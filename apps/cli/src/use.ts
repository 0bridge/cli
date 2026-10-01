import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import {
  AGENT_HOME_VAR,
  AGENT_LABEL,
  AGENT_TOOLS,
  PROFILE_NAME,
  agentHome,
  agentProfileFor,
  agentProfiles,
  findAgentProfile,
  loadAgentProfiles,
  readJson,
  repoOf,
  saveAgentProfiles,
  type AgentTool,
  type Context,
} from "@0bridge/core";
import { binDir, renderShim } from "./profile.ts";
import { c, tilde } from "./ui.ts";

/**
 * `0b use` (M4): which Claude Code or Codex account a repo, a shell or the whole machine starts
 * with. An account is a config folder (agent-profiles.ts); the tool reads CLAUDE_CONFIG_DIR or
 * CODEX_HOME once, when it starts, so the choice reaches it through whatever starts it: the shims
 * (`0b use shims`: ~/.0bridge/bin/claude and codex run `0b exec`), `0b exec -- claude`, or the
 * shell's own variable (`eval "$(0b use work --shell)"`), which wins over the others. A running
 * session keeps its account.
 */

function fail(msg: string): never {
  console.error(c.red(`error: ${msg}`));
  process.exit(1);
}

const RESERVED = new Set(["add", "rm", "remove", "list", "ls", "shims", "default"]);
const SHIMS: AgentTool[] = ["claude", "codex"];

export interface UseOptions {
  tool?: string;
  dir?: string;
  global?: boolean;
  shell?: boolean;
}

function toolsOf(opts: UseOptions): AgentTool[] | null {
  if (!opts.tool) return null;
  if (!AGENT_TOOLS.includes(opts.tool as AgentTool)) fail(`--tool is claude or codex`);
  return [opts.tool as AgentTool];
}

const expand = (ctx: Context, p: string) => resolve(p === "~" ? ctx.home : p.startsWith("~/") ? join(ctx.home, p.slice(2)) : p);

/** Who a Claude Code folder is signed in as: the email its .claude.json shows (no credential is read). */
function signedInAs(dir: string, tool: AgentTool, ctx: Context): string | null {
  if (tool !== "claude") return null;
  const file = resolve(dir) === resolve(agentHome(ctx, "claude")) ? join(ctx.home, ".claude.json") : join(dir, ".claude.json");
  try {
    return readJson<{ oauthAccount?: { emailAddress?: string } }>(file)?.oauthAccount?.emailAddress ?? null;
  } catch {
    return null;
  }
}

const shimsOn = (ctx: Context) => SHIMS.every((t) => isOurShim(join(binDir(ctx), renderShim(t).file)));
const onPath = (ctx: Context) => (process.env.PATH ?? "").split(delimiter).some((d) => resolve(d) === resolve(binDir(ctx)));
const isOurShim = (file: string) => existsSync(file) && readFileSync(file, "utf8").split("\n").slice(0, 3).join("\n").includes("0bridge");

function list(ctx: Context) {
  const cwd = process.cwd();
  for (const tool of AGENT_TOOLS) {
    const profiles = [{ tool, name: "default", dir: agentHome(ctx, tool) }, ...agentProfiles(ctx, tool)];
    if (!existsSync(agentHome(ctx, tool)) && profiles.length === 1) continue;
    const here = agentProfileFor(ctx, tool, cwd);
    console.log(c.bold(AGENT_LABEL[tool]));
    for (const p of profiles) {
      const active = here ? here.dir === resolve(p.dir) : p.name === "default";
      const who = signedInAs(p.dir, tool, ctx);
      const why = active && here ? c.dim(`  ← ${here.from === "shell" ? `this shell (${AGENT_HOME_VAR[tool]})` : here.from === "repo" ? "this repo" : "everywhere (--global)"}`) : "";
      console.log(`  ${active ? c.green("●") : " "} ${p.name.padEnd(12)} ${c.dim(tilde(ctx, p.dir).padEnd(24))} ${who ?? ""}${why}`);
    }
  }
  const cfg = loadAgentProfiles(ctx);
  if (!AGENT_TOOLS.some((t) => agentProfiles(ctx, t, cfg).length)) {
    console.log(`\nOne account each so far. ${c.cyan("0b use add work")} makes a second Claude Code account (${c.cyan("--tool codex")} for Codex).`);
    return;
  }
  if (!shimsOn(ctx)) console.log(c.dim(`\nA repo's pick reaches claude and codex through ${c.cyan("0b use shims")} or ${c.cyan("0b exec -- claude")}.`));
  else if (!onPath(ctx)) console.log(c.yellow(`\nThe shims are in ${binDir(ctx)}, which isn't on your PATH yet (0b use shims says how).`));
}

function add(ctx: Context, name: string | undefined, opts: UseOptions) {
  if (!name || !PROFILE_NAME.test(name) || RESERVED.has(name)) fail("usage: 0b use add <name> [--tool claude|codex] [--dir <folder>]   (name: lowercase letters, digits, - _)");
  const tool: AgentTool = toolsOf(opts)?.[0] ?? "claude";
  const dir = expand(ctx, opts.dir ?? `~/.${tool}-${name}`);
  if (dir === resolve(agentHome(ctx, tool))) fail(`${tilde(ctx, dir)} is ${AGENT_LABEL[tool]}'s own folder (the profile "default")`);
  const known = findAgentProfile(ctx, tool, name);
  if (known && known.dir !== dir) fail(`${AGENT_LABEL[tool]} already has a profile "${name}" at ${tilde(ctx, known.dir)}`);
  const taken = agentProfiles(ctx, tool).find((p) => p.dir === dir && p.name !== name);
  if (taken) fail(`${tilde(ctx, dir)} is already the profile "${taken.name}"`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const cfg = loadAgentProfiles(ctx);
  (cfg.profiles[tool] ??= {})[name] = dir;
  saveAgentProfiles(ctx, cfg);
  const v = AGENT_HOME_VAR[tool];
  console.log(`${c.green("✓")} ${AGENT_LABEL[tool]} profile ${c.bold(name)} in ${tilde(ctx, dir)}`);
  console.log(`\n${c.bold("Sign in")} ${c.dim("(once, in your terminal)")}`);
  if (tool === "claude") console.log(`  ${c.cyan(withVar(v, tilde(ctx, dir), "claude"))}, then ${c.cyan("/login")} with the other account`);
  else console.log(`  ${c.cyan(withVar(v, tilde(ctx, dir), "codex login"))}`);
  const w = Math.max("0b apply".length, `0b use ${name}`.length) + 2;
  console.log(`\n${c.bold("Then")}`);
  console.log(`  ${c.cyan("0b apply".padEnd(w))}gives it your MCP servers, skills and instructions`);
  console.log(`  ${c.cyan(`0b use ${name}`.padEnd(w))}in a repo: that repo starts ${AGENT_LABEL[tool]} as ${name} (${c.cyan(`--global`)}: everywhere; ${c.cyan("--shell")}: this shell)`);
  if (tool === "claude" && process.platform === "darwin")
    console.log(c.dim(`\nOn a Mac, Claude Code keeps its sign-in in the keychain. Check with ${c.cyan("0b use")} that each profile shows its own email before relying on it.`));
}

function remove(ctx: Context, name: string | undefined, opts: UseOptions) {
  if (!name) fail("usage: 0b use rm <name> [--tool claude|codex]");
  const cfg = loadAgentProfiles(ctx);
  const tools = (toolsOf(opts) ?? AGENT_TOOLS).filter((t) => findAgentProfile(ctx, t, name));
  if (!tools.length || name === "default") fail(`no profile "${name}" (0b use lists them)`);
  for (const tool of tools) {
    const registered = cfg.profiles[tool]?.[name];
    if (!registered) {
      console.log(c.yellow(`  ${AGENT_LABEL[tool]}: ${tilde(ctx, findAgentProfile(ctx, tool, name)!.dir)} is found by its name, not registered: rename or delete that folder to remove it`));
      continue;
    }
    delete cfg.profiles[tool]![name];
    cfg.repos = cfg.repos.filter((r) => !(r.tool === tool && r.profile === name));
    if (cfg.defaults?.[tool] === name) delete cfg.defaults[tool];
    console.log(`${c.green("✓")} ${AGENT_LABEL[tool]}: forgot ${name}. Its folder ${tilde(ctx, registered)} (and its sign-in) stays; repos that used it start with the default again.`);
  }
  saveAgentProfiles(ctx, cfg);
}

/** `export VAR='…'` lines for `eval` (PowerShell's form on Windows). */
/** `cmd` run once with `v` set, as the user's shell writes it: PowerShell on Windows (where ~ is $HOME). */
export function withVar(v: string, dir: string, cmd: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `$env:${v}="${dir.replace(/^~(?=[\\/]|$)/, "$HOME")}"; ${cmd}` : `${v}=${dir} ${cmd}`;
}

export function shellLines(vars: Record<string, string | null>, platform: NodeJS.Platform = process.platform): string[] {
  const q = (v: string) => `'${v.replace(/'/g, platform === "win32" ? "''" : `'\\''`)}'`;
  return Object.entries(vars).map(([k, v]) => (platform === "win32" ? (v == null ? `Remove-Item Env:${k} -ErrorAction SilentlyContinue` : `$env:${k} = ${q(v)}`) : v == null ? `unset ${k}` : `export ${k}=${q(v)}`));
}

function pick(ctx: Context, name: string, opts: UseOptions) {
  const asked = toolsOf(opts);
  const tools = asked ?? AGENT_TOOLS.filter((t) => name === "default" || findAgentProfile(ctx, t, name));
  if (!tools.length) fail(`no profile "${name}": 0b use add ${name} makes one (0b use lists them)`);
  for (const t of tools) if (!findAgentProfile(ctx, t, name)) fail(`${AGENT_LABEL[t]} has no profile "${name}" (0b use add ${name} --tool ${t})`);

  if (opts.shell) {
    const vars = Object.fromEntries(tools.map((t) => [AGENT_HOME_VAR[t], name === "default" ? null : findAgentProfile(ctx, t, name)!.dir]));
    for (const line of shellLines(vars)) console.log(line);
    if (process.stderr.isTTY) console.error(c.dim(`# eval "$(0b use ${name} --shell)" applies this to the current shell`));
    return;
  }

  const cfg = loadAgentProfiles(ctx);
  if (opts.global) {
    for (const t of tools) {
      if (name === "default") delete cfg.defaults?.[t];
      else (cfg.defaults ??= {})[t] = name;
    }
    if (cfg.defaults && !Object.keys(cfg.defaults).length) delete cfg.defaults;
    saveAgentProfiles(ctx, cfg);
    console.log(`${c.green("✓")} ${tools.map((t) => AGENT_LABEL[t]).join(" and ")} start${tools.length === 1 ? "s" : ""} as ${c.bold(name)} everywhere, except in repos that picked their own.`);
  } else {
    const inRepo = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { encoding: "utf8" }).stdout?.trim() === "true";
    if (!inRepo) fail(`run this in a repo, or add --global (every repo) or --shell (this shell: eval "$(0b use ${name} --shell)")`);
    const repo = repoOf(process.cwd());
    for (const t of tools) {
      cfg.repos = cfg.repos.filter((r) => !(r.tool === t && (r.path === repo.path || (repo.remote && r.remote === repo.remote))));
      // "default" only needs saying here when the machine's default is another profile.
      if (name !== "default" || cfg.defaults?.[t]) cfg.repos.push({ path: repo.path, ...(repo.remote ? { remote: repo.remote } : {}), tool: t, profile: name });
    }
    saveAgentProfiles(ctx, cfg);
    console.log(`${c.green("✓")} ${c.bold(repo.remote ?? repo.path)}: ${tools.map((t) => AGENT_LABEL[t]).join(" and ")} start${tools.length === 1 ? "s" : ""} as ${c.bold(name)} here (other clones of it too).`);
  }
  const shadowed = tools.filter((t) => process.env[AGENT_HOME_VAR[t]]);
  if (shadowed.length) console.log(c.yellow(`  This shell sets ${shadowed.map((t) => AGENT_HOME_VAR[t]).join(", ")}, which wins: unset it (eval "$(0b use default --shell)") to follow this choice.`));
  if (!shimsOn(ctx)) console.log(c.dim(`  It applies when 0b starts the tool: ${c.cyan("0b use shims")} once (then plain claude and codex do), or ${c.cyan("0b exec -- claude")}.`));
  else if (!onPath(ctx)) console.log(c.yellow(`  Put ${binDir(ctx)} on your PATH so plain claude and codex use it (0b use shims says how).`));
  console.log(c.dim(`  Running sessions keep their account. To carry one over: 0b resume <0b:id> in a new session.`));
}

function shims(ctx: Context, off: boolean) {
  const dir = binDir(ctx);
  if (off) {
    for (const t of SHIMS) {
      const f = join(dir, renderShim(t).file);
      if (isOurShim(f)) rmSync(f);
    }
    return console.log(`${c.green("✓")} claude and codex start as before (the shims are gone).`);
  }
  mkdirSync(dir, { recursive: true });
  for (const t of SHIMS) {
    const s = renderShim(t);
    const f = join(dir, s.file);
    writeFileSync(f, s.body.replace("this repo's profile (0b profile)", "this repo's account (0b use)"));
    if (process.platform !== "win32") chmodSync(f, 0o755);
  }
  console.log(`${c.green("✓")} shims for claude and codex in ${dir}: they start the real one with the account picked for the repo you're in.`);
  if (onPath(ctx)) return;
  if (process.platform === "win32") console.log(`Put ${dir} first on your PATH (Settings → System → About → Advanced system settings → Environment Variables), then open a new terminal.`);
  else console.log(`Add this to ~/.zshrc (or your shell's rc), before other PATH changes take effect:\n  ${c.cyan(`export PATH="${dir}:$PATH"`)}`);
}

export function useCommand(ctx: Context, args: string[], opts: UseOptions): void {
  const [sub, name] = args;
  switch (sub) {
    case undefined:
    case "list":
    case "ls":
      return list(ctx);
    case "add":
      return add(ctx, name, opts);
    case "rm":
    case "remove":
      return remove(ctx, name, opts);
    case "shims":
      return shims(ctx, name === "off");
    default:
      if (!PROFILE_NAME.test(sub)) fail(`unknown profile "${sub}" (0b use lists them)`);
      return pick(ctx, sub, opts);
  }
}
