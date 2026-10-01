import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryLock, type Context } from "@0bridge/core";
import { dirtyDir, pendingMarks, runHook, takeMarks, transcriptOf, workerLockPath } from "../src/hook.ts";
import { sourcesOf } from "../src/history.ts";

const CLI = join(import.meta.dir, "..", "src", "index.ts");

let home: string;
let ctx: Context;
let env: Record<string, string>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "0bridge-hook-"));
  ctx = { home, storeDir: join(home, ".0bridge") };
  env = { ...(process.env as Record<string, string>), ZEROBRIDGE_USER_HOME: home, ZEROBRIDGE_DIR: ctx.storeDir, ZEROBRIDGE_SECRET_STORE: "file" };
  history(true);
});

/** `0b history on|off` as history.json says it. */
function history(enabled: boolean) {
  mkdirSync(ctx.storeDir, { recursive: true });
  writeFileSync(join(ctx.storeDir, "history.json"), JSON.stringify({ enabled }));
}
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** Run `0b hook <target>` the way an agent does: JSON on stdin, closed right after. */
async function hook(target: string, input: string) {
  const start = performance.now();
  const p = Bun.spawn([process.execPath, CLI, "hook", target], { env, stdin: new Blob([input]), stdout: "pipe", stderr: "pipe" });
  const code = await p.exited;
  return { code, ms: performance.now() - start, stdout: await new Response(p.stdout).text(), stderr: await new Response(p.stderr).text() };
}

describe("0b hook", () => {
  test("marks the conversation in well under 150 ms", () => {
    const release = tryLock(workerLockPath(ctx))!; // a worker is running: nothing is started from this test process
    const transcript = join(home, ".claude", "projects", "-x", "abc.jsonl");
    const start = performance.now();
    expect(runHook(ctx, ["claude"], JSON.stringify({ session_id: "abc", transcript_path: transcript, hook_event_name: "Stop" }))).toEqual({ history: false, status: false });
    expect(performance.now() - start).toBeLessThan(150);
    expect([...pendingMarks(ctx).values()]).toEqual([transcript]);
    release();
  });

  test("the CLI writes the mark, says nothing and exits 0", async () => {
    const release = tryLock(workerLockPath(ctx))!;
    const transcript = join(home, ".claude", "projects", "-x", "abc.jsonl");
    // The process as a whole (runtime start included) stays quick; CI machines get some slack, and
    // the fastest of up to three starts counts (a busy CI machine can stall any one for seconds).
    const budget = process.env.CI ? 1500 : 500;
    let fastest = Infinity;
    for (let i = 0; i < 3 && fastest >= budget; i++) {
      const r = await hook("claude", JSON.stringify({ transcript_path: transcript, hook_event_name: "Stop" }));
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe("");
      fastest = Math.min(fastest, r.ms);
    }
    release();
    expect(fastest).toBeLessThan(budget);
    expect([...pendingMarks(ctx).values()]).toEqual([transcript]);
  }, 30_000);

  test("no transcript (Cursor, Codex notify, bad input) marks everything; it still exits 0", async () => {
    const release = tryLock(workerLockPath(ctx))!;
    const r = await hook("cursor", "not json");
    release();
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect([...pendingMarks(ctx).values()]).toEqual(["*"]);
  }, 30_000);

  test("history off: nothing is marked and no worker starts", async () => {
    history(false);
    const r = await hook("claude", JSON.stringify({ transcript_path: join(home, ".claude", "projects", "-x", "a.jsonl"), hook_event_name: "Stop" }));
    expect(r.code).toBe(0);
    expect(pendingMarks(ctx).size).toBe(0);
    expect(existsSync(join(ctx.storeDir, "sync", "worker.log"))).toBe(false);
  }, 30_000);

  test("only a turn's end marks the conversation: a prompt or a permission request doesn't", () => {
    const release = tryLock(workerLockPath(ctx))!;
    const t = join(home, ".claude", "projects", "-x", "abc.jsonl");
    runHook(ctx, ["claude"], JSON.stringify({ session_id: "abc", transcript_path: t, hook_event_name: "UserPromptSubmit", prompt: "hi" }));
    runHook(ctx, ["claude"], JSON.stringify({ session_id: "abc", transcript_path: t, hook_event_name: "PermissionRequest", tool_name: "Bash" }));
    expect(pendingMarks(ctx).size).toBe(0);
    runHook(ctx, ["claude"], JSON.stringify({ session_id: "abc", transcript_path: t, hook_event_name: "SessionEnd" }));
    expect([...pendingMarks(ctx).values()]).toEqual([t]);
    release();
  });

  test("starts a worker when none runs, which takes the marks (the status worker; not signed in here, so it posts nothing)", async () => {
    history(false);
    writeFileSync(join(ctx.storeDir, "status.json"), JSON.stringify({ enabled: true }));
    const r = await hook("claude", JSON.stringify({ session_id: "a", transcript_path: join(home, ".claude", "projects", "-x", "a.jsonl"), hook_event_name: "UserPromptSubmit", prompt: "hi" }));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    const marks = join(ctx.storeDir, "status", "marks");
    const deadline = Date.now() + 20_000; // the worker is a new process: seconds on a busy CI machine
    while (readdirSync(marks).length && Date.now() < deadline) await Bun.sleep(50);
    expect(readdirSync(marks)).toEqual([]);
    expect(existsSync(join(ctx.storeDir, "status", "worker.log"))).toBe(true);
    // The worker let go of its lock on the way out.
    const lock = join(ctx.storeDir, "status", "worker.lock");
    for (let i = 0; i < 200 && existsSync(lock); i++) await Bun.sleep(50);
    expect(existsSync(lock)).toBe(false);
  }, 30_000);

  test("marks are taken once; the same file marked twice is one mark", () => {
    const release = tryLock(workerLockPath(ctx))!;
    runHook(ctx, ["claude"], JSON.stringify({ transcript_path: "/a/b.jsonl" }));
    runHook(ctx, ["claude"], JSON.stringify({ transcript_path: "/a/b.jsonl" }));
    runHook(ctx, ["codex"], JSON.stringify({ transcript_path: "/c/d.jsonl" }));
    release();
    expect(readdirSync(dirtyDir(ctx)).length).toBe(2);
    expect(takeMarks(ctx).sort()).toEqual(["/a/b.jsonl", "/c/d.jsonl"]);
    expect(takeMarks(ctx)).toEqual([]);
  });

  test("the transcript path comes from the hook JSON, and only an absolute one", () => {
    expect(transcriptOf(JSON.stringify({ transcript_path: "/x/y.jsonl" }))).toBe("/x/y.jsonl");
    expect(transcriptOf(JSON.stringify({ transcript_path: "y.jsonl" }))).toBeNull();
    expect(transcriptOf(JSON.stringify({ type: "agent-turn-complete", "thread-id": "t" }))).toBeNull();
    expect(transcriptOf("")).toBeNull();
  });

  test("marked files narrow the worker's upload to their sources; anything unknown scans them all", () => {
    expect(sourcesOf(ctx, [join(home, ".claude", "projects", "-x", "a.jsonl")])).toEqual(["claude-code"]);
    expect(sourcesOf(ctx, [join(home, ".codex", "sessions", "2026", "rollout-x.jsonl"), join(home, ".claude", "projects", "a.jsonl")])?.sort()).toEqual(["claude-code", "codex"]);
    expect(sourcesOf(ctx, ["/elsewhere/x.jsonl"])).toBeNull();
    expect(sourcesOf(ctx, undefined)).toBeNull();
  });
});
