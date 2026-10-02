import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join, posix, relative, sep, win32 } from "node:path";
import type { Context, Manifest, McpServer, SkillEntry, State, ToolId } from "./types.ts";
import { TOOL_IDS } from "./types.ts";
import { claudeMirrors, codexMirrors, getAdapters, isInstalled, portableKey, projectAdapters, type Adapter } from "./adapters.ts";
import type { SecretStore } from "./secrets.ts";
import { addManaged, paths, projectScope, projectSkillsDir, resolveServer, serverFor, targets, toolEnabled, toolInstructions } from "./store.ts";
import { copySkill, listSkills, sameSkill } from "./skills.ts";
import { applyBlock, extractUnmanaged } from "./instructions.ts";
import { excludeFromGit, gitTracked } from "./git.ts";
import { isInside, readJson, readText, stableStringify, writeAtomic } from "./util.ts";

const isLink = (p: string) => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

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
  /** Which copy of the tool, when it isn't the tool itself (another account, a checkout). */
  label?: string;
  /** File mode to write with (a checkout's MCP file holds resolved values: 0600). */
  mode?: number;
  /** A file that held only 0bridge's block is deleted rather than left empty. */
  deleteIfEmpty?: boolean;
  /** Inside a checkout: kept out of its commits (.git/info/exclude) once written. */
  exclude?: { root: string; rel: string };
}

export interface SkillChange {
  kind: "skill";
  tool: ToolId;
  name: string;
  path: string;
  action: "install" | "update" | "remove";
  label?: string;
  /** Where the skill is copied from; default the 0bridge store's skills/<name>. */
  src?: string;
  exclude?: { root: string; rel: string };
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

function planMcp(a: Adapter, m: Pick<Manifest, "mcpServers"> & Partial<Pick<Manifest, "tools">>, state: State, store: SecretStore, missing: Set<string>, warnings: string[]): FileChange | null {
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
    const desired = resolveServer(serverFor(m, name, entry, tool), store, missing);
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

/**
 * The skills dir of another tool `a` reads that gets this skill too (Cursor reading Claude Code's),
 * or null. `others`: the tools synced alongside it.
 */
function readVia(a: Adapter, others: Adapter[], entry: SkillEntry): string | null {
  const via = others.find((o) => o !== a && o.skillsDir && a.alsoReads?.includes(o.skillsDir) && targets(entry, o.id));
  return via?.skillsDir ?? null;
}

/** `from`: the folder skills are copied from (the store's skills/, or a repo's). `others`: see readVia. */
function planSkills(ctx: Context, a: Adapter, m: Pick<Manifest, "skills">, state: State, warnings: string[], from = paths(ctx).skills, others: Adapter[] = []): SkillChange[] {
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
  for (const [name, entry] of wanted) {
    // The tool already reads it from another tool's folder: a second copy would be listed twice.
    if (readVia(a, others, entry)) continue;
    const src = join(from, name);
    const dst = join(a.skillsDir, name);
    if (!existsSync(src)) {
      warnings.push(`skill ${name}: missing from ${from}`);
      continue;
    }
    if (!existsSync(dst)) out.push({ kind: "skill", tool, name, path: dst, action: "install", src });
    else if (!sameSkill(src, dst)) {
      if (!prevManaged.includes(name)) {
        warnings.push(`${a.label}: skill ${name} exists with different content not managed by 0bridge — left as is`);
        continue;
      }
      out.push({ kind: "skill", tool, name, path: dst, action: "update", src });
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
  const canonical = m.instructions.enabled && targets(m.instructions, a.id) ? toolInstructions(ctx) : "";
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

export interface ApplyOptions {
  /**
   * Also write each registered checkout's project scope (its repo's MCP servers and skills, and
   * its instructions for every tool). On for `0b apply`, which shows the diff first; off where a
   * sync runs as a side effect (sign-in, `0b connect`, the sync screen).
   */
  projects?: boolean;
}

export function planApply(ctx: Context, m: Manifest, prev: State, store: SecretStore, only?: ToolId[], opts: ApplyOptions = {}): Plan {
  const state: State = structuredClone(prev);
  const adapters = getAdapters(ctx);
  const changes: Change[] = [];
  const warnings: string[] = [];
  const missing = new Set<string>();
  const synced = (tool: ToolId) => toolEnabled(m, tool) && isInstalled(adapters[tool]);
  const others = TOOL_IDS.filter(synced).map((t) => adapters[t]);
  for (const tool of TOOL_IDS) {
    const a = adapters[tool];
    if ((only && !only.includes(tool)) || !synced(tool)) continue;
    const mcp = planMcp(a, m, state, store, missing, warnings);
    if (mcp) changes.push(mcp);
    changes.push(...planSkills(ctx, a, m, state, warnings, undefined, others));
    const ins = planInstructions(ctx, a, m);
    if (ins) changes.push(ins);
  }
  // Other Claude Code config folders and Codex homes (a second account) get the same as ~/.claude
  // and ~/.codex, planned against what 0bridge had written before this run, so removals reach them
  // too. The state follows the tool's own folder.
  for (const [tool, mirrors] of [
    ["claude", claudeMirrors(ctx)],
    ["codex", codexMirrors(ctx)],
  ] as const) {
    if ((only && !only.includes(tool)) || !toolEnabled(m, tool)) continue;
    for (const a of mirrors) {
      const scratch = structuredClone(prev);
      const mcp = planMcp(a, m, scratch, store, missing, []);
      if (mcp) changes.push({ ...mcp, label: a.label });
      changes.push(...planSkills(ctx, a, m, scratch, []).map((c) => ({ ...c, label: a.label })));
      const ins = planInstructions(ctx, a, m);
      if (ins) changes.push({ ...ins, label: a.label });
    }
  }
  if (opts.projects) {
    for (const co of projectCheckouts(ctx, prev)) {
      const entry = ((state.projects ??= {})[co.root] ??= { repo: co.repo, managed: {} });
      entry.repo = co.repo;
      changes.push(...planProject(ctx, m, co, prev.projects?.[co.root]?.managed ?? {}, entry.managed, store, missing, warnings, only));
    }
  }
  return { changes, warnings, missing: [...missing], state };
}

/**
 * Checkouts that get their repo's project scope: those linked to a project (`0b project link`,
 * kept in projects.json) and those a `--project` command ran in (the state). Only ones still there.
 */
export function projectCheckouts(ctx: Context, state: State): { root: string; repo: string }[] {
  const links = readJson<{ links?: Record<string, { repo: string }> }>(join(ctx.storeDir, "projects.json"))?.links ?? {};
  const all = new Map<string, string>();
  for (const [root, l] of Object.entries(links)) all.set(root, l.repo);
  for (const [root, p] of Object.entries(state.projects ?? {})) if (!all.has(root)) all.set(root, p.repo);
  return [...all].filter(([root]) => existsSync(root)).map(([root, repo]) => ({ root, repo })).sort((a, b) => a.root.localeCompare(b.root));
}

/** The repo-relative form of a path in a checkout (forward slashes, as git and .git/info/exclude take it). */
const repoRel = (root: string, p: string) => relative(root, p).split(sep).join("/");

/**
 * One checkout's project scope. MCP servers go into each tool's project config (Claude Code's local
 * scope, .codex/config.toml, .cursor/mcp.json) and skills into its project skills folder, the same
 * way the global sync works: only what 0bridge wrote is ever changed or removed. A file or skill
 * that's committed is never touched (a warning says what to do instead), and what 0bridge creates
 * in the checkout is kept out of its commits.
 */
function planProject(
  ctx: Context,
  m: Manifest,
  co: { root: string; repo: string },
  prevManaged: NonNullable<State["projects"]>[string]["managed"],
  managed: NonNullable<State["projects"]>[string]["managed"],
  store: SecretStore,
  missing: Set<string>,
  warnings: string[],
  only?: ToolId[],
): Change[] {
  const scope = projectScope(m, co.repo) ?? { mcpServers: {}, skills: {} };
  const global = getAdapters(ctx);
  const { adapters, claudeMirrors: mirrors } = projectAdapters(ctx, co.root);
  const synced = (t: ToolId) => toolEnabled(m, t) && isInstalled(global[t]);
  const active = (Object.keys(adapters) as ToolId[]).filter((t) => synced(t) && (!only || only.includes(t)));
  const others = (Object.keys(adapters) as ToolId[]).filter(synced).map((t) => adapters[t]!);
  const sub: State = { managed };
  const changes: Change[] = [];
  const inRepo = (p: string) => isInside(co.root, p);
  const tracked = (p: string) => inRepo(p) && gitTracked(co.root, repoRel(co.root, p));

  for (const tool of active) {
    const a = adapters[tool]!;
    const before = structuredClone(sub.managed[tool]);
    const mcp = planMcp(a, scope, sub, store, missing, warnings);
    if (mcp && tracked(mcp.path)) {
      warnings.push(`${a.label}: ${repoRel(co.root, mcp.path)} is committed in ${co.root}, so ${mcp.summary.join(", ")} wasn't written (it would put this machine's values in git)`);
      (sub.managed[tool] ??= { mcp: [], skills: [] }).mcp = before?.mcp ?? [];
    } else if (mcp) changes.push({ ...mcp, label: a.label, ...(inRepo(mcp.path) ? { mode: 0o600, exclude: { root: co.root, rel: repoRel(co.root, mcp.path) } } : {}) });
    for (const s of planSkills(ctx, a, scope, sub, warnings, projectSkillsDir(ctx, co.repo), others)) {
      const rel = repoRel(co.root, s.path);
      if (s.action !== "install" && tracked(s.path)) {
        warnings.push(`${a.label}: skill ${s.name} is committed at ${rel} in ${co.root}; left as is`);
        continue;
      }
      changes.push({ ...s, label: a.label, ...(s.action === "install" ? { exclude: { root: co.root, rel } } : {}) });
    }
  }
  if (active.includes("claude"))
    for (const a of mirrors) {
      const scratch: State = { managed: structuredClone(prevManaged) };
      const mcp = planMcp(a, scope, scratch, store, missing, []);
      if (mcp) changes.push({ ...mcp, label: a.label });
    }
  changes.push(...planProjectInstructions(co.root, active, scope.instructions !== false, warnings));
  return changes;
}

const FROM_AGENTS = "<!-- 0bridge:begin (managed by 0bridge so Claude Code reads AGENTS.md too) -->";
const FROM_CLAUDE = "<!-- 0bridge:begin (managed by 0bridge: a copy of CLAUDE.md for Codex and Cursor; edit CLAUDE.md instead) -->";

/**
 * Every tool reads the repo's instructions, whichever file holds them. AGENTS.md is the shared one
 * (Codex and Cursor read it; Claude Code too, but only when there's no CLAUDE.md, code.claude.com/docs/en/memory):
 *  - AGENTS.md written and a CLAUDE.md (or .claude/CLAUDE.md, CLAUDE.local.md) that doesn't mention
 *    it: CLAUDE.md gets a block importing it (`@AGENTS.md`).
 *  - only CLAUDE.md written: AGENTS.md gets a block with a copy of it.
 * The user's own text is never changed. A committed file isn't touched (a warning says what to add),
 * a file 0bridge created is kept out of commits, and one left with nothing but an emptied block is
 * deleted. Off (`0b project instructions off`): the blocks come out. Only the `active` tools' files.
 */
function planProjectInstructions(root: string, active: ToolId[], on: boolean, warnings: string[]): FileChange[] {
  // One linked to the other (CLAUDE.md → AGENTS.md) already serves both; writing would replace the link.
  if (["CLAUDE.md", "AGENTS.md"].some((f) => isLink(join(root, f)))) return [];
  const read = (rel: string) => readText(join(root, rel));
  const own = (rel: string) => extractUnmanaged(read(rel) ?? "");
  const agents = own("AGENTS.md");
  const claudeFiles = ["CLAUDE.md", join(".claude", "CLAUDE.md"), "CLAUDE.local.md"].map(own);
  const claudeText = claudeFiles[0] || claudeFiles[1] || "";
  const toClaude = on && agents && claudeFiles.some(Boolean) && !claudeFiles.some((t) => t === agents || /AGENTS\.md/.test(t)) ? "@AGENTS.md" : "";
  const toAgents = on && !agents ? claudeText : "";
  const out: FileChange[] = [];
  for (const [rel, tool, body, begin, hint, synced] of [
    ["CLAUDE.md", "claude", toClaude, FROM_AGENTS, "add a line @AGENTS.md to it so Claude Code reads AGENTS.md too", active.includes("claude")],
    ["AGENTS.md", "codex", toAgents, FROM_CLAUDE, "Codex and Cursor read AGENTS.md, so put the instructions there", active.includes("codex") || active.includes("cursor")],
  ] as const) {
    if (!synced) continue;
    const path = join(root, rel);
    const before = read(rel);
    const after = applyBlock(before ?? "", body, begin);
    if (after === (before ?? "")) continue;
    if (gitTracked(root, rel)) {
      if (body) warnings.push(`${rel} is committed in ${root}, so 0bridge leaves it alone: ${hint}`);
      continue;
    }
    out.push({
      kind: "file",
      tool,
      what: "instructions",
      path,
      before,
      after,
      viewBefore: before ?? "",
      viewAfter: after,
      summary: [body ? (tool === "claude" ? "import AGENTS.md" : "copy CLAUDE.md") : "remove the 0bridge block"],
      rerender: (fresh) => applyBlock(fresh ?? "", body, begin),
      label: `${tool === "claude" ? "Claude Code" : "Codex, Cursor"} (${basename(root)})`,
      deleteIfEmpty: true,
      ...(before == null ? { exclude: { root, rel } } : {}),
    });
  }
  return out;
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
      const next = c.rerender(readText(c.path));
      if (!next.trim() && c.deleteIfEmpty) rmSync(c.path, { force: true });
      else writeAtomic(c.path, next, c.mode == null ? {} : { mode: c.mode });
    } else if (c.action === "remove") {
      rmSync(c.path, { recursive: true, force: true });
    } else {
      mkdirSync(dirname(c.path), { recursive: true });
      copySkill(c.src ?? join(paths(ctx).skills, c.name), c.path);
    }
    if (c.exclude && existsSync(c.path)) excludeFromGit(c.exclude.root, c.exclude.rel);
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
      else cells[t] = sameAsInstalled(resolveServer(serverFor(m, name, entry, t), store), cur, t) ? (entry.enabled === false ? "off" : "ok") : "differs";
    }
    status.mcp.push({ name, cells });
  }

  const synced = active.map((t) => adapters[t]);
  for (const [name, entry] of Object.entries(m.skills).sort(([a], [b]) => a.localeCompare(b))) {
    const cells: Partial<Record<ToolId, Cell>> = {};
    for (const t of active) {
      // Read from another tool's folder (Cursor from Claude Code's): that copy is the one to check.
      const dir = (entry.enabled !== false && readVia(adapters[t], synced, entry)) || adapters[t].skillsDir;
      const dst = dir && join(dir, name);
      if (!targets(entry, t)) cells[t] = "n/a";
      else if (!dir) cells[t] = "unsupported";
      else if (entry.enabled === false) cells[t] = existsSync(dst!) ? "differs" : "off";
      else if (!existsSync(dst!)) cells[t] = "missing";
      else cells[t] = sameSkill(join(paths(ctx).skills, name), dst!) ? "ok" : "differs";
    }
    status.skills.push({ name, cells });
  }

  const canonical = m.instructions.enabled ? toolInstructions(ctx) : "";
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
