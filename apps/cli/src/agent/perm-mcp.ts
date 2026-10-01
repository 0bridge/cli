import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { writeAtomic, type Context } from "@0bridge/core";
import { ipcRequest } from "./ipc.ts";
import { deniedBy, type Mode } from "./policy.ts";

/**
 * How a Claude Code task asks before it acts. `0b agent perm-mcp <task file>` is the MCP server
 * behind `--permission-prompt-tool mcp__0bperm__ask`: a refused command (DEFAULT_DENY and the
 * repo's rules) is denied at once; anything else goes to the daemon, which shows it to the user
 * wherever they are and waits up to 30 minutes for their answer (no answer is a no).
 * `0b agent guard <task file>` is a PreToolUse hook on the same task: it refuses those commands
 * even when nothing would ask (an allow rule in the user's settings, or auto mode).
 */

/** What the daemon writes for each task, read by perm-mcp and guard. */
export interface TaskFile {
  task: string;
  ipc: string;
  deny: string[];
  mode: Mode;
  /** The task's own branch (its worktree's), when it has one. */
  head?: string;
}

export const PERM_WAIT_MS = 30 * 60 * 1000;
const COMMAND_TOOLS = new Set(["Bash", "PowerShell"]);

export const taskFilePath = (ctx: Context, task: string) => join(ctx.storeDir, "agent", "run", `${task}.json`);

export function writeTaskFile(ctx: Context, tf: TaskFile): string {
  const path = taskFilePath(ctx, tf.task);
  mkdirSync(join(ctx.storeDir, "agent", "run"), { recursive: true, mode: 0o700 });
  writeAtomic(path, JSON.stringify(tf) + "\n", { mode: 0o600 });
  return path;
}

export const removeTaskFile = (ctx: Context, task: string) => rmSync(taskFilePath(ctx, task), { force: true });

/** The answer that needs nobody: a refused command, or leaving plan mode in a plan-only task. Null: ask. */
export function decideLocally(tf: TaskFile, tool: string, input: unknown): { behavior: "deny"; message: string } | null {
  const i = (input ?? {}) as Record<string, unknown>;
  if (COMMAND_TOOLS.has(tool) && typeof i.command === "string") {
    const rule = deniedBy(tf.deny, i.command, tf.head);
    if (rule) return { behavior: "deny", message: `0bridge refuses this command on this machine (rule "${rule}"). Don't try to get around it; leave it for the user.` };
  }
  if (tool === "ExitPlanMode" && tf.mode === "plan") return { behavior: "deny", message: "This task is plan-only (the repo's mode on this machine). Stop here: the plan is the result." };
  return null;
}

/** The permission tool's answer: allow (with the input as it was) or deny, as Claude Code expects. */
export function permResult(input: unknown, d: { decision: "allow" | "deny"; note?: string }): { behavior: "allow"; updatedInput: unknown } | { behavior: "deny"; message: string } {
  return d.decision === "allow" ? { behavior: "allow", updatedInput: input ?? {} } : { behavior: "deny", message: d.note ? `The user said no: ${d.note}` : "The user said no." };
}

function readTaskFile(path: string): TaskFile {
  const tf = JSON.parse(readFileSync(path, "utf8")) as TaskFile;
  if (!tf.task || !tf.ipc || !Array.isArray(tf.deny)) throw new Error("bad task file");
  return tf;
}

const ASK_TOOL = {
  name: "ask",
  description: "Ask the user (through 0bridge) whether a tool call may run.",
  inputSchema: {
    type: "object",
    properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } },
    required: ["tool_name", "input"],
  },
};

/** The MCP server on stdin/stdout (newline-delimited JSON-RPC). */
export async function permMcp(path: string): Promise<void> {
  const tf = readTaskFile(path);
  const write = (o: object) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\n");
  const pending = new Set<Promise<void>>();
  for await (const line of createInterface({ input: process.stdin })) {
    let msg: { id?: string | number; method?: string; params?: Record<string, any> };
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const { id, method, params } = msg;
    if (id === undefined || !method) continue; // notifications and responses
    if (method === "initialize")
      write({ id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "0bperm", version: "1" } } });
    else if (method === "ping") write({ id, result: {} });
    else if (method === "tools/list") write({ id, result: { tools: [ASK_TOOL] } });
    else if (method === "tools/call" && params?.name === "ask") {
      const p = (async () => {
        const tool = String(params.arguments?.tool_name ?? "");
        const input = params.arguments?.input ?? {};
        let answer: object | null = decideLocally(tf, tool, input);
        if (!answer) {
          try {
            const d = await ipcRequest<{ decision: "allow" | "deny"; note?: string }>(tf.ipc, { op: "ask", task: tf.task, tool, input }, PERM_WAIT_MS + 60_000);
            answer = permResult(input, d);
          } catch (e) {
            answer = { behavior: "deny", message: `No answer from the user through 0bridge (${(e as Error).message}).` };
          }
        }
        write({ id, result: { content: [{ type: "text", text: JSON.stringify(answer) }] } });
      })();
      pending.add(p);
      p.finally(() => pending.delete(p));
    } else write({ id, error: { code: -32601, message: `Unknown method: ${method}` } });
  }
  await Promise.all(pending);
}

/** The PreToolUse hook: exit 2 (with the reason on stderr) blocks the call. Fails closed. */
export async function guard(path: string): Promise<number> {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 1024 * 1024) break;
  }
  try {
    const tf = readTaskFile(path);
    const ev = JSON.parse(raw) as { tool_name?: string; tool_input?: unknown };
    const d = decideLocally(tf, ev.tool_name ?? "", ev.tool_input);
    if (d && COMMAND_TOOLS.has(ev.tool_name ?? "")) {
      process.stderr.write(d.message + "\n");
      return 2;
    }
    return 0;
  } catch (e) {
    process.stderr.write(`0bridge couldn't check this command against the machine's rules (${(e as Error).message}), so it doesn't run.\n`);
    return 2;
  }
}
