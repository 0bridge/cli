import { readFileSync } from "node:fs";
import { CloudError, type CloudClient, type Context } from "@0bridge/core";
import { cloudClient } from "./cloud.ts";
import { installService, serviceInstalled } from "./service.ts";
import { c, p, tilde } from "./ui.ts";
import { RUN_DEFAULTS, RUN_MAX, currentRuns, loadRuns, logPath, machineName, runListener, saveRuns, type LocalRun } from "./webhook-run.ts";

/**
 * `0b webhook` (round 2, D54; drive-plus §4.9): addresses other services send events to (Channel
 * Talk, GitHub, any Standard Webhooks sender), what each one does with them, and the events
 * received. Each event can run a command on one of your machines (run: the command stays on that
 * machine, in ~/.0bridge/webhooks.json, and never goes to the server), be forwarded to a URL
 * (signed), start a coding agent, notify you, or be stored for agents to read (Store, the default).
 * A routine's bearer token is typed hidden in the terminal or piped in, never given as a flag
 * (flags end up in shell history and agents' transcripts). Event data is outside input; this only
 * shows it.
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
  /** --route forward: where events go. */
  url?: string;
  /** `run`: seconds to wait for more events before running once (--debounce), and a run's limit (--timeout). */
  debounce?: string;
  timeout?: string;
  /** `run --off`: forget this machine's command for the webhook. */
  off?: boolean;
  /** `run … -- <command…>`: everything after `--`, as given (index.ts splits it off before parsing). */
  command?: string[];
}

/** Mirrors apps/gateway/src/triggers.ts. "queue" is shown as Store. */
type Route =
  | { kind: "queue" }
  | { kind: "run"; machine?: string }
  | { kind: "forward"; url: string }
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
  /** Gateways from before run routes leave it out. */
  runners?: { machine: string; online: boolean; lastSeen: number }[];
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
  route: { kind: string; ok: boolean | null; detail?: string; task?: string; machine?: string; exit?: number | null; ms?: number };
}

/** How the command asks things: hidden from the terminal, else piped in. Swapped in tests. */
export interface WebhookIo {
  /** A person at a terminal (asking makes sense). */
  interactive: boolean;
  bearer(): Promise<string | null>;
  confirm(message: string): Promise<boolean>;
  /** One of `options` (values), or null when cancelled. */
  select(message: string, options: { value: string; label: string; hint?: string }[]): Promise<string | null>;
  /** A line of text, or null when cancelled. */
  text(message: string, placeholder?: string): Promise<string | null>;
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
  get interactive() {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
  },
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
  async select(message, options) {
    const v = await p.select({ message, options });
    return p.isCancel(v) ? null : String(v);
  },
  async text(message, placeholder) {
    const v = await p.text({ message, placeholder, validate: (x) => (x?.trim() ? undefined : "required") });
    return p.isCancel(v) ? null : String(v).trim();
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

const PRESETS = ["channeltalk", "github", "generic"] as const;
/** What --route takes; "queue" still works (older scripts) and means store. */
const ROUTES = ["run", "forward", "agent", "notify", "store", "routine"] as const;
const TITLE: Record<Endpoint["preset"], string> = { channeltalk: "Channel Talk", github: "GitHub", generic: "Generic (Standard Webhooks)" };
/** The action prompt of `0b webhook add`, in the order people pick them. */
const ACTIONS: { value: (typeof ROUTES)[number]; label: string; hint: string }[] = [
  { value: "run", label: "Run a command on this machine", hint: "a script you have here; the event's JSON on its input" },
  { value: "forward", label: "Forward to a URL", hint: "a signed POST to your own server" },
  { value: "agent", label: "Start a coding agent", hint: "Claude Code, Codex or Gemini in a repo, plan mode" },
  { value: "notify", label: "Notify me", hint: "ntfy or email" },
  { value: "store", label: "Store for agents to read", hint: "nothing runs; agents read events with bridge__events_poll" },
  { value: "routine", label: "Start a Claude Code Routine", hint: "its fire URL and bearer token" },
];

const ago = (ms: number) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129_600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86_400)} days ago`;
};

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
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
          : r.kind === "run"
            ? `runs a command on ${r.machine ?? "your machine"}`
            : r.kind === "forward"
              ? `forwards to ${hostOf(r.url)}`
              : "stored for agents to read";
  return `${what}${e.notify && r.kind !== "notify" ? ", and notifies you" : ""}${e.types ? ` (only ${e.types.join(", ")})` : ""}`;
}

/** A command as one would type it: words with spaces or quotes quoted. */
export function shellLine(argv: string[]): string {
  return argv.map((a) => (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}

/**
 * A typed command line split into words, the way a shell would without expanding anything: spaces
 * separate, '…' is literal, "…" takes \" and \\, and elsewhere a backslash escapes the next
 * character (except on Windows, where it's a path separator).
 */
export function splitCommand(line: string, platform = process.platform): string[] {
  const out: string[] = [];
  let cur = "";
  let word = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && (line[i + 1] === '"' || line[i + 1] === "\\")) cur += line[++i];
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      word = true;
    } else if (ch === "\\" && platform !== "win32" && i + 1 < line.length) {
      cur += line[++i];
      word = true;
    } else if (/\s/.test(ch)) {
      if (word) out.push(cur);
      cur = "";
      word = false;
    } else {
      cur += ch;
      word = true;
    }
  }
  if (quote) throw new Error(`the command has an unclosed ${quote}`);
  if (word) out.push(cur);
  return out;
}

/** The preset's setup steps, printed once with the address. */
export function setupSteps(preset: Endpoint["preset"], url: string, name: string): string[] {
  if (preset === "channeltalk")
    return [
      "In Channel Talk: Desk → Settings → Webhook → add one.",
      `Paste ${url.split("?")[0]} and pick message.created.userChat. Save.`,
      `Channel Talk adds a token of its own to the address (?token=…). Copy the token it shows for the webhook, then: 0b webhook token ${name}`,
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

const kindName = (k: string) => (k === "queue" ? "store" : k);

function eventLine(e: StoredEvent): string {
  const k = kindName(e.route.kind);
  const route = e.route.ok === true ? c.green(k) : e.route.ok === false ? c.red(k) : c.dim(k);
  return `${c.dim(new Date(e.receivedAt).toISOString().slice(0, 19).replace("T", " "))}  ${e.endpoint}  ${c.bold(e.type)}  ${c.dim(e.eventId)}  ${route}${e.route.detail ? c.dim(` ${e.route.detail}`) : ""}${e.route.task ? c.dim(` (${e.route.task})`) : ""}`;
}

async function find(client: CloudClient, name: string | undefined, usage: string): Promise<Endpoint> {
  if (!name) throw new Error(`usage: ${usage}`);
  const list = await client.call<Endpoint[]>("GET", "/triggers");
  const e = list.find((x) => x.name === name || x.id === name);
  if (!e) throw new Error(`no webhook named ${name}${list.length ? ` (you have ${list.map((x) => x.name).join(", ")})` : ""}. See \`0b webhook list\`.`);
  return e;
}

/** The action for `add`: --route, else asked on a terminal, else store. */
async function pickRoute(opts: WebhookOptions, io: WebhookIo): Promise<string> {
  if (opts.route) return opts.route;
  if (opts.command?.length) return "run";
  if (!io.interactive) return "store";
  const v = await io.select("What should each event do?", ACTIONS);
  if (v === null) process.exit(0);
  return v;
}

/** Turn the flags (and, on a terminal, answers) into a request's route. */
async function routeFrom(kind: string, opts: WebhookOptions, io: WebhookIo): Promise<{ route?: Record<string, unknown>; routineToken?: string }> {
  if (kind === "queue") kind = "store";
  if (!(ROUTES as readonly string[]).includes(kind)) throw new Error(`--route is ${ROUTES.join(", ")}`);
  const template = opts.template ? readFileSync(opts.template, "utf8") : undefined;
  if (kind === "store") return { route: { kind: "store" } };
  if (kind === "notify") return { route: { kind, ...(template ? { template } : {}) } };
  if (kind === "run") return { route: { kind, ...(opts.machine ? { machine: opts.machine } : {}) } };
  if (kind === "forward") {
    const url = opts.url ?? (io.interactive ? await io.text("The URL to forward events to (https)", "https://…") : null);
    if (!url) throw new Error("--route forward needs --url <https address> (events are POSTed there, signed with the webhook's forward secret)");
    return { route: { kind, url } };
  }
  if (kind === "routine") {
    if (!opts.routineUrl) throw new Error("--route routine needs --routine-url <the routine's fire URL> (its bearer token is asked for, or piped in)");
    const token = await io.bearer();
    if (!token) throw new Error("the routine's bearer token is needed: type it when asked, or pipe it in (`… | 0b webhook add …`); it's never a flag");
    return { route: { kind, url: opts.routineUrl, ...(template ? { template } : {}) }, routineToken: token };
  }
  const repo = opts.repo ?? (io.interactive && !opts.route ? await io.text("Which repo (its name, like acme/web, or its path; allowed with `0b agent allow`)") : null);
  if (!repo) throw new Error("--route agent needs --repo <name or path> (a repo you allowed with `0b agent allow`)");
  const mode = opts.mode ?? "plan";
  if (mode !== "plan" && mode !== "edit") throw new Error("--mode is plan or edit (webhooks never start agents in auto mode)");
  return { route: { kind, repo, mode, ...(opts.agent ? { agent: opts.agent } : {}), ...(opts.machine ? { machine: opts.machine } : {}), ...(template ? { template } : {}) } };
}

/** --timeout and --debounce: whole seconds in range, else the default. */
function seconds(raw: string | undefined, flag: string, min: number, max: number, dflt: number): number {
  if (raw === undefined) return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${flag} is ${min} to ${max} seconds`);
  return n;
}

/** Print the forward secret once, with how a receiver checks it. */
function showForwardSecret(secret: string) {
  console.log(`  Forward secret: ${secret}`);
  console.log(c.dim("  Shown only now. Each POST carries webhook-id, webhook-timestamp and webhook-signature (Standard Webhooks); check them with this secret."));
}

/** Save this machine's command for `name` and make sure the runner service is on. */
function saveCommand(ctx: Context, server: string, userId: string, name: string, argv: string[], opts: WebhookOptions): LocalRun {
  const timeoutSec = seconds(opts.timeout, "--timeout", 1, RUN_MAX.timeoutSec, RUN_DEFAULTS.timeoutSec);
  const debounceSec = seconds(opts.debounce, "--debounce", 0, RUN_MAX.debounceSec, RUN_DEFAULTS.debounceSec);
  const f = loadRuns(ctx);
  // A file for another account: its commands don't apply here, and are dropped.
  const runs = f && f.userId === userId && f.server.replace(/\/+$/, "") === server ? f.runs : {};
  if (f && runs !== f.runs && Object.keys(f.runs).length) console.log(c.dim(`  (commands saved here for another 0bridge account were removed)`));
  if (!runs[name] && Object.keys(runs).length >= RUN_MAX.hooks) throw new Error(`at most ${RUN_MAX.hooks} webhook commands per machine`);
  const run: LocalRun = { argv, cwd: process.cwd(), timeoutSec, debounceSec, addedAt: Date.now() };
  saveRuns(ctx, { v: 1, server, userId, runs: { ...runs, [name]: run } });
  return run;
}

function ensureListener(ctx: Context): string {
  return installService(ctx, "webhook", ["webhook", "listen"], { keepAlive: true });
}

/** After a test event on a run route: wait for its result (the runner reports it), up to `ms`. */
async function awaitRun(client: CloudClient, ev: StoredEvent, io: WebhookIo, ms: number): Promise<StoredEvent> {
  let cur = ev;
  for (const end = Date.now() + ms; cur.route.kind === "run" && cur.route.ok === null && Date.now() < end; ) {
    await io.sleep(1000);
    cur = await client.call<StoredEvent>("GET", `/triggers/events/${encodeURIComponent(ev.id)}`);
  }
  return cur;
}

function showRoute(r: StoredEvent["route"], server: string) {
  const mark = r.ok === true ? c.green("✓") : r.ok === false ? c.red("✗") : c.yellow("…");
  console.log(`${mark} route ${kindName(r.kind)}: ${r.detail ?? (r.ok ? "done" : "pending")}${r.task ? ` · task ${r.task}: ${server}/app/machines/tasks/${r.task}` : ""}`);
}

export async function webhookCommand(ctx: Context, args: string[], opts: WebhookOptions, io: WebhookIo = TTY_IO): Promise<void> {
  const [sub = "list", name] = args;
  const { cfg, client } = cloudClient(ctx);
  const server = cfg.server.replace(/\/+$/, "");

  /** Test a run route and wait for this machine's (or another's) result. */
  const testRun = async (e: Endpoint, waitMs: number) => {
    const ev = await client.call<StoredEvent>("POST", `/triggers/${encodeURIComponent(e.id)}/test`, {});
    console.log(`${c.green("✓")} a signed test event reached ${e.name} (${ev.type}, ${ev.eventId})`);
    showRoute((await awaitRun(client, ev, io, waitMs)).route, server);
  };

  switch (sub) {
    case "list":
    case "ls": {
      const list = await client.call<Endpoint[]>("GET", "/triggers");
      if (opts.json) return console.log(JSON.stringify(list, null, 2));
      if (!list.length) {
        console.log("No webhooks yet. Make one: 0b webhook add <name> --preset channeltalk|github|generic");
        return;
      }
      const here = currentRuns(ctx);
      for (const e of list) {
        console.log(`${e.enabled ? c.green("●") : c.dim("○")} ${c.bold(e.name)}  ${c.dim(TITLE[e.preset])}  ${routeText(e)}`);
        console.log(`    ${e.url}  ·  ${e.counts.today} today, ${e.counts.total} in all${e.lastEventAt ? ` · last ${ago(e.lastEventAt)}` : ""}`);
        const mine = here[e.name];
        if (mine) console.log(`    runs here: ${shellLine(mine.argv)} ${c.dim(`(in ${tilde(ctx, mine.cwd)})`)}`);
        const others = (e.runners ?? []).filter((r) => !mine || r.machine.toLowerCase() !== machineName().toLowerCase());
        if (others.length) console.log(c.dim(`    machines with a command: ${others.map((r) => `${r.machine} (${r.online ? "online" : `last seen ${ago(r.lastSeen)}`})`).join(", ")}`));
        if (e.route.kind === "run" && !mine && !e.runners?.length) console.log(`    ${c.yellow("!")} no machine has a command for it yet: 0b webhook run ${e.name} -- <command>`);
        if (e.lastError) console.log(`    ${c.yellow("!")} ${e.lastError}`);
      }
      return;
    }

    case "add": {
      if (!name) throw new Error("usage: 0b webhook add <name> [--preset channeltalk|github|generic] [--route run|forward|agent|notify|store|routine] …");
      const preset = opts.preset ?? "generic";
      if (!(PRESETS as readonly string[]).includes(preset)) throw new Error(`--preset is ${PRESETS.join(", ")}`);
      const kind = await pickRoute(opts, io);
      // Run: the command is asked for now (on a terminal) and kept on this machine, never sent.
      let argv = kind === "run" ? opts.command : undefined;
      if (kind === "run" && !argv?.length && io.interactive) {
        const line = await io.text(`The command to run here for each event (in ${tilde(ctx, process.cwd())}; the event's JSON comes on its input)`, "python3 sync.py");
        if (line === null) process.exit(0);
        argv = splitCommand(line);
      }
      const { route, routineToken } = await routeFrom(kind, opts, io);
      let r: { endpoint: Endpoint; secret: string; url: string; forwardSecret?: string };
      try {
        r = await client.call("POST", "/triggers", { name, preset, ...(route && route.kind !== "store" ? { route } : {}), ...(routineToken ? { routineToken } : {}), ...(opts.notify ? { notify: true } : {}) });
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
      if (r.forwardSecret) showForwardSecret(r.forwardSecret);
      if (r.endpoint.route.kind === "agent")
        console.log(c.dim(`  Webhook data is outside input: agents start in ${r.endpoint.route.mode} mode, at most once per ${Math.round(r.endpoint.route.cooldownSec / 60)} min and 20 times a day.`));
      if (r.endpoint.route.kind === "run") {
        if (argv?.length) {
          const run = saveCommand(ctx, server, cfg.userId, r.endpoint.name, argv, opts);
          const where = ensureListener(ctx);
          console.log(`  Runs here: ${shellLine(run.argv)} ${c.dim(`(in ${tilde(ctx, run.cwd)}, ${run.timeoutSec} s timeout${run.debounceSec ? `, ${run.debounceSec} s debounce` : ""})`)}`);
          console.log(c.dim(`  The command stays on this machine. ${where ? `This machine stays connected for it (service: ${where}).` : "Keep `0b webhook listen` running."} Output: ${tilde(ctx, logPath(ctx, r.endpoint.name))}`));
        } else console.log(`  Now, on the machine that runs it: ${c.cyan(`0b webhook run ${r.endpoint.name} -- <command>`)}`);
      }
      return;
    }

    case "run": {
      if (!name) throw new Error("usage: 0b webhook run <name> [--debounce 30] [--timeout 300] [--machine <m>] -- <command…>  (or --off)");
      if (opts.off) {
        const f = loadRuns(ctx);
        if (!f?.runs[name]) return console.log(`No command for ${name} on this machine.`);
        const { [name]: _gone, ...rest } = f.runs;
        saveRuns(ctx, { ...f, runs: rest });
        console.log(`${c.green("✓")} ${name} no longer runs a command on this machine.`);
        if (!Object.keys(rest).length && serviceInstalled(ctx, "webhook")) {
          installService(ctx, "webhook", null, {});
          console.log(c.dim("  No commands left here, so this machine stopped listening for webhook runs."));
        }
        console.log(c.dim(`  Its route is unchanged: other machines with a command still run it. To store events instead: 0b webhook set ${name} --route store`));
        return;
      }
      const argv = opts.command ?? [];
      if (!argv.length) {
        const mine = currentRuns(ctx)[name];
        if (mine) return console.log(`${name} runs here: ${shellLine(mine.argv)} ${c.dim(`(in ${tilde(ctx, mine.cwd)}, ${mine.timeoutSec} s timeout${mine.debounceSec ? `, ${mine.debounceSec} s debounce` : ""})`)}`);
        throw new Error(`usage: 0b webhook run ${name} -- <command…>  (the command after --, e.g. 0b webhook run ${name} -- python3 sync.py)`);
      }
      const e = await find(client, name, "0b webhook run <name> -- <command…>");
      const run = saveCommand(ctx, server, cfg.userId, e.name, argv, opts);
      let routed = e.route.kind === "run" && (!opts.machine || e.route.machine === opts.machine);
      if (!routed) {
        const replacing = e.route.kind !== "queue" && e.route.kind !== "run";
        if (!replacing || opts.yes || (await io.confirm(`${e.name} ${routeText(e)} now. Run this command for its events instead?`))) {
          await client.call("PATCH", `/triggers/${encodeURIComponent(e.id)}`, { route: { kind: "run", ...(opts.machine ? { machine: opts.machine } : {}) } });
          routed = true;
        }
      }
      const where = ensureListener(ctx);
      console.log(`${c.green("✓")} ${e.name} runs ${c.bold(shellLine(run.argv))} on this machine for each event ${c.dim(`(in ${tilde(ctx, run.cwd)})`)}`);
      console.log(c.dim(`  Event JSON on its input; ZEROBRIDGE_EVENT_ID, ZEROBRIDGE_EVENT_TYPE and ZEROBRIDGE_HOOK in its environment. Timeout ${run.timeoutSec} s${run.debounceSec ? `; events within ${run.debounceSec} s run once, with the newest` : ""}.`));
      console.log(c.dim(`  The command stays here, never on the server. Output: ${tilde(ctx, logPath(ctx, e.name))}`));
      console.log(c.dim(`  ${where ? `This machine stays connected for it (service: ${where}).` : "Keep `0b webhook listen` running for it."}`));
      if (!routed) console.log(`  ${c.yellow("!")} ${e.name} still ${routeText(e)}; switch it with: 0b webhook set ${e.name} --route run`);
      if (routed && io.interactive && !opts.yes && (await io.confirm("Send a test event now?"))) await testRun(e, (run.timeoutSec + run.debounceSec + 15) * 1000);
      return;
    }

    case "listen": {
      const arg = args[1];
      if (arg === "on") {
        const where = ensureListener(ctx);
        return console.log(where ? `${c.green("✓")} this machine stays connected for webhook runs (service: ${where})` : "");
      }
      if (arg === "off") {
        installService(ctx, "webhook", null, {});
        return console.log(`${c.green("✓")} this machine no longer listens for webhook runs (its commands stay saved; \`0b webhook listen on\` resumes)`);
      }
      if (arg !== undefined) throw new Error("usage: 0b webhook listen [on|off]");
      return runListener(ctx);
    }

    case "set": {
      const e = await find(client, name, "0b webhook set <name> --route run|forward|agent|notify|store|routine …");
      if (!opts.route && opts.notify === undefined) throw new Error("say what to change: --route run|forward|agent|notify|store|routine (with its options), or --notify");
      const body: Record<string, unknown> = {};
      if (opts.route) Object.assign(body, await routeFrom(opts.route, opts, io));
      if (opts.notify !== undefined) body.notify = opts.notify;
      let updated: Endpoint & { forwardSecret?: string };
      try {
        updated = await client.call("PATCH", `/triggers/${encodeURIComponent(e.id)}`, body);
      } catch (err) {
        if (err instanceof CloudError && err.code === "STEP_UP_REQUIRED") throw new Error(`edit mode is set on the dashboard (with your passkey): ${server}/app/triggers/${e.id}`);
        throw err;
      }
      if (opts.json) return console.log(JSON.stringify(updated, null, 2));
      console.log(`${c.green("✓")} ${updated.name}: ${routeText(updated)}`);
      if (updated.forwardSecret) showForwardSecret(updated.forwardSecret);
      if (updated.route.kind === "run" && !currentRuns(ctx)[updated.name] && !updated.runners?.length) console.log(`  Now, on the machine that runs it: ${c.cyan(`0b webhook run ${updated.name} -- <command>`)}`);
      return;
    }

    case "forward-secret": {
      const e = await find(client, name, "0b webhook forward-secret <name>");
      const r = await client.call<{ secret: string }>("POST", `/triggers/${encodeURIComponent(e.id)}/forward-secret`, {});
      if (opts.json) return console.log(JSON.stringify(r, null, 2));
      console.log(`${c.green("✓")} ${e.name} signs forwards with a new secret; the old one stopped working.`);
      showForwardSecret(r.secret);
      return;
    }

    case "rm":
    case "remove":
    case "delete": {
      const e = await find(client, name, "0b webhook rm <name>");
      if (!opts.yes && !(await io.confirm(`Delete the webhook ${e.name} and its events? Senders using its address get 404 from now on.`))) return;
      await client.call("DELETE", `/triggers/${encodeURIComponent(e.id)}`);
      const f = loadRuns(ctx);
      if (f?.runs[e.name]) {
        const { [e.name]: _gone, ...rest } = f.runs;
        saveRuns(ctx, { ...f, runs: rest });
      }
      console.log(`${c.green("✓")} deleted ${e.name}`);
      return;
    }

    case "token": {
      // The sender's own token (Channel Talk makes one per webhook): typed hidden, or one line on stdin.
      const e = await find(client, name, "0b webhook token <name>");
      let secret: string;
      if (process.stdin.isTTY) {
        const v = await p.password({ message: `The token ${TITLE[e.preset] ?? "the sender"} shows for this webhook`, mask: "•", validate: (x) => (x?.trim() ? undefined : "required") });
        if (p.isCancel(v)) process.exit(0);
        secret = String(v).trim();
      } else secret = readFileSync(0, "utf8").trim();
      const r = await client.call<{ url: string }>("POST", `/triggers/${encodeURIComponent(e.id)}/secret`, { secret });
      if (opts.json) return console.log(JSON.stringify(r, null, 2));
      console.log(`${c.green("✓")} ${e.name} now checks deliveries against ${TITLE[e.preset] ?? "the sender"}'s token; 0bridge's own stopped working.`);
      console.log(c.dim(`  Address: ${r.url} (the sender adds ?token=… itself). Try it by sending a real message, then: 0b webhook events ${e.name}`));
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
      const sent = await client.call<StoredEvent>("POST", `/triggers/${encodeURIComponent(e.id)}/test`, {});
      // A run is reported by the machine that runs it: wait a little for it (the event keeps the result either way).
      const mine = currentRuns(ctx)[e.name];
      const ev = sent.route.kind === "run" && sent.route.ok === null ? await awaitRun(client, sent, io, mine ? (mine.timeoutSec + mine.debounceSec + 15) * 1000 : 30_000) : sent;
      if (opts.json) return console.log(JSON.stringify(ev, null, 2));
      console.log(`${c.green("✓")} a signed test event reached ${e.name} (${ev.type}, ${ev.eventId})`);
      showRoute(ev.route, server);
      if (ev.route.kind === "run" && ev.route.ok === null) console.log(c.dim(`  It runs when a machine with a command for ${e.name} is online; see it with: 0b webhook events ${e.name}`));
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
      throw new Error(`unknown subcommand "${sub}". 0b webhook add | run | listen | set | token | forward-secret | list | rm | test | rotate | events`);
  }
}
