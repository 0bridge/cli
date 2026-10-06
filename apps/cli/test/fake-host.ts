import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeBin } from "./fake-bin.ts";

/**
 * Stand-ins for the host's `host-task`, `herdr` and `openclaw` (docs/plans/dots-host.md, 6), each a
 * small bun script in `dir` keeping its state in JSON files there, so tests on every OS run the
 * daemon's real argv against them:
 *
 * - host-task: the real script's rules (~/projects/infra/scripts/host-task): T-NNN numbering,
 *   `set status=completed` needs evidence, `emit` ignores a repeated dedupe key, `answer` only for
 *   the task's current question and once, `events --since --limit` paging. It never reads
 *   HOST_TASK_DB: a developer's real database is never touched.
 * - herdr: scripted panes for `agent list`, `pane send-text`, `pane send-keys`, `agent prompt`
 *   (refusing a blocked agent, as herdr does) and `agent wait`. Typing Enter into a blocked pane
 *   (or prompting an idle one) makes it `working`, unless the pane is scripted `stuck`.
 * - openclaw: records each `agent` call's argv and message file, waits while the task is held,
 *   fails as scripted, and answers `--json`.
 *
 * The handle reads and changes that state the way herdr-watch and the supervisor would; `watch()`
 * is one pass of herdr-watch (`host-task observe`), which takes the task's current question off
 * whenever its worker isn't blocked, a question the worker emitted itself included.
 */

export interface FakePane {
  pane: string;
  /** The agent's name in herdr (t-001 for task T-001). */
  name: string;
  status: "idle" | "working" | "blocked" | "done" | "unknown";
  focused?: boolean;
  seq?: number;
  /** The coding agent's native session id (herdr's agent_session), which host-task may bind the task to. */
  session?: string;
  /** "stuck": typing changes nothing (the worker never takes it). */
  onInput?: "take" | "stuck";
  /** What was typed: send-text, then each Enter, and prompts. */
  typed?: string[];
}

export interface HostDb {
  tasks: Record<string, Record<string, unknown>>;
  events: { id: number; at: number; kind: string; task: string | null; data: Record<string, unknown>; dedupe: string | null }[];
  seq: number;
}

const COMMON = String.raw`
const fs = require("fs");
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function locked(file, fn) {
  const l = file + ".lock";
  const end = Date.now() + 10000;
  for (;;) {
    try { fs.mkdirSync(l); break; } catch (e) {
      if (Date.now() > end) { try { fs.rmdirSync(l); } catch {} }
      sleep(3);
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(l); } catch {} }
}
function load(file, dflt) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return dflt; } }
function store(file, v) { fs.writeFileSync(file + ".tmp", JSON.stringify(v, null, 1)); fs.renameSync(file + ".tmp", file); }
class Fail extends Error {}
// Thrown, not exited: a lock taken is always given back.
function fail(msg) { throw new Fail(msg); }
function main(fn) {
  try { fn(); } catch (e) {
    if (!(e instanceof Fail)) throw e;
    process.stderr.write(e.message + "\n");
    process.exitCode = 1;
  }
}
const argv = process.argv.slice(2);
`;

const HOST_TASK = String.raw`
const DB = DIR + "/host-task.json";
const pos = [], opt = {};
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) { const eq = a.indexOf("="); if (eq > 0) opt[a.slice(2, eq)] = a.slice(eq + 1); else opt[a.slice(2)] = argv[++i]; }
  else pos.push(a);
}
const cmd = argv[0];
if (cmd === "--help" || cmd === "-h") { console.log("usage: host-task {create,set,show,list,events,emit,answer,import-board} ..."); process.exit(0); }
const out = locked(DB, () => {
  const db = load(DB, { tasks: {}, events: [], seq: 0 });
  const now = Date.now() / 1000;
  const emit = (kind, task, data, dedupe) => {
    if (dedupe && db.events.some((e) => e.dedupe === dedupe)) return null;
    const id = ++db.seq;
    db.events.push({ id, at: now, kind, task: task || null, data: data || {}, dedupe: dedupe || null });
    return id;
  };
  const get = (id) => { if (!db.tasks[id]) fail("unknown task: " + id); return db.tasks[id]; };
  const put = (id, data) => { data.task_id = id; data.updated = now; db.tasks[id] = data; };
  let result;
  if (cmd === "create") {
    const nums = Object.keys(db.tasks).filter((k) => /^T-\d+$/.test(k)).map((k) => Number(k.slice(2)));
    const id = "T-" + String(Math.max(0, ...nums) + 1).padStart(3, "0");
    const data = { title: pos[0], project: opt.project || "", repo: opt.repo || "", worker: opt.worker || "", priority: opt.priority || "P2", status: "requested" };
    put(id, data); emit("task_requested", id, JSON.parse(JSON.stringify(data)));
    result = get(id);
  } else if (cmd === "set") {
    const data = get(pos[0]);
    const fields = Object.fromEntries(pos.slice(1).map((f) => [f.slice(0, f.indexOf("=")), f.slice(f.indexOf("=") + 1)]));
    if (fields.status === "completed" && !(fields.evidence || data.evidence)) fail("completed requires evidence; turn_done is not task completion");
    Object.assign(data, fields); put(pos[0], data);
    emit(fields.status === "completed" ? "task_completed" : "task_updated", pos[0], fields);
    result = data;
  } else if (cmd === "show") result = get(pos[0]);
  else if (cmd === "list") result = Object.keys(db.tasks).sort().map((k) => db.tasks[k]);
  else if (cmd === "events") {
    // Scripted lookups of one event that fail (a locked database), counted down.
    const failing = DIR + "/fail-one-event";
    const left = fs.existsSync(failing) ? Number(fs.readFileSync(failing, "utf8")) : 0;
    if (opt.limit === "1" && left > 0) { fs.writeFileSync(failing, String(left - 1)); fail("database is locked"); }
    const since = Number(opt.since || 0), limit = Number(opt.limit || 100);
    if (!(limit >= 1 && limit <= 1000)) fail("limit must be 1..1000");
    const rows = db.events.filter((e) => e.id > since).slice(0, limit);
    result = { events: rows, cursor: rows.length ? rows[rows.length - 1].id : since };
  } else if (cmd === "emit") {
    const task = opt.task ? get(opt.task) : null;
    const eid = emit(opt.kind, opt.task, { text: opt.text, pane: task ? task.pane || null : null, delivery: "pending_connection" }, opt.dedupe);
    if (opt.kind === "question_required" && task && eid) { task.pending_question_event = eid; put(opt.task, task); }
    result = { event: eid };
  } else if (cmd === "answer") {
    const qid = Number(pos[0]);
    const row = db.events.find((e) => e.id === qid);
    if (!row || row.kind !== "question_required") fail("not a question event");
    if (db.events.some((e) => e.dedupe === "answer:" + qid)) fail("question already answered");
    const task = get(row.task);
    if (task.pending_question_event !== qid) fail("question is no longer current");
    result = { event: emit("answer_pending", row.task, { question_event: qid, text: opt.text, target: row.data.pane, delivery: "pending_supervisor" }, "answer:" + qid) };
  } else fail("unknown command " + cmd);
  store(DB, db);
  return result;
});
console.log(JSON.stringify(out, null, 2));
`;

const HERDR = String.raw`
const PANES = DIR + "/herdr-panes.json";
fs.appendFileSync(DIR + "/herdr-calls.jsonl", JSON.stringify(argv) + "\n");
if (argv[0] === "--version") { console.log("herdr 0.9.1"); process.exit(0); }
const [group, sub, target] = argv;
const change = (fn) => locked(PANES, () => { const panes = load(PANES, []); const r = fn(panes); store(PANES, panes); return r; });
const find = (panes) => panes.find((p) => p.pane === target || p.name === target);
if (group === "agent" && sub === "list") {
  const panes = load(PANES, []);
  console.log(JSON.stringify({ result: { agents: panes.map((p) => ({ pane_id: p.pane, name: p.name, agent: "claude", agent_status: p.status, focused: !!p.focused, state_change_seq: p.seq || 0, workspace_id: "w1", ...(p.session ? { agent_session: { value: p.session } } : {}) })) } }));
} else if (group === "pane" && sub === "send-text") {
  change((panes) => { const p = find(panes); if (!p) fail("pane_not_found"); (p.typed = p.typed || []).push(argv[3]); });
} else if (group === "pane" && sub === "send-keys") {
  change((panes) => {
    const p = find(panes); if (!p) fail("pane_not_found");
    for (const k of argv.slice(3)) {
      (p.typed = p.typed || []).push("<" + k + ">");
      if (k === "enter" && p.onInput !== "stuck" && p.status === "blocked") { p.status = "working"; p.seq = (p.seq || 0) + 1; }
    }
  });
} else if (group === "agent" && sub === "prompt") {
  change((panes) => {
    const p = find(panes); if (!p) fail("agent_not_found");
    if (p.status === "blocked") fail("agent_blocked: the agent is waiting at a prompt");
    (p.typed = p.typed || []).push(argv[3], "<enter>");
    if (p.onInput !== "stuck") { p.status = "working"; p.seq = (p.seq || 0) + 1; }
  });
} else if (group === "agent" && sub === "wait") {
  const until = [], rest = argv.slice(3);
  let timeout = 0;
  for (let i = 0; i < rest.length; i++) { if (rest[i] === "--until") until.push(rest[++i]); else if (rest[i] === "--timeout") timeout = Number(rest[++i]); }
  const end = Date.now() + timeout;
  for (;;) {
    const p = find(load(PANES, []));
    if (!p) fail("agent_not_found");
    if (until.includes(p.status)) { console.log(JSON.stringify({ result: { agent_status: p.status } })); process.exit(0); }
    if (Date.now() >= end) fail("timeout");
    sleep(15);
  }
} else fail("unknown herdr command " + argv.join(" "));
`;

const OPENCLAW = String.raw`
if (argv[0] === "--version") { console.log("OpenClaw 2026.9.8 (fake)"); process.exit(0); }
if (argv[0] === "agents" && argv[1] === "list") { console.log(JSON.stringify([{ id: "lead", name: "dev-herdr-agent" }])); process.exit(0); }
if (argv[0] !== "agent") fail("unknown openclaw command");
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const key = flag("--session-key") || "";
const file = flag("--message-file");
const message = file ? fs.readFileSync(file, "utf8") : flag("--message") || "";
const id = (/\[0bridge [a-z -]+? (h[rfac]_[A-Za-z0-9]+)/.exec(message) || /\[0bridge answer for question #(\d+)/.exec(message) || [])[1] || null;
const log = (ev) => fs.appendFileSync(DIR + "/openclaw-calls.jsonl", JSON.stringify({ ...ev, key, id, at: Date.now() }) + "\n");
log({ ev: "start", argv, message });
while (fs.existsSync(DIR + "/hold-" + key)) sleep(15);
const script = load(DIR + "/openclaw-script.json", {});
const n = locked(DIR + "/openclaw-tries.json", () => { const t = load(DIR + "/openclaw-tries.json", {}); t[key] = (t[key] || 0) + 1; store(DIR + "/openclaw-tries.json", t); return t[key]; });
if (script.sleepMs) sleep(script.sleepMs);
if ((script.fail && script.fail[key]) >= n) { log({ ev: "end", ok: false }); fail("gateway closed the connection"); }
log({ ev: "end", ok: true });
console.log(JSON.stringify({ status: "ok", result: { payloads: [{ text: "lead: on it (" + key + ")" }] } }));
`;

export interface OpenclawCall {
  ev: "start" | "end";
  key: string;
  id: string | null;
  at: number;
  argv?: string[];
  message?: string;
  ok?: boolean;
}

export function fakeHost(dir: string, o: { panes?: FakePane[]; openclaw?: { sleepMs?: number; fail?: Record<string, number> } } = {}) {
  mkdirSync(dir, { recursive: true });
  const prog = (body: string) => `const DIR = ${JSON.stringify(dir)};\n${COMMON}\nmain(() => {\n${body}\n});\n`;
  const bins = { hostTask: fakeBin(dir, "host-task", prog(HOST_TASK)), herdr: fakeBin(dir, "herdr", prog(HERDR)), openclaw: fakeBin(dir, "openclaw", prog(OPENCLAW)) };
  const dbFile = join(dir, "host-task.json");
  const panesFile = join(dir, "herdr-panes.json");
  writeFileSync(panesFile, JSON.stringify(o.panes ?? []));
  writeFileSync(join(dir, "openclaw-script.json"), JSON.stringify(o.openclaw ?? {}));
  const read = <T>(f: string, d: T): T => {
    try {
      return JSON.parse(readFileSync(f, "utf8")) as T;
    } catch {
      return d;
    }
  };
  /** The same lock the scripts take, so a test's change never races theirs. */
  const locked = <T>(file: string, fn: () => T): T => {
    const l = file + ".lock";
    const end = Date.now() + 10_000;
    for (;;) {
      try {
        mkdirSync(l);
        break;
      } catch {
        if (Date.now() > end) rmSync(l, { recursive: true, force: true });
        Bun.sleepSync(3);
      }
    }
    try {
      return fn();
    } finally {
      try {
        rmdirSync(l);
      } catch {}
    }
  };
  const store = (file: string, v: unknown) => {
    writeFileSync(file + ".tmp", JSON.stringify(v, null, 1));
    renameSync(file + ".tmp", file);
  };
  const changeDb = <T>(fn: (db: HostDb) => T): T =>
    locked(dbFile, () => {
      const db = read<HostDb>(dbFile, { tasks: {}, events: [], seq: 0 });
      const r = fn(db);
      store(dbFile, db);
      return r;
    });
  const addEvent = (db: HostDb, kind: string, task: string | null, data: Record<string, unknown>, dedupe: string | null = null) => {
    if (dedupe && db.events.some((e) => e.dedupe === dedupe)) return null;
    const id = ++db.seq;
    db.events.push({ id, at: Date.now() / 1000, kind, task, data, dedupe });
    return id;
  };
  const changePanes = <T>(fn: (p: FakePane[]) => T): T =>
    locked(panesFile, () => {
      const panes = read<FakePane[]>(panesFile, []);
      const r = fn(panes);
      store(panesFile, panes);
      return r;
    });

  return {
    dir,
    bins,
    db: () => read<HostDb>(dbFile, { tasks: {}, events: [], seq: 0 }),
    events: (kind?: string) => read<HostDb>(dbFile, { tasks: {}, events: [], seq: 0 }).events.filter((e) => !kind || e.kind === kind),
    task: (id: string) => read<HostDb>(dbFile, { tasks: {}, events: [], seq: 0 }).tasks[id],
    /** A task as host-task create makes it (without going through the CLI). */
    create(title: string, extra: Record<string, unknown> = {}): string {
      return changeDb((db) => {
        const nums = Object.keys(db.tasks).map((k) => Number(k.slice(2)));
        const id = `T-${String(Math.max(0, ...nums) + 1).padStart(3, "0")}`;
        db.tasks[id] = { title, project: "", repo: "", worker: "", priority: "P2", status: "requested", ...extra, task_id: id, updated: Date.now() / 1000 };
        addEvent(db, "task_requested", id, { ...db.tasks[id] });
        return id;
      });
    },
    /** host-task emit. */
    emit(kind: string, task: string | null, text: string, dedupe: string | null = null): number | null {
      return changeDb((db) => {
        const t = task ? db.tasks[task] : undefined;
        const id = addEvent(db, kind, task, { text, pane: t?.pane ?? null, delivery: "pending_connection" }, dedupe);
        if (kind === "question_required" && t && id) t.pending_question_event = id;
        return id;
      });
    },
    /** host-task set (status=completed needs evidence). */
    set(task: string, fields: Record<string, string>): void {
      changeDb((db) => {
        const t = db.tasks[task]!;
        if (fields.status === "completed" && !(fields.evidence || t.evidence)) throw new Error("completed requires evidence");
        Object.assign(t, fields, { updated: Date.now() / 1000 });
        addEvent(db, fields.status === "completed" ? "task_completed" : "task_updated", task, fields);
      });
    },
    /** What herdr-watch records when the task's worker goes blocked: the pane blocked, a question_required, the task's current question. */
    block(task: string, pane: string, text: string): number {
      const agent = task.toLowerCase();
      changePanes((panes) => {
        const p = panes.find((x) => x.pane === pane);
        if (p) Object.assign(p, { status: "blocked", seq: (p.seq ?? 0) + 1 });
        else panes.push({ pane, name: agent, status: "blocked", seq: 1 });
      });
      return changeDb((db) => {
        const t = (db.tasks[task] ??= { title: agent, status: "needs_reconcile" });
        Object.assign(t, { agent, pane, workspace_id: "w1", observed_state: "blocked", task_id: task, updated: Date.now() / 1000 });
        const id = addEvent(db, "question_required", task, { agent, pane, workspace_id: "w1", recovered: false, text, delivery: "pending_connection" })!;
        t.pending_question_event = id;
        return id;
      });
    },
    /**
     * One herdr-watch pass, as the real `host-task observe` does it every 5 s
     * (~/projects/infra/scripts/host-task, observe): each task whose pane runs its worker (t-001 for
     * T-001) gets the pane's state, and loses its pending_question_event unless that worker is
     * blocked, whoever asked the question.
     */
    watch(): void {
      const panes = read<FakePane[]>(panesFile, []);
      changeDb((db) => {
        for (const [id, t] of Object.entries(db.tasks)) {
          const p = panes.find((x) => x.pane === t.pane && x.name === id.toLowerCase());
          if (!p) continue;
          Object.assign(t, { observed_state: p.status, observed_at: Date.now() / 1000 });
          if (p.status !== "blocked") delete t.pending_question_event;
        }
      });
    },
    /** A worker assigned to a task (what the supervisor records when it starts one). */
    assign(task: string, pane: string, status: FakePane["status"] = "working"): void {
      const agent = task.toLowerCase();
      changePanes((panes) => {
        const p = panes.find((x) => x.pane === pane);
        if (p) Object.assign(p, { name: agent, status });
        else panes.push({ pane, name: agent, status, seq: 0 });
      });
      changeDb((db) => Object.assign(db.tasks[task]!, { agent, pane, workspace_id: "w1" }));
    },
    /**
     * A worker someone started outside 0bridge (lead, by hand) bound to the task the way host-task
     * observe binds a native one: the task's pane and native_session, the pane running that session.
     */
    bindNative(task: string, pane: string, session: string, status: FakePane["status"] = "idle", name = task.toLowerCase()): void {
      changePanes((panes) => {
        const p = panes.find((x) => x.pane === pane);
        if (p) Object.assign(p, { name, status, session });
        else panes.push({ pane, name, status, session, seq: 0 });
      });
      changeDb((db) => Object.assign(db.tasks[task]!, { agent: name, pane, native_session: session, workspace_id: "w1" }));
    },
    /** The task taken out of host-task (as if its database lost it): `show` and `emit --task` then fail "unknown task". */
    remove(task: string): void {
      changeDb((db) => {
        delete db.tasks[task];
      });
    },
    /** The next `n` one-event lookups (`events --limit=1`, how a question is read back) fail. */
    failOneEventLookups(n: number): void {
      writeFileSync(join(dir, "fail-one-event"), String(n));
    },
    panes: () => read<FakePane[]>(panesFile, []),
    pane: (id: string) => read<FakePane[]>(panesFile, []).find((p) => p.pane === id),
    setPane(id: string, patch: Partial<FakePane>): void {
      changePanes((panes) => {
        const p = panes.find((x) => x.pane === id);
        if (p) Object.assign(p, patch);
        else panes.push({ pane: id, name: "", status: "idle", ...patch });
      });
    },
    herdrCalls: (): string[][] => {
      const f = join(dir, "herdr-calls.jsonl");
      return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
    openclawCalls: (): OpenclawCall[] => {
      const f = join(dir, "openclaw-calls.jsonl");
      return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
    /** openclaw calls for `task`'s session wait until released. */
    hold: (task: string) => writeFileSync(join(dir, `hold-0bridge-${task.toLowerCase()}`), ""),
    release: (task: string) => rmSync(join(dir, `hold-0bridge-${task.toLowerCase()}`), { force: true }),
    scriptOpenclaw: (s: { sleepMs?: number; fail?: Record<string, number> }) => writeFileSync(join(dir, "openclaw-script.json"), JSON.stringify(s)),
    /** Every line the herdr and openclaw stand-ins were given, to check nothing names Slack or a delivery flag. */
    allArgs: (): string[] => [
      ...readLines(join(dir, "herdr-calls.jsonl")).flatMap((l) => JSON.parse(l) as string[]),
      ...readLines(join(dir, "openclaw-calls.jsonl")).flatMap((l) => (JSON.parse(l) as OpenclawCall).argv ?? []),
    ],
  };
}

const readLines = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean) : []);

export type FakeHost = ReturnType<typeof fakeHost>;
