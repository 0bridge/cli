import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import type { Context } from "./types.ts";
import { readJson, writeAtomic } from "./util.ts";

/**
 * Per-repo CLI accounts. A profile is a directory used as `XDG_CONFIG_HOME` for the CLIs it
 * owns (wrangler, gh): each of those keeps its own login there. Everything else in
 * ~/.config is symlinked in, so pointing XDG_CONFIG_HOME at a profile changes only the
 * logins it owns and every other tool behaves as usual.
 */

export interface CliAdapter {
  label: string;
  /** The service it signs in to, as `0b connect` names it. */
  service: string;
  /** Its folder under XDG_CONFIG_HOME. */
  dir: string;
  login: string[];
  whoami: string[];
  /** How to install it, for when it isn't on this machine. */
  install: string;
  /**
   * Its login waits for the browser at a localhost address on this machine. Over SSH the browser
   * is elsewhere, so `0b profile add` offers to pass that address on (gh signs in with a code instead).
   */
  localhostCallback?: boolean;
}

export const CLIS: Record<string, CliAdapter> = {
  wrangler: { label: "Cloudflare (wrangler)", service: "cloudflare", dir: ".wrangler", login: ["wrangler", "login"], whoami: ["wrangler", "whoami"], install: "npm install -g wrangler", localhostCallback: true },
  gh: { label: "GitHub (gh)", service: "github", dir: "gh", login: ["gh", "auth", "login", "--web"], whoami: ["gh", "auth", "status"], install: "brew install gh (or see https://cli.github.com)" },
};

export interface ProfileConfig {
  profiles: Record<string, { clis: string[] }>;
  /** Repos bound to a profile: by checkout path, and by git remote so other clones match too. */
  repos: { path: string; remote?: string; profile: string }[];
}

export const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const configPath = (ctx: Context) => join(ctx.storeDir, "profiles.json");
export const profileDir = (ctx: Context, name: string) => join(ctx.storeDir, "profiles", name);
const userConfigDir = (ctx: Context) => process.env.XDG_CONFIG_HOME && !process.env.XDG_CONFIG_HOME.startsWith(join(ctx.storeDir, "profiles")) ? process.env.XDG_CONFIG_HOME : join(ctx.home, ".config");

export function loadProfiles(ctx: Context): ProfileConfig {
  return readJson<ProfileConfig>(configPath(ctx)) ?? { profiles: {}, repos: [] };
}

export function saveProfiles(ctx: Context, cfg: ProfileConfig): void {
  writeAtomic(configPath(ctx), JSON.stringify(cfg, null, 2) + "\n");
}

/** Link every ~/.config entry the profile doesn't own into its directory; drop links whose target is gone. */
export function refreshOverlay(ctx: Context, name: string, owned: string[]): string {
  const dir = profileDir(ctx, name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const base = userConfigDir(ctx);
  const ownedDirs = new Set(owned.map((c) => CLIS[c]?.dir).filter(Boolean));
  const wanted = new Set(existsSync(base) ? readdirSync(base).filter((e) => !ownedDirs.has(e)) : []);
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (!lstatSync(p).isSymbolicLink()) continue;
    if (!wanted.has(e) || readlinkSync(p) !== join(base, e)) rmSync(p);
  }
  for (const e of wanted) {
    const p = join(dir, e);
    if (!existsSync(p) && !isLink(p)) symlinkSync(join(base, e), p);
  }
  return dir;
}

const isLink = (p: string) => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
};

/** "github.com/owner/repo" from any remote URL form. */
export function normalizeRemote(url: string): string {
  return url
    .trim()
    .replace(/^[a-z+]+:\/\//, "")
    .replace(/^[^@/]+@/, "")
    .replace(/:(?!\d)/, "/")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .toLowerCase();
}

export function repoOf(cwd: string): { path: string; remote?: string } {
  const top = git(cwd, "rev-parse", "--show-toplevel");
  const path = resolve(top || cwd);
  const remote = git(path, "remote", "get-url", "origin");
  return { path, remote: remote ? normalizeRemote(remote) : undefined };
}

/** The profile bound to `cwd`'s repo: this checkout first, then any clone of the same remote. */
export function profileFor(ctx: Context, cwd: string): string | null {
  const cfg = loadProfiles(ctx);
  const repo = repoOf(cwd);
  const hit = cfg.repos.find((r) => r.path === repo.path) ?? (repo.remote ? cfg.repos.find((r) => r.remote === repo.remote) : undefined);
  return hit && cfg.profiles[hit.profile] ? hit.profile : null;
}

/** Environment for running a CLI in `cwd`: XDG_CONFIG_HOME set to its repo's profile, or nothing. */
export function profileEnv(ctx: Context, cwd: string): { profile: string | null; env: Record<string, string> } {
  const name = profileFor(ctx, cwd);
  if (!name) return { profile: null, env: {} };
  const dir = refreshOverlay(ctx, name, loadProfiles(ctx).profiles[name]!.clis);
  // gh prefers GH_CONFIG_DIR over XDG; clear an inherited one so the profile's login wins.
  return { profile: name, env: { XDG_CONFIG_HOME: dir, GH_CONFIG_DIR: join(dir, "gh") } };
}
