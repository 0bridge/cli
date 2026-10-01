import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readSync, rmSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  CloudError,
  executePlan,
  hooksStatus,
  injected,
  loadHistoryConfig,
  loadState,
  ownedHooks,
  planHooks,
  readJson,
  redact,
  repoFor,
  saveState,
  statusEnabled,
  statusPath,
  tryLock,
  writeAtomic,
  type Context,
  type ToolId,
} from "@0bridge/core";
import { cloudClient } from "./cloud.ts";
import { statusDir, statusLockPath, statusMarksDir, takeStatusMarks, type LiveState, type StatusMark } from "./hook.ts";
import { binPath, ensureBin } from "./service.ts";
import { vaultValues } from "./vault.ts";
import { c } from "./ui.ts";

/**
 * `0b sessions` (round 2, D51): what your coding sessions are doing now, on every machine and in
 * the cloud, and whether this machine posts its sessions' states (`on`/`off`). The agents' hooks
 * leave a mark per event (hook.ts); the status worker (`0b sessions push --worker`, started by
 * the hook, one per machine) turns marks into updates — the repo, the branch, a title and at most
 * two lines, secrets masked here — and posts them, the first at once and then at most one POST per
 * 2 s. While a session waits for you it looks at its transcript every 3 s: once it grows, you
 * answered, and the session is working again.
 */

export interface SessionsOptions {
  state?: string;
  machine?: string;
  repo?: string;
  json?: boolean;
  quiet?: boolean;
  /** `0b sessions push --worker`: the status worker a hook starts. */
  worker?: boolean;
}

/** What POST /api/status takes (apps/gateway/src/status.ts). */
export interface StatusUpdate {
  tool: string;
  native: string;
  state: LiveState;
  reason?: "permission" | "input";
  at: number;
  cwd?: string;
  repo?: string;
  branch?: string;
  title?: string;
  lines?: string[];
  machine?: string;
}

/** What GET /api/status returns. */
export interface BoardEntry {
  id: string;
  tool: string;
  machine: string;
  machineId: string | null;
  kind: "local" | "agent-vm" | "cloud" | "task";
  repo: string | null;
  branch: string | null;
  cwd: string | null;
  title: string | null;
  state: LiveState;
  reason: "permission" | "input" | null;
  lines: string[];
  since: number;
  updatedAt: number;
  stale: boolean;
  task?: string;
}
export interface Board {
  entries: BoardEntry[];
  counts: Record<LiveState, number>;
  now: number;
}

function fail(msg: string): never {
  console.error(c.red(`error: ${msg}`));
  process.exit(1);
}

// ── The worker ──

/** At most one POST per this long (R3). */
export const POST_GAP_MS = 2_000;
/** How often a session that needs you has its transcript looked at. */
export const WATCH_MS = 3_000;
/** A session that needs you is watched this long at most. */
export const WATCH_MAX_MS = 10 * 60_000;
/** The worker leaves after this long with nothing to do. */
export const IDLE_EXIT_MS = 15_000;
const TICK_MS = 250;
/** Posts that fail in a row before the worker drops what it has (the next hook tries again). */
const MAX_FAILURES = 5;
const LINE = 200;
const TITLE = 80;

/** What the worker needs from the world; tests swap in a clock, a fake server and fake files. */
export interface WorkerDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** The hooks' marks waiting now (taken: removed). */
  take(): StatusMark[];
  /**
   * POST /api/status; throws when it didn't go through. The server answers `text: false` while
   * history is end-to-end encrypted: from then on no lines and no title go up (R4).
   */
  post(updates: StatusUpdate[]): Promise<{ text?: boolean } | void>;
  /** Whether the last answer said no text, remembered across runs. */
  noText?: { get(): boolean; set(off: boolean): void };
  /** A transcript's size now, or null when it's gone. */
  size(path: string): number | null;
  repo(cwd: string): string | undefined;
  branch(cwd: string): string | undefined;
  /** The agent's last words, from the end of its transcript. */
  lastAssistant(path: string): string | undefined;
  /** Values to mask (the vault's). */
  values(): string[];
  /** Titles remembered across runs, so a session keeps the one its first prompt gave it. */
  titles: { get(id: string): string | undefined; set(id: string, title: string): void; save(): void };
  machine: string;
  log(msg: string): void;
}

/** The first line of `text` worth showing: markdown marks and extra spaces out, at most `max` characters. */
export function firstLine(text: string | undefined, max = LINE): string | undefined {
  for (const raw of (text ?? "").split("\n")) {
    const l = raw
      .replace(/^\s*(?:#{1,6}\s+|[-*>]\s+|\d+\.\s+)/, "")
      .replace(/[*_`]+/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (l) return l.length > max ? `${l.slice(0, max - 1)}…` : l;
  }
  return undefined;
}

/**
 * Turns the hooks' marks into posts: the newest update per session, at most one POST per 2 s, and
 * a watch on sessions that need you (their transcript growing means you answered).
 */
export class StatusWorker {
  /** id → the update to send next. */
  readonly pending = new Map<string, StatusUpdate>();
  /** id → a session waiting for you: its transcript's size when it started waiting. */
  readonly watching = new Map<string, { transcript: string; size: number; since: number; update: StatusUpdate }>();
  private lastPost = -Infinity;
  private lastWatch = 0;
  private lastBusy: number;
  private failures = 0;
  private branches = new Map<string, { at: number; branch: string | undefined }>();
  private values: string[] | null = null;
  private noText: boolean;

  constructor(private d: WorkerDeps) {
    this.lastBusy = d.now();
    this.noText = d.noText?.get() ?? false;
  }

  private mask(s: string): string {
    this.values ??= this.d.values();
    return redact(s, this.values);
  }

  /** The branch checked out in `cwd`, asked of git at most once a minute. */
  private branch(cwd: string): string | undefined {
    const hit = this.branches.get(cwd);
    if (hit && this.d.now() - hit.at < 60_000) return hit.branch;
    const branch = this.d.branch(cwd);
    this.branches.set(cwd, { at: this.d.now(), branch });
    return branch;
  }

  /** A mark as the board's update: repo, branch, title, and its lines (R4), secrets masked. */
  update(m: StatusMark): StatusUpdate {
    const id = `${m.tool}:${m.native}`;
    const lines: string[] = [];
    const add = (s: string | undefined) => {
      const l = firstLine(s ? this.mask(s) : undefined);
      if (l) lines.push(l);
    };
    // A prompt the tool wrote itself (a task notification, a command wrapper) says nothing about the work.
    const prompt = m.prompt && !injected(m.prompt) ? m.prompt : undefined;
    if (m.state === "working") add(prompt);
    else if (m.state === "needs-you") (add(m.message), add(m.detail));
    else if (m.state === "idle" || m.state === "error") add(m.message ?? (m.transcript ? this.d.lastAssistant(m.transcript) : undefined));
    let title = m.title ? firstLine(this.mask(m.title), TITLE) : this.d.titles.get(id);
    if (!title && m.state === "working" && prompt) title = firstLine(this.mask(prompt), TITLE);
    if (title && title !== this.d.titles.get(id)) this.d.titles.set(id, title);
    const repo = m.cwd ? this.d.repo(m.cwd) : undefined;
    const branch = m.cwd ? this.branch(m.cwd) : undefined;
    return {
      tool: m.tool,
      native: m.native,
      state: m.state,
      ...(m.reason ? { reason: m.reason } : {}),
      at: m.at,
      ...(m.cwd ? { cwd: m.cwd } : {}),
      ...(repo ? { repo } : {}),
      ...(branch ? { branch } : {}),
      ...(title ? { title } : {}),
      lines: lines.slice(0, 2),
      machine: this.d.machine,
    };
  }

  /** Queue the marks: the newest per session wins; one that needs you starts a watch, anything else ends it. */
  collect(marks: StatusMark[]): void {
    for (const m of [...marks].sort((a, b) => a.at - b.at)) {
      const id = `${m.tool}:${m.native}`;
      const prev = this.pending.get(id);
      if (prev && prev.at > m.at) continue;
      const u = this.update(m);
      this.pending.set(id, u);
      this.watching.delete(id);
      if (m.state === "needs-you" && m.transcript) {
        const size = this.d.size(m.transcript);
        if (size !== null) this.watching.set(id, { transcript: m.transcript, size, since: this.d.now(), update: u });
      }
    }
    if (marks.length) this.d.titles.save();
  }

  /** Sessions that needed you and whose transcript grew since: you answered, they work again. */
  watch(): void {
    const now = this.d.now();
    for (const [id, w] of this.watching) {
      const size = this.d.size(w.transcript);
      if (size === null || now - w.since > WATCH_MAX_MS) this.watching.delete(id);
      else if (size > w.size) {
        this.watching.delete(id);
        const { reason: _, ...rest } = w.update;
        this.pending.set(id, { ...rest, state: "working", at: now, lines: [] });
      }
    }
  }

  /** Post up to 20 waiting updates if the last POST was 2 s ago or more. */
  async flush(): Promise<void> {
    const now = this.d.now();
    if (!this.pending.size || now - this.lastPost < POST_GAP_MS) return;
    this.lastPost = now;
    const batch = [...this.pending.values()].sort((a, b) => a.at - b.at).slice(0, 20);
    try {
      // End-to-end history: state, repo and age only; the prompt's words stay here.
      const r = await this.d.post(this.noText ? batch.map(({ title: _, ...u }) => ({ ...u, lines: [] })) : batch);
      if (r && typeof r.text === "boolean" && r.text === this.noText) {
        this.noText = !r.text;
        this.d.noText?.set(this.noText);
      }
      this.failures = 0;
      for (const u of batch) {
        const id = `${u.tool}:${u.native}`;
        if (this.pending.get(id) === u) this.pending.delete(id);
      }
    } catch (e) {
      this.d.log(e instanceof Error ? e.message : String(e));
      // Not signed in, or the token is gone: nothing will get through, so don't keep trying.
      if (++this.failures >= MAX_FAILURES || (e instanceof CloudError && (e.status === 401 || e.status === 403))) {
        this.pending.clear();
        this.watching.clear();
      }
    }
  }

  /** Until there's been nothing to do for 15 s (a session that needs you keeps it up, 10 min at most). */
  async run(): Promise<void> {
    for (;;) {
      const marks = this.d.take();
      if (marks.length) (this.collect(marks), (this.lastBusy = this.d.now()));
      if (this.watching.size && this.d.now() - this.lastWatch >= WATCH_MS) {
        this.lastWatch = this.d.now();
        this.watch();
      }
      if (this.pending.size) {
        await this.flush();
        this.lastBusy = this.d.now();
      } else if (!this.watching.size && this.d.now() - this.lastBusy >= IDLE_EXIT_MS) return;
      await this.d.sleep(TICK_MS);
    }
  }
}

/** The agent's last text in a Claude Code or Codex transcript, from its last 64 KB. */
export function lastAssistantText(path: string): string | undefined {
  let text = "";
  try {
    const fd = openSync(path, "r");
    try {
      const size = statSync(path).size;
      const len = Math.min(size, 64 * 1024);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      text = buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    let j: any;
    try {
      j = JSON.parse(lines[i]!);
    } catch {
      continue;
    }
    // Claude Code: {type: "assistant", message: {content: [{type: "text", text}]}}.
    const content = j?.type === "assistant" ? j.message?.content : j?.type === "response_item" && j.payload?.role === "assistant" ? j.payload.content : null;
    if (Array.isArray(content)) {
      const t = content.filter((b: any) => (b?.type === "text" || b?.type === "output_text") && typeof b.text === "string").map((b: any) => b.text as string).join("\n");
      if (t.trim()) return t;
    }
    // Codex: {type: "event_msg", payload: {type: "agent_message", message}}.
    if (j?.type === "event_msg" && j.payload?.type === "agent_message" && typeof j.payload.message === "string" && j.payload.message.trim()) return j.payload.message;
  }
  return undefined;
}

/** The branch checked out in `cwd` (none when detached or not a repo). */
function gitBranch(cwd: string): string | undefined {
  try {
    const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
    const b = r.status === 0 ? r.stdout.trim() : "";
    return b && b !== "HEAD" ? b : undefined;
  } catch {
    return undefined;
  }
}

/** status/titles.json: id → {title, at}, the newest 300 within a week. */
function titleCache(ctx: Context): WorkerDeps["titles"] {
  const path = join(statusDir(ctx), "titles.json");
  const map = new Map(Object.entries(readJsonSafe<Record<string, { title: string; at: number }>>(path) ?? {}));
  let dirty = false;
  return {
    get: (id) => map.get(id)?.title,
    set: (id, title) => {
      map.set(id, { title, at: Date.now() });
      dirty = true;
    },
    save: () => {
      if (!dirty) return;
      const week = Date.now() - 7 * 86_400_000;
      const keep = [...map].filter(([, v]) => v.at > week).sort((a, b) => b[1].at - a[1].at).slice(0, 300);
      writeAtomic(path, JSON.stringify(Object.fromEntries(keep)) + "\n", { mode: 0o600 });
      dirty = false;
    },
  };
}

function readJsonSafe<T>(path: string): T | null {
  try {
    return readJson<T>(path);
  } catch {
    return null;
  }
}

/** Present while the server says history is end-to-end encrypted (no text goes up). */
const noTextPath = (ctx: Context) => join(statusDir(ctx), "no-text");

/** Post the hooks' marks to the board (at most one POST per 2 s), and watch sessions that need you. */
export async function runStatusWorker(ctx: Context, deps?: Partial<WorkerDeps>): Promise<void> {
  const release = tryLock(statusLockPath(ctx));
  if (!release) return;
  const stamp = () => new Date().toISOString();
  try {
    if (!deps?.post) {
      try {
        cloudClient(ctx);
      } catch {
        // Not signed in: nothing can go up, so the marks go.
        takeStatusMarks(ctx);
        return;
      }
    }
    let client: ReturnType<typeof cloudClient>["client"] | null = null;
    const worker = new StatusWorker({
      now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      take: () => (statusEnabled(ctx) ? takeStatusMarks(ctx) : (takeStatusMarks(ctx), [])),
      post: async (updates) => {
        client ??= cloudClient(ctx).client;
        return client.call<{ text?: boolean }>("POST", "/status", { updates });
      },
      noText: {
        get: () => existsSync(noTextPath(ctx)),
        set: (off) => (off ? writeAtomic(noTextPath(ctx), "", { mode: 0o600 }) : rmSync(noTextPath(ctx), { force: true })),
      },
      size: (p) => {
        try {
          return statSync(p).size;
        } catch {
          return null;
        }
      },
      repo: (cwd) => repoFor(cwd),
      branch: gitBranch,
      lastAssistant: lastAssistantText,
      values: () => vaultValues(ctx),
      titles: titleCache(ctx),
      machine: hostname().replace(/\.local$/, ""),
      log: (msg) => console.error(`${stamp()} ${msg}`),
      ...deps,
    });
    await worker.run();
  } finally {
    release();
  }
  // A mark written while this worker was stopping saw it running and started none: go again.
  if (statusEnabled(ctx) && marksWaiting(ctx)) return runStatusWorker(ctx, deps);
}

/** Whether marks are waiting, without taking them. */
function marksWaiting(ctx: Context): boolean {
  try {
    return readdirSync(statusMarksDir(ctx)).some((n) => n.endsWith(".json"));
  } catch {
    return false;
  }
}

// ── on / off ──

const HOOK_LABEL = { claude: "Claude Code", codex: "Codex", cursor: "Cursor" } as const;
type StatusConfig = { enabled: boolean; since?: number; hooksBefore?: boolean };

const loadStatus = (ctx: Context): StatusConfig => readJsonSafe<StatusConfig>(statusPath(ctx)) ?? { enabled: false };
const saveStatus = (ctx: Context, s: StatusConfig) => writeAtomic(statusPath(ctx), JSON.stringify(s) + "\n", { mode: 0o600 });

/** Put our hooks in (or take them out) as history and the board want them, backed up like `0b apply`, recorded in state.json. */
function applyHooks(ctx: Context, historyWants: boolean): { changes: { tool: string; summary: string[]; path: string }[]; skipped: { target: string; why: string }[] } {
  const plan = planHooks(ctx, historyWants, historyWants || statusEnabled(ctx) ? ensureBin(ctx) : binPath(ctx));
  if (plan.changes.length) executePlan(ctx, { changes: plan.changes, warnings: [], missing: [], state: loadState(ctx) });
  const owned = ownedHooks(ctx);
  const state = loadState(ctx);
  for (const t of ["claude", "codex", "cursor"] as ToolId[]) {
    if (owned[t]) (state.managed[t] ??= { mcp: [], skills: [] }).hooks = owned[t];
    else if (state.managed[t]) delete state.managed[t]!.hooks;
  }
  saveState(ctx, state);
  return plan;
}

function on(ctx: Context): void {
  const before = hooksStatus(ctx);
  const had = (Object.keys(HOOK_LABEL) as (keyof typeof HOOK_LABEL)[]).some((t) => before[t] === "on");
  const cur = loadStatus(ctx);
  saveStatus(ctx, { enabled: true, since: cur.enabled ? cur.since : Date.now(), hooksBefore: cur.enabled ? cur.hooksBefore : had });
  const plan = applyHooks(ctx, had);
  for (const ch of plan.changes) console.log(`${c.green("✓")} ${HOOK_LABEL[ch.tool as keyof typeof HOOK_LABEL] ?? ch.tool}: ${ch.summary.join(", ")} ${c.dim(`(${ch.path.replace(ctx.home, "~")})`)}`);
  const status = hooksStatus(ctx);
  const hooked = (Object.keys(HOOK_LABEL) as (keyof typeof HOOK_LABEL)[]).filter((t) => status[t] === "on");
  for (const s of plan.skipped) if (s.target !== "gemini") console.log(c.dim(`  ${s.target}: ${s.why}`));
  if (!hooked.length) return console.log(c.yellow("No agent here takes the hooks (Claude Code, Codex, Cursor), so nothing reports yet. Install one, then run this again."));
  console.log(`${c.green("✓")} ${hooked.map((t) => HOOK_LABEL[t]).join(", ")} now report what each session is doing to your board. Restart running sessions to pick it up.`);
  if (hooked.includes("cursor")) console.log(c.dim("  Cursor has no hook for permission prompts, so its sessions never show as needing you."));
  if (plan.changes.some((ch) => ch.tool === "codex" && ch.path.endsWith("hooks.json")))
    console.log(c.dim("  Codex asks you to trust each new hook the first time it would run it; allow 0bridge's (they only leave a note for 0b)."));
  try {
    cloudClient(ctx);
    console.log(c.dim(`See it with ${c.cyan("0b sessions")}, on the dashboard (Now), or ask any connected AI.`));
  } catch {
    console.log(c.yellow(`Sign in so states can go up: ${c.cyan("0b login")}`));
  }
}

function off(ctx: Context): void {
  const cur = loadStatus(ctx);
  saveStatus(ctx, { enabled: false });
  // History keeps the turn-end hooks it had before the board came on.
  const keep = loadHistoryConfig(ctx).enabled && cur.hooksBefore !== false;
  const plan = applyHooks(ctx, keep);
  for (const ch of plan.changes) console.log(`${c.green("✓")} ${HOOK_LABEL[ch.tool as keyof typeof HOOK_LABEL] ?? ch.tool}: ${ch.summary.join(", ")} ${c.dim(`(${ch.path.replace(ctx.home, "~")})`)}`);
  console.log(`${c.green("✓")} This machine stopped posting its sessions' states.${keep ? " History still uploads each conversation as its turn ends." : ""}`);
}

// ── Reading the board ──

const STATE_LABEL: Record<LiveState, string> = { "needs-you": "NEEDS YOU", working: "WORKING", idle: "IDLE", ended: "ENDED", error: "FAILED" };
const TOOL_NAME: Record<string, string> = { "claude-code": "Claude Code", "claude-web": "Claude Code", codex: "Codex", cursor: "Cursor", gemini: "Gemini CLI" };

export function age(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/** The board as lines for a terminal: a header with the counts, then one row per session, needs-you first. */
export function renderBoard(b: Board, color = true): string[] {
  const paint = (s: LiveState, t: string) => (!color ? t : s === "needs-you" ? c.bold(c.yellow(t)) : s === "error" ? c.red(t) : s === "working" ? c.cyan(t) : c.dim(t));
  const dim = (t: string) => (color ? c.dim(t) : t);
  const n = b.counts;
  const out = [`${n["needs-you"]} ${n["needs-you"] === 1 ? "needs" : "need"} you · ${n.working} working · ${n.idle} idle${n.error ? ` · ${n.error} failed` : ""}`];
  if (!b.entries.length) return out;
  const rows = b.entries.map((e) => ({
    e,
    cols: [STATE_LABEL[e.state], e.machine, TOOL_NAME[e.tool] ?? e.tool, e.repo ? `${e.repo.replace(/^github\.com\//, "")}${e.branch ? `@${e.branch}` : ""}` : (e.cwd ?? "?"), age(b.now - e.since) + (e.stale ? "?" : "")],
  }));
  const width = rows[0]!.cols.map((_, i) => Math.min(Math.max(...rows.map((r) => r.cols[i]!.length)), 40));
  for (const { e, cols } of rows) {
    const [state, ...rest] = cols.map((col, i) => col.slice(0, 40).padEnd(width[i]!));
    const said = e.lines[0] ?? e.title;
    out.push(`${paint(e.state, state!)}  ${rest.join("  ")}${said ? `  ${dim(`"${said.slice(0, 100)}"`)}` : ""}`);
  }
  return out;
}

async function list(ctx: Context, opts: SessionsOptions): Promise<Board> {
  const q = new URLSearchParams();
  if (opts.state) q.set("state", opts.state);
  if (opts.machine) q.set("machine", opts.machine);
  if (opts.repo) q.set("repo", opts.repo);
  return cloudClient(ctx).client.call<Board>("GET", `/status${q.size ? `?${q}` : ""}`);
}

async function show(ctx: Context, opts: SessionsOptions): Promise<void> {
  const b = await list(ctx, opts);
  if (opts.json) return console.log(JSON.stringify(b, null, 2));
  for (const l of renderBoard(b)) console.log(l);
  if (!b.entries.length) {
    const any = Object.values(b.counts).some(Boolean);
    console.log(c.dim(any ? "Nothing matches that filter." : `No session has reported yet. On each machine: ${c.cyan("0b sessions on")}`));
  }
  if (!statusEnabled(ctx) && !opts.quiet) console.log(c.dim(`This machine doesn't post its sessions: ${c.cyan("0b sessions on")}`));
}

async function watch(ctx: Context, opts: SessionsOptions): Promise<void> {
  const tty = process.stdout.isTTY;
  for (;;) {
    let lines: string[];
    try {
      lines = renderBoard(await list(ctx, opts));
    } catch (e) {
      if (e instanceof CloudError && (e.status === 401 || e.status === 403)) throw e;
      lines = [c.yellow(`couldn't read the board: ${e instanceof Error ? e.message : String(e)}`)];
    }
    if (tty) process.stdout.write("\x1b[2J\x1b[H");
    console.log([...lines, c.dim(`\n${new Date().toLocaleTimeString()} · every 5 s · Ctrl-C to stop`)].join("\n"));
    await new Promise((r) => setTimeout(r, 5000));
  }
}

export async function sessionsCommand(ctx: Context, args: string[], opts: SessionsOptions): Promise<void> {
  const [sub] = args;
  switch (sub) {
    case undefined:
    case "list":
    case "ls":
    case "status":
      return show(ctx, opts);
    case "watch":
      return watch(ctx, opts);
    case "on":
      return on(ctx);
    case "off":
      return off(ctx);
    case "push":
      // `--worker` is how the hook starts it; without, it runs the same in the foreground.
      return runStatusWorker(ctx);
    default:
      fail(`unknown subcommand "sessions ${sub}". Try: 0b sessions [watch], 0b sessions on|off`);
  }
}
