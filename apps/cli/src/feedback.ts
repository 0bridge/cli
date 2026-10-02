import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { arch, platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { accountName, loadCloud, redact, shellSplit, type Context } from "@0bridge/core";
import { cloudClient } from "./cloud.ts";
import { statusDir, syncDir } from "./hook.ts";
import { vaultValues } from "./vault.ts";
import { c, tilde } from "./ui.ts";

/**
 * `0b feedback [message]`: send the 0bridge team a report (the gateway's POST /api/feedback, the
 * same place the dashboard's Feedback button and agents' bridge__feedback send to). Without a
 * message it opens $EDITOR, or asks. --include-logs adds the last lines of 0b's own logs on this
 * machine. Values from the vault and key-shaped text are masked here first (and again on the
 * server); the whole report is shown, and nothing goes until the user says yes (--yes: an agent,
 * after the user did).
 */

export interface FeedbackOptions {
  kind?: string;
  includeLogs?: boolean;
  yes?: boolean;
}

export const KINDS = ["problem", "idea", "other"] as const;
/** The gateway's limits (apps/gateway/src/feedback.ts). */
const MAX_MESSAGE = 8000;
const MAX_LOGS = 20_000;
/** Lines from the end of each log. */
const LOG_LINES = 40;

/** 0b's logs on this machine: the background jobs' (service.ts) and the hook workers'. */
export function logFiles(ctx: Context): string[] {
  return [
    ...["background", "agent", "clip", "clipsync"].map((n) => join(ctx.storeDir, `${n}.log`)),
    join(syncDir(ctx), "worker.log"),
    join(statusDir(ctx), "worker.log"),
  ];
}

/** The last `n` lines of a file, reading at most its last 64 KB. */
export function tail(path: string, n: number): string {
  const size = statSync(path).size;
  const len = Math.min(size, 65_536);
  const buf = Buffer.alloc(len);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, len, size - len);
  } finally {
    closeSync(fd);
  }
  const lines = buf.toString("utf8").split("\n");
  if (len < size) lines.shift(); // started mid-line
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  return lines.slice(-n).join("\n");
}

/**
 * The logs part of a report: each log's last lines under its name, with the vault's values and
 * key-shaped text masked and the home folder shortened to ~. The newest lines win when it's too long.
 */
export function collectLogs(ctx: Context, values: string[], lines = LOG_LINES): string {
  const parts: string[] = [];
  for (const path of logFiles(ctx)) {
    if (!existsSync(path)) continue;
    const text = tail(path, lines);
    if (text.trim()) parts.push(`== ${tilde(ctx, path)} ==\n${text}`);
  }
  let out = tilde(ctx, redact(parts.join("\n\n"), values));
  if (out.length > MAX_LOGS) out = out.slice(out.indexOf("\n", out.length - MAX_LOGS) + 1);
  return out;
}

/** What was written in the editor: everything but the # lines, trimmed. */
export const fromEditor = (text: string) =>
  text
    .split("\n")
    .filter((l) => !l.startsWith("#"))
    .join("\n")
    .trim();

const TEMPLATE = (kind: string) => `
# Write your feedback above. What happened, what you expected and the steps
# to get there help most. Lines starting with # are left out.
# Kind: ${kind} (--kind problem|idea|other). Nothing is sent until you confirm.
`;

/** Open $VISUAL / $EDITOR on a template; what the user wrote, or "" when they wrote nothing. */
function editMessage(kind: string): string {
  const dir = mkdtempSync(join(tmpdir(), "0b-feedback-"));
  const path = join(dir, "FEEDBACK.md");
  try {
    writeFileSync(path, TEMPLATE(kind), { mode: 0o600 });
    const editor = shellSplit(process.env.VISUAL || process.env.EDITOR || "");
    const r = spawnSync(editor[0]!, [...editor.slice(1), path], { stdio: "inherit", shell: false });
    if (r.error || r.status !== 0) throw new Error(`couldn't run ${editor[0]}; give the message instead: 0b feedback "…"`);
    return fromEditor(readFileSync(path, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function ask(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(q);
  } finally {
    rl.close();
  }
}

/** The report as POST /api/feedback takes it. */
export function buildReport(kind: string, message: string, version: string, logs?: string) {
  return {
    kind,
    message,
    versions: { cli: version, os: `${platform()} ${release()} ${arch()}, node ${process.versions.node}` },
    ...(logs ? { logs } : {}),
  };
}

const indent = (s: string) => s.replace(/^/gm, "  ");

export async function feedbackCommand(ctx: Context, args: string[], opts: FeedbackOptions, version: string): Promise<void> {
  const kind = opts.kind ?? "problem";
  if (!KINDS.includes(kind as (typeof KINDS)[number])) throw new Error(`--kind is one of ${KINDS.join(", ")}`);
  const cloud = loadCloud(ctx);
  if (!cloud) throw new Error("Not signed in. Run `0b login` first, or write to us at https://0bridge.dev/contact.");
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let message = args.join(" ").trim();
  if (!message) {
    if (!tty) throw new Error('give the message: 0b feedback "what happened"');
    message = process.env.VISUAL || process.env.EDITOR ? editMessage(kind) : (await ask(`${kind === "idea" ? "Your idea" : "What happened"}? `)).trim();
    if (!message) return console.log(c.dim("Nothing written; nothing sent."));
  }
  if (message.length > MAX_MESSAGE) throw new Error(`the message has ${message.length.toLocaleString("en")} characters; at most ${MAX_MESSAGE.toLocaleString("en")}`);

  // The vault's values never leave this machine, even in a report.
  let values: string[] = [];
  try {
    values = vaultValues(ctx);
  } catch {}
  const logs = opts.includeLogs ? collectLogs(ctx, values) : undefined;
  const report = buildReport(kind, redact(message, values), version, logs);

  console.log(`This report goes to the 0bridge team, from ${c.bold(accountName(cloud))}:\n`);
  console.log(`${c.dim("Kind")}      ${report.kind}`);
  console.log(`${c.dim("Versions")}  0b ${report.versions.cli} · ${report.versions.os}`);
  console.log(`${c.dim("Message")}\n${indent(report.message)}`);
  if (opts.includeLogs) console.log(logs ? `${c.dim(`Logs (${logs.split("\n").length} lines; secrets masked)`)}\n${indent(logs)}` : c.dim("Logs: none on this machine yet."));
  console.log("");

  if (!opts.yes) {
    // An agent's preview: the exact report, for the user to read before it runs again with --yes.
    if (!tty) return console.log(`Not sent. After the user has read it and agreed, run it again with ${c.cyan("--yes")}.`);
    if (!/^y(es)?$/i.test((await ask(`Send it? ${c.dim("[y/N]")} `)).trim())) return console.log(c.dim("Not sent."));
  }
  // Refusals (too long, 10 an hour) come back as the gateway's own words.
  const r = await cloudClient(ctx).client.call<{ id: string }>("POST", "/feedback", report);
  console.log(`${c.green("✓")} Sent as ${r.id}. Thank you. For a reply, write through https://0bridge.dev/contact and mention ${r.id}.`);
}
