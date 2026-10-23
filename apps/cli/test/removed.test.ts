/**
 * CLI 0.2.44 removed the clipboard and the vault's values: `0b update` and the background
 * job clear what an older 0b left on a machine. Against a temp home (no real service manager).
 *   bun test apps/cli/test/removed.test.ts
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyManifest, loadManifest, loadState, saveManifest, saveState, type Context } from "@0bridge/core";
import { cleanUpRemoved, cleanUpRemovedOnce } from "../src/removed.ts";

const SHIM = (name: string) => `#!/bin/sh\n# 0bridge: ⌃V pastes the image you last copied on your Mac (0b clip sync); the rest goes to the real ${name}.\nexec node 0b.js clip shim ${name} -- "$@"\n`;
const SECRETS = "---\nname: 0bridge-secrets\ndescription: Use when a command needs API keys…\n---\n\n# Secrets through 0bridge\n";

let home: string;
let ctx: Context;
let PATH: string | undefined;

const put = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "0b-removed-"));
  ctx = { home, storeDir: join(home, ".0bridge") };
  PATH = process.env.PATH;
});
afterEach(() => {
  process.env.PATH = PATH;
  rmSync(home, { recursive: true, force: true });
});

describe("what the removed features left behind", () => {
  test("clip jobs, the ⌃V stand-ins and receiver, and the 0bridge-secrets skill go; everything else stays", () => {
    const bin = join(ctx.storeDir, "bin");
    const local = join(home, ".local", "bin");
    const tools = join(home, "tools");
    process.env.PATH = [local, tools, PATH].join(":");
    // The stand-ins, in ~/.0bridge/bin and in a folder of the home on PATH; a real xclip next to them.
    put(join(bin, "xclip"), SHIM("xclip"));
    put(join(bin, "wl-paste"), SHIM("wl-paste"));
    put(join(local, "xclip"), SHIM("xclip"));
    put(join(tools, "xclip"), "#!/bin/sh\necho the real one\n");
    put(join(bin, "0bridge"), "#!/bin/sh\n");
    // The jobs, as each OS's service manager had them.
    const plist = join(home, "Library", "LaunchAgents", "dev.0bridge.clip.plist");
    const plistSync = join(home, "Library", "LaunchAgents", "dev.0bridge.clipsync.plist");
    const unit = join(home, ".config", "systemd", "user", "0bridge-clip.service");
    const wants = join(home, ".config", "systemd", "user", "default.target.wants", "0bridge-clip.service");
    const win = join(bin, "0bridge-clipsync.cmd");
    const agentUnit = join(home, ".config", "systemd", "user", "0bridge-agent.service");
    for (const f of [plist, plistSync, unit, wants, win, agentUnit]) put(f, "x");
    // The receiver's image and the logs.
    put(join(ctx.storeDir, "clip", "image"), "{}\n");
    put(join(ctx.storeDir, "clipsync.log"), "x");
    put(join(ctx.storeDir, "background.log"), "x");
    // The skill, in 0bridge's store and a tool; a skill of the user's beside it.
    put(join(ctx.storeDir, "skills", "0bridge-secrets", "SKILL.md"), SECRETS);
    put(join(home, ".claude", "skills", "0bridge-secrets", "SKILL.md"), SECRETS);
    put(join(home, ".claude", "skills", "mine", "SKILL.md"), "---\nname: mine\ndescription: x\n---\n");
    const m = emptyManifest();
    m.skills = { "0bridge": {}, "0bridge-secrets": {}, mine: {} };
    saveManifest(ctx, m);
    saveState(ctx, { managed: { claude: { mcp: [], skills: ["0bridge", "0bridge-secrets", "mine"] } } });

    const done = cleanUpRemoved(ctx);
    expect(done.join("\n")).toMatch(/stand-ins/);
    expect(done.join("\n")).toMatch(/receiver/);
    expect(done.join("\n")).toMatch(/0bridge-secrets/);
    expect(done.join("\n")).toMatch(/clip listen, 0b clip sync/);

    for (const f of [join(bin, "xclip"), join(bin, "wl-paste"), join(local, "xclip"), plist, plistSync, unit, wants, win, join(ctx.storeDir, "clip"), join(ctx.storeDir, "clipsync.log")]) expect([f, existsSync(f)]).toEqual([f, false]);
    for (const f of [join(tools, "xclip"), join(bin, "0bridge"), agentUnit, join(ctx.storeDir, "background.log"), join(home, ".claude", "skills", "mine", "SKILL.md")]) expect([f, existsSync(f)]).toEqual([f, true]);
    expect(readFileSync(join(tools, "xclip"), "utf8")).toContain("the real one");
    expect(existsSync(join(ctx.storeDir, "skills", "0bridge-secrets"))).toBe(false);
    expect(existsSync(join(home, ".claude", "skills", "0bridge-secrets"))).toBe(false);
    expect(Object.keys(loadManifest(ctx)!.skills).sort()).toEqual(["0bridge", "mine"]);
    expect(loadState(ctx).managed.claude!.skills).toEqual(["0bridge", "mine"]);

    // Nothing left: nothing to say.
    expect(cleanUpRemoved(ctx)).toEqual([]);
  });

  test("a folder named 0bridge-secrets that isn't 0bridge's skill is left alone", () => {
    put(join(home, ".claude", "skills", "0bridge-secrets", "SKILL.md"), "---\nname: my-own\ndescription: x\n---\n");
    cleanUpRemoved(ctx);
    expect(existsSync(join(home, ".claude", "skills", "0bridge-secrets", "SKILL.md"))).toBe(true);
  });

  test("the background job cleans up once per machine", () => {
    put(join(ctx.storeDir, "bin", "xclip"), SHIM("xclip"));
    expect(cleanUpRemovedOnce(ctx).length).toBe(1);
    put(join(ctx.storeDir, "bin", "xclip"), SHIM("xclip"));
    expect(cleanUpRemovedOnce(ctx)).toEqual([]);
    expect(existsSync(join(ctx.storeDir, "bin", "xclip"))).toBe(true);
  });
});
