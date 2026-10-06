import { expect, test } from "bun:test";
import { deliverTrelloComment, trelloHostCommand, loadTrelloRelay, saveTrelloRelay, type TrelloRecord, type TrelloHostDeps } from "../src/trello-host.ts";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { deviceTokenKey, openSecretStore, saveCloud } from "@0bridge/core";
import { fakeHost } from "./fake-host.ts";
const board = "6ac3b9821dc2644f39df0761", card = "6ac3bfc599f65b6ce111fa26";
const event = (text = "Please review T-018 too", type = "commentCard") => ({ verified: true, data: { model: { id: board }, action: { id: "000000000000000000000001", type, data: { card: { id: card }, board: { id: board }, text } } } });
function harness() {
  const records = new Map<string, TrelloRecord>();
  const events: { task: string; kind: string; text: string }[] = [];
  const task = { task_id: "T-024", trello_card_id: `ari:cloud:trello::card/workspace/6711c9b5cf90da89afe23f73/${card}`, trello_board: "https://trello.com/b/Rmgi2lRQ/tasks", pane: "w2:p7", agent: "t-024", pending_question_event: null as number | null };
  const agent = { pane: "w2:p7", name: "t-024", status: "idle", focused: false, seq: 10 };
  let extra: typeof task[] = [];
  const d: TrelloHostDeps = {
    host: { list: async () => [task, ...extra], show: async () => task, emit: async (task, kind, text) => { events.push({ task, kind, text }); return { event: events.length }; } },
    records: { get: id => records.get(id), set: (id, r) => { records.set(id, r); } }, mask: s => s,
  };
  return { d, records, events, agent, task, prompts: 0, duplicate() { extra = [{ ...task, task_id: "T-018" }]; } };
}
function reply(input: Parameters<NonNullable<TrelloHostDeps["context"]>>[0], state: string) {
  return { delivery: { key: input.dedupe, kind: "context", task: input.task, state, provenance: { source: "context", provider: input.provider.kind, board: input.provider.board, card: input.provider.card, action: input.provider.action } } };
}
test("ARI mapping uses exact existing T-ID; queued, stored answers or worker activity are not acknowledgement", async () => {
  const h = harness();
  for (const state of ["recorded", "pending", "queued", "supervisor_reply", "delivered"]) {
    h.d.context = async input => { expect(input.task).toBe("T-024"); expect(input.text).toContain("T-018"); return reply(input, state); };
    h.agent.status = "working"; h.agent.seq++;
    expect((await deliverTrelloComment(board, event(), h.d)).status).toBe(state === "delivered" ? "unconfirmed" : "pending");
  }
  expect(h.events.some(e => e.kind === "trello_comment_delivered")).toBe(false);
});
test("only same-task/action common worker_ack confirms receipt, including replay after restart", async () => {
  const h = harness(), keys: string[] = [];
  h.d.context = async input => { keys.push(input.dedupe); return reply(input, keys.length === 1 ? "queued" : "worker_acked"); };
  expect((await deliverTrelloComment(board, event(), h.d)).status).toBe("pending");
  expect((await deliverTrelloComment(board, event(), { ...h.d })).status).toBe("delivered");
  expect(new Set(keys)).toEqual(new Set([`trello:${board}:000000000000000000000001`]));
  expect(h.events.every(e => e.task === "T-024")).toBe(true);
  expect(h.events.find(e => e.kind === "trello_comment_delivered")!.text).toContain("worker_acked for provider action");
  expect(JSON.stringify([...h.records.values()])).not.toContain("Please review");
});
test("wrong task, action, dedupe or provenance cannot confirm a worker receipt", async () => {
  for (const mutate of [
    (r: ReturnType<typeof reply>) => { r.delivery.task = "T-018"; },
    (r: ReturnType<typeof reply>) => { r.delivery.key += "-other"; },
    (r: ReturnType<typeof reply>) => { r.delivery.provenance.action = "other"; },
    (r: ReturnType<typeof reply>) => { r.delivery.provenance.provider = "github"; },
    (r: ReturnType<typeof reply>) => { r.delivery.kind = "followup"; },
  ]) {
    const h = harness(); h.d.context = async input => { const r = reply(input, "worker_acked"); mutate(r); return r; };
    expect((await deliverTrelloComment(board, event(), h.d)).status).toBe("unconfirmed");
    expect(h.events.some(e => e.kind === "trello_comment_delivered")).toBe(false);
  }
});
test("failed or old common endpoint preserves intent and safely retries the same action, without leaking errors", async () => {
  const h = harness(); h.d.context = async () => { throw new Error("credential-bearing diagnostic"); };
  const failed = await deliverTrelloComment(board, event(), h.d);
  expect(failed.status).toBe("pending"); expect(failed.detail).not.toContain("credential");
  h.d.context = async input => reply(input, "worker_acked");
  expect((await deliverTrelloComment(board, event(), { ...h.d })).status).toBe("delivered");
  await expect(deliverTrelloComment(board, event("changed"), h.d)).rejects.toThrow("conflicts");
  h.task.task_id = "T-018";
  await expect(deliverTrelloComment(board, event(), h.d)).rejects.toThrow("conflicts");
});
test("legacy typing or seq-based delivered record never becomes worker_ack or a second submission", async () => {
  for (const status of ["typing", "delivered"] as const) {
    const h = harness();
    h.records.set(`${board}:000000000000000000000001`, { status, task: "T-024", pane: "w2:p7", worker: "t-024", hash: new Bun.CryptoHasher("sha256").update("Please review T-018 too").digest("hex"), seq: 10 });
    h.d.context = async () => { throw new Error("must not resubmit legacy intent"); };
    h.agent.status = "working"; h.agent.seq = 20;
    expect((await deliverTrelloComment(board, event(), h.d)).status).toBe("unconfirmed");
    expect(h.events.some(e => e.kind === "trello_comment_delivered")).toBe(false);
    expect([...h.records.values()][0]!.status).toBe(status);
  }
});
test("own marker, list movement and partial-completion changes never complete a task or loop", async () => {
  const h = harness();
  for (const e of [event("[0bridge-sync:T-024] mirrored"), event("Done", "updateCard"), event("one check complete", "updateCheckItemStateOnCard")]) expect((await deliverTrelloComment(board, e, h.d)).status).toBe("ignored");
  expect(h.prompts).toBe(0); expect(h.events).toHaveLength(0);
});
test("malformed, unverified, wrong board or ambiguous mapping is refused", async () => {
  const h = harness();
  await expect(deliverTrelloComment(board, { ...event(), verified: false }, h.d)).rejects.toThrow("verified");
  await expect(deliverTrelloComment("000000000000000000000000", event(), h.d)).rejects.toThrow("board/action");
  h.duplicate(); await expect(deliverTrelloComment(board, event(), h.d)).rejects.toThrow("exactly one");
});
const done = "6ac3bd28ee18025f5f7f62b0", before = "6ac3bd24e892163bda6db6a9";
const move = (from = before, to = done) => {
  const e = event("ignored text mentioning T-018", "updateCard");
  return { ...e, data: { ...e.data, action: { ...e.data.action, data: { ...e.data.action.data, listBefore: { id: from }, listAfter: { id: to } } } } };
};
test("exact Done transition records only a proposal; focused worker, pending approval and partial criteria stay intact", async () => {
  const h = harness(); h.agent.focused = true; h.task.pending_question_event = 42;
  const original = JSON.stringify(h.task);
  expect(await deliverTrelloComment(board, move(), h.d)).toMatchObject({ status: "proposed", task: "T-024" });
  expect(h.events.map(e => e.kind)).toEqual(["trello_completion_proposed"]);
  expect(h.events[0]!.text).toContain("review every original contract condition");
  expect(JSON.stringify(h.task)).toBe(original); expect(h.prompts).toBe(0);
  h.task.task_id = "T-018";
  await expect(deliverTrelloComment(board, move(), h.d)).rejects.toThrow("conflicts");
});
test("same-list move, wrong destination, description edits and malformed list id do not propose completion", async () => {
  const h = harness();
  for (const e of [move(done), move(before, before), event("Done", "updateCard")]) expect((await deliverTrelloComment(board, e, h.d)).status).toBe("ignored");
  await expect(deliverTrelloComment(board, move(before, "Done"), h.d)).rejects.toThrow("board/action");
  h.duplicate(); await expect(deliverTrelloComment(board, move(), h.d)).rejects.toThrow("exactly one");
  expect(h.events).toHaveLength(0); expect(h.prompts).toBe(0);
});
test("verified host completion suppresses sync return; completed label or partial evidence alone still proposes", async () => {
  for (const verified of [false, true]) {
    const h = harness();
    Object.assign(h.task, { status: "completed", evidence: "original checks", contract: { criteria: [{ state: "met", evidence: "first" }, { state: verified ? "met" : "pending", evidence: verified ? "second" : "" }] } });
    expect((await deliverTrelloComment(board, move(), h.d)).status).toBe(verified ? "ignored" : "proposed");
    expect(h.events).toHaveLength(verified ? 0 : 1); expect(h.prompts).toBe(0);
  }
});
test("recorded proposal intent retries host emit after failure; changed action data is refused", async () => {
  const h = harness(), emit = h.d.host.emit;
  h.d.host.emit = async () => { throw new Error("host unavailable"); };
  await expect(deliverTrelloComment(board, move(), h.d)).rejects.toThrow("host unavailable");
  expect([...h.records.values()][0]!.status).toBe("proposing");
  h.d.host.emit = emit;
  await expect(deliverTrelloComment(board, move("000000000000000000000099"), h.d)).rejects.toThrow("conflicts");
  expect((await deliverTrelloComment(board, move(), h.d)).status).toBe("proposed");
  expect(h.events).toHaveLength(1); expect(h.prompts).toBe(0);
});
test("local relay opt-in persists across process restart, host dedupe and preserved agent policy; no account or supervisor required", async () => {
  const root = mkdtempSync(join(tmpdir(), "0b-trello-relay-"));
  const ctx = { home: root, storeDir: join(root, ".0bridge") };
  const host = fakeHost(join(root, "host"));
  const task = { ...harness().task, status: "working", contract: { criteria: [{ id: "one", state: "met", evidence: "first" }, { id: "two", state: "pending", evidence: "" }] } };
  // Seed only this isolated fixture. Never create a task in the developer's host database.
  writeFileSync(join(host.dir, "host-task.json"), JSON.stringify({ tasks: { "T-024": task }, events: [], seq: 0 }));
  const cli = (args: string[], input?: string) => spawnSync(process.execPath, [join(import.meta.dir, "../src/index.ts"), "webhook", ...args], { encoding: "utf8", input, env: { ...process.env, ZEROBRIDGE_USER_HOME: root, ZEROBRIDGE_DIR: ctx.storeDir, ZEROBRIDGE_SECRET_STORE: "file", BROWSER: "none", NO_COLOR: "1" } });
  try {
    expect(loadTrelloRelay(ctx)).toBeUndefined();
    await expect(trelloHostCommand(ctx, board, move())).rejects.toThrow("enable");
    const cfg = { enabled: true, board, doneList: done, hostTask: host.bins.hostTask };
    const configured = cli(["trello-relay", "configure"], JSON.stringify(cfg));
    expect(configured.status).toBe(0);
    const policyPath = join(ctx.storeDir, "agent.json"), policy = '{"enabled":false,"repos":[],"profiles":{"codex":{"keep":{"CODEX_HOME":"/preserved"}}}}';
    writeFileSync(policyPath, policy);
    for (let n = 0; n < 2; n++) {
      const run = cli(["trello-host", "--board", board], JSON.stringify(move()));
      expect(run.status).toBe(0); expect(JSON.parse(run.stdout).status).toBe("proposed");
      if (n === 0) {
        // Crash after host acknowledged, before the local intent was marked proposed.
        const dir = join(ctx.storeDir, "agent", "trello-comments");
        const path = join(dir, readdirSync(dir).find(f => f.endsWith(".json"))!);
        const intent = JSON.parse(readFileSync(path, "utf8")); intent.status = "proposing";
        writeFileSync(path, JSON.stringify(intent));
      }
    }
    expect(host.events("trello_completion_proposed")).toHaveLength(1);
    expect(host.task("T-024")).toEqual(task);
    const commentEvent = event(); commentEvent.data.action.id = "000000000000000000000002";
    const comment = cli(["trello-host", "--board", board], JSON.stringify(commentEvent));
    expect(comment.status).toBe(1); expect(JSON.parse(comment.stdout).status).toBe("pending");
    expect(host.events("trello_comment_delivered")).toHaveLength(0);
    expect(existsSync(join(host.dir, "herdr-calls.jsonl"))).toBe(false);
    expect(readFileSync(policyPath, "utf8")).toBe(policy);
    expect(cli(["trello-relay", "status"]).status).toBe(0);
    if (process.platform !== "win32") expect(statSync(join(ctx.storeDir, "trello-relay.json")).mode & 0o777).toBe(0o600);
    expect(cli(["trello-relay", "off"]).status).toBe(0);
    await expect(trelloHostCommand(ctx, board, move())).rejects.toThrow("enable");
    saveTrelloRelay(ctx, cfg);
    await expect(trelloHostCommand(ctx, "000000000000000000000099", move())).rejects.toThrow("board-scoped");
    const old = readFileSync(join(ctx.storeDir, "trello-relay.json"), "utf8");
    for (const bad of [{ ...cfg, hostTask: "--deliver" }, { ...cfg, secret: "unsupported" }, { ...cfg, doneList: "Done" }]) expect(() => saveTrelloRelay(ctx, bad)).toThrow("config needs");
    expect(readFileSync(join(ctx.storeDir, "trello-relay.json"), "utf8")).toBe(old);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("without common context capability retains host record pending and has no pane fallback", async () => {
  const h = harness();
  expect((await deliverTrelloComment(board, event(), h.d)).status).toBe("pending");
  expect(h.events.map(e => e.kind)).toEqual(["trello_comment_received"]);
  expect([...h.records.values()][0]!.status).toBe("context");
});
test("Done proposal uses common context and exact action ack without changing original conditions", async () => {
  const h = harness(), original = JSON.stringify(h.task);
  h.d.context = async input => { expect(input.text).toContain("Completion proposal only"); return reply(input, "queued"); };
  expect((await deliverTrelloComment(board, move(), h.d)).status).toBe("pending");
  expect(h.events.map(e => e.kind)).toEqual(["trello_completion_proposed"]);
  h.d.context = async input => reply(input, "worker_acked");
  expect((await deliverTrelloComment(board, move(), { ...h.d })).status).toBe("delivered");
  expect(h.events.some(e => e.kind === "trello_proposal_delivered")).toBe(true);
  expect(JSON.stringify(h.task)).toBe(original);
});
test("mapping changes between list and show refuse both comment and Done before context", async () => {
  for (const e of [event(), move()]) {
    const h = harness(); h.d.host.show = async () => ({ ...h.task, trello_card_id: "000000000000000000000099" });
    h.d.context = async () => { throw new Error("must not submit"); };
    await expect(deliverTrelloComment(board, e, h.d)).rejects.toThrow("mapping changed");
    expect(h.events).toHaveLength(0);
  }
});

test("real CLI REST binding: replay after fresh process stays pending until correlated common ack", async () => {
  const root = mkdtempSync(join(tmpdir(), "0b-trello-context-"));
  const ctx = { home: root, storeDir: join(root, ".0bridge") }, host = fakeHost(join(root, "host"));
  const requests: { task: string; dedupe: string }[] = [];
  let state = "queued";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    expect(new URL(req.url).pathname).toBe("/api/machines/host/context");
    expect(req.method).toBe("POST"); expect(req.headers.get("Authorization")).toBe("Bearer local-fixture-token");
    const input = await req.json(); requests.push(input);
    return Response.json({ ...reply(input, state), machine: "fixture", duplicate: requests.length > 1 }, { status: requests.length === 1 ? 201 : 200 });
  } });
  const previousStore = process.env.ZEROBRIDGE_SECRET_STORE;
  try {
    process.env.ZEROBRIDGE_SECRET_STORE = "file";
    const account = saveCloud(ctx, { server: `http://127.0.0.1:${server.port}`, userId: "fixture", login: "fixture", tokenId: "fixture" });
    openSecretStore(ctx.storeDir).set(deviceTokenKey(account), "local-fixture-token");
    writeFileSync(join(host.dir, "host-task.json"), JSON.stringify({ tasks: { "T-024": harness().task }, events: [], seq: 0 }));
    const policy = JSON.stringify({ enabled: true, repos: [], supervisor: { kind: "openclaw", agent: "lead", hostTask: host.bins.hostTask, herdr: host.bins.herdr, openclaw: host.bins.openclaw } });
    writeFileSync(join(ctx.storeDir, "agent.json"), policy);
    const cli = async (input: unknown) => {
      const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/index.ts"), "webhook", "trello-host", "--board", board], {
        stdin: new Response(JSON.stringify(input)), stdout: "pipe", stderr: "pipe",
        env: { ...process.env, ZEROBRIDGE_USER_HOME: root, ZEROBRIDGE_DIR: ctx.storeDir, ZEROBRIDGE_SECRET_STORE: "file", BROWSER: "none" },
      });
      const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      expect(err).toBe(""); return { code, out: JSON.parse(out) };
    };
    for (const input of [event(), move()]) {
      // Give Done a separate provider action id, as in real Trello.
      if (input.data.action.type === "updateCard") input.data.action.id = "000000000000000000000002";
      state = "queued";
      expect(await cli(input)).toMatchObject({ code: 1, out: { status: "pending", task: "T-024" } });
      state = "supervisor_reply";
      expect(await cli(input)).toMatchObject({ code: 1, out: { status: "pending" } });
      state = "worker_acked";
      expect(await cli(input)).toMatchObject({ code: 0, out: { status: "delivered" } });
    }
    expect(new Set(requests.map(r => r.task))).toEqual(new Set(["T-024"]));
    expect(new Set(requests.map(r => r.dedupe)).size).toBe(2);
    expect(host.events("trello_comment_delivered")).toHaveLength(1);
    expect(host.events("trello_proposal_delivered")).toHaveLength(1);
    expect(existsSync(join(host.dir, "herdr-calls.jsonl"))).toBe(false);
    expect(existsSync(join(host.dir, "openclaw-calls.jsonl"))).toBe(false);
    expect(readFileSync(join(ctx.storeDir, "agent.json"), "utf8")).toBe(policy);
  } finally {
    if (previousStore === undefined) delete process.env.ZEROBRIDGE_SECRET_STORE; else process.env.ZEROBRIDGE_SECRET_STORE = previousStore;
    server.stop(true); rmSync(root, { recursive: true, force: true });
  }
});
