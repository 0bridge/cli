import { randomBytes } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { deniedBy, type Mode } from "../policy.ts";
import type { CommandExecutionRequestApprovalParams, ErrorNotification, FileChangeRequestApprovalParams, ThreadItem, ThreadStartParams, TurnCompletedNotification } from "./codex-protocol/index.ts";
import { kill, onLines, runAgent, spawnAgent, versionOf } from "./spawn.ts";
import { deferred, type AgentAdapter, type AgentEvent, type Run, type Sink, type StartOptions } from "./types.ts";

/**
 * Codex through `codex app-server` (experimental; the protocol types in codex-protocol/ come from
 * codex 0.157.0): one app-server per account on this machine, a thread per task, approval
 * requests relayed to the user. Without app-server it falls back to `codex exec --json` (no
 * approvals, so plan or edit only). A Codex session open in a terminal gets follow-ups with
 * `codex queue`.
 *
 * Modes: plan runs read-only and declines every approval request; edit writes in the workspace
 * and asks for anything more; auto also accepts file changes inside the workspace on its own.
 * Commands this machine refuses are declined before anyone is asked.
 */

type Rpc = { id?: string | number; method?: string; params?: any; result?: any; error?: { code: number; message: string } };

const SANDBOX: Record<Mode, ThreadStartParams["sandbox"]> = { plan: "read-only", edit: "workspace-write", auto: "workspace-write" };

/** The events a notification means for the user (null threadId: not a thread's). */
export function mapCodexNotification(msg: Rpc): { threadId: string | null; events: AgentEvent[] } {
  const p = msg.params ?? {};
  const threadId: string | null = typeof p.threadId === "string" ? p.threadId : (p.thread?.id ?? null);
  const events: AgentEvent[] = [];
  switch (msg.method) {
    case "item/started": {
      const item = p.item as ThreadItem;
      if (item.type === "commandExecution") events.push({ kind: "tool", tool: "shell", summary: item.command.slice(0, 300) });
      else if (item.type === "mcpToolCall") events.push({ kind: "tool", tool: `${item.server}.${item.tool}`, summary: JSON.stringify(item.arguments ?? {}).slice(0, 300) });
      else if (item.type === "webSearch") events.push({ kind: "tool", tool: "web_search", summary: String((item as { query?: string }).query ?? "").slice(0, 300) });
      break;
    }
    case "item/completed": {
      const item = p.item as ThreadItem;
      if (item.type === "agentMessage" && item.text.trim()) events.push({ kind: "text", text: item.text });
      else if (item.type === "fileChange") events.push({ kind: "tool", tool: "edit", summary: item.changes.map((c: { path: string }) => c.path).join(", ").slice(0, 300) });
      break;
    }
    case "turn/completed": {
      const t = (p as TurnCompletedNotification).turn;
      events.push(t.status === "completed" ? { kind: "turn", ok: true } : { kind: "turn", ok: false, error: t.error?.message ?? t.status });
      break;
    }
    case "error": {
      const e = p as ErrorNotification;
      if (!e.willRetry) events.push({ kind: "error", error: e.error.message });
      break;
    }
  }
  return { threadId, events };
}

/** What an approval request asks, for the user and the rules. */
export function describeApproval(msg: Rpc): { threadId: string; tool: string; summary: string; command?: string; file?: boolean; outside?: boolean } | null {
  const p = msg.params ?? {};
  if (msg.method === "item/commandExecution/requestApproval") {
    const a = p as CommandExecutionRequestApprovalParams;
    const command = a.command ?? "";
    return { threadId: a.threadId, tool: "shell", summary: (command || a.reason || "run a command").slice(0, 300), command };
  }
  if (msg.method === "item/fileChange/requestApproval") {
    const a = p as FileChangeRequestApprovalParams;
    return { threadId: a.threadId, tool: "edit", summary: (a.reason ?? (a.grantRoot ? `write under ${a.grantRoot}` : "change files")).slice(0, 300), file: true, outside: Boolean(a.grantRoot) };
  }
  return null;
}

/** One `codex app-server` process (per CODEX_HOME), JSON-RPC over stdio (lines, no "jsonrpc" field). */
export class CodexServer {
  private child: ChildProcess | null = null;
  private next = 1;
  private calls = new Map<string | number, { resolve(v: any): void; reject(e: Error): void }>();
  private threads = new Map<string, { notify(m: Rpc): void; request(m: Rpc): void; closed(e: string): void }>();
  private ready: Promise<void> | null = null;

  constructor(
    private env: Record<string, string | undefined>,
    private bin = "codex",
  ) {}

  start(): Promise<void> {
    if (this.ready) return this.ready;
    const child = spawnAgent(this.bin, ["app-server"], { env: this.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stderr?.resume();
    child.stdin?.on("error", () => {});
    onLines(child.stdout, (line) => {
      let m: Rpc;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      this.receive(m);
    });
    const gone = (why: string) => {
      this.child = null;
      this.ready = null;
      for (const c of this.calls.values()) c.reject(new Error(why));
      this.calls.clear();
      for (const t of this.threads.values()) t.closed(why);
      this.threads.clear();
    };
    child.on("error", (e) => gone(e.message));
    child.on("close", (code) => gone(`codex app-server exited (${code})`));
    this.ready = this.call("initialize", { clientInfo: { name: "0bridge", title: "0bridge", version: "1" }, capabilities: null }).then(() => this.notify("initialized"));
    return this.ready;
  }

  /** Handle one message from the server (exposed for tests). */
  receive(m: Rpc): void {
    if (m.id !== undefined && !m.method) {
      const c = this.calls.get(m.id);
      if (!c) return;
      this.calls.delete(m.id);
      return m.error ? c.reject(new Error(m.error.message)) : c.resolve(m.result);
    }
    const threadId = m.params?.threadId ?? m.params?.thread?.id;
    const t = typeof threadId === "string" ? this.threads.get(threadId) : undefined;
    if (m.id !== undefined && m.method) {
      if (t) return t.request(m);
      return this.respondError(m.id, `0bridge doesn't answer ${m.method}`);
    }
    t?.notify(m);
  }

  call<T = any>(method: string, params: unknown): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }
  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }
  respond(id: string | number, result: unknown): void {
    this.write({ id, result });
  }
  respondError(id: string | number, message: string): void {
    this.write({ id, error: { code: -32601, message } });
  }
  watch(threadId: string, h: { notify(m: Rpc): void; request(m: Rpc): void; closed(e: string): void }): () => void {
    this.threads.set(threadId, h);
    return () => this.threads.get(threadId) === h && this.threads.delete(threadId);
  }
  stop(): void {
    if (this.child) kill(this.child);
  }
  protected write(o: object): void {
    if (!this.child?.stdin?.writable) throw new Error("codex app-server isn't running");
    this.child.stdin.write(JSON.stringify(o) + "\n");
  }
}

export interface CodexDeps {
  /** The rules of a task: commands refused before anyone is asked. */
  deny(task: string): string[];
  /** The branch the task works on, when the daemon made it one (a push naming no branch pushes it). */
  head?(task: string): string | undefined;
  bin?: string;
  /** For tests: the server to use instead of spawning one. */
  server?: (env: Record<string, string>) => CodexServer;
}

export class CodexAdapter implements AgentAdapter {
  readonly id = "codex" as const;
  private servers = new Map<string, CodexServer>();
  private appServer: boolean | null = null;
  constructor(private deps: CodexDeps) {}

  async available() {
    const v = versionOf(this.deps.bin ?? "codex");
    if (v.ok && this.appServer === null) this.appServer = runAgent(this.deps.bin ?? "codex", ["app-server", "--help"], { timeout: 10_000 }).code === 0;
    return v;
  }

  private server(env: Record<string, string> = {}): CodexServer {
    const key = env.CODEX_HOME ?? "";
    let s = this.servers.get(key);
    if (!s) {
      s = this.deps.server?.(env) ?? new CodexServer({ ...process.env, ...env }, this.deps.bin);
      this.servers.set(key, s);
    }
    return s;
  }

  async start(o: StartOptions, sink: Sink): Promise<Run> {
    if (this.appServer === false && !this.deps.server) return this.exec(o.task, o.cwd, o.mode, o.env, sink, null, o.prompt);
    const s = this.server(o.env);
    await s.start();
    const r = await s.call("thread/start", { cwd: o.cwd, approvalPolicy: "on-request", sandbox: SANDBOX[o.mode], approvalsReviewer: "user" } satisfies ThreadStartParams);
    const run = this.thread(s, r.thread.id, o.task, o.mode, sink);
    sink({ kind: "native", native: r.thread.id });
    await run.send(o.prompt);
    return run;
  }

  async attach(native: { id: string; cwd: string }, sink: Sink, o?: { mode: Mode; env?: Record<string, string>; task?: string }): Promise<Run> {
    const mode = o?.mode ?? "edit";
    const task = o?.task ?? `t_${randomBytes(5).toString("hex")}`;
    if (this.appServer === false && !this.deps.server) return this.exec(task, native.cwd, mode, o?.env, sink, native.id, null);
    const s = this.server(o?.env);
    await s.start();
    await s.call("thread/resume", { threadId: native.id, cwd: native.cwd, approvalPolicy: "on-request", sandbox: SANDBOX[mode], approvalsReviewer: "user", excludeTurns: true });
    return this.thread(s, native.id, task, mode, sink);
  }

  /** Stop the app-servers (the daemon is exiting). */
  close(): void {
    for (const s of this.servers.values()) s.stop();
    this.servers.clear();
  }

  /** A message to a Codex session open in a terminal (its TUI picks it up). */
  queue(id: string, text: string, env?: Record<string, string>): void {
    const r = runAgent(this.deps.bin ?? "codex", ["queue", "--thread", id, "--message", text], { env: { ...process.env, ...env }, timeout: 30_000 });
    if (r.code !== 0) throw new Error(r.err.trim().split("\n").at(-1) || "codex queue failed");
  }

  private thread(s: CodexServer, threadId: string, task: string, mode: Mode, sink: Sink): Run {
    const done = deferred<{ ok: boolean; error?: string }>();
    const asks = new Map<string, string | number>();
    let turn: string | null = null;
    let queued = 0;
    let lastError: string | undefined;
    let stopped = false;

    const end = (r: { ok: boolean; error?: string }) => {
      for (const id of asks.values()) s.respond(id, { decision: "decline" });
      asks.clear();
      unwatch();
      done.resolve(r);
    };
    const unwatch = s.watch(threadId, {
      notify: (m) => {
        if (m.method === "turn/started") turn = m.params?.turn?.id ?? turn;
        for (const e of mapCodexNotification(m).events) {
          if (e.kind === "error") lastError = e.error;
          sink(e);
          if (e.kind === "turn") {
            turn = null;
            queued = Math.max(0, queued - 1);
            if (stopped) end({ ok: false, error: "stopped" });
            else if (queued === 0) end(e.ok ? { ok: true } : { ok: false, error: e.error ?? lastError });
          }
        }
      },
      request: (m) => {
        const a = describeApproval(m);
        if (!a) return s.respondError(m.id!, `0bridge doesn't answer ${m.method}`);
        const rule = a.command ? deniedBy(this.deps.deny(task), a.command, this.deps.head?.(task)) : null;
        if (rule) {
          sink({ kind: "text", text: `Refused on this machine (rule "${rule}"): ${a.summary}` });
          return s.respond(m.id!, { decision: "decline" });
        }
        if (mode === "plan") return s.respond(m.id!, { decision: "decline" });
        if (mode === "auto" && a.file && !a.outside) return s.respond(m.id!, { decision: "accept" });
        const request = `p_${randomBytes(5).toString("hex")}`;
        asks.set(request, m.id!);
        sink({ kind: "permission", request, tool: a.tool, summary: a.summary });
      },
      closed: (why) => end({ ok: false, error: why }),
    });

    const input = (text: string) => [{ type: "text", text, text_elements: [] }];
    return {
      native: threadId,
      send: async (text) => {
        if (done.settled()) throw new Error("this run has ended");
        if (turn) {
          // A turn is running: steer it.
          await s.call("turn/steer", { threadId, input: input(text), expectedTurnId: turn });
          return;
        }
        queued++;
        const r = await s.call("turn/start", { threadId, input: input(text) }).catch((e: Error) => {
          queued--;
          throw e;
        });
        turn = r?.turn?.id ?? turn;
      },
      approve: async (request, d) => {
        const id = asks.get(request);
        if (id === undefined) throw new Error(`no permission request ${request} is waiting`);
        asks.delete(request);
        s.respond(id, { decision: d === "allow" ? "accept" : "decline" });
      },
      stop: async () => {
        stopped = true;
        if (turn) await s.call("turn/interrupt", { threadId, turnId: turn }).catch(() => end({ ok: false, error: "stopped" }));
        else end({ ok: false, error: "stopped" });
      },
      done: done.promise,
    };
  }

  /** `codex exec --json` (or `exec resume`): one turn per process, no approvals. */
  private async exec(task: string, cwd: string, mode: Mode, env: Record<string, string> | undefined, sink: Sink, resumeId: string | null, first: string | null): Promise<Run> {
    const done = deferred<{ ok: boolean; error?: string }>();
    let child: ChildProcess | null = null;
    let native = resumeId ?? "";
    let stopped = false;
    const sandbox = mode === "plan" ? "read-only" : "workspace-write";
    const send = async (text: string) => {
      if (child) throw new Error("codex is still working on the last message (no follow-ups while codex exec runs)");
      if (done.settled()) throw new Error("this run has ended");
      const args = native ? ["exec", "resume", native, "--json", "-c", `sandbox_mode="${sandbox}"`, "-"] : ["exec", "--json", "-C", cwd, "-s", sandbox, "-"];
      const p = spawnAgent(this.deps.bin ?? "codex", args, { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
      child = p;
      p.stdin?.on("error", () => {});
      p.stdin?.end(text);
      p.stderr?.resume();
      let ok = true;
      let error: string | undefined;
      onLines(p.stdout, (line) => {
        let o: any;
        try {
          o = JSON.parse(line);
        } catch {
          return;
        }
        if (o.type === "thread.started" && o.thread_id) {
          native = o.thread_id;
          sink({ kind: "native", native });
        } else if (o.type === "item.completed" && o.item?.type === "agent_message" && o.item.text) sink({ kind: "text", text: o.item.text });
        else if (o.type === "item.started" && o.item?.type === "command_execution") sink({ kind: "tool", tool: "shell", summary: String(o.item.command ?? "").slice(0, 300) });
        else if (o.type === "turn.failed" || o.type === "error") {
          ok = false;
          error = o.error?.message ?? o.message ?? "failed";
        }
      });
      p.on("close", (code) => {
        child = null;
        if (code !== 0 && ok) {
          ok = false;
          error = `codex exited with ${code}`;
        }
        sink(ok ? { kind: "turn", ok } : { kind: "turn", ok, error });
        done.resolve(stopped ? { ok: false, error: "stopped" } : ok ? { ok } : { ok, error });
      });
    };
    if (first !== null) await send(first);
    return {
      get native() {
        return native;
      },
      send,
      approve: async () => {
        throw new Error("codex exec has no approvals");
      },
      stop: async () => {
        stopped = true;
        if (child) kill(child);
        else done.resolve({ ok: false, error: "stopped" });
      },
      done: done.promise,
    };
  }
}
