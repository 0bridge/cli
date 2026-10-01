import * as p from "@clack/prompts";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { delimiter, join } from "node:path";
import { CloudError, openValue, writeAtomic, type Context } from "@0bridge/core";
import { cloudClient } from "./cloud.ts";
import { localKey } from "./vault.ts";
import { c } from "./ui.ts";

/**
 * `0b resume <0b:id>`: continue a session from any tool in the one here (Claude Code, Codex,
 * Gemini, Cursor), from its handoff: what was saved about it (summary, open items), the
 * first ask and the last few turns, as the new session's first message. On the machine it ran
 * on, in its own tool, it offers the tool's native resume instead. Inside an agent it prints the
 * handoff, for the agent to read.
 */

export interface ResumeOptions {
  tool?: string;
  print?: boolean;
  turns?: string;
}

type Role = "user" | "assistant" | "tool";
type Turn = { seq: number; role: Role; at: number; text: string };

/** GET /api/history/sessions/<ref>/handoff (the gateway's history.ts Handoff). */
export interface Handoff {
  id: string;
  ref: string;
  tool: string;
  title: string | null;
  repo: string | null;
  branch: string | null;
  cwd: string | null;
  device: string | null;
  startedAt: number;
  updatedAt: number;
  messages: number;
  enc: boolean;
  summary: string | null;
  open: string | null;
  goal: string | null;
  recent: Turn[];
  native: { tool: "claude" | "codex" | "cursor" | "gemini" | "grok"; id: string; command: string } | null;
}

/** The agents `0b resume` can start, by `--tool` name. */
export const AGENTS = {
  claude: { bin: "claude", label: "Claude Code", args: (prompt: string) => [prompt] },
  codex: { bin: "codex", label: "Codex", args: (prompt: string) => [prompt] },
  gemini: { bin: "gemini", label: "Gemini CLI", args: (prompt: string) => ["-i", prompt] },
  cursor: { bin: "cursor-agent", label: "Cursor", args: (prompt: string) => [prompt] },
} as const;
export type AgentName = keyof typeof AGENTS;

/** Budgets, the same as the server's handoff (K3). */
const TURNS = 6;
const MAX_TURNS = 20;
const TURN_CHARS = 1_500;
const GOAL_CHARS = 600;
const MAX_CHARS = 8_000;

function fail(msg: string): never {
  console.error(c.red(`error: ${msg}`));
  process.exit(1);
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const secretOnly = (text: string) => !text.replaceAll("[secret]", "").trim();

/** The agent family a session's tool belongs to, for `--tool` and the native resume. */
export function agentOf(tool: string): AgentName | null {
  if (tool === "claude" || tool === "claude-code" || tool === "claude-app") return "claude";
  if (tool === "codex" || tool === "codex-app") return "codex";
  if (tool === "gemini" || tool === "gemini-cli") return "gemini";
  if (tool === "cursor" || tool === "cursor-agent") return "cursor";
  return null;
}

/**
 * Inside an AI agent (Claude Code, Codex's sandbox) or piped: print the handoff rather than start a
 * tool. Not CODEX_HOME: people set that in their own shell for a second Codex account.
 */
export function inAgent(env: NodeJS.ProcessEnv = process.env, tty = Boolean(process.stdout.isTTY)): boolean {
  return env.CLAUDECODE === "1" || Boolean(env.CODEX_SANDBOX) || Boolean(env.CODEX_SANDBOX_NETWORK_DISABLED) || !tty;
}

/** At most `n` chars of `text`, keeping its start and its end. */
function clipMiddle(text: string, n: number): string {
  if (text.length <= n) return text;
  const gap = " […] ";
  const head = Math.ceil((n - gap.length) * 0.6);
  return `${text.slice(0, head)}${gap}${text.slice(text.length - (n - gap.length - head))}`;
}

/** The last `turns` turns within the budgets, oldest first (end-to-end sessions are cut here, like the server does). */
export function pickRecent(newestFirst: Turn[], turns = TURNS, maxChars = MAX_CHARS): Turn[] {
  const out: Turn[] = [];
  let left = maxChars;
  for (const m of newestFirst) {
    if (out.length >= turns || left <= 0) break;
    if (secretOnly(m.text)) continue;
    const full = m.text.trim();
    if (full.length > left && left < 200) break;
    const text = clipMiddle(full, Math.min(TURN_CHARS, left));
    out.push({ ...m, text });
    left -= text.length;
  }
  return out.reverse();
}

/** The handoff as the first message of a new session in another tool. */
export function renderPrompt(h: Handoff): string {
  const at = [h.repo ? `${h.repo}${h.branch ? `@${h.branch}` : ""}` : null, h.cwd, h.device, `last active ${day(h.updatedAt)}`].filter(Boolean).join(" · ");
  const parts = [`I'm continuing a session from ${h.tool} (${h.ref}): ${h.title ?? "(untitled)"}\n${at}`];
  if (h.summary) parts.push(`Summary:\n${h.summary}`);
  if (h.open) parts.push(`Open items:\n${h.open}`);
  if (h.goal) parts.push(`Goal (the first ask):\n${h.goal}`);
  if (h.recent.length) parts.push(`Recent turns (${h.recent.length} of ${h.messages}):\n${h.recent.map((m) => `#${m.seq} ${m.role}: ${m.text}`).join("\n\n")}`);
  parts.push(
    `Check the current state of the repo before acting; don't redo finished work. Full transcript: \`0b history show ${h.id}\`, or bridge__history_get session=${h.ref}.`,
  );
  return parts.join("\n\n");
}

/** A command's executable on PATH: on Windows an .exe before a .cmd shim. */
export function findCommand(cmd: string, platform = process.platform, path = process.env.PATH ?? ""): string | null {
  const names = platform === "win32" ? [`${cmd}.exe`, `${cmd}.cmd`, cmd] : [cmd];
  for (const d of path.split(platform === "win32" ? ";" : delimiter).filter(Boolean)) for (const n of names) if (existsSync(join(d, n))) return join(d, n);
  return null;
}

export interface Launch {
  file: string;
  args: string[];
  /** Arguments already quoted for cmd.exe (Node passes them as they are). */
  verbatim: boolean;
}

/**
 * How to start `bin` with `args`, never through a shell (the prompt is the user's text). A
 * Windows .cmd shim (npm installs) only runs under cmd.exe, which would read a prompt's & | > as
 * commands, so it gets `fallback` instead: plain words and a path, quoted, with cmd's special
 * characters removed.
 */
export function launch(bin: string, args: string[], fallback: string[] = args, platform = process.platform): Launch {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(bin)) return { file: bin, args, verbatim: false };
  const quote = (a: string) => `"${a.replace(/["%^&|<>!\r\n]/g, "")}"`;
  return { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `"${[bin, ...fallback].map(quote).join(" ")}"`], verbatim: true };
}

/** Sealed text of an end-to-end session, opened with this machine's vault key. */
function opened(key: Uint8Array, id: string, name: string, ct: string): string {
  try {
    return openValue(key, { scope: "history", env: id, name, ct });
  } catch {
    return "(can't decrypt with this machine's vault key)";
  }
}

/** An end-to-end encrypted session's handoff, built here: the server only has ciphertext. */
async function openHandoff(ctx: Context, h: Handoff, turns: number): Promise<Handoff> {
  const key = localKey(ctx) ?? fail(`${h.ref} is end-to-end encrypted: run ${c.cyan("0b vault unlock")} on this machine first`);
  const { client } = cloudClient(ctx);
  const first = await client.historySession(h.id, 0, 20);
  const tail = await client.historySession(h.id, Math.max(0, h.messages - (turns * 3 + 10)), turns * 3 + 10);
  const open = (m: { seq: number; text: string }) => opened(key, h.id, `#${m.seq}`, m.text);
  const sealed = (name: string, v: string | null) => (v?.startsWith("v1.") ? opened(key, h.id, name, v) : v);
  const goal = first.messages.filter((m) => m.role === "user").map(open).find((t) => !secretOnly(t));
  const newestFirst = tail.messages.map((m) => ({ ...m, role: m.role as Role, text: open(m) })).reverse();
  return {
    ...h,
    title: sealed("title", h.title),
    summary: sealed("summary", h.summary),
    open: sealed("open", h.open),
    goal: goal === undefined ? null : goal.trim().length > GOAL_CHARS ? `${goal.trim().slice(0, GOAL_CHARS - 1)}…` : goal.trim(),
    recent: pickRecent(newestFirst, turns),
  };
}

/** Run a command in the foreground and leave with its exit code. */
function run(start: Launch, cwd: string): Promise<never> {
  return new Promise((_, reject) => {
    const child = spawn(start.file, start.args, { cwd, stdio: "inherit", shell: false, windowsVerbatimArguments: start.verbatim });
    child.on("error", reject);
    child.on("exit", (code) => process.exit(code ?? 0));
  });
}

export async function resumeCommand(ctx: Context, args: string[], opts: ResumeOptions): Promise<void> {
  const ref = args.join(" ").trim();
  if (!ref) fail(`which session? ${c.cyan("0b resume 0b:k3f9x2")} (refs are in ${c.cyan("0b history list")} and on the dashboard)`);
  const turns = opts.turns ? Math.min(Math.max(Number.parseInt(opts.turns, 10) || TURNS, 1), MAX_TURNS) : TURNS;
  const wanted = opts.tool ? (agentOf(opts.tool) ?? fail(`--tool is one of ${Object.keys(AGENTS).join(", ")}`)) : null;

  const { client } = cloudClient(ctx);
  type Reply = Handoff | { error: string; candidates?: { short: string; title: string | null; tool: string; repo: string | null; updatedAt: number }[] };
  let r: Reply;
  try {
    r = await client.call<Reply>("GET", `/history/sessions/${encodeURIComponent(ref)}/handoff?turns=${turns}`, undefined, [404, 409]);
  } catch (e) {
    if (e instanceof CloudError) fail(e.message);
    throw e;
  }
  if ("error" in r) {
    if (!r.candidates?.length) fail(`no session ${ref}. ${c.cyan("0b history list")} shows them with their refs`);
    console.error(c.red(`error: ${ref} matches several sessions:`));
    for (const s of r.candidates) console.error(`  ${c.bold(s.short)} ${s.title ?? "(untitled)"} ${c.dim(`${s.tool} · ${s.repo ?? "?"} · ${day(s.updatedAt)}`)}`);
    process.exit(1);
  }
  const h = r.enc ? await openHandoff(ctx, r, turns) : r;
  const prompt = renderPrompt(h);

  if (opts.print || (inAgent() && !wanted)) {
    console.log(prompt);
    return;
  }

  // On the machine it ran on, in its own tool: the tool's own resume has the whole session.
  const here = hostname().replace(/\.local$/, "");
  const own = agentOf(h.tool);
  if (h.native && h.device === here && (!wanted || wanted === own) && own && findCommand(AGENTS[own].bin)) {
    const [, ...nativeArgs] = h.native.command.split(" ");
    const cwd = h.cwd && existsSync(h.cwd) ? h.cwd : process.cwd();
    const yes = await p.confirm({ message: `${h.ref} ran here. Continue it in ${AGENTS[own].label} itself (${h.native.command}${cwd !== process.cwd() ? ` in ${cwd}` : ""})?` });
    if (p.isCancel(yes)) process.exit(0);
    if (yes) return run(launch(findCommand(AGENTS[own].bin)!, nativeArgs), cwd);
  }

  // Elsewhere, or another tool: a new session that starts from the handoff.
  const name = wanted ?? (own && findCommand(AGENTS[own].bin) ? own : (Object.keys(AGENTS) as AgentName[]).find((a) => findCommand(AGENTS[a].bin)));
  if (!name) {
    console.log(prompt);
    console.error(c.dim(`\nNo Claude Code, Codex, Gemini CLI or Cursor CLI here: paste the handoff above into your AI tool.`));
    return;
  }
  const agent = AGENTS[name];
  const bin = findCommand(agent.bin) ?? fail(`${agent.bin} isn't installed here. Install ${agent.label}, or pick another with --tool`);
  const file = join(ctx.storeDir, "handoffs", `${h.ref.replace(/^0b:/, "")}.md`);
  writeAtomic(file, `${prompt}\n`, { mode: 0o600 });
  console.error(c.dim(`Continuing ${h.ref} in ${agent.label} (the handoff is in ${file})`));
  return run(launch(bin, agent.args(prompt), agent.args(`Read ${file} and continue the session it describes.`)), process.cwd());
}
