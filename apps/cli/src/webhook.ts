import { readFileSync } from "node:fs";
import { CloudError, type CloudClient, type Context } from "@0bridge/core";
import { cloudClient } from "./cloud.ts";
import { c, p } from "./ui.ts";

/**
 * `0b webhook` (round 2, D54): addresses other services send events to (Channel Talk, GitHub, any
 * Standard Webhooks sender), what each one does with them, and the events received. A routine's
 * bearer token is typed hidden in the terminal or piped in, never given as a flag (flags end up in
 * shell history and agents' transcripts). Event data is outside input; this only shows it.
 */

export interface WebhookOptions {
  preset?: string;
  route?: string;
  repo?: string;
  agent?: string;
  machine?: string;
  mode?: string;
  template?: string;
  routineUrl?: string;
  notify?: boolean;
  follow?: boolean;
  json?: boolean;
  yes?: boolean;
}

/** Mirrors apps/gateway/src/triggers.ts. */
type Route =
  | { kind: "queue" }
  | { kind: "agent"; repo: string; agent?: string; machine?: string; mode: "plan" | "edit"; template: string; cooldownSec: number }
  | { kind: "routine"; url: string; template: string }
  | { kind: "notify"; template: string };

export interface Endpoint {
  id: string;
  name: string;
  preset: "channeltalk" | "github" | "generic";
  verify: { mode: string; header?: string; param?: string };
  route: Route;
  notify: boolean;
  types: string[] | null;
  retentionDays: number;
  enabled: boolean;
  url: string;
  createdAt: number;
  updatedAt: number;
  lastEventAt: number | null;
  counts: { today: number; total: number };
  lastError: string | null;
}

export interface StoredEvent {
  id: string;
  seq: number;
  endpoint: string;
  eventId: string;
  type: string;
  receivedAt: number;
  verified: boolean;
  size: number;
  data: unknown;
  route: { kind: string; ok: boolean | null; detail?: string; task?: string };
}

/** How the command gets a routine's bearer: hidden from the terminal, else piped in. Swapped in tests. */
export interface WebhookIo {
  bearer(): Promise<string | null>;
  confirm(message: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
}

/** Piped-in text, or "" when nothing is (an agent's closed or empty stdin). */
function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

const TTY_IO: WebhookIo = {
  async bearer() {
    if (!process.stdin.isTTY) return readStdin().trim() || null;
    const v = await p.password({ message: "The routine's bearer token (from its API trigger on claude.ai/code/routines)", mask: "•", validate: (x) => (x?.trim() ? undefined : "required") });
    if (p.isCancel(v)) process.exit(0);
    return String(v).trim();
  },
  async confirm(message) {
    if (!process.stdin.isTTY) return true;
    const v = await p.confirm({ message });
    return v === true;
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

const PRESETS = ["channeltalk", "github", "generic"] as const;
const ROUTES = ["queue", "agent", "routine", "notify"] as const;
const TITLE: Record<Endpoint["preset"], string> = { channeltalk: "Channel Talk", github: "GitHub", generic: "Generic (Standard Webhooks)" };

const ago = (ms: number) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129_600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86_400)} days ago`;
};

/** What an endpoint does with an event, in a few words. */
export function routeText(e: Pick<Endpoint, "route" | "notify" | "types">): string {
  const r = e.route;
  const what =
    r.kind === "agent"
      ? `starts ${r.agent ?? "an agent"} in ${r.repo} (${r.mode}${r.machine ? `, on ${r.machine}` : ""}, ${Math.round(r.cooldownSec / 60)} min cooldown)`
      : r.kind === "routine"
        ? `starts a Claude Code Routine`
        : r.kind === "notify"
          ? "notifies you"
          : "kept for agents to read";
  return `${what}${e.notify && r.kind !== "notify" ? ", and notifies you" : ""}${e.types ? ` (only ${e.types.join(", ")})` : ""}`;
}

/** The preset's setup steps, printed once with the address. */
export function setupSteps(preset: Endpoint["preset"], url: string, name: string): string[] {
  if (preset === "channeltalk")
    return [
      "In Channel Talk: Desk → Settings → Webhook → add one.",
      `Paste the URL above (it carries its token: ?token=…), and pick message.created.userChat.`,
      "Channel Talk blocks a webhook after 100 failed deliveries in a row; 0bridge answers every stored event at once.",
    ];
  if (preset === "github")
    return [
      "In GitHub: the repo (or org) → Settings → Webhooks → Add webhook.",
      `Payload URL: ${url}`,
      "Content type: application/json. Secret: the secret above. Pick the events you want.",
    ];
  return [
    "Give the sender the URL and the signing secret (Standard Webhooks: webhook-id, webhook-timestamp, webhook-signature).",
    `Try it: 0b webhook test ${name}`,
  ];
}

function eventLine(e: StoredEvent): string {
  const route = e.route.ok === true ? c.green(e.route.kind) : e.route.ok === false ? c.red(e.route.kind) : c.dim(e.route.kind);
  return `${c.dim(new Date(e.receivedAt).toISOString().slice(0, 19).replace("T", " "))}  ${e.endpoint}  ${c.bold(e.type)}  ${c.dim(e.eventId)}  ${route}${e.route.detail ? c.dim(` ${e.route.detail}`) : ""}${e.route.task ? c.dim(` (${e.route.task})`) : ""}`;
}

async function find(client: CloudClient, name: string | undefined, usage: string): Promise<Endpoint> {
  if (!name) throw new Error(`usage: ${usage}`);
  const list = await client.call<Endpoint[]>("GET", "/triggers");
  const e = list.find((x) => x.name === name || x.id === name);
  if (!e) throw new Error(`no webhook named ${name}${list.length ? ` (you have ${list.map((x) => x.name).join(", ")})` : ""}. See \`0b webhook list\`.`);
  return e;
}

/** Turn the flags into the create body's route. */
async function routeFrom(opts: WebhookOptions, io: WebhookIo): Promise<{ route?: Record<string, unknown>; routineToken?: string }> {
  const kind = opts.route ?? "queue";
  if (!(ROUTES as readonly string[]).includes(kind)) throw new Error(`--route is ${ROUTES.join(", ")}`);
  const template = opts.template ? readFileSync(opts.template, "utf8") : undefined;
  if (kind === "queue") return {};
  if (kind === "notify") return { route: { kind, ...(template ? { template } : {}) } };
  if (kind === "routine") {
    if (!opts.routineUrl) throw new Error("--route routine needs --routine-url <the routine's fire URL> (its bearer token is asked for, or piped in)");
    const token = await io.bearer();
    if (!token) throw new Error("the routine's bearer token is needed: type it when asked, or pipe it in (`… | 0b webhook add …`); it's never a flag");
    return { route: { kind, url: opts.routineUrl, ...(template ? { template } : {}) }, routineToken: token };
  }
  if (!opts.repo) throw new Error("--route agent needs --repo <name or path> (a repo you allowed with `0b agent allow`)");
  const mode = opts.mode ?? "plan";
  if (mode !== "plan" && mode !== "edit") throw new Error("--mode is plan or edit (webhooks never start agents in auto mode)");
  return { route: { kind, repo: opts.repo, mode, ...(opts.agent ? { agent: opts.agent } : {}), ...(opts.machine ? { machine: opts.machine } : {}), ...(template ? { template } : {}) } };
}

export async function webhookCommand(ctx: Context, args: string[], opts: WebhookOptions, io: WebhookIo = TTY_IO): Promise<void> {
  const [sub = "list", name] = args;
  const { cfg, client } = cloudClient(ctx);
  const server = cfg.server.replace(/\/+$/, "");

  switch (sub) {
    case "list":
    case "ls": {
      const list = await client.call<Endpoint[]>("GET", "/triggers");
      if (opts.json) return console.log(JSON.stringify(list, null, 2));
      if (!list.length) {
        console.log("No webhooks yet. Make one: 0b webhook add <name> --preset channeltalk|github|generic");
        return;
      }
      for (const e of list) {
        console.log(`${e.enabled ? c.green("●") : c.dim("○")} ${c.bold(e.name)}  ${c.dim(TITLE[e.preset])}  ${routeText(e)}`);
        console.log(`    ${e.url}  ·  ${e.counts.today} today, ${e.counts.total} in all${e.lastEventAt ? ` · last ${ago(e.lastEventAt)}` : ""}`);
        if (e.lastError) console.log(`    ${c.yellow("!")} ${e.lastError}`);
      }
      return;
    }

    case "add": {
      if (!name) throw new Error("usage: 0b webhook add <name> [--preset channeltalk|github|generic] [--route queue|agent|routine|notify] …");
      const preset = opts.preset ?? "generic";
      if (!(PRESETS as readonly string[]).includes(preset)) throw new Error(`--preset is ${PRESETS.join(", ")}`);
      const { route, routineToken } = await routeFrom(opts, io);
      let r: { endpoint: Endpoint; secret: string; url: string };
      try {
        r = await client.call("POST", "/triggers", { name, preset, ...(route ? { route } : {}), ...(routineToken ? { routineToken } : {}), ...(opts.notify ? { notify: true } : {}) });
      } catch (e) {
        if (e instanceof CloudError && e.code === "STEP_UP_REQUIRED")
          throw new Error(`letting a webhook start agents in edit mode is set on the dashboard (with your passkey): add it here in plan mode, then switch it at ${server}/app/triggers`);
        throw e;
      }
      if (opts.json) return console.log(JSON.stringify(r, null, 2));
      console.log(`${c.green("✓")} ${c.bold(r.endpoint.name)}: ${routeText(r.endpoint)}`);
      console.log(`  URL:     ${r.url}`);
      if (r.endpoint.verify.mode !== "query") console.log(`  Secret:  ${r.secret}`);
      console.log(c.dim(`  ${r.endpoint.verify.mode === "query" ? "The URL holds the secret" : "The secret is shown"} only now; \`0b webhook rotate ${r.endpoint.name}\` makes a new one.`));
      for (const s of setupSteps(r.endpoint.preset, r.url, r.endpoint.name)) console.log(`  · ${s}`);
      if (r.endpoint.route.kind === "agent")
        console.log(c.dim(`  Webhook data is outside input: agents start in ${r.endpoint.route.mode} mode, at most once per ${Math.round(r.endpoint.route.cooldownSec / 60)} min and 20 times a day.`));
      return;
    }

    case "rm":
    case "remove":
    case "delete": {
      const e = await find(client, name, "0b webhook rm <name>");
      if (!opts.yes && !(await io.confirm(`Delete the webhook ${e.name} and its events? Senders using its address get 404 from now on.`))) return;
      await client.call("DELETE", `/triggers/${encodeURIComponent(e.id)}`);
      console.log(`${c.green("✓")} deleted ${e.name}`);
      return;
    }

    case "rotate": {
      const e = await find(client, name, "0b webhook rotate <name>");
      const r = await client.call<{ secret: string; url: string }>("POST", `/triggers/${encodeURIComponent(e.id)}/rotate`, {});
      if (opts.json) return console.log(JSON.stringify(r, null, 2));
      console.log(`${c.green("✓")} ${e.name} has a new secret; the old one stopped working.`);
      console.log(`  URL:     ${r.url}`);
      if (e.verify.mode !== "query") console.log(`  Secret:  ${r.secret}`);
      console.log(c.dim(`  Update it where ${TITLE[e.preset]} sends from.`));
      return;
    }

    case "test": {
      const e = await find(client, name, "0b webhook test <name>");
      const ev = await client.call<StoredEvent>("POST", `/triggers/${encodeURIComponent(e.id)}/test`, {});
      if (opts.json) return console.log(JSON.stringify(ev, null, 2));
      console.log(`${c.green("✓")} a signed test event reached ${e.name} (${ev.type}, ${ev.eventId})`);
      const r = ev.route;
      const mark = r.ok === true ? c.green("✓") : r.ok === false ? c.red("✗") : c.yellow("…");
      console.log(`${mark} route ${r.kind}: ${r.detail ?? (r.ok ? "done" : "pending")}${r.task ? ` · task ${r.task}: ${server}/app/machines/tasks/${r.task}` : ""}`);
      return;
    }

    case "events": {
      const q = (cursor?: string) => {
        const s = new URLSearchParams({ limit: "50" });
        if (name) s.set("endpoint", name);
        if (cursor) s.set("cursor", cursor);
        return `/triggers/events?${s}`;
      };
      if (name) await find(client, name, "0b webhook events [name]");
      let r = await client.call<{ events: StoredEvent[]; cursor: string; hasMore: boolean }>("GET", q());
      const show = (evs: StoredEvent[]) => {
        for (const e of evs) {
          if (opts.json) console.log(JSON.stringify(e));
          else {
            console.log(eventLine(e));
            console.log(c.dim(`    ${JSON.stringify(e.data).slice(0, 300)}`));
          }
        }
      };
      if (!r.events.length && !opts.follow && !opts.json) console.log(`No events yet${name ? ` for ${name}` : ""}. Send one: 0b webhook test ${name ?? "<name>"}`);
      show(r.events);
      if (!opts.follow) return;
      if (!opts.json) console.log(c.dim("Waiting for events (Ctrl-C to stop)…"));
      for (;;) {
        await io.sleep(3000);
        r = await client.call("GET", q(r.cursor));
        show(r.events);
      }
    }

    default:
      throw new Error(`unknown subcommand "${sub}". 0b webhook add | list | rm | test | rotate | events`);
  }
}
