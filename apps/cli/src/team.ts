import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  PRESETS,
  addManaged,
  applyBlock,
  claudeMirrors,
  copySkill,
  getAdapters,
  hasBlock,
  isInstalled,
  loadManifest,
  loadState,
  paths,
  readJson,
  readText,
  saveManifest,
  saveState,
  targets,
  toolEnabled,
  toolInstructions,
  writeAtomic,
  type Adapter,
  type CloudClient,
  type Context,
  type ContextDoc,
  type ContextSkillMeta,
  type Manifest,
} from "@0bridge/core";
import { cloudClient, connectCommand } from "./cloud.ts";
import { c } from "./ui.ts";

/**
 * What your teams share (M8-2, M8-3) on this machine. Their skills sit next to yours in
 * ~/.0bridge/skills as `<team>--<skill>` (never over one of yours, and never sent back as yours by
 * `0b context`); their instructions in ~/.0bridge/teams/<team>.md, which every tool's instructions
 * block gets after yours. Only ever copied from 0bridge: a team's admins change them on the
 * dashboard, and one they remove leaves this machine and its AI tools on the next sync (`0b team`,
 * `0b context pull|sync`, the background job). `0b connect --team` connects the team's connectors
 * you don't have yet, each with your own account.
 */

export interface TeamView {
  id: string;
  name: string;
  key: string;
  role: string;
  admin: boolean;
  paid: boolean;
  writable: boolean;
  connectors: { service: string; title: string; connected: boolean }[];
  instructions: ContextDoc | null;
  skills: (ContextSkillMeta & { as: string })[];
}

/** What this machine has of one team: the skills it wrote (their names here → 0bridge's hash) and its instructions' hash. */
interface TeamCopy {
  key: string;
  name: string;
  instructions: string | null;
  skills: Record<string, string>;
}
/** Per account (user id), per workspace id. */
type TeamStates = Record<string, Record<string, TeamCopy>>;
const statePath = (ctx: Context) => join(ctx.storeDir, "team.json");
const loadStates = (ctx: Context) => readJson<TeamStates>(statePath(ctx)) ?? {};

/** Every team skill on this machine, whichever account it came with: `0b context` leaves these alone. */
export function teamSkillNames(ctx: Context): Set<string> {
  return new Set(Object.values(loadStates(ctx)).flatMap((teams) => Object.values(teams).flatMap((t) => Object.keys(t.skills))));
}

/** SKILL.md under the name members see it by, so each AI tool lists it as the team's (and it never shadows one of yours). */
export function asTeamSkill(md: string, name: string, description: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(md);
  const fm = m?.[1] ?? "";
  let next = /^name:.*$/m.test(fm) ? fm.replace(/^name:.*$/m, `name: ${name}`) : `name: ${name}${fm ? `\n${fm}` : ""}`;
  if (description && !/^description:/m.test(next)) next += `\ndescription: ${JSON.stringify(description)}`;
  return `---\n${next}\n---\n${m ? md.slice(m[0].length) : `\n${md}`}`;
}

/** A team's section of the instructions: its name, then what its admins wrote. */
export const teamSection = (name: string, text: string) => `## Team ${name}\n\n<!-- from 0bridge: the team's admins change this on the dashboard -->\n\n${text.trim()}\n`;

export interface TeamReport {
  /** The account's teams as 0bridge has them now. */
  teams: TeamView[];
  added: string[];
  updated: string[];
  removed: string[];
  instructions: string[];
  notes: string[];
}

/** Write one team skill from 0bridge into `dir`: SKILL.md (under its team name) and its files; files it no longer has go. */
async function writeTeamSkill(client: CloudClient, team: TeamView, s: TeamView["skills"][number], dir: string): Promise<void> {
  const full = await client.call<{ body: string; files: Record<string, string> }>("GET", `/team/${encodeURIComponent(team.id)}/skills/${encodeURIComponent(s.name)}`);
  rmSync(dir, { recursive: true, force: true });
  for (const [path, text] of [["SKILL.md", asTeamSkill(full.body, s.as, s.description)], ...Object.entries(full.files)] as const) {
    // 0bridge only stores relative paths without `..`; never write outside the skill's folder anyway.
    if (isAbsolute(path) || relative(dir, join(dir, path)).startsWith("..")) continue;
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeAtomic(join(dir, path), text);
  }
}

/**
 * Bring this machine's copy of the account's teams up to date with 0bridge, then the AI tools: a
 * team skill goes into (or out of) each tool 0bridge manages skills in, and the instructions block
 * of each tool that already has one is rewritten. The rest waits for `0b apply`, as usual.
 */
export async function syncTeams(ctx: Context, client: CloudClient, userId: string): Promise<TeamReport> {
  // A server from before team workspaces shared anything: nothing to bring, nothing to take away.
  const got = await client.call<TeamView[] | { error: string }>("GET", "/team", undefined, [404]);
  const teams = Array.isArray(got) ? got : [];
  const res: TeamReport = { teams, added: [], updated: [], removed: [], instructions: [], notes: [] };
  if (!Array.isArray(got)) return res;
  const states = loadStates(ctx);
  const prev = states[userId] ?? {};
  const next: Record<string, TeamCopy> = {};
  const skillsDir = paths(ctx).skills;
  const teamsDir = paths(ctx).teams;
  const mine = teamSkillNames(ctx);
  const m = loadManifest(ctx);

  for (const t of teams) {
    const was = prev[t.id];
    const copy: TeamCopy = { key: t.key, name: t.name, instructions: null, skills: {} };
    for (const s of t.skills) {
      const dir = join(skillsDir, s.as);
      const had = was?.skills[s.as];
      if (had === s.hash && existsSync(join(dir, "SKILL.md"))) {
        copy.skills[s.as] = s.hash;
        continue;
      }
      // A skill of the user's own already has this name: theirs stays.
      if (existsSync(dir) && !had && !mine.has(s.as)) {
        res.notes.push(`team ${t.name}'s skill ${s.name} isn't copied: ${s.as} is already one of your skills`);
        continue;
      }
      await writeTeamSkill(client, t, s, dir);
      copy.skills[s.as] = s.hash;
      if (m) m.skills[s.as] ??= {};
      (had ? res.updated : res.added).push(s.as);
    }
    for (const name of Object.keys(was?.skills ?? {})) if (!(name in copy.skills)) res.removed.push(name);
    const file = join(teamsDir, `${t.key}.md`);
    if (was && was.key !== t.key) rmSync(join(teamsDir, `${was.key}.md`), { force: true });
    if (t.instructions) {
      const text = teamSection(t.name, t.instructions.text);
      if (readText(file) !== text) (writeAtomic(file, text), res.instructions.push(`team ${t.name}`));
      copy.instructions = t.instructions.hash;
    } else if (existsSync(file)) (rmSync(file, { force: true }), res.instructions.push(`team ${t.name} ${c.dim("(removed)")}`));
    next[t.id] = copy;
  }
  // Teams the account left (or that were deleted): everything of theirs goes.
  for (const [id, was] of Object.entries(prev)) {
    if (next[id]) continue;
    res.removed.push(...Object.keys(was.skills));
    if (existsSync(join(teamsDir, `${was.key}.md`))) (rmSync(join(teamsDir, `${was.key}.md`), { force: true }), res.instructions.push(`team ${was.name} ${c.dim("(left)")}`));
  }
  for (const name of res.removed) {
    rmSync(join(skillsDir, name), { recursive: true, force: true });
    if (m) delete m.skills[name];
  }
  if (m && (res.added.length || res.removed.length)) saveManifest(ctx, m);
  writeAtomic(statePath(ctx), JSON.stringify({ ...states, [userId]: next }, null, 1) + "\n", { mode: 0o600 });
  if (m) intoTools(ctx, m, res);
  return res;
}

/** The team's changes, into the AI tools right away (only what 0bridge manages there; `0b apply` does the same later). */
function intoTools(ctx: Context, m: Manifest, r: TeamReport): void {
  const changed = [...r.added, ...r.updated];
  if (!changed.length && !r.removed.length && !r.instructions.length) return;
  const state = loadState(ctx);
  const adapters = getAdapters(ctx);
  const skills = (a: Adapter, managed: string[]) => {
    if (!a.skillsDir) return;
    for (const name of r.removed) {
      if (!managed.includes(name)) continue;
      rmSync(join(a.skillsDir, name), { recursive: true, force: true });
      managed.splice(managed.indexOf(name), 1);
    }
    for (const name of changed) {
      const dst = join(a.skillsDir, name);
      // A folder 0bridge didn't put there stays as it is.
      if (existsSync(dst) && !managed.includes(name)) continue;
      copySkill(join(paths(ctx).skills, name), dst);
      addManaged(managed, name);
    }
  };
  const instructions = (a: Adapter, canonical: string) => {
    if (!a.instructionsPath || !r.instructions.length) return;
    const cur = readText(a.instructionsPath);
    if (cur === null || !hasBlock(cur)) return;
    const out = applyBlock(cur, canonical);
    if (out !== cur) writeAtomic(a.instructionsPath, out);
  };
  for (const [id, a] of Object.entries(adapters) as [keyof typeof adapters, Adapter][]) {
    if (!toolEnabled(m, id) || !isInstalled(a)) continue;
    const managed = (state.managed[id] ??= { mcp: [], skills: [] }).skills;
    skills(a, managed);
    instructions(a, m.instructions.enabled && targets(m.instructions, id) ? toolInstructions(ctx) : "");
  }
  // Other Claude Code folders get what ~/.claude gets, judged by what 0bridge had put in ~/.claude.
  if (toolEnabled(m, "claude"))
    for (const a of claudeMirrors(ctx)) {
      skills(a, [...(loadState(ctx).managed.claude?.skills ?? [])]);
      instructions(a, m.instructions.enabled && targets(m.instructions, "claude") ? toolInstructions(ctx) : "");
    }
  saveState(ctx, state);
}

export function reportTeams(r: TeamReport, opts: { quiet?: boolean } = {}): boolean {
  const any = r.added.length + r.updated.length + r.removed.length + r.instructions.length > 0;
  if (opts.quiet) return any;
  for (const x of r.added) console.log(`${c.green("↓")} skill ${x} ${c.dim("(team, new)")}`);
  for (const x of r.updated) console.log(`${c.green("↓")} skill ${x} ${c.dim("(team)")}`);
  for (const x of r.removed) console.log(`${c.dim("✕")} skill ${x} ${c.dim("(removed by the team)")}`);
  for (const x of r.instructions) console.log(`${c.green("↓")} instructions of ${x}`);
  for (const x of r.notes) console.log(c.yellow(`  ${x}`));
  return any;
}

/** `0b team`: your teams, what they share, which of their connectors you have; and bring their skills and instructions here. */
export async function teamCommand(ctx: Context, args: string[]): Promise<void> {
  const [sub] = args;
  if (sub && sub !== "sync" && sub !== "status") {
    console.error(c.red(`error: unknown subcommand "team ${sub}". Try: 0b team [sync] | 0b connect --team`));
    process.exit(1);
  }
  const { cfg, client } = cloudClient(ctx);
  const r = await syncTeams(ctx, client, cfg.userId);
  const { teams } = r;
  if (!teams.length) return console.log(`You're not in a team workspace. An admin invites you from the dashboard (${cfg.server.replace(/\/+$/, "")}/app/team).`);
  for (const t of teams) {
    console.log(`${c.bold(t.name)} ${c.dim(`· ${t.role}${t.paid ? "" : " · subscription not active: read-only"}`)}`);
    if (t.connectors.length) console.log(`  connectors    ${t.connectors.map((x) => (x.connected ? c.green(`✓ ${x.service}`) : c.yellow(`○ ${x.service}`))).join("  ")}`);
    if (t.skills.length) console.log(`  skills        ${t.skills.map((s) => s.as).join(", ")}`);
    if (t.instructions) console.log(`  instructions  ${c.dim(`${t.instructions.text.trim().split("\n").length} lines`)}`);
    if (!t.connectors.length && !t.skills.length && !t.instructions) console.log(c.dim("  nothing shared yet"));
  }
  if (reportTeams(r)) console.log(c.dim(`In your AI tools now; run ${c.cyan("0b apply")} if one doesn't have them yet.`));
  if (teams.some((t) => t.connectors.some((x) => !x.connected))) console.log(`\nConnect the ones you don't have: ${c.cyan("0b connect --team")}`);
}

/** `0b connect --team`: every connector your teams use that you haven't connected, one by one, each with your own account. */
export async function connectTeam(ctx: Context, opts: { yes?: boolean } = {}): Promise<void> {
  const teams = await cloudClient(ctx).client.call<TeamView[]>("GET", "/team");
  if (!teams.length) return console.log("You're not in a team workspace, so there are no team connectors.");
  const all = [...new Set(teams.flatMap((t) => t.connectors.map((x) => x.service)))];
  const missing = [...new Set(teams.flatMap((t) => t.connectors.filter((x) => !x.connected).map((x) => x.service)))];
  if (!all.length) return console.log("Your team hasn't picked any connectors yet.");
  if (!missing.length) return console.log(`${c.green("✓")} You have every connector your team uses (${all.join(", ")}).`);
  console.log(`Your team uses ${all.join(", ")}. Connecting the ${missing.length} you don't have, one by one, each with your own account:`);
  const done: string[] = [];
  const failed: string[] = [];
  for (const service of missing) {
    console.log(`\n${c.bold(service)}`);
    try {
      // The team picked 0bridge's connector for it: no menu of other ways in.
      await connectCommand(ctx, service, PRESETS[service], { yes: opts.yes, known: true });
      done.push(service);
    } catch (e) {
      failed.push(service);
      console.error(c.red(`  ${e instanceof Error ? e.message : String(e)}`));
    }
  }
  console.log(`\n${done.length ? `${c.green("✓")} ${done.join(", ")}` : ""}${failed.length ? `${done.length ? "  " : ""}${c.yellow(`not connected: ${failed.join(", ")}`)} ${c.dim("(run 0b connect --team again)")}` : ""}`);
}
