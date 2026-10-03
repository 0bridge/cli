# 0bridge

One bridge for your AI tools.

Sign in to Linear, Notion, Sentry and the rest once. Claude Code, Codex, Cursor, Claude and
ChatGPT all use them through one MCP endpoint, `https://0bridge.dev/mcp`. The `0b` CLI also keeps
your MCP servers, skills and AGENTS.md in sync across the AI tools on each machine.

The point is that your context isn't locked into one vendor: the same services, instructions,
memory and session history in every tool, so you can continue a session in a different tool
(`0b resume 0b:k3f9x2`), steer your coding agents from your phone (off until you turn it on) and
switch tools without starting over. Which AI products work, and how well, is dated in
[Supported clients](https://0bridge.dev/docs/clients).

Also: one board of what every coding session is doing (`0b sessions`, which one needs you), one command
that sets up your dev environment on an AI agent's own computer (`0b setup --agent-vm`; Muse and Manus
are untested, Instinct is not supported), Drive folders of files and instructions every AI app works
in, synced to a folder on your computer (`0b drive`), webhooks that run a command on your machine,
forward to your server or wake an agent instead of a polling timer (`0b webhook`), and token counts
with an estimated cost (`0b usage`). Details and limits:
[docs](https://0bridge.dev/docs).

> Status: early development. The gateway runs at https://0bridge.dev.

## Get started

**Let your agent do it.** Copy the setup prompt from https://0bridge.dev and paste it into
Claude Code, Codex or Cursor. The agent installs the CLI and runs the steps below; you only
approve sign-ins in the browser.

**Or run it yourself:**

```sh
npm install -g 0bridge@latest
0b setup               # sign in (browser, one-time code) and add 0bridge to every AI tool here
0b connect linear      # opens Linear's sign-in; every tool now has linear__* tools
0b connect linear --label acme   # a second Linear workspace: linear__acme__*
0b tree                # everything at a glance
```

`0b setup --yes` never prompts (for agents and scripts). Run `0b` on its own to bring your
existing MCP servers and skills under 0bridge and keep every tool in sync.

### Secrets your agents use without seeing

```sh
0b secret set STRIPE_KEY          # asks for the value; encrypted on this machine, synced as ciphertext
0b secret import .env --dry-run   # list what would move (replaces? localhost?); stores nothing
0b secret import .env --only A,B  # move just those names (without --only: the whole file)
0b secret paste                   # or paste KEY=value lines (from a dashboard, a teammate…)
0b secret show STRIPE_KEY         # see a value yourself (secrets go to your terminal only)
0b exec -- bun dev                # runs with this repo's values as env vars
0b exec --env prod -- wrangler deploy   # prod: approve in your browser with your passkey first
```

Values are per repo (or `--global`) and per environment, and each is a secret (hidden, shown
as `***` in output an agent reads) or a plain variable like `PORT` (`--variable`). Pasted and
imported lines are sorted for you; switch with `0b secret mark NAME --secret|--variable`. The vault key stays on your machines. On a new
machine, `0b vault unlock` asks for it: approve in the dashboard with your passkey, or run
`0b vault approve` on a machine that has it (both show the same code). The first `0b secret set`
also shows a recovery key; keep it in your password manager. The dashboard's Secrets page opens
the vault in your browser only.
Your `.env` files keep working; the vault is there when you want agents to stop reading them.

- **Claude / ChatGPT**: add a custom connector with `https://0bridge.dev/mcp`.
- **Dashboard**: https://0bridge.dev/app — connections, device tokens, manual setup.
- **Manifest** `~/.0bridge/0bridge.json` is the single source of truth for local sync.
- **Secrets** found in MCP env/headers move to the OS's secret store (macOS Keychain, Windows DPAPI, Linux
  Secret Service, else a file only you can read) and are referenced as `${secret:name}`;
  global vault values (`0b secret set NAME --global`) resolve there too.
- **Safe by default**: 0bridge only removes what it wrote itself, never overwrites entries it
  doesn't manage, and backs up every file before writing (`0b backups`, `0b restore <id>`).
- Tool-bound servers (e.g. binaries inside the Codex app) are pinned to their tool.

## Layout

- `packages/core` — manifest, per-tool adapters, import/plan/apply engine
- `apps/cli` — the `0b` CLI (published to npm as `0bridge`)

## Development

```sh
bun install
bun test
bun run typecheck
bun run build        # apps/cli/dist/0b.js (runs on Node >= 20.12)
```
