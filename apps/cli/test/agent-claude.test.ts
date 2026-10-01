import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter, parseClaudeLine, userMessage } from "../src/agent/adapters/claude.ts";
import type { AgentEvent } from "../src/agent/adapters/types.ts";
import { fakeBin } from "./fake-bin.ts";

/**
 * Claude Code's stream-json, as `claude -p --output-format stream-json --verbose` 2.1.286 writes
 * it (recorded, trimmed, ids and paths made up). The last result is a real one from a machine
 * that isn't signed in.
 */
const SID = "3f0c9a8e-1b2d-4c5e-8f70-112233445566";
const RECORDED = [
  { type: "system", subtype: "init", cwd: "/work/app", session_id: SID, tools: ["Bash", "Edit", "Read", "Write"], mcp_servers: [{ name: "0bperm", status: "connected" }], model: "claude-opus-5-5", permissionMode: "acceptEdits" },
  { type: "assistant", message: { id: "msg_01", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "thinking", thinking: "Look first." }, { type: "text", text: "I'll look at the files first." }], stop_reason: null }, parent_tool_use_id: null, session_id: SID },
  { type: "assistant", message: { id: "msg_01", type: "message", role: "assistant", content: [{ type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "ls -la", description: "List files" } }] }, parent_tool_use_id: null, session_id: SID },
  { type: "user", message: { role: "user", content: [{ tool_use_id: "toolu_01", type: "tool_result", content: "README.md\nsrc", is_error: false }] }, parent_tool_use_id: null, session_id: SID },
  { type: "assistant", message: { id: "msg_02", type: "message", role: "assistant", content: [{ type: "tool_use", id: "toolu_02", name: "Write", input: { file_path: "/work/app/hello.txt", content: "hi\n" } }] }, parent_tool_use_id: null, session_id: SID },
  { type: "assistant", message: { id: "msg_03", type: "message", role: "assistant", content: [{ type: "tool_use", id: "toolu_03", name: "ExitPlanMode", input: { plan: "1. Add hello.txt\n2. Commit" } }] }, parent_tool_use_id: null, session_id: SID },
  { type: "assistant", message: { id: "msg_04", type: "message", role: "assistant", content: [{ type: "text", text: "Created hello.txt." }] }, parent_tool_use_id: null, session_id: SID },
  { type: "result", subtype: "success", is_error: false, duration_ms: 5321, num_turns: 3, result: "Created hello.txt.", session_id: SID, total_cost_usd: 0.01 },
  { type: "result", subtype: "error_max_turns", is_error: true, num_turns: 30, session_id: SID },
  { type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", session_id: SID, terminal_reason: "api_error" },
];

describe("Claude Code stream-json", () => {
  test("recorded output becomes the events the user sees", () => {
    const events = RECORDED.flatMap(parseClaudeLine);
    expect(events).toEqual([
      { kind: "native", native: SID },
      { kind: "text", text: "I'll look at the files first." },
      { kind: "tool", tool: "Bash", summary: "ls -la" },
      { kind: "tool", tool: "Write", summary: "/work/app/hello.txt" },
      { kind: "text", text: "1. Add hello.txt\n2. Commit" },
      { kind: "text", text: "Created hello.txt." },
      { kind: "turn", ok: true, summary: "Created hello.txt." },
      { kind: "turn", ok: false, error: "error_max_turns" },
      { kind: "turn", ok: false, error: "Not logged in · Please run /login" },
    ]);
  });

  test("a user message on stdin has the shape claude accepts", () => {
    // Checked against claude 2.1.286: this line is taken as the first turn.
    expect(JSON.parse(userMessage("say hi"))).toEqual({ type: "user", message: { role: "user", content: [{ type: "text", text: "say hi" }] } });
  });

  test("the adapter runs claude headless, one session per task, and resumes it for follow-ups", async () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "0b-agent-claude-")));
    // A stand-in claude: records its arguments, answers each stdin message, exits when stdin ends.
    const bin = fakeBin(
      dir,
      "claude",
      `const { appendFileSync } = require("node:fs");
appendFileSync(${JSON.stringify(join(dir, "calls.jsonl"))}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), claudecode: process.env.CLAUDECODE ?? null, profile: process.env.CLAUDE_CONFIG_DIR ?? null }) + "\\n");
const sid = process.argv[process.argv.indexOf(process.argv.includes("--resume") ? "--resume" : "--session-id") + 1];
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "system", subtype: "init", session_id: sid });
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    const text = m.message.content[0].text;
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "echo: " + text }] }, session_id: sid });
    out({ type: "result", subtype: "success", is_error: false, result: "done: " + text, session_id: sid });
  }
});
`,
    );
    const asks: string[] = [];
    const adapter = new ClaudeAdapter({
      self: (sub, file) => ["0b", "agent", sub, file],
      taskFile: (task) => join(dir, `${task}.json`),
      runDir: dir,
      onAsk: (task, ask) => asks.push(`${task}:${ask ? "on" : "off"}`),
      home: dir,
      bin,
    });
    const events: AgentEvent[] = [];
    process.env.CLAUDECODE = "1";
    const run = await adapter.start({ task: "t_test01", cwd: dir, prompt: "create hello.txt", mode: "edit", env: { CLAUDE_CONFIG_DIR: "/x/.claude-work" } }, (e) => events.push(e));
    expect(await run.done).toEqual({ ok: true });
    expect(events).toEqual([
      { kind: "native", native: run.native },
      { kind: "text", text: "echo: create hello.txt" },
      { kind: "turn", ok: true, summary: "done: create hello.txt" },
    ]);
    const first = JSON.parse(readFileSync(join(dir, "calls.jsonl"), "utf8").split("\n")[0]!);
    expect(first.argv).toEqual(expect.arrayContaining(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--session-id", run.native, "--permission-mode", "acceptEdits", "--permission-prompts", "host", "--permission-prompt-tool", "mcp__0bperm__ask"]));
    expect(first.cwd).toBe(dir);
    expect(first.claudecode).toBeNull();
    expect(first.profile).toBe("/x/.claude-work");
    const mcp = JSON.parse(readFileSync(first.argv[first.argv.indexOf("--mcp-config") + 1], "utf8"));
    expect(mcp.mcpServers["0bperm"]).toEqual({ type: "stdio", command: "0b", args: ["agent", "perm-mcp", join(dir, "t_test01.json")] });
    const settings = JSON.parse(readFileSync(first.argv[first.argv.indexOf("--settings") + 1], "utf8"));
    expect(settings.hooks.PreToolUse[0].matcher).toBe("Bash|PowerShell");
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain("guard");
    // A task can't answer prompts or steer agents through 0bridge's own tools.
    expect(settings.permissions.deny).toContain("mcp__0bridge__bridge__agent_approve");

    // A follow-up after it ended resumes the same session.
    const more: AgentEvent[] = [];
    const again = await adapter.attach({ id: run.native, cwd: dir }, (e) => more.push(e), { mode: "plan", task: "t_test01" });
    await again.send("and commit");
    expect(await again.done).toEqual({ ok: true });
    const second = JSON.parse(readFileSync(join(dir, "calls.jsonl"), "utf8").split("\n")[1]!);
    expect(second.argv).toEqual(expect.arrayContaining(["--resume", run.native, "--permission-mode", "plan"]));
    expect(second.argv).not.toContain("--session-id");
    expect(more.map((e) => e.kind)).toEqual(["native", "text", "turn"]);
    expect(asks).toEqual(["t_test01:on", "t_test01:off", "t_test01:on", "t_test01:off"]);
    delete process.env.CLAUDECODE;
  });

  test("stop ends the run as stopped", async () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "0b-agent-claude-")));
    const bin = fakeBin(dir, "claude", `setInterval(() => {}, 1000);\n`);
    const adapter = new ClaudeAdapter({ self: (sub, file) => ["0b", sub, file], taskFile: (t) => join(dir, t), runDir: dir, onAsk: () => {}, home: dir, bin });
    const run = await adapter.start({ task: "t_stop01", cwd: dir, prompt: "wait", mode: "edit" }, () => {});
    await run.stop();
    expect(await run.done).toEqual({ ok: false, error: "stopped" });
  });
});
