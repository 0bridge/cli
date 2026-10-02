import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Context, Manifest, McpServer, State, ToolId } from "./types.ts";
import { TOOL_IDS } from "./types.ts";
import { getAdapters, isInstalled, portableKey, projectAdapters } from "./adapters.ts";
import { looksSecret, secretRef, type SecretStore } from "./secrets.ts";
import { addManaged, managedOf, paths, projectScope, projectSkillsDir, readInstructions, resolveServer, serverFor } from "./store.ts";
import { copySkill, listSkills, sameSkill } from "./skills.ts";
import { extractUnmanaged } from "./instructions.ts";
import { hashDir, readText, writeAtomic } from "./util.ts";

export interface ServerFound {
  name: string;
  tool: ToolId;
  server: McpServer;
  /** Only makes sense inside `tool` (see isToolBound). */
  pinned: boolean;
}

export interface SkillFound {
  name: string;
  tool: ToolId;
  dir: string;
  hash: string;
}

export interface Scan {
  servers: ServerFound[];
  skills: SkillFound[];
  instructions: { tool: ToolId; text: string }[];
}

export interface ImportOptions {
  only?: ToolId[];
  /** Names to import; omitted = everything found. */
  include?: { mcp?: string[]; skills?: string[] };
  /** For names defined differently across tools: whose version every tool should use. */
  prefer?: { mcp?: Record<string, ToolId>; skills?: Record<string, ToolId> };
  /** Field overrides applied when a server enters the manifest (e.g. SSE → streamable HTTP URL). */
  overrides?: Record<string, Partial<McpServer>>;
  /** Which tool's instructions become canonical; false skips instructions. Default: first found. */
  instructions?: ToolId | false;
}

export interface ImportReport {
  servers: { name: string; from: ToolId; pinned: boolean; disabled: boolean }[];
  adopted: { name: string; tool: ToolId }[];
  /** Tool entries that differ but were claimed by an explicit choice; apply will overwrite them. */
  replaced: { kind: "mcp" | "skill"; name: string; tool: ToolId }[];
  conflicts: { kind: "mcp" | "skill" | "instructions"; name: string; kept: string; other: ToolId }[];
  secrets: string[];
  skills: { name: string; from: ToolId }[];
  instructionsFrom: ToolId | null;
}

/**
 * Servers that only make sense inside the tool they came from: relative commands,
 * binaries inside the vendor's own app bundle, or env pointing at the tool's home.
 */
export function isToolBound(s: McpServer, tool: ToolId): boolean {
  if (s.transport !== "stdio" || !s.command) return false;
  if (/^\.\.?\//.test(s.command)) return true;
  if (/\/(ChatGPT|Codex|Cursor|Claude)[^/]*\.app\//.test(s.command)) return true;
  const homeVar: Record<ToolId, string> = { codex: "CODEX_HOME", claude: "CLAUDE_CONFIG_DIR", gemini: "GEMINI_CLI_HOME", cursor: "CURSOR_HOME" };
  return Object.keys(s.env ?? {}).includes(homeVar[tool]);
}

/** Read every installed tool. No side effects. */
export function scanTools(ctx: Context, only?: ToolId[]): Scan {
  const adapters = getAdapters(ctx);
  const scan: Scan = { servers: [], skills: [], instructions: [] };
  for (const tool of TOOL_IDS) {
    const a = adapters[tool];
    if ((only && !only.includes(tool)) || !isInstalled(a)) continue;
    for (const [name, server] of Object.entries(a.readServers())) {
      scan.servers.push({ name, tool, server, pinned: isToolBound(server, tool) });
    }
    for (const name of listSkills(a.skillsDir)) {
      const dir = join(a.skillsDir!, name);
      scan.skills.push({ name, tool, dir, hash: hashDir(dir) });
    }
    if (a.instructionsPath) {
      const text = extractUnmanaged(readText(a.instructionsPath) ?? "");
      if (text) scan.instructions.push({ tool, text });
    }
  }
  return scan;
}

export function groupByName<T extends { name: string }>(items: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const i of items) out.set(i.name, [...(out.get(i.name) ?? []), i]);
  return out;
}

export function distinctBy<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = key(i);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** `prefix`: put before the secret's name (a repo's servers: `project:<repo>:`), so it can't take a global one's. */
function extractSecrets(name: string, s: McpServer, store: SecretStore, report: Pick<ImportReport, "secrets">, prefix = ""): McpServer {
  const move = (group: "env" | "headers") => {
    const src = s[group];
    if (!src) return undefined;
    return Object.fromEntries(
      Object.entries(src).map(([k, v]) => {
        if (!looksSecret(k, v)) return [k, v];
        const key = `${prefix}${name}.${group}.${k}`;
        store.set(key, v);
        report.secrets.push(key);
        return [k, secretRef(key)];
      }),
    );
  };
  return { ...s, env: move("env"), headers: move("headers") };
}

/** Put preferred occurrences first so they define the manifest entry. */
function preferredFirst<T extends { name: string; tool: ToolId }>(items: T[], prefer: Record<string, ToolId>): T[] {
  return [...items].sort((a, b) => Number(prefer[b.name] === b.tool) - Number(prefer[a.name] === a.tool));
}

/** Merge what's installed in each tool into the manifest. Only writes inside the 0bridge store (and the secret store). */
export function importFromTools(ctx: Context, m: Manifest, state: State, store: SecretStore, opts: ImportOptions = {}): ImportReport {
  const report: ImportReport = { servers: [], adopted: [], replaced: [], conflicts: [], secrets: [], skills: [], instructionsFrom: null };
  const scan = scanTools(ctx, opts.only);
  const includeMcp = opts.include?.mcp && new Set(opts.include.mcp);
  const includeSkills = opts.include?.skills && new Set(opts.include.skills);
  const preferMcp = opts.prefer?.mcp ?? {};
  const preferSkills = opts.prefer?.skills ?? {};
  const origin = (kind: "mcp" | "skills", name: string) => TOOL_IDS.find((t) => state.managed[t]?.[kind].includes(name)) ?? "manifest";

  for (const f of preferredFirst(scan.servers, preferMcp)) {
    if (includeMcp && !includeMcp.has(f.name)) continue;
    const managed = managedOf(state, f.tool).mcp;
    const existing = m.mcpServers[f.name];
    const override = opts.overrides?.[f.name];
    // An explicit choice (or override) means "this definition everywhere": claim every tool's copy.
    const claimAll = preferMcp[f.name] != null || override != null;
    const firstThisRun = !report.servers.some((s) => s.name === f.name);
    const add = () => {
      const base = { ...f.server, ...override, ...(f.pinned ? { targets: [f.tool] } : {}) };
      m.mcpServers[f.name] = extractSecrets(f.name, base, store, report);
      addManaged(managed, f.name);
      report.servers.push({ name: f.name, from: f.tool, pinned: f.pinned, disabled: f.server.enabled === false });
    };

    if (!existing) add();
    // (The gateway's entry as that tool gets it: with ?tools= where tool search is on.)
    else if (portableKey(resolveServer(serverFor(m, f.name, existing, f.tool), store)) === portableKey(f.server)) {
      if (f.server.native?.[f.tool] && !existing.native?.[f.tool]) existing.native = { ...existing.native, [f.tool]: f.server.native[f.tool] };
      addManaged(managed, f.name);
      report.adopted.push({ name: f.name, tool: f.tool });
    } else if (preferMcp[f.name] === f.tool && firstThisRun) {
      add(); // re-import with a new choice: the preferred version replaces the manifest entry
    } else if (claimAll) {
      addManaged(managed, f.name);
      report.replaced.push({ kind: "mcp", name: f.name, tool: f.tool });
    } else {
      report.conflicts.push({ kind: "mcp", name: f.name, kept: origin("mcp", f.name), other: f.tool });
    }
  }

  const skillStore = paths(ctx).skills;
  mkdirSync(ctx.storeDir, { recursive: true, mode: 0o700 });
  mkdirSync(skillStore, { recursive: true });
  for (const f of preferredFirst(scan.skills, preferSkills)) {
    if (includeSkills && !includeSkills.has(f.name)) continue;
    const managed = managedOf(state, f.tool).skills;
    const dst = join(skillStore, f.name);
    const firstThisRun = !report.skills.some((s) => s.name === f.name);
    if (!m.skills[f.name] || !existsSync(dst) || (preferSkills[f.name] === f.tool && firstThisRun && !sameSkill(f.dir, dst))) {
      copySkill(f.dir, dst);
      m.skills[f.name] = m.skills[f.name] ?? {};
      addManaged(managed, f.name);
      report.skills.push({ name: f.name, from: f.tool });
    } else if (sameSkill(f.dir, dst)) {
      addManaged(managed, f.name);
    } else if (preferSkills[f.name] != null) {
      addManaged(managed, f.name);
      report.replaced.push({ kind: "skill", name: f.name, tool: f.tool });
    } else {
      report.conflicts.push({ kind: "skill", name: f.name, kept: origin("skills", f.name), other: f.tool });
    }
  }

  if (opts.instructions !== false) {
    const canonical = readInstructions(ctx).trim();
    const chosen = opts.instructions ? scan.instructions.find((i) => i.tool === opts.instructions) : scan.instructions[0];
    if (chosen && (!canonical || opts.instructions)) {
      if (chosen.text !== canonical) writeAtomic(paths(ctx).instructions, chosen.text + "\n");
      report.instructionsFrom = chosen.tool;
    }
    const kept = readInstructions(ctx).trim();
    for (const i of scan.instructions) {
      if (i.text !== kept) report.conflicts.push({ kind: "instructions", name: "AGENTS.md", kept: report.instructionsFrom ?? "manifest", other: i.tool });
    }
  }
  return report;
}

export interface ProjectImportReport {
  servers: { name: string; from: ToolId }[];
  skills: { name: string; from: ToolId }[];
  /** Already in the repo's scope the same way: 0bridge keeps that tool's copy in sync from now on. */
  adopted: { kind: "mcp" | "skill"; name: string; tool: ToolId }[];
  conflicts: { kind: "mcp" | "skill"; name: string; tool: ToolId }[];
  secrets: string[];
}

/** The server `0b project link` writes into a checkout: the link's, never part of the repo's scope. */
export const LINK_SERVER = "0bridge";

/**
 * Bring what a checkout's tools have in their project files (Claude Code's local scope and the
 * repo's .mcp.json, .codex/config.toml, .cursor/mcp.json, and .claude/skills, .agents/skills,
 * .cursor/skills) into its repo's project scope, and register the checkout for `0b apply`. Writes
 * only inside the 0bridge store; a name already in the scope with another definition is reported
 * and left out.
 */
export function importProject(ctx: Context, m: Manifest, state: State, store: SecretStore, co: { root: string; repo: string }): ProjectImportReport {
  const report: ProjectImportReport = { servers: [], skills: [], adopted: [], conflicts: [], secrets: [] };
  const scope = projectScope(m, co.repo, true);
  const entry = ((state.projects ??= {})[co.root] ??= { repo: co.repo, managed: {} });
  const global = getAdapters(ctx);
  const { adapters } = projectAdapters(ctx, co.root);
  const skillStore = projectSkillsDir(ctx, co.repo);
  for (const tool of TOOL_IDS) {
    const a = adapters[tool];
    if (!a || !isInstalled(global[tool])) continue;
    const managed = (entry.managed[tool] ??= { mcp: [], skills: [] });
    for (const [name, server] of Object.entries(a.readServers())) {
      if (name === LINK_SERVER) continue;
      const existing = scope.mcpServers[name];
      if (!existing) {
        scope.mcpServers[name] = extractSecrets(name, server, store, report, `project:${co.repo}:`);
        report.servers.push({ name, from: tool });
      } else if (portableKey(resolveServer(existing, store)) === portableKey(server)) {
        if (!report.servers.some((s) => s.name === name)) report.adopted.push({ kind: "mcp", name, tool });
      } else {
        report.conflicts.push({ kind: "mcp", name, tool });
        continue;
      }
      addManaged(managed.mcp, name);
    }
    for (const name of listSkills(a.skillsDir)) {
      const src = join(a.skillsDir!, name);
      const dst = join(skillStore, name);
      if (!scope.skills[name] || !existsSync(dst)) {
        mkdirSync(skillStore, { recursive: true });
        copySkill(src, dst);
        scope.skills[name] ??= {};
        report.skills.push({ name, from: tool });
      } else if (sameSkill(src, dst)) {
        if (!report.skills.some((s) => s.name === name)) report.adopted.push({ kind: "skill", name, tool });
      } else {
        report.conflicts.push({ kind: "skill", name, tool });
        continue;
      }
      addManaged(managed.skills, name);
    }
  }
  return report;
}
