import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ipcPath, ipcRequest, serveIpc } from "../src/agent/ipc.ts";
import { writeTaskFile } from "../src/agent/perm-mcp.ts";
import { DEFAULT_DENY } from "../src/agent/policy.ts";

/**
 * The permission relay on this OS: the real `0b agent perm-mcp` (as Claude Code starts it) talks
 * MCP on stdio and asks a daemon socket, and `0b agent guard` refuses commands as a hook.
 */

const CLI = join(import.meta.dir, "../src/index.ts");
const home = mkdtempSync(join(tmpdir(), "0b-agent-ipc-"));
const ctx = { home, storeDir: join(home, ".0bridge") };
mkdirSync(ctx.storeDir, { recursive: true });
const env = { ...process.env, ZEROBRIDGE_USER_HOME: home, ZEROBRIDGE_DIR: ctx.storeDir, ZEROBRIDGE_SECRET_STORE: "file", NO_COLOR: "1" };

const asked: { task: string; tool: string; input: unknown }[] = [];
const server = await serveIpc(ipcPath(ctx), async (m) => {
  if (m.op === "ping") return { ok: true };
  asked.push({ task: String(m.task), tool: String(m.tool), input: m.input });
  const input = m.input as { command?: string };
  return input.command?.startsWith("rm ") ? { decision: "deny", note: "not today" } : { decision: "allow" };
});
afterAll(() => server.close());

/** Start perm-mcp, run the MCP calls, and collect the answers by id. */
async function mcp(taskFile: string, calls: object[]): Promise<Map<number, any>> {
  const child = spawn("bun", [CLI, "agent", "perm-mcp", taskFile], { env, stdio: ["pipe", "pipe", "inherit"] });
  const out = new Map<number, any>();
  let buf = "";
  const want = calls.filter((c: any) => c.id !== undefined).length;
  const done = new Promise<void>((resolve) => {
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        out.set(m.id, m);
        if (out.size === want) resolve();
      }
    });
  });
  for (const c of calls) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...c }) + "\n");
  await Promise.race([done, Bun.sleep(15_000)]);
  child.stdin.end();
  return out;
}

describe("permission relay", () => {
  test("the socket answers, and a second daemon on it is refused", async () => {
    expect(await ipcRequest(ipcPath(ctx), { op: "ping" }, 2000)).toEqual({ ok: true });
    await expect(serveIpc(ipcPath(ctx), async () => null)).rejects.toThrow(/already running/);
  });

  test("perm-mcp: refused commands are denied here, the rest go to the daemon and back", async () => {
    const file = writeTaskFile(ctx, { task: "t_ipc001", ipc: ipcPath(ctx), deny: DEFAULT_DENY, mode: "edit" });
    const ask = (id: number, tool_name: string, input: object) => ({ id, method: "tools/call", params: { name: "ask", arguments: { tool_name, input, tool_use_id: `toolu_${id}` } } });
    const r = await mcp(file, [
      { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.286" } } },
      { method: "notifications/initialized" },
      { id: 2, method: "tools/list" },
      ask(3, "Bash", { command: "git push origin main" }),
      ask(4, "Bash", { command: "npm test", description: "Run tests" }),
      ask(5, "Bash", { command: "rm -rf build" }),
      ask(6, "Write", { file_path: "/work/app/a.txt", content: "x" }),
    ]);
    expect(r.get(1).result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "0bperm" } });
    expect(r.get(2).result.tools.map((t: { name: string }) => t.name)).toEqual(["ask"]);
    const answer = (id: number) => JSON.parse(r.get(id).result.content[0].text);
    expect(answer(3)).toMatchObject({ behavior: "deny" });
    expect(answer(3).message).toContain("git push * main");
    expect(answer(4)).toEqual({ behavior: "allow", updatedInput: { command: "npm test", description: "Run tests" } });
    expect(answer(5)).toEqual({ behavior: "deny", message: "The user said no: not today" });
    expect(answer(6)).toEqual({ behavior: "allow", updatedInput: { file_path: "/work/app/a.txt", content: "x" } });
    // The refused one never reached the daemon (nobody was asked).
    expect(asked.map((a) => a.tool + ":" + JSON.stringify(a.input))).toEqual([
      'Bash:{"command":"npm test","description":"Run tests"}',
      'Bash:{"command":"rm -rf build"}',
      'Write:{"file_path":"/work/app/a.txt","content":"x"}',
    ]);
    expect(new Set(asked.map((a) => a.task))).toEqual(new Set(["t_ipc001"]));
  }, 30_000);

  test("perm-mcp: leaving plan mode is refused in a plan-only task; no daemon means no", async () => {
    const plan = writeTaskFile(ctx, { task: "t_ipc002", ipc: ipcPath(ctx), deny: DEFAULT_DENY, mode: "plan" });
    const r = await mcp(plan, [{ id: 1, method: "tools/call", params: { name: "ask", arguments: { tool_name: "ExitPlanMode", input: { plan: "1. do it" } } } }]);
    expect(JSON.parse(r.get(1).result.content[0].text)).toMatchObject({ behavior: "deny" });
    const orphan = writeTaskFile(ctx, { task: "t_ipc003", ipc: join(home, "nobody.sock"), deny: DEFAULT_DENY, mode: "edit" });
    const r2 = await mcp(orphan, [{ id: 1, method: "tools/call", params: { name: "ask", arguments: { tool_name: "Bash", input: { command: "ls" } } } }]);
    expect(JSON.parse(r2.get(1).result.content[0].text)).toMatchObject({ behavior: "deny" });
  }, 30_000);

  test("guard: exit 2 blocks refused commands (and anything it can't check)", () => {
    const file = writeTaskFile(ctx, { task: "t_ipc004", ipc: ipcPath(ctx), deny: [...DEFAULT_DENY, "terraform apply*"], mode: "auto" });
    const guard = (input: object, f = file) => spawnSync("bun", [CLI, "agent", "guard", f], { env, input: JSON.stringify(input), encoding: "utf8" });
    const pushed = guard({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push --force origin feature" } });
    expect(pushed.status).toBe(2);
    expect(pushed.stderr).toContain("git push --force*");
    expect(pushed.stdout).toBe("");
    expect(guard({ tool_name: "Bash", tool_input: { command: "cd infra && terraform apply" } }).status).toBe(2);
    expect(guard({ tool_name: "Bash", tool_input: { command: "npm test" } }).status).toBe(0);
    expect(guard({ tool_name: "Edit", tool_input: { file_path: "a.ts" } }).status).toBe(0);
    expect(guard({ tool_name: "Bash", tool_input: { command: "ls" } }, join(home, "missing.json")).status).toBe(2);
  }, 30_000);
});
