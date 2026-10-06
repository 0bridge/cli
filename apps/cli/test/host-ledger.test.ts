import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { parseChoices } from "@0bridge/core/host";
import type { HostAnswerReply, HostContextReply, HostEventsFrame, HostFollowupReply, HostLookupReply, HostRequestReply } from "../src/agent/protocol.ts";
import { kst } from "../src/agent/ledger.ts";
import { supervisorConfig, supervisorInfo } from "../src/agent/policy.ts";
import { HostSupervisor, parseHostEvent, readSupervisorState, supervisorStatePath, type SupervisorOptions } from "../src/agent/supervisor.ts";
import { fakeHost } from "./fake-host.ts";
import { writeFileSync } from "node:fs";

/**
 * Ledger mode (docs/plans/dots-host.md, "Ledger mode"): what the user tells Dots, ChatGPT or
 * Claude through 0bridge goes into the host's work ledger (host-task's log) the way the host's
 * desk records the user's words, against the stand-in host-task in a temp dir:
 *   bun test apps/cli/test/host-ledger.test.ts
 */

const live: HostSupervisor[] = [];
afterEach(() => {
  for (const s of live.splice(0)) s.stop();
});

/** host-task text through a Windows .cmd shim is one line (argText). */
const NL = process.platform === "win32" ? " / " : "\n";
const VIA = { client: "ChatGPT", kind: "oauth" as const };

function setup() {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "0b-ledger-")));
  const ctx = { home: join(base, "home"), storeDir: join(base, "home", ".0bridge") };
  const host = fakeHost(join(base, "host"));
  const cfg = supervisorConfig({ kind: "ledger", label: "devlead", hostTask: host.bins.hostTask, pollMs: 30 })!;
  const frames: HostEventsFrame[] = [];
  const make = (extra: SupervisorOptions = {}) => {
    const s = new HostSupervisor(ctx, cfg, { retryMs: [40, 40, 40], ackMs: 400, ...extra });
    live.push(s);
    return s;
  };
  /** Connected to a hub that acks every frame at once, from the end of the log. */
  const connect = (s: HostSupervisor) => {
    s.connected((f) => {
      frames.push(f as HostEventsFrame);
      queueMicrotask(() => s.onFrame({ t: "host-ack", cursor: (f as HostEventsFrame).cursor }));
      return true;
    });
    s.onFrame({ t: "host-cursor", cursor: null });
  };
  return { base, ctx, host, cfg, frames, make, connect };
}

const until = async (what: string, fn: () => boolean, ms = 10_000) => {
  for (const end = Date.now() + ms; !fn(); ) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
};

/** Nothing ran but host-task: no task made, no agent, nothing typed. */
function nothingElse(h: ReturnType<typeof fakeHost>) {
  expect(h.openclawCalls()).toEqual([]);
  expect(h.herdrCalls()).toEqual([]);
  expect(h.hostTaskCalls().filter((c) => ["create", "set", "answer"].includes(c[0]!))).toEqual([]);
}

const HANDOFF = ["열린 PR 12개 중 무엇을 할지 정해 주세요.", "", "[선택지]", "A) 전부 닫기 — 다섯 가지를 닫습니다 (추천: 목표가 「열린 것 다 닫기」)", "B) 하나씩 — 번호마다 알려 주시면 반영합니다", "C) 나중에 — 지금은 닫지 않습니다", "기한: 없음"].join("\n");

describe("ledger mode: the config", () => {
  test("ledger and openclaw both parse; the hello names the kind, never a path", () => {
    expect(supervisorConfig({ kind: "ledger" })).toEqual({ kind: "ledger", label: null, hostTask: "host-task", pollMs: 3000 });
    expect(supervisorConfig({ kind: "ledger", label: " devlead ", hostTask: "/opt/bin/host-task", pollMs: 5 })).toEqual({ kind: "ledger", label: "devlead", hostTask: "/opt/bin/host-task", pollMs: 20 });
    expect(supervisorConfig({ kind: "ledger", hostTask: "--evil" })!.hostTask).toBe("host-task");
    expect(supervisorConfig({ kind: "openclaw", agent: "lead" })!.kind).toBe("openclaw");
    expect(supervisorInfo(supervisorConfig({ kind: "ledger", label: "devlead", hostTask: "/opt/bin/host-task" })!)).toEqual({ kind: "ledger", agent: "ledger", label: "devlead" });
    expect(supervisorInfo(supervisorConfig({ kind: "openclaw", agent: "lead", label: "x", hostTask: "/a/host-task" })!)).toEqual({ kind: "openclaw", agent: "lead", label: "x" });
  });

  test("[선택지] blocks: options with their names, what each does and the recommended one", () => {
    expect(parseChoices(HANDOFF)).toEqual([
      { key: "A", label: "전부 닫기", detail: "다섯 가지를 닫습니다 (추천: 목표가 「열린 것 다 닫기」)", recommended: true },
      { key: "B", label: "하나씩", detail: "번호마다 알려 주시면 반영합니다", recommended: false },
      { key: "C", label: "나중에", detail: "지금은 닫지 않습니다", recommended: false },
    ]);
    expect(parseChoices("완료했습니다. PR #12 머지.")).toEqual([]);
    expect(parseChoices("[선택지]\nA) 하나뿐 — 이것")).toEqual([]);
    const ev = parseHostEvent({ id: 9, at: 1, kind: "primary_handoff", task: "T-001", data: { text: HANDOFF }, dedupe: null })!;
    expect([ev.source, ev.options?.map((o) => o.key)]).toEqual(["devlead", ["A", "B", "C"]]);
    expect(parseHostEvent({ id: 10, at: 1, kind: "primary_handoff", task: "T-001", data: { text: "끝났습니다" }, dedupe: null })!.source).toBeNull();
  });

  test("0b agent supervisor ledger saves host-task's absolute path (found on PATH now: a service's PATH may not have it), shows the kind, and openclaw paths are absolute too", () => {
    const { host, ctx } = setup();
    // host-task by name, on this shell's PATH only.
    const env = { ...process.env, PATH: `${host.dir}${delimiter}${process.env.PATH}`, ZEROBRIDGE_USER_HOME: ctx.home, ZEROBRIDGE_DIR: ctx.storeDir, ZEROBRIDGE_SECRET_STORE: "file", NO_COLOR: "1" };
    const cli = (...args: string[]) => spawnSync("bun", [join(import.meta.dir, "../src/index.ts"), "agent", "supervisor", ...args], { env, encoding: "utf8" });
    const ok = cli("ledger", "--label", "devlead");
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("work ledger");
    const saved = JSON.parse(readFileSync(join(ctx.storeDir, "agent.json"), "utf8")).supervisor;
    expect(saved).toEqual({ kind: "ledger", label: "devlead", hostTask: resolve(host.bins.hostTask), pollMs: 3000 });
    expect(saved.hostTask).toBe(resolve(saved.hostTask));
    const st = cli("status");
    expect(st.stdout).toContain("ledger (devlead)");
    expect(st.stdout).toContain("kind: ledger");
    expect(st.stdout).toContain(`host-task: ${resolve(host.bins.hostTask)}`);
    // Not found: refused, nothing saved over it.
    const missing = cli("ledger", "--host-task", "no-such-host-task-here");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/host-task \(no-such-host-task-here\) doesn't run here: not found \(not on PATH; pass --host-task <path>\)/);
    // openclaw by names on PATH: saved as absolute paths.
    const oc = cli("openclaw", "--agent", "lead");
    expect(oc.status).toBe(0);
    const ocSaved = JSON.parse(readFileSync(join(ctx.storeDir, "agent.json"), "utf8")).supervisor;
    expect(ocSaved).toMatchObject({ kind: "openclaw", agent: "lead", label: null, hostTask: resolve(host.bins.hostTask), openclaw: resolve(host.bins.openclaw), herdr: resolve(host.bins.herdr) });
    expect(cli("status").stdout).toContain("openclaw/lead");
    expect(cli("ledger").status).toBe(0);
    expect(JSON.parse(readFileSync(join(ctx.storeDir, "agent.json"), "utf8")).supervisor).toEqual({ kind: "ledger", label: null, hostTask: resolve(host.bins.hostTask), pollMs: 3000 });
  });
});

describe("ledger mode: requests", () => {
  test("a request is a dev_request with the user's words exactly and where they came from, under dots-request:<id>; no task, no agent; the same id again, also after a restart, is the same event", async () => {
    const { host, make, ctx } = setup();
    const s = make();
    const text = "Dots에서 온 요청: 로그인 버그 고쳐줘\n둘째 줄도 그대로";
    const r = (await s.request({ op: "host.request", requestId: "hr_ledger0001", text, title: "로그인 버그", project: "0bridge", worker: "claude", priority: "P1", via: VIA })) as HostRequestReply;
    const dev = host.events("dev_request");
    expect(dev).toHaveLength(1);
    expect(r).toEqual({ task: null, dispatch: "recorded", receipt: { requestId: "hr_ledger0001", event: dev[0]!.id, task: null } });
    const at = readSupervisorState(ctx).ledger.hr_ledger0001!.at;
    expect(dev[0]).toMatchObject({ task: null, dedupe: "dots-request:hr_ledger0001" });
    expect(dev[0]!.data.text).toBe(`Dots에서 온 요청: 로그인 버그 고쳐줘${NL}둘째 줄도 그대로${NL}${NL}출처: ChatGPT via 0bridge · ${kst(at)} · 요청 hr_ledger0001`);
    expect(kst(Date.UTC(2026, 9, 6, 8, 31))).toBe("2026-10-06 17:31 KST");
    expect(host.db().tasks).toEqual({});
    nothingElse(host);
    // Kept without the text once host-task has it.
    expect(readSupervisorState(ctx).ledger.hr_ledger0001).toMatchObject({ event: dev[0]!.id, task: null, text: "" });

    const again = (await s.request({ op: "host.request", requestId: "hr_ledger0001", text, title: "x", via: VIA })) as HostRequestReply;
    expect(again).toEqual({ task: null, dispatch: "duplicate", receipt: { requestId: "hr_ledger0001", event: dev[0]!.id, task: null } });
    s.stop();
    const s2 = make();
    expect(((await s2.request({ op: "host.request", requestId: "hr_ledger0001", text, title: "x" })) as HostRequestReply).receipt).toEqual({ requestId: "hr_ledger0001", event: dev[0]!.id, task: null });
    expect(host.events("dev_request")).toHaveLength(1);
    // Two at once with one id: one event.
    const [a, b] = await Promise.all([s2.request({ op: "host.request", requestId: "hr_ledger0002", text: "둘", title: "x" }), s2.request({ op: "host.request", requestId: "hr_ledger0002", text: "둘", title: "x" })]);
    expect((a as HostRequestReply).receipt!.event).toBe((b as HostRequestReply).receipt!.event);
    expect(host.events("dev_request")).toHaveLength(2);
    await expect(s2.request({ op: "host.request", requestId: "hf_wrongkind", text: "x", title: "x" })).rejects.toThrow(/bad request id/);
    nothingElse(host);
  });

  test("a restart between taking a request and host-task having it records it once; one host-task already had is found by its dedupe key, not written again", async () => {
    const { host, make, ctx } = setup();
    // Taken, then the daemon stopped before host-task heard of it.
    const at = Date.UTC(2026, 9, 6, 8, 0);
    const state = readSupervisorState(ctx);
    state.ledger.hr_crash0001 = { id: "hr_crash0001", text: "재시작 전 요청", at, via: VIA, since: 0, event: null, task: null };
    // And one host-task got, with its event id not saved yet.
    const had = host.emit("dev_request", null, "이미 있던 요청", "dots-request:hr_crash0002")!;
    state.ledger.hr_crash0002 = { id: "hr_crash0002", text: "이미 있던 요청", at, since: 0, event: null, task: null };
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(ctx.storeDir, "agent"), { recursive: true });
    writeFileSync(supervisorStatePath(ctx), JSON.stringify(state));
    make();
    await until("both recorded", () => {
      const l = readSupervisorState(ctx).ledger;
      return l.hr_crash0001?.event != null && l.hr_crash0002?.event != null;
    });
    const dev = host.events("dev_request");
    expect(dev.map((e) => e.dedupe).sort()).toEqual(["dots-request:hr_crash0001", "dots-request:hr_crash0002"]);
    expect(readSupervisorState(ctx).ledger.hr_crash0002!.event).toBe(had);
    // The text has the time it was taken, not of the retry.
    expect(dev.find((e) => e.dedupe === "dots-request:hr_crash0001")!.data.text).toBe(`재시작 전 요청${NL}${NL}출처: ChatGPT via 0bridge · 2026-10-06 17:00 KST · 요청 hr_crash0001`);
    nothingElse(host);
  });

  test("linking: the first later event on a task that names the request id links it; request_linked once, the hub hears it, and lookups and the request's reply give the task", async () => {
    const { host, make, connect, frames } = setup();
    const s = make();
    connect(s);
    await until("the tail started", () => readSupervisorState(s.ctx).cursor !== null);
    const r = (await s.request({ op: "host.request", requestId: "hr_link00001", text: "결제 페이지 고쳐줘", title: "x", via: VIA })) as HostRequestReply;
    const devEvent = r.receipt!.event!;
    // The team triages: a task, without the id at first (nothing links), then its contract with the request's source.
    const t = host.create("결제 페이지 수정", { project: "0bridge" });
    host.event("task_contract_recorded", t, { request: "대표 원문: 「결제 페이지 고쳐줘」", goal: "결제 페이지 수정", source: `Dots via 0bridge, host-task dev_request event ${devEvent}, 요청 hr_link00001`, criteria: [] });
    // Another task naming an id this machine doesn't know, and the same id again later: no effect.
    const other = host.create("다른 일");
    host.event("task_contract_recorded", other, { source: "요청 hr_notmine001" });
    host.emit("user_followup", other, "hr_link00001 도 참고");
    await until("request_linked", () => host.events("request_linked").length === 1);
    expect(host.events("request_linked")[0]).toMatchObject({ task: t, dedupe: "request-linked:hr_link00001" });
    expect(String(host.events("request_linked")[0]!.data.text)).toContain(`hr_link00001 (dev_request event #${devEvent}) is ${t}`);
    await until("the hub got it", () => frames.some((f) => f.events.some((e) => e.kind === "request_linked")));
    expect(frames.flatMap((f) => f.events).find((e) => e.kind === "request_linked")).toMatchObject({ task: t, dedupe: "request-linked:hr_link00001" });
    expect(readSupervisorState(s.ctx).ledger.hr_link00001).toMatchObject({ task: t, announced: true });
    const look = (await s.request({ op: "host.lookup", request: "hr_link00001" })) as HostLookupReply;
    expect([look.task?.id, look.request]).toEqual([t, { requestId: "hr_link00001", event: devEvent, task: t }]);
    expect(await s.request({ op: "host.lookup", request: "hr_unknown001" })).toEqual({ task: null, question: null, request: null });
    const again = (await s.request({ op: "host.request", requestId: "hr_link00001", text: "결제 페이지 고쳐줘", title: "x" })) as HostRequestReply;
    expect([again.task?.id, again.dispatch, again.receipt?.task]).toEqual([t, "duplicate", t]);
    await Bun.sleep(150);
    expect(host.events("request_linked")).toHaveLength(1);
    nothingElse(host);
  });
});

describe("ledger mode: follow-ups and answers", () => {
  test("follow-ups: on a task as user_followup with its source; before the request has a task, on no task, saying which request; the same id again is the same event; an unknown task is refused", async () => {
    const { host, make, connect } = setup();
    const s = make();
    connect(s);
    await until("the tail started", () => readSupervisorState(s.ctx).cursor !== null);
    await s.request({ op: "host.request", requestId: "hr_fu0000001", text: "검색 느려", title: "x", via: VIA });
    // Not linked yet.
    const early = (await s.request({ op: "host.followup", requestId: "hf_fu0000001", request: "hr_fu0000001", text: "모바일에서 특히", via: VIA })) as HostFollowupReply;
    const e1 = host.events("user_followup")[0]!;
    expect(early).toEqual({ task: null, dispatch: "recorded", event: e1.id, request: "hr_fu0000001" });
    expect(e1).toMatchObject({ task: null, dedupe: "dots-followup:hf_fu0000001" });
    const at1 = readSupervisorState(s.ctx).ledgerFollowups.hf_fu0000001!.at;
    expect(e1.data.text).toBe(`(요청 hr_fu0000001 후속) 모바일에서 특히${NL}${NL}출처: ChatGPT via 0bridge · ${kst(at1)} · 후속 hf_fu0000001`);
    expect(await s.request({ op: "host.followup", requestId: "hf_fu0000001", request: "hr_fu0000001", text: "모바일에서 특히" })).toEqual({ ...early, dispatch: "duplicate" });
    expect(host.events("user_followup")).toHaveLength(1);

    // The team makes the task with the id; a follow-up by the request goes on it, naming the request.
    const t = host.create("검색 속도");
    host.event("task_contract_recorded", t, { source: "dev_request 요청 hr_fu0000001" });
    await until("linked", () => readSupervisorState(s.ctx).ledger.hr_fu0000001?.task === t);
    const late = (await s.request({ op: "host.followup", requestId: "hf_fu0000002", request: "hr_fu0000001", text: "PC는 괜찮아", via: VIA })) as HostFollowupReply;
    expect([late.task, late.dispatch, late.request]).toEqual([t, "recorded", "hr_fu0000001"]);
    const e2 = host.events("user_followup").find((e) => e.dedupe === "dots-followup:hf_fu0000002")!;
    expect(e2.task).toBe(t);
    expect(e2.data.text).toBe(`PC는 괜찮아${NL}${NL}출처: ChatGPT via 0bridge · ${kst(readSupervisorState(s.ctx).ledgerFollowups.hf_fu0000002!.at)} · 후속 hf_fu0000002 · 요청 hr_fu0000001`);
    // By the task id: the same, and it still names the request the task came from.
    const byTask = (await s.request({ op: "host.followup", requestId: "hf_fu0000003", task: t, text: "급하진 않아" })) as HostFollowupReply;
    expect([byTask.task, byTask.request]).toEqual([t, "hr_fu0000001"]);
    expect(host.events("user_followup").find((e) => e.dedupe === "dots-followup:hf_fu0000003")!.data.text).toEndWith(`· 후속 hf_fu0000003 · 요청 hr_fu0000001`);
    // A task id host-task doesn't have: refused, nothing kept.
    await expect(s.request({ op: "host.followup", requestId: "hf_fu0000004", task: "T-099", text: "x" })).rejects.toThrow(/unknown task: T-099/);
    expect(readSupervisorState(s.ctx).ledgerFollowups.hf_fu0000004).toBeUndefined();
    await expect(s.request({ op: "host.followup", requestId: "hf_fu0000005", text: "x" })).rejects.toThrow(/bad task id/);
    nothingElse(host);
  });

  test("the team's [선택지] question: the answer is a user_decision on its task with the option's raw value; again is the same; nothing typed, nothing to openclaw", async () => {
    const { host, make } = setup();
    const s = make();
    const t = host.create("PR 정리");
    host.assign(t, "w1:p3", "idle");
    const q = host.emit("primary_handoff", t, HANDOFF)!;
    const look = (await s.request({ op: "host.lookup", question: q })) as HostLookupReply;
    expect(look.question).toMatchObject({ question: q, task: t, source: "devlead" });
    expect(await s.request({ op: "host.questions" })).toEqual({ questions: [] });

    const a = (await s.request({ op: "host.answer", question: q, text: "A로 해 줘", choice: "a", via: VIA })) as HostAnswerReply;
    const dec = host.events("user_decision");
    expect(dec).toHaveLength(1);
    expect(a).toMatchObject({ question: q, task: t, status: "recorded", event: dec[0]!.id });
    expect(a.detail).toContain("nothing was typed into any pane");
    expect(dec[0]).toMatchObject({ task: t, dedupe: `dots-decision:${q}` });
    const at = readSupervisorState(s.ctx).ledgerAnswers[String(q)]!.at;
    expect(dec[0]!.data.text).toBe(`choice: ${t}|e${q}|A / 선택: A) 전부 닫기${NL}A로 해 줘${NL}${NL}(질문 #${q} 답) 출처: ChatGPT via 0bridge · ${kst(at)}`);
    // The same answer again: the same record. Another one: refused (a follow-up says more).
    expect(await s.request({ op: "host.answer", question: q, text: "A로 해 줘", choice: "A" })).toEqual(a);
    const other = (await s.request({ op: "host.answer", question: q, text: "아니 B" })) as HostAnswerReply;
    expect(other).toMatchObject({ status: "refused", detail: expect.stringContaining("already answered") });
    expect(host.events("user_decision")).toHaveLength(1);
    // Never typed, never a host-task answer, never openclaw.
    expect(host.pane("w1:p3")!.typed ?? []).toEqual([]);
    expect(host.events("answer_pending")).toEqual([]);
    nothingElse(host);
  });

  test("answers that aren't to a question, or name an option it doesn't have, are refused; a worker's question is answered as a decision too", async () => {
    const { host, make } = setup();
    const s = make();
    const t = host.create("작업");
    const q = host.emit("primary_handoff", t, HANDOFF)!;
    expect(await s.request({ op: "host.answer", question: q, text: "Z", choice: "Z" })).toMatchObject({ status: "refused", detail: expect.stringContaining("isn't one of") });
    const note = host.emit("primary_handoff", t, "진행 상황: 테스트 중입니다.")!;
    expect(await s.request({ op: "host.answer", question: note, text: "좋아" })).toMatchObject({ status: "refused", detail: expect.stringContaining("isn't a question") });
    const wq = host.emit("question_required", t, "Postgres or SQLite?")!;
    const r = (await s.request({ op: "host.answer", question: wq, text: "SQLite" })) as HostAnswerReply;
    expect(r).toMatchObject({ status: "recorded", task: t });
    expect(host.events("user_decision").map((e) => e.dedupe)).toEqual([`dots-decision:${wq}`]);
    expect(await s.request({ op: "host.answer", question: wq, text: "SQLite", choice: "A" })).toMatchObject({ status: "refused" });
    nothingElse(host);
  });

  test("outside context: kept as context_received on the task with its provenance, not passed on (refused, with why), once per key; never a user_followup", async () => {
    const { host, make } = setup();
    const s = make();
    const t = host.create("카드 작업");
    const op = { op: "host.context" as const, id: "hc_t5hbjyezpfzsz6yh", task: t, dedupe: "trello:b1:act1", provider: { kind: "trello", board: "b1", card: "c1", action: "act1" }, text: "카드 댓글" };
    const r = (await s.request(op)) as HostContextReply;
    const got = host.events("context_received");
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ task: t, dedupe: "context:trello:b1:act1" });
    expect(r.state).toBe("refused");
    expect(r.detail ?? "").toContain(`context_received (host event #${got[0]!.id})`);
    expect(r.detail ?? "").toContain("relays no outside context");
    expect(await s.request(op)).toEqual(r);
    expect(host.events("context_received")).toHaveLength(1);
    expect(host.events("user_followup")).toEqual([]);
    nothingElse(host);
  });

  test("status and the tail work as in OpenClaw mode; status() says the kind", async () => {
    const { host, make, connect, frames } = setup();
    const s = make();
    expect(s.info()).toEqual({ kind: "ledger", agent: "ledger", label: "devlead" });
    connect(s);
    await until("the tail started", () => readSupervisorState(s.ctx).cursor !== null);
    const t = host.create("상태");
    const q = host.emit("primary_handoff", t, HANDOFF)!;
    await until("the question at the hub", () => frames.some((f) => f.events.some((e) => e.id === q)));
    expect(frames.flatMap((f) => f.events).find((e) => e.id === q)).toMatchObject({ kind: "primary_handoff", task: t, source: "devlead", options: [{ key: "A" }, { key: "B" }, { key: "C" }] });
    expect(((await s.request({ op: "host.status", task: t })) as { tasks: { id: string }[] }).tasks.map((x) => x.id)).toEqual([t]);
    expect(s.status()).toMatchObject({ kind: "ledger", agent: null, label: "devlead", ledger: { requests: 0, waiting: 0 } });
  });
});
