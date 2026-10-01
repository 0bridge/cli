import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  agentProfileEnv,
  agentProfileFor,
  agentProfiles,
  checkSkill,
  emptyManifest,
  executePlan,
  extraClaudeDirs,
  importProject,
  loadState,
  openSecretStore,
  planApply,
  projectSkillsDir,
  restoreBackup,
  saveAgentProfiles,
  saveState,
  skillFrontMatter,
  type Context,
  type Manifest,
} from "../src/index.ts";

process.env.ZEROBRIDGE_SECRET_STORE = "file";

let home: string;
let ctx: Context;
const env = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };

function write(path: string, content: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}
const read = (path: string) => readFileSync(path, "utf8");
const git = (cwd: string, ...args: string[]) => spawnSync("git", ["-c", "user.email=t@x", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
const skill = (dir: string, name: string, body = "body") => write(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: Use for ${name}.\n---\n${body}\n`);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "0bridge-scope-"));
  ctx = { home, storeDir: join(home, ".0bridge") };
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  write(join(home, ".claude.json"), JSON.stringify({ mcpServers: {} }, null, 2));
  mkdirSync(join(home, ".claude"), { recursive: true });
  write(join(home, ".codex", "config.toml"), "");
  mkdirSync(join(home, ".cursor"), { recursive: true });
});
afterEach(() => {
  for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  rmSync(home, { recursive: true, force: true });
});

describe("0b skill add: which folders are skills", () => {
  test("SKILL.md with a name and a description; the front matter's name wins, with a note", () => {
    const dir = join(home, "drafts", "my-folder");
    write(join(dir, "SKILL.md"), `---\nname: release-notes\ndescription: >\n  Use when writing\n  release notes.\n---\nbody`);
    const r = checkSkill(dir);
    expect(r.name).toBe("release-notes");
    expect(r.description).toBe("Use when writing release notes.");
    expect(r.warnings.join()).toContain("not my-folder");
    expect(skillFrontMatter(`---\nname: "x"\n---\n`)).toEqual({ name: "x" });
  });

  test("refused: no folder, no SKILL.md, no front matter, no description, a repo, a bad name", () => {
    const at = (n: string) => join(home, "s", n);
    expect(() => checkSkill(at("missing"))).toThrow(/no folder/);
    mkdirSync(at("empty"), { recursive: true });
    expect(() => checkSkill(at("empty"))).toThrow(/no SKILL.md/);
    write(join(at("plain"), "SKILL.md"), "# just markdown");
    expect(() => checkSkill(at("plain"))).toThrow(/front matter/);
    write(join(at("nodesc"), "SKILL.md"), "---\nname: nodesc\n---\n");
    expect(() => checkSkill(at("nodesc"))).toThrow(/description/);
    skill(join(home, "s"), "repo");
    mkdirSync(join(at("repo"), ".git"));
    expect(() => checkSkill(at("repo"))).toThrow(/\.git/);
    write(join(at("bad"), "SKILL.md"), "---\nname: ../evil\ndescription: x\n---\n");
    expect(() => checkSkill(at("bad"))).toThrow(/can't be a skill name/);
  });
});

describe("Cursor's global skills", () => {
  test("Cursor reads Claude Code's folder, so a skill there isn't copied again; without Claude Code it gets ~/.cursor/skills", () => {
    const m: Manifest = { ...emptyManifest(), skills: { pdf: {} } };
    skill(join(ctx.storeDir, "skills"), "pdf");
    const store = openSecretStore(ctx.storeDir);
    executePlan(ctx, planApply(ctx, m, loadState(ctx), store));
    expect(existsSync(join(home, ".claude", "skills", "pdf", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".cursor", "skills", "pdf"))).toBe(false);
    expect(planApply(ctx, m, loadState(ctx), store).changes).toEqual([]);

    // Only for Cursor: its own folder, made if it isn't there (with Codex too, Cursor would read Codex's copy).
    m.skills.pdf = { targets: ["cursor"] };
    const plan = planApply(ctx, m, loadState(ctx), store);
    expect(plan.changes.map((c) => [c.tool, c.kind === "skill" && c.action])).toEqual(
      expect.arrayContaining([
        ["claude", "remove"],
        ["cursor", "install"],
      ]),
    );
    executePlan(ctx, plan);
    expect(existsSync(join(home, ".cursor", "skills", "pdf", "SKILL.md"))).toBe(true);
  });
});

describe("project scope", () => {
  let repo: string;
  const REPO = "github.com/acme/app";

  beforeEach(() => {
    repo = join(home, "code", "app");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q");
    // Committed by the team: AGENTS.md and a shared .mcp.json. Written by the user, untracked: CLAUDE.md.
    write(join(repo, "AGENTS.md"), "Run bun test before committing.\n");
    write(join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { docs: { type: "http", url: "https://docs.example/mcp" } } }));
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");
    write(join(repo, "CLAUDE.md"), "Prefer small diffs.\n");
    // Cursor already has a server of the user's own here.
    write(join(repo, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { mine: { url: "https://mine.example/mcp" } } }, null, 2));
  });

  function manifest(): Manifest {
    const m = emptyManifest();
    m.projects = { [REPO]: { mcpServers: { db: { transport: "stdio", command: "db-mcp", args: ["--ro"] } }, skills: { deploy: {} } } };
    skill(projectSkillsDir(ctx, REPO), "deploy");
    const st = loadState(ctx);
    st.projects = { [repo]: { repo: REPO, managed: {} } };
    saveState(ctx, st);
    return m;
  }

  test("apply writes the repo's servers, skills and instructions into each tool here, out of git, and only ever its own", () => {
    const m = manifest();
    const store = openSecretStore(ctx.storeDir);
    const plan = planApply(ctx, m, loadState(ctx), store, undefined, { projects: true });
    // Without projects (sign-in, connect): nothing in the checkout.
    expect(planApply(ctx, m, loadState(ctx), store).changes.some((c) => c.path.startsWith(repo))).toBe(false);
    const id = executePlan(ctx, plan);

    // Claude Code: the local scope for this folder, nothing in the repo's .mcp.json.
    const claude = JSON.parse(read(join(home, ".claude.json")));
    expect(claude.projects[repo].mcpServers.db).toEqual({ type: "stdio", command: "db-mcp", args: ["--ro"], env: {} });
    expect(JSON.parse(read(join(repo, ".mcp.json"))).mcpServers.db).toBeUndefined();
    // Codex and Cursor: their project files; the user's own Cursor server stays.
    expect((parseToml(read(join(repo, ".codex", "config.toml"))) as any).mcp_servers.db.command).toBe("db-mcp");
    const cursor = JSON.parse(read(join(repo, ".cursor", "mcp.json")));
    expect(Object.keys(cursor.mcpServers).sort()).toEqual(["db", "mine"]);
    // Skills: Claude Code's and Codex's folders; Cursor reads both, so not .cursor/skills.
    expect(existsSync(join(repo, ".claude", "skills", "deploy", "SKILL.md"))).toBe(true);
    expect(existsSync(join(repo, ".agents", "skills", "deploy", "SKILL.md"))).toBe(true);
    expect(existsSync(join(repo, ".cursor", "skills"))).toBe(false);
    // Instructions: CLAUDE.md (the user's) imports the committed AGENTS.md in a marked block.
    expect(read(join(repo, "CLAUDE.md"))).toBe("Prefer small diffs.\n\n<!-- 0bridge:begin (managed by 0bridge so Claude Code reads AGENTS.md too) -->\n@AGENTS.md\n<!-- 0bridge:end -->\n");
    expect(read(join(repo, "AGENTS.md"))).toBe("Run bun test before committing.\n");
    // Out of git: nothing new shows up in status.
    expect(git(repo, "status", "--porcelain").stdout.trim()).toBe("?? CLAUDE.md");
    expect(read(join(repo, ".git", "info", "exclude"))).toContain("/.claude/skills/deploy");
    // Idempotent.
    expect(planApply(ctx, m, loadState(ctx), store, undefined, { projects: true }).changes).toEqual([]);

    // Out of the scope: only what 0bridge wrote goes.
    m.projects![REPO] = { mcpServers: {}, skills: {}, instructions: false };
    executePlan(ctx, planApply(ctx, m, loadState(ctx), store, undefined, { projects: true }));
    expect(JSON.parse(read(join(repo, ".cursor", "mcp.json"))).mcpServers).toEqual({ mine: { url: "https://mine.example/mcp" } });
    expect(existsSync(join(repo, ".claude", "skills", "deploy"))).toBe(false);
    expect(read(join(repo, "CLAUDE.md"))).toBe("Prefer small diffs.\n");
    expect(JSON.parse(read(join(home, ".claude.json"))).projects[repo].mcpServers.db).toBeUndefined();

    restoreBackup(ctx, id);
    expect(read(join(repo, "CLAUDE.md"))).toBe("Prefer small diffs.\n");
    expect(existsSync(join(repo, ".agents", "skills", "deploy"))).toBe(false);
  });

  test("committed files and other people's entries are never touched", () => {
    const m = manifest();
    // The team commits .cursor/mcp.json, and someone's own `deploy` skill is in .claude/skills.
    git(repo, "add", ".cursor/mcp.json");
    git(repo, "commit", "-qm", "cursor");
    skill(join(repo, ".claude", "skills"), "deploy", "someone else's");
    const plan = planApply(ctx, m, loadState(ctx), openSecretStore(ctx.storeDir), undefined, { projects: true });
    expect(plan.changes.some((c) => c.path === join(repo, ".cursor", "mcp.json"))).toBe(false);
    expect(plan.changes.some((c) => c.path === join(repo, ".claude", "skills", "deploy"))).toBe(false);
    expect(plan.warnings.join("\n")).toMatch(/\.cursor\/mcp\.json is committed/);
    expect(plan.warnings.join("\n")).toMatch(/skill deploy exists with different content not managed/);
    // A committed CLAUDE.md isn't edited either: a warning says what to add.
    git(repo, "add", "CLAUDE.md");
    git(repo, "commit", "-qm", "claude");
    const again = planApply(ctx, m, loadState(ctx), openSecretStore(ctx.storeDir), undefined, { projects: true });
    expect(again.changes.some((c) => c.path === join(repo, "CLAUDE.md"))).toBe(false);
    expect(again.warnings.join("\n")).toMatch(/CLAUDE\.md is committed.*@AGENTS\.md/);
  });

  test("only CLAUDE.md: AGENTS.md gets a marked copy for Codex and Cursor, and goes when it's all 0bridge's", () => {
    rmSync(join(repo, "AGENTS.md"));
    git(repo, "commit", "-qam", "rm agents");
    const m = manifest();
    const store = openSecretStore(ctx.storeDir);
    executePlan(ctx, planApply(ctx, m, loadState(ctx), store, undefined, { projects: true }));
    expect(read(join(repo, "AGENTS.md"))).toContain("Prefer small diffs.");
    expect(read(join(repo, "AGENTS.md"))).toContain("edit CLAUDE.md instead");
    expect(read(join(repo, "CLAUDE.md"))).toBe("Prefer small diffs.\n");
    m.projects![REPO]!.instructions = false;
    executePlan(ctx, planApply(ctx, m, loadState(ctx), store, undefined, { projects: true }));
    expect(existsSync(join(repo, "AGENTS.md"))).toBe(false);
  });

  test("import: the checkout's project servers and skills join the repo's scope (never the link's 0bridge entry)", () => {
    write(join(repo, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { "0bridge": { url: "https://0bridge.dev/mcp/p/pr_1" }, mine: { url: "https://mine.example/mcp", headers: { Authorization: "Bearer sk-live-0123456789abcdef" } } } }));
    skill(join(repo, ".claude", "skills"), "review");
    const m = emptyManifest();
    const st = loadState(ctx);
    const r = importProject(ctx, m, st, openSecretStore(ctx.storeDir), { root: repo, repo: REPO });
    expect(r.servers.map((s) => s.name).sort()).toEqual(["docs", "mine"]);
    expect(r.skills).toEqual([{ name: "review", from: "claude" }]);
    expect(m.projects![REPO]!.mcpServers.mine!.headers!.Authorization).toBe(`\${secret:project:${REPO}:mine.headers.Authorization}`);
    expect(existsSync(join(projectSkillsDir(ctx, REPO), "review", "SKILL.md"))).toBe(true);
    expect(st.projects![repo]!.managed.cursor!.mcp).toEqual(["mine"]);
    // Applying afterwards: Claude Code already has docs from .mcp.json, so its local scope doesn't repeat it.
    saveState(ctx, st);
    const plan = planApply(ctx, m, loadState(ctx), openSecretStore(ctx.storeDir), undefined, { projects: true });
    const claude = plan.changes.find((c) => c.kind === "file" && c.path === join(home, ".claude.json"));
    expect(claude?.kind === "file" && claude.summary).toEqual(["add mine"]);
  });
});

describe("agent account profiles (0b use)", () => {
  test("found ~/.claude-* folders and registered ones; a repo, the machine and the shell pick one", () => {
    write(join(home, ".claude-b", ".claude.json"), "{}");
    mkdirSync(join(home, ".claude-unused"), { recursive: true }); // never used: not a profile
    const work = join(home, "accounts", "work");
    mkdirSync(work, { recursive: true });
    mkdirSync(join(home, "code", "app"), { recursive: true });
    // As git reports it (macOS's temp folder is behind a symlink): what `0b use` records.
    const repo = realpathSync(join(home, "code", "app"));
    git(repo, "init", "-q");
    saveAgentProfiles(ctx, { profiles: { claude: { work } }, repos: [{ path: repo, tool: "claude", profile: "work" }], defaults: { claude: "b" } });
    expect(agentProfiles(ctx, "claude").map((p) => [p.name, p.dir])).toEqual([
      ["b", join(home, ".claude-b")],
      ["work", work],
    ]);
    // Registered folders get what ~/.claude gets even before Claude Code has used them.
    expect(extraClaudeDirs(ctx)).toEqual([join(home, ".claude-b"), work].sort());
    expect(agentProfileFor(ctx, "claude", repo, {})).toMatchObject({ name: "work", from: "repo" });
    expect(agentProfileFor(ctx, "claude", home, {})).toMatchObject({ name: "b", from: "global" });
    expect(agentProfileFor(ctx, "claude", repo, { CLAUDE_CONFIG_DIR: join(home, ".claude-b") })).toMatchObject({ name: "b", from: "shell" });
    expect(agentProfileEnv(ctx, repo, {})).toEqual({ CLAUDE_CONFIG_DIR: work });
    // The shell's own choice is kept: nothing to add.
    expect(agentProfileEnv(ctx, repo, { CLAUDE_CONFIG_DIR: "/elsewhere" })).toEqual({});
  });

  test("a second Codex home gets the MCP servers too", () => {
    write(join(home, ".codex-b", "config.toml"), 'model = "x"\n');
    const m: Manifest = { ...emptyManifest(), mcpServers: { linear: { transport: "http", url: "https://mcp.linear.app/mcp" } } };
    const plan = planApply(ctx, m, loadState(ctx), openSecretStore(ctx.storeDir));
    expect(plan.changes.find((c) => c.path === join(home, ".codex-b", "config.toml"))).toMatchObject({ label: "Codex (.codex-b)" });
    executePlan(ctx, plan);
    const b = read(join(home, ".codex-b", "config.toml"));
    expect(b).toStartWith('model = "x"');
    expect((parseToml(b) as any).mcp_servers.linear.url).toBe("https://mcp.linear.app/mcp");
  });
});
