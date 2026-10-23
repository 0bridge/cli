// What a new user sees first, shared by the landing page, the dashboard and the CLI.
// No imports: this file is bundled into the Worker and the web app as-is.

export const INSTALL_COMMAND = "npm install -g 0bridge@latest";
export const SETUP_COMMAND = "0b setup";

/** Paste into Claude Code, Codex, Cursor or Gemini CLI; the agent installs and sets up 0bridge, the user only approves in the browser. */
export function agentPrompt(server = "https://0bridge.dev"): string {
  const host = server.replace(/\/+$/, "");
  return `Set up 0bridge on this machine for me. 0bridge gives all my AI tools (Claude Code, Codex, Cursor, Gemini CLI) one MCP endpoint, ${host}/mcp, and keeps my service sign-ins (Linear, Notion, …) in the cloud, so I sign in once for every tool.

1. Install the CLI: \`${INSTALL_COMMAND}\` (needs Node 20.12+). Check it with \`0b --version\`.
2. Run \`0b setup --yes${host === "https://0bridge.dev" ? "" : ` --server ${host}`}\`. It finds the AI tools on this machine, signs me in, and adds 0bridge to each of them, backing up every file it changes.
   - Sign-in opens my browser. Show me the one-time code from the output right away, then wait: the command finishes by itself once I approve (up to 10 minutes). Give it a long timeout, or run it in the background and watch its output.
3. Ask me which services to connect. \`0b connect\` lists the known ones (linear, notion, sentry, github, context7, …); any MCP URL works too. For each one, run \`0b connect <service>\`: it opens that service's sign-in in my browser and waits until I finish. For a second account of the same service, add \`--label <name>\`, for example the workspace name.
4. Run \`0b tree\` and show me the result.
5. Tell me to restart my AI tools, this session included, so they load 0bridge.

Only use the 0b CLI for this; don't edit tool config files by hand.`;
}

/** The three steps, for people reading before they run anything. */
export const HOW_IT_WORKS = [
  { title: "Sign in", text: "`0b setup` opens your browser with a one-time code. Approve it; this machine gets its own token." },
  { title: "Every AI tool gets 0bridge", text: "Claude Code, Codex, Cursor and Gemini CLI on this machine get one MCP server and the 0bridge skill, so later requests like \"add the Sentry MCP\" go through 0bridge too. Config files are backed up first." },
  { title: "Connect services once", text: "`0b connect linear` opens Linear's sign-in. From then on every tool has Linear's tools, as `linear__…`." },
];

/**
 * The `0bridge` skill `0b` installs into every AI tool, so agents route future requests
 * ("add the Sentry MCP", "use my other Linear workspace") through 0bridge instead of
 * editing one tool's config.
 */
export const BRIDGE_SKILL = `---
name: 0bridge
description: Use whenever the user wants to add, connect, remove or rename an MCP server or a service integration (Linear, Notion, Sentry, GitHub, Cloudflare, PostHog, Stripe, any MCP URL), use another account or workspace of a service, share a skill across AI tools, or pick which CLI account (wrangler, gh) a repo uses — and when they ask which tools or accounts are available. 0bridge manages these for every AI tool on this machine (Claude Code, Codex, Cursor, Gemini CLI) through the \`0b\` CLI.
---

# 0bridge

Every AI tool on this machine shares one MCP server, \`0bridge\`. Services connected to it show up in all of them, on every machine the user signs in on, as \`<service>__<tool>\` (or \`<service>__<label>__<tool>\` for a labeled account).

**Always go through \`0b\`.** Don't run \`claude mcp add\` / \`codex mcp add\` or edit \`~/.claude.json\`, \`~/.codex/config.toml\` or \`~/.cursor/mcp.json\` by hand: that reaches one tool only and 0bridge won't know about it.

## Set up a machine or a repo

When the user asks to set up this machine or a repo ("sync the backend dev environment here", "get this clone ready"), or when you start working in a repo and something 0bridge provides seems missing (a connection, a skill):

1. Run \`0b status\` in the repo. It's a checklist for this machine and this repo: each item is done (✓) or not (●) with the command that fixes it, marked **[agent]** (safe for you to run as is) or **[you]** (needs the user: a sign-in, a key, a choice).
2. Run the [agent] fixes without asking: \`0b apply --yes\`, \`0b project link\`, \`0b background on\`, and \`0b vault unlock\` (tell the user to approve it in their browser and check the code matches).
3. Don't run the [you] ones.
4. Tell the user in one short summary: what you did, what's set up (the project and the connections its agents see), and what's left for them, as the commands or dashboard steps \`0b status\` printed.

## Connect a service (remote MCP with sign-in)

- Any service, by name or address: \`0b connect <name or address> --yes\` (e.g. \`stripe\`, \`api.channel.io\`). 0bridge finds it: its own MCP server (0bridge's list, the official MCP registry, the usual addresses), else its OpenAPI document. It prints what it found and connected. Known MCP URL: \`0b connect <name> <https-url>\`; known API document: \`0b connect <name> --spec <url>\`.
- It never connects a third party's MCP server on its own (someone else's server sees the data passing through). If only those exist, it lists them: ask the user before connecting one.
- It opens the service's sign-in in the user's browser and waits up to 5 minutes. Run it with a long timeout, and tell the user to finish signing in.
- Another account of the same service: \`0b connect linear --label <workspace>\`.
- The connectors the user's team uses: \`0b connect --team\` connects the ones they haven't, one by one, each with their own sign-in. \`0b team\` shows the team's connectors, skills (\`<team>--<skill>\`, set by its admins: don't edit or push them) and instructions.
- A few services (Vercel) accept only apps they've reviewed, not the bridge. \`0b connect vercel\` then adds the server to each AI tool directly; tell the user to sign in once in each tool (Claude Code: \`/mcp\`; Codex: \`codex mcp login vercel\`; Cursor: MCP settings).
- \`0b cloud\` lists connections. \`0b rename linear --label <current> <new>\` changes a label (sign-in kept); \`0b disconnect linear --label <name>\` removes one. Leave out \`--label\` when the service has one account.
- \`0b connection\` shows who each connection is signed in as and what it's for. The user decides what agents get: \`0b connect <service> --read-only\` (only tools that read), \`0b connection <service> read-only on|off\`, \`0b connection <service> tool off <tool>\`, \`0b connection <service> describe "work calendar"\` and \`tags work,acme\`. Change these only when the user asks.
- New tools appear after the AI tool reloads its MCP servers; ask the user to restart the session if they don't.
- Cursor slow or over its tool limit with many services connected: \`0b apply --only cursor --tool-search auto --yes\` gives it three search tools in their place above 80 tools (\`search\`: always, \`all\`: back to every tool). Claude Code and Codex search tools themselves: leave them as they are.

## Local MCP servers (run on this machine)

- \`0b mcp add <name> -- <command> [args…]\` (or \`--url <url>\` for a local HTTP server), then \`0b apply --yes\` writes it into every tool.
- Secrets: never put secret values in commands, files or chat. A key a local server needs is the user's to enter: they add it to the server's config in one tool themselves, then \`0b import\` moves it into this machine's keychain (the config keeps a \`\${secret:<NAME>}\` reference) and \`0b apply --yes\` shares the server.
- Prefer \`0b connect\` whenever the server has a remote URL: the sign-in is kept once for every tool and machine.

## Skills and instructions

- A new skill written into one tool's skills folder (e.g. \`~/.claude/skills/<name>/SKILL.md\`): run \`0b import\` then \`0b apply --yes\` to share it with every tool.
- A skill folder anywhere else (written by hand, downloaded): \`0b skill add <folder>\` checks it (SKILL.md with \`name\` and \`description\` front matter) and adds it to the synced skills; then \`0b apply --yes\`.
- Only for one repo: \`0b mcp add <name> --project …\` and \`0b skill add <folder> --project\` inside it; \`0b apply --yes\` writes them into that repo's checkouts (kept out of git). \`0b project import\` brings what a checkout's tools already have there under 0bridge.
- Uploading to 0bridge (the user's other machines and chat apps) is a separate choice: a skill that was never on 0bridge stays on this machine until the user decides. When \`0b status\` lists skills waiting for their call, ask the user once which to upload, then run \`0b skill share <name>\` for those and \`0b skill local <name>\` for the rest (it stops asking). \`0b skill add\` counts as their yes.
- \`0b skill list\`, \`0b skill disable <name>\`.

## Claude Code and Codex accounts

- \`0b use\` lists them (a second account is a config folder, \`~/.claude-<name>\`). \`0b use add <name>\` makes one and prints how the user signs in (they run that themselves). \`0b use <name>\` in a repo picks it there; it takes effect when the tool starts through \`0b use shims\` or \`0b exec -- claude\`. A running session can't change account.

## CLI accounts per repo

- \`0b profile\` shows profiles and who each CLI is signed in as.
- \`0b profile add <name> wrangler gh\` runs each CLI's own login into a separate profile; \`0b profile use <name>\` binds the current repo to it.
- \`0b exec -- <command>\` runs a command with the repo's profile.

## Past conversations

- The user's earlier sessions in Claude Code, Codex and other tools can be searched with the \`bridge__history_search\` tool (then \`bridge__history_get\` to read one), or \`0b history search "<words>"\` in a terminal. Use it when the user refers to something done or decided before ("like we did in the api repo last week").
- It's empty until the user turns it on: \`0b history on\` (uploads this machine's sessions, secrets masked first). Suggest it; don't run it for them.

## Drive: files every AI app reads

- The user's Drive, and their teams', holds files every AI app reaches through the \`bridge__drive_*\` tools, Claude and ChatGPT included. A folder with a README.md or AGENTS.md is a piece of work: list it first (\`bridge__drive_list\`), then follow its AGENTS.md and skills (\`bridge__skills\` with \`folder\`).
- Its README.md is the work's current state, shared by every AI app: read it before working, and when the user decides something or an output is made, update it with \`bridge__drive_write\` and \`base_version\` (decisions only as the user made them; a changed one is marked "replaced by …", not deleted). Before the user switches tools, checkpoint your session there: \`bridge__session_save\` with \`session\` (your session's ref) and \`folder\`. A session run inside a \`0b drive clone\` folder is filed under it on its own. In a \`0b drive clone\` folder, edit the files on disk and sync them yourself; don't also write the same files with \`bridge__drive_write\` (two ways in for one file make conflict copies).
- To work on a Drive folder on this machine: \`0b drive clone <folder> [dir]\` (\`--workspace <team>\` for a team's) makes a local folder that syncs both ways when \`0b drive sync\` runs in it, with the folder's skills in \`.claude/skills\` and its AGENTS.md as CLAUDE.md. Nothing syncs it on a timer: run \`0b drive sync\` in the folder right before you read or edit its files (others may have changed them), and again right after you write, so the next one gets your change. \`0b drive status\` shows what differs. \`0b drive ls [folder]\` lists one; \`0b drive email <folder>\` prints the address mail to it goes to.
- Changed on both sides: sync keeps this machine's file and saves Drive's next to it as \`<name>.0bridge-<who>-v<n>.<ext>\`. Merge the two, then delete the copy.
- A change to AGENTS.md, CLAUDE.md, \`.claude/\` or \`.agents/skills/\` through the \`bridge__drive_*\` tools, or by a team member who isn't an admin, waits as a proposal for an owner or admin in the dashboard. Tell the user; don't look for a way around it.
- In a folder synced on an owner's or admin's machine, your edits to those files go up as theirs on the next sync, with no proposal: change them only when the user asked you to, and tell them what you changed.
- 0bridge's server reads Drive files (that's how chat apps search them): secrets never go in Drive.

## APIs through 0bridge

- Some connections are HTTP APIs rather than MCP servers (the Connections list says "API"). Google Calendar and Channel Talk have their own tools. An API connected from its OpenAPI document has \`<service>__search\` (find an operation by words), \`<service>__describe\` (its parameters and body), \`<service>__call\` (reads) and, once the user allows writes, \`<service>__call_write\`. Any other API has \`<service>__get\` (reads) and \`<service>__request\` (changes) with a path under its base URL. 0bridge adds the key; you never see it and don't need to.
- OpenAPI connections only read (GET) until the user allows writes (dashboard: Connections › ⋯ › Allow writes). If a call is refused for that, tell the user; don't look for another way around it.
- **Keys never go through you.** When the user asks you to connect an API: run \`0b connect <service> --yes\`. It registers everything except the key and prints what to tell the user: run \`0b key <service>\` in their own terminal (hidden input), or open the printed dashboard link. Never ask for a key in chat and never put one in a command, file or env var. The same from MCP: \`bridge__connect\` with just the service name.
- Any API by base URL instead: \`0b connect <service> --api <base url> --auth header:X-API-Key --yes\`, then \`0b key <service>\`.

## Projects

- A repo can be a project with its own connections: in it, agents see those (and the global ones, unless it's strict). \`0b project\` shows what this repo gets; \`0b project link\` points this clone's AI tools at the project (the user decides which connections belong to it: \`0b project use <service> --label <account>\` limits one to this project; \`0b project hide <service> --label <account>\` keeps one out of it and leaves it everywhere else; or the dashboard).
- A company repo should use the company's accounts only. If a tool you need isn't there, ask the user rather than using another account.

## Look around

- \`0b tree\`: cloud connections, MCP servers, skills and instructions at a glance.
- Something was added to a tool directly? \`0b import\`, then \`0b apply --yes\`.

## When 0bridge itself fails

- If a \`0b\` command, a \`bridge__\` tool or a connection fails in a way that looks like a 0bridge bug (not the user's code, not a service's own error, not a missing sign-in the output tells you how to fix), offer to send the 0bridge team a report. The user may also ask you to send feedback or an idea.
- Write it to be reproducible: what you were doing, the exact commands, the error text, what you expected and what happened, and \`0b --version\`, your tool and the OS. Leave out secret values, tokens, file contents and personal details beyond what's needed.
- Show the user the whole report and send it only after they say yes. \`0b feedback --kind problem "<report>"\` without \`--yes\` prints exactly what would be sent (with \`--include-logs\`, 0b's recent log lines too, masked) and sends nothing: show that, and once they agree run it again with \`--yes\`. Or use the \`bridge__feedback\` tool.
`;

/** A project's "Copy prompt": set up the repo it's run in (dashboard, project Overview). */
export const PROJECT_PROMPT = `Set up this repo in 0bridge, so agents here get its own connections.

1. Run \`0b project\` to see where it stands. If \`0b\` isn't installed or I'm not signed in, set up 0bridge first (\`npm install -g 0bridge@latest\`, then \`0b setup --yes\`).
2. Run \`0b project link\`. It makes the repo a project and points this clone's Claude Code, Codex, Cursor and Gemini CLI at it. Tell me which connections agents here will see.
3. Tell me what changed and what I should do next (for example restart this tool so it picks up the project).`;

/** The prompts the dashboard's "Copy prompt" hands to an agent. Always English: agents follow it best, whatever the user speaks. */
export const PROMPTS = {
  setup: agentPrompt,
  project: PROJECT_PROMPT,
};
