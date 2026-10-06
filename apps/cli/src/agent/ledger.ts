import { HOST_REQUEST_ID, type HostAnswerReply, type HostChoice, type HostFollowupReply, type HostOp, type HostRequestReply, type HostVia } from "./protocol.ts";
import { HOST_TASK_ID, HostTaskError, parseHostEvent, parseHostTask, type HostTaskClient, type RawHostEvent, type SupervisorState } from "./supervisor.ts";

/**
 * Ledger mode (docs/plans/dots-host.md, "Ledger mode"; `0b agent supervisor ledger`). What the user
 * tells Dots, ChatGPT or Claude through 0bridge enters the host's work ledger (host-task's log) by
 * the path the host's own desk and Telegram use, and nothing else happens here:
 *
 * - a request is a `dev_request` (no task: the team triages it and makes the T-ID),
 * - a follow-up is a `user_followup` on the task, or without one while the request has no task yet,
 * - an answer is a `user_decision` on the question's task,
 *
 * each with the user's words exactly, then a source line (`출처: ChatGPT via 0bridge · <KST> ·
 * 요청 hr_…`), under a dedupe key, so a retry or a restart records nothing twice. herdr-watch
 * wakes the team's supervisor (devlead) for these kinds. No task is made, no agent run, nothing
 * typed into a pane, no OpenClaw.
 *
 * Linking: the request id travels in the dev_request's source line. When the team makes the task
 * and keeps the id in what it records (the contract's source, the title, a note), the first later
 * event on a task whose data names a pending request's id links the request to that task. This
 * machine then records `request_linked` on the task (dedupe `request-linked:<hr_id>`), which the
 * tail carries to the hub like any event, so the hub's delivery gets its task.
 */

/** The event this machine records on a task when it links a request to it. */
export const LINK_KIND = "request_linked";
const FOLLOWUP_ID = /^hf_[A-Za-z0-9]{4,40}$/;
const CHOICE = /^[A-Za-z0-9]{1,2}$/;
const MAX_TEXT = 8000;
/** Request ids in an event's data: what links a request to the task made for it. */
const REQUEST_IDS = /hr_[A-Za-z0-9]{4,40}/g;

/** A request recorded as a dev_request. `text` is dropped once host-task has it. */
export interface LedgerRequest {
  id: string;
  text: string;
  /** When it was taken: its source line's time, the same on every retry. */
  at: number;
  via?: HostVia;
  /** host-task's log was at least this far before it was recorded (where to look for it by its dedupe key). */
  since: number;
  /** Its dev_request event, once recorded. */
  event: number | null;
  /** The task the team made for it, once an event on that task names its id. */
  task: string | null;
  /** The event that linked it. */
  linkedBy?: number;
  /** request_linked is in host-task. */
  announced?: boolean;
  /** Failed tries after a restart (nobody waits on it then); given up after the last. */
  tries?: number;
  nextAt?: number;
}

/** A follow-up recorded as user_followup: on a task, or about a request with no task yet. */
export interface LedgerFollowup {
  id: string;
  text: string;
  at: number;
  via?: HostVia;
  since: number;
  task: string | null;
  request: string | null;
  event: number | null;
  tries?: number;
  nextAt?: number;
}

/** An answer recorded as user_decision on its question's task. */
export interface LedgerAnswer {
  question: number;
  task: string;
  text: string;
  /** The option picked, and its name as the question wrote it. */
  choice: string | null;
  label?: string;
  at: number;
  via?: HostVia;
  since: number;
  event: number | null;
  tries?: number;
  nextAt?: number;
  /** Why the team's question had closed before this answer came (the hub says; recorded anyway). */
  closed?: string;
}

/** A time as the host's records write it: 2026-10-06 17:31 KST. */
export const kst = (at: number) => `${new Date(at + 9 * 3_600_000).toISOString().slice(0, 16).replace("T", " ")} KST`;
/** Where the user's words came from, the line after them: `출처: ChatGPT via 0bridge · 2026-10-06 17:31 KST · 요청 hr_…`. */
export const sourceLine = (via: HostVia | undefined, at: number, tail: string[] = []) => `출처: ${via?.client ?? "AI app"} via 0bridge · ${kst(at)}${tail.map((t) => ` · ${t}`).join("")}`;
export const requestText = (r: Pick<LedgerRequest, "id" | "text" | "at" | "via">) => `${r.text}\n\n${sourceLine(r.via, r.at, [`요청 ${r.id}`])}`;
export const followupText = (f: Pick<LedgerFollowup, "id" | "text" | "at" | "via" | "task" | "request">) =>
  f.task
    ? `${f.text}\n\n${sourceLine(f.via, f.at, [`후속 ${f.id}`, ...(f.request ? [`요청 ${f.request}`] : [])])}`
    : `(요청 ${f.request} 후속) ${f.text}\n\n${sourceLine(f.via, f.at, [`후속 ${f.id}`])}`;
/**
 * The user's decision: with an option picked, first its raw value the way the Telegram buttons
 * give it (`choice: T-044|e1145|A / 선택: A) 이름`, which devlead checks before anything it can't
 * undo), then the user's words, then which question it answers and where it came from.
 */
export const decisionText = (a: Pick<LedgerAnswer, "question" | "task" | "text" | "choice" | "label" | "at" | "via" | "closed">) =>
  `${a.choice ? `choice: ${a.task}|e${a.question}|${a.choice} / 선택: ${a.choice}) ${a.label ?? ""}`.trimEnd() + "\n" : ""}${a.text}\n\n(질문 #${a.question} 답${a.closed ? `, 이 질문은 답이 오기 전에 닫혔음: ${a.closed}` : ""}) ${sourceLine(a.via, a.at)}`;

export interface LedgerDeps {
  host: HostTaskClient;
  state: () => SupervisorState;
  save: () => void;
  mask: (s: string) => string;
  log: (line: string) => void;
  error: (text: string) => void;
  /** Where host-task's log is now, at least (the tail's cursor, else its end). */
  logEnd: () => Promise<number>;
  stopped: () => boolean;
  /** The pauses between a crash-left record's tries. */
  retryMs: number[];
}

export class LedgerMode {
  /** Records being written now, by key: a second call for one waits for the first. */
  private busy = new Map<string, Promise<unknown>>();
  private announcing = false;
  private retrying = false;

  constructor(private d: LedgerDeps) {}

  private get s() {
    return this.d.state();
  }

  private once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let p = this.busy.get(key) as Promise<T> | undefined;
    if (!p) {
      p = fn().finally(() => this.busy.delete(key));
      this.busy.set(key, p);
    }
    return p;
  }

  // ── Requests, follow-ups, answers ─────────────

  async request(m: Extract<HostOp, { op: "host.request" }>): Promise<HostRequestReply> {
    if (typeof m.requestId !== "string" || !HOST_REQUEST_ID.test(m.requestId)) throw new Error("bad request id");
    const text = checkText(m.text);
    const id = m.requestId;
    const had = this.s.ledger[id]?.event != null;
    await this.once(`r:${id}`, async () => {
      if (!this.s.ledger[id]) {
        const since = await this.d.logEnd();
        this.s.ledger[id] = { id, text, at: Date.now(), ...(viaOf(m.via) ? { via: viaOf(m.via)! } : {}), since, event: null, task: null };
        this.d.save();
        await this.recordRequest(this.s.ledger[id]!, true);
      } else await this.recordRequest(this.s.ledger[id]!, false);
    });
    const r = this.s.ledger[id]!;
    const task = r.task ? await this.d.host.show(r.task).then((x) => parseHostTask(x, this.d.mask), () => null) : null;
    return { task, dispatch: had ? "duplicate" : "recorded", receipt: { requestId: id, event: r.event, task: r.task } };
  }

  async followup(m: Extract<HostOp, { op: "host.followup" }>): Promise<HostFollowupReply> {
    if (typeof m.requestId !== "string" || !FOLLOWUP_ID.test(m.requestId)) throw new Error("bad request id");
    const task = m.task === undefined || m.task === null ? null : m.task;
    const request = m.request === undefined || m.request === null ? null : m.request;
    if (task !== null && (typeof task !== "string" || !HOST_TASK_ID.test(task))) throw new Error("bad task id");
    if (request !== null && (typeof request !== "string" || !HOST_REQUEST_ID.test(request))) throw new Error("bad request id");
    if (!task && !request) throw new Error("bad task id");
    const text = checkText(m.text);
    const id = m.requestId;
    const had = this.s.ledgerFollowups[id]?.event != null;
    await this.once(`f:${id}`, async () => {
      if (!this.s.ledgerFollowups[id]) {
        // A request the team has linked goes on its task; a task that came from one names it in the source line.
        const on = task ?? (request ? (this.s.ledger[request]?.task ?? null) : null);
        const from = request ?? (on ? (Object.values(this.s.ledger).find((r) => r.task === on)?.id ?? null) : null);
        const since = await this.d.logEnd();
        this.s.ledgerFollowups[id] = { id, text, at: Date.now(), ...(viaOf(m.via) ? { via: viaOf(m.via)! } : {}), since, task: on, request: from, event: null };
        this.d.save();
        await this.recordFollowup(this.s.ledgerFollowups[id]!, true);
      } else await this.recordFollowup(this.s.ledgerFollowups[id]!, false);
    });
    const f = this.s.ledgerFollowups[id]!;
    return { task: f.task, dispatch: had ? "duplicate" : "recorded", event: f.event, request: f.request };
  }

  /**
   * The user's answer to a question (devlead's `[선택지]` handoff, or a worker's question) as a
   * user_decision on its task. Never typed into a pane, never sent to an agent. The same answer
   * again is the same record; a different one for an answered question is refused (a follow-up
   * says more).
   */
  async answer(m: Extract<HostOp, { op: "host.answer" }>): Promise<HostAnswerReply> {
    if (!Number.isInteger(m.question) || m.question <= 0) throw new Error("bad question id");
    const q = m.question;
    const text = checkText(m.text);
    const choice = m.choice === undefined || m.choice === null || m.choice === "" ? null : String(m.choice);
    if (choice !== null && !CHOICE.test(choice)) throw new Error("bad choice");
    return this.once(`a:${q}`, async (): Promise<HostAnswerReply> => {
      const had = this.s.ledgerAnswers[String(q)];
      if (had) {
        if (had.event === null) await this.recordAnswer(had, false);
        if (had.text === text && (had.choice ?? "").toLowerCase() === (choice ?? "").toLowerCase()) return answered(had);
        return { question: q, task: had.task, status: "refused", detail: `question #${q} was already answered through 0bridge (host event #${had.event ?? "?"}); to add or change something, send a follow-up on ${had.task}` };
      }
      const e = (await this.d.host.events(q - 1, 1)).events.find((x) => x.id === q);
      const ev = e ? parseHostEvent(e, this.d.mask) : null;
      const asks = ev?.task && HOST_TASK_ID.test(ev.task) && (ev.kind === "question_required" || (ev.kind === "primary_handoff" && ev.options?.length));
      if (!ev || !asks) return { question: q, task: ev?.task ?? null, status: "refused", detail: `host event #${q} isn't a question on this host (a question is a primary_handoff with a [선택지] block, or a worker's question_required)` };
      let option: HostChoice | undefined;
      if (choice !== null) {
        option = ev.options?.find((o) => o.key.toLowerCase() === choice.toLowerCase());
        if (!option) return { question: q, task: ev.task, status: "refused", detail: ev.options?.length ? `${choice} isn't one of question #${q}'s options (${ev.options.map((o) => o.key).join(", ")})` : `question #${q} lists no options; answer in words` };
      }
      const since = await this.d.logEnd();
      const closed = typeof m.closed === "string" && m.closed.trim() ? m.closed.trim().slice(0, 200) : undefined;
      const a: LedgerAnswer = { question: q, task: ev.task!, text, choice: option?.key ?? null, ...(option ? { label: option.label } : {}), at: Date.now(), ...(viaOf(m.via) ? { via: viaOf(m.via)! } : {}), ...(closed ? { closed } : {}), since, event: null };
      this.s.ledgerAnswers[String(q)] = a;
      this.d.save();
      await this.recordAnswer(a, true);
      return answered(a);
    });
  }

  private recordRequest(r: LedgerRequest, fresh: boolean) {
    return this.record(r, fresh, () => this.s.ledger, r.id, null, "dev_request", requestText(r), `dots-request:${r.id}`, () => (r.text = ""));
  }
  private recordFollowup(f: LedgerFollowup, fresh: boolean) {
    return this.record(f, fresh, () => this.s.ledgerFollowups, f.id, f.task, "user_followup", followupText(f), `dots-followup:${f.id}`, () => (f.text = ""));
  }
  private recordAnswer(a: LedgerAnswer, fresh: boolean) {
    // Not dots-answer:<q>: the OpenClaw mode's dots_answer record uses that key.
    return this.record(a, fresh, () => this.s.ledgerAnswers, String(a.question), a.task, "user_decision", decisionText(a), `dots-decision:${a.question}`);
  }

  /**
   * One record into host-task's log, under its dedupe key (host-task keeps the first; a repeat
   * finds it). A fresh one that host-task never got is forgotten when it fails, as the hub forgets
   * it; one left by a restart is tried again later.
   */
  private async record<T extends { event: number | null; since: number }>(
    rec: T,
    fresh: boolean,
    all: () => Record<string, T>,
    key: string,
    task: string | null,
    kind: string,
    text: string,
    dedupe: string,
    done?: () => void,
  ): Promise<void> {
    if (rec.event !== null) return;
    try {
      const out = await this.d.host.emit(task, kind, text, dedupe);
      rec.event = out.event ?? (await this.d.host.findByDedupe(dedupe, rec.since));
      if (rec.event === null) throw new HostTaskError(`host-task didn't record ${kind}`);
    } catch (e) {
      const found = await this.d.host.findByDedupe(dedupe, rec.since).catch(() => undefined);
      if (typeof found === "number") rec.event = found;
      else {
        // Not in host-task (or it can't say): a fresh one is forgotten; a refusal (unknown task) too.
        if ((fresh && found === null) || gone(e)) {
          delete all()[key];
          this.d.save();
        }
        throw e;
      }
    }
    done?.();
    this.d.save();
  }

  /** Records a restart left unwritten, and links not yet in host-task: tried again with a pause, given up after the last try. */
  retry(): void {
    if (this.retrying || this.d.stopped()) return;
    const now = Date.now();
    type Item = { key: string; run: () => Promise<void>; rec: { tries?: number; nextAt?: number }; drop: () => void };
    const work: Item[] = [];
    const add = <T extends { event: number | null; tries?: number; nextAt?: number }>(prefix: string, all: Record<string, T>, run: (x: T) => Promise<void>) => {
      for (const [k, x] of Object.entries(all))
        if (x.event === null && (x.nextAt ?? 0) <= now && !this.busy.has(`${prefix}:${k}`)) work.push({ key: `${prefix}:${k}`, run: () => run(x), rec: x, drop: () => delete all[k] });
    };
    add("r", this.s.ledger, (r) => this.recordRequest(r, false));
    add("f", this.s.ledgerFollowups, (f) => this.recordFollowup(f, false));
    add("a", this.s.ledgerAnswers, (a) => this.recordAnswer(a, false));
    if (!work.length) return void this.announce();
    this.retrying = true;
    void (async () => {
      for (const w of work) {
        if (this.d.stopped()) return;
        await this.once(w.key, w.run).catch((e: Error) => {
          if (this.d.stopped()) return;
          const r = w.rec;
          r.tries = (r.tries ?? 0) + 1;
          if (r.tries > this.d.retryMs.length) {
            w.drop();
            this.d.error(`gave up recording ${w.key.slice(2)} in host-task: ${e.message}`);
          } else {
            r.nextAt = Date.now() + this.d.retryMs[r.tries - 1]!;
            this.d.error(`${w.key.slice(2)} isn't in host-task yet (${e.message}); again in ${Math.round(this.d.retryMs[r.tries - 1]! / 1000)} s`);
          }
        });
      }
    })().finally(() => {
      this.retrying = false;
      void this.announce();
    });
  }

  // ── Linking a request to the task the team made ─────────────

  /**
   * Events from the tail: one on a task whose data names a pending request's id (the team kept
   * `hr_…` from the dev_request when it made the task: the contract's source, a title, a note)
   * links that request to the task, the first such event after the request was recorded.
   */
  saw(raw: RawHostEvent[]): void {
    const pending = new Map(Object.values(this.s.ledger).filter((r) => !r.task && r.event !== null).map((r) => [r.id, r]));
    if (!pending.size) return;
    let changed = false;
    for (const e of raw) {
      if (!e.task || !HOST_TASK_ID.test(e.task) || e.kind === LINK_KIND) continue;
      const blob = `${JSON.stringify(e.data ?? {})} ${e.dedupe ?? ""}`;
      for (const m of blob.matchAll(REQUEST_IDS)) {
        const r = pending.get(m[0]);
        if (!r || e.id <= r.event!) continue;
        Object.assign(r, { task: e.task, linkedBy: e.id });
        pending.delete(r.id);
        changed = true;
        this.d.log(`host: ${r.id} (dev_request #${r.event}) is ${e.task} (named in #${e.id} ${e.kind})`);
      }
    }
    if (!changed) return;
    this.d.save();
    void this.announce();
  }

  /** request_linked on each newly linked request's task (once: its dedupe key), so the hub learns the task. */
  async announce(): Promise<void> {
    if (this.announcing || this.d.stopped()) return;
    const todo = Object.values(this.s.ledger).filter((r) => r.task && !r.announced);
    if (!todo.length) return;
    this.announcing = true;
    try {
      for (const r of todo) {
        if (this.d.stopped()) return;
        try {
          await this.d.host.emit(r.task, LINK_KIND, `0bridge request ${r.id} (dev_request event #${r.event}) is ${r.task} (named in host event #${r.linkedBy ?? "?"})`, `request-linked:${r.id}`);
          r.announced = true;
        } catch (e) {
          // A task host-task no longer has: nothing to announce it on.
          if (gone(e)) r.announced = true;
          this.d.error(`recording request_linked for ${r.id} on ${r.task}: ${(e as Error).message}`);
        }
        this.d.save();
      }
    } finally {
      this.announcing = false;
    }
  }

  /** A request as this machine has it (host.lookup with `request`), or null. */
  receipt(id: string) {
    const r = this.s.ledger[id];
    return r ? { requestId: r.id, event: r.event, task: r.task } : null;
  }

  status() {
    const all = Object.values(this.s.ledger);
    return { requests: all.length, waiting: all.filter((r) => !r.task).length };
  }
}

const answered = (a: LedgerAnswer): HostAnswerReply => ({
  question: a.question,
  task: a.task,
  status: "recorded",
  detail: `in host-task as the user's decision (user_decision, host event #${a.event}) on ${a.task}, for the team to act on; nothing was typed into any pane`,
  event: a.event,
});

const gone = (e: unknown) => e instanceof HostTaskError && /unknown task/.test(e.message);

function viaOf(v: unknown): HostVia | undefined {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  if (!o || typeof o.client !== "string" || !o.client.trim()) return undefined;
  const kind = o.kind === "oauth" || o.kind === "token" || o.kind === "session" ? o.kind : null;
  return kind ? { client: o.client.replace(/\s+/g, " ").trim().slice(0, 80), kind } : undefined;
}

function checkText(t: unknown): string {
  if (typeof t !== "string" || !t.trim()) throw new Error("empty text");
  if (t.length > MAX_TEXT) throw new Error(`text too long (at most ${MAX_TEXT} characters)`);
  return t.trim();
}
