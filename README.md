# 0bridge CLI

The `0b` command-line tool for [0bridge](https://0bridge.dev): one MCP endpoint for all your AI tools. Sign in to Linear, Notion, Sentry and the rest once, and Claude Code, Codex, Cursor, Claude and ChatGPT all use them, and your history, memory and instructions go where you go, so you can switch tools without starting over.

This repository is the client: the `0b` CLI (`apps/cli`) and the library it's built on (`packages/core`). It's published so you can read what runs on your machine before you install it. The 0bridge gateway it talks to is a hosted service and isn't part of this repository.

```sh
npm install -g 0bridge@latest
0b setup
```

Getting started, every command and how it all works: [0bridge.dev/docs](https://0bridge.dev/docs).

## What runs on your machine

- **Tool settings.** `0b setup` and `0b apply` write the 0bridge endpoint, your MCP servers, skills and instructions into each AI tool's own config (Claude Code, Codex, Cursor, Gemini CLI), backing every file up first. See `packages/core/src/adapters.ts` and `plan.ts`.
- **The vault.** Secrets are encrypted here before they're uploaded (AES-256-GCM, a key only your devices hold), and `0b exec` hands them to a command as environment variables, masking them in output an agent reads. See `packages/core/src/vault-crypto.ts`, `vault.ts` and `apps/cli/src/vault.ts`.
- **Conversation history,** only if you turn it on: read from your AI tools' local files, with vault values and key-shaped text masked on this machine before upload. See `packages/core/src/history.ts`.
- **Hooks,** only if you turn on history or the session board: one silent entry per event in each AI tool's hook settings, next to whatever is already there. It writes a note and a background worker posts the state, with up to two redacted lines of text and none with end-to-end history. See `apps/cli/src/hook.ts` and `sessions.ts`.
- **Token counts,** with history or `0b usage on`: counts only, never text, read from the same local files. See `apps/cli/src/usage.ts`.
- **Agent computers.** `0b setup --agent-vm` sets up an AI agent's own computer without prompts, with an expiring token. It installs no background service. See `apps/cli/src/agent-vm.ts`.
- **Personal files** are sealed with your vault key before upload (`apps/cli/src/files.ts`).

What the server can and can't read: [0bridge.dev/docs/security](https://0bridge.dev/docs/security).

## Build it yourself

```sh
bun install
bun test
bun run build        # apps/cli/dist/0b.js, the file npm ships
```

Releases are built and published from this repository by GitHub Actions with [npm provenance](https://docs.npmjs.com/generating-provenance-statements), so `npm view 0bridge --json` (and the package page on npmjs.com) links each version to the commit and workflow that built it.

## Issues and security

Bugs and questions: [issues](https://github.com/0bridge/cli/issues). Security problems: write to [support@0bridge.dev](mailto:support@0bridge.dev) instead of opening an issue.

This repository mirrors the client from 0bridge's private monorepo, so pull requests may be applied there by hand rather than merged here.

## License

Source available under the [Functional Source License 1.1, Apache 2.0 future license](LICENSE) (FSL-1.1-ALv2): use it, read it, change it and run it however you like, except to build a product that competes with 0bridge. Each version becomes Apache 2.0 two years after its release. Versions up to 0.2.13 were published under MIT.
