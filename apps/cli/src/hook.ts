import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { loadHistoryConfig, statusEnabled, syncWanted, tryLock, type Context } from "@0bridge/core";

/**
 * `0b hook <claude|codex|cursor>`: what an agent's hooks run (D46, round 2 R1). When a turn ends it
 * marks the conversation for upload and wakes the sync worker (`0b history sync --worker`); with
 * the status board on, every event it runs on also leaves a status mark (working, needs you, idle,
 * ended) and wakes the status worker (`0b sessions push --worker`). It only writes small files:
 * never the network, never stdout (a UserPromptSubmit hook's output is added to the prompt), never
 * a failure, so it can't get in the agent's way.
 */

const MAX_INPUT = 1024 * 1024;
const INPUT_MS = 200;
/** What a mark keeps of a prompt or the agent's last message: the worker sends 200 characters at most. */
const MARK_TEXT = 2000;

export const syncDir = (ctx: Context) => join(ctx.storeDir, "sync");
export const dirtyDir = (ctx: Context) => join(syncDir(ctx), "dirty");
export const workerLockPath = (ctx: Context) => join(syncDir(ctx), "worker.lock");

export const statusDir = (ctx: Context) => join(ctx.storeDir, "status");
export const statusMarksDir = (ctx: Context) => join(statusDir(ctx), "marks");
export const statusLockPath = (ctx: Context) => join(statusDir(ctx), "worker.lock");

export type LiveState = "working" | "needs-you" | "idle" | "ended" | "error";

/** One hook event as the status worker reads it: the newest per session wins. */
export interface StatusMark {
  tool: string;
  native: string;
  /** The agent's event name (UserPromptSubmit, Notification, Stop, notify…). */
  event: string;
  state: LiveState;
  reason?: "permission" | "input";
  /** When the hook ran (ms). */
  at: number;
  cwd?: string;
  /** The conversation's log file, when the agent names it. */
  transcript?: string;
  /** The prompt just submitted (working). */
  prompt?: string;
  /** The agent's notice (needs-you) or its last message (idle). */
  message?: string;
  /** What it asks permission for: a command or a file (needs-you). */
  detail?: string;
  /** The session's title, when the agent sends one. */
  title?: string;
}

/** What the agent sent on stdin (its hook JSON), at most 1 MB and 200 ms; nothing from a terminal. */
function readInput(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const done = () => {
      clearTimeout(timer);
      process.stdin.removeAllListeners();
      process.stdin.pause();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(done, INPUT_MS);
    process.stdin.on("data", (d: Buffer) => {
      chunks.push(d);
      size += d.length;
      if (size >= MAX_INPUT) done();
    });
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

const parse = (json: string | undefined): Record<string, unknown> | null => {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** The conversation's log file from a hook's JSON (Claude Code and Codex send `transcript_path`); else null. */
export function transcriptOf(json: string): string | null {
  const j = parse(json);
  const p = j?.transcript_path ?? j?.transcriptPath;
  return typeof p === "string" && isAbsolute(p) ? p : null;
}

const str = (v: unknown, max = MARK_TEXT) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const NATIVE = /^[A-Za-z0-9._:-]{1,128}$/;
const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/**
 * The session id history uses for this log file (core history.ts): Claude Code's file name, the
 * uuid in a Codex rollout's name; else the id the agent sent.
 */
function nativeOf(tool: string, transcript: string | undefined, id: unknown): string | null {
  let n: string | undefined;
  if (transcript && tool === "claude-code") n = basename(transcript, ".jsonl");
  else if (transcript && tool === "codex") n = UUID.exec(basename(transcript))?.[1];
  n ??= typeof id === "string" ? id : undefined;
  n = n?.replace(/[^A-Za-z0-9._:-]/g, "");
  return n && NATIVE.test(n) ? n : null;
}

/** "Bash: npm test" / "Edit: src/app.ts": what a permission request is for, from its tool input. */
function detailOf(tool: unknown, input: unknown): string | undefined {
  if (typeof tool !== "string" || !input || typeof input !== "object") return undefined;
  const i = input as Record<string, unknown>;
  const what = str(i.command, 300) ?? str(i.file_path, 300) ?? str(i.path, 300) ?? str(i.url, 300);
  return what ? `${tool}: ${what.split("\n")[0]}` : undefined;
}

/** The first question of AskUserQuestion's input, if it has one. */
function questionOf(input: unknown): string | undefined {
  const qs = (input as { questions?: unknown } | null)?.questions;
  return Array.isArray(qs) ? str((qs[0] as { question?: unknown } | undefined)?.question) : undefined;
}

const AGENT: Record<string, string> = { "claude-code": "Claude", codex: "Codex", cursor: "Cursor" };

/**
 * What a hook's input means for the board (section 2 of the round-2 plan), or null when it says
 * nothing about state (an idle reminder, an unknown event). `args` are the hook's arguments:
 * `<target>`, and for Codex's `notify` its JSON.
 */
export function statusMark(args: string[], input: string, now = Date.now()): StatusMark | null {
  const target = args[0];
  const j = parse(input) ?? (target === "codex" ? parse(args[1]) : null);
  if (!j) return null;
  const tool = target === "claude" ? "claude-code" : target === "codex" ? "codex" : target === "cursor" ? "cursor" : null;
  if (!tool) return null;
  const transcript = typeof j.transcript_path === "string" && isAbsolute(j.transcript_path) ? j.transcript_path : undefined;
  const roots = Array.isArray(j.workspace_roots) ? j.workspace_roots : [];
  const cwd = str(j.cwd, 1000) ?? str(roots[0], 1000);
  let event = str(j.hook_event_name, 64);
  // Codex's notify (no hooks.json): only a finished turn, its JSON as an argument.
  if (!event && j.type === "agent-turn-complete") event = "notify";
  // Cursor before it named its events: the payload's shape says which one it is.
  if (!event && tool === "cursor") event = typeof j.status === "string" ? "stop" : typeof j.prompt === "string" ? "beforeSubmitPrompt" : undefined;
  if (!event) return null;
  const native = nativeOf(tool, transcript, j.session_id ?? j.conversation_id ?? j["thread-id"]);
  if (!native) return null;
  const base = { tool, native, event, at: now, ...(cwd ? { cwd } : {}), ...(transcript ? { transcript } : {}) };
  const who = AGENT[tool] ?? tool;

  switch (event) {
    case "UserPromptSubmit":
    case "beforeSubmitPrompt": {
      const title = str(j.session_title, 200);
      return { ...base, state: "working", ...(str(j.prompt) ? { prompt: str(j.prompt) } : {}), ...(title ? { title } : {}) };
    }
    case "Notification": {
      const type = str(j.notification_type, 64);
      const message = str(j.message);
      // Older Claude Code sent no type: its permission notices say so.
      const reason =
        type === "permission_prompt" || type === "worker_permission_prompt" || (!type && /permission/i.test(message ?? ""))
          ? "permission"
          : type === "elicitation_dialog" || type === "elicitation_url_dialog" || type === "agent_needs_input"
            ? "input"
            : null;
      // idle_prompt ("waiting for your input" a minute after a turn) and the rest change nothing.
      return reason ? { ...base, state: "needs-you", reason, ...(message ? { message } : {}) } : null;
    }
    case "PermissionRequest": {
      const tn = str(j.tool_name, 100);
      if (tn === "AskUserQuestion") return { ...base, state: "needs-you", reason: "input", message: questionOf(j.tool_input) ?? `${who} has a question for you` };
      const detail = detailOf(tn, j.tool_input);
      return { ...base, state: "needs-you", reason: "permission", message: `${who} needs your permission to use ${tn ?? "a tool"}`, ...(detail ? { detail } : {}) };
    }
    case "Stop":
    case "notify": {
      const message = str(j.last_assistant_message) ?? str(j["last-assistant-message"]);
      return { ...base, state: "idle", ...(message ? { message } : {}) };
    }
    case "stop":
      return { ...base, state: j.status === "error" ? "error" : "idle" };
    case "SessionEnd":
      return { ...base, state: "ended" };
    default:
      return null;
  }
}

/** Events that end a turn (or the session): history uploads then. Unknown input counts, so a turn is never missed. */
const TURN_END = new Set(["Stop", "SessionEnd", "stop", "notify"]);

/** Mark a log file (or `*`: everything) for the worker's next upload. */
export function markDirty(ctx: Context, what: string): void {
  mkdirSync(dirtyDir(ctx), { recursive: true });
  writeFileSync(join(dirtyDir(ctx), createHash("sha1").update(what).digest("hex")), what);
}

/** The marks waiting now (file name → what it marks). */
export function pendingMarks(ctx: Context): Map<string, string> {
  const out = new Map<string, string>();
  let names: string[] = [];
  try {
    names = readdirSync(dirtyDir(ctx));
  } catch {
    return out;
  }
  for (const n of names) {
    try {
      out.set(n, readFileSync(join(dirtyDir(ctx), n), "utf8").trim() || "*");
    } catch {}
  }
  return out;
}

/** Take the marks waiting now: they're removed, so one written during the upload stays for the next round. */
export function takeMarks(ctx: Context): string[] {
  const marks = pendingMarks(ctx);
  for (const n of marks.keys()) rmSync(join(dirtyDir(ctx), n), { force: true });
  return [...new Set(marks.values())];
}

/** Leave a status mark for the worker: one file per session, replaced whole (written aside, then renamed). */
export function writeStatusMark(ctx: Context, m: StatusMark): void {
  const dir = statusMarksDir(ctx);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${createHash("sha1").update(`${m.tool}:${m.native}`).digest("hex")}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(m));
  renameSync(tmp, file);
}

/** Take the status marks waiting now, oldest first; a mark written meanwhile stays for the next round. */
export function takeStatusMarks(ctx: Context): StatusMark[] {
  const dir = statusMarksDir(ctx);
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: StatusMark[] = [];
  for (const n of names) {
    // Claimed by a rename first: a hook renaming a newer mark onto the name meanwhile leaves it for the next round.
    const path = join(dir, `${n}.${process.pid}.taking`);
    try {
      renameSync(join(dir, n), path);
    } catch {
      continue;
    }
    try {
      const text = readFileSync(path, "utf8");
      rmSync(path, { force: true });
      const m = JSON.parse(text) as StatusMark;
      if (m && typeof m.native === "string" && typeof m.tool === "string" && typeof m.state === "string") out.push(m);
    } catch {}
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Start a worker in the background (`args` after the script), its output going to `log` (cut when it passes 1 MB). */
function spawnWorker(log: string, args: string[]): void {
  let big = false;
  try {
    big = statSync(log).size > 1024 * 1024;
  } catch {}
  const fd = openSync(log, big ? "w" : "a");
  const child = spawn(process.execPath, [process.argv[1]!, ...args], {
    detached: true,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  closeSync(fd);
}

/** Start the worker behind `lock` unless one runs (it picks the new marks up then). Returns whether it started one. */
function wake(lock: string, log: string, args: string[]): boolean {
  const free = tryLock(lock);
  if (!free) return false;
  free();
  spawnWorker(log, args);
  return true;
}

/**
 * Leave the marks the hook's input calls for and make sure workers will act on them: the history
 * mark when a turn ends and history is on, the status mark when the board is on. Returns which
 * workers it started.
 */
export function runHook(ctx: Context, args: string[], input: string): { history: boolean; status: boolean } {
  const started = { history: false, status: false };
  const mark = statusMark(args, input);
  if (mark && statusEnabled(ctx)) {
    writeStatusMark(ctx, mark);
    started.status = wake(statusLockPath(ctx), join(statusDir(ctx), "worker.log"), ["sessions", "push", "--worker"]);
  }
  // Usage-only mode (round 2 R14) uploads token counts with the same worker.
  const history = syncWanted(loadHistoryConfig(ctx));
  if (history && (!mark || TURN_END.has(mark.event))) {
    // Codex's `notify` passes its JSON as an argument instead (and names no transcript).
    const transcript = transcriptOf(input) ?? (args[1] ? transcriptOf(args[1]) : null);
    markDirty(ctx, transcript ?? "*");
    // A worker running now picks the mark up; otherwise start one.
    started.history = wake(workerLockPath(ctx), join(syncDir(ctx), "worker.log"), ["history", "sync", "--worker"]);
  }
  return started;
}

export async function hookCommand(ctx: Context, args: string[]): Promise<void> {
  try {
    runHook(ctx, args, await readInput());
  } catch {
    // Never in the agent's way: the periodic sync catches up.
  }
  process.exit(0);
}
