import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join, resolve, sep } from "node:path";
import {
  CloudError,
  HISTORY_SOURCES,
  batchSessions,
  collectHistory,
  executePlan,
  extraClaudeDirs,
  hooksStatus,
  loadHistoryConfig,
  loadState,
  sqliteAvailable,
  openValue,
  ownedHooks,
  planHooks,
  readJson,
  saveHistoryConfig,
  saveState,
  sealValue,
  statusEnabled,
  statusPath,
  syncWanted,
  tryLock,
  usageOnly,
  usageWanted,
  writeAtomic,
  type CloudClient,
  type Context,
  type HistoryConfig,
  type HistoryFilter,
  type HistorySession,
  type HistorySessionMeta,
  type HistorySource,
  type ToolId,
  type UsageIn,
} from "@0bridge/core";
import { BACKGROUND_INTERVAL, backgroundInstalled, ensureBackground, installBackground } from "./background.ts";
import { cloudClient } from "./cloud.ts";
import { pendingMarks, takeMarks, workerLockPath } from "./hook.ts";
import { binPath, ensureBin } from "./service.ts";
import { localKey, vaultValues } from "./vault.ts";
import { c } from "./ui.ts";

/**
 * Conversation history on this machine: `0b history on` uploads the conversations from
 * Claude Code and the Claude app, Codex (CLI and app), Grok, Cursor (app and CLI), Gemini CLI,
 * OpenClaw and Hermes — secrets masked here first — and every AI tool can search them through 0bridge.
 * In end-to-end mode the text is sealed with the vault key and only this CLI can search it.
 *
 * When it's uploaded: each agent's turn-end hook (`0b hook`) marks its conversation and
 * wakes one worker per machine, which uploads 5 s after the last mark and at most every 15 s; the
 * background job sweeps everything every 15 minutes. All of them take the history lock, so only
 * one process at a time reads the logs and rewrites history.json.
 */

function fail(msg: string): never {
  console.error(c.red(`error: ${msg}`));
  process.exit(1);
}

const TOOLS: HistorySource[] = HISTORY_SOURCES;
/** Raw log bytes read per round, so a first sync of gigabytes doesn't hold it all in memory. */
const ROUND_BYTES = 150_000_000;

export interface HistoryOptions {
  repo?: string;
  tool?: string;
  days?: string;
  all?: boolean;
  dryRun?: boolean;
  quiet?: boolean;
  yes?: boolean;
  /** `0b history on --hooks|--no-hooks`: install the turn-end hooks without asking. */
  hooks?: boolean;
  noHooks?: boolean;
  /** `0b history sync --worker`: the debounced uploader a hook starts. */
  worker?: boolean;
  /** Only the sources these log files belong to (what the hooks marked); unset: every source. */
  only?: string[];
  /** The periodic job: when another sync holds the history lock, skip this round instead of waiting. */
  skipIfBusy?: boolean;
}

const historyLockPath = (ctx: Context) => join(ctx.storeDir, "history.lock");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The sources marked log files belong to: Claude Code's (every config folder) and Codex's.
 * Anything else, or nothing, is null: scan every source.
 */
export function sourcesOf(ctx: Context, files: string[] | undefined): HistorySource[] | null {
  if (!files?.length) return null;
  const under = (dir: string, f: string) => resolve(f).startsWith(resolve(dir) + sep);
  const claude = [join(ctx.home, ".claude"), ...extraClaudeDirs(ctx)];
  const codex = [process.env.CODEX_HOME ?? join(ctx.home, ".codex")];
  const out = new Set<HistorySource>();
  for (const f of files) {
    if (claude.some((d) => under(d, f))) out.add("claude-code");
    else if (codex.some((d) => under(d, f))) out.add("codex");
    else return null;
  }
  return [...out];
}

/** Take the history lock, waiting for a sync that holds it (up to 10 minutes); null when skipped or timed out. */
async function historyLock(ctx: Context, opts: HistoryOptions): Promise<(() => void) | null> {
  const deadline = Date.now() + 10 * 60_000;
  let said = false;
  for (;;) {
    const release = tryLock(historyLockPath(ctx));
    if (release || opts.skipIfBusy || Date.now() > deadline) return release;
    if (!opts.quiet && !said) (console.log(c.dim("Another sync is running on this machine; waiting for it…")), (said = true));
    await sleep(1000);
  }
}

/** Seal a session's text for end-to-end mode: the place (session, message) is bound in, like vault values. */
function seal(key: Uint8Array, s: HistorySession) {
  const at = (name: string) => ({ scope: "history", env: s.id, name });
  return {
    ...s,
    enc: true,
    title: s.title ? sealValue(key, at("title"), s.title) : undefined,
    messages: s.messages.map((m) => ({ ...m, text: sealValue(key, at(`#${m.seq}`), m.text) })),
  };
}

function openText(key: Uint8Array, sessionId: string, name: string, ct: string): string {
  try {
    return openValue(key, { scope: "history", env: sessionId, name, ct });
  } catch {
    return "(can't decrypt with this machine's vault key)";
  }
}

export async function syncHistory(ctx: Context, opts: HistoryOptions): Promise<void> {
  if (opts.dryRun) return upload(ctx, opts);
  const release = await historyLock(ctx, opts);
  if (!release) {
    if (!opts.skipIfBusy) fail("another sync on this machine has been running for 10 minutes; try again later");
    return;
  }
  try {
    await upload(ctx, opts);
  } finally {
    release();
  }
}

/** Usage rows per request (the server takes up to 2,000). */
const USAGE_BATCH = 2_000;

/**
 * Send token counts (round 2, P5): absolute bucket totals, so a batch sent twice changes nothing.
 * A server without /api/usage yet (404) is skipped, so history still goes up.
 */
export async function uploadUsage(client: CloudClient, rows: UsageIn[]): Promise<number> {
  let sent = 0;
  for (let i = 0; i < rows.length; i += USAGE_BATCH) {
    try {
      sent += (await client.call<{ rows: number }>("POST", "/usage", { rows: rows.slice(i, i + USAGE_BATCH) })).rows;
    } catch (e) {
      if (e instanceof CloudError && e.status === 404) return sent;
      throw e;
    }
  }
  return sent;
}

async function upload(ctx: Context, opts: HistoryOptions): Promise<void> {
  let cfg = loadHistoryConfig(ctx);
  if (!syncWanted(cfg) && !opts.dryRun) fail(`history sync is off on this machine. Turn it on with ${c.cyan("0b history on")}`);
  // History off and usage on (`0b usage on`): token counts only, read with their own cursors.
  // A dry run always reads like history does, and says what both would send.
  const countsOnly = usageOnly(cfg) && !opts.dryRun;
  const field = countsOnly ? "usageFiles" : "files";
  const withUsage = usageWanted(cfg) || Boolean(opts.dryRun);
  if (countsOnly) cfg = { ...cfg, files: cfg.usageFiles ?? {} };
  const sources = sourcesOf(ctx, opts.only);
  if (sources) cfg = { ...cfg, tools: cfg.tools.filter((t) => sources.includes(t)) };
  if (!cfg.tools.length) return;
  const { client } = cloudClient(ctx);
  const { mode } = countsOnly ? { mode: "server" } : await client.historyStats();
  const key = mode === "e2e" ? (localKey(ctx) ?? fail(`history is end-to-end encrypted and this machine doesn't have the vault key: run ${c.cyan("0b vault unlock")}`)) : null;
  const values = vaultValues(ctx);
  let sessions = 0;
  let messages = 0;
  let skipped = 0;
  let usage = 0;
  for (;;) {
    const got = collectHistory(ctx, cfg, values, { maxBytes: ROUND_BYTES, countsOnly });
    skipped += got.skipped;
    // Done when no log moved on: nothing left, or only lines still being written.
    if (!Object.entries(got.cursors).some(([k, v]) => cfg.files[k]?.offset !== v.offset || cfg.files[k]?.seq !== v.seq || !(k in cfg.files))) break;
    if (!opts.dryRun)
      for (const batch of batchSessions(got.sessions)) {
        const r = await client.uploadHistory(batch.map((s) => (key ? seal(key, s) : { ...s, enc: false })));
        messages += r.messages;
      }
    else messages += got.sessions.reduce((n, s) => n + s.messages.length, 0);
    sessions += got.sessions.length;
    // Token counts after the messages, before the cursors move on (in e2e mode too: counts are metadata).
    if (withUsage) usage += opts.dryRun ? got.usage.length : await uploadUsage(client, got.usage);
    // Saved per round, after its upload: an interrupted sync resumes where it stopped. Merged into
    // the file as it is now, so a setting changed meanwhile (`0b history off`, exclude) stays.
    Object.assign(cfg.files, got.cursors);
    if (!opts.dryRun) {
      const now = loadHistoryConfig(ctx);
      saveHistoryConfig(ctx, { ...now, [field]: { ...now[field], ...got.cursors }, lastSync: Date.now() });
    }
    if (!opts.quiet) process.stdout.write(c.dim(countsOnly ? `  ${usage} usage rows…\r` : `  ${sessions} sessions, ${messages} messages…\r`));
  }
  if (opts.quiet) return;
  const what = opts.dryRun ? "Would upload" : "Uploaded";
  const counts = withUsage && usage ? c.dim(` · token counts: ${usage} ${usage === 1 ? "row" : "rows"}`) : "";
  if (countsOnly) return console.log(`${usage ? c.green("✓") : c.dim("·")} ${what} token counts: ${usage} ${usage === 1 ? "row" : "rows"} ${c.dim("(history is off: no conversation text)")}`);
  console.log(
    `${sessions || messages ? c.green("✓") : c.dim("·")} ${what} ${messages} new messages from ${sessions} sessions${skipped ? c.dim(` (${skipped} in excluded repos skipped)`) : ""}${mode === "e2e" ? c.dim(", end-to-end encrypted") : ""}${counts}`,
  );
}

const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
/** How a session is named to the user: its short ref (`0b:k3f9x2`, what `continue` and `0b resume` take) when the server sends one. */
const refOf = (s: HistorySessionMeta) => s.short || s.id;
const filters = (opts: HistoryOptions): HistoryFilter => ({ repo: opts.repo, tool: opts.tool, since: opts.days ? Date.now() - Number(opts.days) * 86_400_000 : undefined });

async function search(ctx: Context, query: string, opts: HistoryOptions): Promise<void> {
  const { client } = cloudClient(ctx);
  const { mode } = await client.historyStats();
  if (mode === "server") {
    const hits = await client.historySearch(query, { ...filters(opts), limit: 30 });
    if (!hits.length) return console.log(c.dim(`Nothing matches "${query}".`));
    let last = "";
    for (const h of hits) {
      if (h.session.id !== last) {
        console.log(`\n${c.bold(h.session.title ?? "(untitled)")} ${c.dim(refOf(h.session))}\n${c.dim(`${h.session.tool} · ${h.session.repo ?? h.session.cwd ?? "?"} · ${when(h.session.updatedAt)}`)}`);
        last = h.session.id;
      }
      console.log(`  ${c.dim(`#${h.seq} ${h.role}`)} ${h.snippet.replace(/\s+/g, " ").replace(/«([^»]*)»/g, (_, w: string) => c.bold(w))}`);
    }
    return;
  }
  // End-to-end: fetch the matching sessions' ciphertext and search it here.
  const key = localKey(ctx) ?? fail(`history is end-to-end encrypted: run ${c.cyan("0b vault unlock")} on this machine first`);
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const list = await client.historySessions({ ...filters(opts), limit: 100 });
  let found = 0;
  for (const meta of list) {
    for (let from = 0; ; ) {
      const page = await client.historySession(meta.id, from, 500);
      for (const m of page.messages) {
        const text = openText(key, meta.id, `#${m.seq}`, m.text);
        if (!terms.every((t) => text.toLowerCase().includes(t))) continue;
        const title = meta.title ? openText(key, meta.id, "title", meta.title) : "(untitled)";
        found++;
        console.log(`\n${c.bold(title)} ${c.dim(refOf(meta))} ${c.dim(`#${m.seq} ${m.role} · ${meta.repo ?? meta.cwd ?? "?"} · ${when(m.at)}`)}\n  ${text.replace(/\s+/g, " ").slice(0, 240)}`);
        if (found >= 30) return;
      }
      if (page.messages.length < 500) break;
      from = page.messages.at(-1)!.seq + 1;
    }
  }
  if (!found) console.log(c.dim(`Nothing matches "${query}" in the ${list.length} most recent sessions.`));
}

/** `ref`: a session id, or its short ref (`0b:k3f9x2`) where the server takes those. */
async function show(ctx: Context, ref: string, opts: { from?: string }): Promise<void> {
  const { client } = cloudClient(ctx);
  const r = await client.historySession(ref, Number(opts.from ?? 0), 500);
  // Sealed text is bound to the session's own id, not to the ref it was asked for by.
  const id = r.session.id;
  const key = r.session.enc ? (localKey(ctx) ?? fail(`this session is end-to-end encrypted: run ${c.cyan("0b vault unlock")} first`)) : null;
  const title = r.session.title && key ? openText(key, id, "title", r.session.title) : r.session.title;
  console.log(`${c.bold(title ?? id)} ${c.dim(refOf(r.session))}\n${c.dim(`${r.session.tool} · ${r.session.repo ?? r.session.cwd ?? "?"} · ${r.session.device ?? ""} · ${when(r.session.startedAt)} → ${when(r.session.updatedAt)}`)}\n`);
  for (const m of r.messages) console.log(`${c.dim(`#${m.seq} ${m.role}`)}\n${key ? openText(key, id, `#${m.seq}`, m.text) : m.text}\n`);
}

/** The most recent sessions, each with the ref to continue it by. */
async function list(ctx: Context, opts: HistoryOptions): Promise<void> {
  const { client } = cloudClient(ctx);
  const sessions = await client.historySessions({ ...filters(opts), limit: 30 });
  if (!sessions.length) return console.log(c.dim("No sessions yet."));
  const key = sessions.some((s) => s.enc) ? localKey(ctx) : null;
  for (const s of sessions) {
    const title = s.title && s.enc ? (key ? openText(key, s.id, "title", s.title) : "(encrypted)") : (s.title ?? "(untitled)");
    console.log(`${c.cyan(refOf(s).padEnd(10))} ${c.bold(title.replace(/\s+/g, " ").slice(0, 70))}\n${" ".repeat(11)}${c.dim(`${s.tool} · ${s.repo ?? s.cwd ?? "?"} · ${s.device ?? ""} · ${when(s.updatedAt)} · ${s.messages} messages`)}`);
  }
  console.log(c.dim(`\nContinue one anywhere: ${c.cyan("0b resume <ref>")}, or tell any connected AI "continue <ref>".`));
}

/** A visible warning when a chosen source can't be read on this machine (Cursor and Hermes need SQLite). */
function warnSqlite(tools: HistorySource[]): void {
  const need = tools.filter((t) => t === "cursor" || t === "cursor-agent" || t === "hermes");
  if (need.length && !sqliteAvailable())
    console.log(c.yellow(`  ${need.join(", ")}: skipped here, since reading them needs SQLite (Node 22.5 or newer, or the sqlite3 command)`));
}

async function status(ctx: Context): Promise<void> {
  const cfg = loadHistoryConfig(ctx);
  const on = backgroundInstalled(ctx);
  const hooks = hooksStatus(ctx);
  const hooked = (Object.keys(HOOK_LABEL) as (keyof typeof HOOK_LABEL)[]).filter((t) => hooks[t] === "on").map((t) => HOOK_LABEL[t]);
  console.log(
    `This machine: ${cfg.enabled ? c.green("on") : c.yellow("off")} · ${cfg.tools.join(", ")}${cfg.exclude.length ? ` · excluding ${cfg.exclude.join(", ")}` : ""}` +
      `\n  last sync ${cfg.lastSync ? when(cfg.lastSync) : "never"} · every ${BACKGROUND_INTERVAL / 60} min ${on ? c.green("on") : c.yellow(`off (${c.cyan("0b background on")})`)}` +
      `\n  as each turn ends: ${hooked.length ? c.green(hooked.join(", ")) : c.yellow(`off (${c.cyan("0b history hooks on")})`)}`,
  );
  if (cfg.enabled) warnSqlite(cfg.tools);
  try {
    const s = await cloudClient(ctx).client.historyStats();
    console.log(
      `0bridge: ${s.sessions} sessions, ${s.messages} messages, ${(s.bytes / 1e6).toFixed(1)} MB · ${s.mode === "e2e" ? "end-to-end encrypted (search with 0b history search)" : "searchable by your AI tools"}`,
    );
  } catch (e) {
    if (!(e instanceof CloudError)) throw e;
    console.log(c.dim(`0bridge: ${e.message}`));
  }
}

async function setMode(ctx: Context, mode: string | undefined, opts: HistoryOptions): Promise<void> {
  if (mode !== "server" && mode !== "e2e") fail(`mode is "server" (default: your AI tools can search it) or "e2e" (end-to-end encrypted: only 0b on your machines can search it)`);
  const { client } = cloudClient(ctx);
  const cur = await client.historyStats();
  if (cur.mode === mode) return console.log(`Already ${mode}.`);
  if (mode === "e2e" && !localKey(ctx)) fail(`end-to-end mode uses your vault key, which this machine doesn't have: run ${c.cyan("0b vault unlock")} (or create a vault with ${c.cyan("0b secret set")})`);
  // What's stored stays in the form it was sent, so switching starts over: delete, then re-upload.
  if (cur.sessions && !opts.yes)
    fail(`switching deletes the ${cur.sessions} sessions stored now and uploads them again ${mode === "e2e" ? "encrypted" : "readable"} from this machine. Run again with --yes`);
  await client.forgetHistory();
  await client.setHistoryMode(mode);
  const cfg = loadHistoryConfig(ctx);
  saveHistoryConfig(ctx, { ...cfg, files: {} });
  console.log(`${c.green("✓")} History is now ${mode === "e2e" ? "end-to-end encrypted" : "searchable by your AI tools"}. Other machines re-upload on their next sync after ${c.cyan("0b history reset")}.`);
  if (cfg.enabled) await syncHistory(ctx, {});
}

// ── Turn-end hooks ──

const HOOK_LABEL = { claude: "Claude Code", codex: "Codex", cursor: "Cursor" } as const;

/**
 * History wants the hooks too: when the board put them in (status.json hooksBefore: false),
 * record that history needs them now, so `0b sessions off` leaves the turn-end ones.
 */
function claimHooks(ctx: Context): void {
  try {
    const s = readJson<{ enabled?: boolean; hooksBefore?: boolean }>(statusPath(ctx));
    if (s?.enabled && s.hooksBefore === false) writeAtomic(statusPath(ctx), JSON.stringify({ ...s, hooksBefore: true }) + "\n", { mode: 0o600 });
  } catch {}
}

/** Add (or remove) our turn-end hook in each agent's settings, backed up like `0b apply`, and record what's ours in state.json. */
function setHooks(ctx: Context, on: boolean): void {
  // The session board comes on with the hooks (round 2 R5) unless this machine turned it off
  // (`0b sessions off` leaves status.json saying so). Its hooks predate it, so `sessions off` keeps them.
  const board = on && !existsSync(statusPath(ctx));
  if (board) writeAtomic(statusPath(ctx), JSON.stringify({ enabled: true, since: Date.now(), hooksBefore: true }) + "\n", { mode: 0o600 });
  else if (on) claimHooks(ctx);
  const plan = planHooks(ctx, on, on ? ensureBin(ctx) : binPath(ctx));
  if (plan.changes.length) executePlan(ctx, { changes: plan.changes, warnings: [], missing: [], state: loadState(ctx) });
  const owned = ownedHooks(ctx);
  const state = loadState(ctx);
  for (const t of ["claude", "codex", "cursor"] as ToolId[]) {
    if (owned[t]) (state.managed[t] ??= { mcp: [], skills: [] }).hooks = owned[t];
    else if (state.managed[t]) delete state.managed[t]!.hooks;
  }
  saveState(ctx, state);
  for (const ch of plan.changes) console.log(`${c.green("✓")} ${HOOK_LABEL[ch.tool as keyof typeof HOOK_LABEL] ?? ch.tool}: ${ch.summary.join(", ")} ${c.dim(`(${ch.path.replace(ctx.home, "~")})`)}`);
  if (!on) {
    if (!plan.changes.length) console.log(c.dim(statusEnabled(ctx) ? "The session board (0b sessions) still uses the hooks; 0b sessions off removes them." : "No 0bridge hooks to remove."));
    else console.log(c.dim(`Conversations now go up with the background sync, every ${BACKGROUND_INTERVAL / 60} minutes.`));
    return;
  }
  const status = hooksStatus(ctx);
  const hooked = (Object.keys(HOOK_LABEL) as (keyof typeof HOOK_LABEL)[]).filter((t) => status[t] === "on");
  for (const s of plan.skipped) if (s.target !== "gemini" || hooked.length) console.log(c.dim(`  ${s.target}: ${s.why}`));
  if (!hooked.length) return console.log(c.yellow(`No agent here takes the hook; the background sync uploads every ${BACKGROUND_INTERVAL / 60} minutes.`));
  console.log(`${c.green("✓")} ${hooked.map((t) => HOOK_LABEL[t]).join(", ")} upload each conversation within seconds of a turn ending. Restart running sessions to pick it up.`);
  if (board) console.log(`${c.green("✓")} Session board on: your dashboard's Now page and ${c.cyan("0b sessions")} show what each session is doing (${c.cyan("0b sessions off")} stops it).`);
  if (plan.changes.some((ch) => ch.tool === "codex" && ch.path.endsWith("hooks.json")))
    console.log(c.dim("  Codex asks you to trust a new hook the first time it would run it; allow 0bridge's (it only marks the conversation for upload)."));
}

/** `0b history on`: put the hooks in when asked to (--hooks), or after asking here; never without a yes. */
async function offerHooks(ctx: Context, opts: HistoryOptions): Promise<void> {
  if (opts.noHooks) return;
  const status = hooksStatus(ctx);
  if ((Object.keys(HOOK_LABEL) as (keyof typeof HOOK_LABEL)[]).some((t) => status[t] === "on") && !opts.hooks) {
    // The board's hooks already on: history uses them from now on, unless it was told no before.
    if (!loadHistoryConfig(ctx).hooksDeclined) claimHooks(ctx);
    return;
  }
  let yes = Boolean(opts.hooks || opts.yes);
  if (!yes && process.stdin.isTTY && process.stdout.isTTY && !loadHistoryConfig(ctx).hooksDeclined) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const a = await rl.question(`Upload each conversation as its turn ends? This adds a hook to Claude Code, Codex and Cursor's settings ${c.dim("[Y/n]")} `);
    rl.close();
    yes = !/^n(o)?$/i.test(a.trim());
    // Asked once: a later `0b history on` doesn't ask again.
    if (!yes) saveHistoryConfig(ctx, { ...loadHistoryConfig(ctx), hooksDeclined: true });
  }
  if (yes) setHooks(ctx, true);
  else console.log(c.dim(`Conversations go up every ${BACKGROUND_INTERVAL / 60} minutes. To upload as each turn ends: ${c.cyan("0b history hooks on")}`));
}

const DEBOUNCE_MS = 5_000;
const MIN_GAP_MS = 15_000;

/**
 * `0b history sync --worker`, started by a hook: one per machine (the worker lock). It uploads
 * what the hooks marked 5 s after the last mark, at most every 15 s, and exits after 5 s without
 * new marks. Quiet: its output goes to sync/worker.log.
 */
async function runWorker(ctx: Context): Promise<void> {
  const release = tryLock(workerLockPath(ctx));
  if (!release) return;
  const stamp = () => new Date().toISOString();
  try {
    if (!syncWanted(loadHistoryConfig(ctx))) {
      takeMarks(ctx);
      return;
    }
    await sleep(DEBOUNCE_MS);
    let last = 0;
    let lastSeen = Date.now();
    let seen = 0;
    for (;;) {
      const pending = pendingMarks(ctx).size;
      if (pending !== seen) {
        lastSeen = Date.now();
        seen = pending;
      }
      if (!pending) {
        if (Date.now() - lastSeen >= DEBOUNCE_MS) break;
        await sleep(250);
        continue;
      }
      // Trailing debounce (a turn often ends in a burst of marks), and one upload per 15 s.
      const wait = Math.max(lastSeen + DEBOUNCE_MS, last + MIN_GAP_MS) - Date.now();
      if (wait > 0 && last) {
        await sleep(Math.min(wait, 1000));
        continue;
      }
      const marks = takeMarks(ctx);
      seen = 0;
      try {
        await syncHistory(ctx, { quiet: true, only: marks.includes("*") ? undefined : marks });
      } catch (e) {
        console.error(`${stamp()} ${e instanceof Error ? e.message : e}`);
      }
      last = Date.now();
      lastSeen = Date.now();
    }
  } finally {
    release();
  }
  // A mark written while this worker was stopping saw it running and started none: go again.
  if (pendingMarks(ctx).size) return runWorker(ctx);
}

export async function historyCommand(ctx: Context, args: string[], opts: HistoryOptions): Promise<void> {
  const [sub, ...rest] = args;
  const cfg = (): HistoryConfig => loadHistoryConfig(ctx);
  switch (sub) {
    case undefined:
    case "status":
      return status(ctx);
    case "on": {
      const tools = opts.tool ? (opts.tool.split(",") as HistorySource[]) : TOOLS;
      for (const t of tools) if (!TOOLS.includes(t)) fail(`unknown tool "${t}" (expected ${TOOLS.join(", ")})`);
      saveHistoryConfig(ctx, { ...cfg(), enabled: true, tools });
      console.log(`${c.green("✓")} History sync on for ${tools.join(", ")}. Only the conversation goes up (no tool calls or output), with secrets masked on this machine first.`);
      warnSqlite(tools);
      await syncHistory(ctx, {});
      ensureBackground(ctx);
      await offerHooks(ctx, opts);
      console.log(c.dim(`Your AI tools can now search it (bridge__history_search). Exclude a repo with ${c.cyan("0b history exclude <repo>")}.`));
      return;
    }
    case "off": {
      saveHistoryConfig(ctx, { ...cfg(), enabled: false });
      const status = hooksStatus(ctx);
      if ((Object.keys(HOOK_LABEL) as (keyof typeof HOOK_LABEL)[]).some((t) => status[t] === "on")) setHooks(ctx, false);
      console.log(`${c.green("✓")} History sync off on this machine. What's uploaded stays until ${c.cyan("0b history forget --all")}.`);
      return;
    }
    case "hooks": {
      const what = rest[0] ?? "status";
      if (what === "on" || what === "off") {
        setHooks(ctx, what === "on");
        if (what === "on" && !cfg().enabled) console.log(c.yellow(`History sync is off on this machine, so nothing goes up yet: ${c.cyan("0b history on")}`));
        return;
      }
      if (what !== "status") fail("usage: 0b history hooks on|off|status");
      const s = hooksStatus(ctx);
      for (const t of ["claude", "codex", "cursor", "gemini"] as const)
        console.log(`  ${(t === "gemini" ? "Gemini CLI" : HOOK_LABEL[t]).padEnd(12)} ${s[t] === "on" ? c.green("on") : s[t] === "off" ? c.yellow("off") : c.dim("no hook (the background sync covers it)")}`);
      return;
    }
    case "sync":
      if (opts.worker) return runWorker(ctx);
      return syncHistory(ctx, opts);
    case "list":
    case "ls":
      return list(ctx, opts);
    case "search":
      if (!rest.length) fail("usage: 0b history search <words> [--repo r] [--tool t] [--days n]");
      return search(ctx, rest.join(" "), opts);
    case "show":
      if (!rest[0]) fail("usage: 0b history show <0b:ref or session-id>");
      return show(ctx, rest[0], {});
    case "mode":
      return setMode(ctx, rest[0], opts);
    case "exclude": {
      if (!rest[0]) return console.log(cfg().exclude.join("\n") || c.dim("Nothing excluded."));
      saveHistoryConfig(ctx, { ...cfg(), exclude: [...new Set([...cfg().exclude, ...rest])] });
      console.log(`${c.green("✓")} Won't upload sessions in ${rest.join(", ")}. Already uploaded ones stay: ${c.cyan("0b history forget <session-id>")}`);
      return;
    }
    case "include":
      saveHistoryConfig(ctx, { ...cfg(), exclude: cfg().exclude.filter((x) => !rest.includes(x)) });
      return console.log(`${c.green("✓")} Removed from the exclude list.`);
    case "forget": {
      const { client } = cloudClient(ctx);
      if (opts.all) {
        const r = await client.forgetHistory();
        console.log(`${c.green("✓")} Deleted ${r.deleted} sessions from 0bridge. This machine won't re-upload them; ${c.cyan("0b history reset")} would.`);
      } else if (rest[0]) {
        await client.forgetHistory(rest[0]);
        console.log(`${c.green("✓")} Deleted ${rest[0]}.`);
      } else fail("usage: 0b history forget <session-id> | --all");
      return;
    }
    case "reset":
      saveHistoryConfig(ctx, { ...cfg(), files: {} });
      return console.log(`${c.green("✓")} The next sync uploads every session on this machine again.`);
    case "auto":
      return installBackground(ctx, rest[0] !== "off");
    default:
      fail(`unknown subcommand "history ${sub}". Try: status, on, off, hooks, sync, list, search, show, mode, exclude, forget, auto`);
  }
}
