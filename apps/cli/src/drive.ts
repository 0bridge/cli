import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { CloudError, type CloudClient, type Context } from "@0bridge/core";
import { ensureBackground } from "./background.ts";
import { cloudClient } from "./cloud.ts";
import {
  cleanFolder,
  clientFor,
  cloneFolder,
  describeFlags,
  DriveApi,
  folderAt,
  folderLabel,
  folderStatus,
  loadDriveState,
  posixRel,
  prefixOf,
  printReport,
  resolveWorkspace,
  syncAllDriveFolders,
  syncFolder,
  unlinkFolder,
  type FolderContext,
  type RemoteNode,
  type RemoteWorkspace,
} from "./drive-sync.ts";
import { c, tilde } from "./ui.ts";

/**
 * `0b drive` (docs/plans/drive-plus.md A5, §4.10): your Drive and your teams' from the terminal:
 * list a folder with its README, clone a Drive folder into a local one that syncs both ways
 * (drive-sync.ts), sync, status, unlink, and a folder's email address.
 *
 * A team's Drive is `--workspace <name|id>`; a command run inside a synced folder means that
 * folder's Drive folder. The CLI is a full device token over REST, so a workspace's owner or admin
 * changes AGENTS.md and skills directly; a member's changes to those wait as proposals for the
 * dashboard.
 */

export interface DriveOptions {
  /** A team workspace by name or id (default: your personal Drive). */
  workspace?: string;
  json?: boolean;
  yes?: boolean;
  quiet?: boolean;
  force?: boolean;
}

function fail(msg: string): never {
  console.error(c.red(`error: ${msg}`));
  process.exit(1);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) (v /= 1024), i++;
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(at).toISOString().slice(0, 10);
}

/** The README's status line: its first line that isn't a heading, a table rule or empty. */
export function statusLine(readme: string | null | undefined, max = 90): string | null {
  const line = (readme ?? "")
    .split(/\r?\n/)
    .map((l) => printable(l).trim())
    .find((l) => l && !l.startsWith("#") && !/^\|?[\s:|-]+\|?$/.test(l));
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Text anyone who can write to Drive chose (a README line, a file name, who changed it), without
 * control characters: an escape sequence printed as is would act on the terminal (its clipboard, its title).
 */
export const printable = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");

/** What a file's row says besides its size: extraction still running or failed, and sensitive-data flags. */
export function fileNotes(n: Pick<RemoteNode, "extract" | "extractError" | "pages" | "flags">): string[] {
  const out: string[] = [];
  if (n.extract === "pending") out.push("extracting…");
  else if (n.extract === "failed") out.push(printable(n.extractError ?? "no text could be read"));
  else if (n.pages && n.pages > 1) out.push(plural(n.pages, "page"));
  if (n.flags?.length) out.push(`⚠ ${describeFlags(n.flags.map((f) => ({ ...f, sample: "" })))}`);
  return out;
}

/** A folder's direct contents from the tree under its prefix: subfolders (with what's in them) and files. */
export function children(nodes: RemoteNode[], prefix: string): { dirs: { name: string; files: number; bytes: number; at: number }[]; files: (RemoteNode & { name: string })[] } {
  const dirs = new Map<string, { name: string; files: number; bytes: number; at: number }>();
  const files: (RemoteNode & { name: string })[] = [];
  for (const n of nodes) {
    if (!n.path.startsWith(prefix)) continue;
    const rest = n.path.slice(prefix.length);
    const i = rest.indexOf("/");
    if (i < 0) {
      files.push({ ...n, name: printable(rest) });
      continue;
    }
    const name = printable(rest.slice(0, i));
    const d = dirs.get(name) ?? { name, files: 0, bytes: 0, at: 0 };
    d.files++;
    d.bytes += n.size;
    d.at = Math.max(d.at, n.updatedAt);
    dirs.set(name, d);
  }
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  return { dirs: [...dirs.values()].sort(byName), files: files.sort(byName) };
}

/** The workspace and Drive folder a command means: named, or the synced folder it runs in. */
function target(ctx: Context, folderArg: string | undefined, opts: DriveOptions): { client: CloudClient; server: string; workspace?: string; folder: string } {
  const here = folderArg === undefined && !opts.workspace ? folderAt(ctx, process.cwd()) : null;
  try {
    if (here) {
      const sub = posixRel(here.dir, process.cwd());
      return { client: clientFor(ctx, here.state), server: here.state.server, workspace: here.state.workspaceId, folder: cleanFolder(here.state.prefix + (sub && !sub.startsWith("..") ? sub : "")) };
    }
    const { cfg, client } = cloudClient(ctx);
    return { client, server: cfg.server, workspace: opts.workspace, folder: cleanFolder(folderArg ?? "") };
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

/** GET /drive/folder, or null when the server has nothing to say about it. */
async function folderContext(api: DriveApi, folder: string): Promise<FolderContext | null> {
  try {
    return await api.folder(folder);
  } catch (e) {
    if (e instanceof CloudError && (e.status === 404 || e.status === 400)) return null;
    throw e;
  }
}

const wsTitle = (ws: RemoteWorkspace) => (ws.personal ? "Your Drive" : `${printable(ws.name)}'s Drive`);

// ── Subcommands ──

async function ls(ctx: Context, folderArg: string | undefined, opts: DriveOptions) {
  const t = target(ctx, folderArg, opts);
  const ws = await resolveWorkspace(new DriveApi(t.client), t.workspace);
  const api = new DriveApi(t.client, ws.id);
  const prefix = prefixOf(t.folder);
  const [{ nodes }, fc] = await Promise.all([api.fullTree(prefix), folderContext(api, t.folder)]);
  if (opts.json) return console.log(JSON.stringify({ workspace: ws, folder: t.folder, context: fc, nodes }, null, 2));
  if (t.folder && !nodes.length) fail(`${wsTitle(ws)} has no folder "${t.folder}" (0b drive ls${ws.personal ? "" : ` --workspace "${ws.name}"`} lists what's there)`);

  console.log(`${c.bold(wsTitle(ws))}${t.folder ? ` › ${c.bold(t.folder)}` : ""}  ${c.dim(`${fmtBytes(ws.used)} of ${fmtBytes(ws.limit)} used${ws.writable ? "" : " · read-only: the team's subscription isn't active"}`)}`);
  if (fc && (fc.readme || fc.agents || fc.skills.length || fc.inbound)) {
    const status = statusLine(fc.readme?.text);
    if (fc.readme) console.log(`  ${c.dim("README")}  ${status ?? c.dim("(no status line)")}`);
    if (fc.agents) console.log(`  ${c.dim("AGENTS.md")}  instructions for agents working here${fc.agents.updatedVia ? c.dim(` · ${printable(fc.agents.updatedVia)}`) : ""}`);
    if (fc.skills.length) console.log(`  ${c.dim("Skills")}  ${fc.skills.map((k) => `${printable(k.name)}${k.runsOn.length ? c.dim(` [${printable(k.runsOn.join(", "))}]`) : ""}`).join(", ")}`);
    if (fc.inbound) console.log(`  ${c.dim("Email in")}  ${printable(fc.inbound)}`);
  }
  const { dirs, files } = children(nodes, prefix);
  if (!dirs.length && !files.length) {
    console.log(c.dim(`  Empty. Add files in the dashboard, or send a local folder up: 0b drive clone <name> <dir> --force${ws.personal ? "" : ` --workspace "${ws.name}"`}`));
    return;
  }
  const synced = Object.entries(loadDriveState(ctx).folders).filter(([, f]) => f.workspaceId === ws.id);
  const width = Math.min(40, Math.max(...dirs.map((d) => d.name.length + 1), ...files.map((f) => f.name.length)));
  console.log();
  for (const d of dirs) {
    const here = synced.find(([, f]) => f.prefix === `${prefix}${d.name}/`);
    console.log(`  ${c.bold(`${d.name}/`.padEnd(width))}  ${c.dim(`${plural(d.files, "file")} · ${fmtBytes(d.bytes)} · ${ago(d.at)}`)}${here ? c.dim(`  ⇄ ${tilde(ctx, here[0])}`) : ""}`);
  }
  for (const f of files) {
    const notes = fileNotes(f);
    console.log(`  ${f.name.padEnd(width)}  ${c.dim(`${fmtBytes(f.size)} · ${ago(f.updatedAt)}`)}${notes.length ? `  ${notes.map((x) => (x.startsWith("⚠") ? c.yellow(x) : c.dim(x))).join(c.dim(" · "))}` : ""}`);
  }
  for (const [dir] of synced.filter(([, f]) => f.prefix === prefix)) console.log(c.dim(`\n  synced here: ${tilde(ctx, dir)}`));
  if (!folderArg && !opts.workspace && ws.personal) {
    const teams = (await api.workspaces()).filter((w) => !w.personal);
    if (teams.length) console.log(c.dim(`\nTeams: ${teams.map((w) => printable(w.name)).join(", ")} (0b drive ls --workspace <name>)`));
  }
}

async function clone(ctx: Context, args: string[], opts: DriveOptions) {
  if (args[0] === undefined) fail('usage: 0b drive clone <folder> [dir] [--workspace <team>]   ("" for all of your Drive; --force merges into a folder that isn\'t empty)');
  let dir: string;
  try {
    dir = await cloneFolder(ctx, args[0], args[1], { workspace: opts.workspace, force: opts.force });
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  const st = loadDriveState(ctx).folders[dir];
  console.log(`${c.green("✓")} ${c.bold(st ? folderLabel(st) : args[0] || "Drive")} is in ${tilde(ctx, dir)} ${c.dim(`(${plural(Object.keys(st?.files ?? {}).length, "file")})`)}. It syncs both ways in the background ${c.dim("(0b drive status; 0b drive sync now)")}.`);
  const links = st?.links ?? [];
  if (links.length)
    console.log(c.dim(`Claude Code reads its ${[links.some((l) => l.endsWith("CLAUDE.md")) ? "AGENTS.md (as CLAUDE.md)" : "", links.some((l) => l.includes(".claude/skills/")) ? "skills (in .claude/skills)" : ""].filter(Boolean).join(" and ")} there too.`));
  ensureBackground(ctx);
}

async function sync(ctx: Context, dirArg: string | undefined, opts: DriveOptions) {
  const dir = dirArg ? resolve(dirArg) : folderAt(ctx, process.cwd())?.dir;
  if (!dir) {
    if (!Object.keys(loadDriveState(ctx).folders).length) return console.log(`No synced folders. ${c.cyan("0b drive clone <folder>")} makes one.`);
    return syncAllDriveFolders(ctx, Boolean(opts.quiet));
  }
  let r;
  try {
    r = await syncFolder(ctx, dir, { quiet: opts.quiet });
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  if (r.busy) return console.log(c.dim("Another 0b is syncing this folder right now; try again in a moment."));
  printReport(ctx, r, { quiet: opts.quiet, server: loadDriveState(ctx).folders[dir]?.server });
  if (r.errors.length) process.exitCode = 1;
}

async function status(ctx: Context, dirArg?: string) {
  const at = dirArg ? { dir: resolve(dirArg) } : folderAt(ctx, process.cwd());
  if (!at) {
    const folders = Object.entries(loadDriveState(ctx).folders);
    if (!folders.length) return console.log(`No synced folders here. ${c.cyan("0b drive clone <folder>")} makes one.`);
    for (const [dir, f] of folders) console.log(`${c.bold(folderLabel(f))}  ${tilde(ctx, dir)}${existsSync(dir) ? "" : c.yellow("  (gone)")}  ${c.dim(plural(Object.keys(f.files).length, "file"))}`);
    return;
  }
  const s = await folderStatus(ctx, at.dir);
  console.log(`${c.bold(folderLabel(s.state))} ⇄ ${tilde(ctx, at.dir)} ${c.dim(`· ${plural(Object.keys(s.state.files).length, "file")} synced`)}`);
  const show = (title: string, paths: string[], hint = "") => {
    if (!paths.length) return;
    console.log(`${title}${hint ? c.dim(` ${hint}`) : ""}`);
    for (const p of paths.slice(0, 30)) console.log(`  ${p}`);
    if (paths.length > 30) console.log(c.dim(`  … ${paths.length - 30} more`));
  };
  show(c.yellow("Changed here"), s.changedHere, "(0b drive sync sends them)");
  show(c.yellow("Deleted here"), s.missingHere, "(0b drive sync deletes them in Drive too; their versions stay restorable)");
  show(c.yellow("Changed in Drive"), s.changedThere, "(0b drive sync brings them)");
  show(c.yellow("Changed on both sides"), s.both, "(sync keeps yours and saves Drive's next to it)");
  show(c.yellow("Conflict copies"), s.copies, "(merge each into its file, then delete the copy)");
  show(c.yellow("Tracked by git and changed on both sides"), s.tracked, "(git will see the merge as an ordinary change)");
  for (const p of s.large) console.log(c.dim(`${p} is over 25 MB, so it stays on this machine`));
  if (![s.changedHere, s.missingHere, s.changedThere, s.copies].some((x) => x.length)) console.log(c.green("✓ In sync."));
}

async function unlink(ctx: Context, dirArg?: string) {
  const dir = dirArg ? resolve(dirArg) : (folderAt(ctx, process.cwd())?.dir ?? fail("run this in a synced folder, or name it: 0b drive unlink <dir>"));
  const f = await unlinkFolder(ctx, dir);
  if (!f) fail(`${tilde(ctx, dir)} isn't a synced folder (0b drive status lists them)`);
  console.log(`${c.green("✓")} ${tilde(ctx, dir)} doesn't sync anymore. Its files stay here, and in ${folderLabel(f)}.`);
}

/**
 * The folder's inbound address (E6). Addresses are made, rotated and turned off in the dashboard
 * (owner decision 10.6): this prints the one there is, or where to make one.
 */
async function email(ctx: Context, folderArg: string | undefined, opts: DriveOptions) {
  if (folderArg === undefined && !folderAt(ctx, process.cwd())) fail("usage: 0b drive email <folder> [--workspace <team>]");
  const t = target(ctx, folderArg, opts);
  const folder = t.folder || "inbox";
  const ws = await resolveWorkspace(new DriveApi(t.client), t.workspace);
  const api = new DriveApi(t.client, ws.id);
  let address = (await folderContext(api, folder))?.inbound ?? null;
  if (!address) {
    // The list is the dashboard's (sessions only for now); a device token is turned away, which is fine here.
    const list = await t.client.call<{ address: string; folder: string; disabledAt: number | null }[]>("GET", `/drive/inbound?workspace=${encodeURIComponent(ws.id)}`).catch(() => null);
    address = (Array.isArray(list) ? list : []).find((a) => a.folder === folder && !a.disabledAt)?.address ?? null;
  }
  const dashboard = `${t.server.replace(/\/+$/, "")}/app/drive`;
  if (!address) {
    console.log(`${folder}/ has no email address yet. ${ws.personal ? "You make" : "The workspace's owner or an admin makes"} one in the dashboard: ${c.cyan(`${dashboard}/email`)}`);
    process.exitCode = 1;
    return;
  }
  if (opts.json) return console.log(JSON.stringify({ workspace: ws.id, folder, address }));
  console.log(address);
  if (!opts.quiet)
    console.log(
      c.dim(
        `Forward files to it: mail from ${ws.personal ? "your account's addresses" : `${ws.name} members' account addresses`} that passes DKIM lands in ${folder}/<date> <subject>/ with its attachments, and you get a receipt. Anything else waits in the dashboard's Inbox (${dashboard}/inbox).`,
      ),
    );
}

export async function driveCommand(ctx: Context, args: string[], opts: DriveOptions): Promise<void> {
  const [sub, ...rest] = args;
  try {
    switch (sub) {
      case undefined:
      case "ls":
      case "list":
        return await ls(ctx, rest[0], opts);
      case "clone":
        return await clone(ctx, rest, opts);
      case "sync":
        return await sync(ctx, rest[0], opts);
      case "status":
        return await status(ctx, rest[0]);
      case "unlink":
        return await unlink(ctx, rest[0]);
      case "email":
        return await email(ctx, rest[0], opts);
      default:
        fail(`unknown subcommand "drive ${sub}". Try: ls, clone, sync, status, unlink, email`);
    }
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}
