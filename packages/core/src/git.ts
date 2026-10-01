import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Whether `rel` (a file, or any file under a folder) is committed in the checkout at `root`. */
export function gitTracked(root: string, rel: string): boolean {
  return spawnSync("git", ["ls-files", "--error-unmatch", "--", rel], { cwd: root }).status === 0;
}

/**
 * Keep `rel` out of commits without touching the repo's .gitignore: a line in .git/info/exclude,
 * unless git already ignores it. A tracked file is left alone (false: it stays in git). Outside a
 * repo there's nothing to keep it out of (true).
 */
export function excludeFromGit(root: string, rel: string): boolean {
  if (spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root }).status !== 0) return true;
  if (gitTracked(root, rel)) return false;
  const ignored = spawnSync("git", ["check-ignore", "-q", "--", rel], { cwd: root }).status === 0;
  if (!ignored) {
    const exclude = spawnSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: root, encoding: "utf8" }).stdout.trim();
    const file = resolve(root, exclude);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${existsSync(file) && !readFileSync(file, "utf8").endsWith("\n") ? "\n" : ""}/${rel}\n`);
  }
  return true;
}
