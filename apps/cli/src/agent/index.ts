import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { CloudError, type Context } from "@0bridge/core";
import { cloudClient } from "../cloud.ts";
import { installService, serviceInstalled } from "../service.ts";
import { c } from "../ui.ts";
import { Daemon, machineName, runDaemon } from "./daemon.ts";
import { ipcPath, ipcRequest } from "./ipc.ts";
import { listTasks, readTask } from "./log.ts";
import { guard, permMcp } from "./perm-mcp.ts";
import { runAgent, which } from "./adapters/spawn.ts";
import { DEFAULT_DENY, MODES, SUPERVISOR_AGENT, loadAgentConfig, realPath, saveAgentConfig, supervisorTitle, tooBroad, type Mode } from "./policy.ts";
import { readSupervisorState } from "./supervisor.ts";

/**
 * `0b agent`: let your AI apps start and steer coding agents on this machine, in the repos
 * you allow, through 0bridge's machine hub. `on` allows a repo and installs the daemon (`run`),
 * `allow`/`deny` change the repos, `status` and `log` show what's there and what tasks did.
 * `perm-mcp` and `guard` are what a Claude Code task runs to ask before it acts.
 */

export interface AgentOptions {
  repo?: string;
  mode?: string;
  yes?: boolean;
  quiet?: boolean;
  /** `0b agent supervisor openclaw`: the OpenClaw agent id, its label, and the binaries. */
  agent?: string;
  label?: string;
  hostTask?: string;
  openclaw?: string;
  herdr?: string;
}

function fail(msg: string): never {
  console.error(c.red(`error: ${msg}`));
  process.exit(1);
}

const USAGE = `usage: 0b agent on [path] [--mode plan|edit|auto] | off | status | allow <path> [--mode m] | deny <path> | run | log [task] | supervisor ledger | supervisor openclaw --agent <id> | supervisor off | supervisor status`;
const SUPERVISOR_USAGE = "usage: 0b agent supervisor ledger [--label <name>] [--host-task <path>] | supervisor openclaw --agent <id> [--label <name>] [--host-task <bin>] [--openclaw <bin>] [--herdr <bin>] | supervisor off | supervisor status";

async function confirm(q: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(`${q} ${c.dim("[y/N]")} `);
  rl.close();
  return /^y(es)?$/i.test(a.trim());
}

const gitTop = (dir: string) => {
  const r = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
};

function parseMode(m: string | undefined): Mode | undefined {
  if (m === undefined) return undefined;
  if (!MODES.includes(m as Mode)) fail(`--mode is one of ${MODES.join(", ")}`);
  return m as Mode;
}

const MODE_TEXT: Record<Mode, string> = {
  plan: "plan only: agents read and propose, nothing is changed",
  edit: "edit: agents change files in their worktree and ask before anything else",
  auto: "auto: agents decide more on their own (refused commands still never run)",
};

export async function agentCommand(ctx: Context, args: string[], opts: AgentOptions): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "on":
      return on(ctx, [opts.repo, ...rest].filter((p): p is string => Boolean(p)), parseMode(opts.mode), opts.yes);
    case "off": {
      const cfg = loadAgentConfig(ctx);
      cfg.enabled = false;
      saveAgentConfig(ctx, cfg);
      installService(ctx, "agent", null, {});
      return console.log(`${c.green("✓")} Agent control is off on this machine: AI apps can't start or steer agents here. ${c.dim("(Your allowed repos are kept for next time.)")}`);
    }
    case "allow":
      if (!rest[0]) fail("usage: 0b agent allow <path> [--mode plan|edit|auto]");
      return allow(ctx, rest[0], parseMode(opts.mode), true);
    case "deny":
    case "disallow": {
      if (!rest[0]) fail("usage: 0b agent deny <path>");
      const cfg = loadAgentConfig(ctx);
      const path = real(rest[0]);
      const before = cfg.repos.length;
      cfg.repos = cfg.repos.filter((r) => r.root !== path);
      if (cfg.repos.length === before) fail(`${path} isn't allowed (allowed: ${cfg.repos.map((r) => r.root).join(", ") || "none"})`);
      saveAgentConfig(ctx, cfg);
      return console.log(`${c.green("✓")} Agents can no longer work in ${path}.`);
    }
    case "status":
    case undefined:
      return status(ctx);
    case "run":
      return runDaemon(ctx);
    case "log":
      return log(ctx, rest[0]);
    case "supervisor":
      supervisor(ctx, rest, opts);
      // A running daemon looks at agent.json again now and tells the hub its new supervisor, rather
      // than on its next 15-second check (D74: the hub picks a machine by that kind). Not running: nothing to tell.
      if (rest[0] === "ledger" || rest[0] === "openclaw" || rest[0] === "off") await ipcRequest(ipcPath(ctx), { op: "reload" }, 2000).catch(() => {});
      return;
    case "perm-mcp":
      if (!rest[0]) fail("usage: 0b agent perm-mcp <task file>");
      return permMcp(rest[0]);
    case "guard":
      process.exitCode = await guard(rest[0] ?? "");
      return;
    default:
      fail(USAGE);
  }
}

const real = realPath;

/** Add (or change the mode of) an allowed repo. */
function allow(ctx: Context, path: string, mode: Mode | undefined, say: boolean): void {
  const root = real(path);
  if (!existsSync(root) || !statSync(root).isDirectory()) fail(`${root} isn't a folder`);
  const broad = tooBroad(ctx, root);
  if (broad) fail(broad);
  const cfg = loadAgentConfig(ctx);
  const git = gitTop(root) !== null;
  const had = cfg.repos.find((r) => r.root === root);
  if (had) had.mode = mode ?? had.mode;
  else cfg.repos.push({ root, mode: mode ?? "edit", worktree: git, deny: [] });
  saveAgentConfig(ctx, cfg);
  if (!say) return;
  const r = cfg.repos.find((x) => x.root === root)!;
  console.log(`${c.green("✓")} Agents may work in ${root} (${MODE_TEXT[r.mode]}).`);
  if (!git) console.log(c.yellow(`  It isn't a git repo, so tasks work in the folder itself instead of a worktree of their own.`));
  if (r.mode === "auto") console.log(c.yellow(`  Auto mode lets agents act without asking you for more. Use it only where a mistake is cheap.`));
}

async function on(ctx: Context, paths: string[], mode: Mode | undefined, yes?: boolean): Promise<void> {
  const { cfg: account, client } = cloudClient(ctx);
  // The account's switch (dashboard, with a fresh sign-in) comes first: without it the hub refuses.
  try {
    const s = await client.call<{ agentControl?: boolean }>("GET", "/settings");
    if (s.agentControl !== true)
      fail(`agent control is off for your 0bridge account. Turn it on in the dashboard (${account.server.replace(/\/+$/, "")}/app/settings, "AI apps"), then run 0b agent on again.`);
  } catch (e) {
    if (!(e instanceof CloudError) || ![404, 501].includes(e.status)) throw e;
    console.log(c.yellow("This 0bridge server doesn't say whether agent control is on; going ahead."));
  }
  const cfg = loadAgentConfig(ctx);
  if (!paths.length && !cfg.repos.length) {
    const here = gitTop(process.cwd());
    if (here && (yes || (await confirm(`Let your AI apps start coding agents in ${here}? (each task in its own worktree, ${mode ?? "edit"} mode)`)))) paths = [here];
  }
  for (const p of paths) allow(ctx, p, mode, false);
  const next = loadAgentConfig(ctx);
  next.enabled = true;
  saveAgentConfig(ctx, next);
  const where = installService(ctx, "agent", ["agent", "run"], { keepAlive: true });
  console.log(`${c.green("✓")} Agent control is on for ${machineName()}${where ? c.dim(` (${where})`) : ""}.`);
  if (!next.repos.length) console.log(`  No repo is allowed yet, so nothing can run: ${c.cyan("0b agent allow <path>")}`);
  for (const r of next.repos) console.log(`  ${r.root}  ${c.dim(MODE_TEXT[r.mode])}`);
  console.log(c.dim(`  Never run here: push to main or master, force push, merge, deploy, publish (${DEFAULT_DENY.length} rules). Permission prompts come to you; nothing is approved for you.`));
}

async function status(ctx: Context): Promise<void> {
  const cfg = loadAgentConfig(ctx);
  console.log(`${c.bold("Agent control on this machine")}  ${cfg.enabled ? c.green("on") : c.dim("off")}${serviceInstalled(ctx, "agent") ? c.dim(" (service installed)") : ""}`);
  const live = await ipcRequest<{ connected: boolean; tasks: { id: string; agent: string; cwd: string; state: string; mode: string }[] }>(ipcPath(ctx), { op: "status" }, 2000).catch(() => null);
  console.log(`  daemon: ${live ? (live.connected ? c.green("connected") : c.yellow("running, not connected")) : c.dim("not running")}`);
  try {
    const { client } = cloudClient(ctx);
    const s = await client.call<{ agentControl?: boolean }>("GET", "/settings", undefined, [404, 501]);
    if (typeof s?.agentControl === "boolean") console.log(`  account: agent control ${s.agentControl ? c.green("on") : c.yellow("off (dashboard → Settings → AI apps)")}`);
  } catch {}
  const daemon = new Daemon(ctx, { log: () => {} });
  const hello = await daemon.hello();
  console.log(`\n${c.bold("Agents")}`);
  for (const a of hello.agents) console.log(`  ${a.id.padEnd(7)} ${a.ok ? c.green(a.version ?? "ok") : c.dim("not found")}`);
  console.log(`\n${c.bold("Repos")}${cfg.repos.length ? "" : c.dim("  none: 0b agent allow <path>")}`);
  for (const r of cfg.repos) console.log(`  ${r.root}  ${c.dim(`${r.mode}${r.worktree ? ", worktree per task" : ", in place"}${r.agents ? `, ${r.agents.join("/")}` : ""}${r.deny.length ? `, +${r.deny.length} rules` : ""}`)}`);
  for (const t of live?.tasks.filter((t) => ["starting", "running", "waiting"].includes(t.state)) ?? []) console.log(`  ${c.cyan(t.id)} ${t.agent} ${t.state} ${c.dim(t.cwd)}`);
  const sup = cfg.supervisor;
  console.log(
    `\n${c.bold("Supervisor")}  ${sup ? `${supervisorTitle(sup)}${c.dim(`, host-task cursor ${readSupervisorState(ctx).cursor ?? "not set yet"}`)}` : c.dim(`none: ${SETUP}`)}`,
  );
}

/**
 * `0b agent supervisor`: who takes host work asked for through 0bridge (docs/plans/dots-host.md).
 * Set only here, on the machine; the server learns no more than the agent's id and label. Each
 * binary is checked before it's saved.
 */
function supervisor(ctx: Context, args: string[], opts: AgentOptions): void {
  const [what] = args;
  const cfg = loadAgentConfig(ctx);
  if (what === "off") {
    if (!cfg.supervisor) return console.log(c.dim("No supervisor is set up on this machine."));
    delete cfg.supervisor;
    saveAgentConfig(ctx, cfg);
    return console.log(`${c.green("✓")} Host work no longer goes to a supervisor here; AI apps can't request host tasks on ${machineName()}.`);
  }
  if (what === "status" || what === undefined) {
    const s = cfg.supervisor;
    if (!s) return console.log(c.dim(`No supervisor is set up on this machine: ${SETUP}`));
    const st = readSupervisorState(ctx);
    console.log(`${c.bold("Supervisor")}  ${supervisorTitle(s)}${cfg.enabled ? "" : c.yellow("  (agent control is off here: 0b agent on)")}`);
    console.log(`  kind: ${s.kind}${s.kind === "ledger" ? c.dim(" (requests go into host-task's log as dev_request; the team gives them task ids)") : ""}`);
    console.log(s.kind === "openclaw" ? `  host-task: ${s.hostTask}  openclaw: ${s.openclaw}  herdr: ${s.herdr}` : `  host-task: ${s.hostTask}`);
    console.log(`  cursor: ${st.cursor ?? c.dim("not set yet (starts at the end of host-task's log)")}`);
    if (s.kind === "openclaw")
      console.log(`  queued for ${s.agent}: ${st.queue.length}${st.queue.length ? c.dim(` (${st.queue.map((d) => `${d.id} → ${d.task}${d.attempts ? `, ${d.attempts} failed` : ""}`).join("; ")})`) : ""}`);
    else {
      const all = Object.values(st.ledger);
      const waiting = all.filter((r) => !r.task);
      console.log(`  requests recorded: ${all.length}, waiting for a task id: ${waiting.length}${waiting.length ? c.dim(` (${waiting.slice(-5).map((r) => `${r.id} → dev_request #${r.event ?? "?"}`).join("; ")})`) : ""}`);
    }
    if (st.lastError) console.log(`  last error: ${c.yellow(st.lastError.text)} ${c.dim(new Date(st.lastError.at).toISOString().slice(0, 16).replace("T", " "))}`);
    return;
  }
  if (what === "ledger") return ledger(ctx, cfg, opts);
  if (what !== "openclaw") fail(SUPERVISOR_USAGE);
  const prev = cfg.supervisor?.kind === "openclaw" ? cfg.supervisor : undefined;
  const agent = opts.agent ?? prev?.agent;
  if (!agent || !SUPERVISOR_AGENT.test(agent)) fail(`--agent is the OpenClaw agent's id (lead, …). ${SUPERVISOR_USAGE}`);
  // Absolute paths, found now on this shell's PATH: the service that runs the daemon may not have the same PATH.
  const bins = {
    hostTask: program("host-task", opts.hostTask ?? cfg.supervisor?.hostTask ?? "host-task", ["--help"]),
    openclaw: program("openclaw", opts.openclaw ?? prev?.openclaw ?? "openclaw", ["--version"]),
    herdr: program("herdr", opts.herdr ?? prev?.herdr ?? "herdr", ["--version"]),
  };
  checkEvents(bins.hostTask);
  const list = runAgent(bins.openclaw, ["agents", "list", "--json"], { timeout: 30_000 });
  let known = false;
  try {
    const all = JSON.parse(list.out) as unknown;
    const arr = Array.isArray(all) ? all : ((all as { agents?: unknown[] })?.agents ?? []);
    known = arr.some((a) => (typeof a === "string" ? a : (a as { id?: string; agentId?: string })?.id ?? (a as { agentId?: string })?.agentId) === agent);
  } catch {}
  const label = opts.label?.trim() || prev?.label || null;
  cfg.supervisor = { kind: "openclaw", agent, label, ...bins, pollMs: cfg.supervisor?.pollMs ?? 3000, maxDispatch: prev?.maxDispatch ?? 2 };
  saveAgentConfig(ctx, cfg);
  console.log(`${c.green("✓")} Host work your AI apps request through 0bridge goes to OpenClaw's ${c.bold(agent)}${label ? ` (${label})` : ""} on ${machineName()}.`);
  if (!known) console.log(c.yellow(`  openclaw agents list doesn't show an agent "${agent}"; check the id (it's saved anyway).`));
  console.log(c.dim(`  Each task gets its own ${agent} session (0bridge-t-…); replies stay in OpenClaw and host-task, nothing is posted to Slack or any channel.`));
  console.log(c.dim(`  ${agent} decides where and how the work runs: the repos and modes allowed with 0b agent allow apply to agents 0bridge starts itself, not to host work.`));
  if (!cfg.enabled) console.log(c.yellow(`  Agent control is off on this machine, so nothing reaches it yet: 0b agent on`));
}

/**
 * `0b agent supervisor ledger` (docs/plans/dots-host.md, "Ledger mode"): what the user tells an AI
 * app through 0bridge goes into host-task's log the way the host's desk records it (dev_request,
 * user_followup, user_decision); the team there makes the task. Only host-task is needed.
 */
function ledger(ctx: Context, cfg: ReturnType<typeof loadAgentConfig>, opts: AgentOptions): void {
  const hostTask = program("host-task", opts.hostTask ?? cfg.supervisor?.hostTask ?? "host-task", ["--help"]);
  checkEvents(hostTask);
  const label = opts.label?.trim() || (cfg.supervisor?.kind === "ledger" ? cfg.supervisor.label : null) || null;
  cfg.supervisor = { kind: "ledger", label, hostTask, pollMs: cfg.supervisor?.pollMs ?? 3000 };
  saveAgentConfig(ctx, cfg);
  console.log(`${c.green("✓")} What you tell your AI apps for ${machineName()} goes into its work ledger (host-task)${label ? `, for ${c.bold(label)}` : ""}.`);
  console.log(c.dim(`  A request is a dev_request (the team gives it a task id), a follow-up a user_followup, an answer a user_decision, each with the user's words and where they came from.`));
  console.log(c.dim(`  0bridge makes no task, runs no agent and types into no pane here. The team's questions ([선택지]) and results come back to the apps.`));
  console.log(c.dim(`  host-task: ${hostTask}`));
  if (!cfg.enabled) console.log(c.yellow(`  Agent control is off on this machine, so nothing reaches it yet: 0b agent on`));
}

const SETUP = "0b agent supervisor ledger, or 0b agent supervisor openclaw --agent <id>";

/**
 * A program the supervisor runs, checked (it answers `args`) and saved as its absolute path: the
 * daemon runs as a service (systemd, launchd) whose PATH may not have ~/.local/bin, where host-task lives.
 */
function program(name: string, bin: string, args: string[]): string {
  if (!bin.trim() || bin.startsWith("-")) fail(`${name}: ${bin} isn't a program`);
  const found = which(bin);
  if (!found) fail(`${name} (${bin}) doesn't run here: not found${bin.includes("/") || bin.includes("\\") ? "" : ` (not on PATH; pass --${name} <path>)`}`);
  const abs = resolve(found);
  const r = runAgent(abs, args, { timeout: 20_000 });
  if (r.code !== 0) fail(`${name} (${abs}) doesn't run here${r.err.trim() ? `: ${r.err.trim().split("\n").at(-1)}` : ""}`);
  return abs;
}

/** host-task's event log must read as JSON: that's what the daemon follows. */
function checkEvents(hostTask: string): void {
  const ev = runAgent(hostTask, ["events", "--since=0", "--limit=1"], { timeout: 20_000 });
  let readable = false;
  try {
    readable = ev.code === 0 && Array.isArray((JSON.parse(ev.out) as { events?: unknown }).events);
  } catch {}
  if (!readable) fail(`host-task events didn't answer as expected${ev.err.trim() ? ` (${ev.err.trim().split("\n").at(-1)})` : ""}`);
}

function log(ctx: Context, task?: string): void {
  if (!task) {
    const all = listTasks(ctx);
    if (!all.length) return console.log(c.dim("No tasks on this machine yet."));
    for (const t of all.slice(0, 30))
      console.log(`${c.cyan(t.meta.task)}  ${t.state.padEnd(8)} ${t.meta.agent.padEnd(6)} ${new Date(t.updatedAt).toISOString().slice(0, 16).replace("T", " ")}  ${c.dim(t.meta.cwd)}`);
    return;
  }
  const t = readTask(ctx, task);
  if (!t) fail(`no task ${task} on this machine (0b agent log lists them)`);
  if (t.meta) console.log(c.dim(`${t.meta.agent} in ${t.meta.cwd} (${t.meta.mode}${t.meta.branch ? `, branch ${t.meta.branch}` : ""})`));
  for (const e of t.events) {
    const at = new Date(e.at).toISOString().slice(11, 19);
    const d = e.data;
    const line =
      e.kind === "text" ? d.text : e.kind === "tool" ? `${d.tool}: ${d.summary}` : e.kind === "permission" ? `asks ${d.tool}: ${d.summary} (${d.request})` : e.kind === "error" ? c.red(d.error ?? "") : `${d.state ?? ""}${d.error ? ` ${d.error}` : ""}`;
    console.log(`${c.dim(at)} ${e.kind.padEnd(10)} ${line}`);
  }
}

