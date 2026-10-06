import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostEventsFrame, HostRequestReply } from "../src/agent/protocol.ts";
import { supervisorConfig } from "../src/agent/policy.ts";
import { HostSupervisor, contextBackoff, openclawArgs, parseHostEvent, parseHostTask, pendingKind, readSupervisorState, replyText, sessionKey, supervisorStatePath, type ContextRecord, type CrashStep, type SupervisorOptions } from "../src/agent/supervisor.ts";
import { fakeHost, type FakeHost } from "./fake-host.ts";

/** A supervisor over the stand-in host tools, in a temp home, with a fake hub that records frames. */
const live: HostSupervisor[] = [];
afterEach(() => {
  for (const s of live.splice(0)) s.stop();
});

function setup(o: { maxDispatch?: number; openclaw?: { sleepMs?: number; fail?: Record<string, number> }; opts?: SupervisorOptions } = {}) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "0b-host-sup-")));
  const ctx = { home: join(base, "home"), storeDir: join(base, "home", ".0bridge") };
  const host = fakeHost(join(base, "host"), { openclaw: o.openclaw });
  const cfg = supervisorConfig({ kind: "openclaw", agent: "lead", label: "dev-herdr-agent", hostTask: host.bins.hostTask, openclaw: host.bins.openclaw, herdr: host.bins.herdr, pollMs: 30, maxDispatch: o.maxDispatch ?? 2 })!;
  const frames: HostEventsFrame[] = [];
  const make = (extra: SupervisorOptions = {}) => {
    const s = new HostSupervisor(ctx, cfg, { retryMs: [40, 40, 40], ackMs: 400, answer: { replyMs: 3000, confirmMs: 1500, unconfirmedMs: 500 }, ...o.opts, ...extra });
    live.push(s);
    return s;
  };
  const connect = (s: HostSupervisor) =>
    s.connected((f) => {
      frames.push(f as HostEventsFrame);
      return true;
    });
  return { base, ctx, host, cfg, frames, make, connect };
}

const until = async (what: string, fn: () => boolean, ms = 10_000) => {
  for (const end = Date.now() + ms; !fn(); ) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
};

const started = (h: FakeHost, key?: string) => h.openclawCalls().filter((c) => c.ev === "start" && (!key || c.key === key));
const ended = (h: FakeHost, key?: string) => h.openclawCalls().filter((c) => c.ev === "end" && (!key || c.key === key));

describe("host-task parsers", () => {
  test("a task and its events as the hub gets them, masked and in ms", () => {
    const mask = (s: string) => s.replaceAll("sk-secret", "****");
    const t = parseHostTask(
      { title: "Fix it", project: "0bridge", repo: "", worker: "claude", priority: "P2", status: "running", agent: "t-012", pane: "w1:p3", pending_question_event: 45, evidence: "used sk-secret", task_id: "T-012", updated: 1759650000.25 },
      mask,
    )!;
    expect(t).toEqual({ id: "T-012", title: "Fix it", status: "running", project: "0bridge", repo: null, worker: "claude", priority: "P2", agent: "t-012", pane: "w1:p3", pendingQuestion: 45, evidence: "used ****", result: null, pr: null, waiting: null, updatedAt: 1759650000250 });
    expect(parseHostTask({ title: "no id" })).toBeNull();

    const q = parseHostEvent({ id: 45, at: 1759650001.5, kind: "question_required", task: "T-012", data: { agent: "t-012", pane: "w1:p3", text: "A or B? sk-secret", delivery: "pending_connection" }, dedupe: null }, mask)!;
    expect(q).toEqual({ id: 45, at: 1759650001500, kind: "question_required", task: "T-012", text: "A or B? ****", fields: null, dedupe: null, source: "herdr", pane: "w1:p3", question: null });
    expect(parseHostEvent({ id: 46, at: 1, kind: "question_required", task: "T-012", data: { text: "?", pane: null }, dedupe: null })!.source).toBe("worker");
    const a = parseHostEvent({ id: 47, at: 2, kind: "answer_pending", task: "T-012", data: { question_event: 45, text: "A", target: "w1:p3" }, dedupe: "answer:45" })!;
    expect([a.question, a.pane, a.source]).toEqual([45, "w1:p3", null]);
    expect(parseHostEvent({ id: 48, at: 3, kind: "answer_delivered", task: "T-012", data: { text: "…", pane: "w1:p3" }, dedupe: "answer-delivered:45" })!.question).toBe(45);
    const done = parseHostEvent({ id: 49, at: 4, kind: "task_completed", task: "T-012", data: { status: "completed", evidence: "PR #9 merged" }, dedupe: null })!;
    expect(done.fields).toEqual({ status: "completed", evidence: "PR #9 merged" });
    expect(parseHostEvent({ id: 50, at: 5, kind: "task_updated", task: "T-012", data: { status: "failed" }, dedupe: null })!.fields).toEqual({ status: "failed" });
    // Capped.
    expect(parseHostEvent({ id: 51, at: 5, kind: "worker_result", task: "T-012", data: { text: "x".repeat(10_000) }, dedupe: null })!.text).toHaveLength(4000);
  });

  test("openclaw's argv: the task's own session, the message from a file, and no way to deliver anywhere", () => {
    const argv = openclawArgs({ agent: "lead" }, "T-012", "/tmp/m.txt");
    expect(argv).toEqual(["agent", "--agent", "lead", "--session-key", "0bridge-t-012", "--message-file", "/tmp/m.txt", "--json", "--timeout", "900"]);
    expect(argv.some((a) => /^--(deliver|channel|reply-)/.test(a) || /slack/i.test(a))).toBe(false);
    expect(sessionKey("T-001")).toBe("0bridge-t-001");
    expect(replyText(JSON.stringify({ result: { payloads: [{ text: "on it" }] } }))).toBe("on it");
    expect(replyText(JSON.stringify({ reply: "done" }))).toBe("done");
    // The shape openclaw 2026.9.8 prints for `openclaw agent --json` (seen on dgithost, 2026-10-06; ids made up).
    const real = { runId: "run-1", status: "ok", summary: "completed", result: { payloads: [{ text: "PROBE_OK" }], meta: { finalAssistantVisibleText: "PROBE_OK", terminalReply: { text: "PROBE_OK" } }, sourceReplyDeliveryState: "missing" } };
    expect(replyText(JSON.stringify(real))).toBe("PROBE_OK");
    expect(replyText("plain words")).toBe("plain words");
  });

  test("the config: an agent id that can't be an option, defaults filled in", () => {
    expect(supervisorConfig({ kind: "openclaw", agent: "lead" })).toEqual({ kind: "openclaw", agent: "lead", label: null, hostTask: "host-task", openclaw: "openclaw", herdr: "herdr", pollMs: 3000, maxDispatch: 2 });
    expect(supervisorConfig({ kind: "openclaw", agent: "--deliver" })).toBeUndefined();
    expect(supervisorConfig({ kind: "slack", agent: "lead" })).toBeUndefined();
    expect(supervisorConfig({ kind: "openclaw", agent: "lead", maxDispatch: 50, openclaw: "--x" })).toMatchObject({ maxDispatch: 4, openclaw: "openclaw" });
  });
});

describe("host supervisor", () => {
  test("a request becomes a host-task task at once, and its message reaches lead in that task's own session", async () => {
    const { host, make, ctx } = setup();
    const s = make();
    host.hold("T-001");
    const r = (await s.request({ op: "host.request", requestId: "hr_aaaa1111", text: "Add a --dry-run flag to deploy.sh", title: "Dry run for deploy.sh", project: "infra", repo: "/srv/infra", worker: "claude", priority: "P1" })) as HostRequestReply;
    expect(r.dispatch).toBe("queued");
    expect(r.task).toMatchObject({ id: "T-001", title: "Dry run for deploy.sh", status: "requested", project: "infra", repo: "/srv/infra", worker: "claude", priority: "P1" });
    expect(host.events("dots_request")).toEqual([expect.objectContaining({ task: "T-001", dedupe: "dots-request:hr_aaaa1111", data: expect.objectContaining({ text: "Add a --dry-run flag to deploy.sh" }) })]);
    await until("openclaw started", () => started(host).length === 1);
    const call = started(host)[0]!;
    expect(call.argv!.slice(0, 6)).toEqual(["agent", "--agent", "lead", "--session-key", "0bridge-t-001", "--message-file"]);
    expect(call.message).toContain("[0bridge request hr_aaaa1111] Host task T-001 (already created in host-task by 0bridge; don't create another).");
    expect(call.message).toContain("If you've seen request id hr_aaaa1111 before, ignore this copy.");
    expect(call.message).toContain("Add a --dry-run flag to deploy.sh");
    expect(call.message).toContain("Don't post to Slack.");
    // Still "thinking": the queue is on disk, so a restart sends it again.
    expect(readSupervisorState(ctx).queue.map((d) => d.id)).toEqual(["hr_aaaa1111"]);
    host.release("T-001");
    await until("lead's reply recorded", () => host.events("supervisor_reply").length === 1);
    expect(host.events("supervisor_reply")[0]).toMatchObject({ task: "T-001", dedupe: "supervisor-reply:hr_aaaa1111", data: { text: "lead: on it (0bridge-t-001)" } });
    await until("the queue empty", () => readSupervisorState(ctx).queue.length === 0);
    expect(existsSync(call.argv![6]!)).toBe(false);

    // The same request id again (the hub retried): the same task, nothing new.
    const again = (await s.request({ op: "host.request", requestId: "hr_aaaa1111", text: "Add a --dry-run flag to deploy.sh", title: "Dry run for deploy.sh" })) as HostRequestReply;
    expect([again.task.id, again.dispatch]).toEqual(["T-001", "duplicate"]);
    expect(Object.keys(host.db().tasks)).toEqual(["T-001"]);
    await Bun.sleep(100);
    expect(started(host)).toHaveLength(1);
    // Nothing any stand-in got names Slack or a delivery flag.
    expect(host.allArgs().filter((a) => /^--(deliver|channel|reply-)|slack/i.test(a))).toEqual([]);
  });

  test("tasks run side by side, one task's messages in order, at most two openclaw at once", async () => {
    const { host, make } = setup({ maxDispatch: 2 });
    const s = make();
    for (const t of ["T-001", "T-002", "T-003"]) host.hold(t);
    await s.request({ op: "host.request", requestId: "hr_task0001", text: "first", title: "A" });
    await s.request({ op: "host.followup", requestId: "hf_task0001", task: "T-001", text: "and the docs" });
    await s.request({ op: "host.request", requestId: "hr_task0002", text: "second", title: "B" });
    await s.request({ op: "host.request", requestId: "hr_task0003", text: "third", title: "C" });
    await until("two running", () => started(host).length === 2);
    await Bun.sleep(150);
    // T-001's follow-up waits for its request; T-003 waits for a free slot.
    expect(started(host).map((c) => c.key).sort()).toEqual(["0bridge-t-001", "0bridge-t-002"]);
    host.release("T-002");
    await until("T-003 starts in T-002's slot", () => started(host, "0bridge-t-003").length === 1);
    expect(started(host, "0bridge-t-001")).toHaveLength(1);
    host.release("T-001");
    host.release("T-003");
    await until("the follow-up sent", () => started(host, "0bridge-t-001").length === 2);
    const t1 = host.openclawCalls().filter((c) => c.key === "0bridge-t-001");
    // In order: the request ended before the follow-up started.
    expect(t1.map((c) => `${c.ev}:${c.id}`)).toEqual(["start:hr_task0001", "end:hr_task0001", "start:hf_task0001", ...(t1.length > 3 ? ["end:hf_task0001"] : [])]);
    expect(t1[2]!.message).toContain("[0bridge follow-up hf_task0001 for T-001]");
    expect(host.events("dots_followup")).toEqual([expect.objectContaining({ task: "T-001", dedupe: "dots-followup:hf_task0001" })]);
    // A follow-up to a task host-task doesn't have.
    await expect(s.request({ op: "host.followup", requestId: "hf_nope0001", task: "T-099", text: "hi" })).rejects.toThrow(/unknown task: T-099/);
  });

  test("a failed openclaw is tried again; after the last try it's recorded as supervisor_error", async () => {
    const { host, make, ctx } = setup({ openclaw: { fail: { "0bridge-t-001": 2, "0bridge-t-002": 9 } } });
    const s = make();
    await s.request({ op: "host.request", requestId: "hr_retry0001", text: "x", title: "x" });
    await s.request({ op: "host.request", requestId: "hr_retry0002", text: "y", title: "y" });
    await until("T-001 through on the third try", () => host.events("supervisor_reply").length === 1);
    expect(started(host, "0bridge-t-001")).toHaveLength(3);
    await until("T-002 given up", () => host.events("supervisor_error").length === 1);
    expect(started(host, "0bridge-t-002")).toHaveLength(4);
    expect(host.events("supervisor_error")[0]).toMatchObject({ task: "T-002", dedupe: "supervisor-error:hr_retry0002" });
    expect(readSupervisorState(ctx).lastError?.text).toMatch(/hr_retry0002 for T-002 didn't reach lead/);
    // Off the queue once it's recorded.
    await until("the queue empty", () => readSupervisorState(ctx).queue.length === 0);
  });

  test("status and questions read host-task live", async () => {
    const { host, make } = setup();
    const s = make();
    const a = host.create("Older", { project: "infra" });
    host.create("Newer", { project: "0bridge" });
    host.set(a, { status: "running" });
    const q = host.block(a, "w1:p3", "Use Postgres or SQLite?");
    const st = (await s.request({ op: "host.status" })) as { tasks: { id: string }[] };
    expect(st.tasks.map((t) => t.id)).toEqual(["T-001", "T-002"]);
    expect(((await s.request({ op: "host.status", project: "0bridge" })) as { tasks: { id: string }[] }).tasks.map((t) => t.id)).toEqual(["T-002"]);
    expect(((await s.request({ op: "host.status", task: "T-001" })) as { tasks: { pendingQuestion: number }[] }).tasks[0]!.pendingQuestion).toBe(q);
    expect(await s.request({ op: "host.questions" })).toEqual({ questions: [{ question: q, task: "T-001", text: "Use Postgres or SQLite?", askedAt: expect.any(Number) }] });
    await expect(s.request({ op: "host.status", task: "--all" })).rejects.toThrow(/bad task id/);
  });
});

describe("host supervisor crash windows", () => {
  /** A supervisor that dies at `step`: stopped there, so nothing after it runs or is saved (a crash). */
  const dying = (step: CrashStep): SupervisorOptions => ({ seam: (at, sup) => at === step && sup.stop() });
  const req = { op: "host.request" as const, requestId: "hr_crash0001", text: "Rotate the staging keys", title: "Rotate keys", project: "infra", priority: "P1" };

  test("host-task made the task, then a crash before it was saved: the restart finds that task, makes no second, and queues it once", async () => {
    const { host, make, ctx } = setup();
    const s1 = make(dying("request-created"));
    await expect(s1.request(req)).rejects.toThrow(/stopped/);
    // Nothing went back to the hub; on disk, the request is taken but not mapped or queued.
    expect(Object.keys(host.db().tasks)).toEqual(["T-001"]);
    const st = readSupervisorState(ctx);
    expect([st.incoming.hr_crash0001?.task, st.requests, st.queue]).toEqual([null, {}, []]);
    // Someone else's task in between isn't taken for it.
    host.create("Somebody else's", { project: "infra" });

    const s2 = make();
    await until("lead got it after the restart", () => started(host, "0bridge-t-001").length === 1);
    await until("lead's reply", () => host.events("supervisor_reply").length === 1);
    // The hub retries the same request id: the same task.
    const again = (await s2.request(req)) as HostRequestReply;
    expect([again.task.id, again.dispatch]).toEqual(["T-001", "duplicate"]);
    expect(Object.keys(host.db().tasks)).toEqual(["T-001", "T-002"]);
    expect(host.events("task_requested")).toHaveLength(2);
    expect(host.events("dots_request")).toEqual([expect.objectContaining({ task: "T-001", dedupe: "dots-request:hr_crash0001" })]);
    await Bun.sleep(150);
    expect(started(host)).toHaveLength(1);
    expect(readSupervisorState(ctx)).toMatchObject({ incoming: {}, requests: { hr_crash0001: "T-001" }, queue: [] });
  });

  test("a crash before host-task heard of it: the restart makes the task (once) and the hub learns its id from dots_request", async () => {
    const { host, make, ctx } = setup();
    await expect(make(dying("request-taken")).request(req)).rejects.toThrow(/stopped/);
    expect(host.db().tasks).toEqual({});
    expect(Object.keys(readSupervisorState(ctx).incoming)).toEqual(["hr_crash0001"]);
    make();
    await until("lead got it", () => started(host, "0bridge-t-001").length === 1);
    expect(host.task("T-001")).toMatchObject({ title: "Rotate keys", project: "infra", priority: "P1" });
    expect(host.events("dots_request")).toEqual([expect.objectContaining({ task: "T-001", dedupe: "dots-request:hr_crash0001" })]);
    await Bun.sleep(150);
    expect(Object.keys(host.db().tasks)).toEqual(["T-001"]);
    expect(started(host)).toHaveLength(1);
  });

  test("a crash after dots_request but before the queue: the hub's retry and the restart's recovery queue it once", async () => {
    const { host, make, ctx } = setup();
    host.hold("T-001");
    await expect(make(dying("request-recorded")).request(req)).rejects.toThrow(/stopped/);
    expect(readSupervisorState(ctx).incoming.hr_crash0001?.task).toBe("T-001");
    const s2 = make();
    // The retry races the recovery the restart started: both end in the one task, queued once.
    const r = (await s2.request(req)) as HostRequestReply;
    expect(r.task.id).toBe("T-001");
    await until("lead got it", () => started(host, "0bridge-t-001").length === 1);
    expect(readSupervisorState(ctx).queue.map((d) => d.id)).toEqual(["hr_crash0001"]);
    host.release("T-001");
    await until("the queue empty", () => readSupervisorState(ctx).queue.length === 0);
    expect(Object.keys(host.db().tasks)).toEqual(["T-001"]);
    expect(host.events("dots_request")).toHaveLength(1);
    expect(started(host)).toHaveLength(1);
  });

  test("a follow-up taken, then a crash before the queue: queued once after the restart", async () => {
    const { host, make, ctx } = setup();
    const t = host.create("Running task");
    const fu = { op: "host.followup" as const, requestId: "hf_crash0001", task: t, text: "also update the runbook" };
    await expect(make(dying("followup-recorded")).request(fu)).rejects.toThrow(/stopped/);
    expect(readSupervisorState(ctx).followups).toEqual({});
    const s2 = make();
    await until("lead got it", () => started(host, "0bridge-t-001").length === 1);
    expect(started(host)[0]!.message).toContain("[0bridge follow-up hf_crash0001 for T-001]");
    expect(await s2.request(fu)).toEqual({ task: "T-001", dispatch: "duplicate" });
    await until("the queue empty", () => readSupervisorState(ctx).queue.length === 0);
    expect(host.events("dots_followup")).toHaveLength(1);
    expect(started(host)).toHaveLength(1);
  });

  test("lead answered, then a crash before it was recorded: the restart records the reply once, never runs the turn again, and the tail sends it to the hub", async () => {
    const { host, make, ctx, connect, frames } = setup();
    const s1 = make(dying("turn-finished"));
    await s1.request(req);
    await until("lead's turn over", () => ended(host, "0bridge-t-001").length === 1);
    await until("the crash", () => readSupervisorState(ctx).queue[0]?.result !== undefined);
    await Bun.sleep(100);
    expect(host.events("supervisor_reply")).toEqual([]);
    expect(readSupervisorState(ctx).queue[0]!.result).toEqual({ kind: "supervisor_reply", text: "lead: on it (0bridge-t-001)" });

    const cursor = host.db().seq;
    const s2 = make();
    connect(s2);
    s2.onFrame({ t: "host-cursor", cursor });
    await until("the reply recorded", () => host.events("supervisor_reply").length === 1);
    expect(host.events("supervisor_reply")[0]).toMatchObject({ task: "T-001", dedupe: "supervisor-reply:hr_crash0001" });
    await until("the queue empty", () => readSupervisorState(ctx).queue.length === 0);
    await until("the hub hears of it", () => frames.some((f) => f.events.some((e) => e.kind === "supervisor_reply")));
    s2.onFrame({ t: "host-ack", cursor: frames.at(-1)!.cursor });
    await Bun.sleep(150);
    expect(started(host)).toHaveLength(1);
    expect(frames.flatMap((f) => f.events).filter((e) => e.kind === "supervisor_reply")).toHaveLength(1);
  });

  test("a crash before host-task heard of it, with an older task made alike in the log: the restart makes its own, never takes that one", async () => {
    const { host, make, ctx } = setup();
    // Someone made the same task by hand earlier (before 0bridge's cursor was ever set).
    host.create("Rotate keys", { project: "infra", priority: "P1" });
    await expect(make(dying("request-taken")).request(req)).rejects.toThrow(/stopped/);
    expect(readSupervisorState(ctx).incoming.hr_crash0001?.since).toBe(1);
    make();
    await until("lead got it", () => started(host, "0bridge-t-002").length === 1);
    expect(Object.keys(host.db().tasks)).toEqual(["T-001", "T-002"]);
    expect(readSupervisorState(ctx).requests).toEqual({ hr_crash0001: "T-002" });
    expect(started(host, "0bridge-t-001")).toEqual([]);
  });

  test("two requests made alike, both interrupted after host-task made their tasks: each finds its own", async () => {
    const { host, make, ctx } = setup();
    host.create("Twin", { project: "infra" });
    host.create("Twin", { project: "infra" });
    mkdirSync(join(ctx.storeDir, "agent"), { recursive: true });
    const inc = (id: string, text: string) => ({ kind: "request", id, text, task: null, create: { title: "Twin", project: "infra" }, since: 0, tries: 0, nextAt: 0 });
    writeFileSync(supervisorStatePath(ctx), JSON.stringify({ cursor: null, requests: {}, followups: {}, answers: {}, incoming: { hr_twin00001: inc("hr_twin00001", "one"), hr_twin00002: inc("hr_twin00002", "two") }, queue: [], lastError: null }));
    make();
    await until("both queued", () => Object.keys(readSupervisorState(ctx).requests).length === 2);
    expect(Object.values(readSupervisorState(ctx).requests).sort()).toEqual(["T-001", "T-002"]);
    await until("lead got both", () => started(host, "0bridge-t-001").length === 1 && started(host, "0bridge-t-002").length === 1);
    expect(Object.keys(host.db().tasks)).toEqual(["T-001", "T-002"]);
  });

  test("host-task made the task, then a later step failed: the hub gets the task id (not an error), and it's queued once later", async () => {
    const { host, make, ctx } = setup({ opts: { retryMs: [400, 400, 400] } });
    // The messages folder can't be made (a file in its place): queueing fails after the create.
    mkdirSync(join(ctx.storeDir, "agent"), { recursive: true });
    const blocker = join(ctx.storeDir, "agent", "host-messages");
    writeFileSync(blocker, "");
    const r = (await make().request(req)) as HostRequestReply;
    expect([r.task.id, r.task.title, r.dispatch]).toEqual(["T-001", "Rotate keys", "queued"]);
    expect(readSupervisorState(ctx).incoming.hr_crash0001?.task).toBe("T-001");
    rmSync(blocker);
    await until("lead got it", () => started(host, "0bridge-t-001").length === 1, 5000);
    await until("mapped", () => readSupervisorState(ctx).requests.hr_crash0001 === "T-001");
    expect(Object.keys(host.db().tasks)).toEqual(["T-001"]);
    expect(host.events("dots_request")).toHaveLength(1);
  });

  test("the reply recorded, then a crash before the queue moved on: the restart records nothing new and runs nothing again", async () => {
    const { host, make, ctx } = setup({ openclaw: { fail: { "0bridge-t-001": 9 } } });
    await make(dying("turn-recorded")).request(req);
    await until("given up and recorded", () => host.events("supervisor_error").length === 1);
    await Bun.sleep(100);
    expect(readSupervisorState(ctx).queue.map((d) => d.result?.kind)).toEqual(["supervisor_error"]);
    make();
    await until("the queue empty", () => readSupervisorState(ctx).queue.length === 0);
    expect(host.events("supervisor_error")).toEqual([expect.objectContaining({ task: "T-001", dedupe: "supervisor-error:hr_crash0001" })]);
    expect(started(host)).toHaveLength(4);
  });
});

describe("0b agent supervisor", () => {
  test("checks each program, saves the supervisor in agent.json, shows it, and turns it off", () => {
    const { base, host, ctx } = setup();
    const env = { ...process.env, ZEROBRIDGE_USER_HOME: ctx.home, ZEROBRIDGE_DIR: ctx.storeDir, ZEROBRIDGE_SECRET_STORE: "file", NO_COLOR: "1" };
    const cli = (...args: string[]) => spawnSync("bun", [join(import.meta.dir, "../src/index.ts"), "agent", "supervisor", ...args], { env, encoding: "utf8" });
    const bins = ["--host-task", host.bins.hostTask, "--openclaw", host.bins.openclaw, "--herdr", host.bins.herdr];
    const missing = cli("openclaw", "--agent", "lead", "--host-task", host.bins.hostTask, "--openclaw", join(base, "nope"), "--herdr", host.bins.herdr);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/openclaw .* doesn't run here/);
    expect(cli("openclaw", "--agent", "--deliver", ...bins).status).toBe(1);
    const ok = cli("openclaw", "--agent", "lead", "--label", "dev-herdr-agent", ...bins);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("goes to OpenClaw's lead (dev-herdr-agent)");
    expect(ok.stdout).toContain("nothing is posted to Slack");
    expect(ok.stdout).toContain("Agent control is off on this machine");
    expect(ok.stdout).not.toContain("doesn't show an agent");
    const saved = JSON.parse(readFileSync(join(ctx.storeDir, "agent.json"), "utf8"));
    expect(saved.supervisor).toEqual({ kind: "openclaw", agent: "lead", label: "dev-herdr-agent", hostTask: host.bins.hostTask, openclaw: host.bins.openclaw, herdr: host.bins.herdr, pollMs: 3000, maxDispatch: 2 });
    expect(cli("openclaw", "--agent", "ops", ...bins).stdout).toContain(`doesn't show an agent "ops"`);
    const st = cli("status");
    expect(st.stdout).toContain("openclaw/ops (dev-herdr-agent)");
    expect(st.stdout).toContain("queued for ops: 0");
    expect(cli("off").status).toBe(0);
    expect(JSON.parse(readFileSync(join(ctx.storeDir, "agent.json"), "utf8")).supervisor).toBeUndefined();
    expect(cli("status").stdout).toContain("No supervisor is set up");
  });
});

describe("the daemon process with a supervisor, over a hub socket", () => {
  test("requests, a second conversation, a question answered in the right pane, and a restart without loss or repeats", async () => {
    const { base, host, ctx } = setup();
    // A hub that stores host events by id (as MachineHub does), acks them and says where to resume.
    const hub = { frames: [] as any[], ws: null as any, cursor: null as number | null, ids: [] as number[], waiting: new Map<string, (r: any) => void>() };
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        const u = new URL(req.url);
        if (u.pathname === "/api/machines/connect") return req.headers.get("authorization") === "Bearer tok_e2e" && srv.upgrade(req) ? undefined : new Response("no", { status: 401 });
        return u.pathname === "/api/machines" ? Response.json([]) : new Response("not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          hub.ws = ws;
        },
        message(ws, m) {
          const f = JSON.parse(String(m));
          hub.frames.push(f);
          if (f.t === "hello" && f.host) ws.send(JSON.stringify({ t: "host-cursor", cursor: hub.cursor }));
          if (f.t === "host-events") {
            hub.ids.push(...f.events.map((e: { id: number }) => e.id));
            hub.cursor = f.cursor;
            ws.send(JSON.stringify({ t: "host-ack", cursor: f.cursor }));
          }
          if (f.t === "reply") hub.waiting.get(f.rid)?.(f);
        },
        close() {
          hub.ws = null;
        },
      },
    });
    let n = 0;
    const req = (op: Record<string, unknown>) =>
      new Promise<any>((resolve, reject) => {
        const rid = `r${++n}`;
        const t = setTimeout(() => reject(new Error(`no reply to ${JSON.stringify(op)}`)), 15_000);
        hub.waiting.set(rid, (r) => {
          clearTimeout(t);
          r.ok ? resolve(r.data) : reject(new Error(r.error));
        });
        hub.ws.send(JSON.stringify({ t: "req", rid, ...op }));
      });
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { spawn } = await import("node:child_process");
    mkdirSync(ctx.storeDir, { recursive: true });
    const account = { server: `http://localhost:${server.port}`, userId: "u_e2e", login: "e2e", tokenId: null, email: null, slot: "" };
    writeFileSync(join(ctx.storeDir, "accounts.json"), JSON.stringify({ default: "u_e2e", accounts: [account] }));
    writeFileSync(join(ctx.storeDir, "secrets.json"), JSON.stringify({ "cloud.device-token": "tok_e2e" }));
    writeFileSync(
      join(ctx.storeDir, "agent.json"),
      JSON.stringify({ enabled: true, repos: [], supervisor: { kind: "openclaw", agent: "lead", label: "dev-herdr-agent", hostTask: host.bins.hostTask, openclaw: host.bins.openclaw, herdr: host.bins.herdr, pollMs: 100 } }),
    );
    host.create("From before 0bridge");
    const env = { ...process.env, ZEROBRIDGE_USER_HOME: ctx.home, ZEROBRIDGE_DIR: ctx.storeDir, ZEROBRIDGE_SECRET_STORE: "file", ZEROBRIDGE_AGENT_FAKE: "1", NO_COLOR: "1" };
    let out = "";
    const run = () => {
      const p = spawn("bun", [join(import.meta.dir, "../src/index.ts"), "agent", "run"], { env, stdio: ["ignore", "pipe", "pipe"] });
      p.stdout!.on("data", (d) => (out += d));
      p.stderr!.on("data", (d) => (out += d));
      return p;
    };
    const wait = async (what: string, fn: () => boolean, ms = 20_000) => {
      for (const end = Date.now() + ms; !fn(); await Bun.sleep(20)) if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${out}`);
    };
    let daemon = run();
    try {
      await wait("the hello", () => hub.frames.some((f) => f.t === "hello"));
      expect(hub.frames.find((f) => f.t === "hello").host).toEqual({ kind: "openclaw", agent: "lead", label: "dev-herdr-agent" });
      await wait("the cursor at the end of the log", () => readSupervisorState(ctx).cursor === 1);

      // Conversation A asks for work; lead is still on it when conversation B asks for more.
      host.hold("T-002");
      const a = await req({ op: "host.request", requestId: "hr_convA0001", text: "Fix the login bug", title: "Login bug" });
      expect([a.task.id, a.dispatch]).toEqual(["T-002", "queued"]);
      await wait("lead has A", () => started(host, "0bridge-t-002").length === 1);
      const b = await req({ op: "host.request", requestId: "hr_convB0001", text: "Update the changelog", title: "Changelog" });
      expect(b.task.id).toBe("T-003");
      await wait("lead has B in its own session", () => ended(host, "0bridge-t-003").length === 1);
      expect(ended(host, "0bridge-t-002")).toHaveLength(0);

      // A's worker asks; the hub hears it, the answer goes to A's pane only.
      host.assign("T-003", "w1:p4", "blocked");
      const q = host.block("T-002", "w1:p3", "Keep the old endpoint?");
      await wait("the question at the hub", () => hub.frames.some((f) => f.t === "host-events" && f.events.some((e: any) => e.id === q)));
      const qe = hub.frames.flatMap((f) => (f.t === "host-events" ? f.events : [])).find((e: any) => e.id === q);
      expect(qe).toMatchObject({ kind: "question_required", task: "T-002", source: "herdr", pane: "w1:p3", text: "Keep the old endpoint?" });
      const ans = await req({ op: "host.answer", question: q, text: "Yes, keep it" });
      expect(ans).toMatchObject({ status: "delivered", worker: "t-002", pane: "w1:p3", confirmation: { from: "blocked", to: "working" } });
      expect(host.pane("w1:p3")!.typed).toEqual(["Yes, keep it", "<enter>"]);
      expect(host.pane("w1:p4")!.typed ?? []).toEqual([]);
      expect(await req({ op: "host.answer", question: q, text: "Yes, keep it" })).toEqual(ans);
      await wait("answer_delivered at the hub", () => hub.frames.some((f) => f.t === "host-events" && f.events.some((e: any) => e.kind === "answer_delivered")));

      // The daemon stops; things happen meanwhile; it comes back and the hub gets each once.
      const acked = hub.cursor!;
      await wait("everything acked", () => readSupervisorState(ctx).cursor === hub.cursor);
      daemon.kill("SIGTERM");
      await new Promise((r) => daemon.once("exit", r));
      host.release("T-002");
      host.set("T-002", { status: "completed", evidence: "PR #12 merged" });
      host.set("T-003", { status: "failed" });
      daemon = run();
      await wait("the events from while it was down", () => hub.ids.some((id) => id > acked && host.db().events.find((e) => e.id === id)?.kind === "task_updated"));
      await wait("lead's reply to A, sent again after the restart", () => host.events("supervisor_reply").some((e) => e.task === "T-002"));
      await wait("all of it at the hub", () => hub.cursor === host.db().seq, 10_000);
      expect(new Set(hub.ids).size).toBe(hub.ids.length);
      // At least once to lead: A's request went again (it says to ignore a copy already seen).
      expect(started(host, "0bridge-t-002").length).toBeGreaterThanOrEqual(1);
      expect(host.allArgs().filter((a) => /^--(deliver|channel|reply-)|slack/i.test(a))).toEqual([]);
    } finally {
      daemon.kill();
      server.stop(true);
    }
    void base;
  }, 60_000);
});

/**
 * The daemon with a supervisor against a local machine hub (`wrangler dev` with DEV_LOGIN=1):
 *   ZEROBRIDGE_E2E=1 GATEWAY_URL=http://localhost:8871 bun test apps/cli/test/agent-supervisor.test.ts
 * The hello with `host` is accepted, the machine's other work goes on as before, and the hub's
 * host-cursor (null: it has nothing from this machine yet) starts the tail at the end of the log:
 * an event emitted now is sent, acked, and the cursor saved there. The rest of the host round trip
 * is apps/gateway/test/dots-host.ts's end to end.
 */
describe.skipIf(!process.env.ZEROBRIDGE_E2E)("supervisor against a local hub", () => {
  test("a machine with a supervisor connects, works as before, and tails host-task from the hub's host-cursor", async () => {
    const { Database } = await import("bun:sqlite");
    const { readdirSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { spawn, execFileSync } = await import("node:child_process");
    const { CloudClient, DEVICE_TOKEN, loadCloud, openSecretStore } = await import("@0bridge/core");
    const SERVER = process.env.GATEWAY_URL ?? "http://localhost:8787";
    const GATEWAY = join(import.meta.dir, "../../gateway");
    const { host, ctx } = setup();
    const env = { ...process.env, ZEROBRIDGE_USER_HOME: ctx.home, ZEROBRIDGE_DIR: ctx.storeDir, ZEROBRIDGE_SECRET_STORE: "file", ZEROBRIDGE_AGENT_FAKE: "1", BROWSER: join(GATEWAY, "test/fake-browser.ts"), NO_COLOR: "1" };
    const d1 = join(GATEWAY, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject");
    const db = new Database(join(d1, readdirSync(d1).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")!));
    const dev = `(SELECT id FROM user WHERE email = 'dev@0bridge.local')`;
    db.run(`DELETE FROM passkey WHERE userId IN ${dev}`);
    const CLI = join(import.meta.dir, "../src/index.ts");
    expect(spawnSync("bun", [CLI, "login", "--server", SERVER], { env, encoding: "utf8" }).status).toBe(0);
    db.run(`INSERT INTO account_setting (user_id, agent_control, updated_at) SELECT id, 1, ? FROM user WHERE email = 'dev@0bridge.local' ON CONFLICT(user_id) DO UPDATE SET agent_control = 1`, [Date.now()]);
    db.close();
    const repo = join(ctx.home, "work", "app");
    mkdirSync(repo, { recursive: true });
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "README.md"), "app\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    const sup = spawnSync("bun", [CLI, "agent", "supervisor", "openclaw", "--agent", "lead", "--label", "dev-herdr-agent", "--host-task", host.bins.hostTask, "--openclaw", host.bins.openclaw, "--herdr", host.bins.herdr], { env, encoding: "utf8" });
    expect(sup.status).toBe(0);
    const cfg = JSON.parse(readFileSync(join(ctx.storeDir, "agent.json"), "utf8"));
    writeFileSync(join(ctx.storeDir, "agent.json"), JSON.stringify({ ...cfg, enabled: true, repos: [{ root: repo, mode: "edit", worktree: true, deny: [] }], supervisor: { ...cfg.supervisor, pollMs: 100 } }));
    host.create("Already there");
    let out = "";
    const daemon = spawn("bun", [CLI, "agent", "run"], { env, stdio: ["ignore", "pipe", "pipe"] });
    daemon.stdout!.on("data", (d) => (out += d));
    daemon.stderr!.on("data", (d) => (out += d));
    try {
      const client = new CloudClient(loadCloud(ctx)!.server, openSecretStore(ctx.storeDir).get(DEVICE_TOKEN)!);
      const wait = async <T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 20_000): Promise<T> => {
        for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(250)) {
          const v = await fn().catch(() => null);
          if (v) return v;
        }
        throw new Error(`timed out waiting for ${what}\n${out}`);
      };
      type Machine = { id: string; name: string; online?: boolean };
      const machine = await wait("the machine online", async () => (await client.call<Machine[]>("GET", "/machines")).find((m) => m.online !== false));
      // The machine's own tasks work as before.
      const t = await client.call<{ id: string }>("POST", "/machines/tasks", { machine: machine.id, repo, agent: "claude", prompt: "hello" });
      const done = await wait("the task done", async () => {
        const v = await client.call<{ task: { state: string } }>("GET", `/machines/tasks/${t.id}?after=0`);
        return v.task.state === "done" ? v : null;
      });
      expect(done.task.state).toBe("done");
      // The hub sent host-cursor null, so the tail started at the end of the log ("Already there"
      // isn't sent); what's emitted now is sent, and the cursor moves to it on the hub's ack.
      const id = host.emit("worker_result", "T-001", "after the hub's host-cursor");
      expect(id).toBeNumber();
      await wait("the cursor at the new event", async () => readSupervisorState(ctx).cursor === id);
      expect(out).not.toMatch(/host: can't read/);
      await client.call("DELETE", `/machines/${machine.id}`);
    } finally {
      daemon.kill();
    }
  }, 90_000);
});

describe("host-task event tail", () => {
  test("starts at the end of the log, sends new events once acked, and sends them again after a restart until then", async () => {
    const { host, make, connect, frames, ctx } = setup();
    host.create("Old task");
    host.emit("question_required", "T-001", "an old question");
    let s = make();
    connect(s);
    // Nothing goes before the hub says where to resume.
    await Bun.sleep(100);
    expect(frames).toHaveLength(0);
    s.onFrame({ t: "host-cursor", cursor: null });
    await until("the cursor at the end of the log", () => readSupervisorState(ctx).cursor === 2);
    const q = host.block("T-001", "w1:p1", "Which branch?");
    host.set("T-001", { status: "completed", evidence: "PR #4" });
    await until("a frame", () => frames.length === 1);
    const f = frames[0]!;
    expect(f.t).toBe("host-events");
    expect(f.events.map((e) => [e.id, e.kind])).toEqual([
      [q, "question_required"],
      [q + 1, "task_completed"],
    ]);
    expect(f.events[0]).toMatchObject({ source: "herdr", pane: "w1:p1", text: "Which branch?" });
    expect(f.events[1]!.fields).toEqual({ status: "completed", evidence: "PR #4" });
    expect(f.tasks).toEqual([expect.objectContaining({ id: "T-001", status: "completed", evidence: "PR #4" })]);
    expect(f.cursor).toBe(q + 1);
    // Not acked: the cursor stays, and nothing is sent twice while the ack may still come.
    await Bun.sleep(150);
    expect(readSupervisorState(ctx).cursor).toBe(2);
    expect(frames).toHaveLength(1);

    // The daemon restarts before the ack: the same events go again, once.
    s.stop();
    s = make();
    connect(s);
    s.onFrame({ t: "host-cursor", cursor: 2 });
    await until("sent again", () => frames.length === 2);
    expect(frames[1]!.events.map((e) => e.id)).toEqual(f.events.map((e) => e.id));
    // An ack for more than was sent is ignored; the right one moves the cursor.
    s.onFrame({ t: "host-ack", cursor: 99 });
    expect(readSupervisorState(ctx).cursor).toBe(2);
    s.onFrame({ t: "host-ack", cursor: q + 1 });
    expect(readSupervisorState(ctx).cursor).toBe(q + 1);
    host.emit("worker_result", "T-001", "done: PR #4");
    await until("the next one", () => frames.length === 3);
    expect(frames[2]!.events.map((e) => e.kind)).toEqual(["worker_result"]);
    s.onFrame({ t: "host-ack", cursor: frames[2]!.cursor });
    await Bun.sleep(150);
    expect(frames).toHaveLength(3);

    // The hub stored more than this machine remembers (state lost): it resumes from the hub's.
    s.stop();
    s = make();
    connect(s);
    host.emit("worker_result", "T-001", "again");
    s.onFrame({ t: "host-cursor", cursor: frames[2]!.cursor + 1 });
    await Bun.sleep(200);
    expect(frames).toHaveLength(3);
    expect(readSupervisorState(ctx).cursor).toBe(frames[2]!.cursor + 1);
  });

  test("host-task's log was reset (it ends before the hub's cursor): its events go from the start, with the reset's id, until the hub acks it", async () => {
    const { host, make, connect, frames, ctx } = setup();
    const t = host.create("After the reset");
    host.emit("worker_result", t, "first in the new log");
    const s = make();
    connect(s);
    // The hub stored up to #40 from the old log.
    s.onFrame({ t: "host-cursor", cursor: 40, reset: null });
    await until("sent", () => frames.length === 1);
    const id = readSupervisorState(ctx).reset!;
    expect(id).toMatch(/^rs_[0-9a-z]{10}$/);
    expect(frames[0]).toMatchObject({ reset: id, cursor: 2 });
    expect(frames[0]!.events.map((e) => e.id)).toEqual([1, 2]);
    expect(readSupervisorState(ctx)).toMatchObject({ cursor: 0, reset: id });
    // An ack that doesn't say it applied this reset (an older hub) moves nothing.
    s.onFrame({ t: "host-ack", cursor: 2 });
    expect(readSupervisorState(ctx)).toMatchObject({ cursor: 0, reset: id });
    s.onFrame({ t: "host-ack", cursor: 2, reset: id });
    expect(readSupervisorState(ctx).reset).toBeUndefined();
    host.emit("worker_result", t, "next");
    await until("the next one", () => frames.length === 2);
    expect(frames[1]!.reset).toBeUndefined();
    expect(frames[1]!.events.map((e) => e.id)).toEqual([3]);
  });

  test("a reset's ack was lost: the hub's cursor counts only once it says it applied that reset, and the next frames don't say it again", async () => {
    const { host, make, connect, frames, ctx } = setup();
    const t = host.create("After the reset");
    host.emit("worker_result", t, "first in the new log");
    let s = make();
    connect(s);
    s.onFrame({ t: "host-cursor", cursor: 40, reset: null });
    await until("sent", () => frames.length === 1);
    const id = readSupervisorState(ctx).reset!;
    // The hub applied it, but the ack never came; the daemon restarts.
    s.stop();
    host.emit("worker_result", t, "while away");
    s = make();
    connect(s);
    // A hub that didn't apply it (its cursor is still in the old log): sent again from the start, same id.
    s.onFrame({ t: "host-cursor", cursor: 40, reset: "rs_0000000000" });
    await until("sent again", () => frames.length === 2);
    expect(frames[1]).toMatchObject({ reset: id });
    expect(frames[1]!.events.map((e) => e.id)).toEqual([1, 2, 3]);
    s.stop();
    s = make();
    connect(s);
    // The hub did apply it: its cursor is in the new log; nothing repeats the reset.
    s.onFrame({ t: "host-cursor", cursor: 2, reset: id });
    await until("the rest", () => frames.length === 3);
    expect(readSupervisorState(ctx).reset).toBeUndefined();
    expect(frames[2]!.reset).toBeUndefined();
    expect(frames[2]!.events.map((e) => e.id)).toEqual([3]);
    s.onFrame({ t: "host-ack", cursor: 3 });
    expect(readSupervisorState(ctx).cursor).toBe(3);
  });

  test("an unacked frame goes again after a while; a disconnect pauses the tail", async () => {
    const { host, make, connect, frames } = setup({ opts: { ackMs: 150 } });
    const s = make();
    connect(s);
    s.onFrame({ t: "host-cursor", cursor: 0 });
    host.create("T");
    await until("sent", () => frames.length === 1);
    await until("sent again without an ack", () => frames.length === 2, 3000);
    expect(frames[1]!.cursor).toBe(frames[0]!.cursor);
    s.onFrame({ t: "host-ack", cursor: frames[1]!.cursor });
    s.connected(null);
    host.emit("worker_result", "T-001", "while away");
    await Bun.sleep(150);
    expect(frames).toHaveLength(2);
    connect(s);
    s.onFrame({ t: "host-cursor", cursor: frames[1]!.cursor });
    await until("sent after the reconnect", () => frames.length === 3);
    expect(frames[2]!.events.map((e) => e.text)).toEqual(["while away"]);
  });

  test("a big batch is split to fit a frame; the rest follows on the ack", async () => {
    const { host, make, connect, frames } = setup();
    const t = host.create("Big");
    for (let i = 0; i < 80; i++) host.emit("worker_result", t, `${i} ${"x".repeat(3990)}`);
    const s = make();
    connect(s);
    s.onFrame({ t: "host-cursor", cursor: 1 });
    await until("first frame", () => frames.length === 1);
    expect(JSON.stringify(frames[0]).length).toBeLessThanOrEqual(256 * 1024);
    expect(frames[0]!.events.length).toBeLessThan(80);
    s.onFrame({ t: "host-ack", cursor: frames[0]!.cursor });
    await until("the rest", () => frames.reduce((n, f) => n + f.events.length, 0) === 80);
    const ids = frames.flatMap((f) => f.events.map((e) => e.id));
    expect(new Set(ids).size).toBe(80);
  });
});

// On Windows host-task gets its text through a .cmd stand-in on one line: argText joins lines with " / ".
const NL = process.platform === "win32" ? " / " : "\n";

describe("outside context and existing tasks (docs/plans/dots-host.md, \"Outside context\")", () => {
  const SESSION = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
  const OTHER = "99999999-8888-7777-6666-555555555555";
  const TRELLO = { kind: "trello", board: "6ac3b9821dc2644f39df0761", card: "card123", action: "act456", url: "https://trello.com/c/abc" };
  const KEY = "trello:6ac3b9821dc2644f39df0761:act456";
  /** The worker's acknowledgement key the hub made for the item: its message id and a nonce. */
  const ACK = "hc_t5hbjyezpfzsz6yh:k3v9q2m7x1c8p4ra";
  const ctxOp = (task: string, extra: Record<string, unknown> = {}) => ({ op: "host.context" as const, id: "hc_t5hbjyezpfzsz6yh", task, dedupe: KEY, provider: TRELLO, text: "Card comment: please also cover the Safari case", ack: ACK, ...extra });
  const TYPING = /^(send-text|send-keys|prompt)$/;
  const typed = (h: FakeHost) => h.herdrCalls().filter((c) => TYPING.test(c[1] ?? ""));
  type Ctx = { state: string; detail: string | null; worker?: string; pane?: string };

  test("an existing task made outside 0bridge, and its question, are found with host.lookup; an unknown one is null", async () => {
    const { host, make } = setup();
    const s = make();
    const t = host.create("Made by lead");
    const q = host.emit("question_required", t, "Which board?")!;
    expect(await s.request({ op: "host.lookup", task: t })).toMatchObject({ task: { id: t, title: "Made by lead" }, question: null });
    expect(await s.request({ op: "host.lookup", question: q })).toMatchObject({ task: { id: t }, question: { question: q, task: t, text: "Which board?", source: "worker" } });
    expect(await s.request({ op: "host.lookup", task: "T-404" })).toEqual({ task: null, question: null });
    expect(await s.request({ op: "host.lookup", question: 9999 })).toEqual({ task: null, question: null });
  });

  test("context reaches lead for the task's existing native worker only, with its provenance, once per dedupe key; the worker's ack is seen", async () => {
    const { host, make, connect, frames } = setup({ opts: { contextRetryMs: 50 } });
    const t = host.create("Trello card work");
    host.bindNative(t, "w1:p1", SESSION, "idle");
    const s = make();
    connect(s);
    s.onFrame({ t: "host-cursor", cursor: null });
    const r = (await s.request(ctxOp(t))) as Ctx;
    expect(r).toMatchObject({ state: "queued", worker: "t-001", pane: "w1:p1" });
    const received = host.events("context_received");
    expect(received).toHaveLength(1);
    expect(received[0]!.dedupe).toBe(`context:${KEY}`);
    const text = String(received[0]!.data.text);
    expect(JSON.parse(text.split(NL)[0]!.replace(/^provenance: /, ""))).toEqual({ source: "context", provider: "trello", board: TRELLO.board, card: "card123", action: "act456", url: TRELLO.url, dedupe: KEY, id: "hc_t5hbjyezpfzsz6yh" });
    expect(text).toEndWith("Card comment: please also cover the Safari case");
    expect(host.events("context_queued")).toHaveLength(1);
    await until("lead got it", () => ended(host, "0bridge-t-001").length === 1);
    const call = started(host, "0bridge-t-001")[0]!;
    expect(call.id).toBe("hc_t5hbjyezpfzsz6yh");
    expect(call.message).toContain("[0bridge context hc_t5hbjyezpfzsz6yh for T-001]");
    expect(call.message).toContain("not a request, follow-up, approval or answer from the user");
    expect(call.message).toContain(`Provenance: provider=trello · board=${TRELLO.board} · card=card123 · action=act456 · url=${TRELLO.url} · dedupe=${KEY}`);
    expect(call.message).toContain(`pane w1:p1 · herdr agent t-001 · native session ${SESSION}`);
    expect(call.message).toContain(`host-task emit --task T-001 --kind worker_ack --dedupe ack:${ACK} --text`);
    expect(call.message).not.toContain(`ack:${KEY}`);
    expect(call.message).toContain("never start another worker or task");
    await until("lead's reply recorded", () => host.events("supervisor_reply").some((e) => e.dedupe === "supervisor-reply:hc_t5hbjyezpfzsz6yh"));
    await until("the item settled", () => readSupervisorState(s.ctx).contexts[KEY]?.state === "supervisor_reply");
    // The provider sends it again: the same item, nothing new anywhere.
    expect(await s.request(ctxOp(t))).toMatchObject({ state: "supervisor_reply" });
    await Bun.sleep(150);
    expect(started(host)).toHaveLength(1);
    expect(host.events("context_received")).toHaveLength(1);
    // An ack by the provider's key (anyone who saw the Trello action could make it) changes nothing.
    host.emit("worker_ack", t, "forged", `ack:${KEY}`);
    await until("the forged ack read", () => frames.some((f) => f.events.some((e) => e.dedupe === `ack:${KEY}`)));
    expect(readSupervisorState(s.ctx).contexts[KEY]?.state).toBe("supervisor_reply");
    // The worker acknowledges with the key from lead's message: seen, and the settled item keeps no text.
    host.emit("worker_ack", t, "will cover Safari", `ack:${ACK}`);
    await until("acked", () => readSupervisorState(s.ctx).contexts[KEY]?.state === "worker_acked");
    expect(readSupervisorState(s.ctx).contexts[KEY]).toMatchObject({ text: "", settledAt: expect.any(Number) });
    // Never typed, never a new task or worker, never a Dots request, follow-up or answer.
    expect(typed(host)).toEqual([]);
    expect(Object.keys(host.db().tasks)).toEqual([t]);
    expect(host.panes().map((p) => p.pane)).toEqual(["w1:p1"]);
    for (const k of ["dots_request", "dots_followup", "dots_answer", "answer_pending", "question_required"]) expect(host.events(k)).toEqual([]);
  });

  test("context waits while the worker is focused, working, blocked at a question, missing or not the recorded session, then goes once it's ready", async () => {
    const { host, make } = setup({ opts: { contextRetryMs: 40 } });
    const t = host.create("Trello card work");
    const s = make();
    const pendingWhy = () => readSupervisorState(s.ctx).contexts[KEY]?.detail ?? "";
    // No worker on record: pending (0bridge never starts one).
    expect(await s.request(ctxOp(t))).toMatchObject({ state: "pending", detail: expect.stringContaining("no worker on record") });
    host.bindNative(t, "w1:p1", SESSION, "idle");
    host.setPane("w1:p1", { focused: true });
    await until("focused", () => /focused/.test(pendingWhy()));
    host.setPane("w1:p1", { focused: false, status: "working" });
    await until("working", () => /is working/.test(pendingWhy()));
    host.setPane("w1:p1", { status: "blocked" });
    await until("blocked", () => /waiting at a prompt/.test(pendingWhy()));
    host.setPane("w1:p1", { status: "idle", session: OTHER });
    await until("another session in the pane", () => pendingWhy().includes(`runs ${OTHER}`));
    host.setPane("w1:p1", { session: SESSION });
    host.emit("question_required", t, "A or B?");
    await until("a question waits", () => /context isn't an answer/.test(pendingWhy()));
    expect(started(host)).toEqual([]);
    // Recorded the first time and when the kind of reason changed (no worker, busy, another worker,
    // a question), not on each flip between focused, working and blocked.
    await until("each kind of reason recorded once, as it changed", () => host.events("context_pending").length === 4);
    expect(host.events("context_pending").map((e) => e.dedupe)).toEqual([1, 2, 3, 4].map((n) => `context-pending:${KEY}:${n}`));
    expect(host.events("context_pending").map((e) => String(e.data.text).replace(/^.* waits: /, ""))).toEqual([
      expect.stringContaining("no worker on record"),
      expect.stringContaining("is focused"),
      expect.stringContaining(`runs ${OTHER}`),
      expect.stringContaining("context isn't an answer"),
    ]);
    // Ready: no question, idle, unfocused, the recorded session.
    host.watch();
    await until("queued", () => readSupervisorState(s.ctx).contexts[KEY]?.state !== "pending");
    await until("lead got it once", () => ended(host, "0bridge-t-001").length === 1);
    await Bun.sleep(150);
    expect(started(host)).toHaveLength(1);
    expect(typed(host)).toEqual([]);
  });

  test("the worker is checked again right before lead hears of it: not ready then, it waits and goes later, once", async () => {
    const { host, make } = setup({ opts: { contextRetryMs: 40 } });
    const t = host.create("Trello card work");
    host.bindNative(t, "w1:p1", SESSION, "idle");
    const s = make();
    // lead is busy with a follow-up on the same task, so the context waits its turn in the task's queue.
    host.hold(t);
    await s.request({ op: "host.followup", requestId: "hf_ctx00001", task: t, text: "first" });
    await until("follow-up with lead", () => started(host).length === 1);
    expect(await s.request(ctxOp(t))).toMatchObject({ state: "queued" });
    host.setPane("w1:p1", { focused: true });
    host.release(t);
    await until("back to pending", () => readSupervisorState(s.ctx).contexts[KEY]?.state === "pending");
    expect(started(host).filter((c) => c.id?.startsWith("hc_"))).toEqual([]);
    expect(readSupervisorState(s.ctx).queue.map((d) => d.id)).not.toContain("hc_t5hbjyezpfzsz6yh");
    host.setPane("w1:p1", { focused: false });
    await until("lead got it", () => started(host).some((c) => c.id === "hc_t5hbjyezpfzsz6yh"));
    await Bun.sleep(200);
    expect(started(host).filter((c) => c.id === "hc_t5hbjyezpfzsz6yh")).toHaveLength(1);
  });

  test("a context item's dedupe and pending state survive a restart: the same key isn't taken twice, and it goes once the worker is ready", async () => {
    const { host, make } = setup({ opts: { contextRetryMs: 40 } });
    const t = host.create("Trello card work");
    host.bindNative(t, "w1:p1", SESSION, "working");
    const s1 = make();
    expect(await s1.request(ctxOp(t))).toMatchObject({ state: "pending" });
    s1.stop();
    const s2 = make();
    expect(readSupervisorState(s2.ctx).contexts[KEY]).toMatchObject({ state: "pending", task: t });
    expect(await s2.request(ctxOp(t))).toMatchObject({ state: "pending" });
    // Another task can't reuse the key.
    const t2 = host.create("Other");
    await expect(s2.request(ctxOp(t2))).rejects.toThrow(/already T-001's/);
    host.setPane("w1:p1", { status: "idle" });
    await until("lead got it", () => ended(host, "0bridge-t-001").length === 1);
    await Bun.sleep(150);
    expect(started(host)).toHaveLength(1);
    expect(host.events("context_received")).toHaveLength(1);
    // A task host-task doesn't have is refused: nothing recorded, nothing made.
    await expect(s2.request({ ...ctxOp("T-404"), dedupe: "trello:b:other" })).rejects.toThrow(/unknown task/);
    expect(Object.keys(host.db().tasks)).toEqual([t, t2]);
  });

  test("Dots requests, follow-ups and answers carry who sent them; lead is told how the worker acknowledges", async () => {
    const { host, make } = setup();
    const s = make();
    const via = { client: "ChatGPT", kind: "oauth" as const };
    const r = (await s.request({ op: "host.request", requestId: "hr_prov00001", text: "Fix the date parser", title: "Date parser", via })) as HostRequestReply;
    const req = host.events("dots_request")[0]!;
    expect(String(req.data.text).split(NL)[0]).toBe('provenance: {"source":"dots","kind":"dots_request","client":"ChatGPT","via":"oauth","id":"hr_prov00001"}');
    expect(String(req.data.text)).toEndWith(`${NL}${NL}Fix the date parser`);
    await until("lead got it", () => started(host).length === 1);
    expect(started(host)[0]!.message).toContain("Request (from the user, through ChatGPT, an app of theirs):");
    expect(started(host)[0]!.message).toContain(`host-task emit --task ${r.task.id} --kind worker_ack --dedupe ack:hr_prov00001`);
    await s.request({ op: "host.followup", requestId: "hf_prov00001", task: r.task.id, text: "and the docs", via: { client: "my laptop", kind: "token" } });
    expect(String(host.events("dots_followup")[0]!.data.text).split(NL)[0]).toBe('provenance: {"source":"dots","kind":"dots_followup","client":"my laptop","via":"token","id":"hf_prov00001"}');
    // An answer: who answered in a record of its own, the answer's own text untouched.
    const q = host.emit("question_required", r.task.id, "A or B?")!;
    const ANS_ACK = `ha_${q}:m2q8x4c7v1k9p3ra`;
    await s.request({ op: "host.answer", question: q, text: "B", via, ack: ANS_ACK });
    expect(host.events("answer_pending")[0]!.data.text).toBe("B");
    expect(host.events("dots_answer")).toMatchObject([{ dedupe: `dots-answer:${q}`, data: { text: expect.stringContaining('"client":"ChatGPT"') } }]);
    await until("the answer with lead", () => started(host).some((c) => c.message?.includes(`question #${q}`)));
    const fwd = started(host).find((c) => c.message?.includes(`question #${q}`))!.message!;
    expect(fwd).toContain(`--dedupe ack:${ANS_ACK} `);
    expect(fwd).not.toContain(`ack:answer:${q}`);
  });

  test("a worker's ack counts only once lead has the item: before that, even with the right key, it's ignored and the item still goes", async () => {
    const { host, make, connect, frames } = setup({ opts: { contextRetryMs: 40 } });
    const t = host.create("Trello card work");
    host.bindNative(t, "w1:p1", SESSION, "working");
    const s = make();
    connect(s);
    s.onFrame({ t: "host-cursor", cursor: null });
    await until("resumed", () => s.status().resumed);
    expect(await s.request(ctxOp(t))).toMatchObject({ state: "pending" });
    host.emit("worker_ack", t, "early", `ack:${ACK}`);
    await until("the early ack read", () => frames.some((f) => f.events.some((e) => e.dedupe === `ack:${ACK}`)));
    expect(readSupervisorState(s.ctx).contexts[KEY]?.state).toBe("pending");
    host.setPane("w1:p1", { status: "idle" });
    await until("lead got it", () => ended(host, "0bridge-t-001").length === 1);
    expect(started(host)[0]!.message).toContain(`--dedupe ack:${ACK} `);
    // The early ack is read again (the hub never acked these frames): it still came before lead had it.
    await until("settled", () => readSupervisorState(s.ctx).contexts[KEY]?.state === "supervisor_reply");
    const sent = frames.length;
    await until("the log read again", () => frames.length > sent + 1);
    expect(readSupervisorState(s.ctx).contexts[KEY]?.state).toBe("supervisor_reply");
  });

  /** Context items as a restart finds them in the state file. */
  const seed = (ctx: { storeDir: string }, recs: Partial<ContextRecord>[]) => {
    const contexts = Object.fromEntries(
      recs.map((r, i) => {
        const rec: ContextRecord = { id: `hc_seed00000${i}`, task: "T-001", dedupe: `trello:b:a${i}`, provider: { kind: "trello", action: `a${i}` }, text: `comment ${i}`, state: "pending", detail: "t-001 is working", code: "busy", received: true, pendings: 1, nextAt: 0, at: Date.now(), tries: 0, ...r };
        return [rec.dedupe, rec];
      }),
    );
    mkdirSync(join(ctx.storeDir, "agent"), { recursive: true });
    writeFileSync(supervisorStatePath(ctx as never), JSON.stringify({ cursor: null, requests: {}, followups: {}, answers: {}, incoming: {}, contexts, queue: [], lastError: null }));
  };
  /** Counts the supervisor's `host-task show` and `herdr agent list` calls (when each started, and the most at once). */
  const spy = (s: HostSupervisor) => {
    const calls = { show: [] as number[], list: [] as number[], showing: 0, most: 0 };
    const show = s.host.show.bind(s.host);
    s.host.show = async (t: string) => {
      calls.show.push(Date.now());
      calls.most = Math.max(calls.most, ++calls.showing);
      try {
        return await show(t);
      } finally {
        calls.showing--;
      }
    };
    const list = s.herdr.list.bind(s.herdr);
    s.herdr.list = () => {
      calls.list.push(Date.now());
      return list();
    };
    return calls;
  };

  test("the pause before the next look doubles up to its cap; why it waits comes in a few kinds", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 50].map((n) => contextBackoff(n, 15_000, 600_000))).toEqual([15_000, 30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
    expect(["no-worker", "question", "focused", "blocked", "busy-working", "busy-unknown", "gone", "identity", "identity-changed", "herdr", "check-failed"].map(pendingKind)).toEqual([
      "no-worker", "question", "busy", "busy", "busy", "busy", "worker-changed", "worker-changed", "worker-changed", "unavailable", "unavailable",
    ]);
  });

  test("N items waiting for one busy task: one host-task show and one herdr list a round for all of them, rounds further apart each time, nothing recorded again", async () => {
    const { host, make, ctx } = setup({ opts: { contextRetryMs: 60, contextRetryMaxMs: 480 } });
    const t = host.create("Trello card work");
    host.bindNative(t, "w1:p1", SESSION, "working");
    seed(ctx, [0, 1, 2, 3, 4].map((i) => ({ task: t, dedupe: `trello:b:a${i}` })));
    const s = make();
    const calls = spy(s);
    // What each save wrote: every item's tries and when it's due next, and when it was saved.
    const snaps: { at: number; cs: { tries: number; nextAt: number }[] }[] = [];
    const save = s.save.bind(s);
    s.save = () => {
      snaps.push({ at: Date.now(), cs: Object.values(s.state.contexts).map((c) => ({ tries: c.tries ?? 0, nextAt: c.nextAt })) });
      save();
    };
    await until("five rounds", () => calls.list.length >= 5 && snaps.some((x) => x.cs.every((c) => c.tries === 5)), 20_000);
    s.stop();
    await Bun.sleep(400);
    expect(calls.show.length).toBe(calls.list.length);
    const tries = Object.values(readSupervisorState(ctx).contexts).map((c) => c.tries ?? 0);
    expect(tries).toHaveLength(5);
    // Every item was looked at in every round (the same count), and a round asked host-task once for all five.
    expect(new Set(tries).size).toBe(1);
    expect(calls.show.length).toBeLessThanOrEqual(tries[0]! + 1);
    // Rounds further apart, without timing the gaps: after round k every item is due exactly
    // contextBackoff(k) after that round's look (one time for all five, between the round's herdr
    // list and the save), and round k+1 starts no earlier than that.
    let due = 0;
    for (let k = 1; k <= 5; k++) {
      const snap = snaps.find((x) => x.cs.every((c) => c.tries === k))!;
      expect(snap).toBeDefined();
      const nextAts = new Set(snap.cs.map((c) => c.nextAt));
      expect(nextAts.size).toBe(1);
      const looked = [...nextAts][0]! - contextBackoff(k, 60, 480);
      expect(looked).toBeGreaterThanOrEqual(calls.list[k - 1]!);
      expect(looked).toBeLessThanOrEqual(snap.at);
      expect(calls.list[k - 1]!).toBeGreaterThanOrEqual(due);
      due = [...nextAts][0]!;
    }
    expect([1, 2, 3, 4, 5].map((k) => contextBackoff(k, 60, 480))).toEqual([60, 120, 240, 480, 480]);
    // Still busy, as before the restart: no context_pending again, nothing to lead.
    expect(host.events("context_pending")).toEqual([]);
    expect(started(host)).toEqual([]);
  });

  test("tasks' items are checked a few tasks at a time, with one herdr list for the round", async () => {
    const { host, make, ctx } = setup({ opts: { contextRetryMs: 5000 } });
    const tasks = [1, 2, 3, 4, 5, 6, 7].map((n) => {
      const t = host.create(`Card ${n}`);
      host.bindNative(t, `w1:p${n}`, `0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f${n}`, "working", t.toLowerCase());
      return t;
    });
    seed(ctx, tasks.map((task, i) => ({ task, dedupe: `trello:b:t${i}` })));
    const s = make();
    const calls = spy(s);
    await until("every task looked at", () => Object.values(readSupervisorState(ctx).contexts).every((c) => (c.tries ?? 0) >= 1), 20_000);
    expect(calls.show.length).toBe(7);
    expect(calls.list.length).toBe(1);
    expect(calls.most).toBeLessThanOrEqual(4);
  });

  test("an item that waited too long is refused with why; settled items keep no text and leave the state file after a week", async () => {
    const { host, make, ctx } = setup({ opts: { contextRetryMs: 40, contextMaxAgeMs: 5000 } });
    const t = host.create("Trello card work");
    host.bindNative(t, "w1:p1", SESSION, "working");
    const day = 86_400_000;
    seed(ctx, [
      { task: t, dedupe: "trello:b:old", at: Date.now() - 6000 },
      { task: t, dedupe: "trello:b:week", state: "refused", text: "", settledAt: Date.now() - 8 * day },
      { task: t, dedupe: "trello:b:acked", state: "worker_acked", text: "", settledAt: Date.now() - day },
    ]);
    const s = make();
    await until("refused", () => readSupervisorState(ctx).contexts["trello:b:old"]?.state === "refused");
    const st = readSupervisorState(ctx).contexts;
    expect(st["trello:b:old"]).toMatchObject({ text: "", detail: expect.stringMatching(/waited .* never got ready for it \(last: t-001 is working\)/) });
    await until("context_refused recorded", () => host.events("context_refused").length > 0);
    expect(host.events("context_refused").map((e) => e.dedupe)).toEqual(["context-refused:trello:b:old"]);
    expect(st["trello:b:week"]).toBeUndefined();
    expect(st["trello:b:acked"]).toBeDefined();
    expect(started(host)).toEqual([]);
    s.stop();
  });

  test("a task host-task no longer has: its items are refused, also one whose context_received can't be recorded any more, and never looked at again", async () => {
    const { host, make, ctx } = setup({ opts: { contextRetryMs: 40 } });
    const t = host.create("Trello card work");
    host.bindNative(t, "w1:p1", SESSION, "working");
    seed(ctx, [{ task: "T-404", dedupe: "trello:b:never", state: "recorded", received: false, code: undefined, detail: null }]);
    const s = make();
    await until("refused", () => readSupervisorState(ctx).contexts["trello:b:never"]?.state === "refused");
    expect(readSupervisorState(ctx).contexts["trello:b:never"]!.detail).toContain("host-task has no T-404 any more");
    expect(await s.request(ctxOp(t))).toMatchObject({ state: "pending" });
    host.remove(t);
    await until("refused too", () => readSupervisorState(ctx).contexts[KEY]?.state === "refused");
    expect(readSupervisorState(ctx).contexts[KEY]!.detail).toContain(`host-task has no ${t} any more`);
    const calls = spy(s);
    await Bun.sleep(300);
    expect([calls.show.length, calls.list.length]).toEqual([0, 0]);
    expect(started(host)).toEqual([]);
  });
});
