import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, posix, relative, win32 } from "node:path";
import type { Context, Manifest, McpServer, State, ToolId } from "./types.ts";
import { TOOL_IDS } from "./types.ts";
import { claudeMirrors, getAdapters, isInstalled, portableKey, type Adapter } from "./adapters.ts";
import type { SecretStore } from "./secrets.ts";
import { addManaged, paths, readInstructions, resolveServer, targets, toolEnabled } from "./store.ts";
import { copySkill, listSkills, sameSkill } from "./skills.ts";
import { applyBlock } from "./instructions.ts";
import { readJson, readText, stableStringify, writeAtomic } from "./util.ts";

export interface FileChange {
  kind: "file";
  tool: ToolId;
  /** `hooks`: the turn-end hook entries of `0b history hooks` (hooks.ts). */
  what: "mcp" | "instructions" | "hooks";
  path: string;
  before: string | null;
  after: string;
  viewBefore: string;
  viewAfter: string;
  summary: string[];
  /** Re-render against the file's content at write time (the tool may have rewritten it since planning). */
  rerender: (fresh: string | null) => string;
}

export interface SkillChange {
  kind: "skill";
  tool: ToolId;
  name: string;
  path: string;
  action: "install" | "update" | "remove";
}

export type Change = FileChange | SkillChange;

export interface Plan {
  changes: Change[];
  warnings: string[];
  missing: string[];
  state: State;
}

/** Normalized comparison of a desired server against what a tool currently has. */
function sameAsInstalled(desired: McpServer, installed: McpServer, tool: ToolId): boolean {
  return (
    portableKey(desired) === portableKey(installed) &&
    (desired.enabled !== false) === (installed.enabled !== false) &&
    stableStringify(desired.native?.[tool] ?? {}) === stableStringify(installed.native?.[tool] ?? {})
  );
}

function planMcp(a: Adapter, m: Manifest, state: State, store: SecretStore, missing: Set<string>, warnings: string[]): FileChange | null {
  const tool = a.id;
  const before = readText(a.configPath);
  const installed = a.readServers(before);
  const prevManaged = state.managed[tool]?.mcp ?? [];
  const managed: string[] = [];
  const upsert: Record<string, McpServer> = {};

  for (const [name, entry] of Object.entries(m.mcpServers)) {
    if (!targets(entry, tool)) continue;
    if (entry.enabled === false && !a.supportsDisabled) continue;
    if (entry.transport === "sse" && !a.supportsSse) {
      warnings.push(`${a.label}: skipped ${name} (SSE transport not supported; switch the server to its streamable HTTP URL)`);
      continue;
    }
    const desired = resolveServer(entry, store, missing);
    const current = installed[name];
    if (current && sameAsInstalled(desired, current, tool)) {
      addManaged(managed, name);
    } else if (current && !prevManaged.includes(name)) {
      warnings.push(`${a.label}: ${name} exists with a different definition not managed by 0bridge — left as is (run \`0b import\` or remove it to let 0bridge manage it)`);
    } else {
      upsert[name] = desired;
      addManaged(managed, name);
    }
  }
  const remove = prevManaged.filter((n) => !managed.includes(n) && n in installed);
  (state.managed[tool] ??= { mcp: [], skills: [] }).mcp = managed;

  if (!Object.keys(upsert).length && !remove.length) return null;
  const after = a.render(before, upsert, remove);
  return {
    kind: "file",
    tool,
    what: "mcp",
    path: a.configPath,
    before,
    after,
    viewBefore: a.diffView(before),
    viewAfter: a.diffView(after),
    summary: [
      ...Object.keys(upsert).map((n) => `${n in installed ? "update" : "add"} ${n}`),
      ...remove.map((n) => `remove ${n}`),
    ],
    rerender: (fresh) => a.render(fresh, upsert, remove),
  };
}

function planSkills(ctx: Context, a: Adapter, m: Manifest, state: State, warnings: string[]): SkillChange[] {
  const tool = a.id;
  const wanted = Object.entries(m.skills).filter(([, e]) => e.enabled !== false && targets(e, tool));
  const prevManaged = state.managed[tool]?.skills ?? [];
  const managed: string[] = [];
  const out: SkillChange[] = [];
  if (!a.skillsDir) {
    if (wanted.some(([, e]) => !e.targets)) {
      warnings.push(`${a.label}: no global skills directory found — skills not synced (create ${join(a.dir, "skills")} to enable)`);
    }
    (state.managed[tool] ??= { mcp: [], skills: [] }).skills = [];
    return out;
  }
  for (const [name] of wanted) {
    const src = join(paths(ctx).skills, name);
    const dst = join(a.skillsDir, name);
    if (!existsSync(src)) {
      warnings.push(`skill ${name}: missing from ${paths(ctx).skills}`);
      continue;
    }
    if (!existsSync(dst)) out.push({ kind: "skill", tool, name, path: dst, action: "install" });
    else if (!sameSkill(src, dst)) {
      if (!prevManaged.includes(name)) {
        warnings.push(`${a.label}: skill ${name} exists with different content not managed by 0bridge — left as is`);
        continue;
      }
      out.push({ kind: "skill", tool, name, path: dst, action: "update" });
    }
    addManaged(managed, name);
  }
  for (const name of prevManaged) {
    if (!managed.includes(name) && existsSync(join(a.skillsDir, name))) {
      out.push({ kind: "skill", tool, name, path: join(a.skillsDir, name), action: "remove" });
    }
  }
  (state.managed[tool] ??= { mcp: [], skills: [] }).skills = managed;
  return out;
}

function planInstructions(ctx: Context, a: Adapter, m: Manifest): FileChange | null {
  if (!a.instructionsPath) return null;
  const canonical = m.instructions.enabled && targets(m.instructions, a.id) ? readInstructions(ctx) : "";
  const before = readText(a.instructionsPath);
  const after = applyBlock(before ?? "", canonical);
  if (after === (before ?? "")) return null;
  return {
    kind: "file",
    tool: a.id,
    what: "instructions",
    path: a.instructionsPath,
    before,
    after,
    viewBefore: before ?? "",
    viewAfter: after,
    summary: [canonical.trim() ? "sync AGENTS.md block" : "remove AGENTS.md block"],
    rerender: (fresh) => applyBlock(fresh ?? "", canonical),
  };
}

export function planApply(ctx: Context, m: Manifest, prev: State, store: SecretStore, only?: ToolId[]): Plan {
  const state: State = structuredClone(prev);
  const adapters = getAdapters(ctx);
  const changes: Change[] = [];
  const warnings: string[] = [];
  const missing = new Set<string>();
  for (const tool of TOOL_IDS) {
    const a = adapters[tool];
    if ((only && !only.includes(tool)) || !toolEnabled(m, tool) || !isInstalled(a)) continue;
    const mcp = planMcp(a, m, state, store, missing, warnings);
    if (mcp) changes.push(mcp);
    changes.push(...planSkills(ctx, a, m, state, warnings));
    const ins = planInstructions(ctx, a, m);
    if (ins) changes.push(ins);
  }
  // Other Claude Code config folders (a second account) get the same as ~/.claude, planned against
  // what 0bridge had written before this run, so removals reach them too. The state follows ~/.claude.
  if ((!only || only.includes("claude")) && toolEnabled(m, "claude")) {
    for (const a of claudeMirrors(ctx)) {
      const scratch = structuredClone(prev);
      const mcp = planMcp(a, m, scratch, store, missing, []);
      if (mcp) changes.push(mcp);
      changes.push(...planSkills(ctx, a, m, scratch, []));
      const ins = planInstructions(ctx, a, m);
      if (ins) changes.push(ins);
    }
  }
  return { changes, warnings, missing: [...missing], state };
}

/**
 * Where a backed-up path goes inside a backup's `files` folder: the absolute path made relative,
 * keeping the drive on Windows so C:\x and D:\x never share a copy. `/home/me/.claude.json` →
 * `home/me/.claude.json`, `C:\Users\me\.claude.json` → `C/Users/me/.claude.json`,
 * `\\server\share\x` → `UNC/server/share/x`.
 */
export function backupRel(p: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return posix.relative("/", posix.resolve("/", p));
  const abs = win32.resolve(p);
  const { root } = win32.parse(abs);
  const rest = abs.slice(root.length).split(/[\\/]+/).filter(Boolean);
  const drive = /^([A-Za-z]):/.exec(root)?.[1]?.toUpperCase();
  const head = drive ? [drive] : ["UNC", ...root.split(/[\\/]+/).filter(Boolean)];
  return [...head, ...rest].join("/");
}

interface BackupIndex {
  createdAt: string;
  entries: { path: string; existed: boolean }[];
}

/** Execute a plan. Every touched path is backed up first; returns the backup id. */
export function executePlan(ctx: Context, plan: Plan): string {
  if (plan.missing.length) throw new Error(`unresolved refs: ${plan.missing.join(", ")} — set them with \`0b secret set\``);
  const id = new Date().toISOString().replace(/[:.]/g, "-");
  const root = join(paths(ctx).backups, id);
  const index: BackupIndex = { createdAt: new Date().toISOString(), entries: [] };
  const backup = (p: string) => {
    if (index.entries.some((e) => e.path === p)) return;
    const existed = existsSync(p);
    if (existed) {
      const dst = join(root, "files", backupRel(p));
      mkdirSync(dirname(dst), { recursive: true });
      cpSync(p, dst, { recursive: true });
    }
    index.entries.push({ path: p, existed });
  };
  mkdirSync(ctx.storeDir, { recursive: true, mode: 0o700 });
  mkdirSync(root, { recursive: true, mode: 0o700 });

  for (const c of plan.changes) {
    backup(c.path);
    if (c.kind === "file") {
      writeAtomic(c.path, c.rerender(readText(c.path)));
    } else if (c.action === "remove") {
      rmSync(c.path, { recursive: true, force: true });
    } else {
      mkdirSync(dirname(c.path), { recursive: true });
      copySkill(join(paths(ctx).skills, c.name), c.path);
    }
  }
  backup(paths(ctx).state);
  writeAtomic(join(root, "index.json"), JSON.stringify(index, null, 2) + "\n");
  writeAtomic(paths(ctx).state, JSON.stringify(plan.state, null, 2) + "\n");
  return id;
}

export function listBackups(ctx: Context): string[] {
  const dir = paths(ctx).backups;
  return existsSync(dir) ? readdirSync(dir).filter((d) => existsSync(join(dir, d, "index.json"))).sort() : [];
}

/**
 * Put every path touched by an apply back the way it was (paths it created are deleted). Every
 * copy is found before anything is touched; a backup from before backupRel kept the drive (Windows)
 * is read where it was written then.
 */
export function restoreBackup(ctx: Context, id: string): string[] {
  const root = join(paths(ctx).backups, id);
  const index = readJson<BackupIndex>(join(root, "index.json"));
  if (!index) throw new Error(`no backup ${id}`);
  const copies = index.entries.map((e) => {
    if (!e.existed) return null;
    const copy = [backupRel(e.path), relative("/", e.path)].map((r) => join(root, "files", r)).find((f) => existsSync(f));
    if (!copy) throw new Error(`backup ${id} has no copy of ${e.path}; nothing was restored`);
    return copy;
  });
  index.entries.forEach((e, i) => {
    rmSync(e.path, { recursive: true, force: true });
    if (copies[i]) cpSync(copies[i]!, e.path, { recursive: true });
  });
  return index.entries.map((e) => e.path);
}

export type Cell = "ok" | "differs" | "missing" | "off" | "n/a" | "unsupported";

export interface Status {
  tools: { id: ToolId; label: string; installed: boolean; enabled: boolean }[];
  mcp: { name: string; cells: Partial<Record<ToolId, Cell>> }[];
  skills: { name: string; cells: Partial<Record<ToolId, Cell>> }[];
  unmanaged: { tool: ToolId; kind: "mcp" | "skill"; name: string }[];
  instructions: Partial<Record<ToolId, Cell>>;
}

/** Drift report: for every manifest item, is each tool in sync? */
export function computeStatus(ctx: Context, m: Manifest, store: SecretStore): Status {
  const adapters = getAdapters(ctx);
  const active = TOOL_IDS.filter((t) => isInstalled(adapters[t]) && toolEnabled(m, t));
  const installedServers = Object.fromEntries(active.map((t) => [t, adapters[t].readServers()])) as Record<ToolId, Record<string, McpServer>>;
  const status: Status = {
    tools: TOOL_IDS.map((t) => ({ id: t, label: adapters[t].label, installed: isInstalled(adapters[t]), enabled: toolEnabled(m, t) })),
    mcp: [],
    skills: [],
    unmanaged: [],
    instructions: {},
  };

  for (const [name, entry] of Object.entries(m.mcpServers).sort(([a], [b]) => a.localeCompare(b))) {
    const cells: Partial<Record<ToolId, Cell>> = {};
    for (const t of active) {
      const a = adapters[t];
      const cur = installedServers[t][name];
      if (!targets(entry, t)) cells[t] = "n/a";
      else if (entry.transport === "sse" && !a.supportsSse) cells[t] = "unsupported";
      else if (entry.enabled === false && !a.supportsDisabled) cells[t] = cur ? "differs" : "off";
      else if (!cur) cells[t] = "missing";
      else cells[t] = sameAsInstalled(resolveServer(entry, store), cur, t) ? (entry.enabled === false ? "off" : "ok") : "differs";
    }
    status.mcp.push({ name, cells });
  }

  for (const [name, entry] of Object.entries(m.skills).sort(([a], [b]) => a.localeCompare(b))) {
    const cells: Partial<Record<ToolId, Cell>> = {};
    for (const t of active) {
      const dir = adapters[t].skillsDir;
      const dst = dir && join(dir, name);
      if (!targets(entry, t)) cells[t] = "n/a";
      else if (!dir) cells[t] = "unsupported";
      else if (entry.enabled === false) cells[t] = existsSync(dst!) ? "differs" : "off";
      else if (!existsSync(dst!)) cells[t] = "missing";
      else cells[t] = sameSkill(join(paths(ctx).skills, name), dst!) ? "ok" : "differs";
    }
    status.skills.push({ name, cells });
  }

  const canonical = m.instructions.enabled ? readInstructions(ctx) : "";
  for (const t of active) {
    const a = adapters[t];
    for (const name of Object.keys(installedServers[t])) if (!m.mcpServers[name]) status.unmanaged.push({ tool: t, kind: "mcp", name });
    for (const name of listSkills(a.skillsDir)) if (!m.skills[name]) status.unmanaged.push({ tool: t, kind: "skill", name });
    if (!a.instructionsPath) status.instructions[t] = "unsupported";
    else if (!canonical.trim()) status.instructions[t] = "off";
    else {
      const cur = readText(a.instructionsPath) ?? "";
      status.instructions[t] = applyBlock(cur, canonical) === cur ? "ok" : cur.includes("0bridge:begin") ? "differs" : "missing";
    }
  }
  return status;
}
