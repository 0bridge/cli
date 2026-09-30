import {
  CloudError,
  HISTORY_SOURCES,
  batchSessions,
  collectHistory,
  loadHistoryConfig,
  loadVaultCache,
  openValue,
  saveHistoryConfig,
  sealValue,
  vaultKeyId,
  type Context,
  type HistoryConfig,
  type HistoryFilter,
  type HistorySession,
  type HistorySource,
} from "@0bridge/core";
import { backgroundInstalled, ensureBackground, installBackground } from "./background.ts";
import { cloudClient } from "./cloud.ts";
import { localKey } from "./vault.ts";
import { c } from "./ui.ts";

/**
 * Conversation history on this machine: `0b history on` uploads the conversations from
 * Claude Code and the Claude app, Codex (CLI and app), Grok and Cursor — secrets masked here
 * first — and every AI tool can search them through 0bridge.
 * In end-to-end mode the text is sealed with the vault key and only this CLI can search it.
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
}

/** The vault's values this machine can open, to mask them wherever they appear in a conversation. */
function vaultValues(ctx: Context): string[] {
  const key = localKey(ctx);
  const cache = loadVaultCache(ctx);
  if (!key || !cache?.keyId || vaultKeyId(key) !== cache.keyId) return [];
  return cache.items.flatMap((i) => {
    if (!i.ct || i.kind === "variable") return [];
    try {
      return [openValue(key, i)];
    } catch {
      return [];
    }
  });
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
  const cfg = loadHistoryConfig(ctx);
  if (!cfg.enabled && !opts.dryRun) fail(`history sync is off on this machine. Turn it on with ${c.cyan("0b history on")}`);
  const { client } = cloudClient(ctx);
  const { mode } = await client.historyStats();
  const key = mode === "e2e" ? (localKey(ctx) ?? fail(`history is end-to-end encrypted and this machine doesn't have the vault key: run ${c.cyan("0b vault unlock")}`)) : null;
  const values = vaultValues(ctx);
  let sessions = 0;
  let messages = 0;
  let skipped = 0;
  for (;;) {
    const got = collectHistory(ctx, cfg, values, { maxBytes: ROUND_BYTES });
    skipped += got.skipped;
    if (!Object.keys(got.cursors).length) break;
    if (!opts.dryRun)
      for (const batch of batchSessions(got.sessions)) {
        const r = await client.uploadHistory(batch.map((s) => (key ? seal(key, s) : { ...s, enc: false })));
        messages += r.messages;
      }
    else messages += got.sessions.reduce((n, s) => n + s.messages.length, 0);
    sessions += got.sessions.length;
    // Saved per round, after its upload: an interrupted sync resumes where it stopped.
    Object.assign(cfg.files, got.cursors);
    if (!opts.dryRun) saveHistoryConfig(ctx, { ...cfg, lastSync: Date.now() });
    if (!opts.quiet) process.stdout.write(c.dim(`  ${sessions} sessions, ${messages} messages…\r`));
  }
  if (opts.quiet) return;
  const what = opts.dryRun ? "Would upload" : "Uploaded";
  console.log(`${sessions || messages ? c.green("✓") : c.dim("·")} ${what} ${messages} new messages from ${sessions} sessions${skipped ? c.dim(` (${skipped} in excluded repos skipped)`) : ""}${mode === "e2e" ? c.dim(", end-to-end encrypted") : ""}`);
}

const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
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
        console.log(`\n${c.bold(h.session.title ?? "(untitled)")} ${c.dim(h.session.id)}\n${c.dim(`${h.session.tool} · ${h.session.repo ?? h.session.cwd ?? "?"} · ${when(h.session.updatedAt)}`)}`);
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
        console.log(`\n${c.bold(title)} ${c.dim(meta.id)} ${c.dim(`#${m.seq} ${m.role} · ${meta.repo ?? meta.cwd ?? "?"} · ${when(m.at)}`)}\n  ${text.replace(/\s+/g, " ").slice(0, 240)}`);
        if (found >= 30) return;
      }
      if (page.messages.length < 500) break;
      from = page.messages.at(-1)!.seq + 1;
    }
  }
  if (!found) console.log(c.dim(`Nothing matches "${query}" in the ${list.length} most recent sessions.`));
}

async function show(ctx: Context, id: string, opts: { from?: string }): Promise<void> {
  const { client } = cloudClient(ctx);
  const r = await client.historySession(id, Number(opts.from ?? 0), 500);
  const key = r.session.enc ? (localKey(ctx) ?? fail(`this session is end-to-end encrypted: run ${c.cyan("0b vault unlock")} first`)) : null;
  const title = r.session.title && key ? openText(key, id, "title", r.session.title) : r.session.title;
  console.log(`${c.bold(title ?? id)}\n${c.dim(`${r.session.tool} · ${r.session.repo ?? r.session.cwd ?? "?"} · ${r.session.device ?? ""} · ${when(r.session.startedAt)} → ${when(r.session.updatedAt)}`)}\n`);
  for (const m of r.messages) console.log(`${c.dim(`#${m.seq} ${m.role}`)}\n${key ? openText(key, id, `#${m.seq}`, m.text) : m.text}\n`);
}

async function status(ctx: Context): Promise<void> {
  const cfg = loadHistoryConfig(ctx);
  const on = backgroundInstalled(ctx);
  console.log(
    `This machine: ${cfg.enabled ? c.green("on") : c.yellow("off")} · ${cfg.tools.join(", ")}${cfg.exclude.length ? ` · excluding ${cfg.exclude.join(", ")}` : ""}` +
      `\n  last sync ${cfg.lastSync ? when(cfg.lastSync) : "never"}${process.platform === "darwin" ? ` · automatic ${on ? "every 30 min" : "off"}` : ""}`,
  );
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
      await syncHistory(ctx, {});
      ensureBackground(ctx);
      console.log(c.dim(`Your AI tools can now search it (bridge__history_search). Exclude a repo with ${c.cyan("0b history exclude <repo>")}.`));
      return;
    }
    case "off":
      saveHistoryConfig(ctx, { ...cfg(), enabled: false });
      console.log(`${c.green("✓")} History sync off on this machine. What's uploaded stays until ${c.cyan("0b history forget --all")}.`);
      return;
    case "sync":
      return syncHistory(ctx, opts);
    case "search":
      if (!rest.length) fail("usage: 0b history search <words> [--repo r] [--tool t] [--days n]");
      return search(ctx, rest.join(" "), opts);
    case "show":
      if (!rest[0]) fail("usage: 0b history show <session-id>");
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
      fail(`unknown subcommand "history ${sub}". Try: status, on, off, sync, search, show, mode, exclude, forget, auto`);
  }
}
