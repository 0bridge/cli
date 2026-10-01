import { existsSync, readFileSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  AGENT_VM_DAYS,
  AGENT_VM_NAME,
  AGENT_VM_PLATFORMS,
  AGENT_VM_TOS,
  CloudClient,
  CloudError,
  DEFAULT_SERVER,
  TOOL_IDS,
  agentVmPlatform,
  emptyManifest,
  executePlan,
  getAdapters,
  isInstalled,
  loadCloud,
  loadHistoryConfig,
  loadManifest,
  loadState,
  openSecretStore,
  ownedHooks,
  planApply,
  planHooks,
  readJson,
  saveHistoryConfig,
  saveManifest,
  saveState,
  writeAtomic,
  type AgentVmPlatform,
  type Context,
  type ToolId,
} from "@0bridge/core";
import { cloudClient, finishLogin, installBridgeSkill, pollDeviceSignIn, printSignInLink, startDeviceSignIn, type DeviceStart } from "./cloud.ts";
import { contextCommand, planContext } from "./context.ts";
import { filesCommand, repoHere, HOME_REPO } from "./files.ts";
import { sessionsCommand } from "./sessions.ts";
import { ensureBin } from "./service.ts";
import { signedIn } from "./setup.ts";
import { localKey, requestUnlock } from "./vault.ts";
import { c } from "./ui.ts";

/**
 * `0b setup --agent-vm` (round 2, D53): set up an AI agent's computer (Muse, Manus…) with no
 * prompts, so an agent can run it from a pasted prompt. It signs in with a dashboard attach code
 * or the device link, gets an expiring device token labeled as an agent VM, and sets up Claude
 * Code and Codex (the 0bridge entry, skills, AGENTS.md), personal files, history and status hooks,
 * and a vault unlock request. It never installs background services or `0b agent`, and never signs
 * the agents in to Claude or Codex for the user.
 *
 * Output is plain lines an agent can relay: `✓` done, `…` waiting on someone, `!` didn't work (the
 * run goes on), each with what to do next. A link nobody approved yet isn't an error: the flow is
 * saved in agent-vm/pending.json and the command exits 0, so running it again picks it up.
 */

export interface AgentVmOptions {
  attach?: string;
  email?: string;
  name?: string;
  days?: number;
  platform?: string;
  qr?: string;
  noVault?: boolean;
  noWait?: boolean;
  server?: string;
  only?: ToolId[];
}

/** How long one run waits for the link to be approved: under the 10 minutes the code lives, and under most agents' shell limits it isn't. */
const WAIT_MS = 9 * 60_000;
/** Claude Code and Codex: the agents people run on someone else's computer. */
const VM_TOOLS: ToolId[] = ["claude", "codex"];

const ok = (s: string) => console.log(`${c.green("✓")} ${s}`);
const waiting = (s: string) => console.log(`${c.cyan("…")} ${s}`);
const warn = (s: string) => console.log(`${c.yellow("!")} ${s}`);
const skip = (s: string) => console.log(c.dim(`· ${s}`));
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The OS as people name it: "Debian GNU/Linux 12 (bookworm)", "macOS", or the platform. */
export function osName(release = "/etc/os-release"): string {
  if (process.platform === "darwin") return "macOS";
  try {
    const m = /^PRETTY_NAME="?([^"\n]+)"?$/m.exec(readFileSync(release, "utf8"));
    if (m) return m[1]!.trim().slice(0, 64);
  } catch {}
  return process.platform;
}

/**
 * Which agent's computer this is. `--platform` wins. None of the agent computers documents an
 * environment marker yet (checked 2026-10-01), so without it this is `other` rather than a guess.
 */
export function detectPlatform(given: string | undefined): AgentVmPlatform["id"] {
  if (given === undefined) return "other";
  const p = agentVmPlatform(given.trim().toLowerCase());
  if (!p) throw new Error(`--platform is one of ${AGENT_VM_PLATFORMS.map((x) => x.id).join(", ")}`);
  return p.id;
}

/** `<platform>-<short hostname>`, as a name the server takes. */
export function defaultName(platform: string, host = hostname()): string {
  const short = host.split(".")[0]!.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const name = `${platform}-${short || "vm"}`;
  return AGENT_VM_NAME.test(name) ? name : `${platform}-vm`;
}

export function daysOf(given: number | undefined): number {
  if (given === undefined) return AGENT_VM_DAYS.default;
  if (!Number.isInteger(given) || given < 1 || given > AGENT_VM_DAYS.max)
    throw new Error(`--days is a whole number from 1 to ${AGENT_VM_DAYS.max}: an agent VM's token expires, and running this again with a new code renews it`);
  return given;
}

/** A sign-in link shown but not approved yet, kept for the next run. */
interface Pending {
  server: string;
  start: DeviceStart;
  name: string;
  days: number;
  platform: string;
  /** An attach code the server already turned down: the next run doesn't try it again. */
  failedAttach?: string;
}

const pendingPath = (ctx: Context) => join(ctx.storeDir, "agent-vm", "pending.json");
const savePending = (ctx: Context, p: Pending) => writeAtomic(pendingPath(ctx), JSON.stringify(p, null, 1) + "\n", { mode: 0o600 });
const clearPending = (ctx: Context) => rmSync(pendingPath(ctx), { force: true });

/** With the device-flow bootstrap session: POST /api/agent-vm/tokens. */
export async function attachWithSession(server: string, bootstrap: string, vm: { name: string; days: number; platform?: string }): Promise<{ id: string; token: string; expiresAt: number }> {
  return new CloudClient(server.replace(/\/+$/, ""), bootstrap).call("POST", "/agent-vm/tokens", { ...vm, os: osName(), arch: process.arch });
}

/** With a dashboard code: POST /agent-vm/attach (no session). The name the dashboard gave the code wins over `vm.name`. */
export async function attachWithCode(
  server: string,
  code: string,
  vm: { name: string; platform?: string; os: string; arch: string },
): Promise<{ id: string; token: string; expiresAt: number; name?: string }> {
  const res = await fetch(`${server.replace(/\/+$/, "")}/agent-vm/attach`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: code.trim(), ...vm }),
  }).catch((e) => {
    throw new CloudError(`can't reach ${server} (${why(e)})`, 0);
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; token?: string; expiresAt?: number; name?: string; error?: string; error_description?: string };
  if (!res.ok || !body.token) throw new CloudError(body.error_description ?? body.error ?? `${res.status} ${res.statusText}`, res.status);
  return { id: body.id!, token: body.token, expiresAt: body.expiresAt!, ...(body.name ? { name: body.name } : {}) };
}

/** The bootstrap session from an approved link: mint the VM's token, drop the session, save the token. */
async function finishWithSession(ctx: Context, server: string, bootstrap: string, vm: { name: string; days: number; platform: string }): Promise<void> {
  const t = await attachWithSession(server, bootstrap, vm);
  await fetch(`${server}/auth/sign-out`, { method: "POST", headers: { Authorization: `Bearer ${bootstrap}`, Origin: server, "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
  await finishLogin(ctx, server, t.token, { embedded: true });
  clearPending(ctx);
  ok(`This computer is ${vm.name}; its token expires ${day(t.expiresAt)}`);
}

/** Step 2. "done" once a token is saved; "pending" when a link waits for approval (the run stops there, exit 0). */
async function signIn(ctx: Context, server: string, vm: { name: string; days: number; platform: string }, opts: AgentVmOptions): Promise<"done" | "pending"> {
  let pending = readJson<Pending>(pendingPath(ctx));
  if (pending && (pending.server !== server || pending.start.expiresAt <= Date.now() || pending.name !== vm.name)) {
    clearPending(ctx);
    pending = null;
  }
  let failedAttach = pending?.failedAttach;
  const until = () => (opts.noWait ? Date.now() + 1000 : Date.now() + WAIT_MS);
  const stillPending = (s: DeviceStart) => {
    waiting(`Not approved yet. Approve this computer at ${s.link} (code ${s.userCode}${s.match ? `, pick ${s.match} on the dashboard` : ""}), then run this same command again.`);
    return "pending" as const;
  };

  // A code from the dashboard: no link to approve.
  const attach = (opts.attach ?? process.env.ZEROB_ATTACH)?.trim();
  if (attach && attach !== failedAttach) {
    try {
      const t = await attachWithCode(server, attach, { name: vm.name, platform: vm.platform, os: osName(), arch: process.arch });
      await finishLogin(ctx, server, t.token, { embedded: true });
      clearPending(ctx);
      ok(`Attached with the setup code. This computer is ${t.name ?? vm.name}; its token expires ${day(t.expiresAt)}`);
      if (t.name && t.name !== vm.name) vm.name = t.name;
      return "done";
    } catch (e) {
      if (!(e instanceof CloudError) || e.status !== 404) throw e;
      warn(`That setup code was already used or has expired. Make a new one at ${server}/app/agent-vm, or approve the link below.`);
      failedAttach = attach;
      if (pending) savePending(ctx, { ...pending, failedAttach });
    }
  }

  // A link from an earlier run.
  if (pending) {
    waiting(`Checking the sign-in link from before (${pending.start.link})`);
    try {
      const token = await pollDeviceSignIn(server, pending.start, { untilMs: until() });
      if (token === "pending") return stillPending(pending.start);
      await finishWithSession(ctx, server, token, vm);
      return "done";
    } catch (e) {
      clearPending(ctx);
      warn(`The earlier link: ${why(e)}. Here's a new one.`);
    }
  }

  // A new link. The account's email (when known) asks its dashboard to approve this computer.
  const email = (opts.email ?? process.env.ZEROB_EMAIL)?.trim();
  const machine = { name: vm.name, os: osName(), arch: process.arch, kind: "agent-vm" as const, platform: vm.platform };
  const start = await startDeviceSignIn(server, { ...(email ? { hint: { email, machine } } : {}), agentVm: true });
  // Saved before waiting: an agent's shell that kills this command mid-wait loses nothing.
  savePending(ctx, { server, start, ...vm, ...(failedAttach ? { failedAttach } : {}) });
  printSignInLink(start, { tty: false, ...(opts.qr ? { qr: opts.qr } : {}) });
  if (opts.noWait) return stillPending(start);
  let token: string;
  try {
    token = await pollDeviceSignIn(server, start, { untilMs: until() });
  } catch (e) {
    clearPending(ctx);
    throw e;
  }
  if (token === "pending") return stillPending(start);
  await finishWithSession(ctx, server, token, vm);
  return "done";
}

/** Steps 3 to 7 report a failure and go on: the rest is still worth doing, and a re-run retries. */
async function step(label: string, run: () => Promise<void> | void): Promise<void> {
  try {
    await run();
  } catch (e) {
    warn(`${label}: ${why(e)}`);
  }
}

/** Turn-end and prompt hooks in each agent's settings, recorded as ours like `0b history hooks on` does. */
function installHooks(ctx: Context): string[] {
  const plan = planHooks(ctx, true, ensureBin(ctx));
  if (plan.changes.length) executePlan(ctx, { changes: plan.changes, warnings: [], missing: [], state: loadState(ctx) });
  const owned = ownedHooks(ctx);
  const state = loadState(ctx);
  for (const t of ["claude", "codex", "cursor"] as ToolId[]) {
    if (owned[t]) (state.managed[t] ??= { mcp: [], skills: [] }).hooks = owned[t];
    else if (state.managed[t]) delete state.managed[t]!.hooks;
  }
  saveState(ctx, state);
  return Object.keys(owned);
}

export async function agentVmSetup(ctx: Context, opts: AgentVmOptions): Promise<void> {
  // 1. Name, platform, days: refused before anything is written.
  const platform = detectPlatform(opts.platform);
  const days = daysOf(opts.days);
  if (opts.name !== undefined && !AGENT_VM_NAME.test(opts.name)) throw new Error("--name is letters, digits, dots, dashes and underscores (up to 64), starting with a letter or digit");
  const vm = { name: opts.name ?? defaultName(platform), days, platform };
  const server = (opts.server ?? process.env.ZEROBRIDGE_SERVER ?? loadCloud(ctx)?.server ?? DEFAULT_SERVER).replace(/\/+$/, "");
  const info = agentVmPlatform(platform)!;
  console.log(`0bridge setup for an AI agent's computer: ${c.bold(vm.name)} (${info.name}, ${osName()}, ${process.arch})`);
  if (info.status === "unsupported") warn(`${info.name} isn't supported yet (${info.notes}). Going on anyway.`);

  // 2. Sign in.
  const who = await signedIn(ctx);
  if (who) ok(`Already signed in as ${who}`);
  else if ((await signIn(ctx, server, vm, opts)) === "pending") return;

  // 3. The agents: 0bridge, skills, and your instructions and skills from 0bridge.
  const adapters = getAdapters(ctx);
  const wanted = opts.only ?? VM_TOOLS;
  const tools = wanted.filter((t) => isInstalled(adapters[t]));
  await step("Instructions and skills", async () => {
    const { cfg, client } = cloudClient(ctx);
    const pull = (await planContext(ctx, client, cfg.userId)).items.filter((it) => it.action === "pull" || it.action === "delete-local");
    await contextCommand(ctx, ["pull"], { quiet: true });
    if (pull.length) ok(`From 0bridge: ${pull.map((it) => it.label).join(", ")}`);
    else skip(`Nothing new from 0bridge's instructions and skills (0b context push on your main computer sends yours)`);
  });
  await step("Tools", () => {
    const m = loadManifest(ctx) ?? emptyManifest();
    for (const t of TOOL_IDS) m.tools[t] = { enabled: wanted.includes(t) };
    installBridgeSkill(ctx, m);
    saveManifest(ctx, m);
    if (!tools.length) {
      warn(`Neither Claude Code nor Codex is on this computer yet. Install one (npm install -g @anthropic-ai/claude-code, or @openai/codex), then run this same command again.`);
      return;
    }
    const plan = planApply(ctx, loadManifest(ctx)!, loadState(ctx), openSecretStore(ctx.storeDir), tools);
    const names = tools.map((t) => adapters[t].label).join(", ");
    if (plan.missing.length) warn(`${names}: not synced yet, ${plan.missing.join(", ")} missing (0b secret set <name>, then 0b apply --yes)`);
    else if (plan.changes.length) ok(`${names}: 0bridge, its skills and your instructions added (backed up first: 0b restore ${executePlan(ctx, plan)})`);
    else ok(`${names} already have 0bridge`);
  });

  // 4. Personal files of the repo this runs in. They're sealed with the vault key, so only once it's open here.
  await step("Personal files", async () => {
    const here = repoHere(process.cwd());
    if (!here || here.repo === HOME_REPO) return skip("Not in a git clone: no personal files to pull (run 0b files pull in one later)");
    if (!localKey(ctx)) return skip(`Personal files for ${here.repo} come once the vault is open here: then run 0b files pull in this clone`);
    await filesCommand(ctx, ["pull"], { quiet: true });
    ok(`Personal files for ${here.repo} pulled`);
  });

  // 5. History and the session board, by hooks only: no background service on someone else's computer.
  await step("History", () => {
    saveHistoryConfig(ctx, { ...loadHistoryConfig(ctx), enabled: true });
    const hooked = installHooks(ctx);
    ok(
      hooked.length
        ? `History on: each conversation goes up as its turn ends, secrets masked here first (${hooked.map((t) => adapters[t as ToolId].label).join(", ")})`
        : "History on (no agent here takes the hook yet; run this again after installing one)",
    );
  });
  await step("Session status", async () => {
    await sessionsCommand(ctx, ["on"], { quiet: true });
    ok("Session status on: your board shows when an agent here is working or waiting for you");
  });

  // 6. Ask for the vault key; the owner approves on their own device (with a warning that this is an agent's computer).
  if (opts.noVault) skip("Vault: skipped (--no-vault). 0b vault unlock asks for it later");
  else
    await step("Vault", async () => {
      const r = await requestUnlock(ctx, { waitMs: 0, agentVm: true });
      if (r === "none") skip("Vault: your account has none yet. Once you make one (0b secret set on your computer), 0b vault unlock here asks for it");
      else if (r === "already" || r === "unlocked") ok("Vault open here");
      else if (r === "pending") waiting("Vault: approve the request above on a device that has it open; secrets reach commands here through 0b exec");
      else warn(`Vault: the request was ${r}. 0b vault unlock asks again`);
    });

  // 7. What's set up, and how the agents sign in.
  await step("Summary", async () => {
    const { cfg, client } = cloudClient(ctx);
    const vms = (await client.call<{ vms: { tokenId: string; name: string; expiresAt: number | null }[] }>("GET", "/agent-vm")).vms;
    const mine = vms.find((v) => v.tokenId === cfg.tokenId);
    console.log("");
    console.log(`Done. ${mine ? `${c.bold(mine.name)} is signed in as ${cfg.login}${mine.expiresAt ? ` until ${day(mine.expiresAt)}` : ""}` : `Signed in as ${cfg.login} with a regular device token`}.`);
    console.log(`  Tools: ${tools.length ? tools.map((t) => adapters[t].label).join(", ") : "none yet"}. Restart them (and open sessions) to load 0bridge.`);
    console.log(`  Hooks keep your history and status current; run 0b background on if this computer stays up.`);
    console.log(`  Revoke this computer any time at ${server}/app/agent-vm. To renew its token, run 0b logout here, then this command with a new code.`);
  });
  console.log("");
  console.log(AGENT_VM_TOS);
  console.log("Sign the agents in:");
  console.log("  Claude Code: on your own computer, 0b secret set ANTHROPIC_API_KEY --global; then here, 0b exec -- claude");
  console.log("  Codex: codex login --device-auth (a ChatGPT plan), or OPENAI_API_KEY in your vault and 0b exec -- codex");
  if (existsSync(pendingPath(ctx))) clearPending(ctx);
}
