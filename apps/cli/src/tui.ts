import { mkdirSync } from "node:fs";
import {
  PRESETS,
  TOOL_IDS,
  distinctBy,
  loadCloud,
  emptyManifest,
  executePlan,
  getAdapters,
  groupByName,
  importFromTools,
  isInstalled,
  loadManifest,
  loadState,
  openSecretStore,
  planApply,
  portableKey,
  readInstructions,
  requireManifest,
  saveManifest,
  saveState,
  scanTools,
  secretValues,
  type Context,
  type McpServer,
  type ToolId,
} from "@0bridge/core";
import { c, kindLabel, p, planSummary, printPlan, printStatus, printWarnings, skillDescription, spinner, tilde, where } from "./ui.ts";
import { askLabel, cloudClient, connectCommand, connectService, login, migrateTui, renameConnection } from "./cloud.ts";
import { printTree } from "./tree.ts";

function bail<T>(v: T): Exclude<T, symbol> {
  if (p.isCancel(v)) {
    p.cancel("Cancelled — nothing else written.");
    process.exit(0);
  }
  return v as Exclude<T, symbol>;
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });

/** Pick what to bring in from the tools, then save it to the manifest. */
async function importFlow(ctx: Context): Promise<void> {
  const adapters = getAdapters(ctx);
  const label = (t: ToolId) => adapters[t].label;
  const m = loadManifest(ctx) ?? emptyManifest();
  const scan = scanTools(ctx);

  // ── MCP servers ─────────────────────────────────────────────
  const servers = groupByName(scan.servers);
  const newServers = [...servers.keys()].filter((n) => !m.mcpServers[n]).sort(byName);
  const variantsOf = (n: string) => distinctBy(servers.get(n)!, (f) => portableKey(f.server));
  let pickedServers: string[] = [];
  if (newServers.length) {
    pickedServers = bail(
      await p.multiselect({
        message: `MCP servers to manage ${c.dim(`— ${newServers.length} found, uncheck what you don't want synced`)}`,
        options: newServers.map((n) => {
          const found = servers.get(n)!;
          const tools = found.map((f) => f.tool).join(", ");
          const variants = variantsOf(n);
          const hint =
            variants.length > 1
              ? c.yellow(`${variants.length} different versions`) + ` · ${tools}`
              : `${where(found[0]!.server, 40)} · ${found[0]!.pinned ? c.yellow(`${found[0]!.tool} only`) : tools}`;
          return { value: n, label: n, hint };
        }),
        initialValues: newServers,
        required: false,
      }),
    );
  }

  const prefer: Record<string, ToolId> = {};
  for (const n of pickedServers) {
    const variants = variantsOf(n);
    if (variants.length < 2) continue;
    const toolsWith = (s: McpServer) => servers.get(n)!.filter((f) => portableKey(f.server) === portableKey(s)).map((f) => label(f.tool));
    prefer[n] = bail(
      await p.select({
        message: `${c.bold(n)} is set up differently across tools. Which version should every tool use?`,
        options: variants.map((v) => ({ value: v.tool, label: `${kindLabel(v.server)}  ${where(v.server, 56)}`, hint: toolsWith(v.server).join(", ") })),
      }),
    );
  }

  const overrides: Record<string, Partial<McpServer>> = {};
  for (const n of pickedServers) {
    const chosen = (prefer[n] ? servers.get(n)!.find((f) => f.tool === prefer[n]) : servers.get(n)![0])!.server;
    if (chosen.transport !== "sse") continue;
    const url = bail(
      await p.text({
        message: `${c.bold(n)} uses SSE, which Codex can't run and MCP has deprecated. Switch to its streamable HTTP URL?`,
        initialValue: chosen.url!.replace(/\/sse\/?$/, "/mcp"),
        placeholder: "empty = keep SSE",
      }),
    ).trim();
    if (url) overrides[n] = { transport: "http", url };
  }

  // ── Skills ──────────────────────────────────────────────────
  const skills = groupByName(scan.skills);
  const newSkills = [...skills.keys()].filter((n) => !m.skills[n]).sort(byName);
  let pickedSkills: string[] = [];
  if (newSkills.length) {
    const groups: Record<string, { value: string; label: string; hint?: string }[]> = {};
    for (const n of newSkills) {
      const first = skills.get(n)![0]!;
      (groups[`from ${label(first.tool)}`] ??= []).push({ value: n, label: n, hint: skillDescription(first.dir) });
    }
    pickedSkills = bail(
      await p.groupMultiselect({
        message: `Skills to share across tools ${c.dim(`— ${newSkills.length} found`)}`,
        options: groups,
        initialValues: newSkills,
        required: false,
        selectableGroups: true,
      }),
    );
  }
  const preferSkills: Record<string, ToolId> = {};
  for (const n of pickedSkills) {
    const variants = distinctBy(skills.get(n)!, (s) => s.hash);
    if (variants.length < 2) continue;
    preferSkills[n] = bail(
      await p.select({
        message: `Skill ${c.bold(n)} has different content across tools. Which copy should every tool use?`,
        options: variants.map((v) => ({ value: v.tool, label: label(v.tool), hint: skillDescription(v.dir) })),
      }),
    );
  }

  // ── Instructions ────────────────────────────────────────────
  let instructions: ToolId | false = false;
  const texts = distinctBy(scan.instructions, (i) => i.text);
  if (texts.length && !readInstructions(ctx).trim()) {
    const preview = (t: string) => t.split("\n").slice(0, 6).join("\n") + (t.split("\n").length > 6 ? c.dim("\n…") : "");
    if (texts.length === 1) {
      p.note(preview(texts[0]!.text), `Instructions in ${label(texts[0]!.tool)}`);
      instructions = bail(await p.confirm({ message: "Use these instructions in every tool (AGENTS.md / CLAUDE.md / GEMINI.md)?" })) ? texts[0]!.tool : false;
    } else {
      instructions = bail(
        await p.select<ToolId | false>({
          message: "Tools have different global instructions. Which should every tool use?",
          options: [
            ...texts.map((t) => ({ value: t.tool as ToolId | false, label: label(t.tool), hint: t.text.split("\n")[0]!.slice(0, 50) })),
            { value: false, label: "None", hint: "leave instructions alone" },
          ],
        }),
      );
    }
  }

  // ── Save ────────────────────────────────────────────────────
  const store = openSecretStore(ctx.storeDir);
  const spin = spinner();
  spin.start("Saving to ~/.0bridge");
  mkdirSync(ctx.storeDir, { recursive: true, mode: 0o700 });
  const state = loadState(ctx);
  const report = importFromTools(ctx, m, state, store, {
    // Names already in the manifest stay included so their copies in other tools are adopted.
    include: { mcp: [...pickedServers, ...Object.keys(m.mcpServers)], skills: [...pickedSkills, ...Object.keys(m.skills)] },
    prefer: { mcp: prefer, skills: preferSkills },
    overrides,
    instructions,
  });
  saveManifest(ctx, m);
  saveState(ctx, state);
  const secrets = report.secrets.length ? ` · ${report.secrets.length} secret(s) moved to ${store.kind}` : "";
  spin.stop(`Saved ${Object.keys(m.mcpServers).length} MCP servers, ${Object.keys(m.skills).length} skills${secrets}`);
  for (const x of report.conflicts) {
    p.log.warn(`${x.kind} ${x.name}: ${x.other}'s version differs — kept ${x.kept}'s; ${x.other} left as is`);
  }
}

/** Show what a sync would do and apply it on request. */
export async function syncFlow(ctx: Context): Promise<void> {
  const m = requireManifest(ctx);
  const store = openSecretStore(ctx.storeDir);
  const plan = planApply(ctx, m, loadState(ctx), store);
  if (!plan.changes.length) {
    for (const w of plan.warnings) p.log.warn(tilde(ctx, w));
    p.log.success("Every tool is in sync.");
    return;
  }
  p.note(planSummary(ctx, plan).join("\n"), "Ready to sync");
  for (const w of plan.warnings) p.log.warn(tilde(ctx, w));
  if (plan.missing.length) {
    printWarnings(ctx, { ...plan, warnings: [] });
    p.log.error("Set the missing secrets before syncing.");
    return;
  }
  for (;;) {
    const choice = bail(
      await p.select({
        message: "Write these changes into your tools?",
        options: [
          { value: "apply", label: "Apply", hint: "every file is backed up first" },
          { value: "diff", label: "Show diff", hint: "secrets masked" },
          { value: "later", label: "Not now", hint: "run `0b apply` any time" },
        ],
      }),
    );
    if (choice === "diff") {
      printPlan(ctx, { ...plan, warnings: [] }, secretValues(m, store), true);
      continue;
    }
    if (choice === "apply") {
      const id = executePlan(ctx, plan);
      p.log.success(`Synced. Undo with ${c.cyan(`0b restore ${id}`)}`);
      p.log.info("Restart running agent sessions to pick up the changes.");
    }
    return;
  }
}

async function chooseEnabled(kind: "mcp" | "skills", ctx: Context) {
  const m = requireManifest(ctx);
  const entries = kind === "mcp" ? m.mcpServers : m.skills;
  const names = Object.keys(entries).sort(byName);
  if (!names.length) return p.log.info("Nothing here yet.");
  const picked = bail(
    await p.multiselect({
      message: kind === "mcp" ? "MCP servers enabled in your tools" : "Skills enabled in your tools",
      options: names.map((n) => {
        const e = entries[n]!;
        const only = e.targets ? c.yellow(`${e.targets.join(", ")} only`) : "";
        const hint = kind === "mcp" ? `${where(e as McpServer, 40)} ${only}` : only;
        return { value: n, label: n, hint };
      }),
      initialValues: names.filter((n) => entries[n]!.enabled !== false),
      required: false,
    }),
  );
  let changed = 0;
  for (const n of names) {
    const on = picked.includes(n);
    if (on === (entries[n]!.enabled !== false)) continue;
    changed++;
    if (on) delete entries[n]!.enabled;
    else entries[n]!.enabled = false;
  }
  saveManifest(ctx, m);
  p.log.success(changed ? `${changed} change(s) saved. Sync to apply them.` : "No changes.");
}

/** Which installed tools 0bridge writes into; tools it doesn't manage are left untouched. */
export async function chooseTools(ctx: Context): Promise<void> {
  const adapters = getAdapters(ctx);
  const m = loadManifest(ctx) ?? emptyManifest();
  const installed = TOOL_IDS.filter((t) => isInstalled(adapters[t]));
  const picked = bail(
    await p.multiselect({
      message: `Tools to keep in sync ${c.dim(`— ${installed.length} found on this machine`)}`,
      options: installed.map((t) => ({ value: t, label: adapters[t].label, hint: tilde(ctx, adapters[t].configPath) })),
      initialValues: installed.filter((t) => m.tools[t]?.enabled !== false),
      required: true,
    }),
  );
  for (const t of TOOL_IDS) m.tools[t] = { ...m.tools[t], enabled: picked.includes(t) };
  saveManifest(ctx, m);
}

export async function initTui(ctx: Context): Promise<void> {
  p.intro(c.bold(" 0bridge "));
  const adapters = getAdapters(ctx);
  const found = TOOL_IDS.filter((t) => isInstalled(adapters[t])).map((t) => adapters[t].label);
  if (!found.length) {
    p.outro("No supported tools found (Claude Code, Codex, Cursor, Gemini CLI).");
    return;
  }
  await chooseTools(ctx);
  await importFlow(ctx);
  await syncFlow(ctx);
  p.outro(`Run ${c.cyan("0b")} any time to manage and sync.`);
}

export async function homeTui(ctx: Context): Promise<void> {
  p.intro(c.bold(" 0bridge "));
  for (;;) {
    const m = requireManifest(ctx);
    const plan = planApply(ctx, m, loadState(ctx), openSecretStore(ctx.storeDir));
    const pending = plan.changes.length;
    const mcpOn = Object.values(m.mcpServers).filter((s) => s.enabled !== false).length;
    const skillsOn = Object.values(m.skills).filter((s) => s.enabled !== false).length;
    const cloud = loadCloud(ctx);
    const who = cloud ? c.dim(` · cloud: ${cloud.login}`) : "";
    const choice = bail(
      await p.select({
        message: `${mcpOn} MCP servers · ${skillsOn} skills · ${pending ? c.yellow(`${pending} change(s) to sync`) : c.green("in sync")}${who}`,
        options: [
          ...(pending ? [{ value: "sync", label: "Sync now" }] : []),
          ...(cloud
            ? [
                { value: "connect", label: "Connect a service in the cloud", hint: "Linear, Notion, Sentry, …" },
                { value: "rename", label: "Rename a cloud connection", hint: "e.g. one per workspace" },
                { value: "migrate", label: "Move remote servers to the cloud" },
              ]
            : [{ value: "login", label: "Sign in to 0bridge cloud", hint: "one MCP endpoint for every tool and device" }]),
          { value: "tree", label: "Overview", hint: "everything as a tree" },
          { value: "tools", label: "Choose tools to sync", hint: "Claude Code, Codex, Cursor, …" },
          { value: "mcp", label: "Choose MCP servers" },
          { value: "skills", label: "Choose skills" },
          { value: "status", label: "Status by tool" },
          { value: "import", label: "Import new from tools" },
          { value: "quit", label: "Quit" },
        ],
      }),
    );
    if (choice === "quit") break;
    if (choice === "sync") await syncFlow(ctx);
    if (choice === "tools") await chooseTools(ctx);
    if (choice === "mcp") await chooseEnabled("mcp", ctx);
    if (choice === "skills") await chooseEnabled("skills", ctx);
    if (choice === "import") await importFlow(ctx);
    if (choice === "status") printStatus(ctx, m, openSecretStore(ctx.storeDir));
    if (choice === "login") await login(ctx).catch((e) => p.log.error(e.message));
    if (choice === "migrate") await migrateTui(ctx).catch((e) => p.log.error(e.message));
    if (choice === "connect") await connectTui(ctx).catch((e) => p.log.error(e.message));
    if (choice === "rename") await renameTui(ctx).catch((e) => p.log.error(e.message));
    if (choice === "tree") await printTree(ctx);
  }
  p.outro("Bye.");
}

async function connectTui(ctx: Context) {
  const preset = bail(
    await p.select({
      message: "Which service?",
      options: [...Object.entries(PRESETS).map(([n, url]) => ({ value: n, label: n, hint: url })), { value: "", label: "Other…", hint: "any MCP URL" }],
    }),
  );
  let service = preset;
  let url = PRESETS[preset];
  if (!url) {
    service = bail(await p.text({ message: "Service name", placeholder: "my-service", validate: (v) => (v?.trim() ? undefined : "required") })).trim();
    url = bail(await p.text({ message: "MCP URL", placeholder: "https://…/mcp", validate: (v) => (v?.startsWith("https://") ? undefined : "must start with https://") }));
  }
  // A known service: the same choice as `0b connect` (its MCP server, 0bridge's app, its API or CLI).
  if (PRESETS[preset]) return connectCommand(ctx, service, undefined, {});
  const label = await askLabel(ctx, service);
  const r = await connectService(ctx, service, label, url!);
  p.log.success(`${r.display} connected as ${r.prefix}__*. Every tool using your 0bridge can use it now.`);
}

async function renameTui(ctx: Context) {
  const conns = await cloudClient(ctx).client.connections();
  if (!conns.length) return p.log.info("No cloud connections yet.");
  const id = bail(
    await p.select({ message: "Which connection?", options: conns.map((x) => ({ value: x.id, label: x.display, hint: `${x.prefix}__* · ${x.url}` })) }),
  );
  await renameConnection(ctx, conns.find((x) => x.id === id)!);
}
