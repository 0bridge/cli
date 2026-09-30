import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadCloud, loadHistoryConfig, type Context } from "@0bridge/core";
import { c } from "./ui.ts";

/**
 * One background job keeps this machine's conversation history and personal files
 * in sync: `0b background` every 30 minutes, through a macOS LaunchAgent (a crontab line elsewhere).
 */

const AGENT = "dev.0bridge.background";

const agentPath = (ctx: Context) => join(ctx.home, "Library", "LaunchAgents", `${AGENT}.plist`);

export const backgroundInstalled = (ctx: Context) => existsSync(agentPath(ctx));

/**
 * The script LaunchAgents run. macOS names a background item after its signer ("Jarred Sumner" for
 * bun, the Node.js Foundation for node); a small script of our own named 0bridge is what runs
 * instead. `clip …` goes to `0b clip`; anything else is the sync (`0b background`).
 */
function writeBin(ctx: Context): string {
  const bin = join(ctx.storeDir, "bin", "0bridge");
  mkdirSync(dirname(bin), { recursive: true });
  writeFileSync(
    bin,
    `#!/bin/sh
# 0bridge in the background: history and personal file sync, and clipboard answers.
# Remove with: 0b background off / 0b clip listen off
case "$1" in clip) exec "${process.execPath}" "${process.argv[1]}" "$@" ;; esac
exec "${process.execPath}" "${process.argv[1]}" background "$@"
`,
    { mode: 0o755 },
  );
  chmodSync(bin, 0o755);
  return bin;
}

/**
 * A LaunchAgent that runs the 0bridge script with `args`, every `interval` seconds or kept alive;
 * `args` null removes it. A test home (ZEROBRIDGE_USER_HOME) never touches the real launchd.
 */
export function installAgent(ctx: Context, label: string, args: string[] | null, opts: { interval?: number; keepAlive?: boolean } = {}): string {
  const path = join(ctx.home, "Library", "LaunchAgents", `${label}.plist`);
  const real = ctx.home === homedir();
  if (real) spawnSync("launchctl", ["unload", path], { stdio: "ignore" });
  if (!args) {
    rmSync(path, { force: true });
    const others = ["dev.0bridge.background", "dev.0bridge.clip"].some((l) => existsSync(join(ctx.home, "Library", "LaunchAgents", `${l}.plist`)));
    if (!others) rmSync(join(ctx.storeDir, "bin", "0bridge"), { force: true });
    return path;
  }
  const bin = writeBin(ctx);
  const log = join(ctx.storeDir, label === AGENT ? "background.log" : `${label.split(".").pop()}.log`);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>${[bin, ...args].map((a) => `<string>${a}</string>`).join("")}</array>
${opts.interval ? `  <key>StartInterval</key><integer>${opts.interval}</integer>\n` : ""}${opts.keepAlive ? "  <key>KeepAlive</key><true/>\n" : ""}  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict></plist>
`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, plist);
  if (real) spawnSync("launchctl", ["load", path], { stdio: "ignore" });
  return path;
}

export function installBackground(ctx: Context, on: boolean): void {
  const cmd = `${process.execPath} ${process.argv[1]} background --quiet`;
  if (process.platform !== "darwin") {
    console.log(on ? `To sync every 30 minutes, add this to your crontab (${c.cyan("crontab -e")}):\n  */30 * * * * ${cmd}` : "Remove the 0b background line from your crontab.");
    return;
  }
  const path = installAgent(ctx, AGENT, on ? ["--quiet"] : null, { interval: 1800 });
  console.log(on ? `${c.green("✓")} Syncs in the background every 30 minutes ${c.dim(`(${path})`)}` : `${c.green("✓")} Background sync off`);
}

/** Install the job once; later calls do nothing. */
export function ensureBackground(ctx: Context): void {
  if (!backgroundInstalled(ctx)) installBackground(ctx, true);
}

/** What the job runs: history if it's on here, then every tracked personal file. */
export async function runBackground(ctx: Context, quiet: boolean): Promise<void> {
  const { syncHistory } = await import("./history.ts");
  const { syncAllFiles } = await import("./files.ts");
  const stamp = () => new Date().toISOString();
  try {
    // A newer 0b brings newer instructions for agents: every tool gets them without a new setup.
    const { refreshBridgeSkills } = await import("./cloud.ts");
    if (loadCloud(ctx)) refreshBridgeSkills(ctx);
  } catch (e) {
    console.error(`${stamp()} skills: ${e instanceof Error ? e.message : e}`);
  }
  try {
    if (loadHistoryConfig(ctx).enabled) await syncHistory(ctx, { quiet });
  } catch (e) {
    console.error(`${stamp()} history: ${e instanceof Error ? e.message : e}`);
  }
  try {
    await syncAllFiles(ctx, quiet);
  } catch (e) {
    console.error(`${stamp()} files: ${e instanceof Error ? e.message : e}`);
  }
}
