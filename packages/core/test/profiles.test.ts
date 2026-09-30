import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfiles, normalizeRemote, profileEnv, profileFor, refreshOverlay, saveProfiles } from "../src/profiles.ts";

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "0b-prof-"));
  mkdirSync(join(home, ".config", "gh"), { recursive: true });
  mkdirSync(join(home, ".config", "git"), { recursive: true });
  return { home, storeDir: join(home, ".0bridge") };
}

describe("profiles", () => {
  test("remotes normalize across URL forms", () => {
    for (const u of ["git@github.com:Acme/App.git", "https://github.com/acme/app", "ssh://git@github.com/acme/app.git", "https://github.com/acme/app.git/"])
      expect(normalizeRemote(u)).toBe("github.com/acme/app");
  });

  test("overlay links everything but the CLIs the profile owns", () => {
    const ctx = sandbox();
    const dir = refreshOverlay(ctx, "work", ["wrangler"]);
    expect(lstatSync(join(dir, "gh")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dir, "git"))).toBe(join(ctx.home, ".config", "git"));
    expect(existsSync(join(dir, ".wrangler"))).toBe(false);
    // Owning gh later replaces its link with the profile's own folder on the next login.
    refreshOverlay(ctx, "work", ["wrangler", "gh"]);
    expect(existsSync(join(dir, "gh"))).toBe(false);
  });

  test("a repo resolves by checkout path, then by remote", () => {
    const ctx = sandbox();
    const repo = join(ctx.home, "src", "app");
    mkdirSync(repo, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: repo });
    spawnSync("git", ["remote", "add", "origin", "git@github.com:acme/app.git"], { cwd: repo });
    const clone = join(ctx.home, "src", "app-2");
    mkdirSync(clone, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: clone });
    spawnSync("git", ["remote", "add", "origin", "https://github.com/acme/app"], { cwd: clone });
    const other = join(ctx.home, "src", "other");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "x"), "");

    const cfg = loadProfiles(ctx);
    cfg.profiles.work = { clis: ["wrangler"] };
    cfg.repos.push({ path: spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo, encoding: "utf8" }).stdout.trim(), remote: "github.com/acme/app", profile: "work" });
    saveProfiles(ctx, cfg);

    expect(profileFor(ctx, join(repo))).toBe("work");
    expect(profileFor(ctx, clone)).toBe("work");
    expect(profileFor(ctx, other)).toBeNull();
    const { env } = profileEnv(ctx, repo);
    expect(env.XDG_CONFIG_HOME).toBe(join(ctx.storeDir, "profiles", "work"));
    expect(env.GH_CONFIG_DIR).toBe(join(ctx.storeDir, "profiles", "work", "gh"));
  });
});
