import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { supervisorConfig } from "../src/agent/policy.ts";
import type { HostAnswerReply, HostEventsFrame, HostRequestReply } from "../src/agent/protocol.ts";
import { HostSupervisor, HostTaskClient, parseHostEvent, parseHostTask } from "../src/agent/supervisor.ts";
import { fakeHost } from "./fake-host.ts";

/**
 * The real `host-task` (~/.local/bin/host-task, Python) against what the daemon expects of it, so
 * the stand-in in fake-host.ts can't drift from it unnoticed. Only on the host, on request:
 *   ZEROBRIDGE_HOST_TASK_CONTRACT=1 bun test apps/cli/test/host-task-contract.test.ts
 * It runs the script read-only with HOST_TASK_DB pointing at a temp file: the real database is never
 * opened. herdr and openclaw are the stand-ins.
 */

const REAL = join(homedir(), ".local", "bin", "host-task");
const python = () => spawnSync("python3", ["--version"]).status === 0;
const enabled = process.env.ZEROBRIDGE_HOST_TASK_CONTRACT === "1" && process.platform !== "win32" && existsSync(REAL) && python();

const live: HostSupervisor[] = [];
afterEach(() => {
  for (const s of live.splice(0)) s.stop();
});

describe.skipIf(!enabled)("host-task contract (the real script, a temp database)", () => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "0b-host-contract-")));
  const env = { ...process.env, HOST_TASK_DB: join(base, "tasks.sqlite") };
  const fake = fakeHost(join(base, "fake"), { panes: [{ pane: "w1:p3", name: "t-001", status: "idle", seq: 0 }] });
  const real = new HostTaskClient(REAL, env);
  const cfg = supervisorConfig({ kind: "openclaw", agent: "lead", hostTask: REAL, openclaw: fake.bins.openclaw, herdr: fake.bins.herdr, pollMs: 50 })!;
  const make = (home: string) => {
    const s = new HostSupervisor({ home, storeDir: join(home, ".0bridge") }, cfg, { hostTaskEnv: env, answer: { replyMs: 4000, confirmMs: 1500, unconfirmedMs: 500 } });
    live.push(s);
    return s;
  };

  test("requests, questions, answers and the event log read the way the daemon parses them", async () => {
    expect(env.HOST_TASK_DB).not.toContain(".local/state");
    const s = make(join(base, "a"));
    const r = (await s.request({ op: "host.request", requestId: "hr_contract1", text: "Check the contract", title: "Contract", project: "0bridge", worker: "claude", priority: "P3" })) as HostRequestReply;
    expect(r.task).toMatchObject({ id: "T-001", title: "Contract", status: "requested", project: "0bridge", worker: "claude", priority: "P3", pendingQuestion: null });
    // A worker on the task, then a question it emits (herdr-watch's own path needs herdr itself).
    await real.run(["set", "T-001", "pane=w1:p3", "agent=t-001", "status=running"]);
    const q = (await real.emit("T-001", "question_required", "Which file?", "contract-q1")).event!;
    expect(q).toBeNumber();
    expect((await real.emit("T-001", "question_required", "Which file?", "contract-q1")).event).toBeNull();
    expect(parseHostTask(await real.show("T-001"))!.pendingQuestion).toBe(q);
    expect(await s.request({ op: "host.questions" })).toEqual({ questions: [{ question: q, task: "T-001", text: "Which file?", askedAt: expect.any(Number) }] });

    const a = (await s.request({ op: "host.answer", question: q, text: "main.ts" })) as HostAnswerReply;
    expect(a).toMatchObject({ status: "delivered", worker: "t-001", pane: "w1:p3", confirmation: { from: "idle", to: "working" } });
    // host-task's own rules, as another daemon (no state of its own) meets them.
    const other = make(join(base, "b"));
    expect(await other.request({ op: "host.answer", question: q, text: "other.ts" })).toMatchObject({ status: "refused", detail: expect.stringMatching(/already answered at .* with a different answer/) });
    const q2 = (await real.emit("T-001", "question_required", "Second?", "contract-q2")).event!;
    const q3 = (await real.emit("T-001", "question_required", "Third?", "contract-q3")).event!;
    expect(await other.request({ op: "host.answer", question: q2, text: "x" })).toMatchObject({ status: "refused", current: q3 });
    expect(await other.request({ op: "host.answer", question: 1, text: "x" })).toMatchObject({ status: "refused", detail: expect.stringMatching(/isn't a question/) });
    await expect(real.run(["set", "T-001", "status=completed"])).rejects.toThrow(/completed requires evidence/);
    await real.run(["set", "T-001", "status=completed", "evidence=contract test"]);

    // Every event the real script wrote parses, and the tail sends them to the hub.
    const page = await real.events(0, 1000);
    const parsed = page.events.map((e) => parseHostEvent(e));
    expect(parsed.every(Boolean)).toBe(true);
    const byKind = Object.fromEntries(parsed.map((e) => [e!.kind, e!]));
    // (lead's reply, supervisor_reply, may or may not be in yet.)
    expect(Object.keys(byKind).filter((k) => k !== "supervisor_reply").sort()).toEqual(["answer_delivered", "answer_pending", "dots_request", "question_required", "task_completed", "task_requested", "task_updated"].sort());
    expect(byKind.answer_pending).toMatchObject({ question: q, pane: "w1:p3", text: "main.ts" });
    expect(byKind.answer_delivered).toMatchObject({ question: q });
    expect(byKind.task_completed!.fields).toEqual({ status: "completed", evidence: "contract test" });
    const frames: HostEventsFrame[] = [];
    s.connected((f) => {
      frames.push(f as HostEventsFrame);
      return true;
    });
    s.onFrame({ t: "host-cursor", cursor: 0 });
    for (const end = Date.now() + 5000; !frames.length && Date.now() < end; ) await Bun.sleep(20);
    expect(frames[0]!.events.map((e) => e.id)).toEqual(page.events.map((e) => e.id));
    expect(frames[0]!.tasks.map((t) => [t.id, t.status])).toEqual([["T-001", "completed"]]);

    // The stand-in answers the same way to the same steps.
    const f = new HostTaskClient(fake.bins.hostTask);
    const keys = (o: object) => Object.keys(o).sort();
    const opts = { project: "0bridge", worker: "claude", priority: "P3" };
    expect(keys(await f.create("Same", opts))).toEqual(keys(await real.create("Same", opts)));
    expect(keys(await f.emit("T-001", "question_required", "Q?", "same-q"))).toEqual(keys(await real.emit("T-002", "question_required", "Q?", "same-q")));
    const [fe, re] = [(await f.events(0, 1000)).events.at(-1)!, (await real.events(0, 1000)).events.at(-1)!];
    expect([keys(fe), keys(fe.data!)]).toEqual([keys(re), keys(re.data!)]);
  }, 60_000);
});
