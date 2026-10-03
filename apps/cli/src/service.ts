import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Context } from "@0bridge/core";
import { c } from "./ui.ts";

/**
 * 0bridge's background jobs, installed with the OS's own service manager: a LaunchAgent on macOS,
 * a systemd user unit (a crontab line without systemd) on Linux, Task Scheduler on Windows.
 * Every job runs the 0bridge script (`~/.0bridge/bin/0bridge`), which runs this 0b; the agents'
 * turn-end hooks run it too.
 *
 * A test home (ZEROBRIDGE_USER_HOME other than the real home) never touches the real service
 * manager: the files are written and nothing is loaded, enabled or scheduled.
 */

export type ServiceName = "background" | "clip" | "clipsync" | "agent" | "webhook";
export const SERVICE_NAMES: ServiceName[] = ["background", "clip", "clipsync", "agent", "webhook"];
export interface ServiceOptions {
  /** Run every this many seconds. */
  interval?: number;
  /** Keep it running (started at login, restarted when it stops). */
  keepAlive?: boolean;
}
type Manager = "launchd" | "systemd" | "cron" | "schtasks" | "none";

const DESCRIPTION: Record<ServiceName, string> = {
  background: "history and personal file sync",
  clip: "clipboard answers (0b clip listen)",
  clipsync: "clipboard sync (0b clip sync)",
  agent: "coding agents for your AI apps (0b agent)",
  webhook: "webhook runs (0b webhook listen)",
};

const isReal = (ctx: Context) => ctx.home === homedir();
const has = (cmd: string) => spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" }).status === 0;
const logOf = (ctx: Context, name: ServiceName) => join(ctx.storeDir, `${name}.log`);

// ── The 0bridge script ──

/**
 * The script every job and hook runs. macOS names a background item after its signer ("Jarred
 * Sumner" for bun, the Node.js Foundation for node); a small script of our own named 0bridge is
 * what shows instead. Arguments are a 0b command (`clip listen`, `hook claude`); none, or flags
 * only, is the sync (`0b background`), which is what LaunchAgents written before had.
 */
export function renderBin(node: string, script: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32")
    return `@echo off\r\nrem 0bridge in the background: history and personal file sync, clipboard answers, agents' turn-end hooks.\r\nrem Remove the jobs with: 0b background off / 0b clip listen off / 0b history hooks off\r\nset "first=%~1"\r\nif not defined first goto sync\r\nif "%first:~0,1%"=="-" goto sync\r\n"${node}" "${script}" %*\r\nexit /b %errorlevel%\r\n:sync\r\n"${node}" "${script}" background %*\r\n`;
  return `#!/bin/sh
# 0bridge in the background: history and personal file sync, clipboard answers, agents' turn-end hooks.
# Remove the jobs with: 0b background off / 0b clip listen off / 0b history hooks off
case "$1" in ""|-*) set -- background "$@" ;; esac
exec "${node}" "${script}" "$@"
`;
}

export const binPath = (ctx: Context) => join(ctx.storeDir, "bin", process.platform === "win32" ? "0bridge.cmd" : "0bridge");

/** Write (or refresh, after an update) the 0bridge script for this 0b; returns its path. */
export function ensureBin(ctx: Context): string {
  const bin = binPath(ctx);
  mkdirSync(dirname(bin), { recursive: true });
  writeFileSync(bin, renderBin(process.execPath, process.argv[1] ?? "", process.platform), { mode: 0o755 });
  if (process.platform !== "win32") chmodSync(bin, 0o755);
  return bin;
}

// ── macOS: LaunchAgents ──

const label = (name: ServiceName) => `dev.0bridge.${name}`;
const plistPath = (ctx: Context, name: ServiceName) => join(ctx.home, "Library", "LaunchAgents", `${label(name)}.plist`);
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function renderPlist(name: ServiceName, argv: string[], log: string, opts: ServiceOptions): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label(name)}</string>
  <key>ProgramArguments</key><array>${argv.map((a) => `<string>${xml(a)}</string>`).join("")}</array>
${opts.interval ? `  <key>StartInterval</key><integer>${opts.interval}</integer>\n` : ""}${opts.keepAlive ? "  <key>KeepAlive</key><true/>\n" : ""}  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
}

function launchd(ctx: Context, name: ServiceName, args: string[] | null, opts: ServiceOptions): string {
  const path = plistPath(ctx, name);
  const real = isReal(ctx);
  if (real) spawnSync("launchctl", ["unload", path], { stdio: "ignore" });
  if (!args) {
    rmSync(path, { force: true });
    return path;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderPlist(name, [ensureBin(ctx), ...args], logOf(ctx, name), opts));
  if (real) spawnSync("launchctl", ["load", path], { stdio: "ignore" });
  return path;
}

// ── Linux: systemd user units, else crontab ──

const unitDir = (ctx: Context) => join(ctx.home, ".config", "systemd", "user");
const unitName = (name: ServiceName) => `0bridge-${name}`;
/** systemd's own quoting for ExecStart: double quotes, and % doubled (it starts a specifier). */
const sdQuote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

export function renderUnit(name: ServiceName, argv: string[], log: string, opts: ServiceOptions): string {
  return `[Unit]
Description=0bridge: ${DESCRIPTION[name]}

[Service]
Type=${opts.keepAlive ? "simple" : "oneshot"}
ExecStart=${argv.map(sdQuote).join(" ")}
${opts.keepAlive ? "Restart=always\nRestartSec=5\n" : ""}StandardOutput=append:${log}
StandardError=append:${log}
${opts.keepAlive ? "\n[Install]\nWantedBy=default.target\n" : ""}`;
}

export function renderTimer(name: ServiceName, interval: number): string {
  return `[Unit]
Description=0bridge: ${DESCRIPTION[name]}, every ${Math.round(interval / 60)} minutes

[Timer]
OnActiveSec=1min
OnUnitActiveSec=${interval}s
Unit=${unitName(name)}.service

[Install]
WantedBy=timers.target
`;
}

/** A crontab with our line for `name` (tagged `# 0bridge:<name>`) set, or removed when `line` is null. */
export function renderCrontab(current: string, name: ServiceName, line: string | null): string {
  const tag = `# 0bridge:${name}`;
  const kept = current.split("\n").filter((l) => l.trim() && !l.trimEnd().endsWith(tag));
  if (line) kept.push(`${line} ${tag}`);
  return kept.length ? kept.join("\n") + "\n" : "";
}

/** A crontab schedule for every `interval` seconds, in whole minutes (at most hourly steps). */
export function cronSchedule(interval: number): string {
  const min = Math.max(1, Math.round(interval / 60));
  return min >= 60 ? `0 */${Math.min(23, Math.round(min / 60))} * * *` : `*/${min} * * * *`;
}

const shQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

function linuxManager(real: boolean): Manager {
  const systemd = existsSync("/run/systemd/system");
  if (!real) return systemd ? "systemd" : "cron";
  if (systemd && spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore" }).status === 0) return "systemd";
  return has("crontab") ? "cron" : "none";
}

function systemd(ctx: Context, name: ServiceName, args: string[] | null, opts: ServiceOptions): string {
  const real = isReal(ctx);
  const service = join(unitDir(ctx), `${unitName(name)}.service`);
  const timer = join(unitDir(ctx), `${unitName(name)}.timer`);
  const sc = (...a: string[]) => (real ? spawnSync("systemctl", ["--user", ...a], { encoding: "utf8" }) : null);
  if (existsSync(service) || existsSync(timer)) sc("disable", "--now", `${unitName(name)}.timer`, `${unitName(name)}.service`);
  rmSync(timer, { force: true });
  rmSync(service, { force: true });
  if (!args) {
    sc("daemon-reload");
    return service;
  }
  mkdirSync(unitDir(ctx), { recursive: true });
  writeFileSync(service, renderUnit(name, [ensureBin(ctx), ...args], logOf(ctx, name), opts));
  if (opts.interval) writeFileSync(timer, renderTimer(name, opts.interval));
  sc("daemon-reload");
  const r = sc("enable", "--now", opts.interval ? `${unitName(name)}.timer` : `${unitName(name)}.service`);
  if (r && r.status !== 0) console.log(c.yellow(`systemctl --user couldn't start ${unitName(name)}: ${(r.stderr || "").trim().split("\n")[0]}`));
  // User units stop at logout unless the user lingers (a server reached over SSH).
  if (real && spawnSync("loginctl", ["show-user", process.env.USER ?? "", "-p", "Linger"], { encoding: "utf8" }).stdout?.trim() === "Linger=no")
    console.log(c.dim(`  It runs while you're logged in. To keep it running after you log out: ${c.cyan(`loginctl enable-linger ${process.env.USER ?? "$USER"}`)}`));
  return opts.interval ? timer : service;
}

function cron(ctx: Context, name: ServiceName, args: string[] | null, opts: ServiceOptions): string {
  const real = isReal(ctx);
  const line = args && opts.interval ? `${cronSchedule(opts.interval)} ${[ensureBin(ctx), ...args].map(shQuote).join(" ")} >> ${shQuote(logOf(ctx, name))} 2>&1` : null;
  if (args && !opts.interval) {
    console.log(`This machine has no service manager 0bridge can use; keep this running (in tmux, say): ${c.cyan(`0b ${args.join(" ")}`)}`);
    return "";
  }
  if (!real) return "crontab";
  const cur = spawnSync("crontab", ["-l"], { encoding: "utf8" });
  const current = cur.status === 0 ? cur.stdout : "";
  const next = renderCrontab(current, name, line);
  if (next === current) return "crontab";
  const w = spawnSync("crontab", ["-"], { input: next, encoding: "utf8" });
  if (w.status !== 0) console.log(c.yellow(`couldn't update your crontab: ${(w.stderr || "").trim()}`));
  return "crontab";
}

// ── Windows: Task Scheduler ──

const taskName = (name: ServiceName) => `0bridge\\${name}`;
const wrapperPath = (ctx: Context, name: ServiceName) => join(ctx.storeDir, "bin", `0bridge-${name}.cmd`);
const launcherPath = (ctx: Context, name: ServiceName) => join(ctx.storeDir, "bin", `0bridge-${name}.vbs`);

/** The .cmd a task runs: once (interval), or in a loop that restarts it 5 s after it stops (keepAlive). */
export function renderWrapper(name: ServiceName, bin: string, args: string[], log: string, opts: ServiceOptions): string {
  const run = `call "${bin}" ${args.map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)).join(" ")} >> "${log}" 2>&1`;
  const head = `@echo off\r\nrem 0bridge: ${DESCRIPTION[name]}. Task Scheduler runs this (${taskName(name)}).\r\n`;
  return opts.keepAlive ? `${head}:loop\r\n${run}\r\ntimeout /t 5 /nobreak >nul\r\ngoto loop\r\n` : `${head}${run}\r\n`;
}

/** Runs the .cmd without a console window flashing up; waits for it, so ending the task ends it. */
export const renderLauncher = (wrapper: string) => `CreateObject("WScript.Shell").Run """${wrapper}""", 0, True\r\n`;

export function schtasksArgs(name: ServiceName, launcher: string, opts: ServiceOptions): string[] {
  const tr = `wscript.exe //B //Nologo "${launcher}"`;
  const when = opts.keepAlive ? ["/SC", "ONLOGON"] : ["/SC", "MINUTE", "/MO", String(Math.max(1, Math.round((opts.interval ?? 900) / 60)))];
  return ["/Create", "/F", "/TN", taskName(name), ...when, "/TR", tr];
}

function schtasks(ctx: Context, name: ServiceName, args: string[] | null, opts: ServiceOptions): string {
  const real = isReal(ctx);
  const st = (...a: string[]) => (real ? spawnSync("schtasks", a, { encoding: "utf8", windowsHide: true }) : null);
  const startup = process.env.APPDATA ? join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", `0bridge-${name}.vbs`) : null;
  if (existsSync(wrapperPath(ctx, name))) (st("/End", "/TN", taskName(name)), st("/Delete", "/F", "/TN", taskName(name)));
  if (!args) {
    for (const p of [wrapperPath(ctx, name), launcherPath(ctx, name), ...(real && startup ? [startup] : [])]) rmSync(p, { force: true });
    return taskName(name);
  }
  writeFileSync(wrapperPath(ctx, name), renderWrapper(name, ensureBin(ctx), args, logOf(ctx, name), opts));
  writeFileSync(launcherPath(ctx, name), renderLauncher(wrapperPath(ctx, name)));
  const r = st(...schtasksArgs(name, launcherPath(ctx, name), opts));
  if (r && r.status !== 0) {
    // A logon task can need an administrator; the Startup folder doesn't.
    if (opts.keepAlive && startup) {
      writeFileSync(startup, renderLauncher(wrapperPath(ctx, name)));
      spawn("wscript.exe", ["//B", "//Nologo", startup], { stdio: "ignore", windowsHide: true, detached: true }).unref();
      return startup;
    }
    console.log(c.yellow(`Task Scheduler refused ${taskName(name)}: ${(r.stderr || r.stdout || "").trim()}`));
  } else if (opts.keepAlive) st("/Run", "/TN", taskName(name));
  return taskName(name);
}

// ── The interface ──

function manager(ctx: Context): Manager {
  if (process.platform === "darwin") return "launchd";
  if (process.platform === "win32") return "schtasks";
  return linuxManager(isReal(ctx));
}

/** Install the job that runs `0b <args>` (every `interval` seconds, or kept alive); `args` null removes it. Returns where it went ("" when it couldn't be). */
export function installService(ctx: Context, name: ServiceName, args: string[] | null, opts: ServiceOptions): string {
  switch (manager(ctx)) {
    case "launchd":
      return launchd(ctx, name, args, opts);
    case "systemd":
      return systemd(ctx, name, args, opts);
    case "cron":
      return cron(ctx, name, args, opts);
    case "schtasks":
      return schtasks(ctx, name, args, opts);
    default:
      if (args) console.log(`This machine has no service manager 0bridge can use; run ${c.cyan(`0b ${args.join(" ")}`)} yourself${opts.interval ? ` every ${Math.round(opts.interval / 60)} minutes` : " and keep it running"}.`);
      return "";
  }
}

export function serviceInstalled(ctx: Context, name: ServiceName): boolean {
  if (process.platform === "darwin") return existsSync(plistPath(ctx, name));
  if (process.platform === "win32") return existsSync(wrapperPath(ctx, name));
  if (existsSync(join(unitDir(ctx), `${unitName(name)}.service`))) return true;
  if (!isReal(ctx) || !has("crontab")) return false;
  const r = spawnSync("crontab", ["-l"], { encoding: "utf8" });
  return r.status === 0 && r.stdout.split("\n").some((l) => l.trimEnd().endsWith(`# 0bridge:${name}`));
}

/** Restart the jobs that keep running (so they run a new 0b); the names of those restarted. */
export function restartServices(ctx: Context): string[] {
  const restarted: string[] = [];
  if (!isReal(ctx)) return restarted;
  ensureBin(ctx);
  for (const name of ["clip", "clipsync", "agent", "webhook"] as const) {
    if (!serviceInstalled(ctx, name)) continue;
    let ok = false;
    if (process.platform === "darwin" && typeof process.getuid === "function") ok = spawnSync("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/${label(name)}`], { stdio: "ignore" }).status === 0;
    else if (process.platform === "win32") {
      spawnSync("schtasks", ["/End", "/TN", taskName(name)], { stdio: "ignore", windowsHide: true });
      ok = spawnSync("schtasks", ["/Run", "/TN", taskName(name)], { stdio: "ignore", windowsHide: true }).status === 0;
    } else if (existsSync(join(unitDir(ctx), `${unitName(name)}.service`))) ok = spawnSync("systemctl", ["--user", "restart", `${unitName(name)}.service`], { stdio: "ignore" }).status === 0;
    if (ok) restarted.push(name);
  }
  return restarted;
}
