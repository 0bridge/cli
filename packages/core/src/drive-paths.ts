/**
 * What the gateway (apps/gateway/src/drive-paths.ts) and `0b drive sync` agree a Drive path is: how
 * a case-insensitive disk sees a name, and which paths are a folder's agent instructions.
 */

/** Characters macOS and Windows ignore in names, so ".g‌it" is .git there. */
export const IGNORABLE = /[­​-‏‪-‮⁠-⁯﻿]/g;

/**
 * A name as a case-insensitive disk may see it: without ignorable characters, NFKC (so "ſ", the
 * long s that Unicode case folding makes "s", is an s: "AGENTſ.md" is AGENTS.md on APFS), lower case.
 */
export const foldName = (s: string) => s.replace(IGNORABLE, "").normalize("NFKC").toLowerCase();

/** Files agents load as instructions (any folder: Claude Code and Codex read nested ones), or that tools run on their own. */
const INSTRUCTION_FILES = new Set([
  "agents.md",
  "agents.override.md",
  "claude.md",
  "claude.local.md",
  "gemini.md",
  "copilot-instructions.md",
  ".cursorrules",
  ".windsurfrules",
  ".clinerules",
  ".envrc",
  ".mcp.json",
]);
/** Folders agents load skills, rules and settings (hooks) from, or whose contents editors, git tools and CI run. */
const INSTRUCTION_DIRS = new Set([".agents", ".claude", ".clinerules", ".codex", ".cursor", ".gemini", ".github", ".husky", ".junie", ".roo", ".vscode", ".windsurf"]);

/**
 * A folder's instructions and skills, and what runs on its own in a synced folder: AGENTS.md (and
 * AGENTS.override.md), CLAUDE.md (and CLAUDE.local.md), GEMINI.md, copilot-instructions.md, the
 * .cursorrules, .windsurfrules and .clinerules files, .envrc and .mcp.json, and anything under
 * .agents/, .claude/, .clinerules/, .codex/, .cursor/, .gemini/, .github/, .husky/, .junie/, .roo/,
 * .vscode/ or .windsurf/, in any folder, in any case (foldName).
 */
export function isInstructionPath(p: string): boolean {
  const segs = foldName(p).split("/");
  return INSTRUCTION_FILES.has(segs[segs.length - 1]!) || segs.some((x) => INSTRUCTION_DIRS.has(x));
}
