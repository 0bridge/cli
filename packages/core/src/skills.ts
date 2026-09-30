import { cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { hashDir } from "./util.ts";

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
