import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { getAdapters, loadManifest, loadState, paths, saveManifest, saveState, type Context } from "@0bridge/core";
import { removeService } from "./service.ts";

/**
 * What CLI 0.2.44 removed and leaves behind on machines that had it: the clipboard's jobs
 * (`0b clip listen`, `0b clip sync`) and its ⌃V receiver, the xclip / wl-paste stand-ins
 * (`0b clip shims`), and the `0bridge-secrets` skill sign-in installed in every tool. `0b update`
 * clears them, and the background job does once (an update from an older 0b runs the old
 * `0b update`, so the background job is what reaches those machines).
 */

/** First line of every stand-in `0b clip shims` wrote (kept from clip.ts, so only ours are deleted). */
const SHIM_MARK = "# 0bridge: ⌃V pastes";
const SHIMS = ["xclip", "wl-paste"];
const SECRETS_SKILL = "0bridge-secrets";
/** Written once the background job has cleaned up here, so it doesn't look again every 15 minutes. */
const DONE = "removed-0.2.44";

function isOurShim(file: string): boolean {
  try {
    return readFileSync(file, "utf8").slice(0, 300).includes(SHIM_MARK);
  } catch {
    return false;
  }
}

/** The folders the stand-ins went to: ~/.0bridge/bin, else a folder of the home on PATH (~/.local/bin first). */
function shimDirs(ctx: Context, PATH = process.env.PATH ?? ""): string[] {
  return [...new Set([join(ctx.storeDir, "bin"), join(ctx.home, ".local", "bin"), ...PATH.split(delimiter).filter(Boolean)])];
}

/** A skill folder holds 0bridge's own copy: its SKILL.md is named 0bridge-secrets. */
function isSecretsSkill(dir: string): boolean {
  try {
    return /^name:\s*0bridge-secrets\s*$/m.test(readFileSync(join(dir, "SKILL.md"), "utf8").slice(0, 500));
  } catch {
    return false;
  }
}

function removeSecretsSkill(ctx: Context): boolean {
  let removed = false;
  const dirs = [join(paths(ctx).skills, SECRETS_SKILL), ...Object.values(getAdapters(ctx)).flatMap((a) => (a.skillsDir ? [join(a.skillsDir, SECRETS_SKILL)] : []))];
  for (const dir of new Set(dirs))
    if (isSecretsSkill(dir)) {
      rmSync(dir, { recursive: true, force: true });
      removed = true;
    }
  const m = loadManifest(ctx);
  if (m?.skills[SECRETS_SKILL]) {
    delete m.skills[SECRETS_SKILL];
    saveManifest(ctx, m);
    removed = true;
  }
  // `0b apply` no longer manages it in any tool.
  const state = loadState(ctx);
  let changed = false;
  for (const t of Object.values(state.managed))
    if (t?.skills.includes(SECRETS_SKILL)) {
      t.skills = t.skills.filter((s) => s !== SECRETS_SKILL);
      changed = true;
    }
  if (changed) saveState(ctx, state);
  return removed || changed;
}

/** Whether `pid` runs `0b clip sync` (Linux: /proc/<pid>/cmdline; elsewhere unknown, so no). */
function isClipReceiver(pid: number): boolean {
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    return argv.includes("clip") && argv.includes("sync");
  } catch {
    return false;
  }
}

/** Stop the ⌃V receiver (`0b clip sync` started in the background by a stand-in) and drop what it kept. */
function removeReceiver(ctx: Context): boolean {
  const dir = join(ctx.storeDir, "clip");
  if (!existsSync(dir)) return false;
  try {
    const pid = Number(readFileSync(join(dir, "receiver.pid"), "utf8")) || 0;
    // A pid file can outlive its process (a crash, a reboot) and point at someone else's: only a
    // process whose command line is our `clip sync` is stopped. Where that can't be read (not
    // Linux), the receiver is left to exit on its own: with the relay gone its socket keeps failing.
    if (pid && pid !== process.pid && isClipReceiver(pid)) process.kill(pid);
  } catch {}
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/** Clear what the removed features left here; what was removed, for a line of output. */
export function cleanUpRemoved(ctx: Context): string[] {
  const done: string[] = [];
  const shims = shimDirs(ctx).flatMap((d) => SHIMS.map((n) => join(d, n))).filter(isOurShim);
  for (const f of shims) rmSync(f, { force: true });
  if (shims.length) done.push("the xclip and wl-paste stand-ins (0b clip shims)");
  if (removeReceiver(ctx)) done.push("the clipboard receiver");
  for (const f of ["clip.log", "clipsync.log"]) rmSync(join(ctx.storeDir, f), { force: true });
  try {
    if (removeSecretsSkill(ctx)) done.push("the 0bridge-secrets skill");
  } catch {}
  // Last: removing a job stops it, and this may be running inside one (a job of an older 0b runs this 0b).
  const jobs = (["clip", "clipsync"] as const).filter((n) => removeService(ctx, n));
  if (jobs.length) done.push(`the clipboard ${jobs.length > 1 ? "jobs" : "job"} (${jobs.map((n) => `0b clip ${n === "clip" ? "listen" : "sync"}`).join(", ")})`);
  return done;
}

/** The background job's turn: clean up once per machine. */
export function cleanUpRemovedOnce(ctx: Context): string[] {
  const marker = join(ctx.storeDir, DONE);
  if (existsSync(marker)) return [];
  const done = cleanUpRemoved(ctx);
  writeFileSync(marker, `${new Date().toISOString()}\n`);
  return done;
}

/**
 * `0b clip …` after its removal: a job or a stand-in from before still calls it. Clean up, and hand
 * a stand-in's call to the real xclip or wl-paste so this copy or paste still works.
 */
export function clipRemoved(ctx: Context, args: string[]): never {
  const PATH = process.env.PATH ?? "";
  const done = cleanUpRemoved(ctx);
  if (args[0] === "shim" && SHIMS.includes(args[1] ?? "")) {
    const argv = args.slice(2);
    if (argv[0] === "--") argv.shift();
    const real = PATH.split(delimiter)
      .filter(Boolean)
      .map((d) => join(d, args[1]!))
      .find((f) => existsSync(f) && !isOurShim(f));
    if (!real) process.exit(1);
    process.exit(spawnSync(real, argv, { stdio: "inherit" }).status ?? 1);
  }
  console.error(`0b clip was removed in 0.2.44.${done.length ? ` Removed from this machine: ${done.join(", ")}.` : ""}`);
  process.exit(1);
}
