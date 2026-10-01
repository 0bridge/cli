import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { extraClaudeDirs } from "./adapters.ts";
import type { FileChange } from "./plan.ts";
import type { Context, ToolId } from "./types.ts";
import { readJson, readText, stableStringify } from "./util.ts";

/**
 * Agent hooks (D46, round 2 R1): Claude Code, Codex and Cursor run `0b hook <tool>` when a turn
 * ends, so a conversation is uploaded seconds after it happens instead of at the next periodic
 * sync; with the session status board on (`0b sessions on`) also when a prompt is submitted and
 * when the agent waits for the user, so the board shows working / needs you / idle live.
 *
 * Our entries are merged into the arrays already there (the user's own hooks, herdr's) and are
 * found again by their command: the 0bridge script followed by ` hook `. Removing them leaves
 * everything else as it was.
 *
 * Which events exist, checked 2026-10-01 against the installed binaries (their bundled hook input
 * schemas), never a real config folder:
 * - Claude Code 2.1.286: UserPromptSubmit {prompt, session_title?}, Notification {message, title?,
 *   notification_type: permission_prompt | idle_prompt | elicitation_dialog | agent_needs_input…},
 *   PermissionRequest {tool_name, tool_input}, Stop {last_assistant_message?}, SessionEnd {reason};
 *   all carry session_id, transcript_path, cwd and hook_event_name. StopFailure exists too but is
 *   left out: settings with an event an older Claude Code doesn't know may be refused there.
 *   UserPromptSubmit's stdout is added to the prompt, so the hook never prints.
 * - Codex 0.157 hooks.json: UserPromptSubmit {prompt}, PermissionRequest {tool_name, tool_input},
 *   Stop {last_assistant_message}, SessionEnd, plus Pre/PostToolUse, SessionStart, Subagent* and
 *   Pre/PostCompact. No Notification event. Its `notify` fallback only reports a finished turn.
 * - Cursor hooks.json (version 1): beforeSubmitPrompt and stop {status: completed|aborted|error}.
 *   There's no permission hook, so Cursor never shows "needs you".
 */

export type HookTarget = "claude" | "codex" | "cursor" | "gemini";
export const HOOK_TARGETS: HookTarget[] = ["claude", "codex", "cursor", "gemini"];

/**
 * The events each tool runs our hook on with the status board on. History alone needs only a
 * turn's end (TURN_END), so with the board off a prompt never waits for our hook.
 */
export const CLAUDE_EVENTS = ["UserPromptSubmit", "Notification", "PermissionRequest", "Stop", "SessionEnd"];
export const CODEX_EVENTS = ["UserPromptSubmit", "PermissionRequest", "Stop", "SessionEnd"];
export const CURSOR_EVENTS = ["beforeSubmitPrompt", "stop"];
/** Claude Code: a turn ending, and the session closing (/exit, /clear). */
const TURN_END: Record<"claude" | "codex" | "cursor", string[]> = { claude: ["Stop", "SessionEnd"], codex: ["Stop"], cursor: ["stop"] };

/** `0b sessions on|off` (round 2 R5): whether this machine posts its sessions' live state. */
export const statusPath = (ctx: Context) => join(ctx.storeDir, "status.json");

/** Whether the session status board is on for this machine (status.json {enabled}). */
export function statusEnabled(ctx: Context): boolean {
  try {
    return readJson<{ enabled?: unknown }>(statusPath(ctx))?.enabled === true;
  } catch {
    return false;
  }
}

/** A command 0bridge wrote: its script (…/0bridge or 0bridge.cmd, maybe quoted) then ` hook `. */
export function isOurHook(command: unknown): boolean {
  return typeof command === "string" && /0bridge(?:\.cmd)?["']?\s+hook\s/.test(command);
}

/** `<bin> hook <target>`, the bin quoted when it needs to be (double quotes work in sh, bash and cmd). */
export function hookCommandLine(bin: string, target: HookTarget): string {
  return `${/^[\w@%+=:,./~-]+$/.test(bin) ? bin : `"${bin}"`} hook ${target}`;
}

const isObject = (v: unknown): v is Record<string, any> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/**
 * Claude Code and Codex shape: `[{matcher?, hooks: [{type, command, timeout}]}]`. Our item replaces
 * the one we wrote before, in place; `item` null removes it (and its group when nothing else is in it).
 */
export function editHookGroups(list: unknown, item: Record<string, unknown> | null): unknown[] {
  const out: unknown[] = [];
  let placed = false;
  for (const g of Array.isArray(list) ? list : []) {
    if (!isObject(g) || !Array.isArray(g.hooks) || !g.hooks.some((h: any) => isObject(h) && isOurHook(h.command))) {
      out.push(g);
      continue;
    }
    const hooks: unknown[] = [];
    for (const h of g.hooks) {
      if (!(isObject(h) && isOurHook(h.command))) hooks.push(h);
      else if (item && !placed) (hooks.push(item), (placed = true));
    }
    if (hooks.length) out.push({ ...g, hooks });
  }
  if (item && !placed) out.push({ hooks: [item] });
  return out;
}

/** Cursor's shape: a flat `[{command}]`. */
export function editHookList(list: unknown, item: Record<string, unknown> | null): unknown[] {
  const out: unknown[] = [];
  let placed = false;
  for (const h of Array.isArray(list) ? list : []) {
    if (!(isObject(h) && isOurHook(h.command))) out.push(h);
    else if (item && !placed) (out.push(item), (placed = true));
  }
  if (item && !placed) out.push(item);
  return out;
}

const hasOurs = (list: unknown, flat = false): boolean =>
  Array.isArray(list) && list.some((x) => (flat ? isObject(x) && isOurHook(x.command) : isObject(x) && Array.isArray(x.hooks) && x.hooks.some((h: any) => isObject(h) && isOurHook(h.command))));

function parseJson(text: string | null): Record<string, any> | null {
  if (text == null || !text.trim()) return {};
  try {
    const v = JSON.parse(text);
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

/** A JSON settings file with our entry set or taken out of each event (`edit` decides per event), everything else untouched. */
function renderJson(text: string | null, events: string[], edit: (list: unknown, event: string) => unknown[], base: Record<string, unknown> = {}): string {
  const obj = parseJson(text);
  if (!obj) throw new Error("invalid JSON");
  const had = isObject(obj.hooks);
  const hooks: Record<string, unknown> = { ...(had ? obj.hooks : {}) };
  for (const ev of events) {
    const next = edit(hooks[ev], ev);
    if (next.length) hooks[ev] = next;
    else delete hooks[ev];
  }
  const out: Record<string, unknown> = text == null || !text.trim() ? { ...base } : { ...obj };
  if (Object.keys(hooks).length) out.hooks = hooks;
  else delete out.hooks;
  const indent = /^\{\n(\s+)"/.exec(text ?? "")?.[1] ?? "  ";
  return JSON.stringify(out, null, indent) + "\n";
}

const hooksView = (text: string | null) => JSON.stringify(parseJson(text)?.hooks ?? {}, null, 2) + "\n";

// ── Codex: hooks.json when its hooks are on, else `notify` in config.toml ──

const NOTIFY_LINE = /^notify\s*=\s*\[[^\n]*0bridge[^\n]*"hook"[^\n]*\]\s*\n?/m;

/** Codex runs hooks.json when hooks are on for it: the file exists already, or `[features] hooks = true`. */
function codexHasHooks(dir: string): boolean {
  if (existsSync(join(dir, "hooks.json"))) return true;
  try {
    return (parseToml(readText(join(dir, "config.toml")) ?? "") as { features?: { hooks?: unknown } }).features?.hooks === true;
  } catch {
    return false;
  }
}

/** config.toml with our top-level `notify` added (before any table, where top-level keys must go) or removed. */
export function renderCodexNotify(text: string | null, bin: string | null): string {
  const cur = (text ?? "").replace(NOTIFY_LINE, "");
  if (!bin) return cur;
  return `notify = ${JSON.stringify([bin, "hook", "codex"])}\n${cur}`;
}

function notifyOf(text: string | null): unknown {
  try {
    return (parseToml(text ?? "") as Record<string, unknown>).notify;
  } catch {
    return undefined;
  }
}

// ── Plan ──

/** Which of `events` hold an entry of ours in a settings file's text. */
const eventsWithOurs = (text: string | null, events: string[], flat: boolean) => {
  const hooks = parseJson(text)?.hooks ?? {};
  return events.filter((ev) => hasOurs(hooks[ev], flat));
};

/** Our entry (`item`) in the events of `want`, and in no other of `events`. `flat` is Cursor's shape. */
function jsonChange(tool: ToolId, path: string, before: string | null, events: string[], want: string[], item: Record<string, unknown> | null, flat: boolean, base?: Record<string, unknown>): FileChange | null {
  if (before == null && !want.length) return null;
  const edit = (list: unknown, ev: string) => {
    const it = item && want.includes(ev) ? item : null;
    return flat ? editHookList(list, it) : editHookGroups(list, it);
  };
  const render = (fresh: string | null) => renderJson(fresh, events, edit, base);
  const after = render(before);
  if (stableStringify(parseJson(after)) === stableStringify(parseJson(before))) return null;
  const had = eventsWithOurs(before, events, flat);
  const has = eventsWithOurs(after, events, flat);
  const names = (evs: string[]) => `${evs.join(", ")} hook${evs.length > 1 ? "s" : ""}`;
  const added = has.filter((ev) => !had.includes(ev));
  const removed = had.filter((ev) => !has.includes(ev));
  const summary = [...(added.length ? [`add ${names(added)}`] : []), ...(removed.length ? [`remove ${names(removed)}`] : [])];
  return {
    kind: "file",
    tool,
    what: "hooks",
    path,
    before,
    after,
    viewBefore: hooksView(before),
    viewAfter: hooksView(after),
    summary: summary.length ? summary : [`update ${names(has)}`],
    rerender: render,
  };
}

/**
 * The edits that add or remove our hook entries in each tool's settings, merged into what's there.
 * `on` says history wants them (a turn's end only); the status board, while it's on, wants them
 * whatever `on` says, on every event it reads.
 */
export function planHooks(ctx: Context, on: boolean, bin: string): { changes: FileChange[]; skipped: { target: HookTarget; why: string }[] } {
  const status = statusEnabled(ctx);
  on = on || status;
  const want = (t: keyof typeof TURN_END, all: string[]) => (status ? all : on ? TURN_END[t] : []);
  const changes: FileChange[] = [];
  const skipped: { target: HookTarget; why: string }[] = [];
  const push = (c: FileChange | null) => c && changes.push(c);
  const tryJson = (target: HookTarget, path: string, make: (before: string | null) => FileChange | null) => {
    const before = readText(path);
    if (!parseJson(before)) return skipped.push({ target, why: `${path} isn't valid JSON; left as is` });
    push(make(before));
  };

  // Claude Code: ~/.claude and every other config folder it uses (a second account).
  const claudeDirs = [join(ctx.home, ".claude"), ...extraClaudeDirs(ctx)].filter((d) => existsSync(d));
  if (!claudeDirs.length) skipped.push({ target: "claude", why: "Claude Code isn't installed here" });
  const claudeItem = on ? { type: "command", command: hookCommandLine(bin, "claude"), timeout: 5 } : null;
  for (const d of claudeDirs) tryJson("claude", join(d, "settings.json"), (before) => jsonChange("claude", join(d, "settings.json"), before, CLAUDE_EVENTS, want("claude", CLAUDE_EVENTS), claudeItem, false));

  // Codex: its hooks.json, or `notify` when hooks aren't on there (only when notify is free).
  const codexDir = join(ctx.home, ".codex");
  if (!existsSync(codexDir)) skipped.push({ target: "codex", why: "Codex isn't installed here" });
  else {
    const hooksPath = join(codexDir, "hooks.json");
    const tomlPath = join(codexDir, "config.toml");
    const toml = readText(tomlPath);
    const useHooks = codexHasHooks(codexDir);
    const codexItem = on && useHooks ? { type: "command", command: hookCommandLine(bin, "codex"), timeout: 5 } : null;
    if (useHooks) tryJson("codex", hooksPath, (before) => jsonChange("codex", hooksPath, before, CODEX_EVENTS, want("codex", CODEX_EVENTS), codexItem, false));
    const oursNotify = NOTIFY_LINE.test(toml ?? "");
    const wantNotify = on && !useHooks;
    if (wantNotify && notifyOf(toml) !== undefined && !oursNotify) skipped.push({ target: "codex", why: "this Codex has no hooks turned on and its notify setting is taken; the periodic sync covers it" });
    else if (wantNotify !== oursNotify || (wantNotify && !(toml ?? "").includes(JSON.stringify(bin)))) {
      const render = (fresh: string | null) => renderCodexNotify(fresh, wantNotify ? bin : null);
      const after = render(toml);
      if (after !== (toml ?? ""))
        changes.push({
          kind: "file",
          tool: "codex",
          what: "hooks",
          path: tomlPath,
          before: toml,
          after,
          viewBefore: (NOTIFY_LINE.exec(toml ?? "")?.[0] ?? "").trim() + "\n",
          viewAfter: (NOTIFY_LINE.exec(after)?.[0] ?? "").trim() + "\n",
          summary: [`${wantNotify ? "add" : "remove"} notify hook`],
          rerender: render,
        });
    }
  }

  // Cursor: ~/.cursor/hooks.json.
  const cursorDir = join(ctx.home, ".cursor");
  if (!existsSync(cursorDir)) skipped.push({ target: "cursor", why: "Cursor isn't installed here" });
  else {
    const path = join(cursorDir, "hooks.json");
    const item = on ? { command: hookCommandLine(bin, "cursor") } : null;
    tryJson("cursor", path, (before) => jsonChange("cursor", path, before, CURSOR_EVENTS, want("cursor", CURSOR_EVENTS), item, true, { version: 1 }));
  }

  skipped.push({ target: "gemini", why: "Gemini CLI has no turn-end hook 0bridge uses yet; the periodic sync covers it" });
  return { changes, skipped };
}

/** The hook entries of ours in each tool's settings now (what State.managed[tool].hooks records). */
export function ownedHooks(ctx: Context): Partial<Record<ToolId, string[]>> {
  const out: Partial<Record<ToolId, string[]>> = {};
  const claude = parseJson(readText(join(ctx.home, ".claude", "settings.json")))?.hooks ?? {};
  const c = CLAUDE_EVENTS.filter((ev) => hasOurs(claude[ev]));
  if (c.length) out.claude = c;
  const codexHooks = parseJson(readText(join(ctx.home, ".codex", "hooks.json")))?.hooks ?? {};
  const x = [...CODEX_EVENTS.filter((ev) => hasOurs(codexHooks[ev])), ...(NOTIFY_LINE.test(readText(join(ctx.home, ".codex", "config.toml")) ?? "") ? ["notify"] : [])];
  if (x.length) out.codex = x;
  const cursor = parseJson(readText(join(ctx.home, ".cursor", "hooks.json")))?.hooks ?? {};
  const u = CURSOR_EVENTS.filter((ev) => hasOurs(cursor[ev], true));
  if (u.length) out.cursor = u;
  return out;
}

/** Whether our hook is in each tool's settings. */
export function hooksStatus(ctx: Context): Record<HookTarget, "on" | "off" | "unsupported"> {
  const owned = ownedHooks(ctx);
  return {
    claude: owned.claude?.includes("Stop") ? "on" : "off",
    codex: owned.codex?.length ? "on" : "off",
    cursor: owned.cursor?.length ? "on" : "off",
    gemini: "unsupported",
  };
}
