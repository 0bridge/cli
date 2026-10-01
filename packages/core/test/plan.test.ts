import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupRel, executePlan, isInside, linkOrCopy, loadState, paths, restoreBackup, secretStoreKind, type Context, type FileChange } from "../src/index.ts";

process.env.ZEROBRIDGE_SECRET_STORE = "file";

// Platform parity (P3): what differs between macOS, Linux and Windows, as pure functions.

let home: string;
let ctx: Context;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "0bridge-plan-"));
  ctx = { home, storeDir: join(home, ".0bridge") };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("backups", () => {
  test("paths map into the backup folder, keeping the drive on Windows", () => {
    expect(backupRel("/home/me/.claude.json", "linux")).toBe("home/me/.claude.json");
    expect(backupRel("/Users/me/.codex/config.toml", "darwin")).toBe("Users/me/.codex/config.toml");
    expect(backupRel("C:\\Users\\me\\.claude.json", "win32")).toBe("C/Users/me/.claude.json");
    expect(backupRel("d:\\work\\.cursor\\mcp.json", "win32")).toBe("D/work/.cursor/mcp.json");
    expect(backupRel("\\\\server\\share\\x\\y.json", "win32")).toBe("UNC/server/share/x/y.json");
    // Two drives never share a copy.
    expect(backupRel("C:\\a.json", "win32")).not.toBe(backupRel("D:\\a.json", "win32"));
  });

  test("a change is backed up under that path and restored from it", () => {
    const file = join(home, ".claude", "settings.json");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(file, '{"a":1}\n');
    const change: FileChange = { kind: "file", tool: "claude", what: "hooks", path: file, before: '{"a":1}\n', after: '{"a":2}\n', viewBefore: "", viewAfter: "", summary: [], rerender: () => '{"a":2}\n' };
    const id = executePlan(ctx, { changes: [change], warnings: [], missing: [], state: loadState(ctx) });
    expect(readFileSync(file, "utf8")).toBe('{"a":2}\n');
    expect(existsSync(join(paths(ctx).backups, id, "files", backupRel(file)))).toBe(true);
    restoreBackup(ctx, id);
    expect(readFileSync(file, "utf8")).toBe('{"a":1}\n');
  });
});

describe("paths", () => {
  test("inside is by path, not by string prefix", () => {
    expect(isInside("/a/b", "/a/b")).toBe(true);
    expect(isInside("/a/b", "/a/b/c/d")).toBe(true);
    expect(isInside("/a/b", "/a/bc")).toBe(false);
    expect(isInside("/a/b", "/a")).toBe(false);
    expect(isInside("/a/b", "/a/b/../c")).toBe(false);
    expect(isInside("/a/b", "/a/b/..foo")).toBe(true);
  });

  test("links are symlinks off Windows", () => {
    writeFileSync(join(home, "target"), "x");
    const how = linkOrCopy(join(home, "target"), join(home, "link"));
    // Windows without Developer Mode can't make a file symlink: a copy then.
    expect(how).toBe(lstatSync(join(home, "link")).isSymbolicLink() ? "link" : "copy");
    if (process.platform !== "win32") expect(how).toBe("link");
    expect(readFileSync(join(home, "link"), "utf8")).toBe("x");
  });
});

describe("secret store per OS", () => {
  const PATH_WITH = (dir: string) => ({ PATH: dir });
  test("macOS keychain, Windows DPAPI; ZEROBRIDGE_SECRET_STORE wins", () => {
    expect(secretStoreKind("darwin", {})).toBe("keychain");
    expect(secretStoreKind("win32", {})).toBe("dpapi");
    expect(secretStoreKind("darwin", { ZEROBRIDGE_SECRET_STORE: "file" })).toBe("file");
    expect(secretStoreKind("win32", { ZEROBRIDGE_SECRET_STORE: "file" })).toBe("file");
    expect(secretStoreKind("linux", { ZEROBRIDGE_SECRET_STORE: "libsecret" })).toBe("libsecret");
  });

  test("Linux: secret-tool when it's installed and a session bus is there, else the file", () => {
    const bin = join(home, "bin");
    mkdirSync(bin);
    expect(secretStoreKind("linux", { ...PATH_WITH(bin), DBUS_SESSION_BUS_ADDRESS: "unix:path=/x" })).toBe("file");
    writeFileSync(join(bin, "secret-tool"), "#!/bin/sh\n");
    expect(secretStoreKind("linux", { ...PATH_WITH(bin), DBUS_SESSION_BUS_ADDRESS: "unix:path=/x" })).toBe("libsecret");
    expect(secretStoreKind("linux", { ...PATH_WITH(bin), XDG_RUNTIME_DIR: join(home, "no-bus") })).toBe("file");
  });
});
