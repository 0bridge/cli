import type { Context } from "@0bridge/core";
import { cloudClient } from "./cloud.ts";
import { c } from "./ui.ts";

/**
 * `0b settings`: what the account lets AI apps do (GET /settings), and `0b settings off <name>` to
 * turn agent control, chat-app webhook events or chat-app history off from here, an agent's
 * terminal included. Turning one on needs the dashboard and a passkey (the gateway's D28), so
 * `on` only says where.
 */

/** Mirrors apps/gateway/src/settings.ts (the fields shown here). */
export interface AccountSettings {
  chatHistory: boolean;
  memory: boolean;
  profileInInstructions: boolean;
  agentControl: boolean;
  chatEvents: boolean;
}

type Guarded = "agentControl" | "chatEvents" | "chatHistory";

/** The names `0b settings off` takes (bridge__settings_off uses the same), and what each lets AI apps do. */
export const SWITCHES: { name: string; key: Guarded; what: string }[] = [
  { name: "agent-control", key: "agentControl", what: "AI apps start and steer coding agents on your machines" },
  { name: "chat-events", key: "chatEvents", what: "Chat apps read your webhooks' events" },
  { name: "chat-history", key: "chatHistory", what: "Chat apps search and resume your conversation history" },
];

const dashboard = (server: string) => `${server.replace(/\/+$/, "")}/app/settings/apps`;
const state = (on: boolean) => (on ? c.green("on ") : c.dim("off"));

function fail(msg: string): never {
  console.error(c.red(`error: ${msg}`));
  process.exit(1);
}

/** What `0b settings` prints. Pure, for tests. */
export function renderSettings(s: AccountSettings, server: string): string {
  const width = Math.max(...SWITCHES.map((w) => w.name.length), "profile-in-chat-apps".length);
  const line = (name: string, on: boolean, what: string) => `  ${name.padEnd(width)}  ${state(on)}  ${c.dim(what)}`;
  return [
    "What your AI apps may do with this 0bridge account:",
    ...SWITCHES.map((w) => line(w.name, s[w.key], w.what)),
    line("memory", s.memory, "Any AI saves and reads what you asked it to remember"),
    line("profile-in-chat-apps", s.profileInInstructions, "Chat apps get the start of your profile"),
    "",
    c.dim(`Turn one off: ${c.cyan("0b settings off <name>")}. Turning on, and the rest: ${dashboard(server)} (asks for your passkey).`),
  ].join("\n");
}

/** The switches named on the command line, or why not. */
export function parseSwitches(names: string[]): Guarded[] | string {
  if (!names.length) return `name one: ${SWITCHES.map((w) => w.name).join(", ")}`;
  const keys: Guarded[] = [];
  for (const n of names) {
    const w = SWITCHES.find((x) => x.name === n.trim().toLowerCase());
    if (!w) return `unknown setting "${n}": ${SWITCHES.map((x) => x.name).join(", ")} (memory and the rest are on the dashboard)`;
    if (!keys.includes(w.key)) keys.push(w.key);
  }
  return keys;
}

export async function settingsCommand(ctx: Context, args: string[], opts: { json?: boolean } = {}): Promise<void> {
  const [sub, ...names] = args;
  switch (sub) {
    case undefined:
    case "show": {
      const { cfg, client } = cloudClient(ctx);
      const s = await client.call<AccountSettings>("GET", "/settings");
      if (opts.json) return console.log(JSON.stringify(s, null, 2));
      return console.log(renderSettings(s, cfg.server));
    }
    case "off": {
      const keys = parseSwitches(names);
      if (typeof keys === "string") fail(keys);
      const { client } = cloudClient(ctx);
      const s = await client.call<AccountSettings>("PATCH", "/settings", Object.fromEntries(keys.map((k) => [k, false])));
      if (opts.json) return console.log(JSON.stringify(s, null, 2));
      for (const k of keys) console.log(`${c.green("✓")} ${SWITCHES.find((w) => w.key === k)!.name} is off`);
      console.log(c.dim("An app that's open may keep its tool list until you refresh 0bridge in it and start a new chat; the turned-off tools are refused meanwhile."));
      return;
    }
    case "on": {
      const keys = parseSwitches(names);
      if (typeof keys === "string") fail(keys);
      // The server refuses this without the dashboard's passkey check: say where instead of asking.
      const { cfg } = cloudClient(ctx);
      console.log(`Turning ${keys.map((k) => SWITCHES.find((w) => w.key === k)!.name).join(", ")} on asks for your passkey, on the dashboard: ${c.cyan(dashboard(cfg.server))}`);
      return;
    }
    default:
      fail(`unknown subcommand "settings ${sub}". Try: 0b settings, 0b settings off <${SWITCHES.map((w) => w.name).join("|")}>`);
  }
}
