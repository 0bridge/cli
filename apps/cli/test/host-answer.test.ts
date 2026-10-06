import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keysText, parseAgentList } from "../src/agent/host-answer.ts";
import { supervisorConfig } from "../src/agent/policy.ts";
import type { HostAnswerReply } from "../src/agent/protocol.ts";
import { HostSupervisor, readSupervisorState, supervisorStatePath, type CrashStep, type SupervisorOptions } from "../src/agent/supervisor.ts";
import { writeAtomic } from "@0bridge/core";
import { fakeHost, type FakeHost, type FakePane } from "./fake-host.ts";

/** Answers to the host's questions, typed into the asking worker's pane through the stand-in herdr. */
const live: HostSupervisor[] = [];
afterEach(() => {
  for (const s of live.splice(0)) s.stop();
});

function setup(panes: FakePane[] = []) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "0b-host-answer-")));
  const ctx = { home: join(base, "home"), storeDir: join(base, "home", ".0bridge") };
  const host = fakeHost(join(base, "host"), { panes });
  const cfg = supervisorConfig({ kind: "openclaw", agent: "lead", label: "dev-herdr-agent", hostTask: host.bins.hostTask, openclaw: host.bins.openclaw, herdr: host.bins.herdr, pollMs: 50 })!;
  const make = (extra: SupervisorOptions = {}) => {
    const s = new HostSupervisor(ctx, cfg, { retryMs: [40], answer: { replyMs: 4000, confirmMs: 1500, unconfirmedMs: 600 }, ...extra });
    live.push(s);
    return s;
  };
  const s = make();
  const answer = (question: number, text: string) => s.request({ op: "host.answer", question, text }) as Promise<HostAnswerReply>;
  return { ctx, host, s, make, answer };
}

const until = async (what: string, fn: () => boolean, ms = 10_000) => {
  for (const end = Date.now() + ms; !fn(); ) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
};

/** What reached each pane: send-text, keys and prompts. */
const typedInto = (h: FakeHost, pane: string) => h.pane(pane)?.typed ?? [];
const keysTo = (h: FakeHost) => h.herdrCalls().filter((c) => (c[0] === "pane" && (c[1] === "send-text" || c[1] === "send-keys")) || (c[0] === "agent" && c[1] === "prompt"));
const forwarded = (h: FakeHost) => h.openclawCalls().filter((c) => c.ev === "start" && /\[0bridge answer for question/.test(c.message ?? ""));

describe("answer delivery", () => {
  test("a blocked worker gets the answer typed in its own pane, herdr shows it taken, answer_delivered once", async () => {
    const { host, answer } = setup([{ pane: "w1:p9", name: "t-002", status: "blocked", seq: 4 }]);
    const t1 = host.create("Fix login");
    host.create("Other task");
    host.assign("T-002", "w1:p9", "blocked");
    const q = host.block(t1, "w1:p3", "Use Postgres or SQLite?");
    const r = await answer(q, "SQLite");
    expect(r).toMatchObject({ question: q, task: "T-001", status: "delivered", worker: "t-001", pane: "w1:p3", confirmation: { from: "blocked", to: "working" } });
    expect(r.confirmation!.event).toBeNumber();
    expect(typedInto(host, "w1:p3")).toEqual(["SQLite", "<enter>"]);
    // The other worker, blocked too, got nothing.
    expect(typedInto(host, "w1:p9")).toEqual([]);
    expect(host.events("answer_pending")).toEqual([expect.objectContaining({ dedupe: `answer:${q}`, data: expect.objectContaining({ text: "SQLite", target: "w1:p3" }) })]);
    const delivered = host.events("answer_delivered");
    expect(delivered).toEqual([expect.objectContaining({ id: r.confirmation!.event, task: "T-001", dedupe: `answer-delivered:${q}` })]);
    expect(delivered[0]!.data.text).toBe(`question #${q} → t-001 (pane w1:p3): blocked → working`);

    // Again: the same result, nothing typed.
    const n = keysTo(host).length;
    expect(await answer(q, "SQLite")).toEqual(r);
    expect(keysTo(host).length).toBe(n);
    // A different answer to the same question: refused, nothing typed.
    expect(await answer(q, "Postgres")).toMatchObject({ status: "refused", detail: expect.stringMatching(/already answered with a different answer/) });
    expect(keysTo(host).length).toBe(n);
    expect(host.events("answer_delivered")).toHaveLength(1);
  });

  test("a newer question, or something that isn't one: refused, nothing typed", async () => {
    const { host, answer } = setup();
    const t = host.create("Fix login");
    const old = host.block(t, "w1:p3", "First?");
    const current = host.block(t, "w1:p3", "Second?");
    expect(await answer(old, "yes")).toMatchObject({ status: "refused", current, detail: expect.stringMatching(/isn't the current one/) });
    expect(await answer(1, "yes")).toMatchObject({ status: "refused", detail: expect.stringMatching(/isn't a question/) });
    expect(await answer(999, "yes")).toMatchObject({ status: "refused" });
    expect(keysTo(host)).toEqual([]);
    expect(forwarded(host)).toEqual([]);
  });

  test("a pane that runs someone else, or is gone: never typed into; the supervisor gets it with the question id", async () => {
    const { host, answer } = setup();
    const a = host.create("A");
    const b = host.create("B");
    const qa = host.block(a, "w1:p3", "A?");
    // herdr now shows another worker in that pane.
    host.setPane("w1:p3", { name: "t-007" });
    const ra = await answer(qa, "yes");
    expect(ra).toMatchObject({ status: "forwarded", task: a, detail: expect.stringMatching(/w1:p3 runs t-007 now, not t-001/) });
    const qb = host.block(b, "w1:p4", "B?");
    host.setPane("w1:p4", { pane: "w9:p9" });
    expect(await answer(qb, "no")).toMatchObject({ status: "forwarded", detail: expect.stringMatching(/pane w1:p4 is gone/) });
    expect(keysTo(host)).toEqual([]);
    await until("both passed on", () => forwarded(host).length === 2);
    const m = forwarded(host).find((c) => c.key === "0bridge-t-001")!;
    expect(m.message).toContain(`[0bridge answer for question #${qa} on T-001]`);
    expect(m.message).toContain(`Check that #${qa} still waits for this answer`);
    expect(host.events("answer_forwarded").map((e) => e.dedupe)).toEqual([`answer-forwarded:${qa}`, `answer-forwarded:${qb}`]);
    // Asked again: the same reply, no second message.
    expect(await answer(qa, "yes")).toEqual(ra);
    await Bun.sleep(100);
    expect(forwarded(host)).toHaveLength(2);
  });

  test("a focused pane isn't typed into: pending, and the supervisor has it", async () => {
    const { host, answer } = setup();
    const t = host.create("A");
    const q = host.block(t, "w1:p3", "A?");
    host.setPane("w1:p3", { focused: true });
    const r = await answer(q, "yes");
    expect(r).toMatchObject({ status: "pending", detail: expect.stringMatching(/focused on the host/) });
    expect(keysTo(host)).toEqual([]);
    await until("passed on", () => forwarded(host).length === 1);
    expect(forwarded(host)[0]!.message).toMatch(/focused on the host/);
  });

  test("typed but never taken: answer_unconfirmed and the supervisor told, never typed twice", async () => {
    const { host, answer, ctx } = setup();
    const t = host.create("A");
    const q = host.block(t, "w1:p3", "A?");
    host.setPane("w1:p3", { onInput: "stuck" });
    const r = await answer(q, "yes");
    expect(r).toMatchObject({ status: "pending", detail: expect.stringMatching(/typed into t-001's pane/) });
    expect(typedInto(host, "w1:p3")).toEqual(["yes", "<enter>"]);
    // Asked again while it's being watched: pending, nothing typed.
    expect((await answer(q, "yes")).status).toBe("pending");
    await until("answer_unconfirmed", () => host.events("answer_unconfirmed").length === 1);
    await until("the supervisor told", () => forwarded(host).length === 1);
    expect(forwarded(host)[0]!.message).toMatch(/don't type it again/);
    expect(typedInto(host, "w1:p3")).toEqual(["yes", "<enter>"]);
    expect(host.events("answer_delivered")).toEqual([]);
    expect(readSupervisorState(ctx).answers[String(q)]!.status).toBe("unconfirmed");
    expect((await answer(q, "yes")).status).toBe("pending");
    expect(typedInto(host, "w1:p3")).toHaveLength(2);
  });

  test("a question the worker emitted itself: herdr-watch takes it off the task, and the answer goes to the supervisor with its id and task, never typed", async () => {
    const { host, answer } = setup();
    const t = host.create("A");
    host.assign(t, "w1:p3", "idle");
    const q = host.emit("question_required", t, "Ship it?")!;
    // herdr-watch's next pass (every 5 s on the host): the worker isn't blocked, so the task's current question goes.
    host.watch();
    expect(host.task(t)!.pending_question_event).toBeUndefined();
    const r = await answer(q, "yes, ship");
    expect(r).toMatchObject({ question: q, task: "T-001", status: "forwarded", detail: "the worker recorded this question itself (host-task emit), so no prompt in its pane waits for the answer" });
    expect(keysTo(host)).toEqual([]);
    await until("lead has it", () => forwarded(host).length === 1);
    const m = forwarded(host)[0]!;
    expect(m.key).toBe("0bridge-t-001");
    expect(m.message).toContain(`[0bridge answer for question #${q} on T-001]`);
    expect(m.message).toContain("yes, ship");
    expect(host.events("answer_forwarded")).toEqual([expect.objectContaining({ task: "T-001", dedupe: `answer-forwarded:${q}` })]);
    // Again: the same reply, no second message; a different answer is refused.
    expect(await answer(q, "yes, ship")).toEqual(r);
    expect((await answer(q, "no")).status).toBe("refused");
    await Bun.sleep(100);
    expect(forwarded(host)).toHaveLength(1);
    expect(keysTo(host)).toEqual([]);
  });

  test("a worker's own question while its pane is blocked at another prompt: forwarded, nothing typed at that prompt", async () => {
    const { host, answer } = setup();
    const t = host.create("A");
    host.assign(t, "w1:p3", "idle");
    const own = host.emit("question_required", t, "Which file?")!;
    // Then it stops at a tool-permission prompt (herdr-watch raises that one).
    host.block(t, "w1:p3", "Allow Bash: rm -rf build?");
    const r = await answer(own, "main.ts");
    expect(r).toMatchObject({ status: "forwarded" });
    expect(typedInto(host, "w1:p3")).toEqual([]);
    expect(host.pane("w1:p3")!.status).toBe("blocked");
    await until("lead has it", () => forwarded(host).length === 1);
  });

  test("a blocked worker gets one line: a lone CR, escape sequences and other control characters are typed as spaces", async () => {
    const { host, answer } = setup();
    const t = host.create("Fix login");
    const q = host.block(t, "w1:p3", "Allow?");
    expect(await answer(q, "1\r\u001b[B\r\u009b2\nyes")).toMatchObject({ status: "delivered" });
    expect(typedInto(host, "w1:p3")).toEqual(["1  [B  2 yes", "<enter>"]);
    expect(keysText("a\r\nb\u0007c\u007f")).toBe("a b c ");
  });

  test("a daemon that stopped mid-typing never types again: it only watches, then records what it saw", async () => {
    const { host, ctx, s, make, answer } = setup();
    const t = host.create("A");
    const q = host.block(t, "w1:p3", "A?");
    // What the state file holds when the daemon stopped right after the keys went (the worker took them).
    s.stop();
    host.setPane("w1:p3", { status: "working", seq: 9 });
    const st = readSupervisorState(ctx);
    st.answers[String(q)] = { status: "typing", hash: "x", task: t, at: Date.now(), text: "yes", pane: "w1:p3", worker: "t-001", from: "blocked", seq: 1 };
    writeAtomic(supervisorStatePath(ctx), JSON.stringify(st));
    const after = make();
    await until("recorded as delivered", () => readSupervisorState(ctx).answers[String(q)]?.status === "delivered");
    expect(host.events("answer_delivered")).toHaveLength(1);
    expect(keysTo(host)).toEqual([]);
    expect(((await after.request({ op: "host.answer", question: q, text: "no" })) as HostAnswerReply).status).toBe("refused");
    expect(keysTo(host)).toEqual([]);
    void answer;
  });

  /** A supervisor that dies at `step`: stopped there, so nothing after it runs or is saved (a crash). */
  const dying = (step: CrashStep): SupervisorOptions => ({ seam: (at, sup) => at === step && sup.stop() });

  test("stopped after host-task stored the answer: nothing else happens (no keys, no message, no answer_forwarded); the retry delivers it", async () => {
    const { host, ctx, s, make } = setup();
    s.stop();
    const t = host.create("A");
    host.assign(t, "w1:p3", "idle");
    const q = host.emit("question_required", t, "Ship it?")!;
    const dies = make(dying("answer-stored"));
    await expect(dies.request({ op: "host.answer", question: q, text: "yes" })).rejects.toThrow(/stopped/);
    expect(host.events("answer_pending")).toHaveLength(1);
    await Bun.sleep(150);
    expect([host.events("answer_forwarded"), forwarded(host), keysTo(host), readSupervisorState(ctx).answers]).toEqual([[], [], [], {}]);
    // The hub's retry, after the restart: host-task has the same answer, so it goes on from there.
    const after = make();
    expect(((await after.request({ op: "host.answer", question: q, text: "yes" })) as HostAnswerReply).status).toBe("forwarded");
    await until("lead has it once", () => forwarded(host).length === 1);
    expect(host.events("answer_forwarded")).toHaveLength(1);
  });

  test("stopped after the supervisor's message was queued: the retry finishes passing it on and never types it, though the pane is free by then", async () => {
    const { host, ctx, s, make } = setup();
    s.stop();
    const t = host.create("A");
    const q = host.block(t, "w1:p3", "A?");
    host.setPane("w1:p3", { focused: true });
    host.hold(t);
    const dies = make(dying("answer-queued"));
    await expect(dies.request({ op: "host.answer", question: q, text: "yes" })).rejects.toThrow(/stopped/);
    const st = readSupervisorState(ctx);
    expect(st.answers[String(q)]).toMatchObject({ status: "forwarding", queued: true });
    expect(st.queue.map((d) => d.id)).toEqual([`ha_${q}`]);
    expect(host.events("answer_forwarded")).toEqual([]);
    // Nobody has the pane focused now, and it still waits at the question.
    host.setPane("w1:p3", { focused: false });
    const after = make();
    const r = (await after.request({ op: "host.answer", question: q, text: "yes" })) as HostAnswerReply;
    expect(r).toMatchObject({ status: "pending", detail: expect.stringMatching(/focused/) });
    expect(keysTo(host)).toEqual([]);
    expect(host.events("answer_forwarded")).toHaveLength(1);
    host.release(t);
    // The run the crash cut off may have started too; lead has only this answer (the message says to ignore a copy).
    await until("lead has it", () => host.openclawCalls().some((c) => c.ev === "end" && c.id === String(q)));
    expect(new Set(forwarded(host).map((c) => c.id))).toEqual(new Set([String(q)]));
    expect(keysTo(host)).toEqual([]);
  });

  test("herdr's agent list", () => {
    expect(parseAgentList(JSON.stringify({ result: { agents: [{ pane_id: "w1:p3", name: "t-001", agent_status: "blocked", focused: true, state_change_seq: 7 }, { name: "no pane" }] } }))).toEqual([
      { pane: "w1:p3", name: "t-001", status: "blocked", focused: true, seq: 7, session: null },
    ]);
    expect(parseAgentList("nope")).toBeNull();
    expect(parseAgentList("{}")).toBeNull();
  });
});

describe("herdr's own output", () => {
  test("agent list as herdr 0.9.1 prints it (seen on dgithost, 2026-10-06; ids made up)", () => {
    const out = JSON.stringify({ id: "cli:agent:list", result: { agents: [
      { agent: "claude", agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value: "s-1" }, agent_status: "working", cwd: "/w", focused: false, foreground_cwd: "/w", pane_id: "w2:p4", revision: 3, state_change_seq: 164, tab_id: "w2:t4", terminal_id: "t1", terminal_title: "x", terminal_title_stripped: "x", workspace_id: "w2" },
      { agent: "codex", agent_status: "idle", focused: true, pane_id: "w6:p6", state_change_seq: 144, tab_id: "w6:t6", workspace_id: "w6" },
    ] } });
    const list = parseAgentList(out)!;
    expect(list.map((a) => [a.pane, a.status, a.focused, a.seq])).toEqual([["w2:p4", "working", false, 164], ["w6:p6", "idle", true, 144]]);
    // The native session herdr reports ({value}, or a plain string): what host-task binds a worker by.
    expect(list.map((a) => a.session)).toEqual(["s-1", null]);
    expect(parseAgentList(JSON.stringify({ result: { agents: [{ pane_id: "w1:p1", agent_session: "abc" }] } }))![0]!.session).toBe("abc");
  });
});
