import { randomBytes } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { deniedBy, inside, type Mode } from "../policy.ts";
import { kill, onLines, spawnAgent, versionOf } from "./spawn.ts";
import { deferred, summarize, type AgentAdapter, type Run, type Sink, type StartOptions } from "./types.ts";

/**
 * Gemini CLI over the Agent Client Protocol (`gemini --experimental-acp`): best effort, not yet
 * checked against a real Gemini CLI. One process per task: session/new (or session/load for a
 * follow-up), session/prompt per message, and session/request_permission relayed to the user.
 * Plan declines whatever asks; auto also allows edits that stay in the task's folder.
 */

type Rpc = { jsonrpc?: "2.0"; id?: number | string; method?: string; params?: any; result?: any; error?: { code: number; message: string } };
type Option = { optionId: string; kind: "allow_once" | "allow_always" | "reject_once" | "reject_always"; name?: string };

/** The option to pick for a decision: a one-time choice first, never "always". */
export function pickOption(options: Option[], allow: boolean): string | null {
  const want = allow ? ["allow_once"] : ["reject_once", "reject_always"];
  return options.find((o) => want.includes(o.kind))?.optionId ?? null;
}

export interface GeminiDeps {
  deny(task: string): string[];
  /** The branch the task works on, when the daemon made it one (a push naming no branch pushes it). */
  head?(task: string): string | undefined;
  bin?: string;
}

export class GeminiAdapter implements AgentAdapter {
  readonly id = "gemini" as const;
  constructor(private deps: GeminiDeps) {}

  async available() {
    return versionOf(this.deps.bin ?? "gemini");
  }

  start(o: StartOptions, sink: Sink): Promise<Run> {
    return this.session(o.task, o.cwd, o.mode, o.env, sink, null, o.prompt);
  }

  attach(native: { id: string; cwd: string }, sink: Sink, o?: { mode: Mode; env?: Record<string, string>; task?: string }): Promise<Run> {
    return this.session(o?.task ?? `t_${randomBytes(5).toString("hex")}`, native.cwd, o?.mode ?? "edit", o?.env, sink, native.id, null);
  }

  private async session(task: string, cwd: string, mode: Mode, env: Record<string, string> | undefined, sink: Sink, loadId: string | null, first: string | null): Promise<Run> {
    const child: ChildProcess = spawnAgent(this.deps.bin ?? "gemini", ["--experimental-acp"], { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    const done = deferred<{ ok: boolean; error?: string }>();
    const calls = new Map<number | string, { resolve(v: any): void; reject(e: Error): void }>();
    const asks = new Map<string, { id: number | string; options: Option[] }>();
    let next = 1;
    let text = "";
    let stopped = false;
    let busy = false;
    const queue: string[] = [];
    let sessionId = loadId ?? "";

    const write = (o: Rpc) => child.stdin?.writable && child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\n");
    const call = (method: string, params: unknown) =>
      new Promise<any>((resolve, reject) => {
        const id = next++;
        calls.set(id, { resolve, reject });
        write({ id, method, params });
      });
    const flush = () => {
      if (text.trim()) sink({ kind: "text", text });
      text = "";
    };
    const finish = (r: { ok: boolean; error?: string }) => {
      for (const a of asks.values()) write({ id: a.id, result: { outcome: { outcome: "cancelled" } } });
      asks.clear();
      kill(child);
      done.resolve(r);
    };

    child.stdin?.on("error", () => {});
    child.stderr?.resume();
    child.on("error", (e) => finish({ ok: false, error: e.message }));
    child.on("close", (code) => {
      for (const c of calls.values()) c.reject(new Error(`gemini exited (${code})`));
      calls.clear();
      finish(stopped ? { ok: false, error: "stopped" } : { ok: false, error: `gemini exited (${code})` });
    });
    onLines(child.stdout, (line) => {
      let m: Rpc;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (m.id !== undefined && !m.method) {
        const c = calls.get(m.id);
        calls.delete(m.id);
        return m.error ? c?.reject(new Error(m.error.message)) : c?.resolve(m.result);
      }
      const p = m.params ?? {};
      if (m.method === "session/update") {
        const u = p.update ?? {};
        if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") text += u.content.text;
        else if (u.sessionUpdate === "tool_call") {
          flush();
          sink({ kind: "tool", tool: u.kind ?? "tool", summary: String(u.title ?? summarize(u.kind ?? "tool", u.rawInput)).slice(0, 300) });
        }
        return;
      }
      if (m.method === "session/request_permission" && m.id !== undefined) {
        const tc = p.toolCall ?? {};
        const options: Option[] = p.options ?? [];
        const answer = (allow: boolean) => {
          const optionId = pickOption(options, allow);
          write({ id: m.id!, result: { outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } } });
        };
        const command = typeof tc.rawInput?.command === "string" ? tc.rawInput.command : null;
        const rule = command ? deniedBy(this.deps.deny(task), command, this.deps.head?.(task)) : null;
        if (rule) {
          sink({ kind: "text", text: `Refused on this machine (rule "${rule}"): ${command}` });
          return answer(false);
        }
        if (mode === "plan") return answer(false);
        const paths: string[] = (tc.locations ?? []).map((l: { path?: string }) => l.path).filter(Boolean);
        if (mode === "auto" && tc.kind === "edit" && paths.length && paths.every((x) => inside(cwd, x))) return answer(true);
        flush();
        const request = `p_${randomBytes(5).toString("hex")}`;
        asks.set(request, { id: m.id, options });
        sink({ kind: "permission", request, tool: tc.kind ?? "tool", summary: String(tc.title ?? command ?? "use a tool").slice(0, 300) });
        return;
      }
      // Requests we don't serve (we offered no file system or terminal).
      if (m.id !== undefined && m.method) write({ id: m.id, error: { code: -32601, message: `0bridge doesn't answer ${m.method}` } });
    });

    const pump = async () => {
      if (busy) return;
      busy = true;
      while (queue.length && !stopped) {
        const msg = queue.shift()!;
        try {
          const r = await call("session/prompt", { sessionId, prompt: [{ type: "text", text: msg }] });
          flush();
          sink({ kind: "turn", ok: r?.stopReason !== "refusal", ...(r?.stopReason === "refusal" ? { error: "refused" } : {}) });
        } catch (e) {
          flush();
          sink({ kind: "turn", ok: false, error: (e as Error).message });
          busy = false;
          return finish({ ok: false, error: (e as Error).message });
        }
      }
      busy = false;
      finish(stopped ? { ok: false, error: "stopped" } : { ok: true });
    };

    try {
      await call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
      if (loadId) await call("session/load", { sessionId: loadId, cwd, mcpServers: [] });
      else sessionId = (await call("session/new", { cwd, mcpServers: [] })).sessionId;
    } catch (e) {
      kill(child);
      throw new Error(`gemini (ACP): ${(e as Error).message}`);
    }
    sink({ kind: "native", native: sessionId });
    const send = async (msg: string) => {
      if (done.settled()) throw new Error("this run has ended");
      queue.push(msg);
      void pump();
    };
    if (first !== null) await send(first);
    return {
      native: sessionId,
      send,
      approve: async (request, d) => {
        const a = asks.get(request);
        if (!a) throw new Error(`no permission request ${request} is waiting`);
        asks.delete(request);
        const optionId = pickOption(a.options, d === "allow");
        write({ id: a.id, result: { outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } } });
      },
      stop: async () => {
        stopped = true;
        queue.length = 0;
        write({ method: "session/cancel", params: { sessionId } });
        setTimeout(() => finish({ ok: false, error: "stopped" }), 3000).unref?.();
      },
      done: done.promise,
    };
  }
}
