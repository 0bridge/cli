/**
 * The webhook runner (src/webhook-run.ts) with real child processes: fake binaries (fake-bin.ts,
 * a .cmd shim on Windows) that write down what they got, a temp home, and a fake socket for
 * `runListener`.
 *   bun test apps/cli/test/webhook-run.test.ts
 * The event's JSON on stdin and its plain values in the environment, never in arguments or a shell;
 * exit status, timeouts (the process is ended), one run at a time per webhook, debounce folding
 * events into one run with the newest, the journal answering an event it already ran (also after a
 * restart), commands found on PATH (Windows .cmd shims) and relative to their folder, the hello's
 * hooks, and the listener's connection (hello, run, ack, result; 4002 stops it; one per machine).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { deviceTokenKey, openSecretStore, saveCloud, type Context } from "@0bridge/core";
import { fakeBin } from "./fake-bin.ts";
import { Runner, execRun, journalPath, logPath, runEnv, runListener, saveRuns, type LocalRun, type RunEvent } from "../src/webhook-run.ts";

process.env.ZEROBRIDGE_SECRET_STORE = "file";

const SERVER = "http://localhost:1";
let ctx: Context;
let dir: string;
let frames: Record<string, unknown>[];
const realPath = process.env.PATH;

/** Writes what it got (stdin, ZEROBRIDGE_* env, args, cwd) to <out dir>/<event id or "run">.json, and appends start/end lines to order.log. */
const RECORDER = `
const fs = require("node:fs"), path = require("node:path");
const input = fs.readFileSync(0, "utf8");
const out = process.argv[2];
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("ZEROBRIDGE_")));
const id = env.ZEROBRIDGE_EVENT_ID || "run";
fs.appendFileSync(path.join(out, "order.log"), "start " + id + "\\n");
const wait = Number(process.env.FAKE_WAIT_MS || 0);
setTimeout(() => {
  fs.writeFileSync(path.join(out, id + ".json"), JSON.stringify({ input, env, argv: process.argv.slice(3), cwd: process.cwd() }));
  fs.appendFileSync(path.join(out, "order.log"), "end " + id + "\\n");
  console.log("ran " + id);
  process.exit(Number(process.env.FAKE_EXIT || 0));
}, wait);
`;

let recorder: string;
const ev = (n: number, extra: Partial<RunEvent> = {}): RunEvent => ({
  id: `ev_${String(n).padStart(16, "0")}`,
  eventId: `m-${n}`,
  hook: "ct",
  type: "Message.push",
  receivedAt: 1_790_000_000_000 + n,
  data: { entity: { plainText: `hello ${n}` } },
  ...extra,
});
const job = (e: RunEvent, attempt = 1) => ({ t: "run", id: e.id, attempt, event: e });
const recorded = (e: RunEvent) => JSON.parse(readFileSync(join(dir, `${e.id}.json`), "utf8")) as { input: string; env: Record<string, string>; argv: string[]; cwd: string };
const order = () => (existsSync(join(dir, "order.log")) ? readFileSync(join(dir, "order.log"), "utf8").trim().split("\n") : []);
const results = () => frames.filter((f) => f.t === "result");

function setRun(run: Partial<LocalRun> & { argv: string[] }, hook = "ct", userId = "user1") {
  saveRuns(ctx, { v: 1, server: SERVER, userId, runs: { [hook]: { cwd: dir, timeoutSec: 30, debounceSec: 0, addedAt: 0, ...run } } });
}

function runner(o: { sleep?: (ms: number) => Promise<void> } = {}) {
  return new Runner({ ctx, send: (f) => (frames.push(f as Record<string, unknown>), true), log: () => {}, machine: "testbox", sleep: o.sleep, killGraceMs: 500 });
}

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "0b-webhook-run-"));
  ctx = { home, storeDir: join(home, ".0bridge") };
  const acct = saveCloud(ctx, { server: SERVER, userId: "user1", login: "me", email: "me@example.com", tokenId: "t1" });
  openSecretStore(ctx.storeDir).set(deviceTokenKey(acct), "0b_device_token");
  dir = join(home, "work");
  mkdirSync(dir, { recursive: true });
  const bins = join(home, "bin");
  mkdirSync(bins);
  recorder = fakeBin(bins, "recorder", RECORDER);
  frames = [];
});
afterEach(() => {
  process.env.PATH = realPath;
  delete process.env.FAKE_WAIT_MS;
  delete process.env.FAKE_EXIT;
});

describe("one run", () => {
  test("the event's JSON on stdin, its plain values in the environment; arguments as saved, no shell", async () => {
    setRun({ argv: [recorder, dir, "$(touch pwned)", "; touch pwned2", "`id`"] });
    const e = ev(1, { data: { text: "$(touch pwned3); `touch pwned4` && rm -rf ~", quote: "'\"" }, type: "Message.push" });
    const r = runner();
    r.onFrame(job(e));
    await r.idle();
    const got = recorded(e);
    expect(JSON.parse(got.input)).toEqual({ id: e.id, eventId: "m-1", hook: "ct", type: "Message.push", receivedAt: e.receivedAt, verified: true, data: e.data });
    expect(got.env).toMatchObject({
      ZEROBRIDGE_EVENT_ID: e.id,
      ZEROBRIDGE_EVENT_SENDER_ID: "m-1",
      ZEROBRIDGE_EVENT_TYPE: "Message.push",
      ZEROBRIDGE_HOOK: "ct",
      ZEROBRIDGE_EVENT_RECEIVED_AT: String(e.receivedAt),
      ZEROBRIDGE_EVENT_COUNT: "1",
    });
    expect(got.argv).toEqual(["$(touch pwned)", "; touch pwned2", "`id`"]);
    for (const f of ["pwned", "pwned2", "pwned3", "pwned4"]) expect(existsSync(join(dir, f))).toBe(false);
    expect(frames).toEqual([
      { t: "ack", id: e.id },
      { t: "result", id: e.id, ok: true, exit: 0, signal: null, ms: expect.any(Number) },
    ]);
    // Output goes to the hook's log, not to the gateway.
    expect(readFileSync(logPath(ctx, "ct"), "utf8")).toContain(`ran ${e.id}`);
    expect(JSON.stringify(frames)).not.toContain("ran ev_");
  });

  test("values that aren't plain names stay out of the environment, and the runner's own ZEROBRIDGE_EVENT_* don't leak in", () => {
    const env = runEnv(ev(1, { eventId: "a b; c", type: "x".repeat(200) }), 3, { PATH: "/bin", ZEROBRIDGE_EVENT_TYPE: "stale", ZEROBRIDGE_HOOK: "stale" });
    expect(env).toEqual({ PATH: "/bin", ZEROBRIDGE_EVENT_ID: ev(1).id, ZEROBRIDGE_HOOK: "ct", ZEROBRIDGE_EVENT_RECEIVED_AT: String(ev(1).receivedAt), ZEROBRIDGE_EVENT_COUNT: "3" });
  });

  test("a failing exit status, a missing command, a missing folder", async () => {
    process.env.FAKE_EXIT = "3";
    setRun({ argv: [recorder, dir] });
    const r = runner();
    r.onFrame(job(ev(1)));
    await r.idle();
    expect(results()[0]).toMatchObject({ ok: false, exit: 3 });
    const run = (argv: string[], cwd = dir) => execRun({ argv, cwd, timeoutSec: 5, debounceSec: 0, addedAt: 0 }, ev(2), { count: 1, log: logPath(ctx, "ct") });
    expect(await run(["definitely-not-a-command-0bridge"])).toMatchObject({ ok: false, exit: null, detail: "the command wasn't found" });
    expect(await run([recorder, dir], join(dir, "gone"))).toMatchObject({ ok: false, detail: "its folder doesn't exist any more" });
  });

  test("a command that runs past its timeout is ended, and says so", async () => {
    process.env.FAKE_WAIT_MS = "20000";
    const started = Date.now();
    const r = await execRun({ argv: [recorder, dir], cwd: dir, timeoutSec: 1, debounceSec: 0, addedAt: 0 }, ev(1), { count: 1, log: logPath(ctx, "ct"), killGraceMs: 500 });
    expect(r).toMatchObject({ ok: false, detail: "timed out after 1 s" });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(existsSync(join(dir, `${ev(1).id}.json`))).toBe(false);
  }, 15_000);

  test.if(process.platform !== "win32")("past its timeout, what the command started ends too (its process group)", async () => {
    const out = join(dir, "grandchild.txt");
    const parent = fakeBin(
      join(ctx.home, "bin"),
      "parent",
      `
const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'still here'), 2500)", process.argv[2]], { stdio: "ignore" });
setTimeout(() => {}, 20000);
`,
    );
    const r = await execRun({ argv: [parent, out], cwd: dir, timeoutSec: 1, debounceSec: 0, addedAt: 0 }, ev(1), { count: 1, log: logPath(ctx, "ct"), killGraceMs: 300 });
    expect(r).toMatchObject({ ok: false, detail: "timed out after 1 s" });
    await new Promise((done) => setTimeout(done, 2500));
    expect(existsSync(out)).toBe(false);
  }, 15_000);

  test("commands on PATH (a .cmd shim on Windows) and paths relative to the command's folder", async () => {
    process.env.PATH = `${dirname(recorder)}${delimiter}${realPath}`;
    const r1 = await execRun({ argv: ["recorder", dir], cwd: dir, timeoutSec: 10, debounceSec: 0, addedAt: 0 }, ev(1), { count: 1, log: logPath(ctx, "ct") });
    expect(r1).toMatchObject({ ok: true, exit: 0 });
    // Its own folder (compared by name: macOS's /var is /private/var, Windows may shorten the temp path).
    expect(basename(recorded(ev(1)).cwd)).toBe("work");
    const local = join(dir, "bin");
    mkdirSync(local);
    const own = fakeBin(local, "own", RECORDER);
    const r2 = await execRun({ argv: [`./bin/${basename(own)}`, dir], cwd: dir, timeoutSec: 10, debounceSec: 0, addedAt: 0 }, ev(2), { count: 1, log: logPath(ctx, "ct") });
    expect(r2).toMatchObject({ ok: true, exit: 0 });
  });
});

describe("the runner", () => {
  test("one run at a time per webhook, in order", async () => {
    process.env.FAKE_WAIT_MS = "150";
    setRun({ argv: [recorder, dir] });
    const r = runner();
    for (const n of [1, 2, 3]) r.onFrame(job(ev(n)));
    await r.idle();
    expect(order()).toEqual([1, 2, 3].flatMap((n) => [`start ${ev(n).id}`, `end ${ev(n).id}`]));
    expect(results().map((f) => [f.id, f.ok])).toEqual([1, 2, 3].map((n) => [ev(n).id, true]));
  });

  test("debounce: events that arrive while it waits run once, with the newest; the others say they were folded into it", async () => {
    setRun({ argv: [recorder, dir], debounceSec: 30 });
    let release!: () => void;
    const waited: number[] = [];
    const r = runner({
      sleep: (ms) => {
        waited.push(ms);
        return new Promise<void>((res) => (release = res));
      },
    });
    r.onFrame(job(ev(1)));
    await Bun.sleep(10);
    r.onFrame(job(ev(3)));
    r.onFrame(job(ev(2)));
    release();
    await r.idle();
    expect(waited).toEqual([30_000]);
    expect(order()).toEqual([`start ${ev(3).id}`, `end ${ev(3).id}`]);
    expect(recorded(ev(3)).env.ZEROBRIDGE_EVENT_COUNT).toBe("3");
    expect(frames.filter((f) => f.t === "ack").map((f) => f.id)).toEqual([ev(1).id, ev(3).id, ev(2).id]);
    const res = Object.fromEntries(results().map((f) => [f.id as string, f]));
    expect(res[ev(3).id]).toMatchObject({ ok: true, exit: 0 });
    expect(res[ev(3).id]!.coalescedInto).toBeUndefined();
    expect(res[ev(1).id]).toMatchObject({ ok: true, coalescedInto: ev(3).id });
    expect(res[ev(2).id]).toMatchObject({ ok: true, coalescedInto: ev(3).id });
  });

  test("at least once, never twice here: an event it ran is answered from the journal (also after a restart); one it holds is acked again, not run again", async () => {
    process.env.FAKE_WAIT_MS = "200";
    setRun({ argv: [recorder, dir] });
    const r = runner();
    r.onFrame(job(ev(1)));
    await Bun.sleep(50);
    r.onFrame(job(ev(1), 2));
    await r.idle();
    expect(order()).toEqual([`start ${ev(1).id}`, `end ${ev(1).id}`]);
    expect(frames.map((f) => f.t)).toEqual(["ack", "ack", "result"]);
    // Sent again (the gateway never heard the result): replayed, not run.
    r.onFrame(job(ev(1), 3));
    await r.idle();
    expect(order()).toHaveLength(2);
    expect(results()).toHaveLength(2);
    expect(results()[1]).toEqual(results()[0]!);
    // A new runner process reads the journal.
    frames = [];
    const again = runner();
    again.onFrame(job(ev(1), 4));
    await again.idle();
    expect(order()).toHaveLength(2);
    expect(frames).toEqual([expect.objectContaining({ t: "result", id: ev(1).id, ok: true, exit: 0 })]);
    expect(JSON.parse(readFileSync(journalPath(ctx), "utf8")).results).toHaveLength(1);
  });

  test("a run cut short by stopping isn't journaled, so the gateway's redelivery runs it", async () => {
    process.env.FAKE_WAIT_MS = "20000";
    setRun({ argv: [recorder, dir] });
    const r = runner();
    r.onFrame(job(ev(1)));
    await Bun.sleep(300);
    await r.shutdown();
    expect(results()).toHaveLength(0);
    expect(existsSync(journalPath(ctx))).toBe(false);
  }, 15_000);

  test("no command for the webhook here any more: a failed result, nothing run", async () => {
    setRun({ argv: [recorder, dir] }, "other");
    const r = runner();
    r.onFrame(job(ev(1)));
    await r.idle();
    expect(results()[0]).toMatchObject({ ok: false, exit: null, detail: "no command for ct on this machine any more" });
    expect(order()).toEqual([]);
  });

  test("hello: the hooks with commands for this account (names and the two numbers only); a file for another account counts as none", () => {
    setRun({ argv: [recorder, dir, "--secret-flag"], timeoutSec: 99_999, debounceSec: 30 });
    const h = runner().hello();
    expect(h).toMatchObject({ t: "hello", v: 1, machine: { name: "testbox" }, hooks: [{ name: "ct", timeoutSec: 3600, debounceSec: 30 }] });
    expect(JSON.stringify(h)).not.toContain("secret-flag");
    expect(JSON.stringify(h)).not.toContain(dir.replace(/\\/g, "\\\\"));
    setRun({ argv: ["x"] }, "ct", "someone-else");
    expect(runner().hello().hooks).toEqual([]);
  });
});

/** A WebSocket stand-in for connectLoop: opens at once, records what's sent, closes on demand. */
class FakeWs {
  static all: FakeWs[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(
    public url: string,
    public token: string,
  ) {
    FakeWs.all.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  receive(frame: object) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  close(code = 1000, reason = "") {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

describe("the listener", () => {
  beforeEach(() => {
    FakeWs.all = [];
  });

  test("connects with the device token, says hello, runs what comes, reports it; one listener per machine; 4002 stops it", async () => {
    setRun({ argv: [recorder, dir] });
    const stop = new AbortController();
    const lines: string[] = [];
    const listening = runListener(ctx, { open: (u, t) => new FakeWs(u, t) as unknown as WebSocket, log: (l) => lines.push(l), signal: stop.signal, minDelay: 10 });
    await Bun.sleep(20);
    const ws = FakeWs.all[0]!;
    expect(ws.url).toBe("ws://localhost:1/api/triggers/runner");
    expect(ws.token).toBe("0b_device_token");
    expect(ws.sent[0]).toMatchObject({ t: "hello", hooks: [{ name: "ct", timeoutSec: 30, debounceSec: 0 }] });
    await expect(runListener(ctx, { open: (u, t) => new FakeWs(u, t) as unknown as WebSocket, log: () => {} })).rejects.toThrow("already running here");

    ws.receive({ t: "welcome", v: 1, hooks: [{ name: "ct", routed: true, machine: null }], unknown: ["old"] });
    expect(lines.some((l) => l.includes("old: there's no webhook with this name"))).toBe(true);
    ws.receive(job(ev(1)));
    for (let i = 0; i < 100 && !ws.sent.some((f) => f.t === "result"); i++) await Bun.sleep(20);
    expect(ws.sent.slice(1).map((f) => f.t)).toEqual(["ack", "result"]);
    expect(ws.sent.at(-1)).toMatchObject({ t: "result", id: ev(1).id, ok: true, exit: 0 });

    // A newer runner with this machine's token took over: this one stops instead of fighting it.
    ws.close(4002, "another connection from this machine took over");
    await listening;
    expect(lines.at(-1)).toContain("another runner with this machine's sign-in connected");
    expect(FakeWs.all).toHaveLength(1);
    // Its lock went with it.
    const again = runListener(ctx, { open: (u, t) => new FakeWs(u, t) as unknown as WebSocket, log: () => {}, signal: stop.signal, minDelay: 10 });
    await Bun.sleep(20);
    stop.abort();
    await again;
  });

  test("reconnects after a drop and says hello again", async () => {
    setRun({ argv: [recorder, dir] });
    const stop = new AbortController();
    const listening = runListener(ctx, { open: (u, t) => new FakeWs(u, t) as unknown as WebSocket, log: () => {}, signal: stop.signal, minDelay: 10 });
    await Bun.sleep(20);
    FakeWs.all[0]!.close(1006);
    for (let i = 0; i < 50 && FakeWs.all.length < 2; i++) await Bun.sleep(10);
    await Bun.sleep(10);
    expect(FakeWs.all[1]!.sent[0]).toMatchObject({ t: "hello" });
    stop.abort();
    await listening;
  });
});

test("a journal that isn't there yet, and a webhooks file written by hand, don't break the runner", () => {
  writeFileSync(join(ctx.storeDir, "webhooks.json"), "{not json");
  expect(runner().hello().hooks).toEqual([]);
});
