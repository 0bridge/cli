import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extraClaudeDirs } from "../src/adapters.ts";

const made: string[] = [];
const temp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  made.push(d);
  return d;
};
const claudeDir = (d: string) => {
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, ".claude.json"), "{}");
  return d;
};
const saved = process.env.CLAUDE_CONFIG_DIR;
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved;
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("CLAUDE_CONFIG_DIR outside an overridden home is someone's real config: not mirrored (a test's temporary home never writes to ~/.claude-b)", () => {
  const home = temp("0bridge-home-");
  process.env.CLAUDE_CONFIG_DIR = claudeDir(join(temp("real-"), ".claude-b"));
  expect(extraClaudeDirs({ home, storeDir: join(home, ".0bridge") })).toEqual([]);
});

test("CLAUDE_CONFIG_DIR inside that home is mirrored as before", () => {
  const home = temp("0bridge-home-");
  const inside = claudeDir(join(home, ".claude-b"));
  process.env.CLAUDE_CONFIG_DIR = inside;
  expect(extraClaudeDirs({ home, storeDir: join(home, ".0bridge") })).toContain(inside);
});
