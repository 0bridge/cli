import * as p from "@clack/prompts";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve, win32 } from "node:path";
import { createInterface } from "node:readline";
import {
  CLIS,
  DEFAULT_ENV,
  Masker,
  PROFILE_NAME,
  loadProfiles,
  profileDir,
  profileEnv,
  profileFor,
  readJson,
  refreshOverlay,
  repoOf,
  saveProfiles,
  writeAtomic,
  type Context,
} from "@0bridge/core";
import { c, canOpenBrowser } from "./ui.ts";
import { vaultEnv } from "./vault.ts";

const binDir = (ctx: Context) => join(ctx.storeDir, "bin");

function fail(msg: string): never {
  console.error(c.red(`error: ${msg}`));
  process.exit(1);
}

/**
 * Where a CLI's binary is: on PATH, or else a project's own copy (wrangler is often only a
 * devDependency), looking up from the current directory. Null when neither has it.
 */
export function findBin(cmd: string, from = process.cwd()): string | null {
  const names = process.platform === "win32" ? [`${cmd}.cmd`, `${cmd}.exe`, cmd] : [cmd];
  for (const d of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) for (const n of names) if (existsSync(join(d, n))) return join(d, n);
  for (let d = resolve(from); ; d = dirname(d)) {
    for (const n of names) if (existsSync(join(d, "node_modules", ".bin", n))) return join(d, "node_modules", ".bin", n);
    if (dirname(d) === d) return null;
  }
}

/** A localhost address pasted from a browser on another machine, or why it isn't one. */
export function parseCallback(input: string): URL | string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return "that isn't an address";
  }
  if (u.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) || !u.port) return "paste the http://localhost:… address the browser ended on";
  return u;
}

/**
 * The login waits at a localhost address on this machine, but the browser is on another one
 * (SSH), so the last redirect can't reach it. Take the address the browser ended on and open it
 * here. Only localhost: nothing pasted is sent anywhere else. Stops when the login exits.
 */
function relayCallback(child: ChildProcess): void {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  child.once("exit", () => rl.close());
  console.log(
    c.dim("\nBrowser on another machine? After you approve, it lands on a localhost page that won't load.\nPaste that page's address here and 0b passes it on:"),
  );
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    const u = parseCallback(line);
    if (typeof u === "string") return console.log(c.yellow(u));
    // localhost can resolve to ::1 first while the login listens on 127.0.0.1: try both.
    for (const host of u.hostname === "localhost" ? ["127.0.0.1", "[::1]"] : [u.hostname]) {
      try {
        const res = await fetch(`http://${host}:${u.port}${u.pathname}${u.search}`, { redirect: "manual" });
        if (res.status < 400) return console.log(`${c.green("✓")} passed to the login`);
        return console.log(c.yellow(`the login answered ${res.status}; start it again if it doesn't finish`));
      } catch {}
    }
    console.log(c.yellow("nothing is listening at that address; the login may have finished or timed out"));
  });
}

/** Run a CLI's own login inside the profile, so its tokens land in the profile's folder. */
export async function loginInto(ctx: Context, name: string, cli: string): Promise<void> {
  const a = CLIS[cli] ?? fail(`unknown CLI "${cli}" (supported: ${Object.keys(CLIS).join(", ")})`);
  const bin = findBin(a.login[0]!) ?? fail(`${a.login[0]} isn't installed. Install it with ${c.cyan(a.install)}, then run this again`);
  const cfg = loadProfiles(ctx);
  const clis = [...new Set([...(cfg.profiles[name]?.clis ?? []), cli])];
  cfg.profiles[name] = { clis };
  saveProfiles(ctx, cfg);
  const dir = refreshOverlay(ctx, name, clis);
  console.log(`${c.bold(a.label)} → sign in for profile ${c.bold(name)} ${c.dim(`(${a.login.join(" ")})`)}`);
  const run = spawnTarget(bin, a.login.slice(1), process.env.PATH ?? "");
  const child = spawn(run.cmd, run.args, { stdio: "inherit", shell: run.shell, env: { ...process.env, XDG_CONFIG_HOME: dir, GH_CONFIG_DIR: join(dir, "gh") } });
  if (a.localhostCallback && !canOpenBrowser() && process.stdin.isTTY) relayCallback(child);
  const status = await new Promise<number | null>((ok) => {
    child.once("error", (e) => fail(`${a.login[0]}: ${e.message}`));
    child.once("exit", (code) => ok(code));
  });
  if (status !== 0) fail(`${a.login.join(" ")} failed`);
}

/** Who each CLI in a profile is signed in as (its own whoami output, trimmed). */
function whoami(ctx: Context, name: string, cli: string): string {
  const dir = refreshOverlay(ctx, name, loadProfiles(ctx).profiles[name]?.clis ?? []);
  const a = CLIS[cli]!;
  const bin = findBin(a.whoami[0]!);
  if (!bin) return c.yellow(`${a.whoami[0]} not installed`);
  const run = spawnTarget(bin, a.whoami.slice(1), process.env.PATH ?? "");
  const r = spawnSync(run.cmd, run.args, { encoding: "utf8", shell: run.shell, env:{ ...process.env, XDG_CONFIG_HOME: dir, GH_CONFIG_DIR: join(dir, "gh") } });
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const email = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(out)?.[0];
  const gh = /account (\S+)/.exec(out)?.[1];
  if (r.status !== 0 && !email && !gh) return c.yellow("not signed in");
  return email ?? gh ?? c.green("signed in");
}

/**
 * Claude Code runs every agent shell command with the project's settings `env`, so writing the
 * profile there covers `npx wrangler` and package scripts, which a PATH shim would miss.
 */
function writeClaudeEnv(repoPath: string, env: Record<string, string> | null): string {
  const file = join(repoPath, ".claude", "settings.local.json");
  if (!env && !existsSync(file)) return file;
  const s = readJson<Record<string, any>>(file) ?? {};
  const next = { ...(s.env ?? {}) };
  for (const k of ["XDG_CONFIG_HOME", "GH_CONFIG_DIR"]) delete next[k];
  Object.assign(next, env ?? {});
  if (Object.keys(next).length) s.env = next;
  else delete s.env;
  mkdirSync(join(repoPath, ".claude"), { recursive: true });
  writeAtomic(file, JSON.stringify(s, null, 2) + "\n");
  // Machine-specific paths: keep them out of commits even if the repo doesn't ignore the file.
  const ignored = spawnSync("git", ["check-ignore", "-q", file], { cwd: repoPath }).status === 0;
  const exclude = join(repoPath, ".git", "info", "exclude");
  if (!ignored && existsSync(join(repoPath, ".git", "info"))) appendFileSync(exclude, "\n.claude/settings.local.json\n");
  return file;
}

function use(ctx: Context, name: string | undefined) {
  const cfg = loadProfiles(ctx);
  const repo = repoOf(process.cwd());
  cfg.repos = cfg.repos.filter((r) => r.path !== repo.path);
  if (name) {
    if (!cfg.profiles[name]) fail(`no profile "${name}" — create it with \`0b profile add ${name} wrangler\``);
    cfg.repos.push({ path: repo.path, remote: repo.remote, profile: name });
  }
  saveProfiles(ctx, cfg);
  const env = name ? profileEnv(ctx, repo.path).env : null;
  const file = writeClaudeEnv(repo.path, env);
  if (name) {
    console.log(`${c.green("✓")} ${c.bold(repo.remote ?? repo.path)} uses profile ${c.bold(name)} (${cfg.profiles[name]!.clis.join(", ")})`);
    console.log(c.dim(`  Claude Code: ${file.replace(repo.path + "/", "")} (restart sessions)`));
    console.log(c.dim(`  Terminal:    ${c.cyan("0b exec -- wrangler …")} or the shims (${c.cyan("0b profile shims")})`));
  } else console.log(`${c.green("✓")} ${repo.remote ?? repo.path} uses your default logins again.`);
}

function list(ctx: Context) {
  const cfg = loadProfiles(ctx);
  const names = Object.keys(cfg.profiles).sort();
  if (!names.length) return console.log(`No profiles yet. ${c.cyan("0b profile add work wrangler")} signs wrangler into a separate "work" profile.`);
  const here = profileFor(ctx, process.cwd());
  for (const n of names) {
    console.log(`${n === here ? c.green("●") : " "} ${c.bold(n)}`);
    for (const cli of cfg.profiles[n]!.clis) console.log(`    ${cli.padEnd(10)} ${whoami(ctx, n, cli)}`);
    for (const r of cfg.repos.filter((r) => r.profile === n)) console.log(c.dim(`    ↳ ${r.remote ?? r.path}`));
  }
}

/** A shim that runs the real `cli` with this repo's profile: a shell script, or a .cmd on Windows (what cmd and PowerShell run). */
export function renderShim(cli: string, platform: NodeJS.Platform = process.platform): { file: string; body: string } {
  if (platform === "win32") return { file: `${cli}.cmd`, body: `@echo off\r\nrem 0bridge: run the real ${cli} with this repo's profile (0b profile).\r\n0b exec --shim ${cli} -- %*\r\n` };
  return { file: cli, body: `#!/bin/sh\n# 0bridge: run the real ${cli} with this repo's profile (0b profile).\nexec 0b exec --shim ${cli} -- "$@"\n` };
}

function shims(ctx: Context) {
  const dir = binDir(ctx);
  mkdirSync(dir, { recursive: true });
  for (const cli of Object.keys(CLIS)) {
    const s = renderShim(cli);
    const f = join(dir, s.file);
    writeFileSync(f, s.body);
    if (process.platform !== "win32") chmodSync(f, 0o755);
  }
  const onPath = (process.env.PATH ?? "").split(delimiter).some((d) => resolve(d) === resolve(dir));
  console.log(`${c.green("✓")} shims for ${Object.keys(CLIS).join(", ")} in ${dir}`);
  if (onPath) return;
  if (process.platform === "win32") console.log(`Put ${dir} first on your PATH (Settings → System → About → Advanced system settings → Environment Variables), then open a new terminal.`);
  else console.log(`Add this to ~/.zshrc (or your shell's rc), before other PATH changes take effect:\n  ${c.cyan(`export PATH="${dir}:$PATH"`)}`);
}

export async function profileCommand(ctx: Context, args: string[]) {
  const [sub, name, ...rest] = args;
  switch (sub) {
    case undefined:
    case "list":
    case "ls":
      return list(ctx);
    case "add":
    case "login": {
      if (!name || !PROFILE_NAME.test(name)) fail("usage: 0b profile add <name> <cli>...   (name: lowercase letters, digits, - _)");
      let clis = rest;
      if (!clis.length) {
        if (!process.stdin.isTTY) fail(`which CLIs? e.g. 0b profile add ${name} wrangler gh`);
        const picked = await p.multiselect({ message: `Sign in which CLIs for ${c.bold(name)}?`, options: Object.entries(CLIS).map(([id, a]) => ({ value: id, label: a.label })), required: true });
        if (p.isCancel(picked)) return;
        clis = picked;
      }
      for (const cli of clis) await loginInto(ctx, name, cli);
      console.log(`${c.green("✓")} profile ${c.bold(name)} ready. Bind a repo to it: ${c.cyan(`0b profile use ${name}`)}`);
      return;
    }
    case "use":
      if (!name) fail("usage: 0b profile use <name>   (0b profile unuse to go back to default logins)");
      return use(ctx, name);
    case "unuse":
      return use(ctx, undefined);
    case "shims":
      return shims(ctx);
    case "remove": {
      if (!name) fail("usage: 0b profile remove <name>");
      const cfg = loadProfiles(ctx);
      if (!cfg.profiles[name]) fail(`no profile "${name}"`);
      delete cfg.profiles[name];
      cfg.repos = cfg.repos.filter((r) => r.profile !== name);
      saveProfiles(ctx, cfg);
      rmSync(profileDir(ctx, name), { recursive: true, force: true });
      console.log(`${c.green("✓")} removed ${name} and its logins. Repos that used it fall back to your default logins.`);
      return;
    }
    default:
      fail(`unknown subcommand "profile ${sub}". Try: list, add, use, unuse, shims, remove`);
  }
}

/**
 * `0b exec [--env dev] [--shim cli] -- cmd …`: run a command with this repo's CLI profile and
 * its vault values as environment variables. When the output goes to a program rather
 * than a terminal (an agent reading it), secret values in it are replaced with ***.
 */
/**
 * `ZEROBRIDGE_ENV=<env>` in the child: which vault environment the values came from, so a repo's
 * script can tell "running under 0b exec with dev values" apart from a plain shell (and never mistake
 * a prod run for dev). Set last, so neither the shell nor a stored value can fake it. Shims only swap
 * CLI logins and carry no vault values, so they don't set it.
 */
export const execMarker = (shim: string | undefined, envName: string): Record<string, string> =>
  shim ? {} : { ZEROBRIDGE_ENV: envName };

/**
 * How to start `cmd` here. Windows CLIs installed by npm are .cmd scripts, which only cmd.exe runs
 * (Node refuses to spawn them without a shell), so those go through it with each argument quoted.
 */
export function spawnTarget(cmd: string, args: string[], PATH: string, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = existsSync): { cmd: string; args: string[]; shell: boolean } {
  if (platform !== "win32") return { cmd, args, shell: false };
  let found = cmd;
  if (!/[\\/]/.test(cmd) && !/\.\w+$/.test(cmd))
    search: for (const d of PATH.split(";").filter(Boolean))
      for (const ext of [".exe", ".cmd", ".bat"])
        if (exists(win32.join(d, cmd + ext))) {
          found = win32.join(d, cmd + ext);
          break search;
        }
  if (!/\.(cmd|bat)$/i.test(found)) return { cmd: found, args, shell: false };
  const q = (a: string) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`);
  return { cmd: q(found), args: args.map(q), shell: true };
}

export async function execCommand(ctx: Context, argv: string[]): Promise<never> {
  let shim: string | undefined;
  let envName = DEFAULT_ENV;
  for (;;) {
    if (argv[0] === "--shim") shim = argv[1];
    else if (argv[0] === "--env") envName = argv[1] ?? fail("--env needs a name (dev, prod, …)");
    else if (argv[0]?.startsWith("--env=")) envName = argv[0].slice(6);
    else break;
    argv = argv.slice(2 - Number(argv[0]?.startsWith("--env=")));
  }
  if (argv[0] === "--") argv = argv.slice(1);
  const [cmd, ...args] = shim ? [shim, ...argv] : argv;
  if (!cmd) fail("usage: 0b exec [--env dev|prod] -- <command> [args…]");
  const { env } = profileEnv(ctx, process.cwd());
  // Shims only swap CLI logins; they don't need the vault (and run on every wrangler call).
  // The approval page shows what's asking: the command and its first argument, never more (it could hold a secret).
  const vault = shim ? { env: {}, hidden: [] } : await vaultEnv(ctx, process.cwd(), envName, [cmd, ...args.slice(0, 1)].join(" ").slice(0, 80));
  // A shim must find the real binary, not itself.
  const PATH = (process.env.PATH ?? "").split(delimiter).filter((d) => resolve(d) !== resolve(binDir(ctx))).join(delimiter);
  // Windows spells it Path; a second PATH key next to it would leave the child with either one.
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== "PATH"));
  const childEnv = { ...base, PATH, ...vault.env, ...env, ...execMarker(shim, envName) };
  // Only secrets are masked; variables (PORT, NODE_ENV) show as they are.
  const values = vault.hidden;
  const mask = values.length > 0 && !process.stdout.isTTY;
  const run = spawnTarget(cmd, args, PATH);
  const child = spawn(run.cmd, run.args, { stdio: ["inherit", mask ? "pipe" : "inherit", mask ? "pipe" : "inherit"], env: childEnv, shell: run.shell });
  if (mask) {
    for (const [from, to] of [
      [child.stdout!, process.stdout],
      [child.stderr!, process.stderr],
    ] as const) {
      const m = new Masker(values);
      from.setEncoding("utf8");
      from.on("data", (d: string) => to.write(m.push(d)));
      from.on("end", () => to.write(m.flush()));
    }
  }
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => child.kill(sig));
  return new Promise<never>(() => {
    child.on("error", (e: NodeJS.ErrnoException) => fail(`${cmd}: ${e.code === "ENOENT" ? "not found" : e.message}`));
    child.on("close", (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
  });
}
