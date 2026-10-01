import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { existsSync, mkdirSync } from "node:fs";
import {
  TOOL_IDS,
  defaultContext,
  emptyManifest,
  executePlan,
  getAdapters,
  importFromTools,
  isInstalled,
  listBackups,
  loadManifest,
  loadState,
  openSecretStore,
  withVault,
  accountName,
  defaultAccount,
  findAccount,
  loadAccounts,
  loadCloud,
  paths,
  planApply,
  requireManifest,
  restoreBackup,
  saveManifest,
  saveState,
  secretValues,
  type ImportReport,
  type Manifest,
  type McpServer,
  type ToolId,
} from "@0bridge/core";
import { c, printPlan, printStatus, printWarnings, where } from "./ui.ts";
import { homeTui, initTui, syncFlow } from "./tui.ts";
import { cloudClient, cloudStatus, connectCommand, findConnection, keyCommand, login, logout, migrateTui, renameConnection } from "./cloud.ts";
import { accountCommand } from "./account.ts";
import { accountAt } from "./links.ts";
import { printTree } from "./tree.ts";
import { doctorCommand } from "./doctor.ts";
import { setup } from "./setup.ts";
import { execCommand, profileCommand } from "./profile.ts";
import { historyCommand } from "./history.ts";
import { filesCommand } from "./files.ts";
import { installBackground, runBackground } from "./background.ts";
import { secretCommand, vaultCommand } from "./vault.ts";
import { projectCommand } from "./project.ts";
import { clipCommand } from "./clip.ts";
import { updateCommand } from "./update.ts";

declare const VERSION: string;
const version = typeof VERSION !== "undefined" ? VERSION : "dev";

const HELP = `${c.bold("0b")} — one bridge for all your AI agent tooling ${c.dim(`v${version}`)}

${c.bold("Usage")}
  0b setup                     Start here: sign in, add 0bridge to every AI tool on this machine,
        [--yes] [--only t,...]  connect services. --yes never prompts (for agents and scripts)
        [--connect a,b] [--web]
  0b                           Interactive: pick, review, and sync (first run starts setup)
  0b init [--yes]              Set up ~/.0bridge from your tools (--yes: import everything, no prompts)
  0b import [--only t,...]     Merge tool configs into the manifest (writes only to ~/.0bridge)
  0b tree                      Everything at a glance: cloud connections, MCP servers, skills (alias: ls)
  0b status                    Is this machine and this repo set up? A checklist with the command that fixes
                               each item ([agent]: safe for an agent to run; [you]: needs you). Alias: doctor
  0b status tools              What's in sync across tools (MCP servers, skills, instructions)
  0b apply [--only t,...]      Write the manifest into each tool (shows a diff, asks first)
        [--yes] [--dry-run]
  0b mcp list
  0b mcp add <name> --url <url> [--header K=V]... [--only t,...]
  0b mcp add <name> [--env K=V]... [--only t,...] -- <command> [args...]
  0b mcp enable|disable|remove <name>
  0b skill list | enable|disable|remove <name>
  0b secret set <NAME>         Store a secret in your vault, encrypted on this machine (asks for the value,
        [--env dev|prod]        or reads stdin). For this repo; --global for every repo and \${secret:<NAME>}
        [--global]
  0b secret import [.env]      Move a .env file into the vault (--delete removes the file after).
        [--dry-run] [--only A,B]  --dry-run lists names first (replaces? points at localhost?), stores
                                nothing; --only moves just those names and keeps the file
  0b secret paste              Paste KEY=value lines instead. Each is guessed as a secret (hidden,
                                masked in agents' output) or a variable (PORT, NEXT_PUBLIC_*);
                                --secret / --variable decide for all
  0b secret set <NAME> --file key.pem   A value of several lines (a private key, a JSON service account)
  0b secret set <NAME> --variable [value]   A plain setting; its value may go on the command line
  0b secret list | rm <NAME>   Names only
  0b secret show <NAME>        Show one value to you (secrets go to your terminal only, not to agents)
  0b secret mark <NAME> --secret|--variable
  0b secret off|on <NAME>      Switch a value off (kept, but commands don't get it) or back on
  0b secret note <NAME> "…"    What it is ("acme org token"); shown in list. No text clears it
  0b project link [--strict]   Make this repo a project: its AI tools reach 0bridge at the project's own
                                endpoint and see the connections limited to it (plus the global ones,
                                unless --strict). Also: status, list, unlink, rm, strict on|off
  0b project use <service> [--label a]   Limit a connection to this project (unuse undoes it)
  0b project hide <service> [--label a]  Keep a connection out of this project only (show undoes it),
                                e.g. another company's Slack in this repo
  0b exec [--env prod] -- <cmd>  Run a command with this repo's secrets and CLI profile as env vars
                               (and ZEROBRIDGE_ENV=dev|prod, so a script can tell it runs under 0b)
  0b vault [status]            Whether this machine can open your vault
  0b vault unlock              New machine: approve it in the browser (passkey) or with \`0b vault approve\`
        [--recovery-key]        on another machine; --recovery-key types the key instead
  0b vault approve             Hand the vault key to a machine that's asking (compare the codes)
  0b history on                Upload this machine's conversations (Claude Code and app, Codex CLI and
                                app, Grok, Cursor; secrets masked first) so every AI tool can search
                                them; syncs every 30 minutes. --tool picks sources
  0b history search <words>    [--repo r] [--tool t] [--days n]; 0b history show <session-id>
  0b history mode server|e2e   server (default): your AI tools can search it. e2e: sealed with your
                                vault key, only 0b on your machines can search it
  0b history exclude <repo> | forget <id>|--all | off | status
  0b files add <file>…         Sync personal files kept out of git (AGENTS.local.md, CLAUDE.local.md symlink,
                                .claude/settings.local.json) to every clone of this repo, sealed with your vault
                                key; every change is a version. Also: status, pull, push [--force], rm, log, restore
  0b files statusline          Sync Claude Code's status line (the statusLine setting and its script) to
                                your other machines. Files under ~ outside a repo work too: 0b files add ~/…
  0b clip [file…]              Send what's on your clipboard (a screenshot, copied files or text), or files,
                                to your agents: over SSH or anywhere, they read it once with bridge__clipboard
                                within 10 minutes. Also: clip status, clip clear
  0b clip listen on|off        Let agents ask this Mac for its clipboard: a dialog asks you each time
  0b clip sync on|off          On a Mac: images you copy (screenshots, copied images) go to your agents as you copy them
  0b clip paste [dir]          Save what's waiting here (over SSH too) and print the paths
  0b clip shims [off]          On a Linux server: ⌃V in Claude Code pastes the image you last copied on your Mac,
                                received as you copy it (clip sync on|off does the same there)
  0b background [on|off]       Run (or schedule every 30 min) the history and personal file sync
  0b tool enable|disable <tool>
  0b update [--check]          Install the newest 0b (and restart its background jobs); --check only looks
  0b login [--web]             Sign in with a one-time code (works over SSH too); --web uses a browser redirect
                               instead. Every tool then gets one MCP endpoint
  0b logout [email] [--all]    Revoke this device and sign out (with several accounts, say which)
  0b account                   Accounts signed in here: the default (every AI tool's 0bridge entry) and
                               this repo's. 0b login adds another (a company's and your own at once)
  0b account use <email>       Make it the default
  --account <email>            Run any command as that account. Inside a checkout linked with
                               0b project link, commands use its project's account on their own
  0b connect <name or address> Connect any service in the cloud. 0bridge finds it: its own MCP server
                               (the official registry, the usual addresses), else its OpenAPI document
                               (tools: search, describe, call; call_write once you allow writes)
                               In your terminal it lists every way in to pick from: MCP, API (you type
                               the key), or the CLI (wrangler, gh); --yes takes 0bridge's pick
  0b connect <service> [url]   An MCP server by its URL
        [--label name]         Account label (e.g. your org): tools become <service>__<label>__*.
                               Asked interactively; optional for a service's first account
        [--client-id id --client-secret s]
                               An OAuth app you registered, for services that need one (Slack:
                               without these, 0b opens a prefilled "create app" page and asks)
        [--app own|0bridge]    Slack: your own app in the workspace (works now), or 0bridge's app
                               (one click; works once it's in the Slack Marketplace). Asked if not given
  0b connect <service> --api <base url> [--auth bearer|basic|header:<Name>|query:<param>]
                               Any HTTP API with a key (asked for, never on the command line). 0bridge
                               keeps the key and agents call the API through it (<service>__get, <service>__request)
  0b connect <service> --spec <OpenAPI URL> [--allow-write]
                               An API from its OpenAPI/Swagger document: auth and operations are read from it
        [--yes]                Don't ask anything: register it and print what's missing (for agents)
  0b key <service>             Type an API's key(s) into 0bridge (hidden; never through an agent or chat)
  0b connect google-calendar   Google Calendar through its API (sign in with Google)
  0b rename <service> [--label <current>] <new label>
                               Change an account's label (- clears it). Sign-in is kept
  0b disconnect <service> [--label <name>]
                               Remove a cloud connection (--label picks the account when there are several)
  0b cloud                     Show cloud account and connections
  0b cloud migrate             Move locally configured remote servers to the cloud
  0b profile                   CLI accounts per repo: list profiles and who each CLI is signed in as
  0b profile add <name> <cli>… Sign CLIs (wrangler, gh) into a separate profile with their own login
  0b profile use <name>        This repo uses that profile (Claude Code picks it up; restart sessions)
  0b profile unuse | remove <name> | shims
  0b backups                   List apply backups
  0b restore <id>              Undo an apply

${c.bold("Tools")}  ${TOOL_IDS.join(", ")}
${c.bold("Store")}  ${paths(defaultContext()).manifest}
`;

function die(msg: string): never {
  console.error(c.red(`error: ${msg}`));
  process.exit(1);
}

function parseTools(v: string | undefined): ToolId[] | undefined {
  if (!v) return undefined;
  const list = v.split(",").map((s) => s.trim()) as ToolId[];
  for (const t of list) if (!TOOL_IDS.includes(t)) die(`unknown tool "${t}" (expected ${TOOL_IDS.join(", ")})`);
  return list;
}

function kv(list: string[] | undefined, flag: string): Record<string, string> | undefined {
  if (!list?.length) return undefined;
  return Object.fromEntries(
    list.map((s) => {
      const i = s.indexOf("=");
      if (i <= 0) die(`${flag} expects KEY=VALUE, got "${s}"`);
      return [s.slice(0, i), s.slice(i + 1)];
    }),
  );
}

async function confirm(q: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(`${q} ${c.dim("[y/N]")} `);
  rl.close();
  return /^y(es)?$/i.test(a.trim());
}

const ctx = defaultContext();

/**
 * Commands about this machine as a whole: they use the default account unless --account says
 * otherwise. Everything else, run inside a checkout linked to a project, uses the account that
 * project belongs to, so nobody picks accounts by hand.
 */
const MACHINE_WIDE = new Set(["setup", "init", "import", "apply", "mcp", "skill", "skills", "tool", "login", "logout", "account", "accounts", "background", "backups", "restore", "profile", "profiles", "history"]);

/** Take `--account <email>` out of argv, anywhere before `--` (the command `0b exec` runs keeps its own flags). */
function takeAccountFlag(argv: string[]): string | undefined {
  const end = argv.includes("--") ? argv.indexOf("--") : argv.length;
  for (let i = 2; i < end; i++) {
    if (argv[i] === "--account") {
      const v = argv[i + 1];
      if (!v || v.startsWith("-")) die("--account needs an email: --account you@company.com");
      argv.splice(i, 2);
      return v;
    }
    if (argv[i]!.startsWith("--account=")) return argv.splice(i, 1)[0]!.slice("--account=".length);
  }
  return undefined;
}

const explicitAccount = takeAccountFlag(process.argv) ?? (process.env.ZEROBRIDGE_ACCOUNT || undefined);
if (explicitAccount && process.argv[2] !== "login") {
  if (!findAccount(loadAccounts(ctx), explicitAccount)) die(`${explicitAccount} isn't signed in on this machine: 0b login adds it, 0b account lists who is`);
  ctx.account = explicitAccount;
} else if (process.argv[2] && !MACHINE_WIDE.has(process.argv[2])) {
  const here = accountAt(ctx, process.cwd());
  const main = defaultAccount(loadAccounts(ctx));
  if (here && main && here !== main.userId) {
    ctx.account = here;
    if (process.argv[2] !== "exec" && process.stderr.isTTY) console.error(c.dim(`(0bridge account ${accountName(loadCloud(ctx)!)}: this checkout's project)`));
  }
}

const store = () => withVault(ctx, openSecretStore(ctx.storeDir));
const interactive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

function printImport(r: ImportReport) {
  for (const s of r.servers) {
    const tags = [s.pinned && c.dim(`only ${s.from}`), s.disabled && c.dim("disabled")].filter(Boolean).join(" ");
    console.log(`  ${c.green("+")} mcp ${s.name} ${c.dim(`from ${s.from}`)} ${tags}`.trimEnd());
  }
  for (const s of r.skills) console.log(`  ${c.green("+")} skill ${s.name} ${c.dim(`from ${s.from}`)}`);
  if (r.instructionsFrom) console.log(`  ${c.green("+")} instructions ${c.dim(`from ${r.instructionsFrom}`)}`);
  if (r.secrets.length) console.log(`  ${c.cyan("🔒")} moved ${r.secrets.length} secret(s) to ${store().kind}: ${c.dim(r.secrets.join(", "))}`);
  for (const x of r.conflicts) {
    console.log(`  ${c.yellow("!")} ${x.kind} ${x.name}: ${x.other}'s version differs from ${x.kept}'s — kept ${x.kept}, ${x.other} left untouched`);
  }
  if (!r.servers.length && !r.skills.length && !r.instructionsFrom && !r.conflicts.length) console.log(c.dim("  nothing new"));
}

function runImport(m: Manifest, only?: ToolId[]) {
  const state = loadState(ctx);
  const report = importFromTools(ctx, m, state, store(), { only });
  saveManifest(ctx, m);
  saveState(ctx, state);
  printImport(report);
}

async function apply(values: { only?: string; yes?: boolean; "dry-run"?: boolean; "no-diff"?: boolean }) {
  const m = requireManifest(ctx);
  const s = store();
  const plan = planApply(ctx, m, loadState(ctx), s, parseTools(values.only));
  if (!plan.changes.length) {
    printWarnings(ctx, plan);
    console.log(c.green("Everything is in sync."));
    return;
  }
  printPlan(ctx, plan, secretValues(m, s), !values["no-diff"]);
  if (values["dry-run"]) return console.log(c.dim("\n(dry run — nothing written)"));
  if (plan.missing.length) die("fix unresolved refs before applying");
  if (!values.yes && !(await confirm(`\nApply ${plan.changes.length} change(s)?`))) {
    return console.log(c.dim(process.stdin.isTTY ? "Cancelled." : "Not a TTY — re-run with --yes to write."));
  }
  const id = executePlan(ctx, plan);
  console.log(`${c.green("Applied.")} Backup ${c.dim(id)} — undo with ${c.cyan(`0b restore ${id}`)}`);
  console.log(c.dim("Restart running agent sessions to pick up changes."));
}

function mcp(args: string[], values: Record<string, any>) {
  const [sub, name] = args;
  const m = requireManifest(ctx);
  const get = () => m.mcpServers[name!] ?? die(`no MCP server "${name}"`);
  switch (sub) {
    case undefined:
    case "list":
      for (const [n, s] of Object.entries(m.mcpServers).sort(([a], [b]) => a.localeCompare(b))) {
        const tags = [s.enabled === false && "disabled", s.targets && `only ${s.targets.join(",")}`].filter(Boolean).join(" ");
        console.log(`  ${n.padEnd(22)} ${c.dim(s.transport.padEnd(6))} ${where(s, 80)} ${c.yellow(tags)}`);
      }
      return;
    case "add": {
      if (!name) die("usage: 0b mcp add <name> ...");
      const cmd = args.slice(2);
      const entry: McpServer = values.url
        ? { transport: /\/sse\/?$/.test(values.url) ? "sse" : "http", url: values.url, headers: kv(values.header, "--header") }
        : cmd.length
          ? { transport: "stdio", command: cmd[0], args: cmd.slice(1), env: kv(values.env, "--env") }
          : die("give --url <url> or -- <command> [args...]");
      if (values.only) entry.targets = parseTools(values.only);
      m.mcpServers[name] = JSON.parse(JSON.stringify(entry));
      break;
    }
    case "remove":
      get();
      delete m.mcpServers[name!];
      break;
    case "enable":
      delete get().enabled;
      break;
    case "disable":
      get().enabled = false;
      break;
    default:
      die(`unknown subcommand "mcp ${sub}"`);
  }
  saveManifest(ctx, m);
  console.log(`${c.green("✓")} mcp ${sub} ${name}. Run ${c.cyan("0b apply")} to sync.`);
}

function skill(args: string[]) {
  const [sub, name] = args;
  const m = requireManifest(ctx);
  const get = () => m.skills[name!] ?? die(`no skill "${name}"`);
  switch (sub) {
    case undefined:
    case "list":
      for (const [n, s] of Object.entries(m.skills).sort(([a], [b]) => a.localeCompare(b))) {
        console.log(`  ${n.padEnd(28)} ${c.yellow([s.enabled === false && "disabled", s.targets && `only ${s.targets.join(",")}`].filter(Boolean).join(" "))}`);
      }
      return;
    case "remove":
      get();
      delete m.skills[name!];
      break;
    case "enable":
      delete get().enabled;
      break;
    case "disable":
      get().enabled = false;
      break;
    default:
      die(`unknown subcommand "skill ${sub}"`);
  }
  saveManifest(ctx, m);
  console.log(`${c.green("✓")} skill ${sub} ${name}. Run ${c.cyan("0b apply")} to sync.`);
}

function tool(args: string[]) {
  const [sub, t] = args;
  const [id] = parseTools(t) ?? die("usage: 0b tool enable|disable <tool>");
  if (sub !== "enable" && sub !== "disable") die("usage: 0b tool enable|disable <tool>");
  const m = requireManifest(ctx);
  m.tools[id!] = { enabled: sub === "enable" };
  saveManifest(ctx, m);
  console.log(`${c.green("✓")} ${id} ${sub}d.`);
}

async function main() {
  // `0b exec -- cmd --any --flags`: everything after is the command's, not ours.
  if (process.argv[2] === "exec") return execCommand(ctx, process.argv.slice(3));
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      only: { type: "string" },
      yes: { type: "boolean", short: "y" },
      "dry-run": { type: "boolean" },
      check: { type: "boolean" },
      "no-diff": { type: "boolean" },
      url: { type: "string" },
      header: { type: "string", multiple: true },
      env: { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      server: { type: "string" },
      web: { type: "boolean" },
      label: { type: "string" },
      "client-id": { type: "string" },
      "client-secret": { type: "string" },
      connect: { type: "string" },
      global: { type: "boolean" },
      delete: { type: "boolean" },
      "recovery-key": { type: "boolean" },
      variable: { type: "boolean" },
      secret: { type: "boolean" },
      repo: { type: "string" },
      tool: { type: "string" },
      days: { type: "string" },
      all: { type: "boolean" },
      quiet: { type: "boolean" },
      force: { type: "boolean" },
      note: { type: "string" },
      strict: { type: "boolean" },
      api: { type: "string" },
      auth: { type: "string" },
      spec: { type: "string" },
      file: { type: "string" },
      app: { type: "string" },
      "allow-write": { type: "boolean" },
    },
  });
  const [cmd, ...rest] = positionals;
  if (values.version) return console.log(version);
  if (values.help) return console.log(HELP);
  if (!cmd) {
    if (!interactive()) return console.log(HELP);
    return loadManifest(ctx) ? homeTui(ctx) : setup(ctx, {});
  }

  switch (cmd) {
    case "update":
    case "upgrade":
      return updateCommand(ctx, version, { check: values.check });
    case "setup":
      return setup(ctx, {
        yes: values.yes,
        only: parseTools(values.only),
        connect: values.connect?.split(",").map((x) => x.trim()).filter(Boolean),
        web: values.web,
        server: values.server,
      });
    case "profile":
    case "profiles":
      return profileCommand(ctx, rest);
    case "init": {
      if (interactive() && !values.yes) return initTui(ctx);
      mkdirSync(ctx.storeDir, { recursive: true, mode: 0o700 });
      const existed = existsSync(paths(ctx).manifest);
      const m = loadManifest(ctx) ?? emptyManifest();
      const adapters = getAdapters(ctx);
      console.log(`${existed ? "Using" : "Created"} ${paths(ctx).manifest}`);
      console.log(`Detected: ${TOOL_IDS.filter((t) => isInstalled(adapters[t])).map((t) => adapters[t].label).join(", ") || "no tools"}\n`);
      runImport(m);
      console.log(`\nNext: ${c.cyan("0b status")} to see drift, ${c.cyan("0b apply")} to sync every tool.`);
      return;
    }
    case "import":
      return runImport(requireManifest(ctx), parseTools(values.only));
    case "status":
    case "doctor":
      // `0b status tools`: the MCP servers, skills and instructions per tool (the sync table).
      if (rest[0] === "tools") {
        if (printStatus(ctx, requireManifest(ctx), store())) console.log(`Run ${c.cyan("0b apply")} to sync.`);
        return;
      }
      return doctorCommand(ctx);
    case "apply":
      return apply(values);
    case "mcp":
      return mcp(rest, values);
    case "skill":
    case "skills":
      return skill(rest);
    case "secret":
    case "secrets":
      return secretCommand(ctx, rest, { env: values.env?.at(-1), global: values.global, delete: values.delete, yes: values.yes, variable: values.variable, secret: values.secret, note: values.note, file: values.file, only: values.only, dryRun: values["dry-run"] });
    case "vault":
      return vaultCommand(ctx, rest, { recoveryKey: values["recovery-key"] });
    case "files":
      return filesCommand(ctx, rest, { force: values.force, quiet: values.quiet, all: values.all });
    case "background":
      if (rest[0] === "on" || rest[0] === "off") return installBackground(ctx, rest[0] === "on");
      return runBackground(ctx, Boolean(values.quiet));
    case "clip":
      return clipCommand(ctx, rest);
    case "project":
    case "projects":
      return projectCommand(ctx, rest, { strict: values.strict, label: values.label });
    case "history":
      return historyCommand(ctx, rest, { repo: values.repo, tool: values.tool, days: values.days, all: values.all, dryRun: values["dry-run"], quiet: values.quiet, yes: values.yes });
    case "tool":
      return tool(rest);
    case "login":
      await login(ctx, values.server, { web: values.web });
      if (interactive()) await syncFlow(ctx);
      else console.log(`Run ${c.cyan("0b apply --yes")} to add the gateway to your tools.`);
      return;
    case "logout":
      return logout(ctx, rest[0], { all: values.all });
    case "account":
    case "accounts":
      if (!accountCommand(ctx, rest)) return;
      if (interactive()) await syncFlow(ctx);
      else console.log(`Run ${c.cyan("0b apply --yes")} to point your AI tools at it.`);
      return;
    case "connect":
      return connectCommand(ctx, rest[0], rest[1], {
        headers: kv(values.header, "--header"),
        label: values.label,
        clientId: values["client-id"],
        clientSecret: values["client-secret"],
        api: values.api,
        auth: values.auth,
        spec: values.spec,
        allowWrite: values["allow-write"],
        yes: values.yes,
        app: values.app,
      });
    case "key":
      return keyCommand(ctx, rest[0]);
    case "rename":
      return renameConnection(
        ctx,
        await findConnection(ctx, rest[0] ?? die("usage: 0b rename <service> [--label <current>] <new label>"), values.label),
        rest.slice(1).join(" ") || undefined,
      );
    case "tree":
    case "ls":
      return printTree(ctx);
    case "disconnect": {
      const conn = await findConnection(ctx, rest[0] ?? die("usage: 0b disconnect <service> [--label <name>]   (see `0b cloud`)"), values.label);
      await cloudClient(ctx).client.disconnect(conn.id);
      console.log(`${c.green("✓")} disconnected ${conn.display}`);
      return;
    }
    case "cloud":
      if (rest[0] === "migrate") {
        if (!interactive()) die("`0b cloud migrate` is interactive");
        if (await migrateTui(ctx)) await syncFlow(ctx);
        return;
      }
      return cloudStatus(ctx);
    case "backups":
      for (const b of listBackups(ctx)) console.log(`  ${b}`);
      return;
    case "restore": {
      const id = rest[0] ?? die("usage: 0b restore <id> (see `0b backups`)");
      for (const p of restoreBackup(ctx, id)) console.log(`  ${c.green("↺")} ${p}`);
      return;
    }
    default:
      die(`unknown command "${cmd}". See \`0b --help\`.`);
  }
}

main().catch((e) => die(e?.message ?? String(e)));
