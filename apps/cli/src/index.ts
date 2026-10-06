import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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
  LINK_SERVER,
  checkSkill,
  copySkill,
  projectScope,
  projectSkillsDir,
  readSkill,
  sameSkill,
  type ImportReport,
  type SkillCheck,
  type Manifest,
  type McpServer,
  type ToolId,
} from "@0bridge/core";
import { c, printPlan, printStatus, printWarnings, where } from "./ui.ts";
import { homeTui, initTui, syncFlow } from "./tui.ts";
import { cloudClient, cloudStatus, connectCommand, connectionCommand, findConnection, keyCommand, login, logout, migrateTui, renameConnection } from "./cloud.ts";
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
import { here, projectCommand } from "./project.ts";
import { useCommand } from "./use.ts";
import { clipCommand } from "./clip.ts";
import { updateCommand } from "./update.ts";
import { resumeCommand } from "./resume.ts";
import { hookCommand } from "./hook.ts";
import { contextCommand, markSkills, memoryCommand, shareSkillsCommand } from "./context.ts";
import { connectTeam, teamCommand } from "./team.ts";
import { agentCommand } from "./agent/index.ts";
import { sessionsCommand } from "./sessions.ts";
import { webhookCommand } from "./webhook.ts";
import { driveCommand } from "./drive.ts";
import { usageCommand } from "./usage.ts";
import { agentVmSetup } from "./agent-vm.ts";
import { feedbackCommand } from "./feedback.ts";

declare const VERSION: string;
const version = typeof VERSION !== "undefined" ? VERSION : "dev";

const HELP = `${c.bold("0b")} — one bridge for all your AI agent tooling ${c.dim(`v${version}`)}

${c.bold("Usage")}
  0b setup                     Start here: sign in, add 0bridge to every AI tool on this machine,
        [--yes] [--only t,...]  connect services. --yes never prompts (for agents and scripts)
        [--connect a,b] [--web]
  0b setup --agent-vm          Set up an AI agent's computer (Muse, Manus…) with no prompts: prints a link
        [--attach <code>]       to approve, or uses a code from the dashboard; --name, --days (7), --email,
        [--no-vault] [--no-wait] --platform, --qr <file.png>
  0b                           Interactive: pick, review, and sync (first run starts setup)
  0b init [--yes]              Set up ~/.0bridge from your tools (--yes: import everything, no prompts)
  0b import [--only t,...]     Merge tool configs into the manifest (writes only to ~/.0bridge)
  0b tree                      Everything at a glance: cloud connections, MCP servers, skills (alias: ls)
  0b status                    Is this machine and this repo set up? A checklist with the command that fixes
                               each item ([agent]: safe for an agent to run; [you]: needs you). Alias: doctor
  0b status tools              What's in sync across tools (MCP servers, skills, instructions)
  0b apply [--only t,...]      Write the manifest into each tool (shows a diff, asks first)
        [--yes] [--dry-run]
  0b apply --only cursor       That tool's 0bridge entry lists three search tools in place of the connected
        --tool-search auto     services' tools: above 80 of them (auto), always (search), or never (all, the
                               default). For tools that load every tool at once; kept in the manifest
  0b mcp list
  0b mcp add <name> --url <url> [--header K=V]... [--only t,...]
  0b mcp add <name> [--env K=V]... [--only t,...] -- <command> [args...]
  0b mcp enable|disable|remove <name>
  0b skill add <folder>         Add a skill folder (SKILL.md with a name and description) to your synced
        [--only t,...] [--force]  skills; 0b apply puts it in every tool. --force replaces one of that name
  0b skill list | enable|disable|remove <name>
  0b skill share|local <name>…  A skill never on 0bridge stays on this machine until you choose: share
                                uploads it (other machines, chat apps), local keeps it here, unasked
  --project                    With mcp and skill: this repo's own servers and skills instead, written into
                                its checkouts by 0b apply (Claude Code's local scope, .codex/config.toml,
                                .cursor/mcp.json, .claude/skills, .agents/skills), kept out of git
  0b project import            Bring this checkout's project MCP servers and skills under 0bridge
  0b project instructions on|off  Make every tool read this repo's AGENTS.md or CLAUDE.md (on by default)
  0b use                       Claude Code and Codex accounts (config folders): which one starts here
  0b use add <name>            A second account: ~/.claude-<name> (--tool codex: ~/.codex-<name>, --dir
        [--tool t] [--dir d]    for another folder); prints how to sign in. 0b apply fills it like the first
  0b use <name>                This repo starts Claude Code (and Codex, if it has <name>) as that account;
        [--global] [--shell]    --global: everywhere else too; --shell: eval "$(0b use <name> --shell)"
  0b use default | rm <name> | shims [off]   Back to the tool's own; forget one; claude and codex shims
                               that start the account picked for the repo you're in
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
                                unless --strict). Also: status, list, unlink, rm, strict on|off, cloud
  0b project use <service> [--label a]   Limit a connection to this project (unuse undoes it)
  0b project hide <service> [--label a]  Keep a connection out of this project only (show undoes it),
                                e.g. another company's Slack in this repo
  0b project cloud             For agents in the cloud (Claude Code on the web): commit .mcp.json and an
        [--codex] [--cursor]    upload hook that use ZEROB_TOKEN, and get a 90-day token for it
        [--no-hooks] [--read-only]
  0b exec [--env prod] -- <cmd>  Run a command with this repo's secrets and CLI profile as env vars
        [--why "<sentence>"]    (and ZEROBRIDGE_ENV=dev|prod, so a script can tell it runs under 0b);
                               --why is shown on the prod approval page: what the command is for
  0b vault [status]            Whether this machine can open your vault
  0b vault unlock              New machine: approve it in the browser (passkey) or with \`0b vault approve\`
        [--recovery-key]        on another machine; --recovery-key types the key instead
  0b vault approve             Hand the vault key to a machine that's asking (compare the codes)
  0b history on                Upload this machine's conversations (Claude Code and app, Codex CLI and
                                app, Grok, Cursor, Gemini CLI, OpenClaw; secrets masked first) so every AI
                                tool can search them; syncs as each turn ends (hooks) and every 15 minutes.
                                --tool picks sources
  0b history search <words>    [--repo r] [--tool t] [--days n]; 0b history show <0b:ref>; 0b history list
  0b history mode server|e2e   server (default): your AI tools can search it. e2e: sealed with your
                                vault key, only 0b on your machines can search it
  0b history exclude <repo> | forget <id>|--all | off | status
  0b resume <0b:id>            Continue a session from any tool here: Claude Code, Codex, Gemini or Cursor
        [--tool t] [--print]    (--print shows the handoff instead of starting a tool)
  0b history hooks on|off      Upload each conversation as its turn ends (Claude Code, Codex, Cursor)
  0b context push|pull|sync|status  Your profile, global instructions and skills, on 0bridge for every AI app
  0b context rm <skill>        Remove a skill from 0bridge and your machines
  0b team                      Your team workspaces: their connectors (which you have), shared keys, skills
                               and instructions; brings the skills (as <team>--<skill>) and instructions here
  0b team skill push <folder>  As a team's admin: publish a skill to everyone (--name n; --workspace <team>
                               when you run more than one); 0b team skill rm <name> takes it back
  0b team instructions set <file>  As a team's admin: replace the team's instructions with the file's text
  0b context profile           Edit your profile (who you are, how you like to work)
  0b memory add|search|rm      Things your AIs should remember, searchable from any of them
  0b agent on|off|status       Let your AI apps start and steer coding agents on this machine
  0b agent allow|deny <path>   Repos agents may work in (nothing is allowed until you add one)
  0b agent log [task]          What tasks on this machine did (agent run: the daemon itself)
  0b agent supervisor openclaw --agent <id>   Host work your AI apps request (Dots, ChatGPT, Claude) goes to
        [--label <name>]        that OpenClaw agent here, one session per host-task task (off, status)
  0b sessions                  What your coding sessions are doing now, on every machine and in the cloud
        [--state needs-you]     (--machine m, --repo r); watch: refresh every 5 s
  0b sessions on|off           Post this machine's session states (Claude Code, Codex, Cursor) to your board
  0b drive ls [folder]          Your Drive (and your teams' with --workspace <team>): files, and a folder's README
  0b drive clone <folder> [dir] A local folder that syncs both ways with a Drive folder ("" for all of it)
  0b drive sync [dir] | status [dir] | unlink [dir]   Sync now, see what differs, stop syncing (files stay)
  0b drive email <folder>       The folder's email address: mail from you or your team lands there
  0b webhook add <name>         An address other services send events to (--preset channeltalk|github|generic);
                                asks what each event does: run a command here, forward it, start an agent,
                                notify you, or store it for agents (--route run|forward|agent|notify|store)
  0b webhook run <name> [--debounce 30] [--timeout 300] [--machine <m>] -- <command…>
                                Run a command on this machine for each event (event JSON on stdin); --off stops
  0b webhook listen [on|off]    Keep this machine connected for webhook runs (installed by \`run\`)
  0b webhook set <name> --route …   Change what a webhook does; forward-secret <name> makes a new signing secret
  0b webhook token <name>       Use the token the sender made (Channel Talk adds its own ?token= to the address)
  0b webhook list | rm | test | rotate <name> | events [name] [--follow]
  0b usage [--days 30]         Tokens and estimated cost by tool, model, repo or day (--by)
  0b usage on|off|forget       Upload token counts (never conversation text), even with history off; forget deletes them
  0b files add <file>…         Sync personal files kept out of git (AGENTS.local.md, CLAUDE.local.md symlink,
                                .claude/settings.local.json) to every clone of this repo, sealed with your vault
                                key; every change is a version. Also: status, pull, push [--force], rm, log, restore
  0b files statusline          Sync Claude Code's status line (the statusLine setting and its script) to
                                your other machines. Files under ~ outside a repo work too: 0b files add ~/…
  0b clip [file…]              Send what's on your clipboard (a screenshot, copied files or text), or files,
                                to your agents: over SSH or anywhere, they read it once with bridge__clipboard
                                within 10 minutes. Also: clip status, clip clear
  0b clip listen on|off        Let agents ask this machine for its clipboard: a dialog asks you each time
  0b clip sync on|off          On a Mac: images you copy (screenshots, copied images) go to your agents as you copy them
  0b clip paste [dir]          Save what's waiting here (over SSH too) and print the paths
  0b clip shims [off]          On a Linux server: ⌃V in Claude Code pastes the image you last copied on your Mac,
                               received as you copy it (clip sync on|off does the same there)
  0b background [on|off]       Run (or schedule every 15 min) the history, context, personal file and Drive folder sync
  0b tool enable|disable <tool>
  0b update [--check]          Install the newest 0b (and restart its background jobs); --check only looks
  0b login [--web]             Sign in with a one-time code (works over SSH too); --web uses a browser redirect
                               instead. Every tool then gets one MCP endpoint
  0b login --qr <file.png>     Also save the sign-in link as a QR image (for agents that can show images)
  0b login --email <you@…>     Also ask on that account's dashboard (Approvals): pick the number this terminal shows
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
  0b connect --team            Every connector your team uses that you haven't connected, one by one,
                               each signed in with your own account
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
        [--read-only]          Agents get only its tools that read (any of the forms above)
  0b connection [<service>]    Who each connection is signed in as, what it's for, and what agents get;
        [--label a] [--json]    with a service: its tools, each on or off (alias: connections)
  0b connection <service> read-only on|off       Agents get only the tools that read
  0b connection <service> tool on|off <tool>…    Turn single tools off (or back on) for agents
  0b connection <service> describe "<text>"      What it's for ("work calendar"); agents read it to
  0b connection <service> tags a,b                pick the right account. - clears either
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
  0b feedback [message]        Tell the 0bridge team what's wrong or what you'd like ($EDITOR or a
        [--kind idea|other]     prompt without a message). Shows the whole report and asks first.
        [--include-logs]        --include-logs adds the last lines of 0b's logs here, masked and shown
        [--yes]                 first; --yes is for an agent after you've read it and agreed

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
const MACHINE_WIDE = new Set(["setup", "init", "import", "apply", "mcp", "skill", "skills", "use", "tool", "login", "logout", "account", "accounts", "background", "backups", "restore", "profile", "profiles", "history", "resume", "hook", "context", "team", "teams", "memory", "agent", "sessions", "webhook", "webhooks", "usage"]);

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

/**
 * `--tool-search auto|search|all`: how the named tools' 0bridge entry lists tools, kept in
 * the manifest per tool. For a tool that loads every tool at once (Cursor); Claude Code and Codex
 * search tools themselves, so it's never set for all tools at once.
 */
function setToolSearch(m: Manifest, only: ToolId[] | undefined, mode: string): void {
  if (mode !== "auto" && mode !== "search" && mode !== "all") die('--tool-search is auto (search above 80 tools), search (always) or all (list every tool, the default)');
  if (!only) die(`say which tools get it: ${c.cyan(`0b apply --only cursor --tool-search ${mode}`)} (Claude Code and Codex search tools themselves)`);
  for (const t of only) {
    const entry = (m.tools[t] ??= { enabled: true });
    if (mode === "all") delete entry.toolSearch;
    else entry.toolSearch = mode;
  }
}

async function apply(values: { only?: string; yes?: boolean; "dry-run"?: boolean; "no-diff"?: boolean; "tool-search"?: string }) {
  const m = requireManifest(ctx);
  const s = store();
  const only = parseTools(values.only);
  if (values["tool-search"] !== undefined) setToolSearch(m, only, values["tool-search"]);
  // Kept once it's written (or there's nothing to write), not on a dry run or a "no".
  const keep = () => {
    if (values["tool-search"] !== undefined) saveManifest(ctx, m);
  };
  const plan = planApply(ctx, m, loadState(ctx), s, only, { projects: true });
  if (!plan.changes.length) {
    if (!values["dry-run"]) keep();
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
  keep();
  console.log(`${c.green("Applied.")} Backup ${c.dim(id)} — undo with ${c.cyan(`0b restore ${id}`)}`);
  console.log(c.dim("Restart running agent sessions to pick up changes."));
}

/**
 * `--project`: the commands work on this repo's project scope instead of the global list, and the
 * checkout is registered so `0b apply` writes into it (and every other registered clone).
 */
function scopeOf(m: Manifest, project: boolean | undefined): { scope: Pick<Manifest, "mcpServers" | "skills">; at: { root: string; repo: string } | null } {
  if (!project) return { scope: m, at: null };
  const at = here();
  return { scope: projectScope(m, at.repo, true), at };
}

function registerCheckout(at: { root: string; repo: string } | null) {
  if (!at) return;
  const st = loadState(ctx);
  (st.projects ??= {})[at.root] ??= { repo: at.repo, managed: {} };
  saveState(ctx, st);
}

const syncHint = (at: { repo: string } | null) => (at ? `Run ${c.cyan("0b apply")} to write it into this repo's checkouts (${at.repo}).` : `Run ${c.cyan("0b apply")} to sync.`);

function mcp(args: string[], values: Record<string, any>) {
  const [sub, name] = args;
  const m = requireManifest(ctx);
  const { scope, at } = scopeOf(m, values.project);
  const get = () => scope.mcpServers[name!] ?? die(`no MCP server "${name}"${at ? ` in ${at.repo}` : ""}`);
  switch (sub) {
    case undefined:
    case "list":
      if (at && !Object.keys(scope.mcpServers).length) console.log(c.dim(`  none for ${at.repo} yet: 0b mcp add <name> --project …, or 0b project import`));
      for (const [n, s] of Object.entries(scope.mcpServers).sort(([a], [b]) => a.localeCompare(b))) {
        const tags = [s.enabled === false && "disabled", s.targets && `only ${s.targets.join(",")}`].filter(Boolean).join(" ");
        console.log(`  ${n.padEnd(22)} ${c.dim(s.transport.padEnd(6))} ${where(s, 80)} ${c.yellow(tags)}`);
      }
      return;
    case "add": {
      if (!name) die("usage: 0b mcp add <name> ...");
      if (at && name === LINK_SERVER) die(`"${LINK_SERVER}" is the project endpoint 0b project link writes; pick another name`);
      const cmd = args.slice(2);
      const entry: McpServer = values.url
        ? { transport: /\/sse\/?$/.test(values.url) ? "sse" : "http", url: values.url, headers: kv(values.header, "--header") }
        : cmd.length
          ? { transport: "stdio", command: cmd[0], args: cmd.slice(1), env: kv(values.env, "--env") }
          : die("give --url <url> or -- <command> [args...]");
      if (values.only) entry.targets = parseTools(values.only);
      scope.mcpServers[name] = JSON.parse(JSON.stringify(entry));
      break;
    }
    case "remove":
      get();
      delete scope.mcpServers[name!];
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
  registerCheckout(at);
  console.log(`${c.green("✓")} mcp ${sub} ${name}${at ? ` (${at.repo})` : ""}. ${syncHint(at)}`);
}

/**
 * `0b skill add <folder>`: a skill written by hand (or downloaded) joins the synced ones. It's
 * checked first (checkSkill), copied into the store under its own name, and from there `0b apply`
 * puts it in every tool, as if it had been imported from one.
 */
function addSkill(m: Manifest, scope: Pick<Manifest, "skills">, at: { root: string; repo: string } | null, path: string | undefined, values: Record<string, any>) {
  if (!path) die("usage: 0b skill add <folder> [--only t,...] [--project] [--force]   (the folder with SKILL.md in it)");
  let dir = resolve(path);
  if (basename(dir) === "SKILL.md") dir = dirname(dir);
  let check: SkillCheck;
  try {
    check = checkSkill(dir);
  } catch (e) {
    die(e instanceof Error ? e.message : String(e));
  }
  const name = check.name;
  const dst = join(at ? projectSkillsDir(ctx, at.repo) : paths(ctx).skills, name);
  const had = scope.skills[name];
  const same = existsSync(dst) && sameSkill(dir, dst);
  if (had && existsSync(dst) && !same && !values.force) die(`there's already a skill "${name}" with other content (0b skill list${at ? " --project" : ""}): --force replaces it`);
  // A folder added from the store itself is already in place: copying would delete it first.
  if (resolve(dir) !== resolve(dst) && !same) copySkill(dir, dst);
  scope.skills[name] = { ...(had ?? {}), ...(values.only ? { targets: parseTools(values.only) } : {}) };
  saveManifest(ctx, m);
  // Added by hand: the user chose it, so it may go up to 0bridge.
  if (!at) markSkills(ctx, [name], "share");
  registerCheckout(at);
  for (const w of check.warnings) console.log(`  ${c.yellow("!")} ${w}`);
  const kept = readSkill(dst, name)?.skipped.filter((s) => /credential/.test(s.why)) ?? [];
  if (!at && kept.length) console.log(`  ${c.yellow("!")} ${kept.map((s) => s.path).join(", ")} look${kept.length === 1 ? "s" : ""} like ${kept.length === 1 ? "it holds" : "they hold"} a credential: synced to your tools here, but never uploaded by 0b context push`);
  console.log(`${c.green("✓")} skill ${c.bold(name)} ${had ? (same ? "is already in" : "replaced in") : "added to"} ${at ? `${at.repo}'s skills` : "your skills"}${c.dim(` (${check.description.length > 60 ? check.description.slice(0, 59) + "…" : check.description})`)}. ${syncHint(at)}`);
}

function skill(args: string[], values: Record<string, any>) {
  const [sub, name] = args;
  if (sub === "share" || sub === "local") {
    if (values.project) die(`a repo's skills stay in the repo: 0b skill ${sub} is for your own`);
    return shareSkillsCommand(ctx, args.slice(1), sub);
  }
  const m = requireManifest(ctx);
  const { scope, at } = scopeOf(m, values.project);
  const get = () => scope.skills[name!] ?? die(`no skill "${name}"${at ? ` in ${at.repo}` : ""}`);
  switch (sub) {
    case undefined:
    case "list":
      if (at && !Object.keys(scope.skills).length) console.log(c.dim(`  none for ${at.repo} yet: 0b skill add <folder> --project, or 0b project import`));
      for (const [n, s] of Object.entries(scope.skills).sort(([a], [b]) => a.localeCompare(b))) {
        console.log(`  ${n.padEnd(28)} ${c.yellow([s.enabled === false && "disabled", s.targets && `only ${s.targets.join(",")}`].filter(Boolean).join(" "))}`);
      }
      return;
    case "add":
      return addSkill(m, scope, at, name, values);
    case "remove":
      get();
      delete scope.skills[name!];
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
  registerCheckout(at);
  console.log(`${c.green("✓")} skill ${sub} ${name}${at ? ` (${at.repo})` : ""}. ${syncHint(at)}`);
}

function tool(args: string[]) {
  const [sub, t] = args;
  const [id] = parseTools(t) ?? die("usage: 0b tool enable|disable <tool>");
  if (sub !== "enable" && sub !== "disable") die("usage: 0b tool enable|disable <tool>");
  const m = requireManifest(ctx);
  m.tools[id!] = { ...m.tools[id!], enabled: sub === "enable" };
  saveManifest(ctx, m);
  console.log(`${c.green("✓")} ${id} ${sub}d.`);
}

async function main() {
  // `0b exec -- cmd --any --flags`: everything after is the command's, not ours.
  if (process.argv[2] === "exec") return execCommand(ctx, process.argv.slice(3));
  // `0b webhook run <name> -- python3 sync.py --flag`: what follows `--` is the command to run, never ours.
  let args = process.argv.slice(2);
  let command: string[] | undefined;
  if ((args[0] === "webhook" || args[0] === "webhooks") && args.includes("--")) {
    command = args.slice(args.indexOf("--") + 1);
    args = args.slice(0, args.indexOf("--"));
  }
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      only: { type: "string" },
      yes: { type: "boolean", short: "y" },
      "dry-run": { type: "boolean" },
      check: { type: "boolean" },
      "no-diff": { type: "boolean" },
      "tool-search": { type: "string" },
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
      print: { type: "boolean" },
      turns: { type: "string" },
      hooks: { type: "boolean" },
      "no-hooks": { type: "boolean" },
      worker: { type: "boolean" },
      codex: { type: "boolean" },
      cursor: { type: "boolean" },
      "read-only": { type: "boolean" },
      mode: { type: "string" },
      tags: { type: "string" },
      api: { type: "string" },
      auth: { type: "string" },
      spec: { type: "string" },
      file: { type: "string" },
      app: { type: "string" },
      "allow-write": { type: "boolean" },
      qr: { type: "string" },
      email: { type: "string" },
      "agent-vm": { type: "boolean" },
      name: { type: "string" },
      attach: { type: "string" },
      platform: { type: "string" },
      "no-vault": { type: "boolean" },
      "no-wait": { type: "boolean" },
      preset: { type: "string" },
      board: { type: "string" },
      route: { type: "string" },
      "routine-url": { type: "string" },
      template: { type: "string" },
      agent: { type: "string" },
      machine: { type: "string" },
      notify: { type: "boolean" },
      follow: { type: "boolean" },
      by: { type: "string" },
      state: { type: "string" },
      json: { type: "boolean" },
      kind: { type: "string" },
      "include-logs": { type: "boolean" },
      team: { type: "boolean" },
      project: { type: "boolean" },
      shell: { type: "boolean" },
      dir: { type: "string" },
      workspace: { type: "string" },
      debounce: { type: "string" },
      timeout: { type: "string" },
      off: { type: "boolean" },
      "host-task": { type: "string" },
      openclaw: { type: "string" },
      herdr: { type: "string" },
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
      if (values["agent-vm"])
        return agentVmSetup(ctx, {
          attach: values.attach,
          email: values.email,
          name: values.name,
          days: values.days === undefined ? undefined : Number(values.days),
          platform: values.platform,
          qr: values.qr,
          noVault: values["no-vault"],
          noWait: values["no-wait"],
          server: values.server,
          only: parseTools(values.only),
        });
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
    case "use":
      return useCommand(ctx, rest, { tool: values.tool, dir: values.dir, global: values.global, shell: values.shell });
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
      return skill(rest, values);
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
      return projectCommand(ctx, rest, { strict: values.strict, label: values.label, codex: values.codex, cursor: values.cursor, noHooks: values["no-hooks"], readOnly: values["read-only"] });
    case "history":
      return historyCommand(ctx, rest, {
        repo: values.repo,
        tool: values.tool,
        days: values.days,
        all: values.all,
        dryRun: values["dry-run"],
        quiet: values.quiet,
        yes: values.yes,
        hooks: values.hooks,
        noHooks: values["no-hooks"],
        worker: values.worker,
      });
    case "resume":
      return resumeCommand(ctx, rest, { tool: values.tool, print: values.print, turns: values.turns });
    case "hook":
      return hookCommand(ctx, rest);
    case "context":
      return contextCommand(ctx, rest, { force: values.force, quiet: values.quiet, yes: values.yes });
    case "team":
    case "teams":
      return teamCommand(ctx, rest, { name: values.name, workspace: values.workspace });
    case "memory":
      return memoryCommand(ctx, rest, { tags: values.tags, yes: values.yes });
    case "agent":
      return agentCommand(ctx, rest, {
        repo: values.repo,
        mode: values.mode,
        yes: values.yes,
        quiet: values.quiet,
        agent: values.agent,
        label: values.label,
        hostTask: values["host-task"],
        openclaw: values.openclaw,
        herdr: values.herdr,
      });
    case "sessions":
      return sessionsCommand(ctx, rest, { state: values.state, machine: values.machine, repo: values.repo, json: values.json, quiet: values.quiet, worker: values.worker });
    case "webhook":
    case "webhooks":
      return webhookCommand(ctx, rest, {
        preset: values.preset,
        board: values.board,
        route: values.route,
        repo: values.repo,
        agent: values.agent,
        machine: values.machine,
        mode: values.mode,
        template: values.template,
        routineUrl: values["routine-url"],
        notify: values.notify,
        follow: values.follow,
        json: values.json,
        yes: values.yes,
        url: values.url,
        debounce: values.debounce,
        timeout: values.timeout,
        off: values.off,
        command,
      });
    case "drive":
      return driveCommand(ctx, rest, { workspace: values.workspace, json: values.json, yes: values.yes, quiet: values.quiet, force: values.force });
    case "usage":
      return usageCommand(ctx, rest, { days: values.days, by: values.by, json: values.json, quiet: values.quiet });
    case "tool":
      return tool(rest);
    case "feedback":
      return feedbackCommand(ctx, rest, { kind: values.kind, includeLogs: values["include-logs"], yes: values.yes }, version);
    case "login":
      await login(ctx, values.server, { web: values.web, qr: values.qr, email: values.email });
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
      if (values.team) return connectTeam(ctx, { yes: values.yes });
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
        readOnly: values["read-only"],
      });
    case "connection":
    case "connections":
      return connectionCommand(ctx, rest, { label: values.label, json: values.json });
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
