import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { repoOf } from "./profiles.ts";
import { readJson, writeAtomic } from "./util.ts";
import type { Context } from "./types.ts";

/**
 * Conversation history: read AI tools' session logs on this machine, keep the conversation
 * itself — what the person asked, what the agent answered, and the questions the agent asked back
 * with their answers — mask secrets, and hand new messages to the uploader. Tool calls, their
 * output and reasoning are left out. Each source is read from where the last sync stopped.
 */

/** Where logs are read from. Sessions are labeled more precisely (claude-app, codex-app). */
export type HistorySource = "claude-code" | "codex" | "grok" | "cursor";
export const HISTORY_SOURCES: HistorySource[] = ["claude-code", "codex", "grok", "cursor"];
export type HistoryRole = "user" | "assistant" | "tool";

export interface HistoryMessage {
  seq: number;
  role: HistoryRole;
  at: number;
  text: string;
}

export interface HistorySession {
  id: string;
  /** claude-code, claude-app, codex, codex-app, grok, cursor */
  tool: string;
  device: string;
  cwd?: string;
  repo?: string;
  title?: string;
  startedAt: number;
  updatedAt: number;
  messages: HistoryMessage[];
}

/** Where each log's sync stopped: a byte offset in a file, or Cursor's last update time. */
interface Cursor {
  offset: number;
  seq: number;
  session: string;
  tool?: string;
  cwd?: string;
  title?: string;
  startedAt?: number;
}

export interface HistoryConfig {
  /** Sync runs only after `0b history on` on this machine. */
  enabled: boolean;
  tools: HistorySource[];
  /** Repos or folders never uploaded (substring of the repo or path). */
  exclude: string[];
  files: Record<string, Cursor>;
  lastSync?: number;
}

const MAX_MESSAGE = 16 * 1024;

export const historyPath = (ctx: Context) => join(ctx.storeDir, "history.json");

export function loadHistoryConfig(ctx: Context): HistoryConfig {
  const c = readJson<Partial<HistoryConfig>>(historyPath(ctx)) ?? {};
  return { enabled: c.enabled ?? false, tools: c.tools ?? HISTORY_SOURCES, exclude: c.exclude ?? [], files: c.files ?? {}, lastSync: c.lastSync };
}

export function saveHistoryConfig(ctx: Context, c: HistoryConfig): void {
  writeAtomic(historyPath(ctx), JSON.stringify(c) + "\n", { mode: 0o600 });
}

// ── Secrets ──

/**
 * Credentials with a recognizable shape. Masked before anything leaves the machine, on top of the
 * vault's own values; a conversation that pasted a key shouldn't put it in the cloud.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk)-(?:live|test|proj|ant|or)?[-_]?[A-Za-z0-9_-]{20,}/g, // OpenAI, Anthropic, Stripe, OpenRouter
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\bya29\.[0-9A-Za-z_-]{20,}/g, // Google OAuth access token
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b0B(?:-[A-Z2-7]{4}){13}\b/g, // 0bridge vault recovery key
  /(?<=:\/\/[^\s/:@]+:)[^\s/@]{6,}(?=@)/g, // password in a URL
  // KEY=value / "token": "value" where the name says it's a secret
  /(?<=\b[A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|ACCESS_KEY)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?)[^\s"'`,;]{8,}/gi,
];

/** Mask known secret values (from the vault) and anything shaped like a credential. */
export function redact(text: string, values: string[] = []): string {
  let s = text;
  for (const v of [...new Set(values.filter((v) => v.length >= 6))].sort((a, b) => b.length - a.length)) s = s.split(v).join("[secret]");
  for (const re of SECRET_PATTERNS) s = s.replace(re, "[secret]");
  return s;
}

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

function* walk(dir: string, match: (name: string) => boolean, depth = 5): Generator<string> {
  if (depth < 0 || !existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, match, depth - 1);
    else if (match(e.name)) yield p;
  }
}

const clip = (s: string, n = MAX_MESSAGE) => (s.length > n ? `${s.slice(0, n)}… [${s.length - n} more characters]` : s);
const ms = (t: unknown) => (typeof t === "string" || typeof t === "number" ? new Date(typeof t === "string" && /^\d+$/.test(t) ? Number(t) : t).getTime() || 0 : 0);
const json = (line: string): any => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

/** Text the tool injected rather than the person typed (environment, instructions, command wrappers). */
const injected = (t: string) =>
  /^\s*<(?:[a-z_-]+-)?(?:environment_context|user_instructions|permissions instructions|app-context|recommended_plugins|command-|local-command-|system-reminder|INSTRUCTIONS|turn_aborted|user_info|rules|topic)/i.test(t) ||
  /^\s*<(?:skill|subagent_notification|task-notification)>/i.test(t) ||
  /^(?:Caveat: The messages below|The following is the Codex agent history|# AGENTS\.md instructions for|This session is being continued from a previous conversation)/.test(t);

/** Tools an agent uses to ask the person something; their question and the answer are conversation. */
const ASKS = /^(?:AskUserQuestion|ask_user_question|ask_?user|request_user_input|ask_question)$/i;

/** "Which account?\n- A\n- B" from a question tool's input. */
function questionText(input: any): string {
  const qs: any[] = Array.isArray(input?.questions) ? input.questions : input?.question ? [input] : [];
  if (!qs.length) return typeof input === "string" ? input : JSON.stringify(input ?? {});
  return qs
    .map((q) => [String(q.question ?? q.prompt ?? ""), ...(Array.isArray(q.options) ? q.options.map((o: any) => `- ${o?.label ?? o}`) : [])].join("\n"))
    .join("\n\n");
}

/** The person's answers from a question tool's result. */
function answerText(result: unknown, structured?: any): string {
  const answers = structured?.answers;
  if (answers && typeof answers === "object") return Object.values(answers).map(String).join("\n");
  const text = typeof result === "string" ? result : Array.isArray(result) ? result.map((b: any) => b?.text ?? "").join("\n") : JSON.stringify(result ?? "");
  const pairs = [...text.matchAll(/"[^"]*"="([^"]*)"/g)].map((m) => m[1]);
  return pairs.length ? pairs.join("\n") : text.replace(/\s*Read the answers carefully[\s\S]*$/, "");
}

type Parsed = { messages: Omit<HistoryMessage, "seq">[]; cwd?: string; title?: string; startedAt?: number; session?: string; tool?: string };

/** Claude Code (and the Claude app's Code tab): ~/.claude/projects/<project>/<session>.jsonl. */
function parseClaude(lines: string[]): Parsed {
  const out: Parsed = { messages: [] };
  const asks = new Set<string>();
  for (const line of lines) {
    const d = json(line);
    if (!d) continue;
    if (d.type === "ai-title" && d.aiTitle) out.title = String(d.aiTitle);
    if (d.type === "summary" && d.summary && !out.title) out.title = String(d.summary);
    if (d.type !== "user" && d.type !== "assistant") continue;
    // Subagents' own turns and injected meta messages are noise when searching.
    if (d.isSidechain || d.isMeta) continue;
    if (d.cwd) out.cwd = d.cwd;
    if (d.sessionId) out.session ??= d.sessionId;
    const at = ms(d.timestamp);
    if (at) out.startedAt ??= at;
    const content = d.message?.content;
    const blocks: any[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
    for (const b of blocks) {
      if (b.type === "text" && typeof b.text === "string" && b.text.trim() && !injected(b.text)) out.messages.push({ role: d.type, at, text: clip(b.text.trim()) });
      else if (b.type === "tool_use" && ASKS.test(b.name ?? "")) {
        asks.add(b.id);
        out.messages.push({ role: "assistant", at, text: clip(questionText(b.input)) });
      } else if (b.type === "tool_result" && asks.has(b.tool_use_id)) out.messages.push({ role: "user", at, text: clip(answerText(b.content, d.toolUseResult)) });
    }
  }
  return out;
}

/** Codex CLI and the Codex app: ~/.codex/sessions/YYYY/MM/DD/rollout-….jsonl. */
function parseCodex(lines: string[]): Parsed {
  const out: Parsed = { messages: [] };
  const asks = new Set<string>();
  for (const line of lines) {
    const d = json(line);
    if (!d) continue;
    const p = d.payload ?? {};
    const at = ms(d.timestamp);
    if (d.type === "session_meta") {
      out.session ??= p.session_id ?? p.id;
      if (p.cwd) out.cwd = p.cwd;
      out.startedAt ??= ms(p.timestamp) || at;
      out.tool = /desktop/i.test(p.originator ?? "") ? "codex-app" : "codex";
      continue;
    }
    if (d.type === "turn_context" && p.cwd) out.cwd = p.cwd;
    if (d.type !== "response_item") continue;
    if (p.type === "message" && (p.role === "user" || p.role === "assistant")) {
      const text = (Array.isArray(p.content) ? p.content : [])
        .filter((c: any) => (c.type === "input_text" || c.type === "output_text") && typeof c.text === "string")
        .map((c: any) => c.text)
        .join("\n")
        .trim();
      if (text && !injected(text)) out.messages.push({ role: p.role, at, text: clip(text) });
    } else if ((p.type === "function_call" || p.type === "custom_tool_call") && ASKS.test(p.name ?? "")) {
      asks.add(p.call_id);
      out.messages.push({ role: "assistant", at, text: clip(questionText(json(p.arguments ?? p.input ?? "") ?? p.arguments ?? p.input)) });
    } else if ((p.type === "function_call_output" || p.type === "custom_tool_call_output") && asks.has(p.call_id)) {
      out.messages.push({ role: "user", at, text: clip(answerText(p.output)) });
    }
  }
  return out;
}

/** Grok: ~/.grok/sessions/<folder>/<session>/chat_history.jsonl. What the person typed is in <user_query>. */
function parseGrok(lines: string[]): Parsed {
  const out: Parsed = { messages: [] };
  const asks = new Set<string>();
  for (const line of lines) {
    const d = json(line);
    if (!d) continue;
    const at = ms(d.timestamp ?? d.ts ?? d.created_at);
    if (d.type === "user") {
      const blocks: any[] = typeof d.content === "string" ? [{ text: d.content }] : Array.isArray(d.content) ? d.content : [];
      for (const b of blocks) {
        const q = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(String(b?.text ?? ""))?.[1];
        if (q?.trim()) out.messages.push({ role: "user", at, text: clip(q.trim()) });
      }
    } else if (d.type === "assistant") {
      if (typeof d.content === "string" && d.content.trim()) out.messages.push({ role: "assistant", at, text: clip(d.content.trim()) });
      for (const t of Array.isArray(d.tool_calls) ? d.tool_calls : [])
        if (ASKS.test(t?.name ?? "")) {
          asks.add(t.id);
          out.messages.push({ role: "assistant", at, text: clip(questionText(json(t.arguments ?? "") ?? t.arguments)) });
        }
    } else if (d.type === "tool_result" && asks.has(d.tool_call_id)) out.messages.push({ role: "user", at, text: clip(answerText(d.content)) });
  }
  return out;
}

const repoCache = new Map<string, string | undefined>();
function repoFor(cwd: string | undefined): string | undefined {
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
  const dir = join(ctx.home, "Library", "Application Support", "Claude", "claude-code-sessions");
  const out = new Map<string, string | undefined>();
  for (const f of walk(dir, (n) => n.startsWith("local_") && n.endsWith(".json"), 3)) {
    const d = json(readFileSync(f, "utf8"));
    if (d?.cliSessionId) out.set(String(d.cliSessionId), d.title ? String(d.title) : undefined);
  }
  return out;
}

interface FileSource {
  dir: (ctx: Context) => string;
  match: (name: string) => boolean;
  parse: (lines: string[]) => Parsed;
  idOf: (path: string) => string;
  cwdOf?: (path: string) => string | undefined;
}

const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

const FILE_SOURCES: Record<Exclude<HistorySource, "cursor">, FileSource> = {
  "claude-code": { dir: (ctx) => join(ctx.home, ".claude", "projects"), match: (n) => n.endsWith(".jsonl"), parse: parseClaude, idOf: (p) => basename(p, ".jsonl") },
  codex: { dir: (ctx) => join(ctx.home, ".codex", "sessions"), match: (n) => n.endsWith(".jsonl"), parse: parseCodex, idOf: (p) => UUID.exec(basename(p))?.[1] ?? basename(p, ".jsonl") },
  grok: {
    dir: (ctx) => join(ctx.home, ".grok", "sessions"),
    match: (n) => n === "chat_history.jsonl",
    parse: parseGrok,
    idOf: (p) => basename(dirname(p)),
    cwdOf: (p) => {
      try {
        return decodeURIComponent(basename(dirname(dirname(p))));
      } catch {
        return undefined;
      }
    },
  },
};

export interface Collected {
  sessions: HistorySession[];
  /** Cursor updates to save once the upload succeeded. */
  cursors: Record<string, Cursor>;
  skipped: number;
}

interface Collector {
  device: string;
  values: string[];
  cfg: HistoryConfig;
  out: Collected;
  budget: number;
}

const excluded = (cfg: HistoryConfig, repo: string | undefined, cwd: string | undefined) => cfg.exclude.some((x) => (repo ?? "").includes(x) || (cwd ?? "").includes(x));

/** Turn parsed messages into a session for upload (or nothing new), updating the cursor. */
function emit(c: Collector, key: string, cursor: Cursor, prev: Cursor | undefined, parsed: Omit<HistoryMessage, "seq">[], base: number, fallbackAt: number) {
  c.out.cursors[key] = cursor;
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
    startedAt: cursor.startedAt ?? updatedAt,
    updatedAt,
    messages,
  });
}

function collectFiles(ctx: Context, c: Collector, source: Exclude<HistorySource, "cursor">) {
  const src = FILE_SOURCES[source];
  const app = source === "claude-code" ? claudeAppSessions(ctx) : new Map<string, string | undefined>();
  for (const path of walk(src.dir(ctx), src.match)) {
    if (c.budget <= 0) return;
    const prev = c.cfg.files[path];
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      continue;
    }
    if (prev && prev.offset === size) continue;
    const restart = !prev || prev.offset > size;
    const { lines, offset } = readNewLines(path, restart ? 0 : prev.offset);
    c.budget -= offset - (restart ? 0 : prev.offset);
    const parsed = src.parse(lines);
    // One session per log file: Codex threads of one task share a session_id, and a resumed
    // Claude session can reuse its id in a new file, so the file's own id is the stable key.
    const native = src.idOf(path);
    const inApp = app.has(native);
    const tool = parsed.tool ?? prev?.tool ?? (source === "claude-code" ? (inApp ? "claude-app" : "claude-code") : source);
    const base = restart ? 0 : prev.seq;
    const cursor: Cursor = {
      offset,
      seq: base + parsed.messages.length,
      session: `${tool}:${native.replace(/[^A-Za-z0-9._-]/g, "")}`,
      tool,
      cwd: parsed.cwd ?? prev?.cwd ?? src.cwdOf?.(path),
      title: parsed.title ?? (inApp ? app.get(native) : undefined) ?? prev?.title,
      startedAt: prev?.startedAt ?? parsed.startedAt,
    };
    emit(c, path, cursor, prev, parsed.messages, base, statSync(path).mtimeMs);
  }
}

// ── Cursor (app): conversations live in its state database ──

function cursorDb(ctx: Context): string {
  return process.platform === "darwin"
    ? join(ctx.home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb")
    : join(ctx.home, ".config", "Cursor", "User", "globalStorage", "state.vscdb");
}

/** Read-only query through the sqlite3 command (macOS and most Linux have it; nothing to bundle). */
function sqlite(db: string, query: string): any[] {
  const r = spawnSync("sqlite3", ["-readonly", "-json", db, query], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) return [];
  return r.stdout.trim() ? JSON.parse(r.stdout) : [];
}

const sq = (s: string) => `'${s.replaceAll("'", "''")}'`;

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
    const all = headers.flatMap((h) => {
      const b = bubbles.get(h.bubbleId);
      return b && (h.type === 1 || h.type === 2) ? [{ role: (h.type === 1 ? "user" : "assistant") as HistoryRole, at: b.at || updated, text: clip(b.text) }] : [];
    });
    const base = prev?.seq ?? 0;
    const cursor: Cursor = { offset: updated, seq: all.length, session: `cursor:${k.id}`, tool: "cursor", cwd: k.cwd ?? prev?.cwd, title: k.name ?? prev?.title, startedAt: prev?.startedAt ?? ms(k.created) };
    emit(c, key, cursor, prev, all.slice(base), base, updated);
  }
}

/**
 * New messages from every enabled source since the last sync. Title-only changes (an AI title
 * written later) are included as sessions without messages. `maxBytes` bounds one round.
 */
export function collectHistory(ctx: Context, cfg: HistoryConfig, values: string[] = [], opts: { maxBytes?: number } = {}): Collected {
  const c: Collector = { device: hostname().replace(/\.local$/, ""), values, cfg, out: { sessions: [], cursors: {}, skipped: 0 }, budget: opts.maxBytes ?? Infinity };
  for (const source of cfg.tools) {
    if (source === "cursor") collectCursor(ctx, c);
    else if (FILE_SOURCES[source]) collectFiles(ctx, c, source);
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
