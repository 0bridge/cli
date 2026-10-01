import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clampMode, commandParts, DEFAULT_DENY, deniedBy, loadAgentConfig, matchGlob, profileEnv, repoFor, saveAgentConfig, tooBroad, type AgentConfig } from "../src/agent/policy.ts";

const denied = (cmd: string) => deniedBy(DEFAULT_DENY, cmd);

describe("agent policy: refused commands", () => {
  test("push to main or master, in any spelling", () => {
    for (const cmd of [
      "git push origin main",
      "git push -u origin main",
      "git push origin master --follow-tags",
      "git push origin HEAD:main",
      "git -C /work/app push origin main",
      "git --no-pager push upstream master",
      "cd web && git push origin main",
      "npm test; git push origin main",
      "FOO=1 git push origin main",
      "sudo git push origin main",
      "bash -c 'git push origin main'",
      'sh -c "npm test && git push origin master"',
      "echo $(git push origin main)",
      "/usr/bin/git push origin main",
      "git push 'origin' \"main\"",
      "git push origin refs/heads/main",
      "git push origin HEAD:refs/heads/main",
      "GIT_DIR=x git push origin refs/heads/main",
      "git push origin :main",
      "eval 'git push origin main'",
      "git push --mirror origin",
      "git push origin --all",
    ])
      expect(denied(cmd)).not.toBeNull();
  });

  test("a push that names no branch pushes HEAD: the task's own branch when known, refused otherwise", () => {
    for (const cmd of ["git push", "git push origin", "git push -u origin HEAD"]) {
      expect(denied(cmd)).toBe("git push * HEAD");
      expect(deniedBy(DEFAULT_DENY, cmd, "0b/t_abc123")).toBeNull();
      expect(deniedBy(DEFAULT_DENY, cmd, "main")).not.toBeNull();
    }
  });

  test("force push, merge, deploy and publish", () => {
    for (const cmd of [
      "git push --force",
      "git push --force-with-lease origin feature",
      "git push -f origin feature",
      "git push origin feature --force",
      "git push origin +feature",
      "git merge main",
      "gh pr merge 12 --squash",
      "wrangler deploy",
      "npx wrangler deploy --env production",
      "bunx wrangler deploy",
      "bunx wrangler@latest deploy",
      "npx @cloudflare/wrangler@3 deploy",
      "gh api -X PUT repos/o/r/pulls/1/merge",
      "0b exec -- wrangler deploy",
      "vercel --prod",
      "fly deploy",
      "npm publish --access public",
      "pnpm publish",
      "bun run deploy",
      "rm -rf /",
      "rm -rf /home",
      "rm -rf ~",
    ])
      expect(denied(cmd)).not.toBeNull();
  });

  test("ordinary work is not refused", () => {
    for (const cmd of [
      "git push origin 0b/t_abc123",
      "git push -u origin feature/main-menu",
      "git push origin HEAD:feature",
      "git push -o ci.skip origin feature",
      "git status",
      "git commit -m 'merge main into notes'",
      "npm test",
      "bun run build",
      "wrangler dev",
      "rm -rf node_modules",
      "rm -rf ./dist /tmp/build/out",
      "echo 'git push origin main'",
      "grep -r 'npm publish' docs",
    ])
      expect(denied(cmd)).toBeNull();
  });

  test("globs: * is any text, a rule matches with more arguments, a * after / stays in one segment", () => {
    expect(matchGlob("git push * main", ["git", "push", "origin", "main"])).toBe(true);
    expect(matchGlob("git push * main", "git push origin main --dry-run")).toBe(true);
    expect(matchGlob("git push * main", "git push origin mainline")).toBe(false);
    expect(matchGlob("rm -rf /*", "rm -rf /etc")).toBe(true);
    expect(matchGlob("rm -rf /*", "rm -rf /tmp/x")).toBe(false);
    expect(matchGlob("terraform apply*", "terraform apply -auto-approve")).toBe(true);
  });

  test("a repo's own rules add to the defaults", () => {
    expect(deniedBy([...DEFAULT_DENY, "terraform apply*"], "cd infra && terraform apply")).toBe("terraform apply*");
  });

  test("commands split at operators and quotes are removed", () => {
    expect(commandParts(`a "b c" && d 'e;f' | g; h`)).toEqual([["a", "b c"], ["d", "e;f"], ["g"], ["h"]]);
    expect(commandParts("env A=1 npx -y wrangler deploy")).toEqual([["wrangler", "deploy"]]);
  });
});

describe("agent policy: repos and modes", () => {
  const base = mkdtempSync(join(tmpdir(), "0b-agent-policy-"));
  const repo = join(base, "work", "app");
  mkdirSync(join(repo, "web"), { recursive: true });
  const cfg: AgentConfig = { enabled: true, repos: [{ root: repo, mode: "edit", worktree: true, deny: [] }] };

  test("only inside an allowed repo", () => {
    expect(repoFor(cfg, repo)?.root).toBe(repo);
    expect(repoFor(cfg, join(repo, "web"))?.root).toBe(repo);
    expect(repoFor(cfg, join(base, "work"))).toBeNull();
    expect(repoFor(cfg, `${repo}-evil`)).toBeNull();
    expect(repoFor(cfg, join(repo, "..", "other"))).toBeNull();
  });

  test("a request never gets more than the repo's mode", () => {
    expect(clampMode("auto", "edit")).toBe("edit");
    expect(clampMode("edit", "plan")).toBe("plan");
    expect(clampMode("plan", "auto")).toBe("plan");
    expect(clampMode(undefined, "edit")).toBe("edit");
    expect(clampMode("yolo", "plan")).toBe("plan");
  });

  test("home, a parent of it, and 0bridge's folder can't be allowed", () => {
    const ctx = { home: join(base, "home"), storeDir: join(base, "home", ".0bridge") };
    mkdirSync(ctx.storeDir, { recursive: true });
    expect(tooBroad(ctx, ctx.home)).not.toBeNull();
    expect(tooBroad(ctx, base)).not.toBeNull();
    expect(tooBroad(ctx, "/")).not.toBeNull();
    expect(tooBroad(ctx, ctx.storeDir)).not.toBeNull();
    expect(tooBroad(ctx, repo)).toBeNull();
  });

  test("agent.json: off and empty by default; profiles by name only", () => {
    const ctx = { home: base, storeDir: join(base, "store") };
    expect(loadAgentConfig(ctx)).toEqual({ enabled: false, repos: [] });
    saveAgentConfig(ctx, { ...cfg, profiles: { claude: { work: { CLAUDE_CONFIG_DIR: "/x/.claude-work" } } } });
    const back = loadAgentConfig(ctx);
    expect(back.repos[0]).toMatchObject({ root: repo, mode: "edit", worktree: true });
    expect(profileEnv(back, "claude", "work")).toEqual({ CLAUDE_CONFIG_DIR: "/x/.claude-work" });
    expect(profileEnv(back, "claude", undefined)).toEqual({});
    expect(() => profileEnv(back, "codex", "work")).toThrow();
    writeFileSync(join(ctx.storeDir, "agent.json"), JSON.stringify({ enabled: true, repos: [{ root: repo, mode: "bogus" }] }));
    expect(loadAgentConfig(ctx).repos[0]).toMatchObject({ mode: "edit", worktree: true, deny: [] });
  });
});
