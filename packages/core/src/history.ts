import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  HOUR_MS,
  addTokens,
  bucketKey,
  converters,
  countsOf,
  cursorAgentMessageIds,
  fromCursorBubbles,
  fromHermesMessages,
  parseBucket,
  toConversation,
  type Converter,
  type HermesMessage,
  type ParseResult,
  type ParseState,
  type TokenCounts,
  type UsageDelta,
} from "@0bridge/session";
import { redact } from "@0bridge/session/redact";
import { extraClaudeDirs } from "./adapters.ts";
import { repoOf } from "./profiles.ts";
import { readJson, writeAtomic } from "./util.ts";
import type { Context } from "./types.ts";

/**
 * Conversation history: read AI tools' session logs on this machine, keep the conversation
 * itself — what the person asked, what the agent answered, and the questions the agent asked back
 * with their answers — mask secrets, and hand new messages to the uploader. Tool calls, their
 * output and reasoning are left out. Each source is read from where the last sync stopped.
 *
 * Reading the logs into events is @0bridge/session's job (pure converters, 0b.session/1); this
 * module finds the logs, remembers where each one stopped, and turns events into the upload.
 */

/** Where logs are read from. Sessions are labeled more precisely (claude-app, codex-app). */
export type HistorySource = "claude-code" | "codex" | "grok" | "cursor" | "gemini" | "cursor-agent" | "openclaw" | "hermes";
export const HISTORY_SOURCES: HistorySource[] = ["claude-code", "codex", "grok", "cursor", "gemini", "cursor-agent", "openclaw", "hermes"];
/** The default before Gemini, Cursor CLI, OpenClaw and Hermes: a config that saved it gets those too. */
const OLD_DEFAULT: HistorySource[] = ["claude-code", "codex", "grok", "cursor"];
export type HistoryRole = "user" | "assistant" | "tool";

export interface HistoryMessage {
  seq: number;
  role: HistoryRole;
  at: number;
  text: string;
}

export interface HistorySession {
  id: string;
  /** claude-code, claude-app, codex, codex-app, grok, cursor, gemini, cursor-agent, openclaw, hermes */
  tool: string;
  device: string;
  cwd?: string;
  repo?: string;
  title?: string;
  /** The git branch the session ran on, when its log says. */
  branch?: string;
  /** The model it last used, when its log says. */
  model?: string;
  /** Which of the person's accounts of that tool (a second Claude config dir, CODEX_HOME); unset for the default one. */
  account?: string;
  startedAt: number;
  updatedAt: number;
  messages: HistoryMessage[];
}

/** Where each log's sync stopped: a byte offset in a file, a message id, or Cursor's last update time. */
interface Cursor {
  offset: number;
  /** Messages uploaded so far: the next one's seq. */
  seq: number;
  session: string;
  tool?: string;
  cwd?: string;
  title?: string;
  startedAt?: number;
  branch?: string;
  model?: string;
  account?: string;
  /** The converter's state, so the next read continues exactly where this one stopped. */
  state?: ParseState;
  /**
   * Token counts so far per "<model>|<hour>" (absolute totals, so re-uploading a bucket is
   * harmless). Buckets older than USAGE_KEEP_HOURS are dropped once uploaded.
   */
  usage?: Record<string, TokenCounts>;
}

/**
 * One session's tokens for one model in one hour, as uploaded (`POST /api/usage`): absolute
 * totals that replace what the server has for (session, model, hour). Counts only, never text.
 */
export interface UsageIn extends TokenCounts {
  /** "<tool>:<native>", the id history uses. */
  session: string;
  tool: string;
  model: string;
  /** floor(ms / 3_600_000), UTC. */
  hour: number;
  device: string;
  repo?: string;
  account?: string;
}

/** How long a log's usage buckets stay in its cursor after they were uploaded. */
const USAGE_KEEP_HOURS = 48;

export interface HistoryConfig {
  /** Sync runs only after `0b history on` on this machine. */
  enabled: boolean;
  /**
   * Upload token counts (round 2, P5). Unset follows `enabled`; true uploads them with history
   * off too (`0b usage on`), false never (`0b usage off`).
   */
  usage?: boolean;
  /**
   * Where each log stopped for usage alone (history off, usage on). Kept apart from `files`, so
   * turning history on later still uploads every conversation from the start.
   */
  usageFiles?: Record<string, Cursor>;
  tools: HistorySource[];
  /** Repos or folders never uploaded (substring of the repo or path). */
  exclude: string[];
  files: Record<string, Cursor>;
  lastSync?: number;
  /** `0b history on` asked about turn-end hooks and got a no: it doesn't ask again (`0b history hooks on` still adds them). */
  hooksDeclined?: boolean;
}

const MAX_MESSAGE = 16 * 1024;

export const historyPath = (ctx: Context) => join(ctx.storeDir, "history.json");

const sameSet = (a: string[], b: string[]) => a.length === b.length && b.every((x) => a.includes(x));

export function loadHistoryConfig(ctx: Context): HistoryConfig {
  const c = readJson<Partial<HistoryConfig>>(historyPath(ctx)) ?? {};
  // Someone who kept the old default list gets the new sources; a list they chose stays theirs.
  const tools = !c.tools || sameSet(c.tools, OLD_DEFAULT) ? HISTORY_SOURCES : c.tools;
  return {
    enabled: c.enabled ?? false,
    tools,
    exclude: c.exclude ?? [],
    files: c.files ?? {},
    lastSync: c.lastSync,
    ...(c.hooksDeclined ? { hooksDeclined: true } : {}),
    ...(typeof c.usage === "boolean" ? { usage: c.usage } : {}),
    ...(c.usageFiles ? { usageFiles: c.usageFiles } : {}),
  };
}

/** Whether token counts go up from this machine: `0b usage on|off`, else whatever history does. */
export const usageWanted = (c: HistoryConfig): boolean => c.usage ?? c.enabled;

/** Whether anything syncs from this machine's logs: history, or usage on its own. */
export const syncWanted = (c: HistoryConfig): boolean => c.enabled || c.usage === true;

/** Usage without history: the logs are read for token counts only, with their own cursors. */
export const usageOnly = (c: HistoryConfig): boolean => !c.enabled && c.usage === true;

export function saveHistoryConfig(ctx: Context, c: HistoryConfig): void {
  writeAtomic(historyPath(ctx), JSON.stringify(c) + "\n", { mode: 0o600 });
}

// ── Secrets ──

/** Masking lives in @0bridge/session (pure, so the gateway masks with the same rules); re-exported here. */
export { redact };
/** Text a tool injected rather than the person typed (the session board leaves it out). */
export { injected } from "@0bridge/session";

// ── Reading log files ──

/** Complete lines appended since `offset`; a half-written last line waits for the next run. */
function readNewLines(path: string, offset: number): { lines: string[]; offset: number } {
  const size = statSync(path).size;
  if (size < offset) offset = 0; // rewritten: start over
  if (size === offset) return { lines: [], offset };
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    const end = buf.lastIndexOf(0x0a);
    if (end < 0) return { lines: [], offset };
    return { lines: buf.subarray(0, end).toString("utf8").split("\n"), offset: offset + end + 1 };
  } finally {
    closeSync(fd);
  }
}

function* walk(dir: string, match: (name: string, path: string) => boolean, depth = 5): Generator<string> {
  if (depth < 0 || !existsSync(dir)) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, match, depth - 1);
    else if (match(e.name, p)) yield p;
  }
}

const subdirs = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
};

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

const clip = (s: string, n = MAX_MESSAGE) => (s.length > n ? `${s.slice(0, n)}… [${s.length - n} more characters]` : s);
const ms = (t: unknown) => (typeof t === "string" || typeof t === "number" ? new Date(typeof t === "string" && /^\d+$/.test(t) ? Number(t) : t).getTime() || 0 : 0);
const json = (line: string): any => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

/** An app's data folder: Application Support on macOS, %APPDATA% on Windows, ~/.config elsewhere. */
function appDir(ctx: Context, name: string): string {
  if (process.platform === "darwin") return join(ctx.home, "Library", "Application Support", name);
  if (process.platform === "win32") return join(ctx.home, "AppData", "Roaming", name);
  return join(ctx.home, ".config", name);
}

const repoCache = new Map<string, string | undefined>();
/** The repo (git remote) a session's working directory belongs to, cached per directory. */
export function repoFor(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  if (!repoCache.has(cwd)) {
    let r: string | undefined;
    try {
      r = existsSync(cwd) ? repoOf(cwd).remote : undefined;
    } catch {}
    repoCache.set(cwd, r);
  }
  return repoCache.get(cwd);
}

/** The Claude app's Code sessions run Claude Code; their transcripts are Claude Code's, their titles the app's. */
function claudeAppSessions(ctx: Context): Map<string, string | undefined> {
  const dir = join(appDir(ctx, "Claude"), "claude-code-sessions");
  const out = new Map<string, string | undefined>();
  for (const f of walk(dir, (n) => n.startsWith("local_") && n.endsWith(".json"), 3)) {
    const d = json(readFileSync(f, "utf8"));
    if (d?.cliSessionId) out.set(String(d.cliSessionId), d.title ? String(d.title) : undefined);
  }
  return out;
}

/** A folder of logs, and whose they are when it isn't the default account. */
interface Root {
  dir: string;
  account?: string;
}

interface FileSource {
  roots: (ctx: Context) => Root[];
  match: (name: string, path: string) => boolean;
  convert: Converter;
  /** The file is one document rewritten as it grows (Gemini): read whole, the state skips what was converted. */
  whole?: boolean;
  /** The native session id, from the path or what the converter saw. */
  idOf: (path: string, state: ParseState) => string;
  cwdOf?: (path: string) => string | undefined;
}

const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

/** ~/.claude, then other Claude config folders (a second account), each tagged with its name. */
const claudeRoots = (ctx: Context): Root[] => [
  { dir: join(ctx.home, ".claude", "projects") },
  ...extraClaudeDirs(ctx).map((d) => ({ dir: join(d, "projects"), account: basename(d).replace(/^\.claude-/, "") })),
];

/** ~/.codex, and CODEX_HOME when it points somewhere else (another account). */
function codexRoots(ctx: Context): Root[] {
  const roots: Root[] = [{ dir: join(ctx.home, ".codex", "sessions") }];
  const env = process.env.CODEX_HOME;
  if (env && resolve(env) !== resolve(ctx.home, ".codex")) roots.push({ dir: join(env, "sessions"), account: basename(resolve(env)).replace(/^\.codex-?/, "") || basename(resolve(env)) });
  return roots;
}

/** Gemini CLI writes the project's folder next to its chats (newer versions); older ones only hash it. */
function geminiCwd(path: string): string | undefined {
  const f = join(dirname(dirname(path)), ".project_root");
  try {
    return existsSync(f) ? readFileSync(f, "utf8").trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

const FILE_SOURCES: Partial<Record<HistorySource, FileSource>> = {
  "claude-code": { roots: claudeRoots, match: (n) => n.endsWith(".jsonl"), convert: converters["claude-code"], idOf: (p) => basename(p, ".jsonl") },
  codex: { roots: codexRoots, match: (n) => n.endsWith(".jsonl"), convert: converters.codex, idOf: (p) => UUID.exec(basename(p))?.[1] ?? basename(p, ".jsonl") },
  grok: {
    roots: (ctx) => [{ dir: join(ctx.home, ".grok", "sessions") }],
    match: (n) => n === "chat_history.jsonl",
    convert: converters.grok,
    idOf: (p) => basename(dirname(p)),
    cwdOf: (p) => {
      try {
        return decodeURIComponent(basename(dirname(dirname(p))));
      } catch {
        return undefined;
      }
    },
  },
  gemini: {
    roots: (ctx) => [{ dir: join(ctx.home, ".gemini", "tmp") }],
    match: (n, p) => n.startsWith("session-") && (n.endsWith(".json") || n.endsWith(".jsonl")) && basename(dirname(p)) === "chats",
    convert: converters["gemini-cli"],
    whole: true,
    idOf: (p, st) => (typeof st.x?.session === "string" ? st.x.session : basename(p).replace(/\.jsonl?$/, "")),
    cwdOf: geminiCwd,
  },
  // OpenClaw runs Codex with a Codex home per agent: ~/.openclaw/agents/<agent>/agent/codex-home.
  openclaw: {
    roots: (ctx) => subdirs(join(ctx.home, ".openclaw", "agents")).map((a) => ({ dir: join(a, "agent", "codex-home", "sessions") })),
    match: (n) => n.startsWith("rollout-") && n.endsWith(".jsonl"),
    convert: converters.openclaw,
    idOf: (p) => UUID.exec(basename(p))?.[1] ?? basename(p, ".jsonl"),
  },
};

/** The sources whose logs say how many tokens were used (the others are skipped in counts-only mode). */
export const USAGE_SOURCES: ReadonlySet<HistorySource> = new Set(["claude-code", "codex", "gemini", "openclaw"]);

export interface Collected {
  sessions: HistorySession[];
  /** Cursor updates to save once the upload succeeded. */
  cursors: Record<string, Cursor>;
  skipped: number;
  /** The absolute totals of every usage bucket that grew this round. */
  usage: UsageIn[];
}

interface Collector {
  device: string;
  values: string[];
  cfg: HistoryConfig;
  out: Collected;
  budget: number;
  /** Real paths already read this round, so a log reachable two ways (CODEX_HOME is ~/.openclaw/…) is read once. */
  seen: Set<string>;
  /** Token counts only: no sessions or messages are handed back. */
  countsOnly: boolean;
  /** The hour before which usage buckets leave the cursors. */
  keepFrom: number;
}

const excluded = (cfg: HistoryConfig, repo: string | undefined, cwd: string | undefined) => cfg.exclude.some((x) => (repo ?? "").includes(x) || (cwd ?? "").includes(x));

/**
 * Add a chunk's token deltas to a log's buckets: the new buckets (recent ones, plus any that grew
 * now), and the keys that grew. `prev` undefined starts over (a rewritten log is counted again).
 */
export function addUsage(prev: Record<string, TokenCounts> | undefined, deltas: UsageDelta[] | undefined, keepFrom: number): { buckets: Record<string, TokenCounts>; touched: string[] } {
  const buckets: Record<string, TokenCounts> = {};
  for (const [k, v] of Object.entries(prev ?? {})) if ((parseBucket(k)?.hour ?? 0) >= keepFrom) buckets[k] = v;
  const touched = new Set<string>();
  for (const d of deltas ?? []) {
    const k = bucketKey(d.model, d.hour);
    const before = buckets[k] ?? prev?.[k];
    buckets[k] = before ? addTokens(before, d) : countsOf(d);
    touched.add(k);
  }
  return { buckets, touched: [...touched] };
}

/**
 * The new usage buckets for a cursor, and the grown ones as upload rows. An excluded repo's
 * tokens still count, without the repo's name.
 */
function emitUsage(c: Collector, cursor: Cursor, prev: Cursor | undefined, deltas: UsageDelta[] | undefined, restart: boolean): void {
  const { buckets, touched } = addUsage(restart ? undefined : prev?.usage, deltas, c.keepFrom);
  // Buckets that grew stay in the cursor this once even when old (a first sync of an old log):
  // they're uploaded now, and the next round drops them.
  if (Object.keys(buckets).length) cursor.usage = buckets;
  if (!touched.length) return;
  const repo = repoFor(cursor.cwd);
  const named = repo && !excluded(c.cfg, repo, cursor.cwd) ? repo : undefined;
  for (const k of touched) {
    const b = parseBucket(k)!;
    c.out.usage.push({
      session: cursor.session,
      tool: cursor.tool ?? "claude-code",
      model: b.model,
      hour: b.hour,
      device: c.device,
      ...(named ? { repo: named } : {}),
      ...(cursor.account ? { account: cursor.account } : {}),
      ...buckets[k]!,
    });
  }
}

/** Turn parsed messages into a session for upload (or nothing new), updating the cursor. */
function emit(c: Collector, key: string, cursor: Cursor, prev: Cursor | undefined, parsed: Omit<HistoryMessage, "seq">[], base: number, fallbackAt: number) {
  c.out.cursors[key] = cursor;
  if (c.countsOnly) return;
  const repo = repoFor(cursor.cwd);
  if (excluded(c.cfg, repo, cursor.cwd)) {
    c.out.skipped++;
    return;
  }
  const titleChanged = cursor.title !== prev?.title;
  if (!parsed.length && !titleChanged) return;
  const messages = parsed.map((m, i) => ({ ...m, seq: base + i, text: redact(m.text, c.values) }));
  const first = messages.find((m) => m.role === "user")?.text;
  const updatedAt = Math.max(...messages.map((m) => m.at), cursor.startedAt ?? 0) || fallbackAt;
  c.out.sessions.push({
    id: cursor.session,
    tool: cursor.tool ?? "claude-code",
    device: c.device,
    cwd: cursor.cwd,
    repo,
    title: cursor.title ? redact(cursor.title, c.values) : !prev && first ? clip(first.replace(/\s+/g, " "), 80) : undefined,
    ...(cursor.branch ? { branch: cursor.branch } : {}),
    ...(cursor.model ? { model: cursor.model } : {}),
    ...(cursor.account ? { account: cursor.account } : {}),
    startedAt: cursor.startedAt ?? updatedAt,
    updatedAt,
    messages,
  });
}

/** The converter's result as upload messages; `at` 0 (a log without times) becomes `fallbackAt`. */
const conversation = (r: ParseResult, fallbackAt?: number) => toConversation(r.events).map((m) => (m.at || !fallbackAt ? m : { ...m, at: fallbackAt }));

function collectFiles(ctx: Context, c: Collector, source: HistorySource) {
  const src = FILE_SOURCES[source];
  if (!src) return;
  const app = source === "claude-code" ? claudeAppSessions(ctx) : new Map<string, string | undefined>();
  const roots = new Map<string, Root>();
  for (const r of src.roots(ctx)) if (!roots.has(real(r.dir))) roots.set(real(r.dir), r);
  for (const root of roots.values())
    for (const path of walk(root.dir, src.match)) {
      if (c.budget <= 0) return;
      const id = real(path);
      if (c.seen.has(id)) continue;
      c.seen.add(id);
      const prev = c.cfg.files[path];
      let size: number;
      try {
        size = statSync(path).size;
      } catch {
        continue;
      }
      if (prev && prev.offset === size) continue;
      let lines: string[];
      let offset: number;
      let restart: boolean;
      if (src.whole) {
        restart = !prev?.state;
        try {
          lines = readFileSync(path, "utf8").split("\n");
        } catch {
          continue;
        }
        offset = size;
        c.budget -= size;
      } else {
        restart = !prev || prev.offset > size;
        const from = restart ? 0 : (prev?.offset ?? 0);
        ({ lines, offset } = readNewLines(path, from));
        c.budget -= offset - from;
        // Only a line still being written (no newline yet): nothing new until it ends.
        if (prev && !restart && offset === prev.offset) continue;
      }
      const r = src.convert(lines, restart ? undefined : prev?.state);
      // One session per log file: Codex threads of one task share a session_id, and a resumed
      // Claude session can reuse its id in a new file, so the file's own id is the stable key.
      const native = src.idOf(path, r.state);
      const inApp = app.has(native);
      const tool = r.meta.tool ?? prev?.tool ?? (source === "claude-code" ? (inApp ? "claude-app" : "claude-code") : source);
      const base = restart ? 0 : (prev?.seq ?? 0);
      const mtime = statSync(path).mtimeMs;
      const messages = conversation(r, src.whole ? mtime : undefined);
      const cursor: Cursor = {
        offset,
        seq: base + messages.length,
        session: `${tool}:${native.replace(/[^A-Za-z0-9._-]/g, "")}`,
        tool,
        cwd: r.meta.cwd ?? prev?.cwd ?? src.cwdOf?.(path),
        title: r.meta.title ?? (inApp ? app.get(native) : undefined) ?? prev?.title,
        startedAt: prev?.startedAt ?? r.meta.startedAt,
        ...meta(r.state, root.account),
      };
      emitUsage(c, cursor, prev, r.usage, restart);
      emit(c, path, cursor, prev, messages, base, mtime);
    }
}

/** Branch, model and account for the upload, and the state to continue from (without what the cursor holds). */
function meta(state: ParseState, account: string | undefined): Pick<Cursor, "branch" | "model" | "account" | "state"> {
  const { cwd: _cwd, title: _title, ...rest } = state;
  return { branch: state.branch, model: state.model, account, state: rest };
}

// ── SQLite: Cursor's app and CLI, Hermes ──

type Sqlite = (db: string, query: string) => any[];
let sqliteImpl: Sqlite | null | undefined;
let sqliteWarned = false;

/**
 * A read-only query runner: the runtime's own SQLite (Bun's bun:sqlite, Node 22.5+'s node:sqlite),
 * else the sqlite3 command, else none (those sources are skipped with one warning).
 */
/** Whether Cursor's and Hermes' history can be read here (they need SQLite: Bun, Node 22.5+ or the sqlite3 command). */
export const sqliteAvailable = (): boolean => sqliteRunner() !== null;

function sqliteRunner(): Sqlite | null {
  if (sqliteImpl !== undefined) return sqliteImpl;
  const req = createRequire(import.meta.url);
  const open = (make: (path: string) => { all: (q: string) => any[]; close: () => void }): Sqlite => (db, query) => {
    const h = make(db);
    try {
      return h.all(query);
    } finally {
      h.close();
    }
  };
  try {
    if (process.versions.bun) {
      const { Database } = req("bun:sqlite");
      return (sqliteImpl = open((p) => {
        const d = new Database(p, { readonly: true });
        return { all: (q) => d.query(q).all(), close: () => d.close() };
      }));
    }
    // node:sqlite says it's experimental on some Node versions; that's not the person's concern.
    const emit = process.emitWarning;
    process.emitWarning = ((w: unknown, ...rest: unknown[]) => (/sqlite/i.test(String((w as Error)?.message ?? w)) ? undefined : (emit as any).call(process, w, ...rest))) as typeof process.emitWarning;
    try {
      const { DatabaseSync } = req("node:sqlite");
      return (sqliteImpl = open((p) => {
        const d = new DatabaseSync(p, { readOnly: true });
        return { all: (q) => d.prepare(q).all(), close: () => d.close() };
      }));
    } finally {
      process.emitWarning = emit;
    }
  } catch {}
  if (spawnSync("sqlite3", ["-version"], { encoding: "utf8" }).status === 0)
    return (sqliteImpl = (db, query) => {
      const r = spawnSync("sqlite3", ["-readonly", "-json", db, query], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
      if (r.status !== 0) throw new Error(r.stderr.trim() || "sqlite3 failed");
      return r.stdout.trim() ? JSON.parse(r.stdout) : [];
    });
  return (sqliteImpl = null);
}

/** Rows from a read-only query; nothing (and one warning per run) when SQLite isn't available or the query fails. */
function sqlite(db: string, query: string): any[] {
  const run = sqliteRunner();
  if (!run) {
    if (!sqliteWarned) process.stderr.write(`0bridge: skipping Cursor and Hermes history: no SQLite here (Node 22.5+ or the sqlite3 command reads it)\n`);
    sqliteWarned = true;
    return [];
  }
  try {
    return run(db, query);
  } catch {
    return [];
  }
}

const sq = (s: string) => `'${s.replaceAll("'", "''")}'`;
const hex = (h: unknown) => (typeof h === "string" ? Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16)) : new Uint8Array());

// ── Cursor (app): conversations live in its state database ──

const cursorDb = (ctx: Context) => join(appDir(ctx, "Cursor"), "User", "globalStorage", "state.vscdb");

function collectCursor(ctx: Context, c: Collector) {
  const db = cursorDb(ctx);
  if (!existsSync(db)) return;
  const composers = sqlite(
    db,
    `SELECT substr(key, 14) AS id, json_extract(value, '$.name') AS name, json_extract(value, '$.createdAt') AS created,
            json_extract(value, '$.lastUpdatedAt') AS updated, json_extract(value, '$.workspaceIdentifier.uri.fsPath') AS cwd
     FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;'`,
  );
  for (const k of composers) {
    if (c.budget <= 0) return;
    const key = `cursor:${k.id}`;
    const prev = c.cfg.files[key];
    const updated = Number(k.updated ?? k.created ?? 0);
    if (!updated || (prev && prev.offset >= updated)) continue;
    const headers: { bubbleId: string; type: number }[] =
      json(sqlite(db, `SELECT json_extract(value, '$.fullConversationHeadersOnly') AS h FROM cursorDiskKV WHERE key = ${sq(`composerData:${k.id}`)}`)[0]?.h ?? "[]") ?? [];
    const bubbles = new Map<string, { text: string; at: number }>();
    for (const b of sqlite(
      db,
      `SELECT substr(key, ${`bubbleId:${k.id}:`.length + 1}) AS id, json_extract(value, '$.text') AS text, json_extract(value, '$.createdAt') AS at
       FROM cursorDiskKV WHERE key >= ${sq(`bubbleId:${k.id}:`)} AND key < ${sq(`bubbleId:${k.id};`)}`,
    ))
      if (typeof b.text === "string" && b.text.trim()) bubbles.set(b.id, { text: b.text.trim(), at: ms(b.at) });
    c.budget -= [...bubbles.values()].reduce((n, b) => n + b.text.length, 0);
    // The whole conversation is converted each time; what was uploaded before is sliced off by count.
    const rows = headers.flatMap((h) => {
      const b = bubbles.get(h.bubbleId);
      return b ? [{ bubbleId: h.bubbleId, type: h.type, text: b.text, createdAt: b.at || updated }] : [];
    });
    const all = toConversation(fromCursorBubbles(rows).events);
    const base = prev?.seq ?? 0;
    const cursor: Cursor = { offset: updated, seq: all.length, session: `cursor:${k.id}`, tool: "cursor", cwd: k.cwd ?? prev?.cwd, title: k.name ?? prev?.title, startedAt: prev?.startedAt ?? ms(k.created) };
    emit(c, key, cursor, prev, all.slice(base), base, updated);
  }
}

// ── Cursor CLI (cursor-agent): a content-addressed SQLite store per chat ──

function collectCursorAgent(ctx: Context, c: Collector) {
  const dirs = [...subdirs(join(ctx.home, ".cursor", "chats")).flatMap(subdirs), ...subdirs(join(ctx.home, ".cursor", "acp-sessions"))];
  for (const dir of dirs) {
    if (c.budget <= 0) return;
    const db = join(dir, "store.db");
    if (!existsSync(db)) continue;
    const key = db;
    const prev = c.cfg.files[key];
    const raw = sqlite(db, `SELECT value FROM meta WHERE key = '0'`)[0]?.value;
    const m = json(typeof raw === "string" && /^[0-9a-f]+$/i.test(raw) ? Buffer.from(raw, "hex").toString("utf8") : String(raw ?? ""));
    const rootId = typeof m?.latestRootBlobId === "string" ? m.latestRootBlobId : null;
    if (!rootId || !/^[0-9a-f]+$/i.test(rootId) || prev?.state?.x?.root === rootId) continue;
    const ids = cursorAgentMessageIds(hex(sqlite(db, `SELECT hex(data) AS data FROM blobs WHERE id = ${sq(rootId)}`)[0]?.data));
    let state = prev?.state;
    const done = typeof state?.x?.line === "number" ? state.x.line : 0;
    // A compacted chat's list can shrink: carry on numbering from there rather than resending.
    if (ids.length < done && state) state = { ...state, x: { ...state.x, line: ids.length } };
    const fresh = ids.slice(Math.min(done, ids.length));
    const blobs = new Map<string, string>();
    for (let i = 0; i < fresh.length; i += 200)
      for (const b of sqlite(db, `SELECT id, CAST(data AS TEXT) AS data FROM blobs WHERE id IN (${fresh.slice(i, i + 200).map(sq).join(",")})`)) blobs.set(String(b.id), String(b.data ?? ""));
    const lines = fresh.map((id) => blobs.get(id) ?? "");
    c.budget -= lines.reduce((n, l) => n + l.length, 0);
    const r = converters["cursor-agent"](lines, state);
    r.state.x = { ...r.state.x, root: rootId };
    const file = readJson<{ cwd?: string; title?: string; createdAtMs?: number }>(join(dir, "meta.json")) ?? {};
    let mtime = 0;
    for (const f of [db, `${db}-wal`])
      try {
        mtime = Math.max(mtime, statSync(f).mtimeMs);
      } catch {}
    const base = prev?.seq ?? 0;
    const messages = conversation(r, mtime);
    const cursor: Cursor = {
      offset: ids.length,
      seq: base + messages.length,
      session: `cursor-agent:${basename(dir).replace(/[^A-Za-z0-9._-]/g, "")}`,
      tool: "cursor-agent",
      cwd: file.cwd ?? prev?.cwd,
      title: (typeof m.name === "string" && m.name) || file.title || prev?.title,
      startedAt: prev?.startedAt ?? (ms(m.createdAt) || file.createdAtMs || r.meta.startedAt),
      ...meta(r.state, undefined),
    };
    emit(c, key, cursor, prev, messages, base, mtime);
  }
}

// ── Hermes Agent: ~/.hermes/state.db (unverified format; skipped unless the tables match) ──

function collectHermes(ctx: Context, c: Collector) {
  const db = join(ctx.home, ".hermes", "state.db");
  if (!existsSync(db)) return;
  const cols = (t: string) => new Set(sqlite(db, `SELECT name FROM pragma_table_info(${sq(t)})`).map((r) => String(r.name)));
  const mc = cols("messages");
  const sc = cols("sessions");
  if (!["id", "session_id", "role", "content"].every((k) => mc.has(k)) || !sc.has("id")) return;
  const pick = (have: Set<string>, names: string[]) => names.filter((n) => have.has(n)).join(", ");
  const sessions = new Map<string, any>(sqlite(db, `SELECT ${pick(sc, ["id", "title", "model", "started_at", "cwd"])} FROM sessions`).map((s) => [String(s.id), s]));
  for (const row of sqlite(db, `SELECT session_id AS id, MAX(id) AS last FROM messages GROUP BY session_id`)) {
    if (c.budget <= 0) return;
    const id = String(row.id);
    const key = `hermes:${id}`;
    const prev = c.cfg.files[key];
    if (prev && prev.offset >= Number(row.last)) continue;
    const rows: HermesMessage[] = sqlite(
      db,
      `SELECT ${pick(mc, ["id", "role", "content", "tool_calls", "tool_call_id", "tool_name", "timestamp"])} FROM messages
       WHERE session_id = ${sq(id)} AND id > ${Number(prev?.offset ?? 0)} ORDER BY id`,
    );
    c.budget -= rows.reduce((n, r) => n + String(r.content ?? "").length, 0);
    const s = sessions.get(id) ?? {};
    const r = fromHermesMessages(rows, prev?.state, typeof s.model === "string" ? s.model : undefined);
    const base = prev?.seq ?? 0;
    const messages = conversation(r);
    const started = ms(typeof s.started_at === "number" && s.started_at < 1e12 ? s.started_at * 1000 : s.started_at);
    const cursor: Cursor = {
      offset: Number(row.last),
      seq: base + messages.length,
      session: `hermes:${id.replace(/[^A-Za-z0-9._-]/g, "")}`,
      tool: "hermes",
      cwd: typeof s.cwd === "string" ? s.cwd : prev?.cwd,
      title: typeof s.title === "string" && s.title ? s.title : prev?.title,
      startedAt: prev?.startedAt ?? (started || r.meta.startedAt),
      ...meta(r.state, undefined),
    };
    emit(c, key, cursor, prev, messages, base, Date.now());
  }
}

/**
 * New messages from every enabled source since the last sync, and the token counts that grew.
 * Title-only changes (an AI title written later) are included as sessions without messages.
 * `maxBytes` bounds one round. With `countsOnly` (usage without history: pass `usageFiles` as
 * `cfg.files`) no sessions come back, only cursors and usage.
 */
export function collectHistory(ctx: Context, cfg: HistoryConfig, values: string[] = [], opts: { maxBytes?: number; countsOnly?: boolean; now?: number } = {}): Collected {
  const c: Collector = {
    device: hostname().replace(/\.local$/, ""),
    values,
    cfg,
    out: { sessions: [], cursors: {}, skipped: 0, usage: [] },
    budget: opts.maxBytes ?? Infinity,
    seen: new Set(),
    countsOnly: opts.countsOnly ?? false,
    keepFrom: Math.floor((opts.now ?? Date.now()) / HOUR_MS) - USAGE_KEEP_HOURS,
  };
  for (const source of cfg.tools) {
    if (c.countsOnly && !USAGE_SOURCES.has(source)) continue;
    if (source === "cursor") collectCursor(ctx, c);
    else if (source === "cursor-agent") collectCursorAgent(ctx, c);
    else if (source === "hermes") collectHermes(ctx, c);
    else collectFiles(ctx, c, source);
  }
  return c.out;
}

/** Split sessions into upload batches of roughly `bytes` each (a long session spans several). */
export function batchSessions(sessions: HistorySession[], bytes = 900_000, maxSessions = 150): HistorySession[][] {
  const batches: HistorySession[][] = [];
  let cur: HistorySession[] = [];
  let size = 0;
  const push = () => {
    if (cur.length) batches.push(cur);
    cur = [];
    size = 0;
  };
  for (const s of sessions) {
    let part: HistoryMessage[] = [];
    for (const m of s.messages) {
      const n = JSON.stringify(m).length;
      if (size + n > bytes && (part.length || cur.length)) {
        if (part.length) cur.push({ ...s, messages: part });
        part = [];
        push();
      }
      part.push(m);
      size += n;
    }
    cur.push({ ...s, messages: part });
    if (cur.length >= maxSessions) push();
  }
  push();
  return batches;
}
