import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCloud, loadHistoryConfig, syncWanted, type Context } from "@0bridge/core";
import { installService, serviceInstalled } from "./service.ts";
import { c } from "./ui.ts";

/**
 * One background job keeps this machine's conversation history, personal files,
 * context (profile, instructions, skills) and Drive folders cloned here (`0b drive clone`) in sync: `0b background` every 15 minutes, through the
 * OS's service manager (service.ts). The agents' turn-end hooks upload a conversation within
 * seconds; this catches whatever they miss, and the tools without hooks.
 */

export const BACKGROUND_INTERVAL = 900;
const ARGS = ["background", "--quiet"];

export const backgroundInstalled = (ctx: Context) => serviceInstalled(ctx, "background");

/** A LaunchAgent from before the 15-minute job (every 30 minutes, `0bridge --quiet`). */
function outdated(ctx: Context): boolean {
  if (process.platform !== "darwin") return false;
  try {
    return !readFileSync(join(ctx.home, "Library", "LaunchAgents", "dev.0bridge.background.plist"), "utf8").includes(`<integer>${BACKGROUND_INTERVAL}</integer>`);
  } catch {
    return false;
  }
}

export function installBackground(ctx: Context, on: boolean, quiet = false): void {
  const where = installService(ctx, "background", on ? ARGS : null, { interval: BACKGROUND_INTERVAL });
  if (quiet) return;
  if (!on) return console.log(`${c.green("✓")} Background sync off`);
  if (where) console.log(`${c.green("✓")} Syncs in the background every 15 minutes ${c.dim(`(${where})`)}`);
}

/** Install the job once (or bring one from an older 0b up to date); later calls do nothing. */
export function ensureBackground(ctx: Context): void {
  if (!backgroundInstalled(ctx)) installBackground(ctx, true);
  else if (outdated(ctx)) installBackground(ctx, true, true);
}

/** `0b update`: a job installed by an older 0b gets today's schedule. Not from inside the job itself (reloading it would stop it). */
export function upgradeBackground(ctx: Context): void {
  if (backgroundInstalled(ctx) && outdated(ctx)) installBackground(ctx, true, true);
}

/** What the job runs: history if it's on here, then the context, then every tracked personal file, then every synced Drive folder. */
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
    // Under the history lock: a hook's worker or a manual sync running now has it, and this round is skipped.
    // Usage on its own (`0b usage on`, history off) syncs too: token counts only.
    if (syncWanted(loadHistoryConfig(ctx))) await syncHistory(ctx, { quiet, skipIfBusy: true });
  } catch (e) {
    console.error(`${stamp()} history: ${e instanceof Error ? e.message : e}`);
  }
  try {
    const { syncContext } = await import("./context.ts");
    if (loadCloud(ctx)) await syncContext(ctx, { quiet });
  } catch (e) {
    console.error(`${stamp()} context: ${e instanceof Error ? e.message : e}`);
  }
  try {
    await syncAllFiles(ctx, quiet);
  } catch (e) {
    console.error(`${stamp()} files: ${e instanceof Error ? e.message : e}`);
  }
  try {
    const { syncAllDriveFolders } = await import("./drive-sync.ts");
    await syncAllDriveFolders(ctx, quiet);
  } catch (e) {
    console.error(`${stamp()} drive: ${e instanceof Error ? e.message : e}`);
  }
}
