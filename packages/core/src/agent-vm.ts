/**
 * AI agents' own computers (round 2, D53): which ones 0bridge can set up, the copyable "set up my
 * dev environment" prompt, and the line about using API keys there. Imported by the CLI, the
 * dashboard, the gateway and the landing page, so it stays free of Node APIs.
 */
// Extensionless: the gateway and the web app compile this file too.
import { INSTALL_COMMAND } from "./onboarding";

/** works: run end to end on the real product; untested: has a shell, not run yet; unverified: whether it has a shell is unknown. */
export type AgentVmStatus = "works" | "untested" | "unverified" | "unsupported";

export interface AgentVmPlatform {
  id: "muse" | "manus" | "dots" | "grok-bot" | "instinct" | "other";
  name: string;
  shell: string;
  status: AgentVmStatus;
  notes: string;
  /** When the status was last checked (YYYY-MM-DD). */
  checked: string;
}

/** Nothing is labeled "works" until it has run on the real product (R17). */
export const AGENT_VM_PLATFORMS: AgentVmPlatform[] = [
  { id: "muse", name: "Meta Muse", shell: "Debian", status: "untested", notes: "Debian shell; approve 0bridge.dev, and the AI provider your agent uses, in Sentinel when asked", checked: "2026-10-01" },
  { id: "manus", name: "Manus", shell: "Ubuntu", status: "untested", notes: "Ubuntu shell", checked: "2026-10-01" },
  { id: "dots", name: "OpenAI Dots", shell: "unknown", status: "unverified", notes: "we don't know yet whether Dots runs shell commands", checked: "2026-10-01" },
  { id: "grok-bot", name: "Grok Bot", shell: "unknown", status: "unverified", notes: "we don't know yet whether Grok Bot runs shell commands", checked: "2026-10-01" },
  { id: "instinct", name: "Instinct", shell: "none", status: "unsupported", notes: "no terminal or MCP yet", checked: "2026-10-01" },
  { id: "other", name: "Another agent's computer", shell: "Linux or macOS", status: "untested", notes: "any computer where your agent runs shell commands", checked: "2026-10-01" },
];

export const agentVmPlatform = (id: string | null | undefined): AgentVmPlatform | null => AGENT_VM_PLATFORMS.find((p) => p.id === id) ?? null;

/** An agent VM's name (the token's `machine`): attaching again under the same name replaces the older token. */
export const AGENT_VM_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** A dashboard attach code: "vm_" and 20 lowercase Crockford base32 characters, single use, 15 minutes. */
export const ATTACH_CODE = /^vm_[0-9a-hjkmnp-tv-z]{20}$/;
/**
 * The device sign-in's scope for an agent's computer: the approval page says so, and the session
 * it hands over makes only an agent-VM token (the gateway's auth.ts and access.ts).
 */
export const AGENT_VM_DEVICE_SCOPE = "agent-vm";
/** How long an agent VM's token lasts: 7 days unless asked, at most 30 (R9). */
export const AGENT_VM_DAYS = { default: 7, max: 30 } as const;

const DEFAULT_SERVER = "https://0bridge.dev";
/** Pasted into a shell by an agent: only plain words go in the command. */
const shellSafe = (s: string) => /^[A-Za-z0-9@._+:/-]+$/.test(s);

/**
 * The copyable "set up my dev environment" prompt (under 900 characters). With `attach`, the VM
 * signs in without a link to approve; with `email` instead, the account's dashboard is asked to
 * approve it. `--no-wait` keeps the agent's shell from timing out on a link nobody approved yet:
 * the command prints it and stops, and running it again picks up where it left off.
 */
export function agentVmPrompt(o: { server: string; platform?: AgentVmPlatform["id"]; attach?: string; email?: string }): string {
  const server = o.server.replace(/\/+$/, "");
  const host = (() => {
    try {
      return new URL(server).host;
    } catch {
      return server;
    }
  })();
  const flags = [
    "--agent-vm",
    o.platform && agentVmPlatform(o.platform) ? `--platform ${o.platform}` : null,
    o.attach && ATTACH_CODE.test(o.attach) ? `--attach ${o.attach}` : o.email && shellSafe(o.email) ? `--email ${o.email}` : null,
    "--no-wait",
    server !== DEFAULT_SERVER && shellSafe(server) ? `--server ${server}` : null,
  ].filter(Boolean);
  return [
    "Set up my dev environment on this computer with 0bridge (it gives you my tools, instructions and skills). In your shell, run:",
    `\`${INSTALL_COMMAND}\` (needs Node 20.12+; install Node first if it's missing)`,
    `\`0b setup ${flags.join(" ")}\``,
    ...(o.platform === "muse" ? [`If Sentinel asks to allow ${host} (or later the AI provider you use), ask me to approve it.`] : []),
    "If it prints a link to approve instead, show me that link (and the QR image if you saved one with `--qr qr.png`), wait until I say it's approved, then run the same command again. Never paste keys or tokens into this chat. Run Claude Code here with an API key from my vault through `0b exec`, not my Claude subscription; Codex can also use `codex login --device-auth`. When it's done, tell me what it set up and what it says to do next.",
  ].join("\n");
}

/** Why agent VMs use API keys rather than a Claude subscription sign-in (R10). */
export const AGENT_VM_TOS =
  "Claude Pro and Max sign-ins are only for Claude Code and Claude themselves (since 2026-02-19), so don't sign an agent on someone else's computer in with yours. Use API keys instead: keep ANTHROPIC_API_KEY or OPENAI_API_KEY in your vault and run the agent through `0b exec`, or sign Codex in with `codex login --device-auth` for a ChatGPT plan.";
