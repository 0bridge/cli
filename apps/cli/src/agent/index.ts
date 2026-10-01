import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { CloudError, type Context } from "@0bridge/core";
import { cloudClient } from "../cloud.ts";
import { installService, serviceInstalled } from "../service.ts";
import { c } from "../ui.ts";
import { Daemon, machineName, runDaemon } from "./daemon.ts";
import { ipcPath, ipcRequest } from "./ipc.ts";
import { listTasks, readTask } from "./log.ts";
import { guard, permMcp } from "./perm-mcp.ts";
import { DEFAULT_DENY, MODES, loadAgentConfig, saveAgentConfig, tooBroad, type Mode } from "./policy.ts";

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
}

function fail(msg: string): never {
  console.error(c.red(`error: ${msg}`));
  process.exit(1);
}

const USAGE = `usage: 0b agent on [path] [--mode plan|edit|auto] | off | status | allow <path> [--mode m] | deny <path> | run | log [task]`;

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

const real = (p: string) => {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
};

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

