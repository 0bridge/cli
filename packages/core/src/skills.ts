import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { hashDir, listFiles } from "./util.ts";

/** Skill dirs (`<dir>/<name>/SKILL.md`) directly under a skills root. Dot-dirs are tool-internal. */
export function listSkills(root: string | null): string[] {
  if (!root || !existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith(".") && existsSync(join(root, e.name, "SKILL.md")))
    .map((e) => e.name)
    .sort();
}

export function sameSkill(a: string, b: string): boolean {
  return existsSync(a) && existsSync(b) && hashDir(a) === hashDir(b);
}

export function copySkill(src: string, dst: string): void {
  rmSync(dst, { recursive: true, force: true });
  cpSync(src, dst, { recursive: true, dereference: true, filter: (p) => !p.endsWith(".DS_Store") });
}

/**
 * The front matter of a SKILL.md as plain strings: `key: value` lines (quotes dropped) and `>` or
 * `|` blocks (their indented lines, folded with spaces or kept with newlines). Null without one.
 */
export function skillFrontMatter(md: string): Record<string, string> | null {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(md);
  if (!m) return null;
  const out: Record<string, string> = {};
  const lines = m[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    let v = kv[2]!.trim();
    if (/^[>|][+-]?$/.test(v)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || lines[i + 1]!.trim() === "")) block.push(lines[++i]!.trim());
      v = block.join(v.startsWith(">") ? " " : "\n").trim();
    } else v = v.replace(/^(["'])([\s\S]*)\1$/, "$2");
    out[kv[1]!] = v;
  }
  return out;
}

/** A skill name 0bridge can use as a folder in every tool: no path separators, not hidden. */
export const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** The Agent Skills spec's form (lowercase words joined by hyphens), which some tools insist on. */
const SPEC_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_SKILL_BYTES = 20 * 1024 * 1024;

export interface SkillCheck {
  name: string;
  description: string;
  /** Fine to add, but worth saying. */
  warnings: string[];
}

/**
 * Whether a folder is a skill `0b skill add` can take: SKILL.md with front matter that names it
 * (`name`, else the folder's own name) and says when to use it (`description`, which is what agents
 * pick skills by). Throws with the reason when it isn't. A folder holding `.git` or
 * `node_modules`, or over 20 MB, is refused: it's likely a repo picked by mistake, and every
 * tool would get a copy.
 */
export function checkSkill(dir: string): SkillCheck {
  let isDir = false;
  try {
    isDir = statSync(dir).isDirectory();
  } catch {}
  if (!isDir) throw new Error(`no folder at ${dir}`);
  const mdPath = join(dir, "SKILL.md");
  if (!existsSync(mdPath)) throw new Error(`${dir} has no SKILL.md (a skill is a folder with SKILL.md in it)`);
  for (const junk of [".git", "node_modules"])
    if (existsSync(join(dir, junk))) throw new Error(`${dir} has ${junk} in it: point at the skill's own folder (the one with SKILL.md), not a repo`);
  const fm = skillFrontMatter(readFileSync(mdPath, "utf8"));
  if (!fm) throw new Error(`SKILL.md has no front matter: start it with ---, a name: and a description: line, then ---`);
  const warnings: string[] = [];
  const folder = basename(dir);
  const name = fm.name || folder;
  if (!SKILL_NAME.test(name)) throw new Error(`"${name}" can't be a skill name (letters, digits, . _ -, up to 64, not starting with a dot)`);
  if (!SPEC_NAME.test(name)) warnings.push(`"${name}" isn't lowercase words joined by hyphens, which some tools expect`);
  if (fm.name && fm.name !== folder) warnings.push(`added as ${name} (its front matter's name), not ${folder}`);
  const description = fm.description ?? "";
  if (!description) throw new Error(`SKILL.md has no description: agents choose a skill by its description, so add one that says when to use it`);
  if (description.length > 1024) warnings.push(`its description is ${description.length} characters; tools may cut it at 1024`);
  const bytes = listFiles(dir).reduce((n, f) => n + statSync(join(dir, f)).size, 0);
  if (bytes > MAX_SKILL_BYTES) throw new Error(`${dir} holds ${Math.round(bytes / 1024 / 1024)} MB; a skill over 20 MB is copied into every tool, so keep big files elsewhere`);
  return { name, description, warnings };
}
