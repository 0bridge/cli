import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { arch, hostname } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { deviceTokenKey, loadCloud, openSecretStore, redact, type Context } from "@0bridge/core";
import { ClaudeAdapter } from "./adapters/claude.ts";
import { CodexAdapter } from "./adapters/codex.ts";
import { FakeAdapter } from "./adapters/fake.ts";
import { GeminiAdapter } from "./adapters/gemini.ts";
import { HerdrAdapter } from "./adapters/herdr.ts";
import { TmuxAdapter } from "./adapters/tmux.ts";
import type { AgentAdapter, AgentEvent, Run } from "./adapters/types.ts";
import { ipcPath, serveIpc } from "./ipc.ts";
import { logEvent, logMeta, readTask } from "./log.ts";
import { PERM_WAIT_MS, removeTaskFile, writeTaskFile } from "./perm-mcp.ts";
import { AGENT_IDS, clampMode, denyRules, loadAgentConfig, profileEnv, repoFor, saveAgentConfig, supervisorInfo, withUseProfiles, type AgentConfig, type AgentId, type Mode, type RepoPolicy } from "./policy.ts";
import { installService } from "../service.ts";
import { vaultValues } from "../vault.ts";
import { HostSupervisor, type SupervisorOptions } from "./supervisor.ts";
import { connectLoop, type Conn } from "./ws.ts";
import type { DaemonAgentId, EventData, EventFrame, EventKind, HelloFrame, HostOp, HubFrame, HubRequest, ReplyFrame, RunningSession, TaskState } from "./protocol.ts";

/**
 * The machine's agent daemon: it holds the connection to the machine hub, starts and
 * steers tasks there asks for, and relays what they do. Every request is checked against this
 * machine's own rules (agent.json) first: agents run only in allowed repos, never in a mode above
 * the repo's, by default each in its own worktree, and never run the refused commands. A
 * permission prompt nobody answers in 30 minutes is a no. With a supervisor set up here
 * (`0b agent supervisor`), host work goes through it (supervisor.ts).
 */

declare const VERSION: string;
const version = typeof VERSION !== "undefined" ? VERSION : "dev";

const TASK_ID = /^t_[A-Za-z0-9]{4,32}$/;
/** A session or pane id from the hub (UUID, thread id, herdr's w1:p4, tmux's %12): never one an agent CLI could read as an option. */
const NATIVE_ID = /^[A-Za-z0-9%][A-Za-z0-9._:%-]{0,127}$/;
const MAX_RUNNING = 4;
const MAX_TEXT = 8000;
const MAX_PROMPT = 64 * 1024;
const OUTBOX = 1000;
const START_WAIT_MS = 10_000;

interface Task {
  id: string;
  agent: DaemonAgentId;
  root: string;
  cwd: string;
  mode: Mode;
  env: Record<string, string>;
  deny: string[];
  run: Run | null;
  state: TaskState;
  seq: number;
  native: string;
  branch?: string;
  /** Permission prompts waiting for the user, each with its 30-minute timer. */
  pending: Map<string, ReturnType<typeof setTimeout>>;
  updatedAt: number;
  /** The last error reported, so the same one (an agent's error event, then its failed turn) is said once. */
  lastError?: string;
}

type Ask = (tool: string, input: unknown) => Promise<{ decision: "allow" | "deny"; note?: string }>;

export interface DaemonOptions {
  /** Adapters to use instead of the real ones (tests). */
  adapters?: Partial<Record<DaemonAgentId, AgentAdapter>>;
  log?: (line: string) => void;
  /** The host supervisor's waits (tests). */
  supervisor?: Omit<SupervisorOptions, "mask" | "log">;
}

export class Daemon {
  readonly adapters: Partial<Record<DaemonAgentId, AgentAdapter>>;
  private tasks = new Map<string, Task>();
  private asks = new Map<string, Ask>();
  private outbox: EventFrame[] = [];
  private send: ((frame: object) => boolean) | null = null;
  private log: (line: string) => void;
  private secrets: { at: number; values: string[] } | null = null;
  /** The host supervisor, while agent.json sets one up (key: its settings). */
  private host: { key: string; sup: HostSupervisor; kind: "openclaw" | "ledger" } | null = null;
  /** The supervisor key last seen (undefined: not looked at yet), so a change is told to the hub once. */
  private supKey: string | null | undefined = undefined;
  /**
   * Called when agent.json's supervisor changed since it was last looked at (`0b agent supervisor`
   * pokes the daemon, or a request found it): runDaemon sends the hub a new hello at once, so it
   * never picks this machine by a kind it no longer has.
   */
  onSupervisorChange: (() => void) | null = null;
  private supOpts: DaemonOptions["supervisor"];

  constructor(
    readonly ctx: Context,
    opts: DaemonOptions = {},
  ) {
    this.log = opts.log ?? ((line) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`));
    this.supOpts = opts.supervisor;
    const deny = (task: string) => this.tasks.get(task)?.deny ?? denyRules(null);
    const head = (task: string) => this.tasks.get(task)?.branch;
    if (opts.adapters) this.adapters = opts.adapters;
    else if (process.env.ZEROBRIDGE_AGENT_FAKE === "1") this.adapters = Object.fromEntries(AGENT_IDS.map((id) => [id, new FakeAdapter(id, deny, head)]));
    else
      this.adapters = {
        claude: new ClaudeAdapter({
          self: (sub, file) => [process.execPath, process.argv[1]!, "agent", sub, file],
          taskFile: (task, mode) => writeTaskFile(ctx, { task, ipc: ipcPath(ctx), deny: deny(task), mode, ...(head(task) ? { head: head(task) } : {}) }),
          runDir: join(ctx.storeDir, "agent", "run"),
          onAsk: (task, ask) => (ask ? this.asks.set(task, ask) : this.asks.delete(task)),
          home: ctx.home,
        }),
        codex: new CodexAdapter({ deny, head }),
        gemini: new GeminiAdapter({ deny, head }),
        herdr: new HerdrAdapter(),
        tmux: new TmuxAdapter(),
      };
  }

  private avail = new Map<DaemonAgentId, { at: number; r: Promise<{ ok: boolean; version?: string }> }>();

  /** Whether an agent CLI is installed (checked by running it, so remembered for a minute). */
  available(id: DaemonAgentId, fresh = false): Promise<{ ok: boolean; version?: string }> {
    const hit = this.avail.get(id);
    if (hit && !fresh && Date.now() - hit.at < 60_000) return hit.r;
    const a = this.adapters[id];
    const r = a ? a.available().catch(() => ({ ok: false })) : Promise.resolve({ ok: false });
    this.avail.set(id, { at: Date.now(), r });
    return r;
  }

  config(): AgentConfig {
    return withUseProfiles(this.ctx, loadAgentConfig(this.ctx));
  }

  async hello(): Promise<HelloFrame> {
    const cfg = this.config();
    const agents = await Promise.all(
      (["claude", "codex", "gemini", "herdr", "tmux"] as const).flatMap((id) => {
        const a = this.adapters[id];
        return a ? [this.available(id, true).then((r) => ({ id, ok: r.ok, ...(r.version ? { version: r.version } : {}) }))] : [];
      }),
    );
    const usable = agents.filter((a) => a.ok && AGENT_IDS.includes(a.id as AgentId)).map((a) => a.id);
    const profiles = Object.fromEntries(Object.entries(cfg.profiles ?? {}).map(([agent, p]) => [agent, Object.keys(p ?? {})]));
    // Connected: agent.json may have changed, so the supervisor follows it before the hub hears.
    if (this.send) this.supervisor();
    return {
      t: "hello",
      v: 1,
      machine: { name: machineName(), os: process.platform === "darwin" || process.platform === "win32" ? process.platform : "linux", arch: arch(), version },
      agents,
      repos: cfg.enabled ? cfg.repos.map((r) => ({ root: r.root, repo: repoName(r.root), agents: (r.agents ?? usable).filter((a) => usable.includes(a)), mode: r.mode, worktree: r.worktree })) : [],
      ...(Object.keys(profiles).length ? { profiles } : {}),
      // Only who it is: never paths or flags.
      ...(cfg.enabled && cfg.supervisor ? { host: supervisorInfo(cfg.supervisor) } : {}),
    };
  }

  /** The supervisor agent.json sets up (with agent control on), made again when its settings change; null without one. */
  supervisor(): HostSupervisor | null {
    const cfg = loadAgentConfig(this.ctx);
    const key = cfg.enabled && cfg.supervisor ? JSON.stringify(cfg.supervisor) : null;
    const seen = this.supKey;
    this.supKey = key;
    if (seen !== undefined && seen !== key) queueMicrotask(() => this.onSupervisorChange?.());
    if ((this.host?.key ?? null) === key) return this.host?.sup ?? null;
    this.host?.sup.stop();
    this.host = null;
    if (!key) return null;
    const sup = new HostSupervisor(this.ctx, cfg.supervisor!, { ...this.supOpts, mask: (s) => redact(s, this.vaultValues()), log: this.log });
    if (this.send) sup.connected(this.send);
    this.host = { key, sup, kind: cfg.supervisor!.kind };
    return sup;
  }

  /** The hub connection opened (frames go out through `send`) or closed (null). */
  connected(send: ((frame: object) => boolean) | null): void {
    this.send = send;
    (send ? this.supervisor() : this.host?.sup)?.connected(send);
    if (!send) return;
    const queued = this.outbox;
    this.outbox = [];
    for (const f of queued) if (!send(f)) this.outbox.push(f);
  }

  /** One frame from the hub. */
  async onFrame(msg: unknown): Promise<void> {
    const f = msg as HubFrame;
    if (f && typeof f === "object" && (f.t === "host-ack" || f.t === "host-cursor")) return void this.supervisor()?.onFrame(f);
    const m = msg as HubRequest;
    if (!m || typeof m !== "object" || m.t !== "req" || typeof m.rid !== "string") return;
    const reply = (r: Omit<ReplyFrame, "t" | "rid">) => this.send?.({ t: "reply", rid: m.rid, ...r });
    try {
      reply({ ok: true, data: await this.request(m) });
    } catch (e) {
      reply({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  async request(m: HubRequest): Promise<unknown> {
    switch (m.op) {
      case "start":
        return this.start(m);
      case "send":
        return this.sendTo(m);
      case "approve":
        return this.approve(m.task, m.request, m.decision, m.note);
      case "stop":
        return this.stop(m.task);
      case "sessions":
        return { running: await this.sessions() };
      case "host.request":
      case "host.followup":
      case "host.answer":
      case "host.status":
      case "host.questions":
      case "host.lookup":
      case "host.context": {
        this.enabled();
        const sup = this.supervisor();
        if (!sup) throw new Error(`no supervisor is set up on ${machineName()} (0b agent supervisor ledger, or openclaw --agent <id>, there)`);
        // An agent computer's call: only while this machine's supervisor is the work ledger,
        // as agent.json says now, whatever the hub last heard in a hello.
        if ((m as HostOp).ledgerOnly && this.host?.kind !== "ledger")
          throw new Error(`${machineName()}'s supervisor is ${this.host?.kind ?? "not set"} now, not the work ledger, so it takes nothing from an agent computer's token (0b agent supervisor ledger there)`);
        return sup.request(m as HostOp);
      }
      default:
        throw new Error(`unknown op ${(m as { op?: string }).op}`);
    }
  }

  /** A question from a task's permission tool (over the local socket). */
  async onIpc(msg: Record<string, unknown>): Promise<unknown> {
    if (msg.op === "ping") return { ok: true };
    // `0b agent supervisor …` changed agent.json: look again now (a change sends the hub a new hello).
    if (msg.op === "reload") return { supervisor: this.supervisor() ? this.host!.kind : null };
    if (msg.op === "status")
      return {
        connected: Boolean(this.send),
        tasks: [...this.tasks.values()].map((t) => ({ id: t.id, agent: t.agent, cwd: t.cwd, state: t.state, mode: t.mode })),
        ...(this.host ? { supervisor: this.host.sup.status() } : {}),
      };
    if (msg.op === "ask") {
      const ask = this.asks.get(String(msg.task));
      if (!ask) throw new Error("no such task here");
      return ask(String(msg.tool ?? ""), msg.input);
    }
    throw new Error("unknown request");
  }

  // ── Requests ─────────────

  private enabled(): AgentConfig {
    const cfg = this.config();
    if (!cfg.enabled) throw new Error("agent control is off on this machine (0b agent on)");
    return cfg;
  }

  /** The rules for `path`: an allowed repo, or a worktree of one made for a task. */
  policyFor(cfg: AgentConfig, path: string): RepoPolicy | null {
    const direct = repoFor(cfg, path);
    if (direct) return direct;
    const parts = resolve(path).split(sep);
    const at = parts.lastIndexOf(".0b-worktrees");
    if (at < 1 || !parts[at + 1]) return null;
    const m = /^(.+)-(t_[A-Za-z0-9]{4,32})$/.exec(parts[at + 1]!);
    if (!m) return null;
    return repoFor(cfg, [...parts.slice(0, at), m[1]!].join(sep));
  }

  /** The rules where `agent` would work at `cwd`; throws when that isn't an allowed repo, or not for this agent. */
  private allowedAt(cfg: AgentConfig, cwd: string, agent: string): RepoPolicy {
    const policy = this.policyFor(cfg, cwd);
    if (!policy) throw new Error(`${cwd} isn't in a repo agents may use on ${machineName()}`);
    if (policy.agents && AGENT_IDS.includes(agent as AgentId) && !policy.agents.includes(agent as AgentId)) throw new Error(`${agent} isn't allowed in ${policy.root} (allowed: ${policy.agents.join(", ")})`);
    return policy;
  }

  private running(): number {
    return [...this.tasks.values()].filter((t) => t.run && ["starting", "running", "waiting"].includes(t.state)).length;
  }

  private async start(m: Extract<HubRequest, { op: "start" }>) {
    const cfg = this.enabled();
    if (!TASK_ID.test(m.task)) throw new Error("bad task id");
    if (this.tasks.has(m.task)) throw new Error(`task ${m.task} already exists here`);
    if (typeof m.prompt !== "string" || !m.prompt.trim()) throw new Error("empty prompt");
    if (m.prompt.length > MAX_PROMPT) throw new Error("prompt too long");
    const agent = m.agent as AgentId;
    if (!AGENT_IDS.includes(agent)) throw new Error(`agents here: ${AGENT_IDS.join(", ")}`);
    const path = resolve(String(m.repo ?? ""));
    const policy = repoFor(cfg, path);
    if (!policy || !existsSync(path)) throw new Error(`${m.repo} isn't a repo agents may use on ${machineName()} (0b agent allow <path> there)`);
    if (policy.agents && !policy.agents.includes(agent)) throw new Error(`${agent} isn't allowed in ${policy.root} (allowed: ${policy.agents.join(", ")})`);
    const adapter = this.adapters[agent];
    if (!adapter || !(await this.available(agent)).ok) throw new Error(`${agent} isn't installed on ${machineName()}`);
    if (this.running() >= MAX_RUNNING) throw new Error(`${machineName()} is already running ${MAX_RUNNING} tasks; stop one first`);
    const mode = clampMode(m.mode, policy.mode);
    const env = profileEnv(cfg, agent, m.profile);

    let cwd = path;
    let branch: string | undefined;
    if (policy.worktree || m.worktree === true) ({ cwd, branch } = makeWorktree(path, m.task));
    const task: Task = { id: m.task, agent, root: policy.root, cwd, mode, env, deny: denyRules(policy), run: null, state: "starting", seq: 0, native: "", branch, pending: new Map(), updatedAt: Date.now() };
    this.tasks.set(task.id, task);
    logMeta(this.ctx, { task: task.id, agent, repo: policy.root, cwd, mode, ...(branch ? { branch } : {}), createdAt: Date.now() });
    this.emit(task, "status", { state: "starting" });
    this.log(`${task.id}: ${agent} in ${cwd} (${mode}${branch ? `, branch ${branch}` : ""})`);
    const started = adapter.start({ task: task.id, cwd, prompt: m.prompt, mode, env }, (e) => this.onAgent(task, e));
    // The hub waits 15 s for this reply; an agent slow to start (Gemini) goes on after it.
    const run = await Promise.race([started, new Promise<null>((r) => setTimeout(() => r(null), START_WAIT_MS).unref?.())]).catch((e: Error) => {
      this.finish(task, { ok: false, error: e.message });
      throw e;
    });
    if (run) this.track(task, run);
    else started.then((r) => this.track(task, r), (e: Error) => this.finish(task, { ok: false, error: e.message }));
    return { task: task.id, cwd, mode, ...(branch ? { branch } : {}), ...(task.native ? { native: task.native } : {}) };
  }

  private async sendTo(m: Extract<HubRequest, { op: "send" }>) {
    const cfg = this.enabled();
    if (typeof m.text !== "string" || !m.text.trim()) throw new Error("empty message");
    if (m.text.length > MAX_PROMPT) throw new Error("message too long");
    if (m.task && !TASK_ID.test(m.task)) throw new Error("bad task id");
    let task = m.task ? (this.tasks.get(m.task) ?? this.fromLog(m.task)) : undefined;
    if (task) {
      this.allowedAt(cfg, task.cwd, task.agent);
      if (task.run && ["starting", "running", "waiting"].includes(task.state)) {
        await task.run.send(m.text);
        this.emit(task, "status", { state: task.pending.size ? "waiting" : "running" });
        return { task: task.id };
      }
      return this.followUp(task, m.text);
    }
    if (!m.native) throw new Error(m.task ? `no task ${m.task} on ${machineName()}` : "say which task or session");
    return this.sendNative(cfg, m.task ?? newTaskId(), m.native, m.text);
  }

  /** A message to a session this daemon didn't start (or no longer holds). */
  private async sendNative(cfg: AgentConfig, id: string, native: { tool: string; id: string; cwd: string }, text: string) {
    if (typeof native.id !== "string" || !NATIVE_ID.test(native.id)) throw new Error("bad session id");
    const tool = (native.tool === "claude-code" ? "claude" : native.tool) as DaemonAgentId;
    if (!AGENT_IDS.includes(tool as AgentId)) throw new Error(`can't send to ${native.tool} sessions`);
    const policy = this.allowedAt(cfg, String(native.cwd ?? ""), tool);
    const task: Task = { id, agent: tool, root: policy.root, cwd: native.cwd, mode: policy.mode, env: {}, deny: denyRules(policy), run: null, state: "starting", seq: 0, native: native.id, pending: new Map(), updatedAt: Date.now() };
    this.tasks.set(task.id, task);
    logMeta(this.ctx, { task: id, agent: tool, repo: policy.root, cwd: native.cwd, mode: policy.mode, createdAt: Date.now() });
    return this.followUp(task, text);
  }

  /**
   * Where a message to an existing session goes, so that only one writer ever touches it: a
   * session open in a terminal gets it there (herdr, tmux when the repo allows typing, `codex
   * queue`), or not at all; otherwise the agent picks the session up headless. A live session is
   * checked where it really runs (its own folder and agent), not where the request says it does.
   */
  private async liveRoute(tool: DaemonAgentId, id: string, cwd: string): Promise<{ via: "herdr" | "tmux"; id: string } | { via: "queue" } | null> {
    const herdr = this.adapters.herdr;
    const pane = herdr && (await this.available("herdr")).ok ? ((await herdr.running?.().catch(() => [])) ?? []).find((s) => s.native === id) : undefined;
    if (pane) {
      this.allowedAt(this.config(), pane.cwd, pane.tool ?? tool);
      return { via: "herdr", id };
    }
    const tmux = this.adapters.tmux;
    if (tool === "claude") {
      const live = ((await this.adapters.claude?.running?.().catch(() => [])) ?? []).find((s) => s.native === id);
      if (!live) return null;
      const where = this.allowedAt(this.config(), live.cwd, "claude");
      const pane = tmux instanceof TmuxAdapter && where.keys && live.pid ? await tmux.paneOf(live.pid) : null;
      if (pane) return { via: "tmux", id: pane };
      throw new Error(`that session is open in a terminal on ${machineName()}; send it there (or close it there and try again)`);
    }
    if (tool === "codex" && tmux && (await this.available("tmux")).ok && ((await tmux.running?.().catch(() => [])) ?? []).some((s) => s.tool === "codex" && s.cwd === cwd)) return { via: "queue" };
    return null;
  }

  /** Continue a task's session (finished here, or never started here) with a new message. */
  private async followUp(task: Task, text: string) {
    if (!task.native) throw new Error(`task ${task.id} has no session to continue`);
    if (!NATIVE_ID.test(task.native)) throw new Error("bad session id");
    // Also for a task read back from its log: the repo's rules may have changed since.
    this.allowedAt(this.config(), task.cwd, task.agent);
    if (this.running() >= MAX_RUNNING) throw new Error(`${machineName()} is already running ${MAX_RUNNING} tasks; stop one first`);
    const route = await this.liveRoute(task.agent, task.native, task.cwd).catch((e: Error) => {
      if (task.state === "starting") this.finish(task, { ok: false, error: e.message });
      throw e;
    });
    if (route?.via === "queue" && this.adapters.codex instanceof CodexAdapter) {
      this.adapters.codex.queue(task.native, text, task.env);
      this.emit(task, "text", { text: "Queued for the Codex session open in a terminal (codex queue)." });
      this.finish(task, { ok: true });
      return { task: task.id, via: "codex queue" };
    }
    const via: DaemonAgentId = route && route.via !== "queue" ? route.via : task.agent;
    const adapter = this.adapters[via];
    if (!adapter?.attach) throw new Error(`can't continue ${task.agent} sessions`);
    task.state = "starting";
    this.emit(task, "status", { state: "starting", native: task.native });
    const target = route && route.via !== "queue" ? { id: route.id, cwd: task.cwd } : { id: task.native, cwd: task.cwd };
    const run = await adapter.attach(target, (e) => this.onAgent(task, e), { mode: task.mode, env: task.env, task: task.id }).catch((e: Error) => {
      this.finish(task, { ok: false, error: e.message });
      throw e;
    });
    this.track(task, run);
    await run.send(text);
    return { task: task.id, ...(route ? { via: route.via } : {}) };
  }

  private async approve(id: string, request: string, decision: "allow" | "deny", note?: string) {
    const task = this.tasks.get(id);
    if (!task?.run) throw new Error(`no task ${id} running on ${machineName()}`);
    if (decision !== "allow" && decision !== "deny") throw new Error("decision is allow or deny");
    const timer = task.pending.get(request);
    if (!timer) throw new Error(`no permission request ${request} is waiting`);
    clearTimeout(timer);
    task.pending.delete(request);
    await task.run.approve(request, decision, note);
    this.log(`${id}: ${request} ${decision === "allow" ? "allowed" : "denied"}`);
    this.emit(task, "status", { state: task.pending.size ? "waiting" : "running" });
    return { task: id };
  }

  private async stop(id: string) {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`no task ${id} on ${machineName()}`);
    if (!["starting", "running", "waiting"].includes(task.state)) return { task: id, state: task.state };
    task.state = "stopped";
    await task.run?.stop();
    return { task: id, state: "stopped" };
  }

  async sessions(): Promise<RunningSession[]> {
    const cfg = this.config();
    if (!cfg.enabled) return [];
    const out: RunningSession[] = [];
    const seen = new Set<string>();
    for (const t of this.tasks.values())
      if (t.run && ["starting", "running", "waiting"].includes(t.state) && t.native) {
        seen.add(t.native);
        out.push({ tool: t.agent, native: t.native, cwd: t.cwd, title: t.id, via: "daemon" });
      }
    for (const [via, id] of [
      ["herdr", "herdr"],
      ["tmux", "tmux"],
      ["process", "claude"],
    ] as const) {
      const a = this.adapters[id];
      if (!a?.running) continue;
      const list = await a.running().catch(() => []);
      for (const s of list) {
        if (seen.has(s.native) || !this.policyFor(cfg, s.cwd)) continue;
        seen.add(s.native);
        out.push({ tool: s.tool ?? id, native: s.native, cwd: s.cwd, ...(s.title ? { title: s.title } : {}), via });
      }
    }
    return out;
  }

  // ── Tasks ─────────────

  private track(task: Task, run: Run): void {
    task.run = run;
    // Stopped while it was still starting.
    if (task.state === "stopped") void run.stop();
    if (run.native) task.native = run.native;
    this.wake(task);
    run.done.then(
      (r) => task.run === run && this.finish(task, r),
      (e) => task.run === run && this.finish(task, { ok: false, error: String(e) }),
    );
  }

  /** The agent is under way: starting → running (with its session id when known). */
  private wake(task: Task): void {
    if (task.state !== "starting") return;
    this.emit(task, "status", { state: "running", ...(task.native ? { native: task.native } : {}) });
  }

  private onAgent(task: Task, e: AgentEvent): void {
    if (e.kind === "native") {
      if (task.native === e.native) return;
      task.native = e.native;
      if (task.state === "starting") return this.wake(task);
      return this.emit(task, "status", { state: task.state, native: e.native });
    }
    this.wake(task);
    switch (e.kind) {
      case "text":
        return this.emit(task, "text", { text: e.text });
      case "tool":
        return this.emit(task, "tool", { tool: e.tool, summary: e.summary });
      case "permission": {
        const timer = setTimeout(() => {
          if (!task.pending.delete(e.request)) return;
          this.emit(task, "text", { text: `No answer in 30 minutes: denied ${e.tool} (${e.summary}).` });
          void task.run?.approve(e.request, "deny", "no answer in 30 minutes").catch(() => {});
          this.emit(task, "status", { state: task.pending.size ? "waiting" : "running" });
        }, PERM_WAIT_MS);
        timer.unref?.();
        task.pending.set(e.request, timer);
        task.state = "waiting";
        this.emit(task, "permission", { request: e.request, tool: e.tool, summary: e.summary });
        return this.emit(task, "status", { state: "waiting" });
      }
      case "turn":
        if (!e.ok && e.error) this.emit(task, "error", { error: e.error });
        return;
      case "error":
        return this.emit(task, "error", { error: e.error });
    }
  }

  private finish(task: Task, r: { ok: boolean; error?: string }): void {
    for (const t of task.pending.values()) clearTimeout(t);
    task.pending.clear();
    const state: TaskState = task.state === "stopped" || r.error === "stopped" ? "stopped" : r.ok ? "done" : "failed";
    task.state = state;
    this.emit(task, "done", { state, ok: r.ok, ...(r.error && state !== "stopped" ? { error: r.error } : {}), ...(task.native ? { native: task.native } : {}) });
    this.log(`${task.id}: ${state}${r.error && state === "failed" ? ` (${r.error})` : ""}`);
    removeTaskFile(this.ctx, task.id);
    for (const ext of [".mcp.json", ".settings.json"]) rmSync(join(this.ctx.storeDir, "agent", "run", task.id + ext), { force: true });
    this.prune();
  }

  /** A finished task this process no longer holds (a restart), from its log. */
  private fromLog(id: string): Task | undefined {
    const t = readTask(this.ctx, id);
    if (!t?.meta) return undefined;
    const native = [...t.events].reverse().find((e) => e.data.native)?.data.native ?? "";
    const cfg = this.config();
    const policy = this.policyFor(cfg, t.meta.cwd);
    const task: Task = {
      id,
      agent: t.meta.agent as DaemonAgentId,
      root: t.meta.repo,
      cwd: t.meta.cwd,
      mode: clampMode(t.meta.mode, policy?.mode ?? "plan"),
      env: {},
      deny: denyRules(policy),
      run: null,
      state: "done",
      seq: t.events.at(-1)?.seq ?? 0,
      native,
      ...(t.meta.branch ? { branch: t.meta.branch } : {}),
      pending: new Map(),
      updatedAt: Date.now(),
    };
    this.tasks.set(id, task);
    return task;
  }

  private prune(): void {
    const old = Date.now() - 24 * 3600_000;
    for (const [id, t] of this.tasks) if (!["starting", "running", "waiting"].includes(t.state) && t.updatedAt < old) this.tasks.delete(id);
  }

  /** The vault's values this machine can open (masked in every event, as in synced history), read again each minute. */
  private vaultValues(): string[] {
    if (this.secrets && Date.now() - this.secrets.at < 60_000) return this.secrets.values;
    let values: string[] = [];
    try {
      values = vaultValues(this.ctx);
    } catch {}
    this.secrets = { at: Date.now(), values };
    return values;
  }

  private emit(task: Task, kind: EventKind, data: EventData): void {
    const clean: EventData = { ...data };
    const values = this.vaultValues();
    for (const k of ["text", "summary", "error"] as const) if (typeof clean[k] === "string") clean[k] = redact(clean[k]!, values).slice(0, MAX_TEXT);
    if (kind === "error") {
      if (clean.error === task.lastError) return;
      task.lastError = clean.error;
    }
    task.seq++;
    task.updatedAt = Date.now();
    if (clean.state && kind !== "done") task.state = clean.state;
    const frame: EventFrame = { t: "event", task: task.id, seq: task.seq, at: task.updatedAt, kind, data: clean };
    try {
      logEvent(this.ctx, task.id, { seq: frame.seq, at: frame.at, kind, data: clean });
    } catch {}
    if (!this.send?.(frame)) {
      this.outbox.push(frame);
      if (this.outbox.length > OUTBOX) this.outbox.splice(0, this.outbox.length - OUTBOX);
    }
  }

  /** Stop everything (the daemon is exiting). */
  async shutdown(): Promise<void> {
    this.host?.sup.stop();
    this.host = null;
    await Promise.all([...this.tasks.values()].map((t) => (t.run && ["starting", "running", "waiting"].includes(t.state) ? t.run.stop().catch(() => {}) : null)));
    if (this.adapters.codex instanceof CodexAdapter) this.adapters.codex.close();
  }
}

export const machineName = () => hostname().replace(/\.local$/, "");
export const newTaskId = () => `t_${randomBytes(5).toString("hex").slice(0, 8)}`;

/** owner/name from the origin remote, or the folder's name. */
function repoName(root: string): string | null {
  const r = spawnSync("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf8" });
  const url = r.status === 0 ? r.stdout.trim() : "";
  const m = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
  return m ? m[1]! : existsSync(root) ? basename(root) : null;
}

/**
 * A worktree for the task next to the repo, on its own branch: <repo>/../.0b-worktrees/<repo>-<task>
 * on 0b/<task>. Returns the folder to work in (the same subfolder when `path` is inside the repo).
 */
export function makeWorktree(path: string, task: string): { cwd: string; branch: string } {
  const git = (args: string[], cwd = path) => spawnSync("git", args, { cwd, encoding: "utf8" });
  const top = git(["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) throw new Error(`${path} isn't a git repo, so the task can't get its own worktree (set worktree: false for it in agent.json to work in place)`);
  const root = top.stdout.trim();
  const dir = join(dirname(root), ".0b-worktrees", `${basename(root)}-${task}`);
  const branch = `0b/${task}`;
  mkdirSync(dirname(dir), { recursive: true });
  const r = git(["worktree", "add", dir, "-b", branch], root);
  if (r.status !== 0) throw new Error(`git worktree add failed: ${r.stderr.trim().split("\n").at(-1)}`);
  const sub = relative(resolve(root), resolve(path));
  return { cwd: sub && !sub.startsWith("..") ? join(dir, sub) : dir, branch };
}

/** Per-task files left by a daemon that didn't exit cleanly (none of its tasks run any more). */
export function cleanRunDir(ctx: Context): void {
  const dir = join(ctx.storeDir, "agent", "run");
  try {
    for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true });
  } catch {}
}

/**
 * `0b agent run`: the daemon in the foreground (the service runs this). Holds the hub connection
 * and the local socket until stopped; tasks still running are stopped with it. When the hub says
 * the machine is gone for good (its token deleted, or removed on the dashboard), agent control is
 * turned off here and the service removed, so the service manager doesn't bring it straight back.
 */
export async function runDaemon(ctx: Context, opts: { log?: (line: string) => void } = {}): Promise<void> {
  const cfg = loadCloud(ctx);
  const token = cfg && openSecretStore(ctx.storeDir).get(deviceTokenKey(cfg));
  if (!cfg || !token) throw new Error("sign in first: 0b login");
  if (typeof WebSocket === "undefined") throw new Error("this needs Node 22 or newer (WebSocket)");
  if (!loadAgentConfig(ctx).enabled) throw new Error("agent control is off on this machine (0b agent on)");
  const daemon = new Daemon(ctx, opts);
  const log = opts.log ?? ((line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`));
  cleanRunDir(ctx);
  const ipc = await serveIpc(ipcPath(ctx), (m) => daemon.onIpc(m));
  let hello = await daemon.hello();
  let conn: Conn | null = null;
  let warned = false;
  const server = cfg.server.replace(/\/+$/, "");
  const url = `${server.replace(/^http/, "ws")}/api/machines/connect`;
  const loop = connectLoop(url, token, (msg) => void daemon.onFrame(msg), {
    // A socket that never opened: is it the token (deleted while this machine was off)?
    refused: async () => (await fetch(`${server}/api/machines`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) })).status === 401,
    onOpen: (c) => {
      conn = c;
      c.send(hello);
      daemon.connected(c.send);
      log(`connected to ${cfg.server} as ${hello.machine.name} (${hello.repos.length} ${hello.repos.length === 1 ? "repo" : "repos"} allowed)`);
    },
    onClose: (code, reason) => {
      if (conn) log(`disconnected (${code}${reason ? ` ${reason}` : ""})`);
      else if (!warned) log(`can't connect to ${cfg.server} yet (is agent control on for your account?); trying again`);
      warned = !conn;
      conn = null;
      daemon.connected(null);
    },
  });

  // agent.json changed (0b agent allow, deny, off): tell the hub what this machine offers now.
  const cfgFile = join(ctx.storeDir, "agent.json");
  const mtime = () => (existsSync(cfgFile) ? statSync(cfgFile).mtimeMs : 0);
  let seen = mtime();
  const resend = async () => {
    seen = mtime();
    hello = await daemon.hello();
    conn?.send(hello);
  };
  // The supervisor changed (`0b agent supervisor` pokes the daemon, or a request found it): tell the hub now.
  daemon.onSupervisorChange = () => void resend().catch(() => {});
  const watch = setInterval(async () => {
    if (mtime() === seen) return;
    await resend();
  }, 15_000);

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    log("stopping");
    loop.stop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const final = await loop.done;
  clearInterval(watch);
  await daemon.shutdown();
  await ipc.close();
  if (final === null) return;
  const off = loadAgentConfig(ctx);
  off.enabled = false;
  saveAgentConfig(ctx, off);
  log(
    final === 4003
      ? "this machine was removed on the dashboard: agent control is off here now (0b agent on adds it back)"
      : "this device's 0bridge token was deleted: agent control is off here now (sign in again with 0b login, then 0b agent on)",
  );
  // Last: removing the service may stop this very process.
  installService(ctx, "agent", null, {});
}

