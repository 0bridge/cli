import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { kill, spawnAgent, which } from "./adapters/spawn.ts";
import type { HostAnswerReply, HostVia } from "./protocol.ts";
import type { HostTaskClient, RawHostEvent } from "./supervisor.ts";

/**
 * Delivering an answer to the worker that asked (docs/plans/dots-host.md, 4.4). `host-task
 * answer` only stores it; for a worker blocked at a prompt (a question herdr-watch raised) this
 * types it into that worker's Herdr pane and watches herdr show it was taken, then records
 * `answer_delivered` in host-task. It types only into the question's own pane, only while that
 * question is still the task's current one, the pane still runs the task's worker (t-012), it's
 * blocked and nobody has it focused, and never twice for one question. A question the worker (or
 * the supervisor) recorded itself with `host-task emit` has no prompt waiting for it, so its answer
 * goes to the supervisor with the question id, as does anything else it can't do safely.
 */

export interface HerdrAgent {
  pane: string;
  name: string | null;
  status: string;
  focused: boolean;
  /** herdr's state_change_seq: moves whenever the agent's state does. */
  seq: number | null;
  /** The coding agent's own session id (herdr's agent_session, a string or {value}), the identity host-task binds a task to. */
  session: string | null;
}

/** `herdr agent list` ({result: {agents: […]}}), or null when it isn't that. */
export function parseAgentList(out: string): HerdrAgent[] | null {
  try {
    const agents = (JSON.parse(out) as { result?: { agents?: unknown } }).result?.agents;
    if (!Array.isArray(agents)) return null;
    return agents.flatMap((a) =>
      a && typeof a.pane_id === "string"
        ? [
            {
              pane: a.pane_id,
              name: typeof a.name === "string" && a.name ? a.name : null,
              status: String(a.agent_status ?? a.state ?? "unknown"),
              focused: a.focused === true,
              seq: typeof a.state_change_seq === "number" ? a.state_change_seq : null,
              session: sessionOf(a.agent_session),
            },
          ]
        : [],
    );
  } catch {
    return null;
  }
}

/**
 * What 0bridge writes into host-task for someone who isn't on the host (a Dots request, follow-up
 * or answer, an outside-context item): a first line `provenance: {json}` saying where it came
 * from, a blank line, then the text. Data for the supervisor and the record, never instructions.
 */
export const provenanceText = (p: Record<string, unknown>, text: string) =>
  `provenance: ${JSON.stringify(Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== null && v !== "")))}\n\n${text}`;

function sessionOf(v: unknown): string | null {
  const s = v && typeof v === "object" ? (v as { value?: unknown }).value : v;
  return typeof s === "string" && s ? s : null;
}

/**
 * Text for an argument: no NULs, and on Windows on one line (a .cmd shim, as the tests' stand-ins
 * are there, can't pass a line break through cmd.exe).
 */
export const argText = (s: string) => {
  const t = s.replace(/\0/g, "");
  return process.platform === "win32" ? t.replace(/\r?\n/g, " / ") : t;
};

/**
 * An answer typed at a worker's prompt: one line, with every control character (a lone CR, ESC,
 * C1) a space, so it can't press Enter again or drive a menu.
 */
export const keysText = (s: string) => s.replace(/\r?\n/g, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");

/** A pane id from host-task: never something herdr could read as an option. */
export const PANE = /^[A-Za-z0-9%][A-Za-z0-9._:%-]{0,127}$/;

/**
 * Run `bin` to the end like runAgentAsync, with the process kept in `procs` meanwhile, so stopping
 * the daemon ends what's still waiting (an `agent wait`, an `openclaw agent` turn) instead of
 * keeping it alive.
 */
export function runTracked(bin: string, args: string[], timeout: number, procs: Set<ChildProcess>): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    if (!which(bin)) return resolve({ code: null, out: "", err: `${bin} not found` });
    const p = spawnAgent(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    procs.add(p);
    let out = "";
    let err = "";
    p.stdout?.on("data", (d) => (out += d));
    p.stderr?.on("data", (d) => (err += d));
    const t = setTimeout(() => kill(p, 2000), timeout);
    const end = (code: number | null, e?: string) => {
      clearTimeout(t);
      procs.delete(p);
      resolve({ code, out, err: e ?? err });
    };
    p.on("error", (e) => end(null, e.message));
    p.on("close", (code) => end(code));
  });
}

export class HerdrClient {
  private procs = new Set<ChildProcess>();
  constructor(readonly bin: string) {}

  stop(): void {
    for (const p of this.procs) kill(p, 2000);
  }

  async list(): Promise<HerdrAgent[]> {
    const r = await runTracked(this.bin, ["agent", "list"], 10_000, this.procs);
    const list = r.code === 0 ? parseAgentList(r.out) : null;
    if (!list) throw new Error(`herdr agent list failed${r.err.trim() ? `: ${r.err.trim().split("\n").at(-1)}` : ""}`);
    return list;
  }
  private async ok(args: string[], timeout = 10_000): Promise<boolean> {
    return (await runTracked(this.bin, args, timeout, this.procs)).code === 0;
  }
  sendText(pane: string, text: string) {
    return this.ok(["pane", "send-text", pane, argText(text)]);
  }
  sendKeys(pane: string, ...keys: string[]) {
    return this.ok(["pane", "send-keys", pane, ...keys]);
  }
  /** Until the agent reaches one of `until` (true) or `ms` pass (false). */
  wait(pane: string, until: string[], ms: number) {
    return this.ok(["agent", "wait", pane, ...until.flatMap((s) => ["--until", s]), "--timeout", String(Math.max(1, Math.round(ms)))], ms + 5000);
  }
}

export interface AnswerRecord {
  /**
   * typing: about to type (or typing when the daemon stopped: it may have been typed, so never again);
   * typed: typed, not confirmed yet; forwarding: being passed to the supervisor (never typed after that).
   */
  status: "typing" | "typed" | "forwarding" | "delivered" | "unconfirmed" | "forwarded" | "focused" | "stale";
  hash: string;
  task: string;
  at: number;
  /** Kept only while it may still be typed or passed on. */
  text?: string;
  pane?: string;
  worker?: string;
  from?: string;
  seq?: number | null;
  reply?: HostAnswerReply;
  /** forwarding: why, what it ends as, and whether the supervisor's message is queued (saved in the same write as the queue item). */
  reason?: string;
  as?: "forwarded" | "focused";
  queued?: boolean;
}

export interface AnswerTimings {
  /** The reply to the hub goes by then (the hub waits 15 s). */
  replyMs: number;
  /** Watching herdr for the worker taking the answer, at most, before replying. */
  confirmMs: number;
  /** Then in the background, before answer_unconfirmed. */
  unconfirmedMs: number;
}

const TIMINGS: AnswerTimings = { replyMs: 11_000, confirmMs: 10_000, unconfirmedMs: 120_000 };

/** Where a stopped supervisor can be caught between an answer's steps (SupervisorOptions.seam). */
export type AnswerStep = "answer-stored" | "answer-queued";

export interface AnswerDeps {
  host: Pick<HostTaskClient, "answer" | "events" | "show" | "emit">;
  herdr: HerdrClient;
  /** Persisted (the state file), so a restart never types an answer twice. */
  records: { get(question: number): AnswerRecord | undefined; set(question: number, r: AnswerRecord): void; all(): number[] };
  /**
   * Pass the answer to the supervisor (queued, in the task's session); `queued` changes the record
   * in the same write as the queue item. False when nothing was queued (the supervisor stopped).
   */
  forward(task: string, question: number, text: string, reason: string, queued: () => void): boolean;
  /** The supervisor's name in replies (dev-herdr-agent). */
  supervisor: string;
  mask(s: string): string;
  log(line: string): void;
  /** Tests: called between steps; throws when the supervisor stopped there. */
  step?(at: AnswerStep): void;
  timings?: Partial<AnswerTimings>;
}

interface Question {
  id: number;
  task: string;
  pane: string | null;
  source: "herdr" | "worker";
}

type Target =
  | { kind: "ok"; pane: string; worker: string; from: string; seq: number | null }
  | { kind: "stale"; current: number | null }
  | { kind: "focused"; pane: string; worker: string }
  | { kind: "fallback"; reason: string; pane?: string; worker?: string };

const hashOf = (text: string) => createHash("sha256").update(text.trim()).digest("hex");
const SETTLED = new Set(["delivered", "unconfirmed", "forwarded", "focused", "stale"]);

/** What an answer that's under way does when the supervisor stopped under it: nothing more. */
class Stopped extends Error {
  constructor() {
    super("the supervisor stopped");
  }
}

export class AnswerDelivery {
  private t: AnswerTimings;
  /** Questions a call is working on now (a second call meanwhile hears "pending"). */
  private calls = new Set<number>();
  private stopped = false;

  constructor(private d: AnswerDeps) {
    this.t = { ...TIMINGS, ...d.timings };
  }

  stop(): void {
    this.stopped = true;
  }

  /** Before each step with an effect (host-task, keys, the supervisor): a stopped supervisor goes no further. */
  private live(at?: AnswerStep): void {
    if (at) this.d.step?.(at);
    if (this.stopped) throw new Stopped();
  }

  /** After a restart: watch what was typed (never typing it again), finish passing on what was being passed on. */
  resume(): void {
    for (const id of this.d.records.all()) {
      const r = this.d.records.get(id)!;
      if (r.status === "typing" || r.status === "typed") this.background(id, () => this.confirmLater(id));
      else if (r.status === "forwarding") this.background(id, () => this.finishForward(id).then(() => {}));
    }
  }

  private reply(question: number, task: string | null, status: HostAnswerReply["status"], detail: string, extra: Partial<HostAnswerReply> = {}): HostAnswerReply {
    return { question, task, status, detail, ...extra };
  }

  async deliver(question: number, text: string, via?: HostVia): Promise<HostAnswerReply> {
    const hash = hashOf(text);
    const rec = this.d.records.get(question);
    if (rec) {
      if (rec.hash !== hash) return this.reply(question, rec.task, "refused", `Question #${question} was already answered with a different answer; nothing was typed.`);
      if (SETTLED.has(rec.status) && rec.reply) return rec.reply;
      // Being passed on (a restart came between): finished now, never typed.
      if (rec.status === "forwarding" && !this.calls.has(question)) return this.once(question, () => this.finishForward(question));
      return this.reply(question, rec.task, "pending", this.pendingText(question, rec), { ...(rec.worker ? { worker: rec.worker } : {}), ...(rec.pane ? { pane: rec.pane } : {}) });
    }
    if (this.calls.has(question)) return this.reply(question, null, "pending", `The answer to #${question} is being delivered.`);
    return this.once(question, async () => {
      const deadline = Date.now() + this.t.replyMs;
      const q = await this.question(question);
      if (!q) return this.reply(question, null, "refused", `#${question} isn't a question on this host.`);
      this.live();
      try {
        await this.d.host.answer(question, text);
      } catch (e) {
        const msg = (e as Error).message;
        if (/already answered/.test(msg)) {
          const stored = await this.storedAnswer(question);
          if (!stored || stored.text.trim() !== text.trim())
            return this.reply(question, q.task, "refused", `Question #${question} was already answered${stored ? ` at ${new Date(stored.at).toISOString()}` : ""} with a different answer; nothing was typed.`);
          // The same answer, stored before (by an earlier call that stopped short): deliver it now.
        } else if (/no longer current/.test(msg)) {
          // herdr-watch clears a worker's own question from the task whenever the worker isn't blocked: it still wants the answer.
          if (q.source === "herdr") {
            const current = await this.d.host.show(q.task).then((t) => pendingOf(t), () => null);
            return this.reply(question, q.task, "refused", `Question #${question} on ${q.task} isn't the current one any more${current ? ` (#${current} is)` : ""}; nothing was typed.`, { current });
          }
        } else if (/not a question/.test(msg)) return this.reply(question, null, "refused", `#${question} isn't a question on this host.`);
        else throw e;
      }
      this.live("answer-stored");
      // Who answered (D): a record of its own, so the answer's text (which may be typed) stays the user's words only.
      if (via)
        await this.d.host
          .emit(q.task, "dots_answer", provenanceText({ source: "dots", kind: "dots_answer", client: via.client, via: via.kind, question }, `Answer to question #${question} (its text is in answer_pending).`), `dots-answer:${question}`)
          .catch((e: Error) => this.d.log(`host: recording who answered #${question}: ${e.message}`));
      if (q.source === "worker")
        return this.forward(question, text, hash, q, "the worker recorded this question itself (host-task emit), so no prompt in its pane waits for the answer", "forwarded", {});
      return await this.attempt(question, text, hash, q, deadline);
    });
  }

  /** One call at a time per question. */
  private async once(question: number, fn: () => Promise<HostAnswerReply>): Promise<HostAnswerReply> {
    this.calls.add(question);
    try {
      return await fn();
    } finally {
      this.calls.delete(question);
    }
  }

  private pendingText(question: number, r: AnswerRecord): string {
    if (r.status === "forwarding") return `The answer to #${question} is being passed to ${this.d.supervisor}; nothing is typed.`;
    return `The answer to #${question} was typed into ${r.worker ?? "the worker"}'s pane; herdr hasn't shown it taking it yet. Nothing is typed again.`;
  }

  /** The question event itself (`host-task events` from just before it). */
  private async question(id: number): Promise<Question | null> {
    const page = await this.d.host.events(id - 1, 1);
    const e = page.events.find((x) => x.id === id);
    if (!e || e.kind !== "question_required" || !e.task) return null;
    const data = (e.data ?? {}) as Record<string, unknown>;
    return { id, task: e.task, pane: typeof data.pane === "string" && data.pane ? data.pane : null, source: typeof data.agent === "string" && data.agent ? "herdr" : "worker" };
  }

  /** The answer host-task already holds for `question` (its answer_pending, dedupe answer:<id>). */
  private async storedAnswer(question: number): Promise<{ text: string; at: number } | null> {
    let at = question;
    for (let i = 0; i < 20; i++) {
      const page = await this.d.host.events(at, 1000);
      const hit = page.events.find((e: RawHostEvent) => e.kind === "answer_pending" && e.dedupe === `answer:${question}`);
      if (hit) return { text: String((hit.data as Record<string, unknown> | null)?.text ?? ""), at: Math.round(Number(hit.at) * 1000) };
      if (page.events.length < 1000) return null;
      at = page.events.at(-1)!.id;
    }
    return null;
  }

  /** Every check, right before typing: the question is current, its pane is the task's, it runs the task's worker, nobody has it focused, and the worker is blocked at it. */
  private async target(q: Question): Promise<Target> {
    const task = (await this.d.host.show(q.task)) as Record<string, unknown>;
    const current = pendingOf(task);
    if (current !== q.id) return { kind: "stale", current };
    const worker = typeof task.agent === "string" && task.agent ? task.agent : null;
    const pane = q.pane;
    if (!pane || !PANE.test(pane)) return { kind: "fallback", reason: "host-task doesn't say which pane asked" };
    if (task.pane !== pane) return { kind: "fallback", reason: `the task's pane changed (${pane} asked; the task is on ${String(task.pane ?? "none")} now)`, pane };
    if (!worker) return { kind: "fallback", reason: "the task has no worker on record", pane };
    let agents: HerdrAgent[];
    try {
      agents = await this.d.herdr.list();
    } catch (e) {
      return { kind: "fallback", reason: `herdr didn't answer (${(e as Error).message})`, pane, worker };
    }
    const a = agents.find((x) => x.pane === pane);
    if (!a) return { kind: "fallback", reason: `pane ${pane} is gone`, pane, worker };
    if (a.name !== worker) return { kind: "fallback", reason: `pane ${pane} runs ${a.name ?? "an unnamed agent"} now, not ${worker}`, pane, worker };
    if (a.focused) return { kind: "focused", pane, worker };
    if (a.status === "blocked") return { kind: "ok", pane, worker, from: a.status, seq: a.seq };
    return { kind: "fallback", reason: `${worker} isn't waiting at its question any more (herdr says ${a.status})`, pane, worker };
  }

  private async attempt(question: number, text: string, hash: string, q: Question, deadline: number): Promise<HostAnswerReply> {
    const t = await this.target(q);
    const where = (x: { pane?: string; worker?: string }) => ({ ...(x.worker ? { worker: x.worker } : {}), ...(x.pane ? { pane: x.pane } : {}) });
    switch (t.kind) {
      case "stale":
        // Never recorded: a later call checks again, and the stale answer stays stored in host-task only.
        return this.reply(question, q.task, "refused", `Question #${question} on ${q.task} isn't the current one any more${t.current ? ` (#${t.current} is)` : ""}; nothing was typed.`, { current: t.current });
      case "focused":
        return this.forward(question, text, hash, q, `${t.worker}'s pane ${t.pane} is focused on the host (someone may be typing there), so 0bridge doesn't type into it`, "focused", where(t));
      case "fallback":
        return this.forward(question, text, hash, q, t.reason, "forwarded", where(t));
      case "ok":
        break;
    }
    this.live();
    // Recorded before the first key: whatever happens next, it's never typed twice.
    const rec: AnswerRecord = { status: "typing", hash, task: q.task, at: Date.now(), text, pane: t.pane, worker: t.worker, from: t.from, seq: t.seq };
    this.d.records.set(question, rec);
    const sent = (await this.d.herdr.sendText(t.pane, keysText(text))) && (await this.d.herdr.sendKeys(t.pane, "enter"));
    this.d.records.set(question, { ...rec, status: "typed" });
    this.d.log(`host: answer to #${question} typed into ${t.worker} (${t.pane})${sent ? "" : ", herdr reported an error"}`);
    const left = Math.min(this.t.confirmMs, deadline - Date.now());
    const seen = await this.confirm(question, left);
    if (seen) return seen;
    this.background(question, () => this.confirmLater(question));
    return this.reply(question, q.task, "pending", this.pendingText(question, { ...rec, status: "typed" }), where(t));
  }

  /** Whether herdr shows the worker took the answer within `ms`; delivered (recorded) when it does. */
  private async confirm(question: number, ms: number): Promise<HostAnswerReply | null> {
    const r = this.d.records.get(question);
    if (!r?.pane || !r.worker) return null;
    if (ms > 0) await this.d.herdr.wait(r.pane, ["working", "idle", "done"], ms);
    const now = await this.d.herdr.list().then((l) => l.find((a) => a.pane === r.pane) ?? null, () => null);
    if (!now || now.name !== r.worker) return null;
    const moved = now.status !== r.from || (r.seq !== null && r.seq !== undefined && now.seq !== null && now.seq > r.seq);
    if (!moved) return null;
    const line = `question #${question} → ${r.worker} (pane ${r.pane}): ${r.from} → ${now.status}`;
    const ev = await this.d.host.emit(r.task, "answer_delivered", line, `answer-delivered:${question}`).catch((e: Error) => {
      this.d.log(`host: recording answer_delivered for #${question}: ${e.message}`);
      return { event: null };
    });
    const reply = this.reply(question, r.task, "delivered", `Delivered to ${r.worker} (pane ${r.pane}): herdr shows it ${r.from} → ${now.status}.`, {
      worker: r.worker,
      pane: r.pane,
      confirmation: { from: r.from ?? "unknown", to: now.status, event: ev.event },
    });
    this.d.records.set(question, { status: "delivered", hash: r.hash, task: r.task, at: Date.now(), pane: r.pane, worker: r.worker, reply });
    this.d.log(`host: ${line}`);
    return reply;
  }

  /** Typed but not seen taken: keep watching, then record answer_unconfirmed and tell the supervisor (never typed again). */
  private async confirmLater(question: number): Promise<void> {
    const end = Date.now() + this.t.unconfirmedMs;
    while (!this.stopped && Date.now() < end) {
      if (await this.confirm(question, Math.min(10_000, end - Date.now()))) return;
      await new Promise((r) => setTimeout(r, Math.min(1000, Math.max(0, end - Date.now()))));
    }
    if (this.stopped) return;
    const r = this.d.records.get(question);
    if (!r || r.status === "delivered") return;
    const line = `question #${question}: typed into ${r.worker} (pane ${r.pane}), herdr didn't show it taken in ${Math.round(this.t.unconfirmedMs / 1000)} s`;
    await this.d.host.emit(r.task, "answer_unconfirmed", line, `answer-unconfirmed:${question}`).catch(() => {});
    const reply = this.reply(question, r.task, "pending", `Typed into ${r.worker}'s pane, but herdr didn't show it taken; ${this.d.supervisor} was asked to look at the screen. Nothing is typed again.`, {
      ...(r.worker ? { worker: r.worker } : {}),
      ...(r.pane ? { pane: r.pane } : {}),
    });
    const settled: AnswerRecord = { status: "unconfirmed", hash: r.hash, task: r.task, at: Date.now(), pane: r.pane, worker: r.worker, reply };
    if (r.text)
      this.d.forward(r.task, question, r.text, `it was typed into ${r.worker}'s pane ${r.pane}, but herdr didn't show the worker taking it; look at the screen and don't type it again unless it clearly wasn't received`, () =>
        this.d.records.set(question, settled),
      );
    this.d.records.set(question, settled);
    this.d.log(`host: ${line}`);
  }

  /**
   * To the supervisor instead. Recorded as forwarding first, so a call or a restart after this
   * never types it (the supervisor may have it already); queued with that record marked in the same
   * write; then answer_forwarded in host-task, and the reply kept.
   */
  private async forward(question: number, text: string, hash: string, q: Question, reason: string, as: "forwarded" | "focused", where: { pane?: string; worker?: string }): Promise<HostAnswerReply> {
    this.live();
    this.d.records.set(question, { status: "forwarding", hash, task: q.task, at: Date.now(), text, ...where, reason, as });
    return this.finishForward(question);
  }

  /** A forwarding record to the end: queued unless it is, answer_forwarded recorded, the reply kept. */
  private async finishForward(question: number): Promise<HostAnswerReply> {
    const r = this.d.records.get(question)!;
    const reason = r.reason ?? "0bridge couldn't give it to the worker itself";
    const where = { ...(r.worker ? { worker: r.worker } : {}), ...(r.pane ? { pane: r.pane } : {}) };
    this.live();
    if (!r.queued && !this.d.forward(r.task, question, r.text ?? "", reason, () => this.d.records.set(question, { ...r, queued: true }))) throw new Stopped();
    this.live("answer-queued");
    await this.d.host.emit(r.task, "answer_forwarded", `question #${question} → ${this.d.supervisor}: ${reason}`, `answer-forwarded:${question}`).catch((e: Error) => this.d.log(`host: recording answer_forwarded for #${question}: ${e.message}`));
    const reply =
      r.as === "focused"
        ? this.reply(question, r.task, "pending", `Pending: the worker's pane is focused on the host, so 0bridge didn't type into it. ${this.d.supervisor} has the answer with question #${question} and passes it on.`, where)
        : this.reply(question, r.task, "forwarded", reason, where);
    this.d.records.set(question, { status: r.as ?? "forwarded", hash: r.hash, task: r.task, at: Date.now(), ...where, reply });
    this.d.log(`host: answer to #${question} → ${this.d.supervisor} (${reason})`);
    return reply;
  }

  /** A wait that outlives the call (its record says where it is, so a restart picks it up). */
  private background(question: number, fn: () => Promise<void>): void {
    void fn().catch((e: Error) => {
      if (!(e instanceof Stopped)) this.d.log(`host: answer to #${question}: ${e.message}`);
    });
  }
}

function pendingOf(task: unknown): number | null {
  const v = (task as Record<string, unknown> | null)?.pending_question_event;
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}
