import { closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { deviceTokenKey, loadCloud, openSecretStore, readJson, readText, writeAtomic, type Context } from "@0bridge/core";
import { kill, spawnAgent } from "./agent/adapters/spawn.ts";
import { connectLoop, type Conn, type LoopOptions } from "./agent/ws.ts";

/**
 * Webhook runs on this machine (docs/plans/drive-plus.md B1, §4.9): `0b webhook run <name> --
 * <command…>` keeps the command here, in ~/.0bridge/webhooks.json, never on the server; the runner
 * (`0b webhook listen`, service "webhook") holds a socket to the gateway and runs it for each event,
 * event JSON on stdin, reporting only the exit status, duration and a short reason.
 *
 * Each command runs without a shell (event data never reaches its arguments), one at a time per
 * webhook, others waiting in order; with a debounce, the events that arrive while it waits run once,
 * with the newest on stdin. Delivery is at least once: a result is written to the journal
 * (~/.0bridge/webhook-runs.json, the last 500) before it's reported, and an event id the journal
 * has is answered from it instead of being run again. A run cut short by stopping the runner isn't
 * journaled, so the gateway sends it again. Output goes to ~/.0bridge/webhook-runs/<hook>.log.
 */

/** One webhook's command on this machine. */
export interface LocalRun {
  /** The command as given after `--`, run without a shell. */
  argv: string[];
  cwd: string;
  /** Default 300. */
  timeoutSec: number;
  /** Default 0: every event runs once. */
  debounceSec: number;
  addedAt: number;
}

/** ~/.0bridge/webhooks.json. */
export interface RunsFile {
  v: 1;
  server: string;
  userId: string;
  runs: Record<string, LocalRun>;
}

export const runsPath = (ctx: Context) => join(ctx.storeDir, "webhooks.json");
export const journalPath = (ctx: Context) => join(ctx.storeDir, "webhook-runs.json");
export const logPath = (ctx: Context, hook: string) => join(ctx.storeDir, "webhook-runs", `${hook}.log`);
const lockPath = (ctx: Context) => join(ctx.storeDir, "webhook-listen.pid");

export const RUN_DEFAULTS = { timeoutSec: 300, debounceSec: 0 } as const;
/** As the gateway's RUN_LIMITS. */
export const RUN_MAX = { hooks: 20, timeoutSec: 3600, debounceSec: 3600 } as const;
const HOOK = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** What may go into an environment variable from an event: plain names, as the gateway's prompts allow. */
const PLAIN = /^[A-Za-z0-9_.:/-]{1,128}$/;
const JOURNAL_MAX = 500;
const LOG_MAX = 1024 * 1024;
const KILL_GRACE_MS = 10_000;

declare const VERSION: string;
const version = typeof VERSION !== "undefined" ? VERSION : "dev";
export const machineName = () => hostname().replace(/\.local$/, "");

/** A JSON file, or null when it's missing or not JSON (edited by hand). */
const readSafe = <T>(path: string): T | null => {
  try {
    return readJson<T>(path);
  } catch {
    return null;
  }
};

export function loadRuns(ctx: Context): RunsFile | null {
  const f = readSafe<RunsFile>(runsPath(ctx));
  return f && f.v === 1 && f.runs && typeof f.runs === "object" ? f : null;
}

/** Only this machine's user may read it (commands can name paths and hosts). */
export function saveRuns(ctx: Context, f: RunsFile): void {
  writeAtomic(runsPath(ctx), `${JSON.stringify(f, null, 2)}\n`, { mode: 0o600 });
}

/** The commands for the account signed in now (a file written for another account counts as none). */
export function currentRuns(ctx: Context): Record<string, LocalRun> {
  const f = loadRuns(ctx);
  const cfg = loadCloud(ctx);
  if (!f || !cfg || f.userId !== cfg.userId || f.server.replace(/\/+$/, "") !== cfg.server.replace(/\/+$/, "")) return {};
  return f.runs;
}

/** An event as the gateway sends it, and as the command gets it on stdin. */
export interface RunEvent {
  id: string;
  eventId: string;
  hook: string;
  type: string;
  receivedAt: number;
  data: unknown;
}

export interface RunJob {
  id: string;
  attempt: number;
  event: RunEvent;
}

/** What the gateway is told about a run (and the journal keeps). */
export interface RunResult {
  id: string;
  hook: string;
  ok: boolean;
  exit: number | null;
  signal: string | null;
  ms: number;
  detail?: string;
  coalescedInto?: string;
  at: number;
}

function parseJob(msg: unknown): RunJob | null {
  const m = msg as { t?: unknown; id?: unknown; attempt?: unknown; event?: Partial<RunEvent> } | null;
  if (!m || m.t !== "run" || typeof m.id !== "string" || !/^ev_[0-9a-z]{16}$/.test(m.id)) return null;
  const e = m.event;
  if (!e || typeof e.hook !== "string" || !HOOK.test(e.hook) || typeof e.type !== "string" || typeof e.eventId !== "string" || typeof e.receivedAt !== "number") return null;
  return { id: m.id, attempt: typeof m.attempt === "number" ? m.attempt : 1, event: { id: m.id, eventId: e.eventId, hook: e.hook, type: e.type, receivedAt: e.receivedAt, data: e.data ?? null } };
}

/** The last 500 results by event id; written before a result is reported. */
class Journal {
  private byId = new Map<string, RunResult>();
  constructor(private path: string) {
    const f = readSafe<{ v: 1; results: RunResult[] }>(path);
    for (const r of f?.results ?? []) if (r && typeof r.id === "string") this.byId.set(r.id, r);
  }
  get(id: string) {
    return this.byId.get(id);
  }
  add(results: RunResult[]) {
    for (const r of results) {
      this.byId.delete(r.id);
      this.byId.set(r.id, r);
    }
    const all = [...this.byId.values()].slice(-JOURNAL_MAX);
    this.byId = new Map(all.map((r) => [r.id, r]));
    writeAtomic(this.path, `${JSON.stringify({ v: 1, results: all })}\n`, { mode: 0o600 });
  }
}

/** The command's environment: ours, minus anything the runner itself inherited under these names, plus the event's plain values. */
export function runEnv(ev: RunEvent, count: number, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!k.startsWith("ZEROBRIDGE_EVENT_") && k !== "ZEROBRIDGE_HOOK") env[k] = v;
  const add = (k: string, v: string) => {
    if (PLAIN.test(v)) env[k] = v;
  };
  add("ZEROBRIDGE_EVENT_ID", ev.id);
  add("ZEROBRIDGE_EVENT_SENDER_ID", ev.eventId);
  add("ZEROBRIDGE_EVENT_TYPE", ev.type);
  add("ZEROBRIDGE_HOOK", ev.hook);
  add("ZEROBRIDGE_EVENT_RECEIVED_AT", String(ev.receivedAt));
  add("ZEROBRIDGE_EVENT_COUNT", String(count));
  return env;
}

/** Append to the hook's log, moving it to <hook>.log.1 past 1 MB. */
function openLog(path: string): number {
  mkdirSync(dirname(path), { recursive: true });
  try {
    if (statSync(path).size > LOG_MAX) renameSync(path, `${path}.1`);
  } catch {}
  return openSync(path, "a", 0o600);
}

const seconds = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

/**
 * Run one command for an event: no shell, the event's JSON on stdin, output to the hook's log,
 * terminated at the timeout with whatever it started (its process group; on Windows the whole tree),
 * killed 10 s later if still there.
 * `stop` ends it early (the runner shutting down): `stopped` is then true.
 */
export function execRun(
  run: LocalRun,
  ev: RunEvent,
  o: { count: number; log: string; killGraceMs?: number; signal?: AbortSignal },
): Promise<Omit<RunResult, "id" | "hook" | "at"> & { stopped?: boolean }> {
  return new Promise((done) => {
    const started = Date.now();
    if (!run.argv.length) return done({ ok: false, exit: null, signal: null, ms: 0, detail: "no command is set" });
    if (!existsSync(run.cwd)) return done({ ok: false, exit: null, signal: null, ms: 0, detail: "its folder doesn't exist any more" });
    const [cmd, ...args] = run.argv;
    // A relative path (./sync.sh) is the command's folder's, not wherever the runner started.
    const bin = /[\\/]/.test(cmd!) && !isAbsolute(cmd!) ? resolve(run.cwd, cmd!) : cmd!;
    let fd: number | null = null;
    try {
      fd = openLog(o.log);
      writeSync(fd, `\n--- ${new Date().toISOString()} ${ev.id} ${ev.type}${o.count > 1 ? ` (${o.count} events)` : ""} ---\n`);
    } catch {
      fd = null;
    }
    const finish = (r: Omit<RunResult, "id" | "hook" | "at"> & { stopped?: boolean }) => {
      if (fd !== null) {
        try {
          writeSync(fd, `--- ${r.exit !== null ? `exit ${r.exit}` : r.signal ? `stopped (${r.signal})` : "didn't run"}${r.detail ? `: ${r.detail}` : ""}, ${seconds(r.ms)} ---\n`);
          closeSync(fd);
        } catch {}
        fd = null;
      }
      done(r);
    };
    let child: ReturnType<typeof spawnAgent>;
    try {
      // Its own process group off Windows, so the timeout ends what it started too (Windows: taskkill /t).
      child = spawnAgent(bin, args, { cwd: run.cwd, env: runEnv(ev, o.count), stdio: ["pipe", fd ?? "ignore", fd ?? "ignore"], windowsHide: true, detached: process.platform !== "win32" });
    } catch (e) {
      return finish({ ok: false, exit: null, signal: null, ms: Date.now() - started, detail: `couldn't start the command (${e instanceof Error ? e.message.slice(0, 80) : "error"})` });
    }
    let timedOut = false;
    let stopped = false;
    const timer = setTimeout(() => {
      timedOut = true;
      kill(child, o.killGraceMs ?? KILL_GRACE_MS, { group: true });
    }, run.timeoutSec * 1000);
    const onAbort = () => {
      stopped = true;
      kill(child, 2000, { group: true });
    };
    o.signal?.addEventListener("abort", onAbort, { once: true });
    let failed: string | null = null;
    child.on("error", (e: NodeJS.ErrnoException) => {
      failed = e.code === "ENOENT" ? "the command wasn't found" : `couldn't start the command (${e.code ?? e.message.slice(0, 60)})`;
    });
    // A command that doesn't read its input closes the pipe early; that's fine.
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify({ id: ev.id, eventId: ev.eventId, hook: ev.hook, type: ev.type, receivedAt: ev.receivedAt, verified: true, data: ev.data }));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      const ms = Date.now() - started;
      if (failed) return finish({ ok: false, exit: null, signal: null, ms, detail: failed });
      const detail = timedOut ? `timed out after ${run.timeoutSec} s` : stopped ? "the runner stopped" : undefined;
      finish({ ok: code === 0 && !timedOut, exit: code, signal: signal ?? null, ms, ...(detail ? { detail } : {}), ...(stopped ? { stopped } : {}) });
    });
  });
}

export interface RunnerDeps {
  ctx: Context;
  /** Send a frame on the current connection; false when there's none (the journal keeps the result). */
  send(frame: object): boolean;
  log(line: string): void;
  machine?: string;
  /** Waits out a debounce (tests make it instant). */
  sleep?(ms: number): Promise<void>;
  killGraceMs?: number;
}

/**
 * The runner's work: jobs from the gateway, queued per webhook and run one at a time, each result
 * journaled, then reported. `onFrame` takes what the socket brings; `hello()` is what to say on
 * every (re)connection.
 */
export class Runner {
  private queues = new Map<string, RunJob[]>();
  private busy = new Map<string, Promise<void>>();
  /** Jobs held here: waiting their turn, or started (acked). */
  private held = new Map<string, "queued" | "started">();
  private journal: Journal;
  private stopping = new AbortController();
  readonly machine: string;

  constructor(private deps: RunnerDeps) {
    this.journal = new Journal(journalPath(deps.ctx));
    this.machine = deps.machine ?? machineName();
  }

  hello() {
    const hooks = Object.entries(currentRuns(this.deps.ctx))
      .filter(([name]) => HOOK.test(name))
      .slice(0, RUN_MAX.hooks)
      .map(([name, r]) => ({ name, timeoutSec: clamp(r.timeoutSec, 1, RUN_MAX.timeoutSec, RUN_DEFAULTS.timeoutSec), debounceSec: clamp(r.debounceSec, 0, RUN_MAX.debounceSec, 0) }));
    return { t: "hello", v: 1, machine: { name: this.machine, os: process.platform === "darwin" || process.platform === "win32" ? process.platform : "linux", version }, hooks };
  }

  onFrame(msg: unknown): void {
    const m = msg as { t?: unknown; hooks?: { name: string; routed: boolean; machine: string | null }[]; unknown?: string[] };
    if (m?.t === "welcome") {
      for (const h of m.hooks ?? []) {
        if (!h.routed) this.deps.log(`${h.name}: this webhook doesn't run commands yet (0b webhook set ${h.name} --route run)`);
        else if (h.machine && h.machine.toLowerCase() !== this.machine.toLowerCase()) this.deps.log(`${h.name}: runs only on ${h.machine}, not here`);
      }
      for (const n of m.unknown ?? []) this.deps.log(`${n}: there's no webhook with this name on your account (0b webhook run ${n} --off forgets it here)`);
      return;
    }
    const job = parseJob(msg);
    if (!job) return;
    // Dedupe: a result we have is answered again; a job we hold isn't run twice.
    const had = this.journal.get(job.id);
    if (had) {
      this.report([had]);
      return;
    }
    const held = this.held.get(job.id);
    if (held === "started") this.deps.send({ t: "ack", id: job.id });
    if (held) return;
    this.held.set(job.id, "queued");
    const q = this.queues.get(job.event.hook) ?? [];
    q.push(job);
    this.queues.set(job.event.hook, q);
    this.pump(job.event.hook);
  }

  /** Resolves when nothing is queued or running (tests). */
  async idle(): Promise<void> {
    while (this.busy.size) await Promise.all([...this.busy.values()]);
  }

  /** Stop: running commands are ended and not journaled (the gateway sends them again). */
  async shutdown(): Promise<void> {
    this.stopping.abort();
    for (const q of this.queues.values()) q.length = 0;
    await this.idle();
  }

  private pump(hook: string) {
    if (this.busy.has(hook)) return;
    const p = this.drain(hook).finally(() => this.busy.delete(hook));
    this.busy.set(hook, p);
  }

  private start(job: RunJob) {
    this.held.set(job.id, "started");
    this.deps.send({ t: "ack", id: job.id });
  }

  private async drain(hook: string): Promise<void> {
    const q = this.queues.get(hook)!;
    while (q.length && !this.stopping.signal.aborted) {
      const batch = [q.shift()!];
      this.start(batch[0]!);
      const debounce = currentRuns(this.deps.ctx)[hook]?.debounceSec ?? 0;
      if (debounce > 0) {
        await (this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))))(Math.min(debounce, RUN_MAX.debounceSec) * 1000);
        for (const j of q.splice(0)) this.start(j), batch.push(j);
      }
      if (this.stopping.signal.aborted) break;
      // The newest event is the one the command gets; the others say they were folded into it.
      const newest = batch.reduce((a, b) => (b.event.receivedAt >= a.event.receivedAt ? b : a));
      const run = currentRuns(this.deps.ctx)[hook];
      const r = run
        ? await execRun({ ...run, timeoutSec: clamp(run.timeoutSec, 1, RUN_MAX.timeoutSec, RUN_DEFAULTS.timeoutSec) }, newest.event, {
            count: batch.length,
            log: logPath(this.deps.ctx, hook),
            killGraceMs: this.deps.killGraceMs,
            signal: this.stopping.signal,
          })
        : { ok: false, exit: null, signal: null, ms: 0, detail: `no command for ${hook} on this machine any more` };
      if ("stopped" in r && r.stopped) {
        for (const j of batch) this.held.delete(j.id);
        break;
      }
      const at = Date.now();
      const results: RunResult[] = batch.map((j) => ({
        id: j.id,
        hook,
        ok: r.ok,
        exit: r.exit,
        signal: r.signal,
        ms: r.ms,
        ...(r.detail ? { detail: r.detail } : {}),
        ...(j !== newest ? { coalescedInto: newest.id } : {}),
        at,
      }));
      // Journal first: a crash after this replays the result instead of running it again.
      try {
        this.journal.add(results);
      } catch (e) {
        this.deps.log(`couldn't write ${journalPath(this.deps.ctx)}: ${e instanceof Error ? e.message : e}`);
      }
      for (const j of batch) this.held.delete(j.id);
      this.report(results);
      this.deps.log(`${hook} ${newest.id} ${newest.event.type}${batch.length > 1 ? ` (+${batch.length - 1} folded in)` : ""}: ${r.exit !== null ? `exit ${r.exit}` : (r.detail ?? "didn't run")} in ${seconds(r.ms)}`);
    }
  }

  private report(results: RunResult[]) {
    for (const r of results)
      this.deps.send({ t: "result", id: r.id, ok: r.ok, exit: r.exit, signal: r.signal, ms: r.ms, ...(r.detail ? { detail: r.detail } : {}), ...(r.coalescedInto ? { coalescedInto: r.coalescedInto } : {}) });
  }
}

const clamp = (v: unknown, min: number, max: number, dflt: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(Math.round(v), min), max) : dflt);

/** Lock files this process holds (a second listener in the same process is refused too). */
const holding = new Set<string>();

/** One runner per machine home: a pid file, taken over when its process is gone. */
function takeLock(ctx: Context): () => void {
  const path = lockPath(ctx);
  const pid = Number(readText(path)?.trim());
  if (pid === process.pid && holding.has(path)) throw new Error(`a webhook runner is already running here (pid ${pid})`);
  if (pid && pid !== process.pid) {
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (e) {
      alive = (e as NodeJS.ErrnoException).code === "EPERM";
    }
    if (alive) throw new Error(`a webhook runner is already running here (pid ${pid}); its service is \`0b webhook listen on|off\``);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, `${process.pid}\n`);
  holding.add(path);
  return () => {
    holding.delete(path);
    if (Number(readText(path)?.trim()) === process.pid) rmSync(path, { force: true });
  };
}

export interface ListenOptions {
  log?: (line: string) => void;
  /** Stops the runner (tests; SIGINT and SIGTERM do it otherwise). */
  signal?: AbortSignal;
  /** For tests: what opens a socket, and how fast to retry. */
  open?: LoopOptions["open"];
  minDelay?: number;
  killGraceMs?: number;
}

/** `0b webhook listen`: connect and run commands for events until stopped. */
export async function runListener(ctx: Context, opts: ListenOptions = {}): Promise<void> {
  const cfg = loadCloud(ctx);
  const token = cfg && openSecretStore(ctx.storeDir).get(deviceTokenKey(cfg));
  if (!cfg || !token) throw new Error("sign in first: 0b login");
  if (typeof WebSocket === "undefined" && !opts.open) throw new Error("this needs Node 22 or newer (WebSocket)");
  const log = opts.log ?? ((line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`));
  const release = takeLock(ctx);
  const server = cfg.server.replace(/\/+$/, "");
  let conn: Conn | null = null;
  let replaced = false;
  const runner = new Runner({ ctx, send: (f) => conn?.send(f) ?? false, log, killGraceMs: opts.killGraceMs });
  const loop = connectLoop(`${server.replace(/^http/, "ws")}/api/triggers/runner`, token, (msg) => runner.onFrame(msg), {
    open: opts.open,
    minDelay: opts.minDelay,
    // A socket that never opened: is it the token (deleted while this machine was off)?
    refused: async () => (await fetch(`${server}/api/triggers`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) })).status === 401,
    onOpen: (c) => {
      conn = c;
      const hello = runner.hello();
      c.send(hello);
      log(`connected to ${cfg.server} as ${runner.machine}: ${hello.hooks.length ? hello.hooks.map((h) => h.name).join(", ") : "no webhook commands here yet (0b webhook run <name> -- <command>)"}`);
    },
    onClose: (code, reason) => {
      if (conn) log(`disconnected (${code}${reason ? ` ${reason}` : ""})`);
      conn = null;
      // Another runner signed in with this machine's token took over: two would take turns forever.
      if (code === 4002) {
        replaced = true;
        loop.stop();
      }
    },
  });

  // webhooks.json changed (0b webhook run, --off): tell the gateway what this machine runs now.
  const file = runsPath(ctx);
  const mtime = () => (existsSync(file) ? statSync(file).mtimeMs : 0);
  let seen = mtime();
  const watch = setInterval(() => {
    if (mtime() === seen) return;
    seen = mtime();
    conn?.send(runner.hello());
  }, 5000);

  const stop = () => loop.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  opts.signal?.addEventListener("abort", stop, { once: true });
  try {
    const final = await loop.done;
    if (replaced) log("another runner with this machine's sign-in connected, so this one stopped");
    else if (final === 4001) log("this device's sign-in was removed (or the account deleted): sign in again with 0b login");
  } finally {
    clearInterval(watch);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await runner.shutdown();
    release();
  }
}
