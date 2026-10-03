import { spawnSync } from "node:child_process";
import type { Context } from "@0bridge/core";
import { upgradeBackground } from "./background.ts";
import { stopReceiver } from "./clip.ts";
import { restartServices } from "./service.ts";
import { c } from "./ui.ts";

function fail(msg: string): never {
  console.error(c.red(`error: ${msg}`));
  process.exit(1);
}

/** "0.2.15" is newer than "0.2.14"; pre-release tags aren't used. */
export function isNewer(latest: string, current: string): boolean {
  const a = latest.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

/**
 * The package manager that installed this copy, from where it lives (bun and pnpm keep global
 * packages in their own folders), installing exactly `version`: right after a release, npm's
 * cached idea of "latest" can still be the old one.
 */
export function installer(scriptPath: string, version = "latest"): string[] {
  const pkg = `0bridge@${version}`;
  if (/[\\/]\.bun[\\/]/.test(scriptPath)) return ["bun", "add", "-g", pkg];
  if (/[\\/]pnpm[\\/]/.test(scriptPath)) return ["pnpm", "add", "-g", pkg];
  if (/[\\/]\.?yarn[\\/]/.test(scriptPath)) return ["yarn", "global", "add", pkg];
  return ["npm", "install", "-g", pkg, "--prefer-online"];
}

/** What the restarted jobs are called here. The periodic sync isn't one: it starts fresh each time. */
const RUNNING: Record<string, string> = { clip: "clip listen", clipsync: "clip sync", agent: "the agent daemon", webhook: "webhook listen" };

/**
 * `0b update`: install the newest 0b from npm with the package manager that installed this one,
 * then restart 0bridge's background jobs that keep running (macOS, Linux and Windows), so they run
 * the new version. `--check` only says whether there's one.
 */
export async function updateCommand(ctx: Context, current: string, opts: { check?: boolean } = {}): Promise<void> {
  const latest = await fetch("https://registry.npmjs.org/0bridge/latest", { headers: { Accept: "application/json" } })
    .then((r) => (r.ok ? (r.json() as Promise<{ version?: string }>) : null))
    .then((j) => j?.version ?? null)
    .catch(() => null);
  if (!latest) fail("couldn't reach npm to look for a new version; check your connection and try again");
  if (current === "dev") fail(`this 0b runs from source (the newest release is ${latest}); update it with git pull`);
  if (!isNewer(latest, current)) return console.log(`${c.green("✓")} 0b ${current} is the newest version`);
  if (opts.check) return console.log(`0b ${latest} is out (this is ${current}). Run ${c.cyan("0b update")}.`);

  const cmd = installer(process.argv[1] ?? "", latest);
  console.log(`Updating 0b ${current} → ${latest}  ${c.dim(`(${cmd.join(" ")})`)}`);
  // npm, pnpm and yarn are .cmd scripts on Windows, which only a shell runs (the arguments are our own).
  const r = spawnSync(cmd[0]!, cmd.slice(1), { stdio: "inherit", shell: process.platform === "win32" });
  if (r.error) fail(`${cmd[0]} isn't on this machine's PATH; run ${cmd.join(" ")} with the package manager you installed 0b with`);
  if (r.status !== 0)
    fail(`${cmd.join(" ")} failed. If it says EACCES, npm's global folder needs other permissions: see https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally`);

  const now = spawnSync(process.execPath, [process.argv[1]!, "--version"], { encoding: "utf8" }).stdout?.trim() || latest;
  if (now !== latest) {
    // The package manager put the new version somewhere this `0b` doesn't run from (two installs, or a PATH that points elsewhere).
    console.log(c.yellow(`Installed 0b ${latest}, but the 0b here is still ${now} (${process.argv[1]}). Check which one your PATH finds: ${c.cyan("which -a 0b")}.`));
    return;
  }
  // The jobs run the 0bridge script, which runs whatever 0b is installed: restart the ones that keep running, and move an older periodic job to today's schedule.
  upgradeBackground(ctx);
  const restarted = restartServices(ctx).map((n) => RUNNING[n] ?? n);
  // The ⌃V receiver on a server isn't a service: stopping it is enough, the next ⌃V starts the new one.
  if (stopReceiver(ctx)) restarted.push("the clipboard receiver");
  console.log(`${c.green("✓")} 0b ${now}${restarted.length ? c.dim(` · restarted ${restarted.join(" and ")}`) : ""}`);
}
