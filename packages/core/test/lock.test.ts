import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryLock, withLock } from "../src/lock.ts";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "0bridge-lock-"));
  path = join(dir, "sync", "worker.lock");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("lock", () => {
  test("one holder at a time; released, it can be taken again", () => {
    const release = tryLock(path);
    expect(release).not.toBeNull();
    expect(readFileSync(path, "utf8").split("\n")[0]).toBe(String(process.pid));
    expect(tryLock(path)).toBeNull();
    release!();
    expect(existsSync(path)).toBe(false);
    const again = tryLock(path);
    expect(again).not.toBeNull();
    again!();
  });

  test("another process holding it keeps us out until it exits", async () => {
    const script = `import { tryLock } from ${JSON.stringify(join(import.meta.dir, "../src/lock.ts"))};
const release = tryLock(${JSON.stringify(path)});
console.log(release ? "held" : "busy");
await new Promise((r) => setTimeout(r, 600));
release?.();`;
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe" });
    const reader = child.stdout.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first.trim()).toBe("held");
    expect(tryLock(path)).toBeNull();
    expect(await withLock(path, async () => "ran")).toBeNull();
    await child.exited;
    expect(await withLock(path, async () => "ran")).toBe("ran");
    expect(existsSync(path)).toBe(false);
  });

  test("a lock whose process is gone is taken over", () => {
    const dead = Bun.spawnSync([process.execPath, "-e", "console.log(process.pid)"]).stdout.toString().trim();
    rmSync(path, { force: true });
    mkdirSync(join(dir, "sync"), { recursive: true });
    writeFileSync(path, `${dead}\n${Date.now()}\n`);
    const release = tryLock(path);
    expect(release).not.toBeNull();
    expect(readFileSync(path, "utf8").split("\n")[0]).toBe(String(process.pid));
    release!();
  });

  test("a lock untouched for over 10 minutes is taken over even if its pid lives", () => {
    mkdirSync(join(dir, "sync"), { recursive: true });
    writeFileSync(path, `${process.ppid}\n${Date.now() - 11 * 60_000}\n`);
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(path, old, old);
    const release = tryLock(path);
    expect(release).not.toBeNull();
    release!();
  });

  test("a fresh lock held by a live process is not taken over", () => {
    mkdirSync(join(dir, "sync"), { recursive: true });
    writeFileSync(path, `${process.ppid}\n${Date.now()}\n`);
    expect(tryLock(path)).toBeNull();
  });

  test("releasing a lock someone took over from us leaves theirs alone", () => {
    const release = tryLock(path)!;
    writeFileSync(path, `${process.ppid}\n${Date.now()}\n`);
    release();
    expect(existsSync(path)).toBe(true);
  });

  test("withLock releases when the work throws", async () => {
    await expect(withLock(path, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(existsSync(path)).toBe(false);
  });
});
