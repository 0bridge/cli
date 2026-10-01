import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { redact } from "@0bridge/session/redact";
import { paths } from "./store.ts";
import type { Context } from "./types.ts";

/**
 * Your context on 0bridge: a profile, global instructions and skills, kept in the cloud so
 * every AI app reads the same ones. These are the local copies `0b context push|pull` syncs.
 */
export const contextPaths = (ctx: Context) => ({
  /** Who you are and how you like to work (new; at most 4,000 characters on 0bridge). */
  profile: join(ctx.storeDir, "PROFILE.md"),
  instructions: paths(ctx).instructions,
  skills: paths(ctx).skills,
});

/** A document on 0bridge (the profile, the instructions). */
export interface ContextDoc {
  text: string;
  hash: string;
  updatedAt: number;
}

export interface ContextSkillMeta {
  name: string;
  description: string;
  hash: string;
  updatedAt: number;
}

export interface ContextOverview {
  profile: ContextDoc | null;
  instructions: ContextDoc | null;
  skills: ContextSkillMeta[];
  memory: { count: number };
}

export interface MemoryItem {
  id: string;
  text: string;
  tags: string[];
  source: string;
  createdAt: number;
  updatedAt: number;
}

export const sha256Hex = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/** A skill's hash: SKILL.md and its files in path order (code units, so every runtime agrees). The gateway computes the same. */
export const skillHash = (body: string, files: Record<string, string>) =>
  sha256Hex(JSON.stringify([body, Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))]));

/**
 * What to do with one item (the profile, the instructions, a skill), from three hashes: here, on
 * 0bridge, and both at the last sync (`base`). null means there is none.
 *  - same: both have the same copy (just remember it as the base)
 *  - push / pull: only one side changed since the last sync
 *  - conflict: both changed (or both have one and they never synced)
 *  - delete-local: removed on 0bridge and unchanged here
 *  - none: nothing to do (also: removed here only; `0b context rm` removes a skill everywhere)
 */
export type SyncAction = "same" | "push" | "pull" | "conflict" | "delete-local" | "none";

export function planSync(local: string | null, remote: string | null, base: string | null): SyncAction {
  if (local === remote) return local === null ? "none" : "same";
  if (local === null) return remote !== base ? "pull" : "none";
  if (remote === null) return base !== null && local === base ? "delete-local" : "push";
  if (local === base) return "pull";
  if (remote === base) return "push";
  return "conflict";
}

/** The skills shipped with 0bridge itself (installed on sign-in): about the CLI, so they stay local. */
export const BUILTIN_SKILLS = new Set(["0bridge", "0bridge-secrets"]);

/** A file a skill's upload leaves out, and why. */
export interface SkippedFile {
  path: string;
  why: string;
}

export interface LocalSkill {
  name: string;
  body: string;
  files: Record<string, string>;
  hash: string;
  skipped: SkippedFile[];
}

const MAX_FILE = 256 * 1024;

/**
 * A skill folder as 0bridge stores it: SKILL.md plus its other files as text. Binary or oversized
 * files, dot-files, conflict copies (`*.0bridge-remote`) and files that look like they hold a
 * credential (an API key, a private key) stay local: every connected AI app can read a skill's files.
 */
export function readSkill(dir: string, name: string): LocalSkill | null {
  const md = join(dir, "SKILL.md");
  if (!existsSync(md)) return null;
  const body = readFileSync(md, "utf8");
  const files: Record<string, string> = {};
  const skipped: SkippedFile[] = [];
  const walk = (d: string, seen: Set<string>) => {
    let real: string;
    try {
      real = realpathSync(d);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = join(d, e.name);
      const rel = relative(dir, abs).split(sep).join("/");
      if (e.name.startsWith(".") || e.name.endsWith(".0bridge-remote") || rel === "SKILL.md") continue;
      let st;
      try {
        st = lstatSync(abs).isSymbolicLink() ? lstatSync(realpathSync(abs)) : lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(abs, seen);
      else if (st.isFile()) {
        if (st.size > MAX_FILE) {
          skipped.push({ path: rel, why: "over 256 KB" });
          continue;
        }
        const buf = readFileSync(abs);
        const text = buf.toString("utf8");
        if (buf.includes(0) || text.includes("�")) skipped.push({ path: rel, why: "not text" });
        else if (redact(text) !== text) skipped.push({ path: rel, why: "it looks like it holds a credential" });
        else files[rel] = text;
      }
    }
  };
  walk(dir, new Set());
  return { name, body, files, hash: skillHash(body, files), skipped };
}
