import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  BUILTIN_SKILLS,
  CloudError,
  contextPaths,
  listSkills,
  loadManifest,
  planSync,
  readJson,
  readSkill,
  readText,
  saveManifest,
  sha256Hex,
  shellSplit,
  writeAtomic,
  type CloudClient,
  type Context,
  type ContextDoc,
  type ContextOverview,
  type ContextSkillMeta,
  type MemoryItem,
  type SyncAction,
} from "@0bridge/core";
import { cloudClient } from "./cloud.ts";
import { c, tilde } from "./ui.ts";

/**
 * `0b context` and `0b memory`: your profile, global instructions and skills on 0bridge, so
 * every AI app (Claude, ChatGPT, the coding agents) reads the same ones, and memory any of them can
 * search. The local copies are ~/.0bridge/PROFILE.md, ~/.0bridge/AGENTS.md (what `0b apply` puts
 * in each tool) and ~/.0bridge/skills/*. Like personal files, a sync never overwrites a copy
 * changed on both sides: this machine's stays, and 0bridge's is written next to it.
 */

export interface ContextOptions {
  force?: boolean;
  quiet?: boolean;
  yes?: boolean;
  tags?: string;
}

function fail(msg: string): never {
  console.error(c.red(`error: ${msg}`));
  process.exit(1);
}

/** The hashes both sides had at the last sync, per account (by user id). */
interface SyncState {
  profile: string | null;
  instructions: string | null;
  skills: Record<string, string>;
  lastSync?: number;
}
const statePath = (ctx: Context) => join(ctx.storeDir, "context.json");
const loadStates = (ctx: Context) => readJson<Record<string, SyncState>>(statePath(ctx)) ?? {};
const saveState = (ctx: Context, userId: string, s: SyncState) => writeAtomic(statePath(ctx), JSON.stringify({ ...loadStates(ctx), [userId]: s }, null, 1) + "\n", { mode: 0o600 });

const PROFILE_MAX = 4000;
const PROFILE_TEMPLATE = `# About me

- Role:
- Usually working on:
- Languages and tools:
- How I like answers:
`;

type DocName = "profile" | "instructions";

/** One thing to sync: the profile, the instructions, or a skill. */
interface Item {
  kind: DocName | "skill";
  name: string;
  /** What to call it in output. */
  label: string;
  local: string | null;
  remote: string | null;
  base: string | null;
  action: SyncAction;
}

interface Report {
  pushed: string[];
  pulled: string[];
  removed: string[];
  conflicts: string[];
  /** Changed on the side this command doesn't move (a pull's local edits, a push's remote ones). */
  waiting: string[];
  notes: string[];
}

/** A document's text here; empty counts as none, so a blank file never replaces one on 0bridge. */
const localDoc = (path: string) => {
  const t = readText(path);
  return t?.trim() ? t : null;
};

export interface ContextPlan {
  items: Item[];
  remote: ContextOverview;
  state: SyncState;
}

/** Both sides of every item and what a sync does with it. */
export async function planContext(ctx: Context, client: CloudClient, userId: string, only?: DocName): Promise<ContextPlan> {
  const p = contextPaths(ctx);
  const remote = await client.call<ContextOverview>("GET", "/context");
  const state: SyncState = loadStates(ctx)[userId] ?? { profile: null, instructions: null, skills: {} };
  const items: Item[] = [];
  const doc = (kind: DocName, label: string, path: string, r: ContextDoc | null) => {
    const text = localDoc(path);
    const local = text === null ? null : sha256Hex(text);
    let action = planSync(local, r?.hash ?? null, state[kind]);
    // A document isn't deleted on 0bridge: missing there (a new account) means push it again.
    if (action === "delete-local") action = "push";
    items.push({ kind, name: kind, label, local, remote: r?.hash ?? null, base: state[kind], action });
  };
  doc("profile", tilde(ctx, p.profile), p.profile, remote.profile);
  if (only) return { items, remote, state };
  doc("instructions", tilde(ctx, p.instructions), p.instructions, remote.instructions);
  const remoteSkills = new Map(remote.skills.map((s) => [s.name, s]));
  const names = new Set([...listSkills(p.skills), ...remoteSkills.keys(), ...Object.keys(state.skills)]);
  for (const name of [...names].sort()) {
    if (BUILTIN_SKILLS.has(name)) continue;
    const local = readSkill(join(p.skills, name), name)?.hash ?? null;
    const r = remoteSkills.get(name)?.hash ?? null;
    const base = state.skills[name] ?? null;
    items.push({ kind: "skill", name, label: `skill ${name}`, local, remote: r, base, action: planSync(local, r, base) });
  }
  return { items, remote, state };
}

/** Write 0bridge's copy next to this machine's: `<file>.0bridge-remote`, or a skill under skills/.0bridge-remote/. */
async function conflictCopy(ctx: Context, client: CloudClient, it: Item, remoteText?: string): Promise<string> {
  const p = contextPaths(ctx);
  if (it.kind === "skill") {
    const dir = join(p.skills, ".0bridge-remote", it.name);
    rmSync(dir, { recursive: true, force: true });
    await writeSkill(client, dir, it.name);
    return tilde(ctx, dir);
  }
  const path = `${p[it.kind]}.0bridge-remote`;
  const text = remoteText ?? (await client.call<ContextDoc>("GET", `/context/${it.kind}`)).text;
  writeAtomic(path, text);
  return tilde(ctx, path);
}

/** Write 0bridge's copy of a skill into `dir`: SKILL.md and its files; text files it no longer has go. Returns its hash. */
async function writeSkill(client: CloudClient, dir: string, name: string): Promise<string> {
  const s = await client.call<{ body: string; files: Record<string, string>; hash: string }>("GET", `/context/skills/${encodeURIComponent(name)}`);
  const before = readSkill(dir, name);
  for (const path of Object.keys(before?.files ?? {})) if (!(path in s.files)) rmSync(join(dir, path), { force: true });
  for (const [path, text] of [["SKILL.md", s.body], ...Object.entries(s.files)] as const) {
    // 0bridge only stores relative paths without `..`; never write outside the skill's folder anyway.
    if (isAbsolute(path) || relative(dir, join(dir, path)).startsWith("..")) continue;
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeAtomic(join(dir, path), text);
  }
  return s.hash;
}

type Mode = "push" | "pull" | "sync";

/** Do what the plan says for `mode`. `force`: this side wins (push) or 0bridge's does (pull). */
async function run(ctx: Context, client: CloudClient, userId: string, plan: ContextPlan, mode: Mode, force = false): Promise<Report> {
  const p = contextPaths(ctx);
  const { state } = plan;
  const res: Report = { pushed: [], pulled: [], removed: [], conflicts: [], waiting: [], notes: [] };
  const m = loadManifest(ctx);
  let manifestChanged = false;
  const remember = (it: Item, hash: string | null) => {
    if (it.kind === "skill") {
      if (hash) state.skills[it.name] = hash;
      else delete state.skills[it.name];
    } else state[it.kind] = hash;
  };

  const pull = async (it: Item) => {
    if (it.kind === "skill") {
      const dir = join(p.skills, it.name);
      const fresh = !existsSync(dir);
      remember(it, await writeSkill(client, dir, it.name));
      if (m && !m.skills[it.name]) ((m.skills[it.name] = {}), (manifestChanged = true));
      res.pulled.push(it.label + (fresh ? c.dim(" (new)") : ""));
      return;
    }
    const d = it.kind === "profile" ? plan.remote.profile : plan.remote.instructions;
    if (!d) return;
    writeAtomic(p[it.kind], d.text);
    remember(it, d.hash);
    res.pulled.push(it.label);
  };

  /** Upload; a 409 (someone changed it since) becomes a conflict copy. `base` undefined overwrites. */
  const push = async (it: Item, base: string | null | undefined) => {
    if (it.kind === "skill") {
      const s = readSkill(join(p.skills, it.name), it.name)!;
      const r = await client.call<ContextSkillMeta | { error: string; current: ContextSkillMeta | null }>("PUT", `/context/skills/${encodeURIComponent(it.name)}`, { body: s.body, files: s.files, ...(base === undefined ? {} : { base }) }, [409]);
      if ("error" in r) return conflict(it);
      remember(it, r.hash);
      res.pushed.push(it.label);
      for (const f of s.skipped) res.notes.push(`${it.label}: ${f.path} stays on this machine (${f.why})`);
      return;
    }
    const text = localDoc(p[it.kind])!;
    if (it.kind === "profile" && text.length > PROFILE_MAX) {
      res.notes.push(`${it.label} has ${text.length.toLocaleString("en")} characters; 0bridge keeps at most ${PROFILE_MAX.toLocaleString("en")}. Shorten it, then ${c.cyan("0b context push")}`);
      return;
    }
    const r = await client.call<ContextDoc | { error: string; current: ContextDoc | null }>("PUT", `/context/${it.kind}`, { text, ...(base === undefined ? {} : { base }) }, [409]);
    if ("error" in r) return conflict(it, r.current?.text);
    remember(it, r.hash);
    res.pushed.push(it.label);
  };

  const conflict = async (it: Item, remoteText?: string) => {
    const copy = await conflictCopy(ctx, client, it, remoteText);
    res.conflicts.push(`${it.label} (0bridge's copy: ${copy})`);
  };

  for (const it of plan.items) {
    const a = it.action;
    if (a === "none") {
      if (it.local === null && it.remote === null) remember(it, null); // gone on both sides
      continue;
    }
    if (a === "same") {
      remember(it, it.local);
      continue;
    }
    if (a === "delete-local") {
      if (mode === "push") {
        res.waiting.push(`${it.label} ${c.dim("(removed on 0bridge)")}`);
        continue;
      }
      rmSync(join(p.skills, it.name), { recursive: true, force: true });
      if (m?.skills[it.name]) (delete m.skills[it.name], (manifestChanged = true));
      remember(it, null);
      res.removed.push(it.label);
      continue;
    }
    if (a === "pull" || (a === "conflict" && mode === "pull" && force)) {
      if (mode === "push" && !force) res.waiting.push(`${it.label} ${c.dim("(newer on 0bridge)")}`);
      else if (mode === "push") it.local !== null && (await push(it, undefined));
      else await pull(it);
      continue;
    }
    if (a === "push" || (a === "conflict" && mode === "push" && force)) {
      if (mode === "pull") res.waiting.push(`${it.label} ${c.dim("(changed here)")}`);
      else await push(it, force ? undefined : it.base);
      continue;
    }
    // Both changed: keep this machine's, put 0bridge's next to it.
    await conflict(it);
  }
  if (manifestChanged && m) saveManifest(ctx, m);
  saveState(ctx, userId, { ...state, lastSync: Date.now() });
  return res;
}

function report(r: Report, opts: { quiet?: boolean; mode: Mode | "profile" }) {
  if (opts.quiet && !r.conflicts.length) return;
  for (const x of r.pulled) console.log(`${c.green("↓")} ${x}`);
  for (const x of r.pushed) console.log(`${c.green("↑")} ${x}`);
  for (const x of r.removed) console.log(`${c.dim("✕")} ${x} ${c.dim("(removed on 0bridge)")}`);
  for (const x of r.conflicts) console.log(`${c.yellow("!")} ${x} ${c.dim("— changed here and on 0bridge. Merge them, then `0b context push --force`")}`);
  if (opts.quiet) return;
  for (const x of r.waiting) console.log(`${c.dim("·")} ${x} ${c.dim(opts.mode === "pull" ? "— `0b context push` sends it" : "— `0b context pull` gets it")}`);
  for (const x of r.notes) console.log(c.yellow(`  ${x}`));
  if (!r.pulled.length && !r.pushed.length && !r.removed.length && !r.conflicts.length && !r.waiting.length) console.log(c.dim("Up to date."));
  if (r.pulled.length || r.removed.length) console.log(c.dim(`Run ${c.cyan("0b apply")} to put them in your AI tools.`));
}

const STATE_LABEL: Record<SyncAction, string> = {
  same: "synced",
  none: "",
  push: "changed here — `0b context push`",
  pull: "newer on 0bridge — `0b context pull`",
  conflict: "changed here and on 0bridge",
  "delete-local": "removed on 0bridge — `0b context pull`",
};

async function status(ctx: Context, client: CloudClient, userId: string): Promise<void> {
  const plan = await planContext(ctx, client, userId);
  const shown = plan.items.filter((it) => it.local !== null || it.remote !== null);
  if (!shown.length) {
    console.log(`Nothing on 0bridge or here yet. Write your profile with ${c.cyan("0b context profile")}, or send your instructions and skills with ${c.cyan("0b context push")}.`);
    return;
  }
  for (const it of shown) {
    const where = it.local === null ? c.yellow("only on 0bridge — `0b context pull`") : it.remote === null && it.action === "push" ? c.yellow("only here — `0b context push`") : it.action === "same" ? c.green("synced") : c.yellow(STATE_LABEL[it.action]);
    console.log(`  ${it.label.padEnd(36)} ${where}`);
  }
  const n = plan.remote.memory.count;
  console.log(c.dim(`\nMemory: ${n} item${n === 1 ? "" : "s"} (${c.cyan("0b memory search")})`));
}

/** Open the profile in the user's editor (a short outline the first time), then push it. */
async function editProfile(ctx: Context, client: CloudClient, userId: string, opts: ContextOptions): Promise<void> {
  const path = contextPaths(ctx).profile;
  if (!existsSync(path)) {
    // 0bridge's copy first, if another machine wrote one (and it's the base of this edit).
    const remote = (await client.call<ContextOverview>("GET", "/context")).profile;
    writeAtomic(path, remote?.text ?? PROFILE_TEMPLATE);
    if (remote) saveState(ctx, userId, { ...(loadStates(ctx)[userId] ?? { instructions: null, skills: {} }), profile: remote.hash });
  }
  const before = readText(path);
  const editor = shellSplit(process.env.VISUAL || process.env.EDITOR || (process.platform === "win32" ? "notepad" : "vi"));
  const r = spawnSync(editor[0]!, [...editor.slice(1), path], { stdio: "inherit", shell: false });
  if (r.error || r.status !== 0) fail(`couldn't run ${editor[0]} (set $EDITOR); the profile is ${tilde(ctx, path)}`);
  const after = readText(path) ?? "";
  if (after === PROFILE_TEMPLATE) return console.log(c.dim("The profile is still the outline; nothing sent."));
  if (after.length > PROFILE_MAX) fail(`the profile has ${after.length.toLocaleString("en")} characters; 0bridge keeps at most ${PROFILE_MAX.toLocaleString("en")}. Shorten it, then run ${c.cyan("0b context push")}`);
  const plan = await planContext(ctx, client, userId, "profile");
  report(await run(ctx, client, userId, plan, "push", opts.force), { mode: "profile" });
  if (after !== before || plan.items[0]?.action === "push") console.log(c.dim("Chat apps connected to 0bridge see its start in their instructions; every AI app can read it with bridge__profile."));
}

async function confirm(q: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${q} [y/N] `)).trim().toLowerCase();
  rl.close();
  return a === "y" || a === "yes";
}

/** Remove a skill everywhere: from 0bridge, from this machine, and (on their next sync) from the others. */
async function removeSkill(ctx: Context, client: CloudClient, userId: string, name: string, opts: ContextOptions): Promise<void> {
  if (!opts.yes && !(await confirm(`Remove the skill ${name} from 0bridge, this machine and your other machines?`))) fail("not removed (pass --yes to remove without asking)");
  const r = await client.call<{ deleted?: boolean; error?: string }>("DELETE", `/context/skills/${encodeURIComponent(name)}`, undefined, [404]);
  const dir = join(contextPaths(ctx).skills, name);
  const here = existsSync(dir);
  rmSync(dir, { recursive: true, force: true });
  const m = loadManifest(ctx);
  if (m?.skills[name]) (delete m.skills[name], saveManifest(ctx, m));
  const states = loadStates(ctx);
  const s = states[userId];
  if (s) (delete s.skills[name], saveState(ctx, userId, s));
  if (!r.deleted && !here) fail(`no skill ${name} on 0bridge or here`);
  console.log(`${c.green("✓")} Removed ${name}${r.deleted ? "" : c.dim(" (it wasn't on 0bridge)")}. ${here ? `Run ${c.cyan("0b apply")} to take it out of your AI tools.` : ""}`.trimEnd());
}

export async function contextCommand(ctx: Context, args: string[], opts: ContextOptions): Promise<void> {
  const [sub, ...rest] = args;
  const { cfg, client } = cloudClient(ctx);
  switch (sub) {
    case undefined:
    case "status":
      return status(ctx, client, cfg.userId);
    case "push":
    case "pull":
    case "sync": {
      const plan = await planContext(ctx, client, cfg.userId);
      report(await run(ctx, client, cfg.userId, plan, sub, opts.force), { quiet: opts.quiet, mode: sub });
      return;
    }
    case "profile":
      return editProfile(ctx, client, cfg.userId, opts);
    case "rm":
      if (!rest[0]) fail("usage: 0b context rm <skill> (removes it from 0bridge and from your machines)");
      return removeSkill(ctx, client, cfg.userId, rest[0], opts);
    default:
      fail(`unknown subcommand "context ${sub}". Try: 0b context status | push | pull | sync | profile | rm <skill>`);
  }
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export async function memoryCommand(ctx: Context, args: string[], opts: ContextOptions): Promise<void> {
  const [sub, ...rest] = args;
  const { client } = cloudClient(ctx);
  switch (sub) {
    case "add": {
      const text = rest.join(" ").trim();
      if (!text) fail('usage: 0b memory add <text> [--tags a,b] (e.g. 0b memory add "Prefers pnpm over npm")');
      const r = await client.call<MemoryItem>("POST", "/context/memory", { text, ...(opts.tags ? { tags: opts.tags } : {}) });
      console.log(`${c.green("✓")} Remembered ${c.dim(r.id)}${r.text !== text ? c.dim(" (a credential in it was masked)") : ""}`);
      console.log(c.dim("Every AI app connected to 0bridge can find it with bridge__memory_search."));
      return;
    }
    case undefined:
    case "list":
    case "search": {
      const q = rest.join(" ").trim();
      const items = await client.call<MemoryItem[]>("GET", `/context/memory?${new URLSearchParams({ ...(q ? { q } : {}), limit: "30" })}`);
      if (!items.length) return console.log(c.dim(q ? `Nothing remembered matches "${q}".` : `Nothing remembered yet. Add something: ${c.cyan('0b memory add "…"')}`));
      for (const m of items)
        console.log(`${c.dim(m.id)}  ${m.text.replace(/\s*\n\s*/g, " ")}\n  ${c.dim([day(m.updatedAt), m.source && `from ${m.source}`, m.tags.length && m.tags.map((t) => `#${t}`).join(" ")].filter(Boolean).join(" · "))}`);
      return;
    }
    case "rm":
    case "forget": {
      if (!rest.length) fail("usage: 0b memory rm <id>… (ids from 0b memory search)");
      for (const id of rest) {
        const r = await client.call<{ deleted?: boolean }>("DELETE", `/context/memory/${encodeURIComponent(id)}`, undefined, [404]);
        console.log(r.deleted ? `${c.green("✓")} Forgot ${id}` : c.yellow(`No remembered item ${id}`));
      }
      return;
    }
    default:
      fail(`unknown subcommand "memory ${sub}". Try: 0b memory add <text> | search [words] | rm <id>`);
  }
}

/**
 * Pull then push the profile, instructions and skills when either side changed (the background job
 * runs it). Only once this account has used `0b context` here: nothing goes to 0bridge unasked.
 */
export async function syncContext(ctx: Context, opts: { quiet?: boolean }): Promise<void> {
  let account;
  try {
    account = cloudClient(ctx);
  } catch {
    return; // not signed in
  }
  const { cfg, client } = account;
  if (!loadStates(ctx)[cfg.userId]) return;
  try {
    const plan = await planContext(ctx, client, cfg.userId);
    if (plan.items.every((it) => it.action === "none" || it.action === "same")) return;
    report(await run(ctx, client, cfg.userId, plan, "sync"), { quiet: opts.quiet, mode: "sync" });
  } catch (e) {
    if (!opts.quiet) throw e;
    // The background job keeps going; the next run tries again.
    if (!(e instanceof CloudError && e.status === 0)) console.error(`context sync: ${e instanceof Error ? e.message : String(e)}`);
  }
}
