import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import {
  accountName,
  CloudClient,
  deviceTokenKey,
  extraClaudeDirs,
  findAccount,
  importProject,
  loadManifest,
  loadAccounts,
  loadState,
  projectScope,
  requireManifest,
  saveManifest,
  saveState,
  seenIn,
  editMcpTables,
  openSecretStore,
  parseToml,
  readJson,
  repoOf,
  withVault,
  writeAtomic,
  type CloudProjects,
  type Context,
} from "@0bridge/core";
import { cloudClient, findConnection } from "./cloud.ts";
import { CLOUD_HOOK_COMMAND, CLOUD_HOOK_PATH, cloudHookScript } from "./cloud-hook.ts";
import { ignoreLocally } from "./files.ts";
import { linkAccount, loadLinks, saveLinks } from "./links.ts";
import { render, type Node } from "./tree.ts";
import { c } from "./ui.ts";

/**
 * Projects (projects.ts on the gateway): a repo whose agents reach 0bridge at the project's own
 * endpoint, /mcp/p/<id>, and so see the connections limited to it (and the global ones unless it's
 * strict). `0b project link` points this checkout's tool configs there, with a token that opens
 * that endpoint only:
 *   Claude Code  ~/.claude.json, this folder's local-scope server (wins over the user-scope one)
 *   Codex        .codex/config.toml in the checkout (read once the folder is trusted)
 *   Cursor       .cursor/mcp.json in the checkout
 * The files in the checkout hold the token, so they're kept out of git (.git/info/exclude).
 *
 * `0b project cloud` is for agents that run in the cloud on a clone (Claude Code on the web): files
 * meant to be committed, which name the token's environment variable (ZEROB_TOKEN) instead of
 * holding it, plus a hook that uploads each cloud session to the user's history and posts its
 * state to their session board (cloud-hook.ts).
 */

const SERVER_NAME = "0bridge";
const tokenKey = (projectId: string) => `project.${projectId}`;

export { loadLinks };

function fail(msg: string): never {
  console.error(c.red(`error: ${msg}`));
  process.exit(1);
}

/** This checkout and the repo it's for (the remote, so every clone is the same project). */
export function here(cwd = process.cwd()): { root: string; repo: string } {
  const inRepo = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, encoding: "utf8" }).stdout?.trim() === "true";
  if (!inRepo) fail("run this inside a git repo (the project is the repo)");
  const r = repoOf(cwd);
  return { root: r.path, repo: r.remote ?? r.path };
}

const tracked = (root: string, path: string) => spawnSync("git", ["ls-files", "--error-unmatch", path], { cwd: root }).status === 0;

const readJsonFile = (path: string): any => {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  return text.trim() ? JSON.parse(text) : {};
};

/** Point this checkout's tools at the project endpoint (or, with `entry` null, back to the global one). Returns what changed. */
interface ToolDone {
  tool: "Claude Code" | "Codex" | "Cursor";
  file: string;
}

/** ~/.claude.json and the other Claude Code config folders' .claude.json. */
const claudeConfigs = (ctx: Context) => [join(ctx.home, ".claude.json"), ...extraClaudeDirs(ctx).map((d) => join(d, ".claude.json"))];
const tildeOf = (ctx: Context, p: string) => (p.startsWith(ctx.home) ? `~${p.slice(ctx.home.length)}` : p);

function writeToolConfigs(ctx: Context, root: string, entry: { url: string; token: string } | null): ToolDone[] {
  const done: ToolDone[] = [];
  const auth = entry ? { Authorization: `Bearer ${entry.token}` } : null;

  // Claude Code: a local-scope server for this folder, kept in ~/.claude.json (nothing in the repo),
  // and in each other Claude Code config folder (a second account's ~/.claude-b/.claude.json).
  for (const claudeJson of claudeConfigs(ctx)) {
    if (!existsSync(claudeJson)) continue;
    const obj = readJsonFile(claudeJson);
    const proj = (obj.projects ??= {})[root] ?? {};
    if (entry) {
      proj.mcpServers = { ...(proj.mcpServers ?? {}), [SERVER_NAME]: { type: "http", url: entry.url, headers: auth } };
      obj.projects[root] = proj;
    } else if (proj.mcpServers?.[SERVER_NAME]) delete proj.mcpServers[SERVER_NAME];
    writeAtomic(claudeJson, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
    done.push({ tool: "Claude Code", file: `${tildeOf(ctx, claudeJson)} (this folder)` });
  }

  // Codex: the checkout's .codex/config.toml, layered over ~/.codex/config.toml in trusted folders.
  if (existsSync(join(ctx.home, ".codex"))) {
    const rel = ".codex/config.toml";
    const file = join(root, rel);
    if (tracked(root, rel)) console.log(c.yellow(`  Codex: ${rel} is committed to git, so it's left alone (it would carry the token). Codex keeps using the global endpoint here.`));
    else {
      const current = existsSync(file) ? readFileSync(file, "utf8") : "";
      const next = entry ? editMcpTables(current, { [SERVER_NAME]: { url: entry.url, http_headers: auth } }, []) : editMcpTables(current, {}, [SERVER_NAME]);
      if (!next.trim()) rmSync(file, { force: true });
      else {
        mkdirSync(dirname(file), { recursive: true });
        writeAtomic(file, next, { mode: 0o600 });
        ignoreLocally(root, rel);
      }
      done.push({ tool: "Codex", file: rel });
      if (entry && !codexTrusts(ctx, root)) console.log(c.dim(`  Codex reads ${rel} once you trust this folder (it asks the first time you open it).`));
    }
  }

  // Cursor: the checkout's .cursor/mcp.json.
  if (existsSync(join(ctx.home, ".cursor"))) {
    const rel = ".cursor/mcp.json";
    const file = join(root, rel);
    if (tracked(root, rel)) console.log(c.yellow(`  Cursor: ${rel} is committed to git, so it's left alone (it would carry the token). Cursor keeps using the global endpoint here.`));
    else {
      const obj = readJsonFile(file);
      if (entry) obj.mcpServers = { ...(obj.mcpServers ?? {}), [SERVER_NAME]: { url: entry.url, headers: auth } };
      else if (obj.mcpServers) delete obj.mcpServers[SERVER_NAME];
      const empty = !Object.keys(obj.mcpServers ?? {}).length && Object.keys(obj).every((k) => k === "mcpServers");
      if (empty) rmSync(file, { force: true });
      else {
        mkdirSync(dirname(file), { recursive: true });
        writeAtomic(file, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
        ignoreLocally(root, rel);
      }
      done.push({ tool: "Cursor", file: rel });
    }
  }
  return done;
}

function codexTrusts(ctx: Context, root: string): boolean {
  try {
    const cfg = parseToml(readFileSync(join(ctx.home, ".codex", "config.toml"), "utf8")) as { projects?: Record<string, { trust_level?: string }> };
    return Object.entries(cfg.projects ?? {}).some(([path, p]) => (root === path || root.startsWith(`${path}/`)) && p.trust_level === "trusted");
  } catch {
    return false;
  }
}

export async function projectOf(client: CloudClient, repo: string): Promise<{ all: CloudProjects; project: CloudProjects["projects"][number] | null }> {
  const all = await client.projects();
  return { all, project: all.projects.find((p) => p.repo === repo) ?? null };
}

/** What an agent here sees, by connection name. */
export function visibleHere(all: CloudProjects, project: CloudProjects["projects"][number] | null): { own: string[]; global: string[] } {
  const own = project ? all.connections.filter((x) => x.projects.includes(project.id)).map((x) => x.display) : [];
  const global = all.connections.filter((x) => !x.projects.length && seenIn(x, project)).map((x) => x.display);
  return { own, global };
}

/** The connections agents here get, by service: `cloudflare` → `acme`, `personal`. Limited-to-this-project ones are marked. */
export function connectionTree(all: CloudProjects, project: CloudProjects["projects"][number] | null): Node[] {
  const seen = all.connections.filter((x) => seenIn(x, project));
  const hidden = project && !project.strict ? all.connections.filter((x) => x.hidden?.includes(project.id)).map((x) => x.display) : [];
  const by = new Map<string, { label: string | null; own: boolean }[]>();
  for (const x of seen) {
    const [service, label] = x.display.split(" › ");
    by.set(service!, [...(by.get(service!) ?? []), { label: label ?? null, own: Boolean(project && x.projects.includes(project.id)) }]);
  }
  const mark = (own: boolean) => (own ? ` ${c.cyan("only here")}` : "");
  const tree: Node[] = [...by]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([service, accounts]) => {
      const solo = accounts.length === 1 && !accounts[0]!.label;
      return solo
        ? { text: `${service}${mark(accounts[0]!.own)}` }
        : { text: service, children: accounts.sort((a, b) => (a.label ?? "").localeCompare(b.label ?? "")).map((a) => ({ text: `${a.label ?? c.dim("(no label)")}${mark(a.own)}` })) };
    });
  if (hidden.length) tree.push({ text: c.dim(`hidden here: ${hidden.sort().join(", ")}`), note: true });
  return tree;
}

/** Which of this machine's AI tools point this checkout at the project endpoint. */
export function toolStates(ctx: Context, root: string, projectId: string): { tool: string; file: string; on: boolean }[] {
  const mine = (url: unknown) => typeof url === "string" && url.includes(`/mcp/p/${projectId}`);
  const out: { tool: string; file: string; on: boolean }[] = [];
  for (const claudeJson of claudeConfigs(ctx))
    if (existsSync(claudeJson)) out.push({ tool: "Claude Code", file: `${tildeOf(ctx, claudeJson)} (this folder)`, on: mine(readJsonFile(claudeJson).projects?.[root]?.mcpServers?.[SERVER_NAME]?.url) });
  if (existsSync(join(ctx.home, ".codex"))) {
    const file = join(root, ".codex/config.toml");
    const cfg = existsSync(file) ? (parseToml(readFileSync(file, "utf8")) as { mcp_servers?: Record<string, { url?: string }> }) : {};
    out.push({ tool: "Codex", file: ".codex/config.toml", on: mine(cfg.mcp_servers?.[SERVER_NAME]?.url) });
  }
  if (existsSync(join(ctx.home, ".cursor"))) out.push({ tool: "Cursor", file: ".cursor/mcp.json", on: mine(readJsonFile(join(root, ".cursor/mcp.json")).mcpServers?.[SERVER_NAME]?.url) });
  return out;
}

function printTrees(agents: Node[], connections: Node[], strict: boolean) {
  console.log(`\n${c.bold("Agents")}`);
  for (const line of render(agents.length ? agents : [{ text: c.dim("no Claude Code, Codex or Cursor on this machine") }])) console.log(line);
  const count = connections.reduce((n, x) => n + (x.note ? 0 : (x.children?.length ?? 1)), 0);
  console.log(`\n${c.bold("Connections they see")} ${c.dim(`· ${count}${strict ? ", strict: only this project's" : ""}`)}`);
  for (const line of render(connections.length ? connections : [{ text: c.dim("none yet — 0b connect <service>") }])) console.log(line);
}

/** The token's place in committed files: each tool expands the variable when it starts. */
const TOKEN_VAR = "ZEROB_TOKEN";
/** A real token in a file means `0b project link` wrote it for this machine: never turn it into a committed one. */
const holdsToken = (path: string) => existsSync(path) && /\b0b_[A-Za-z0-9_-]{20,}/.test(readFileSync(path, "utf8"));
const ignored = (root: string, rel: string) => spawnSync("git", ["check-ignore", "-q", rel], { cwd: root }).status === 0;

interface CloudFile {
  file: string;
  what: string;
}

/**
 * `0b project cloud`'s files, for committing: the MCP server for the project's endpoint with the
 * token from ZEROB_TOKEN, and (unless `hooks` is off) the hook that uploads each cloud session.
 * Merged into what's there; running it again changes nothing. Returns what it wrote and what it left.
 */
export function writeCloudFiles(root: string, o: { server: string; url: string; hooks: boolean; codex?: boolean; cursor?: boolean }): { written: CloudFile[]; skipped: string[] } {
  const written: CloudFile[] = [];
  const skipped: string[] = [];

  // Claude Code: the project scope (.mcp.json). A checkout linked with `0b project link` keeps its
  // local-scope entry, which wins over this one on that machine.
  const mcpJson = join(root, ".mcp.json");
  const mcp = readJsonFile(mcpJson);
  mcp.mcpServers = { ...(mcp.mcpServers ?? {}), [SERVER_NAME]: { type: "http", url: o.url, headers: { Authorization: `Bearer \${${TOKEN_VAR}}` } } };
  writeAtomic(mcpJson, JSON.stringify(mcp, null, 2) + "\n");
  written.push({ file: ".mcp.json", what: `Claude Code: 0bridge at this project's endpoint, with the token from ${TOKEN_VAR}` });

  // The hook, run on Stop and SessionEnd (the upload; it waits for it) and, for the session board,
  // on UserPromptSubmit and Notification in the background (a prompt never waits on the network).
  // Our entries are replaced, anyone else's kept.
  const settingsFile = join(root, ".claude", "settings.json");
  const settings = readJsonFile(settingsFile);
  const ours = (group: any) => Array.isArray(group?.hooks) && group.hooks.some((h: any) => typeof h?.command === "string" && h.command.includes(CLOUD_HOOK_PATH));
  let changed = false;
  for (const [event, entry] of [
    ["Stop", { timeout: 30 }],
    ["SessionEnd", { timeout: 30 }],
    ["UserPromptSubmit", { timeout: 10, async: true }],
    ["Notification", { timeout: 10, async: true }],
  ] as const) {
    const list: any[] = Array.isArray(settings.hooks?.[event]) ? settings.hooks[event] : [];
    const kept = list.filter((g) => !ours(g));
    if (kept.length !== list.length || o.hooks) changed = true;
    const next = o.hooks ? [...kept, { hooks: [{ type: "command", command: CLOUD_HOOK_COMMAND, ...entry }] }] : kept;
    if (next.length) (settings.hooks ??= {})[event] = next;
    else if (settings.hooks) delete settings.hooks[event];
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
  const script = join(root, CLOUD_HOOK_PATH);
  if (o.hooks) {
    writeAtomic(script, cloudHookScript(o.server), { mode: 0o755 });
    written.push({ file: CLOUD_HOOK_PATH, what: "shows each cloud session on your session board and uploads it to your history (only in the cloud, with the token set)" });
  } else if (existsSync(script)) {
    rmSync(script);
    written.push({ file: CLOUD_HOOK_PATH, what: "removed" });
  }
  if (changed) {
    if (Object.keys(settings).length || existsSync(settingsFile)) writeAtomic(settingsFile, JSON.stringify(settings, null, 2) + "\n");
    written.push({ file: ".claude/settings.json", what: o.hooks ? "runs it as a prompt is sent, a session waits for you, and a turn or session ends" : "the upload hook removed" });
  }

  // Codex and Cursor read these from a clone too (field names to verify on each before relying on them).
  if (o.codex) {
    const rel = ".codex/config.toml";
    const file = join(root, rel);
    if (holdsToken(file)) skipped.push(`${rel} holds this machine's project token (0b project link), so it's left alone; 0b project unlink first to commit one for the cloud`);
    else {
      writeAtomic(file, editMcpTables(existsSync(file) ? readFileSync(file, "utf8") : "", { [SERVER_NAME]: { url: o.url, bearer_token_env_var: TOKEN_VAR } }, []));
      written.push({ file: rel, what: `Codex: the same, with bearer_token_env_var = "${TOKEN_VAR}"` });
    }
  }
  if (o.cursor) {
    const rel = ".cursor/mcp.json";
    const file = join(root, rel);
    if (holdsToken(file)) skipped.push(`${rel} holds this machine's project token (0b project link), so it's left alone; 0b project unlink first to commit one for the cloud`);
    else {
      const obj = readJsonFile(file);
      obj.mcpServers = { ...(obj.mcpServers ?? {}), [SERVER_NAME]: { url: o.url, headers: { Authorization: `Bearer \${env:${TOKEN_VAR}}` } } };
      writeAtomic(file, JSON.stringify(obj, null, 2) + "\n");
      written.push({ file: rel, what: `Cursor: the same, with the token from \${env:${TOKEN_VAR}}` });
    }
  }
  for (const w of written) if (ignored(root, w.file)) skipped.push(`${w.file} is ignored by git here: add it with git add -f`);
  return { written, skipped };
}

export interface ProjectOptions {
  strict?: boolean;
  label?: string;
  /** `0b project cloud`: also write Codex's and Cursor's project config, skip the Claude hook, a read-only token. */
  codex?: boolean;
  cursor?: boolean;
  noHooks?: boolean;
  readOnly?: boolean;
}

/**
 * Strict holds in Claude Code (the local scope replaces the user-scope 0bridge) and Codex (the
 * project table is layered over the global one). Cursor doesn't replace: a server in both
 * ~/.cursor/mcp.json and .cursor/mcp.json is loaded twice (Cursor staff, forum.cursor.com/t/151971,
 * 2026-02), so its agents still reach the global endpoint, and with it the global connections.
 */
function cursorStrictNote(done: { tool: string }[]) {
  if (!done.some((d) => d.tool === "Cursor")) return;
  console.log(c.yellow(`● Cursor loads its global 0bridge next to this project's (it doesn't let one replace the other), so agents there can still use connections outside this project.`));
  console.log(c.dim(`  For strict in Cursor, turn the global 0bridge off in Cursor Settings → MCP while you work here.`));
}

/** The checkout gets its repo's project scope from now on (`0b apply` writes into it). */
function registerCheckout(ctx: Context, h: { root: string; repo: string }) {
  const st = loadState(ctx);
  (st.projects ??= {})[h.root] ??= { repo: h.repo, managed: {} };
  st.projects[h.root]!.repo = h.repo;
  saveState(ctx, st);
}

/**
 * The project scope's local commands (no account needed): `import` brings what this checkout's
 * tools have in their project files under 0bridge, `instructions on|off` whether every tool here is
 * made to read the repo's AGENTS.md or CLAUDE.md. True when `sub` was one of them.
 */
function localCommand(ctx: Context, sub: string | undefined, rest: string[]): boolean {
  if (sub === "import") {
    const h = here();
    const m = requireManifest(ctx);
    const st = loadState(ctx);
    const r = importProject(ctx, m, st, withVault(ctx, openSecretStore(ctx.storeDir)), h);
    saveManifest(ctx, m);
    saveState(ctx, st);
    for (const s of r.servers) console.log(`  ${c.green("+")} mcp ${s.name} ${c.dim(`from ${s.from}`)}`);
    for (const s of r.skills) console.log(`  ${c.green("+")} skill ${s.name} ${c.dim(`from ${s.from}`)}`);
    if (r.secrets.length) console.log(`  ${c.cyan("🔒")} moved ${r.secrets.length} secret(s) out of the config: ${c.dim(r.secrets.join(", "))}`);
    for (const x of r.conflicts) console.log(`  ${c.yellow("!")} ${x.kind} ${x.name}: ${x.tool}'s differs from the one ${h.repo} already has; left as is`);
    if (!r.servers.length && !r.skills.length && !r.conflicts.length) console.log(c.dim("  nothing new"));
    console.log(`\n${c.bold(h.repo)}: ${c.cyan("0b apply")} writes these into every tool in this checkout (and the repo's other registered clones).`);
    return true;
  }
  if (sub === "instructions") {
    const on = rest[0] === "on" ? true : rest[0] === "off" ? false : fail("usage: 0b project instructions on|off");
    const h = here();
    const m = requireManifest(ctx);
    const scope = projectScope(m, h.repo, true);
    if (on) delete scope.instructions;
    else scope.instructions = false;
    saveManifest(ctx, m);
    registerCheckout(ctx, h);
    console.log(
      on
        ? `${c.green("✓")} ${h.repo}: ${c.cyan("0b apply")} makes every tool read its instructions (Claude Code imports AGENTS.md, or AGENTS.md gets a copy of CLAUDE.md for Codex and Cursor)`
        : `${c.green("✓")} ${h.repo}: its instruction files are left to you; ${c.cyan("0b apply")} takes out the blocks 0bridge added`,
    );
    return true;
  }
  return false;
}

export async function projectCommand(ctx: Context, args: string[], opts: ProjectOptions): Promise<void> {
  const [sub, ...rest] = args;
  if (localCommand(ctx, sub, rest)) return;
  const { cfg, client } = cloudClient(ctx);
  switch (sub) {
    case undefined:
    case "status": {
      const h = here();
      const { all, project } = await projectOf(client, h.repo);
      if (!project) {
        console.log(`${c.bold(h.repo)} isn't a project yet. ${c.cyan("0b project link")} makes it one and points this checkout's AI tools at it.`);
        return;
      }
      const link = loadLinks(ctx).links[h.root];
      console.log(`${c.bold(project.repo)}${project.strict ? c.dim(" (strict)") : ""} ${c.dim(`· ${project.secrets} secrets`)}`);
      const tools = toolStates(ctx, h.root, project.id);
      printTrees(
        tools.map((t) => ({ text: `${t.on ? c.green("✓") : c.yellow("●")} ${t.tool.padEnd(12)} ${t.on ? c.dim(t.file) : c.yellow("global endpoint")}` })),
        connectionTree(all, project),
        project.strict,
      );
      if (link?.projectId !== project.id || tools.some((t) => !t.on)) console.log(`\n${c.yellow("●")} Some tools here use the global endpoint: run ${c.cyan("0b project link")}`);
      return;
    }
    case "list":
    case "ls": {
      const all = await client.projects(true);
      if (!all.projects.length) console.log(`No projects yet. In a repo: ${c.cyan("0b project link")}`);
      const links = Object.entries(loadLinks(ctx).links);
      for (const p of all.projects) {
        const conns = all.connections.filter((x) => x.projects.includes(p.id)).map((x) => x.display);
        const paths = links.filter(([, l]) => l.projectId === p.id).map(([path]) => path.replace(`${ctx.home}/`, "~/"));
        console.log(`${c.bold(p.repo)}${p.strict ? c.dim(" strict") : ""}  ${c.dim(`${p.secrets} secrets`)}${conns.length ? `  ${conns.join(", ")}` : ""}${paths.length ? c.dim(`  linked: ${paths.join(", ")}`) : ""}`);
      }
      if (all.suggestions.length) console.log(c.dim(`\nNot projects yet: ${all.suggestions.slice(0, 8).join(", ")}`));
      return;
    }
    case "link":
    case "add": {
      const h = here();
      const project = await client.createProject(h.repo, opts.strict);
      if (opts.strict && !project.strict) await client.updateProject(project.id, true);
      const store = openSecretStore(ctx.storeDir);
      const links = loadLinks(ctx);
      // One token per project on this machine, shared by its checkouts.
      const known = Object.values(links.links).find((l) => l.projectId === project.id);
      let token = known ? store.get(tokenKey(project.id)) : null;
      let tokenId = known?.tokenId ?? "";
      const url = `${cfg.server.replace(/\/+$/, "")}/mcp/p/${project.id}`;
      if (!token) {
        const t = await client.projectToken(project.id, hostname());
        token = t.token;
        tokenId = t.id;
        store.set(tokenKey(project.id), token);
      }
      const done = writeToolConfigs(ctx, h.root, { url, token });
      // Relinked to another project (say, another account's): the old one's token goes with it
      // once no other checkout uses it, revoked by the account that made it.
      const old = links.links[h.root];
      links.links[h.root] = { projectId: project.id, repo: project.repo, tokenId, userId: cfg.userId };
      if (old && old.projectId !== project.id && !Object.values(links.links).some((l) => l.projectId === old.projectId)) {
        const owner = findAccount(loadAccounts(ctx), linkAccount(ctx, old) ?? "");
        const ownerToken = owner && store.get(deviceTokenKey(owner));
        if (owner && ownerToken) await new CloudClient(owner.server, ownerToken).deleteToken(old.tokenId).catch(() => {});
        store.delete(tokenKey(old.projectId));
      }
      saveLinks(ctx, links);
      registerCheckout(ctx, h);
      console.log(`${c.green("✓")} ${c.bold(project.repo)} is a project${project.strict || opts.strict ? " (strict)" : ""}. AI tools in this checkout now use its endpoint.`);
      if (loadAccounts(ctx).accounts.length > 1) console.log(c.dim(`  It belongs to ${accountName(cfg)}: 0b commands in this checkout use that account.`));
      const { all, project: p } = await projectOf(client, h.repo);
      const { own } = visibleHere(all, p);
      printTrees(
        done.map((d) => ({ text: `${d.tool.padEnd(12)} ${c.dim(d.file)}` })),
        connectionTree(all, p),
        Boolean(p?.strict),
      );
      console.log();
      if (p?.strict) cursorStrictNote(done);
      if (!own.length) console.log(c.dim(`Limit a connection to this project: 0b project use <service> [--label <account>]`));
      const m = loadManifest(ctx);
      const scope = m && projectScope(m, h.repo);
      if (scope && (Object.keys(scope.mcpServers).length || Object.keys(scope.skills).length)) console.log(`${c.cyan("0b apply")} writes ${h.repo}'s own MCP servers and skills into this checkout.`);
      console.log(c.dim("Start a new session in each tool (or reconnect MCP) to pick it up."));
      return;
    }
    case "cloud": {
      const h = here();
      // The project the cloud agents' token opens: this repo's, made now if it isn't one yet.
      const project = await client.createProject(h.repo);
      const server = cfg.server.replace(/\/+$/, "");
      const hooks = !opts.noHooks;
      let files: ReturnType<typeof writeCloudFiles>;
      try {
        // The files first (they don't hold the token), so a broken one stops before a token is made.
        files = writeCloudFiles(h.root, { server, url: `${server}/mcp/p/${project.id}`, hooks, codex: opts.codex, cursor: opts.cursor });
      } catch (e) {
        fail(`couldn't update this checkout's files: ${e instanceof Error ? e.message : String(e)}`);
      }
      const scope = { tools: opts.readOnly ? "read" : "all", history: "read", agent: false, connections: null, api: hooks ? ["history:ingest"] : [] };
      const t = await client.call<{ id: string; token: string; expiresAt: number | null }>("POST", `/projects/${encodeURIComponent(project.id)}/token`, { label: "cloud agents", scope, expiresInDays: 90 });
      const host = new URL(server).host;
      console.log(`${c.green("✓")} ${c.bold(project.repo)}: cloud agents working on a clone reach 0bridge at the project's endpoint.`);
      const width = Math.max(...files.written.map((w) => w.file.length));
      for (const w of files.written) console.log(`  ${w.file.padEnd(width)}  ${c.dim(w.what)}`);
      for (const s of files.skipped) console.log(c.yellow(`  ${s}`));
      const expires = t.expiresAt ? new Date(t.expiresAt).toISOString().slice(0, 10) : "never";
      console.log(`\n${c.bold("Token for cloud agents")} ${c.dim(`(shown once; ${opts.readOnly ? "read-only tools" : "all tools"}, history: read${hooks ? " and upload of its own sessions" : ""}, no agent control; expires ${expires})`)}`);
      console.log(`  ${t.token}`);
      console.log(`\n${c.bold("Next")}`);
      console.log(`  1. Add ${TOKEN_VAR}=<the token> to the cloud environment's variables (Claude Code on the web: the environment's settings; on Pro or Max you can add it as an API credential for ${host} instead).`);
      console.log(`  2. Allow ${host} in the environment's network access (it isn't on the default trusted list).`);
      console.log(`  3. Commit the files: git add -A ${files.written.map((w) => (w.file.startsWith(".0bridge/") ? ".0bridge" : w.file)).join(" ")} && git commit -m "0bridge for cloud agents"`);
      console.log(c.dim(`\nAnyone who can see that environment can read the token. It opens this project's endpoint only, ends ${expires}, and you can revoke it on the dashboard (Devices).`));
      if (loadLinks(ctx).links[h.root]?.projectId !== project.id)
        console.log(c.dim(`Claude Code on this machine: the committed .mcp.json asks for ${TOKEN_VAR}. ${c.cyan("0b project link")} gives this checkout its own token, which takes precedence.`));
      return;
    }
    case "unlink": {
      const h = here();
      const links = loadLinks(ctx);
      const link = links.links[h.root];
      writeToolConfigs(ctx, h.root, null);
      delete links.links[h.root];
      saveLinks(ctx, links);
      if (link && !Object.values(links.links).some((l) => l.projectId === link.projectId)) {
        await client.deleteToken(link.tokenId).catch(() => {});
        openSecretStore(ctx.storeDir).delete(tokenKey(link.projectId));
      }
      console.log(`${c.green("✓")} AI tools in this checkout use the global endpoint again. The project and its settings stay (${c.cyan("0b project rm")} deletes it).`);
      return;
    }
    case "strict": {
      const on = rest[0] === "on" ? true : rest[0] === "off" ? false : fail("usage: 0b project strict on|off");
      const h = here();
      const { project } = await projectOf(client, h.repo);
      if (!project) fail(`${h.repo} isn't a project yet: 0b project link`);
      await client.updateProject(project.id, on);
      console.log(on ? `${c.green("✓")} strict: agents in ${project.repo} see only the connections limited to it` : `${c.green("✓")} agents in ${project.repo} see its connections and the global ones`);
      if (on) cursorStrictNote(toolStates(ctx, h.root, project.id).filter((t) => t.on));
      return;
    }
    case "hide":
    case "show": {
      if (!rest[0]) fail(`usage: 0b project ${sub} <service> [--label <account>]   (e.g. 0b project ${sub} slack --label acme)`);
      const h = here();
      const { project } = await projectOf(client, h.repo);
      if (!project) fail(`${h.repo} isn't a project yet: 0b project link`);
      const conn = await findConnection(ctx, rest[0], opts.label);
      if (conn.projects?.length) fail(`${conn.display} is limited to projects, not available everywhere, so there's nothing to hide: 0b project ${sub === "hide" ? "unuse" : "use"} ${rest[0]}${opts.label ? ` --label ${opts.label}` : ""}`);
      const current = conn.hidden ?? [];
      const next = sub === "hide" ? [...new Set([...current, project.id])] : current.filter((x) => x !== project.id);
      const r = await client.setConnectionProjects(conn.id, [], next);
      console.log(
        sub === "hide"
          ? `${c.green("✓")} agents in ${c.bold(project.repo)} don't see ${r.display} anymore; everywhere else still does.`
          : `${c.green("✓")} agents in ${c.bold(project.repo)} see ${r.display} again.`,
      );
      return;
    }
    case "use":
    case "unuse": {
      if (!rest[0]) fail(`usage: 0b project ${sub} <service> [--label <account>]   (e.g. 0b project ${sub} slack --label acme)`);
      const h = here();
      const { project } = await projectOf(client, h.repo);
      if (!project) fail(`${h.repo} isn't a project yet: 0b project link`);
      const conn = await findConnection(ctx, rest[0], opts.label);
      const current = conn.projects ?? [];
      const next = sub === "use" ? [...new Set([...current, project.id])] : current.filter((x) => x !== project.id);
      const r = await client.setConnectionProjects(conn.id, next);
      if (sub === "use")
        console.log(
          `${c.green("✓")} ${r.display} is limited to ${current.length ? "its projects, now including " : ""}${c.bold(project.repo)}: agents elsewhere (and apps like Claude) don't see it anymore.`,
        );
      else console.log(next.length ? `${c.green("✓")} ${r.display} isn't used in ${project.repo} anymore` : `${c.yellow("●")} ${r.display} is available everywhere again (it was limited to ${project.repo} only)`);
      return;
    }
    case "rm":
    case "remove": {
      const h = here();
      const { project } = await projectOf(client, h.repo);
      if (!project) fail(`${h.repo} isn't a project`);
      const r = await client.deleteProject(project.id);
      const links = loadLinks(ctx);
      for (const [path, l] of Object.entries(links.links)) if (l.projectId === project.id) (writeToolConfigs(ctx, path, null), delete links.links[path]);
      saveLinks(ctx, links);
      openSecretStore(ctx.storeDir).delete(tokenKey(project.id));
      console.log(`${c.green("✓")} ${project.repo} isn't a project anymore; its secrets stay (they belong to the repo).`);
      if (r.orphaned.length) console.log(c.yellow(`  ${r.orphaned.join(", ")} ${r.orphaned.length === 1 ? "was" : "were"} limited to it alone, so ${r.orphaned.length === 1 ? "it's" : "they're"} not available anywhere now. 0b project use … in another project, or remove the limit on the dashboard.`));
      return;
    }
    default:
      fail(`unknown subcommand "project ${sub}". Try: link, status, list, use, unuse, hide, show, strict, cloud, import, instructions, unlink, rm`);
  }
}

/**
 * Signing an account out: its linked checkouts go back to the global endpoint (the default
 * account's) and their project tokens are revoked while its device token still works. Returns the
 * checkouts.
 */
export async function unlinkAccount(ctx: Context, userId: string, client: CloudClient | null): Promise<string[]> {
  const links = loadLinks(ctx);
  const gone = Object.entries(links.links).filter(([, l]) => linkAccount(ctx, l) === userId);
  const store = openSecretStore(ctx.storeDir);
  for (const [path, l] of gone) {
    if (existsSync(path)) writeToolConfigs(ctx, path, null);
    delete links.links[path];
    if (!Object.values(links.links).some((x) => x.projectId === l.projectId)) {
      await client?.deleteToken(l.tokenId).catch(() => {});
      store.delete(tokenKey(l.projectId));
    }
  }
  if (gone.length) saveLinks(ctx, links);
  return gone.map(([path]) => path);
}
