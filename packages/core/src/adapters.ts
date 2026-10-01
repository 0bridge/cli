import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { Context, McpServer, ToolId, Transport } from "./types.ts";
import { agentProfiles } from "./agent-profiles.ts";
import { editMcpTables } from "./toml-edit.ts";
import { isEmpty, readJson, readText, shellSplit, stableStringify } from "./util.ts";

export interface Adapter {
  id: ToolId;
  label: string;
  /** Tool home dir; its existence means the tool is installed. */
  dir: string;
  configPath: string;
  /** Can write a server as disabled instead of removing it. */
  supportsDisabled: boolean;
  supportsSse: boolean;
  /** Global skills dir, or null when this tool has no file-based skills here. */
  skillsDir: string | null;
  /**
   * Other tools' skills dirs this tool reads too (Cursor reads Claude Code's and Codex's). A skill
   * 0bridge puts there isn't copied into `skillsDir` as well: the tool would list it twice.
   */
  alsoReads?: string[];
  /** Global instructions file, or null (Cursor keeps user rules in its settings DB). */
  instructionsPath: string | null;
  readServers(text?: string | null): Record<string, McpServer>;
  /** New config text. `upsert` values are fully resolved (no refs). */
  render(current: string | null, upsert: Record<string, McpServer>, remove: string[]): string;
  /** Text shown in diffs: the MCP section only for big JSON files, the whole file for TOML. */
  diffView(text: string | null): string;
}

function remoteTransport(url: string): Transport {
  try {
    return /\/sse\/?$/.test(new URL(url).pathname) ? "sse" : "http";
  } catch {
    return "http";
  }
}

/** Split `"npx -y pkg"`-style commands when args are absent and the command isn't a real path. */
function normalizeCommand(command: string, args: string[] | undefined): { command: string; args: string[] } {
  if ((!args || args.length === 0) && /\s/.test(command.trim()) && !existsSync(command)) {
    const [cmd, ...rest] = shellSplit(command);
    return { command: cmd!, args: rest };
  }
  return { command, args: args ?? [] };
}

function pickNative(raw: Record<string, unknown>, known: string[]): Record<string, unknown> | undefined {
  const extra = Object.fromEntries(Object.entries(raw).filter(([k]) => !known.includes(k)));
  return isEmpty(extra) ? undefined : extra;
}

function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && !(typeof v === "object" && isEmpty(v as object)))) as T;
}

function withNative(s: McpServer, id: ToolId, raw: Record<string, unknown>, known: string[]): McpServer {
  const native = pickNative(raw, known);
  return clean({ ...s, native: native ? { [id]: native } : undefined });
}

/** Shared shape for tools that keep `mcpServers` inside a JSON file. */
abstract class JsonAdapter implements Adapter {
  abstract id: ToolId;
  abstract label: string;
  abstract dir: string;
  abstract configPath: string;
  abstract skillsDir: string | null;
  abstract instructionsPath: string | null;
  alsoReads?: string[];
  supportsDisabled = false;
  supportsSse = true;
  protected abstract known: string[];
  protected abstract fromNative(raw: any): McpServer;
  protected abstract toNative(s: McpServer): Record<string, unknown>;

  protected parse(text: string | null | undefined): any {
    if (text == null || text.trim() === "") return {};
    try {
      return JSON.parse(text);
    } catch (e: any) {
      throw new Error(`${this.configPath}: invalid JSON (${e.message})`);
    }
  }

  /** The object in the file that holds `mcpServers` (the whole file; one project's entry in ~/.claude.json). `create` makes it. */
  protected section(obj: any, create = false): any {
    return obj;
  }

  protected toServers(servers: Record<string, unknown>): Record<string, McpServer> {
    return Object.fromEntries(Object.entries(servers).map(([n, raw]) => [n, withNative(this.fromNative(raw), this.id, raw as any, this.known)]));
  }

  readServers(text: string | null = readText(this.configPath)) {
    return this.toServers(this.section(this.parse(text))?.mcpServers ?? {});
  }

  render(current: string | null, upsert: Record<string, McpServer>, remove: string[]) {
    const obj = this.parse(current);
    const sec = this.section(obj, true);
    sec.mcpServers ??= {};
    for (const n of remove) delete sec.mcpServers[n];
    for (const [n, s] of Object.entries(upsert)) sec.mcpServers[n] = { ...this.toNative(s), ...(s.native?.[this.id] ?? {}) };
    const indent = /^\{\n(\s+)"/.exec(current ?? "")?.[1] ?? "  ";
    const trailing = current == null || current === "" || current.endsWith("\n") ? "\n" : "";
    return JSON.stringify(obj, null, indent) + trailing;
  }

  diffView(text: string | null) {
    return JSON.stringify(this.section(this.parse(text))?.mcpServers ?? {}, null, 2) + "\n";
  }
}

class ClaudeAdapter extends JsonAdapter {
  id = "claude" as const;
  label = "Claude Code";
  dir: string;
  configPath: string;
  skillsDir: string | null;
  instructionsPath: string | null;
  protected known = ["type", "command", "args", "env", "url", "headers"];
  /** `dir`: another Claude Code config folder (CLAUDE_CONFIG_DIR), which keeps its .claude.json inside. */
  constructor(home: string, dir?: string) {
    super();
    this.dir = dir ?? join(home, ".claude");
    this.configPath = dir ? join(dir, ".claude.json") : join(home, ".claude.json");
    this.skillsDir = join(this.dir, "skills");
    this.instructionsPath = join(this.dir, "CLAUDE.md");
    if (dir) this.label = `Claude Code (${basename(dir)})`;
  }
  protected fromNative(r: any): McpServer {
    if (r.url) return clean({ transport: r.type === "sse" ? "sse" : r.type === "http" ? "http" : remoteTransport(r.url), url: r.url, headers: r.headers });
    return clean({ transport: "stdio", ...normalizeCommand(r.command, r.args), env: r.env });
  }
  protected toNative(s: McpServer) {
    if (s.transport === "stdio") return { type: "stdio", command: s.command, args: s.args ?? [], env: s.env ?? {} };
    return clean({ type: s.transport, url: s.url, headers: s.headers });
  }
}

/**
 * Claude Code in one checkout: its local scope, the checkout's entry in .claude.json (wins over
 * the user scope, and leaves nothing in the repo), and the checkout's .claude/skills. The repo's
 * shared .mcp.json is read too, so a server it already has the same way isn't written again.
 */
class ClaudeLocalAdapter extends ClaudeAdapter {
  constructor(
    home: string,
    readonly root: string,
    dir?: string,
  ) {
    super(home, dir);
    this.label = dir ? `Claude Code (${basename(dir)}, ${basename(root)})` : `Claude Code (${basename(root)})`;
    // The skills folder is the checkout's, shared by every Claude Code account: one of them writes it.
    this.skillsDir = dir ? null : join(root, ".claude", "skills");
    this.instructionsPath = null;
  }
  protected section(obj: any, create = false): any {
    if (!create) return obj.projects?.[this.root];
    return ((obj.projects ??= {})[this.root] ??= {});
  }
  readServers(text: string | null = readText(this.configPath)) {
    const shared = readJson<{ mcpServers?: Record<string, unknown> }>(join(this.root, ".mcp.json"))?.mcpServers ?? {};
    return { ...this.toServers(shared), ...super.readServers(text) };
  }
}

class CursorAdapter extends JsonAdapter {
  id = "cursor" as const;
  label = "Cursor";
  dir: string;
  configPath: string;
  skillsDir: string;
  alsoReads: string[];
  instructionsPath = null;
  protected known = ["type", "command", "args", "env", "url", "headers"];
  /**
   * Cursor reads skills from ~/.cursor/skills and ~/.agents/skills, and also from Claude Code's and
   * Codex's folders (cursor.com/docs/context/skills); a skill in two of them is listed twice. In a
   * checkout (`root`): .cursor/mcp.json and .cursor/skills, next to .claude, .agents and .codex.
   */
  constructor(home: string, root?: string) {
    super();
    this.dir = join(home, ".cursor");
    const base = root ? join(root, ".cursor") : this.dir;
    this.configPath = join(base, "mcp.json");
    this.skillsDir = join(base, "skills");
    const top = root ?? home;
    this.alsoReads = [".claude", ".codex", ".agents"].map((d) => join(top, d, "skills"));
    if (root) this.label = `Cursor (${basename(root)})`;
  }
  protected fromNative(r: any): McpServer {
    if (r.url) return clean({ transport: r.type === "sse" || r.type === "http" ? r.type : remoteTransport(r.url), url: r.url, headers: r.headers });
    return clean({ transport: "stdio", ...normalizeCommand(r.command, r.args), env: r.env });
  }
  protected toNative(s: McpServer) {
    if (s.transport === "stdio") return clean({ command: s.command, args: s.args, env: s.env });
    return clean({ url: s.url, headers: s.headers });
  }
}

class GeminiAdapter extends JsonAdapter {
  id = "gemini" as const;
  label = "Gemini CLI";
  dir: string;
  configPath: string;
  skillsDir: string | null;
  instructionsPath: string;
  protected known = ["type", "command", "args", "env", "cwd", "url", "httpUrl", "headers"];
  constructor(home: string) {
    super();
    this.dir = join(home, ".gemini");
    this.configPath = join(this.dir, "settings.json");
    const skills = join(this.dir, "skills");
    this.skillsDir = existsSync(skills) ? skills : null;
    this.instructionsPath = join(this.dir, "GEMINI.md");
  }
  protected fromNative(r: any): McpServer {
    if (r.httpUrl) return clean({ transport: "http", url: r.httpUrl, headers: r.headers });
    if (r.url) return clean({ transport: r.type === "http" ? "http" : "sse", url: r.url, headers: r.headers });
    return clean({ transport: "stdio", ...normalizeCommand(r.command, r.args), env: r.env, cwd: r.cwd });
  }
  protected toNative(s: McpServer) {
    if (s.transport === "stdio") return clean({ command: s.command, args: s.args, env: s.env, cwd: s.cwd });
    if (s.transport === "http") return clean({ httpUrl: s.url, headers: s.headers });
    return clean({ url: s.url, headers: s.headers });
  }
}

class CodexAdapter implements Adapter {
  id = "codex" as const;
  label = "Codex";
  dir: string;
  configPath: string;
  skillsDir: string;
  instructionsPath: string | null;
  supportsDisabled = true;
  supportsSse = false;
  private known = ["command", "args", "env", "cwd", "url", "http_headers", "enabled"];
  /**
   * `dir`: another Codex home (CODEX_HOME, a second account). `root`: a checkout, whose
   * .codex/config.toml Codex layers over the global one once the folder is trusted, and whose
   * .agents/skills it reads (learn.chatgpt.com/docs/build-skills).
   */
  constructor(home: string, dir?: string, root?: string) {
    this.dir = dir ?? join(home, ".codex");
    this.configPath = join(root ? join(root, ".codex") : this.dir, "config.toml");
    this.skillsDir = root ? join(root, ".agents", "skills") : join(this.dir, "skills");
    this.instructionsPath = root ? null : join(this.dir, "AGENTS.md");
    if (dir) this.label = `Codex (${basename(dir)})`;
    if (root) this.label = `Codex (${basename(root)})`;
  }
  readServers(text: string | null = readText(this.configPath)) {
    const servers = ((text ? (parseToml(text) as any) : {}).mcp_servers ?? {}) as Record<string, any>;
    return Object.fromEntries(
      Object.entries(servers).map(([n, r]) => {
        const base: McpServer = r.url
          ? { transport: "http", url: r.url, headers: r.http_headers }
          : { transport: "stdio", ...normalizeCommand(r.command, r.args), env: r.env, cwd: r.cwd };
        if (r.enabled === false) base.enabled = false;
        return [n, withNative(clean(base), "codex", r, this.known)];
      }),
    );
  }
  private toNative(s: McpServer): Record<string, unknown> {
    const t =
      s.transport === "stdio"
        ? clean({ command: s.command, args: s.args, env: s.env, cwd: s.cwd })
        : clean({ url: s.url, http_headers: s.headers });
    return { ...t, ...(s.enabled === false ? { enabled: false } : {}), ...(s.native?.codex ?? {}) };
  }
  render(current: string | null, upsert: Record<string, McpServer>, remove: string[]) {
    const tables = Object.fromEntries(Object.entries(upsert).map(([n, s]) => [n, this.toNative(s)]));
    return editMcpTables(current ?? "", tables, remove);
  }
  diffView(text: string | null) {
    return text ?? "";
  }
}

export function getAdapters(ctx: Context): Record<ToolId, Adapter> {
  return {
    claude: new ClaudeAdapter(ctx.home),
    codex: new CodexAdapter(ctx.home),
    cursor: new CursorAdapter(ctx.home),
    gemini: new GeminiAdapter(ctx.home),
  };
}

/**
 * Other Claude Code config folders on this machine (a second account run with
 * CLAUDE_CONFIG_DIR=~/.claude-b): CLAUDE_CONFIG_DIR itself, ~/.claude-* folders Claude Code has
 * used (they hold a .claude.json) and the profiles `0b use add` registered (agent-profiles.ts).
 * They get what ~/.claude gets.
 */
export function extraClaudeDirs(ctx: Context): string[] {
  const main = resolve(ctx.home, ".claude");
  const found = new Set(agentProfiles(ctx, "claude").map((p) => p.dir));
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (env && resolve(env) !== main && existsSync(join(env, ".claude.json"))) found.add(resolve(env));
  return [...found].sort();
}

/**
 * Other Codex homes (a second account run with CODEX_HOME=~/.codex-b): ~/.codex-* folders Codex
 * has used and registered profiles. CODEX_HOME itself isn't one here: wrappers such as OpenClaw
 * point it at their own folder, which isn't the person's to sync into.
 */
export function extraCodexDirs(ctx: Context): string[] {
  return agentProfiles(ctx, "codex").map((p) => p.dir).sort();
}

/** Adapters for those folders: Claude Code again, at another place. */
export const claudeMirrors = (ctx: Context): Adapter[] => extraClaudeDirs(ctx).map((d) => new ClaudeAdapter(ctx.home, d));
/** And Codex. */
export const codexMirrors = (ctx: Context): Adapter[] => extraCodexDirs(ctx).map((d) => new CodexAdapter(ctx.home, d));

/**
 * The project-scope files of one checkout, per tool (Gemini CLI isn't one, D23), and Claude Code
 * again for each other account's .claude.json (its local scope for this folder).
 */
export function projectAdapters(ctx: Context, root: string): { adapters: Partial<Record<ToolId, Adapter>>; claudeMirrors: Adapter[] } {
  return {
    adapters: { claude: new ClaudeLocalAdapter(ctx.home, root), codex: new CodexAdapter(ctx.home, undefined, root), cursor: new CursorAdapter(ctx.home, root) },
    claudeMirrors: extraClaudeDirs(ctx).map((d) => new ClaudeLocalAdapter(ctx.home, root, d)),
  };
}

export function isInstalled(a: Adapter): boolean {
  return existsSync(a.dir);
}

/** Tool-agnostic comparison key: ignores native passthrough, enabled flags, and targets. */
export function portableKey(s: McpServer): string {
  const { native, enabled, targets, ...rest } = s;
  return stableStringify(clean({ ...rest, args: rest.transport === "stdio" ? rest.args ?? [] : undefined }));
}
