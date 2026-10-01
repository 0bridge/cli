import * as p from "@clack/prompts";
import {
  deviceTokenKey,
  PRESETS,
  TOOL_IDS,
  emptyManifest,
  executePlan,
  getAdapters,
  isInstalled,
  loadCloud,
  loadManifest,
  loadState,
  openSecretStore,
  planApply,
  saveManifest,
  scanTools,
  type Context,
  type ToolId,
} from "@0bridge/core";
import { c, planSummary } from "./ui.ts";
import { cloudClient, connectCommand, installBridgeSkill, login } from "./cloud.ts";
import { chooseTools } from "./tui.ts";

export interface SetupOptions {
  /** Never prompt: every detected tool (or `only`), no service picker. What agents run. */
  yes?: boolean;
  only?: ToolId[];
  connect?: string[];
  web?: boolean;
  server?: string;
}

const hostOf = (u?: string) => {
  try {
    return u ? new URL(u).host : "";
  } catch {
    return "";
  }
};

/** Signed in with a device token the server still accepts (an expired agent-VM token isn't). */
export async function signedIn(ctx: Context): Promise<string | null> {
  const cfg = loadCloud(ctx);
  if (!cfg || !openSecretStore(ctx.storeDir).get(deviceTokenKey(cfg))) return null;
  try {
    return (await cloudClient(ctx).client.me()).login;
  } catch {
    return null;
  }
}

/**
 * The one command a new user (or their agent) runs: sign in, put 0bridge into every AI tool
 * on this machine, and connect services. Safe to re-run; each step skips what's already done.
 */
export async function setup(ctx: Context, opts: SetupOptions): Promise<void> {
  const interactive = !opts.yes && process.stdin.isTTY && process.stdout.isTTY;
  const adapters = getAdapters(ctx);
  const installed = TOOL_IDS.filter((t) => isInstalled(adapters[t]));
  p.intro(c.bold(" 0bridge setup "));
  if (!installed.length) {
    p.cancel("No AI tools found. Install Claude Code, Codex or Cursor, then run this again.");
    process.exit(1);
  }

  // 1. Which tools get 0bridge.
  if (interactive && !opts.only) await chooseTools(ctx);
  else {
    const fresh = !loadManifest(ctx);
    const m = loadManifest(ctx) ?? emptyManifest();
    if (opts.only || fresh) for (const t of TOOL_IDS) m.tools[t] = { enabled: (opts.only ?? installed).includes(t) };
    saveManifest(ctx, m);
  }
  const m = loadManifest(ctx)!;
  const targets = installed.filter((t) => m.tools[t]?.enabled !== false);
  p.log.step(`Tools: ${targets.map((t) => adapters[t].label).join(", ")}`);

  // 2. Sign in (device code: the browser opens; also works over SSH).
  const who = await signedIn(ctx);
  if (who) {
    p.log.step(`Signed in as ${c.bold(who)}`);
    const m2 = loadManifest(ctx)!;
    installBridgeSkill(ctx, m2);
    saveManifest(ctx, m2);
  }
  else await login(ctx, opts.server, { web: opts.web, embedded: true });

  // 3. Write the gateway (and anything else in the manifest) into each tool.
  const store = openSecretStore(ctx.storeDir);
  const plan = planApply(ctx, loadManifest(ctx)!, loadState(ctx), store);
  if (plan.missing.length) {
    p.log.warn(`Not syncing yet: ${plan.missing.join(", ")} missing. Set them with ${c.cyan("0b secret set <name>")}, then run ${c.cyan("0b apply")}.`);
  } else if (plan.changes.length) {
    const id = executePlan(ctx, plan);
    p.note(planSummary(ctx, plan).join("\n"), "Added to your tools");
    p.log.success(`Backed up first — undo with ${c.cyan(`0b restore ${id}`)}`);
  } else {
    p.log.step("Your tools already have 0bridge.");
  }

  // 4. Services. Each sign-in opens in the browser and is kept in the cloud, so it's done once for every tool.
  let services = opts.connect ?? [];
  let urls: Record<string, string> = {};
  const connected = new Set((await cloudClient(ctx).client.connections()).map((x) => x.service.toLowerCase()));
  if (interactive && !services.length) {
    // Only what the user already has in an AI tool on this machine (remote MCP servers, by host):
    // moving those into the bridge is the point here. Anything else: 0b connect <name>.
    const own = hostOf(loadCloud(ctx)?.server ?? "");
    const found = new Map<string, { name: string; url: string; tools: Set<string> }>();
    for (const f of scanTools(ctx).servers) {
      const url = f.server.url;
      const host = url ? hostOf(url) : "";
      if (!url || !host || host === own) continue;
      const preset = Object.entries(PRESETS).find(([, u]) => hostOf(u) === host)?.[0];
      // A server set up with a key in its headers connects here only if it also takes a sign-in.
      if (f.server.headers && !preset) continue;
      const entry = found.get(host) ?? { name: preset ?? f.name.toLowerCase(), url: preset ? PRESETS[preset]! : url, tools: new Set() };
      entry.tools.add(adapters[f.tool].label);
      found.set(host, entry);
    }
    const options = [...found.values()]
      .filter((x) => !connected.has(x.name))
      .map((x) => ({ value: x.name, label: x.name, hint: `you use it in ${[...x.tools].join(", ")}` }));
    urls = Object.fromEntries([...found.values()].map((x) => [x.name, x.url]));
    const picked = options.length
      ? await p.multiselect({
          message: `Connect services you use ${c.dim("— sign in once in the browser; every tool can use them")}`,
          options,
          required: false,
        })
      : [];
    services = p.isCancel(picked) ? [] : picked;
  }
  for (const s of services) {
    try {
      await connectCommand(ctx, s, PRESETS[s] ? undefined : urls[s], {});
    } catch (e) {
      p.log.error(`${s}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const conns = await cloudClient(ctx).client.connections();
  const cfg = loadCloud(ctx)!;
  p.note(
    [
      conns.length ? `Services: ${conns.map((x) => `${x.display} (${x.state})`).join(", ")}` : `No services yet — ${c.cyan("0b connect linear")}`,
      `Connect more:   ${c.cyan("0b connect <service>")}  ${c.dim(`(${Object.keys(PRESETS).slice(0, 5).join(", ")}, … or any MCP URL)`)}`,
      `Second account: ${c.cyan("0b connect linear --label <org>")}`,
      `Your MCP servers and skills: ${c.cyan("0b")}  ${c.dim("(import them and keep every tool in sync)")}`,
      `Dashboard:      ${c.cyan(`${cfg.server}/app`)}`,
    ].join("\n"),
    "Next",
  );
  p.outro(`Done. Restart ${targets.map((t) => adapters[t].label).join(", ")} (and open sessions) to load 0bridge.`);
}
