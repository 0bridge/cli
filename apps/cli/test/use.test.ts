import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellLines, withVar } from "../src/use.ts";

const CLI = join(import.meta.dir, "..", "src", "index.ts");

describe("0b use --shell", () => {
  test("lines a shell evals: quoted for sh, PowerShell's form on Windows, unset for default", () => {
    expect(shellLines({ CLAUDE_CONFIG_DIR: "/Users/me/it's", CODEX_HOME: null }, "darwin")).toEqual([`export CLAUDE_CONFIG_DIR='/Users/me/it'\\''s'`, "unset CODEX_HOME"]);
    expect(shellLines({ CLAUDE_CONFIG_DIR: "C:\\Users\\me\\.claude-b", CODEX_HOME: null }, "win32")).toEqual([`$env:CLAUDE_CONFIG_DIR = 'C:\\Users\\me\\.claude-b'`, "Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue"]);
  });

  test("the sign-in line: sh's prefix, and PowerShell's with ~ as $HOME on Windows", () => {
    expect(withVar("CLAUDE_CONFIG_DIR", "~/.claude-work", "claude", "darwin")).toBe("CLAUDE_CONFIG_DIR=~/.claude-work claude");
    expect(withVar("CODEX_HOME", "~\\.codex-work", "codex login", "win32")).toBe('$env:CODEX_HOME="$HOME\\.codex-work"; codex login');
  });
});

describe("0b use and 0b skill add, end to end in a temporary home", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "0b-use-")));
  // Never this machine's own accounts: no CLAUDE_CONFIG_DIR or CODEX_HOME from the outside.
  const { CLAUDE_CONFIG_DIR, CODEX_HOME, ...outside } = process.env;
  const env = { ...outside, ZEROBRIDGE_USER_HOME: home, ZEROBRIDGE_DIR: join(home, ".0bridge"), ZEROBRIDGE_SECRET_STORE: "file", NO_COLOR: "1" };
  const run = (cwd: string, ...args: string[]) => spawnSync("bun", [CLI, ...args], { cwd, env, encoding: "utf8" });
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude.json"), "{}");
  const repo = join(home, "app");
  mkdirSync(repo);
  spawnSync("git", ["init", "-q"], { cwd: repo });

  test("add a profile, pick it in a repo, see it there, print it for a shell", () => {
    const add = run(home, "use", "add", "work");
    expect(add.status).toBe(0);
    expect(existsSync(join(home, ".claude-work"))).toBe(true);
    expect(add.stdout).toContain(process.platform === "win32" ? '$env:CLAUDE_CONFIG_DIR="$HOME\\.claude-work"; claude' : "CLAUDE_CONFIG_DIR=~/.claude-work claude");
    expect(run(repo, "use", "work").status).toBe(0);
    expect(run(repo, "use").stdout).toMatch(/● work .*← this repo/);
    expect(run(home, "use").stdout).toMatch(/● default/);
    expect(run(home, "use", "work", "--shell").stdout.trim()).toBe(shellLines({ CLAUDE_CONFIG_DIR: join(home, ".claude-work") }).join("\n"));
    expect(run(home, "use", "nope").status).toBe(1);
  });

  test("skill add: checked, copied into the store, in the manifest; a broken one is refused", () => {
    expect(run(home, "init", "--yes").status).toBe(0);
    const dir = join(home, "drafts", "notes");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: notes\ndescription: Use when taking notes.\n---\nbody\n");
    const r = run(home, "skill", "add", dir);
    expect(r.status).toBe(0);
    expect(readFileSync(join(home, ".0bridge", "skills", "notes", "SKILL.md"), "utf8")).toContain("taking notes");
    expect(JSON.parse(readFileSync(join(home, ".0bridge", "0bridge.json"), "utf8")).skills.notes).toEqual({});
    writeFileSync(join(dir, "SKILL.md"), "no front matter");
    const bad = run(home, "skill", "add", dir);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("front matter");
  });
});
