import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter, describeApproval, mapCodexNotification } from "../src/agent/adapters/codex.ts";
import type { AgentEvent } from "../src/agent/adapters/types.ts";
import { DEFAULT_DENY } from "../src/agent/policy.ts";

/**
 * `codex app-server` 0.157.0 messages. The handshake, thread and turn start and the user message
 * item were recorded on a machine without a Codex sign-in (ids and paths made up); the rest
 * follows the generated protocol types (codex-protocol/).
 */
const THREAD = "01a0f54e-54bc-7843-b051-1eece3b8e00d";
const TURN = "01a0f54e-54d3-7272-adcb-2311bb70614f";
const RECORDED = [
  { id: 1, result: { userAgent: "0bridge/0.157.0 (Ubuntu 26.4.0; x86_64) xterm-256color (0bridge; 1)", codexHome: "/home/u/.codex", platformFamily: "unix", platformOs: "linux" } },
  { method: "remoteControl/status/changed", params: { status: "disabled", serverName: "host", installationId: "x", environmentId: null }, emittedAtMs: 1 },
  { id: 2, result: { thread: { id: THREAD, sessionId: THREAD, preview: "", ephemeral: false, modelProvider: "openai", model: "gpt-6-astra", cwd: "/work/app", status: { type: "idle" } } } },
  { method: "thread/started", params: { thread: { id: THREAD, cwd: "/work/app" } } },
  { id: 3, result: { turn: { id: TURN, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: null, completedAt: null, durationMs: null } } },
  { method: "thread/status/changed", params: { threadId: THREAD, status: { type: "active", activeFlags: [] } } },
  { method: "turn/started", params: { threadId: THREAD, turn: { id: TURN, items: [], status: "inProgress", error: null } } },
  { method: "item/started", params: { item: { type: "userMessage", id: "u1", clientId: null, content: [{ type: "text", text: "add a test", text_elements: [] }] }, threadId: THREAD, turnId: TURN, startedAtMs: 1 } },
  { method: "error", params: { error: { message: "Reconnecting... 2/5", codexErrorInfo: null, additionalDetails: null, misalignment: null }, willRetry: true, threadId: THREAD, turnId: TURN } },
  // From the protocol types:
  { method: "item/started", params: { item: { type: "commandExecution", id: "c1", command: "npm test", cwd: "/work/app", processId: null, source: "agent", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null }, threadId: THREAD, turnId: TURN, startedAtMs: 2 } },
  { method: "item/agentMessage/delta", params: { threadId: THREAD, turnId: TURN, itemId: "m1", delta: "Added" } },
  { method: "item/completed", params: { item: { type: "agentMessage", id: "m1", text: "Added a test for the parser.", phase: null }, threadId: THREAD, turnId: TURN, completedAtMs: 3 } },
  { method: "item/completed", params: { item: { type: "fileChange", id: "f1", changes: [{ path: "src/parse.test.ts" }], status: "completed" }, threadId: THREAD, turnId: TURN, completedAtMs: 4 } },
  { method: "error", params: { error: { message: "stream disconnected", codexErrorInfo: null, additionalDetails: null, misalignment: null }, willRetry: false, threadId: THREAD, turnId: TURN } },
  { method: "turn/completed", params: { threadId: THREAD, turn: { id: TURN, items: [], status: "completed", error: null } } },
  { method: "turn/completed", params: { threadId: THREAD, turn: { id: TURN, items: [], status: "failed", error: { message: "usage limit reached" } } } },
];

describe("Codex app-server messages", () => {
  test("notifications become the events the user sees", () => {
    const events = RECORDED.flatMap((m) => mapCodexNotification(m).events);
    expect(events).toEqual([
      { kind: "tool", tool: "shell", summary: "npm test" },
      { kind: "text", text: "Added a test for the parser." },
      { kind: "tool", tool: "edit", summary: "src/parse.test.ts" },
      { kind: "error", error: "stream disconnected" },
      { kind: "turn", ok: true },
      { kind: "turn", ok: false, error: "usage limit reached" },
    ]);
    expect(mapCodexNotification(RECORDED[6]!).threadId).toBe(THREAD);
    expect(mapCodexNotification(RECORDED[3]!).threadId).toBe(THREAD);
  });

  test("approval requests: what is asked", () => {
    expect(describeApproval({ id: 9, method: "item/commandExecution/requestApproval", params: { kind: "command", threadId: THREAD, turnId: TURN, itemId: "c2", startedAtMs: 1, environmentId: null, command: "git push origin main", reason: "needs network" } })).toEqual({
      threadId: THREAD,
      tool: "shell",
      summary: "git push origin main",
      command: "git push origin main",
    });
    expect(describeApproval({ id: 10, method: "item/fileChange/requestApproval", params: { threadId: THREAD, turnId: TURN, itemId: "f2", startedAtMs: 1, grantRoot: "/etc" } })).toMatchObject({ tool: "edit", file: true, outside: true });
    expect(describeApproval({ id: 11, method: "item/tool/requestUserInput", params: { threadId: THREAD } })).toBeNull();
  });
});

/** A stand-in `codex app-server`: a scripted turn with two approval requests. */
function fakeCodex(dir: string): string {
  const bin = join(dir, "codex");
  writeFileSync(
    bin,
    `#!/usr/bin/env bun
const { appendFileSync } = require("node:fs");
const log = (o) => appendFileSync(${JSON.stringify(join(dir, "rpc.jsonl"))}, JSON.stringify(o) + "\\n");
if (process.argv[2] === "--version") { console.log("codex-cli 0.157.0"); process.exit(0); }
const T = "thr-1", U = "turn-1";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const n = (method, params) => out({ method, params: { threadId: T, turnId: U, ...params } });
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    log(m);
    if (m.method === "initialize") out({ id: m.id, result: { userAgent: "fake", codexHome: "/x", platformFamily: "unix", platformOs: "linux" } });
    else if (m.method === "thread/start" || m.method === "thread/resume") out({ id: m.id, result: { thread: { id: T, cwd: m.params.cwd } } });
    else if (m.method === "turn/start") {
      out({ id: m.id, result: { turn: { id: U, items: [], status: "inProgress", error: null } } });
      n("turn/started", { turn: { id: U, status: "inProgress" } });
      out({ id: 100, method: "item/commandExecution/requestApproval", params: { kind: "command", threadId: T, turnId: U, itemId: "c1", startedAtMs: 1, environmentId: null, command: "git push origin main" } });
      out({ id: 101, method: "item/commandExecution/requestApproval", params: { kind: "command", threadId: T, turnId: U, itemId: "c2", startedAtMs: 1, environmentId: null, command: "npm install left-pad" } });
      out({ id: 102, method: "item/fileChange/requestApproval", params: { threadId: T, turnId: U, itemId: "f1", startedAtMs: 1 } });
    } else if (m.id === 101) {
      n("item/completed", { item: { type: "agentMessage", id: "m1", text: "installed: " + m.result.decision } });
      n("turn/completed", { turn: { id: U, items: [], status: "completed", error: null } });
    }
  }
});
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

describe("Codex adapter", () => {
  for (const mode of ["edit", "auto", "plan"] as const)
    test(`approvals in ${mode} mode: refused commands declined at once, the rest asked (or decided by the mode)`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "0b-agent-codex-"));
      const adapter = new CodexAdapter({ deny: () => DEFAULT_DENY, bin: fakeCodex(dir) });
      expect(await adapter.available()).toMatchObject({ ok: true, version: "0.157.0" });
      const events: AgentEvent[] = [];
      let resolveAsk!: () => void;
      const asked = new Promise<void>((r) => (resolveAsk = r));
      const run = await adapter.start({ task: "t_codex1", cwd: dir, prompt: "add left-pad", mode }, (e) => {
        events.push(e);
        if (e.kind === "permission") resolveAsk();
      });
      expect(run.native).toBe("thr-1");
      if (mode === "plan") {
        // Plan declines whatever asks; the fake agent then finishes on its own.
      } else {
        await asked;
        const p = events.find((e) => e.kind === "permission") as Extract<AgentEvent, { kind: "permission" }>;
        expect(p).toMatchObject({ tool: "shell", summary: "npm install left-pad" });
        await run.approve(p.request, "allow");
      }
      const r = await run.done;
      expect(r).toEqual({ ok: true });
      const read = () => readFileSync(join(dir, "rpc.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      // The answers written as the run ended reach the fake a moment later.
      for (let i = 0; i < 50 && !read().some((m) => m.id === 102 && !m.method); i++) await Bun.sleep(20);
      const rpc = read();
      const start = rpc.find((m) => m.method === "thread/start");
      expect(start.params).toMatchObject({ cwd: dir, approvalPolicy: "on-request", sandbox: mode === "plan" ? "read-only" : "workspace-write", approvalsReviewer: "user" });
      expect(rpc.find((m) => m.method === "turn/start").params.input).toEqual([{ type: "text", text: "add left-pad", text_elements: [] }]);
      const answer = (id: number) => rpc.find((m) => m.id === id && !m.method)?.result?.decision;
      expect(answer(100)).toBe("decline");
      expect(answer(101)).toBe(mode === "plan" ? "decline" : "accept");
      // A file change inside the workspace: auto accepts it, edit leaves it to the user (declined when the run ends), plan declines.
      expect(answer(102)).toBe(mode === "auto" ? "accept" : "decline");
      expect(events.some((e) => e.kind === "text" && e.text.includes('rule "git push * main"'))).toBe(true);
      expect(events.filter((e) => e.kind === "permission")).toHaveLength(mode === "plan" ? 0 : mode === "auto" ? 1 : 2);
      adapter.close();
    });
});
