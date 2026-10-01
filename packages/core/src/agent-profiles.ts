import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Context } from "./types.ts";
import { readJson, writeAtomic } from "./util.ts";
import { repoOf } from "./profiles.ts";

/**
 * Agent account profiles (M4, `0b use`). Another Claude Code or Codex account is another config
 * folder, which the tool takes from CLAUDE_CONFIG_DIR or CODEX_HOME when it starts. A profile is a
 * name for one: `~/.claude-<name>` and `~/.codex-<name>` (the folders 0.2.11 already found), or any
 * folder registered with `0b use add --dir`. A repo, a shell or the whole machine picks one; the
 * tool's own folder (~/.claude, ~/.codex) is the profile "default". `0b apply` gives every profile
 * the same MCP servers, skills and instructions, and history reads each one under its name.
 */

export type AgentTool = "claude" | "codex";
export const AGENT_TOOLS: AgentTool[] = ["claude", "codex"];
export const AGENT_HOME_VAR: Record<AgentTool, string> = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" };
export const AGENT_LABEL: Record<AgentTool, string> = { claude: "Claude Code", codex: "Codex" };

export interface AgentProfilesConfig {
  /** Folders registered by name, per tool. Found `~/.claude-*` and `~/.codex-*` folders aren't listed. */
  profiles: Partial<Record<AgentTool, Record<string, string>>>;
  /** Repos that use a profile: by checkout path, and by remote so other clones match too. */
  repos: { path: string; remote?: string; tool: AgentTool; profile: string }[];
  /** The profile used outside those repos (`0b use <name> --global`). */
  defaults?: Partial<Record<AgentTool, string>>;
}

export interface AgentProfile {
  tool: AgentTool;
  name: string;
  dir: string;
}

const configPath = (ctx: Context) => join(ctx.storeDir, "agent-profiles.json");

export function loadAgentProfiles(ctx: Context): AgentProfilesConfig {
  const cfg = readJson<Partial<AgentProfilesConfig>>(configPath(ctx));
  return { profiles: cfg?.profiles ?? {}, repos: cfg?.repos ?? [], ...(cfg?.defaults ? { defaults: cfg.defaults } : {}) };
}

export function saveAgentProfiles(ctx: Context, cfg: AgentProfilesConfig): void {
  writeAtomic(configPath(ctx), JSON.stringify(cfg, null, 2) + "\n");
}

/** The tool's own folder: the "default" profile. */
export const agentHome = (ctx: Context, tool: AgentTool) => join(ctx.home, `.${tool}`);

/** A folder the tool has used: Claude Code keeps a .claude.json in it, Codex its config or sign-in. */
function used(tool: AgentTool, dir: string): boolean {
  const marks = tool === "claude" ? [".claude.json"] : ["config.toml", "auth.json", "sessions"];
  return marks.some((m) => existsSync(join(dir, m)));
}

/**
 * Every profile of `tool` on this machine besides the default: registered ones, then the
 * `~/.<tool>-<name>` folders the tool has used. Sorted by name; a folder appears once.
 */
export function agentProfiles(ctx: Context, tool: AgentTool, cfg = loadAgentProfiles(ctx)): AgentProfile[] {
  const out = new Map<string, AgentProfile>();
  const dirs = new Set<string>([resolve(agentHome(ctx, tool))]);
  for (const [name, dir] of Object.entries(cfg.profiles[tool] ?? {})) {
    if (dirs.has(resolve(dir))) continue;
    dirs.add(resolve(dir));
    out.set(name, { tool, name, dir: resolve(dir) });
  }
  let names: string[] = [];
  try {
    names = readdirSync(ctx.home);
  } catch {}
  const pattern = new RegExp(`^\\.${tool}-([\\w.-]+)$`);
  for (const n of names) {
    const name = pattern.exec(n)?.[1];
    const d = resolve(ctx.home, n);
    if (!name || out.has(name) || dirs.has(d)) continue;
    try {
      if (statSync(d).isDirectory() && used(tool, d)) (out.set(name, { tool, name, dir: d }), dirs.add(d));
    } catch {}
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** A profile by name; "default" is the tool's own folder. */
export function findAgentProfile(ctx: Context, tool: AgentTool, name: string): AgentProfile | null {
  if (name === "default") return { tool, name, dir: resolve(agentHome(ctx, tool)) };
  return agentProfiles(ctx, tool).find((p) => p.name === name) ?? null;
}

/** The profile name of a config folder (`~/.claude-b` → `b`), or its folder name when it isn't one. */
export function agentProfileName(ctx: Context, tool: AgentTool, dir: string): string {
  const d = resolve(dir);
  if (d === resolve(agentHome(ctx, tool))) return "default";
  return agentProfiles(ctx, tool).find((p) => p.dir === d)?.name ?? (basename(d).replace(new RegExp(`^\\.${tool}-?`), "") || basename(d));
}

/**
 * The profile `tool` uses in `cwd` and why: the shell's (its variable is already set), else the
 * repo's (`0b use <name>` there: this checkout, then any clone of the same remote), else the
 * machine's (`--global`). Null: the tool's own folder.
 */
/**
 * The same folder however it's spelled: symlinks followed, and on Windows the long names (the native
 * realpath turns C:\\Users\\RUNNER~1 into what git reports) and either case.
 */
function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  const norm = (p: string) => {
    let r = resolve(p);
    try {
      r = realpathSync.native(r);
    } catch {}
    return process.platform === "win32" || process.platform === "darwin" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

export function agentProfileFor(ctx: Context, tool: AgentTool, cwd: string, env: NodeJS.ProcessEnv = process.env): (AgentProfile & { from: "shell" | "repo" | "global" }) | null {
  const set = env[AGENT_HOME_VAR[tool]];
  if (set) return { tool, name: agentProfileName(ctx, tool, set), dir: resolve(set), from: "shell" };
  const cfg = loadAgentProfiles(ctx);
  const repo = repoOf(cwd);
  const mine = cfg.repos.filter((r) => r.tool === tool);
  const hit = mine.find((r) => samePath(r.path, repo.path)) ?? (repo.remote ? mine.find((r) => r.remote === repo.remote) : undefined);
  const pick = (name: string | undefined, from: "repo" | "global") => {
    if (!name || name === "default") return null;
    const p = findAgentProfile(ctx, tool, name);
    return p ? { ...p, from } : null;
  };
  return hit ? pick(hit.profile, "repo") : pick(cfg.defaults?.[tool], "global");
}

/**
 * Variables that start Claude Code and Codex with the profiles picked for `cwd` (`0b exec`, the
 * shims). Only what the shell hasn't set: a shell that picked one keeps it.
 */
export function agentProfileEnv(ctx: Context, cwd: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tool of AGENT_TOOLS) {
    const p = agentProfileFor(ctx, tool, cwd, env);
    if (p && p.from !== "shell") out[AGENT_HOME_VAR[tool]] = p.dir;
  }
  return out;
}
