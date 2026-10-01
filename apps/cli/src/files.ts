import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { excludeFromGit, isInside, openValue, readJson, repoOf, sealValue, writeAtomic, type CloudClient, type Context, type RemoteFile } from "@0bridge/core";
import { ensureBackground } from "./background.ts";
import { openVault } from "./vault.ts";
import { accountForRepo } from "./links.ts";
import { c } from "./ui.ts";

/**
 * Personal files kept out of git: AGENTS.local.md, CLAUDE.local.md (often a symlink to it),
 * .claude/settings.local.json … follow the repo to every machine and clone. Sealed with the vault
 * key before upload; every change is a version the user can go back to. Pull never overwrites a
 * file changed here: a conflicting copy is written next to it instead.
 *
 * Files in the home folder outside any repo (~/.claude/statusline.sh) sync the same way, under
 * the repo name "~". A path like `.claude/settings.json#statusLine` is one key of a JSON file:
 * only that key syncs, and the file's other keys (machine-specific settings) stay as they are.
 */

/** The home folder's "repo": files under ~ that aren't in a git repo. */
export const HOME_REPO = "~";

/** `file.json#key` → the file and the key; plain paths → no key. */
const jsonKey = (path: string): { file: string; key: string } | null => {
  const i = path.lastIndexOf("#");
  return i > 0 && path.slice(0, i).endsWith(".json") && /^[A-Za-z0-9_.-]+$/.test(path.slice(i + 1)) ? { file: path.slice(0, i), key: path.slice(i + 1) } : null;
};

const readJsonObject = (abs: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(readFileSync(abs, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};

function fail(msg: string): never {
  console.error(c.red(`error: ${msg}`));
  process.exit(1);
}

interface Tracked {
  version: number;
  hash: string;
}
interface FilesConfig {
  repos: Record<string, { files: Record<string, Tracked>; checkouts: string[] }>;
}

const configPath = (ctx: Context) => join(ctx.storeDir, "files.json");
const load = (ctx: Context): FilesConfig => readJson<FilesConfig>(configPath(ctx)) ?? { repos: {} };
const save = (ctx: Context, cfg: FilesConfig) => writeAtomic(configPath(ctx), JSON.stringify(cfg, null, 1) + "\n", { mode: 0o600 });

/** The repo `dir` is in (by remote, so every clone matches), and its checkout root. */
function repoHere(dir = process.cwd()): { repo: string; root: string } | null {
  const inRepo = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir, encoding: "utf8" }).stdout?.trim() === "true";
  if (!inRepo) return null;
  const r = repoOf(dir);
  return { repo: r.remote ?? r.path, root: r.path };
}

interface Local {
  kind: "file" | "symlink";
  /** File bytes as base64, or the symlink's target. */
  body: string;
  hash: string;
  size: number;
}

function readLocal(abs: string): Local | null {
  const jk = jsonKey(abs);
  if (jk) {
    const obj = readJsonObject(jk.file);
    if (!obj || !(jk.key in obj)) return null;
    const bytes = Buffer.from(JSON.stringify(obj[jk.key], null, 2));
    return { kind: "file", body: bytes.toString("base64"), hash: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
  }
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) {
    const target = readlinkSync(abs);
    return { kind: "symlink", body: target, hash: createHash("sha256").update(`symlink:${target}`).digest("hex"), size: target.length };
  }
  if (!st.isFile()) return null;
  const bytes = readFileSync(abs);
  return { kind: "file", body: bytes.toString("base64"), hash: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
}

function writeLocal(abs: string, kind: "file" | "symlink", body: string) {
  const jk = jsonKey(abs);
  if (jk) {
    // Just this key; the rest of the file is this machine's own.
    const obj = existsSync(jk.file) ? readJsonObject(jk.file) : {};
    if (!obj) throw new Error(`${jk.file} isn't a JSON object; not changing it`);
    obj[jk.key] = JSON.parse(Buffer.from(body, "base64").toString("utf8"));
    mkdirSync(dirname(jk.file), { recursive: true });
    writeAtomic(jk.file, JSON.stringify(obj, null, 2) + "\n");
    return;
  }
  mkdirSync(dirname(abs), { recursive: true });
  try {
    unlinkSync(abs);
  } catch {}
  if (kind === "symlink") {
    const target = resolve(dirname(abs), body);
    // Windows lets only administrators (or Developer Mode) make symlinks: a copy of what it points to instead.
    if (process.platform === "win32" && existsSync(target) && !lstatSync(target).isDirectory()) {
      try {
        symlinkSync(body, abs, "file");
      } catch {
        writeFileSync(abs, readFileSync(target));
        console.log(c.yellow(`! ${abs} is a symlink on your other machines; Windows didn't allow one here, so it's a copy of ${body} (turn on Developer Mode to keep them linked).`));
      }
    } else symlinkSync(body, abs);
  } else {
    const bytes = Buffer.from(body, "base64");
    // Modes don't sync; a script (#!) comes back runnable, like the status line script it usually is.
    writeFileSync(abs, bytes, bytes.subarray(0, 2).toString() === "#!" ? { mode: 0o755 } : {});
  }
}

const at = (repo: string, path: string) => ({ scope: `files:${repo}`, env: path, name: "content" });

/** Keep a personal file out of commits in this clone without touching the shared .gitignore. */
export function ignoreLocally(root: string, file: string): boolean {
  return excludeFromGit(root, jsonKey(file)?.file ?? file); // a JSON key: the file it's in
}

interface Result {
  pushed: string[];
  pulled: string[];
  conflicts: string[];
  removed: string[];
}

/** Pull then push one checkout. `force`: push this machine's copy over a newer one. */
async function syncCheckout(ctx: Context, cfg: FilesConfig, client: CloudClient, key: Uint8Array, repo: string, root: string, opts: { force?: boolean; pullOnly?: boolean } = {}): Promise<Result> {
  const entry = (cfg.repos[repo] ??= { files: {}, checkouts: [] });
  if (!entry.checkouts.includes(root)) entry.checkouts.push(root);
  const res: Result = { pushed: [], pulled: [], conflicts: [], removed: [] };
  const conflicted = new Set<string>();
  const remote = new Map((await client.files(repo)).map((f) => [f.path, f]));
  const device = hostname().replace(/\.local$/, "");
  const conflictCopy = (path: string, f: RemoteFile) => {
    if (!f.ct) return;
    const jk = jsonKey(path);
    // A JSON key's other copy goes to a file of its own, never into the JSON file.
    const copy = jk ? `${jk.file}.${jk.key}.0bridge-${f.device ?? "other"}-v${f.version}.json` : `${path}.0bridge-${f.device ?? "other"}-v${f.version}`;
    writeLocal(join(root, copy), f.kind, openValue(key, { ...at(repo, path), ct: f.ct }));
    ignoreLocally(root, copy);
    conflicted.add(path);
    res.conflicts.push(`${path} (the other machine's copy: ${copy})`);
  };

  // Pull: what changed elsewhere, unless it also changed here.
  for (const [path, f] of remote) {
    const known = entry.files[path];
    const local = readLocal(join(root, path));
    if (known && known.version >= f.version) continue;
    const changedHere = local && known ? local.hash !== known.hash : Boolean(local);
    if (!f.ct) {
      // Deleted elsewhere.
      if (local && !changedHere) (rmSync(join(root, path), { force: true }), res.removed.push(path));
      if (!local || !changedHere) delete entry.files[path];
      continue;
    }
    if (local && local.hash === f.hash) {
      entry.files[path] = { version: f.version, hash: f.hash };
      continue;
    }
    if (changedHere && !opts.force) {
      conflictCopy(path, f);
      // Never synced here: from now on it's tracked against the cloud's version.
      if (!known) entry.files[path] = { version: f.version, hash: local!.hash };
      continue;
    }
    if (changedHere) continue; // --force: keep this machine's copy; it's pushed below
    writeLocal(join(root, path), f.kind, openValue(key, { ...at(repo, path), ct: f.ct }));
    ignoreLocally(root, path);
    entry.files[path] = { version: f.version, hash: f.hash };
    res.pulled.push(path);
  }
  if (opts.pullOnly) return res;

  // Push: what changed here since the version this machine last had (not what just conflicted).
  for (const [path, known] of Object.entries(entry.files)) {
    if (conflicted.has(path)) continue;
    const local = readLocal(join(root, path));
    if (!local) continue; // missing here: a clone that hasn't pulled, or deleted by hand (`0b files rm` removes it everywhere)
    const latest = remote.get(path);
    if (local.hash === known.hash && latest?.ct && latest.version === known.version) continue;
    const base = opts.force ? (latest?.version ?? 0) : latest ? known.version : 0;
    const r = await client.putFile({ repo, path, kind: local.kind, ct: sealValue(key, at(repo, path), local.body), hash: local.hash, size: local.size, device, base });
    if ("code" in r) {
      conflictCopy(path, r.latest);
      continue;
    }
    entry.files[path] = { version: r.version, hash: local.hash };
    res.pushed.push(path);
  }
  return res;
}

function report(r: Result, quiet?: boolean) {
  if (quiet && !r.conflicts.length) return;
  for (const p of r.pulled) console.log(`${c.green("↓")} ${p}`);
  for (const p of r.pushed) console.log(`${c.green("↑")} ${p}`);
  for (const p of r.removed) console.log(`${c.dim("✕")} ${p} ${c.dim("(deleted on another machine)")}`);
  for (const p of r.conflicts) console.log(`${c.yellow("!")} ${p} ${c.dim("— both machines changed it. Merge them, then `0b files push --force`")}`);
  if (!quiet && !r.pulled.length && !r.pushed.length && !r.removed.length && !r.conflicts.length) console.log(c.dim("Up to date."));
}

async function vault(ctx: Context) {
  try {
    const v = await openVault(ctx, { create: true });
    return v!;
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

/** Sync every checkout this machine knows (the background job). */
export async function syncAllFiles(ctx: Context, quiet = true): Promise<void> {
  const cfg = load(ctx);
  const repos = Object.entries(cfg.repos).filter(([, e]) => Object.keys(e.files).length);
  if (!repos.length) return;
  // A repo whose checkouts are linked to another account's project syncs with that account.
  const byAccount = new Map<string | undefined, typeof repos>();
  for (const entry of repos) {
    const account = ctx.account ?? accountForRepo(ctx, entry[0]) ?? undefined;
    byAccount.set(account, [...(byAccount.get(account) ?? []), entry]);
  }
  for (const [account, list] of byAccount) {
    const actx = account ? { ...ctx, account } : ctx;
    const v = account ? await openVault(actx, { create: true }).catch((e) => (quiet || console.log(c.yellow(`${account}: ${e instanceof Error ? e.message : e}`)), null)) : await vault(actx);
    if (!v) continue;
    for (const [repo, e] of list)
      for (const root of e.checkouts.filter((p) => existsSync(p))) {
        const r = await syncCheckout(actx, cfg, v.client, v.key, repo, root);
        if (!quiet) console.log(c.bold(`${repo} ${c.dim(root)}`));
        report(r, quiet);
      }
  }
  save(ctx, cfg);
}

async function status(ctx: Context): Promise<void> {
  const here = repoHere();
  const cfg = load(ctx);
  if (!here) {
    const repos = Object.entries(cfg.repos).filter(([, e]) => Object.keys(e.files).length);
    if (!repos.length) return console.log(`No personal files yet. In a repo: ${c.cyan("0b files add AGENTS.local.md")}`);
    for (const [repo, e] of repos) console.log(`${c.bold(repo)}  ${Object.keys(e.files).join(", ")}\n  ${c.dim(e.checkouts.join("  "))}`);
    return;
  }
  const { client } = await vault(ctx);
  const remote = await client.files(here.repo);
  const entry = cfg.repos[here.repo] ?? { files: {}, checkouts: [] };
  const paths = new Set([...Object.keys(entry.files), ...remote.filter((f) => f.ct).map((f) => f.path)]);
  if (!paths.size) return console.log(`No personal files for ${here.repo}. Add one: ${c.cyan("0b files add AGENTS.local.md")}`);
  console.log(c.bold(here.repo));
  for (const path of [...paths].sort()) {
    const f = remote.find((x) => x.path === path);
    const known = entry.files[path];
    const local = readLocal(join(here.root, path));
    const state = !local
      ? c.yellow(`not here — ${c.cyan("0b files pull")}`)
      : !f || !f.ct
        ? c.yellow("not uploaded")
        : local.hash === f.hash
          ? c.green("synced")
          : known && known.hash !== local.hash && known.version < f.version
            ? c.yellow("changed here and elsewhere")
            : known && known.hash !== local.hash
              ? c.yellow(`changed here — ${c.cyan("0b files push")}`)
              : c.yellow(`newer elsewhere — ${c.cyan("0b files pull")}`);
    console.log(`  ${path}${local?.kind === "symlink" ? c.dim(` → ${readlinkSync(join(here.root, path))}`) : ""}  ${state}${f ? c.dim(`  v${f.version}`) : ""}`);
  }
}

/**
 * Personal files of `repo` against this checkout, for `0b status`: the ones another machine
 * uploaded that aren't here yet, and the ones that differ.
 */
export async function filesHere(client: CloudClient, repo: string, root: string): Promise<{ total: number; missing: string[]; differ: string[] }> {
  const remote = (await client.files(repo)).filter((f) => f.ct);
  const missing: string[] = [];
  const differ: string[] = [];
  for (const f of remote) {
    const local = readLocal(join(root, f.path));
    if (!local) missing.push(f.path);
    else if (local.hash !== f.hash) differ.push(f.path);
  }
  return { total: remote.length, missing, differ };
}

export { repoHere };

export interface FilesOptions {
  force?: boolean;
  quiet?: boolean;
  all?: boolean;
}

/**
 * Where a command works: the repo the file (or the current folder) is in, or the home folder for
 * files under ~ outside any repo.
 */
function scopeOf(ctx: Context, p?: string): { repo: string; root: string } {
  const abs = p ? resolve(p.replace(/^~(?=[\\/]|$)/, ctx.home)) : process.cwd();
  const dir = p ? dirname(jsonKey(abs)?.file ?? abs) : abs;
  const r = existsSync(dir) ? repoHere(dir) : null;
  if (r && (!p || isInside(r.root, abs))) return r;
  // Real paths: the current folder comes back resolved (/private/var/… on macOS), $HOME may not be.
  const real = (x: string) => {
    try {
      return realpathSync(x);
    } catch {
      return x;
    }
  };
  const under = (x: string) => isInside(real(ctx.home), x) || isInside(ctx.home, x);
  if (under(abs) || under(real(dirname(abs)))) return { repo: HOME_REPO, root: ctx.home };
  fail(`${p ?? dir} is neither in a git repo nor in your home folder`);
}

/** Claude Code's status line: the `statusLine` setting and the script it runs, if that's under ~. */
function statusLinePaths(ctx: Context): string[] {
  const settings = join(ctx.home, ".claude", "settings.json");
  const sl = readJsonObject(settings)?.statusLine as { command?: string } | undefined;
  if (!sl) fail(`no statusLine in ${settings} yet. Set one up in Claude Code (/statusline), then run this again`);
  const out = [`${settings}#statusLine`];
  const script = sl.command?.trim().split(/\s+/)[0]?.replace(/^~(?=\/)/, ctx.home).replace(/^\$HOME(?=\/)/, ctx.home);
  if (script && script !== ctx.home && isInside(ctx.home, script) && existsSync(script)) out.push(script);
  if (sl.command?.includes(ctx.home)) console.log(c.yellow(`  The command has ${ctx.home} in it; write it as ~/… so it works on machines with another home folder.`));
  return out;
}

export async function filesCommand(ctx: Context, args: string[], opts: FilesOptions): Promise<void> {
  let [sub, ...rest] = args;
  if (sub === undefined || sub === "status") return status(ctx);
  if (sub === "sync" && opts.all) return syncAllFiles(ctx, Boolean(opts.quiet));
  if (sub === "statusline") [sub, rest] = ["add", statusLinePaths(ctx)];
  const here = scopeOf(ctx, sub === "add" || sub === "rm" || sub === "log" || sub === "restore" ? rest[0] : undefined);
  const cfg = load(ctx);
  const v = await vault(ctx);
  const entry = (cfg.repos[here.repo] ??= { files: {}, checkouts: [] });
  const rel = (p: string) => {
    const abs = resolve(p.replace(/^~(?=[\\/]|$)/, ctx.home));
    const r = relative(here.root, abs);
    if (!r || !isInside(here.root, abs)) fail(`${p} isn't inside ${here.root}${here.repo === HOME_REPO ? "" : " (one repo at a time)"}`);
    return r;
  };
  switch (sub) {
    case "add": {
      if (!rest.length) fail("usage: 0b files add <file>… (e.g. AGENTS.local.md CLAUDE.local.md)");
      for (const p of rest) {
        const path = rel(p);
        if (!readLocal(join(here.root, path))) fail(`${p} doesn't exist (or isn't a file or symlink)`);
        if (!ignoreLocally(here.root, path)) fail(`${path} is committed to git; personal files are the ones kept out of it`);
        entry.files[path] ??= { version: 0, hash: "" };
      }
      const r = await syncCheckout(ctx, cfg, v.client, v.key, here.repo, here.root);
      save(ctx, cfg);
      report(r);
      console.log(
        c.dim(
          here.repo === HOME_REPO
            ? `Your other machines get these with ${c.cyan("0b files pull")} (from anywhere outside a repo), then keep them in sync in the background.`
            : `Every clone of ${here.repo} gets these with ${c.cyan("0b files pull")}; this machine keeps them in sync in the background.`,
        ),
      );
      ensureBackground(ctx);
      return;
    }
    case "push":
    case "pull":
    case "sync": {
      const r = await syncCheckout(ctx, cfg, v.client, v.key, here.repo, here.root, { force: opts.force, pullOnly: sub === "pull" });
      save(ctx, cfg);
      report(r, opts.quiet);
      return;
    }
    case "rm": {
      if (!rest.length) fail("usage: 0b files rm <file>… (stops syncing and removes it from your other machines; this copy stays)");
      for (const p of rest) {
        const path = rel(p);
        const known = entry.files[path];
        const latest = (await v.client.files(here.repo)).find((f) => f.path === path);
        if (latest?.ct) await v.client.putFile({ repo: here.repo, path, kind: latest.kind, ct: null, hash: "0".repeat(64), size: 0, device: hostname(), base: latest.version });
        delete entry.files[path];
        console.log(`${c.green("✓")} ${path} no longer synced${known ? "" : c.dim(" (it wasn't tracked here)")}`);
      }
      save(ctx, cfg);
      return;
    }
    case "log": {
      const path = rel(rest[0] ?? fail("usage: 0b files log <file>"));
      const list = await v.client.fileVersions(here.repo, path);
      if (!list.length) return console.log(c.dim(`No versions of ${path}.`));
      for (const x of list) console.log(`v${x.version}  ${new Date(x.at).toISOString().slice(0, 16).replace("T", " ")}  ${x.deleted ? c.dim("deleted") : `${x.size} bytes`}  ${c.dim(x.device ?? "")}`);
      return;
    }
    case "restore": {
      const path = rel(rest[0] ?? fail("usage: 0b files restore <file> <version>"));
      const n = Number(rest[1] ?? fail("usage: 0b files restore <file> <version> (see 0b files log)"));
      const old = await v.client.fileVersion(here.repo, path, n);
      if (!old.ct) fail(`v${n} is a deletion`);
      writeLocal(join(here.root, path), old.kind, openValue(v.key, { ...at(here.repo, path), ct: old.ct }));
      entry.files[path] ??= { version: 0, hash: "" };
      const r = await syncCheckout(ctx, cfg, v.client, v.key, here.repo, here.root, { force: true });
      save(ctx, cfg);
      console.log(`${c.green("✓")} ${path} is back to v${n}${r.pushed.length ? " and uploaded as the latest" : ""}`);
      return;
    }
    default:
      fail(`unknown subcommand "files ${sub}". Try: status, add, statusline, pull, push, sync, rm, log, restore`);
  }
}
