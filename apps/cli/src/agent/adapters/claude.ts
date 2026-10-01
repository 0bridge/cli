import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GATEWAY_NAME, writeAtomic } from "@0bridge/core";
import type { Mode } from "../policy.ts";
import { kill, onLines, spawnAgent, versionOf } from "./spawn.ts";
import { deferred, summarize, type AgentAdapter, type AgentEvent, type Run, type Sink, type StartOptions } from "./types.ts";

/**
 * Claude Code, headless: `claude -p` with stream-json both ways (checked against 2.1.286). Each
 * task is one session (`--session-id`, then `--resume` for follow-ups after it ends). Permission
 * prompts go to the `0bperm` MCP server (`0b agent perm-mcp`) and from there to the user; a
 * PreToolUse hook (`0b agent guard`) refuses the commands this machine never runs, in every mode.
 */

const PERMISSION_MODE: Record<Mode, string> = { plan: "plan", edit: "acceptEdits", auto: "auto" };

/**
 * 0bridge's own agent tools, refused inside a task whatever the user's settings allow: a task
 * never answers its own (or another task's) permission prompts, nor starts or steers agents.
 */
export const TASK_DENIED_TOOLS = ["machines", "agent_sessions", "agent_start", "agent_send", "agent_read", "agent_approve", "agent_stop"].map((t) => `mcp__${GATEWAY_NAME}__bridge__${t}`);

/** A stream-json user message (stdin). */
export const userMessage = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });

/** What one stream-json line (stdout) means for the user. */
export function parseClaudeLine(o: any): AgentEvent[] {
  if (!o || typeof o !== "object") return [];
  if (o.type === "system" && o.subtype === "init" && typeof o.session_id === "string") return [{ kind: "native", native: o.session_id }];
  if (o.type === "assistant" && Array.isArray(o.message?.content)) {
    const out: AgentEvent[] = [];
    for (const b of o.message.content) {
      if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) out.push({ kind: "text", text: b.text });
      else if (b?.type === "tool_use" && typeof b.name === "string") {
        // The plan is what a plan-mode task produces: show it as text.
        if (b.name === "ExitPlanMode" && typeof b.input?.plan === "string") out.push({ kind: "text", text: b.input.plan });
        else out.push({ kind: "tool", tool: b.name, summary: summarize(b.name, b.input) });
      }
    }
    return out;
  }
  if (o.type === "result") {
    const ok = o.subtype === "success" && !o.is_error;
    const text = typeof o.result === "string" ? o.result : undefined;
    return [ok ? { kind: "turn", ok, summary: text?.slice(0, 500) } : { kind: "turn", ok, error: text?.slice(0, 500) ?? o.subtype ?? "failed" }];
  }
  return [];
}

export interface ClaudeDeps {
  /** argv of `0b agent <sub> <task file>`, the permission server and the guard hook. */
  self(sub: "perm-mcp" | "guard", taskFile: string): string[];
  /** Write this task's rules (perm-mcp and guard read them); returns the file. */
  taskFile(task: string, mode: Mode): string;
  /** Where per-task Claude files (MCP config, settings) go. */
  runDir: string;
  /** Route this task's permission questions (from perm-mcp, through the daemon) to `ask`. */
  onAsk(task: string, ask: ((tool: string, input: unknown) => Promise<{ decision: "allow" | "deny"; note?: string }>) | null): void;
  home: string;
  bin?: string;
}

/** A shell word for a hook command line. */
const shq = (s: string) => (process.platform === "win32" ? `"${s.replace(/"/g, '\\"')}"` : `'${s.replace(/'/g, `'\\''`)}'`);

export class ClaudeAdapter implements AgentAdapter {
  readonly id = "claude" as const;
  constructor(private deps: ClaudeDeps) {}

  async available() {
    return versionOf(this.deps.bin ?? "claude");
  }

  start(o: StartOptions, sink: Sink): Promise<Run> {
    return Promise.resolve(this.run(o.task, o.cwd, o.mode, o.env, sink, { id: randomUUID(), resume: false }, o.prompt));
  }

  attach(native: { id: string; cwd: string }, sink: Sink, o?: { mode: Mode; env?: Record<string, string>; task?: string }): Promise<Run> {
    return Promise.resolve(this.run(o?.task ?? `t_${randomBytes(5).toString("hex")}`, native.cwd, o?.mode ?? "edit", o?.env, sink, { id: native.id, resume: true }, null));
  }

  /** Interactive Claude Code sessions open now (each writes sessions/<pid>.json in its config dir). */
  async running() {
    const dirs = new Set([process.env.CLAUDE_CONFIG_DIR ?? join(this.deps.home, ".claude")]);
    const out: { native: string; cwd: string; title?: string; tool: string; pid: number }[] = [];
    for (const dir of dirs) {
      let names: string[] = [];
      try {
        names = readdirSync(join(dir, "sessions")).filter((f) => /^\d+\.json$/.test(f));
      } catch {}
      for (const f of names) {
        try {
          const s = JSON.parse(readFileSync(join(dir, "sessions", f), "utf8")) as { pid?: number; sessionId?: string; cwd?: string; name?: string; kind?: string };
          if (!s.pid || !s.sessionId || !s.cwd || !alive(s.pid)) continue;
          out.push({ native: s.sessionId, cwd: s.cwd, ...(s.name ? { title: s.name } : {}), tool: "claude", pid: s.pid });
        } catch {}
      }
    }
    return out;
  }

  private run(task: string, cwd: string, mode: Mode, env: Record<string, string> | undefined, sink: Sink, session: { id: string; resume: boolean }, first: string | null): Run {
    const { deps } = this;
    const taskFile = deps.taskFile(task, mode);
    const mcpFile = join(deps.runDir, `${task}.mcp.json`);
    const settingsFile = join(deps.runDir, `${task}.settings.json`);
    const [cmd, ...args] = deps.self("perm-mcp", taskFile);
    writeAtomic(mcpFile, JSON.stringify({ mcpServers: { "0bperm": { type: "stdio", command: cmd, args } } }) + "\n", { mode: 0o600 });
    const guard = deps.self("guard", taskFile).map(shq).join(" ");
    writeAtomic(
      settingsFile,
      JSON.stringify({ permissions: { deny: TASK_DENIED_TOOLS }, hooks: { PreToolUse: [{ matcher: "Bash|PowerShell", hooks: [{ type: "command", command: guard, timeout: 10 }] }] } }) + "\n",
      { mode: 0o600 },
    );

    const done = deferred<{ ok: boolean; error?: string }>();
    const asks = new Map<string, (d: { decision: "allow" | "deny"; note?: string }) => void>();
    let child: ReturnType<typeof spawnAgent> | null = null;
    let turns = 0;
    let lastOk = true;
    let lastError: string | undefined;
    let stopped = false;
    let resume = session.resume;

    deps.onAsk(task, (tool, input) => {
      const request = `p_${randomBytes(5).toString("hex")}`;
      return new Promise((resolve) => {
        asks.set(request, resolve);
        sink({ kind: "permission", request, tool, summary: summarize(tool, input) });
      });
    });
    const finish = (r: { ok: boolean; error?: string }) => {
      for (const [, answer] of asks) answer({ decision: "deny", note: "the task ended" });
      asks.clear();
      deps.onAsk(task, null);
      done.resolve(r);
    };

    const spawnProcess = () => {
      const childEnv: Record<string, string | undefined> = { ...process.env, ...env };
      // A task is its own session, not a child of the Claude Code this daemon may run under.
      for (const k of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "CLAUDE_CODE_REMOTE"]) delete childEnv[k];
      const argv = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        ...(resume ? ["--resume", session.id] : ["--session-id", session.id]),
        "--permission-mode",
        PERMISSION_MODE[mode],
        "--permission-prompts",
        "host",
        "--permission-prompt-tool",
        "mcp__0bperm__ask",
        "--mcp-config",
        mcpFile,
        "--settings",
        settingsFile,
      ];
      resume = true;
      const p = spawnAgent(deps.bin ?? "claude", argv, { cwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
      child = p;
      let err = "";
      p.stderr?.on("data", (d) => (err = (err + d).slice(-2000)));
      p.stdin?.on("error", () => {});
      onLines(p.stdout, (line) => {
        let o: unknown;
        try {
          o = JSON.parse(line);
        } catch {
          return;
        }
        for (const e of parseClaudeLine(o)) {
          if (e.kind === "turn") {
            lastOk = e.ok;
            lastError = e.error;
            turns = Math.max(0, turns - 1);
            // Nothing more queued: close stdin so the process ends; a later send resumes.
            if (turns === 0) p.stdin?.end();
          }
          sink(e);
        }
      });
      p.on("error", (e) => {
        lastOk = false;
        lastError = e.message;
      });
      p.on("close", (code) => {
        if (child === p) child = null;
        if (stopped) return finish({ ok: false, error: "stopped" });
        if (turns > 0) {
          lastOk = false;
          lastError = lastError ?? (err.trim().split("\n").at(-1) || `claude exited with ${code}`);
          turns = 0;
        }
        finish(lastOk ? { ok: true } : { ok: false, error: lastError });
      });
    };

    const send = async (text: string) => {
      if (stopped || done.settled()) throw new Error("this run has ended");
      if (!child) spawnProcess();
      turns++;
      child!.stdin?.write(userMessage(text) + "\n");
    };
    if (first !== null) void send(first);

    return {
      native: session.id,
      send,
      approve: async (request, d, note) => {
        const answer = asks.get(request);
        if (!answer) throw new Error(`no permission request ${request} is waiting`);
        asks.delete(request);
        answer({ decision: d, ...(note ? { note } : {}) });
      },
      stop: async () => {
        stopped = true;
        if (child) kill(child);
        else finish({ ok: false, error: "stopped" });
      },
      done: done.promise,
    };
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
