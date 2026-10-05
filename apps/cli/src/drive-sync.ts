import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { CloudClient, CloudError, deviceTokenKey, findAccount, isInside, loadAccounts, loadCloud, openSecretStore, readJson, tryLock, writeAtomic, type Context } from "@0bridge/core";
import { foldName, isInstructionPath } from "@0bridge/core/drive-paths";
import { c, tilde } from "./ui.ts";

/**
 * Drive folders synced to local folders (docs/plans/drive-plus.md A5, §4.10): `0b drive clone`
 * links a local folder to a Drive folder (personal or a team's), and each sync (by hand or in
 * `0b background`) pulls the changes cursor and pushes local edits with the recorded base version,
 * keeping both sides of a conflict. State in ~/.0bridge/drive.json, locks under ~/.0bridge/drive/.
 * Ported from the spaces branch's space-sync.ts onto /api/drive (§4.7); the Drive folder's prefix is
 * stripped here, so `tax-invoices/AGENTS.md` in Drive is `AGENTS.md` in the folder cloned from it.
 *
 * - Pull: a remote change to a file unchanged here overwrites it; a remote delete removes it.
 * - Push: a file whose sha256 differs from the one recorded goes up with `If-Match: <recorded
 *   version>` (0 for a new one); a recorded file missing here is deleted with `If-Match`.
 * - Conflict (both sides changed, or a 409): this machine's file stays and is pushed, after the
 *   other version is saved next to it as `<stem>.0bridge-<via>-v<n><ext>`. Those copies never go up.
 * - Instruction files (AGENTS.md, skills): a change from someone who may not make it directly (a
 *   team member who isn't an admin) comes back as a proposal, reported once and not proposed again
 *   until it changes here.
 * - Skills on disk: in every folder with them, `.claude/skills/<name>` → `../../.agents/skills/<name>`
 *   and `CLAUDE.md` → `AGENTS.md`, so Claude Code reads the folder's skills and instructions with
 *   no 0bridge in the loop. Links are made here only, never pushed (symlinks are never pushed).
 * - Hashes decide, never mtimes: a size and mtime equal to the recorded ones only spare re-hashing.
 * - Nothing comes down that this disk would read as something else, or that sits where this folder
 *   ignores (`.git/` above all: a hook there would run): unsafePath and the ignore rules gate every
 *   pull, and every write and delete stays inside the folder. Modes don't sync: only a skill's
 *   script (.agents/skills/, which only owners and admins change directly) comes down runnable.
 * - Inside a git repo, sync never runs git commands that change anything; new files git ignores
 *   stay here (`git check-ignore`), so build output and .env files don't go up.
 */

/** Drive's own limit for one file (drive.ts MAX_FILE): bigger files stay on this machine. */
export const MAX_SYNC_BYTES = 25 * 1024 * 1024;

// ── The REST contract (drive-plus.md §4.2, §4.7), as the CLI reads it ──

export interface SensitiveFlag {
  kind: "rrn" | "card" | "account" | "password" | "secret";
  count: number;
  sample: string;
}
export interface RemoteNode {
  path: string;
  size: number;
  mime: string;
  sha256: string;
  version: number;
  source: string;
  trusted: boolean;
  flags: SensitiveFlag[];
  extract: "pending" | "ok" | "failed" | "skipped";
  quality: string | null;
  pages: number | null;
  extractError: string | null;
  updatedBy: string | null;
  updatedVia: string | null;
  updatedAt: number;
  seq: number;
}
export interface RemoteChange {
  path: string;
  version: number;
  sha256: string | null;
  size: number;
  mime: string;
  deleted: boolean;
  seq: number;
  at: number;
  via: string | null;
  /** Written or applied by the owner or an admin (absent from servers before it: taken as so). */
  trusted?: boolean;
}
export interface RemoteProposal {
  id: string;
  path: string;
  baseVersion: number;
  sha256: string | null;
  size: number;
  by: string;
  via: string;
  at: number;
  note: string | null;
  state: "pending" | "applied" | "rejected";
}
/** GET /api/drive/spaces: the caller's workspaces (personal first). */
export interface RemoteWorkspace {
  id: string;
  name: string;
  personal: boolean;
  writable: boolean;
  limit: number;
  role: string;
  used: number;
}
export interface FolderDoc {
  path: string;
  version: number;
  trusted: boolean;
  updatedVia: string | null;
  text: string;
  truncated: boolean;
}
export interface FolderContext {
  folder: string;
  readme: FolderDoc | null;
  agents: FolderDoc | null;
  skills: { name: string; folder: string; description: string; runsOn: string[]; files: string[]; trusted: boolean }[];
  inbound: string | null;
}

export type PutOutcome =
  | { ok: true; node: RemoteNode; warnings: SensitiveFlag[]; unchanged?: boolean }
  | { ok: true; proposal: RemoteProposal; warnings: SensitiveFlag[] }
  | { ok: false; code: "CONFLICT"; latest: RemoteNode | null; error: string }
  | { ok: false; code: "TOO_LARGE" | "LIMIT" | "READ_ONLY" | "INVALID"; error: string };

export type DeleteOutcome = { ok: true } | { ok: true; proposal: RemoteProposal } | { ok: false; code: "CONFLICT"; latest: RemoteNode | null } | { ok: false; code: "NOT_FOUND" };

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** `/api/drive/…` of one workspace through the device token: JSON with `call`, file bytes with `raw`. */
export class DriveApi {
  constructor(
    readonly client: CloudClient,
    /** The workspace's id (null: the personal one). */
    readonly workspace: string | null = null,
  ) {}

  private qs(o: Record<string, string | number | undefined>): string {
    const q = new URLSearchParams();
    if (this.workspace) q.set("workspace", this.workspace);
    for (const [k, v] of Object.entries(o)) if (v !== undefined) q.set(k, String(v));
    return q.toString();
  }
  get<T>(path: string): Promise<T> {
    return this.client.call<T>("GET", path);
  }
  workspaces() {
    return this.get<RemoteWorkspace[]>("/drive/spaces");
  }
  tree(prefix: string, limit = 5000, after?: string) {
    return this.get<{ nodes: RemoteNode[]; cursor: number }>(`/drive/tree?${this.qs({ prefix: prefix || undefined, limit, after })}`);
  }
  /**
   * The whole tree, page by page, with the first page's cursor. `complete` is false when the server
   * didn't page (one from before `after`): then the nodes are only the first page.
   */
  async fullTree(prefix: string, limit = 5000): Promise<{ nodes: RemoteNode[]; cursor: number; complete: boolean }> {
    const first = await this.tree(prefix, limit);
    const nodes = [...first.nodes];
    const seen = new Set(nodes.map((n) => n.path));
    for (let page = first.nodes; page.length >= limit; ) {
      page = (await this.tree(prefix, limit, page[page.length - 1]!.path)).nodes;
      if (page.some((n) => seen.has(n.path))) return { nodes, cursor: first.cursor, complete: false };
      for (const n of page) (nodes.push(n), seen.add(n.path));
    }
    return { nodes, cursor: first.cursor, complete: true };
  }
  changes(cursor: number, prefix: string, limit = 1000) {
    return this.get<{ cursor: number; more: boolean; reset: boolean; changes: RemoteChange[] }>(`/drive/changes?${this.qs({ cursor, prefix: prefix || undefined, limit })}`);
  }
  /** README.md, AGENTS.md, skills and the email address of a folder ("" for the top). */
  folder(path: string) {
    return this.get<FolderContext>(`/drive/folder?${this.qs({ path })}`);
  }

  async download(path: string, version?: number): Promise<Uint8Array> {
    const res = await this.client.raw("GET", `/drive/content?${this.qs({ path, version })}`);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      throw new CloudError(body.error ?? `${path}: ${res.status} ${res.statusText}`, res.status, body.code);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  /** `base` undefined writes over whatever is there; 0 means it must not exist yet. */
  async put(path: string, bytes: Uint8Array, o: { base?: number; mime?: string; sync?: boolean; sha256?: string } = {}): Promise<PutOutcome> {
    const headers: Record<string, string> = { "X-Content-SHA256": o.sha256 ?? sha256(bytes), "Content-Type": o.mime ?? mimeOf(path) };
    if (o.base !== undefined) headers["If-Match"] = String(o.base);
    if (o.sync) headers["X-0bridge-Client"] = "sync";
    const res = await this.client.raw("PUT", `/drive/content?${this.qs({ path })}`, new Blob([bytes as Uint8Array<ArrayBuffer>]), headers);
    const body = (await res.json().catch(() => ({}))) as any;
    if (res.status === 202) return { ok: true, proposal: body.proposal, warnings: body.warnings ?? [] };
    if (res.ok) return { ok: true, node: body.node, warnings: body.warnings ?? [], unchanged: body.unchanged };
    if (res.status === 409 && body.code === "CONFLICT") return { ok: false, code: "CONFLICT", latest: body.latest ?? null, error: body.error ?? "changed elsewhere" };
    if (res.status === 413) return { ok: false, code: body.code === "LIMIT" ? "LIMIT" : "TOO_LARGE", error: body.error ?? "too large" };
    if (res.status === 402) return { ok: false, code: "READ_ONLY", error: body.error ?? "this workspace takes no new files" };
    if (res.status === 400) return { ok: false, code: "INVALID", error: body.error ?? "Drive refused the path" };
    throw new CloudError(body.error ?? `${path}: ${res.status} ${res.statusText}`, res.status, body.code);
  }

  async remove(path: string, base?: number, o: { sync?: boolean } = {}): Promise<DeleteOutcome> {
    const headers: Record<string, string> = {};
    if (base !== undefined) headers["If-Match"] = String(base);
    if (o.sync) headers["X-0bridge-Client"] = "sync";
    const res = await this.client.raw("DELETE", `/drive/content?${this.qs({ path })}`, null, headers);
    const body = (await res.json().catch(() => ({}))) as any;
    if (res.status === 202) return { ok: true, proposal: body.proposal };
    if (res.ok) return { ok: true };
    if (res.status === 409) return { ok: false, code: "CONFLICT", latest: body.latest ?? null };
    if (res.status === 404) return { ok: false, code: "NOT_FOUND" };
    throw new CloudError(body.error ?? `${path}: ${res.status} ${res.statusText}`, res.status, body.code);
  }
}

/** A Drive folder as typed (`/tax-invoices/`, `.`, ``) → `tax-invoices` ("" for all of Drive). */
export const cleanFolder = (f: string) =>
  f
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s && s !== ".")
    .join("/");

/** The prefix of a folder's paths in Drive: `tax-invoices/`, or "" for all of it. */
export const prefixOf = (folder: string) => (folder ? `${folder}/` : "");

// ── Mime types (the gateway's table decides; this is only what the upload says) ──

const MIME: Record<string, string> = {
  md: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  hwp: "application/x-hwp",
  hwpx: "application/hwp+zip",
  zip: "application/zip",
  html: "text/html",
  yaml: "application/yaml",
  yml: "application/yaml",
  toml: "application/toml",
  sh: "text/x-shellscript",
  py: "text/x-python",
  ts: "text/plain",
  js: "text/javascript",
};
export const mimeOf = (path: string) => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return (dot > 0 && MIME[name.slice(dot + 1).toLowerCase()]) || "application/octet-stream";
};

// ── State: ~/.0bridge/drive.json ──

export interface SyncedFile {
  version: number;
  sha256: string;
  size: number;
  mtimeMs: number;
}
export interface FolderState {
  /** The account the folder syncs with (it may not be the default one). */
  server: string;
  userId: string;
  workspaceId: string;
  /** For messages: the workspace's name when it was linked ("Personal" for your own). */
  workspaceName: string;
  /** The Drive folder's prefix (`tax-invoices/`; "" for all of Drive). Local paths are relative to it. */
  prefix: string;
  /** The workspace's changes cursor this folder has seen. */
  cursor: number;
  /** By local path (the prefix stripped). */
  files: Record<string, SyncedFile>;
  /** Links sync made here (skills on disk, CLAUDE.md): never pushed, removed when their target goes. */
  links?: string[];
}
export interface DriveState {
  folders: Record<string, FolderState>;
}

const statePath = (ctx: Context) => join(ctx.storeDir, "drive.json");
const stateLockPath = (ctx: Context) => join(ctx.storeDir, "drive.json.lock");
/** Held while a folder syncs; another sync of it (the background job, a manual one) skips it. */
export const folderLockPath = (ctx: Context, dir: string) => join(ctx.storeDir, "drive", `${createHash("sha256").update(dir).digest("hex").slice(0, 16)}.lock`);

export const loadDriveState = (ctx: Context): DriveState => readJson<DriveState>(statePath(ctx)) ?? { folders: {} };

/** Change the state under its lock (held for the read and the write only, never across the network). */
export async function editDriveState<T>(ctx: Context, fn: (s: DriveState) => T): Promise<T> {
  for (let i = 0; ; i++) {
    const release = tryLock(stateLockPath(ctx));
    if (release)
      try {
        const s = loadDriveState(ctx);
        const out = fn(s);
        writeAtomic(statePath(ctx), JSON.stringify(s, null, 1) + "\n", { mode: 0o600 });
        return out;
      } finally {
        release();
      }
    if (i >= 200) throw new Error(`${statePath(ctx)} is locked by another 0b; try again`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** The synced folder `dir` is in (the innermost one), if any. */
export function folderAt(ctx: Context, dir: string): { dir: string; state: FolderState } | null {
  let best: { dir: string; state: FolderState } | null = null;
  for (const [root, state] of Object.entries(loadDriveState(ctx).folders))
    if (isInside(root, dir) && (!best || root.length > best.dir.length)) best = { dir: root, state };
  return best;
}

/** The device-token client of the account a folder syncs with. */
export function clientFor(ctx: Context, st: Pick<FolderState, "userId">): CloudClient {
  const acct = findAccount(loadAccounts(ctx), st.userId);
  const token = acct && openSecretStore(ctx.storeDir).get(deviceTokenKey(acct));
  if (!acct || !token) throw new Error(`the account this folder syncs with isn't signed in here anymore (0b login, or 0b drive unlink)`);
  return new CloudClient(acct.server, token);
}

/** "Personal" or "Acme"; with the Drive folder: "Acme › tax-invoices". */
export const folderLabel = (st: Pick<FolderState, "workspaceName" | "prefix">) => (st.prefix ? `${st.workspaceName} › ${st.prefix.replace(/\/$/, "")}` : `${st.workspaceName} Drive`);

/** Register `dir` as synced with a Drive folder. Refuses a folder inside or around another synced one. */
export async function linkFolder(
  ctx: Context,
  dir: string,
  ws: Pick<RemoteWorkspace, "id" | "name">,
  prefix: string,
  o: { files?: Record<string, SyncedFile>; userId?: string; server?: string } = {},
): Promise<void> {
  const cfg = o.userId && o.server ? { userId: o.userId, server: o.server } : loadCloud(ctx);
  if (!cfg) throw new Error("Not signed in. Run `0b login` first.");
  await editDriveState(ctx, (s) => {
    for (const [root, f] of Object.entries(s.folders)) {
      if (root === dir) {
        if (f.workspaceId !== ws.id || f.prefix !== prefix) throw new Error(`${dir} already syncs with ${folderLabel(f)}; 0b drive unlink it first`);
        return;
      }
      if (isInside(root, dir) || isInside(dir, root)) throw new Error(`${dir} would overlap ${root}, which already syncs with ${folderLabel(f)}`);
    }
    s.folders[dir] = { server: cfg.server, userId: cfg.userId, workspaceId: ws.id, workspaceName: ws.name, prefix, cursor: 0, files: o.files ?? {} };
  });
}

export async function unlinkFolder(ctx: Context, dir: string): Promise<FolderState | null> {
  return editDriveState(ctx, (s) => {
    const f = s.folders[dir] ?? null;
    delete s.folders[dir];
    return f;
  });
}

// ── What's here ──

/**
 * The built-in ignore rules; the folder's `.driveignore` adds to them. One person's agent settings
 * (Claude Code's settings.local.json, with its allowed commands and hooks, and CLAUDE.local.md)
 * stay on their machine: never pushed to the team, never pulled.
 */
export const DEFAULT_IGNORE = [
  ".git/",
  "node_modules/",
  "__pycache__/",
  ".venv/",
  "*.sqlite-journal",
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
  "*.0bridge-*",
  "**/.claude/settings.local.json",
  "CLAUDE.local.md",
];
export const IGNORE_FILE = ".driveignore";

/** A conflict copy (or one of sync's own temp files): never pushed. */
export const isConflictCopy = (path: string) => basename(path).includes(".0bridge-");

const escapeRe = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");

/**
 * Gitignore's subset: `#` comments, `*`, `?`, `**`, a trailing `/` (folders only), a leading `/`
 * or an inner `/` (relative to the folder's root). No `!`. Returns a test of a relative POSIX path.
 */
export function ignoreRules(lines: string[]): (path: string, isDir: boolean) => boolean {
  const rules: { re: RegExp; dirOnly: boolean }[] = [];
  for (const raw of lines) {
    let p = raw.replace(/\s+$/, "");
    if (!p || p.startsWith("#") || p.startsWith("!")) continue;
    const dirOnly = p.endsWith("/");
    if (dirOnly) p = p.replace(/\/+$/, "");
    const anchored = p.startsWith("/") || p.includes("/");
    p = p.replace(/^\/+/, "");
    if (!p) continue;
    let body = "";
    for (let i = 0; i < p.length; i++) {
      if (p.startsWith("**/", i)) (body += "(?:.*/)?", (i += 2));
      else if (p.startsWith("/**", i) && i + 3 === p.length) (body += "(?:/.*)?", (i += 2));
      else if (p.startsWith("**", i)) (body += ".*", (i += 1));
      else if (p[i] === "*") body += "[^/]*";
      else if (p[i] === "?") body += "[^/]";
      else body += escapeRe(p[i]!);
    }
    rules.push({ re: new RegExp(anchored ? `^${body}$` : `(?:^|/)${body}$`), dirOnly });
  }
  return (path, isDir) => rules.some((r) => (!r.dirOnly || isDir) && r.re.test(path));
}

/** The folder's rules: the built-in ones plus its `.driveignore`. */
export function folderRules(dir: string): (path: string, isDir: boolean) => boolean {
  let extra: string[] = [];
  try {
    extra = readFileSync(join(dir, IGNORE_FILE), "utf8").split(/\r?\n/);
  } catch {}
  return ignoreRules([...DEFAULT_IGNORE, ...extra]);
}

export interface LocalFile {
  size: number;
  mtimeMs: number;
}

/**
 * Every file under `dir` sync would consider, by relative POSIX path (NFC): ignored folders aren't
 * entered, symlinks are skipped, files over Drive's 25 MB are listed in `large`.
 */
export function scanFolder(dir: string, ignored = folderRules(dir)): { files: Map<string, LocalFile>; large: string[] } {
  const files = new Map<string, LocalFile>();
  const large: string[] = [];
  const walk = (abs: string, rel: string) => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const name = e.name.normalize("NFC");
      const path = rel ? `${rel}/${name}` : name;
      const full = join(abs, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!ignored(path, true)) walk(full, path);
        continue;
      }
      if (!e.isFile() || ignored(path, false)) continue;
      let st;
      try {
        st = statSync(full);
      } catch {
        continue; // gone since the listing
      }
      if (st.size > MAX_SYNC_BYTES) large.push(path);
      else files.set(path, { size: st.size, mtimeMs: st.mtimeMs });
    }
  };
  walk(dir, "");
  return { files, large };
}

/** Of `paths`, the ones git ignores in the repo `dir` is in (none when it isn't in one, or git isn't here). Read-only. */
export function gitIgnored(dir: string, paths: string[]): Set<string> {
  if (!paths.length) return new Set();
  const r = spawnSync("git", ["check-ignore", "--stdin", "-z"], { cwd: dir, input: paths.join("\0") + "\0", encoding: "utf8" });
  if (r.status !== 0 && r.status !== 1) return new Set();
  return new Set((r.stdout ?? "").split("\0").filter(Boolean));
}

/** Whether `dir` is inside a git work tree. */
export const inGitRepo = (dir: string) => spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir, encoding: "utf8" }).stdout?.trim() === "true";

// ── Writing here, safely ──

const abs = (dir: string, path: string) => join(dir, ...path.split("/"));

const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
/** What no disk here takes, or a terminal printing it would act on (the gateway refuses these too), and what only Windows doesn't take. */
const NEVER = /[\\:\u0000-\u001f\u007f-\u009f]/;
const NOT_ON_WINDOWS = /[*?"<>|]/;

/**
 * Why a Drive path can't be written in `dir` on this machine, or null when it can: a part this
 * disk reads as something else (`\` and `:` on Windows, a trailing dot or space Windows drops, a
 * device name, `.git` in any spelling) or a path that resolves outside the folder. The gateway
 * refuses these too (normalizePath); this holds whatever a server sends.
 */
export function unsafePath(dir: string, path: string, platform: string = process.platform): string | null {
  const segs = path.split("/");
  for (const seg of segs) {
    if (!seg || seg === "." || seg === ".." || NEVER.test(seg) || (platform === "win32" && NOT_ON_WINDOWS.test(seg)) || /[. ]$/.test(seg) || WINDOWS_DEVICE.test(seg))
      return `"${seg}" isn't a safe name on this disk`;
    const bare = foldName(seg);
    if (bare === ".git" || /^git~\d+$/.test(bare)) return "sync never writes into .git";
  }
  const target = resolve(abs(dir, path));
  return target !== resolve(dir) && isInside(dir, target) ? null : "it would land outside the folder";
}

/** Whether the folder's rules ignore `path` or a folder it's in (what's ignored here never comes down either). */
function ignoredHere(rules: (path: string, isDir: boolean) => boolean, path: string): boolean {
  const segs = path.split("/");
  for (let n = 1; n < segs.length; n++) if (rules(segs.slice(0, n).join("/"), true)) return true;
  return rules(path, false);
}

/** Where `path` lands in `dir`; throws when that isn't safe (see unsafePath). */
function target(dir: string, path: string): string {
  const why = unsafePath(dir, path);
  if (why) throw new Error(`not written here: ${why}`);
  return abs(dir, path);
}

/** Whether `path` is one of sync's own links, or inside one. */
const throughLink = (path: string, st: FolderState) => (st.links ?? []).some((l) => path === l || path.startsWith(`${l}/`));

const lexists = (p: string) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * Make `path`'s parent folders, never through a symlink: a link sync made itself is removed (a real
 * folder from Drive replaces it), any other one refuses, so nothing is ever written outside `dir`.
 */
function prepareParent(dir: string, path: string, st: FolderState): void {
  const parts = path.split("/").slice(0, -1);
  let cur = dir;
  let rel = "";
  for (const p of parts) {
    cur = join(cur, p);
    rel = rel ? `${rel}/${p}` : p;
    let s;
    try {
      s = lstatSync(cur);
    } catch {
      mkdirSync(cur);
      continue;
    }
    if (s.isSymbolicLink()) {
      if (!st.links?.includes(rel)) throw new Error(`${rel} is a symlink here; not writing through it`);
      unlinkSync(cur);
      st.links = st.links.filter((l) => l !== rel);
      mkdirSync(cur);
    } else if (!s.isDirectory()) throw new Error(`${rel} is a file here, and Drive has a folder by that name`);
  }
}

/** Whether a file at `path` may come down runnable: a script (#!) in a skill's folder. */
export const runnableHere = (path: string, bytes: Uint8Array) => /(^|\/)\.agents\/skills\//.test(path) && bytes[0] === 0x23 && bytes[1] === 0x21;

function writeHere(dir: string, path: string, bytes: Uint8Array, st: FolderState): LocalFile {
  const file = target(dir, path);
  prepareParent(dir, path, st);
  let existing;
  try {
    existing = lstatSync(file);
  } catch {}
  if (existing?.isDirectory()) throw new Error(`${path} is a folder here, and Drive has a file by that name`);
  if (existing?.isSymbolicLink()) {
    if (!(st.links ?? []).includes(path)) throw new Error(`${path} is a symlink here; not writing through it`);
    // CLAUDE.md as a link to AGENTS.md (sync's own) becomes Drive's real file.
    unlinkSync(file);
    st.links = (st.links ?? []).filter((l) => l !== path);
  }
  const tmp = `${file}.0bridge-${process.pid}.tmp`;
  // Modes don't sync. A skill's script (#!) comes down runnable: only owners and admins change
  // .agents/ directly (anyone else's change there waits as a proposal); anything else comes down plain.
  writeFileSync(tmp, bytes, runnableHere(path, bytes) ? { mode: 0o755 } : {});
  renameSync(tmp, file);
  const s = statSync(file);
  return { size: s.size, mtimeMs: s.mtimeMs };
}

/** Remove a file, and the folders it leaves empty (up to the folder's root). */
function removeHere(dir: string, path: string): void {
  const file = target(dir, path);
  rmSync(file, { force: true });
  let d = dirname(file);
  while (d !== dir && isInside(dir, d)) {
    try {
      rmdirSync(d);
    } catch {
      break;
    }
    d = dirname(d);
  }
}

/** `notes.md` changed by "Claude" in v3 → `notes.0bridge-claude-v3.md`. */
export function conflictName(path: string, via: string | null, version: number): string {
  const slug =
    (via ?? "")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24)
      .replace(/-+$/, "") || "other";
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  const ext = name.lastIndexOf(".") > 0 ? name.slice(name.lastIndexOf(".")) : "";
  const stem = ext ? name.slice(0, -ext.length) : name;
  return `${path.slice(0, slash + 1)}${stem}.0bridge-${slug}-v${version}${ext}`;
}

/**
 * The skills-on-disk links, in every folder of the synced files that has them: `<f>/.claude/skills/<name>`
 * for each `<f>/.agents/skills/<name>/`, and `<f>/CLAUDE.md` → `AGENTS.md`. Never over a real file.
 */
export function linkSkills(dir: string, st: FolderState): string[] {
  const made: string[] = [];
  const links = new Set(st.links ?? []);
  const want = new Map<string, string>();
  for (const path of Object.keys(st.files)) {
    const skill = /^(?:(.*?)\/)?\.agents\/skills\/([^/]+)\/./.exec(path);
    if (skill) {
      const f = skill[1] ? `${skill[1]}/` : "";
      if (lexists(abs(dir, `${f}.agents/skills/${skill[2]}`))) want.set(`${f}.claude/skills/${skill[2]}`, `../../.agents/skills/${skill[2]}`);
    }
    const agents = /(^|\/)\.(agents|claude)\//.test(path) ? null : /^(?:(.*)\/)?AGENTS\.md$/.exec(path);
    if (agents) {
      const f = agents[1] ? `${agents[1]}/` : "";
      try {
        if (lstatSync(abs(dir, path)).isFile()) want.set(`${f}CLAUDE.md`, "AGENTS.md");
      } catch {}
    }
  }
  // Ours whose target is gone (a skill deleted from Drive) go too.
  for (const l of links) {
    const p = abs(dir, l);
    let s;
    try {
      s = lstatSync(p);
    } catch {
      links.delete(l);
      continue;
    }
    if (!s.isSymbolicLink()) links.delete(l);
    else if (!want.has(l)) (unlinkSync(p), links.delete(l));
  }
  for (const [l, to] of want) {
    const p = abs(dir, l);
    if (lexists(p) || unsafePath(dir, l)) continue;
    try {
      prepareParent(dir, l, st);
      symlinkSync(to, p, l.endsWith("CLAUDE.md") ? "file" : "dir");
      links.add(l);
      made.push(l);
    } catch {
      // Windows without Developer Mode can't make symlinks: Drive's files are still all here.
    }
  }
  st.links = [...links].sort();
  return made;
}

// ── One folder ──

export interface SyncReport {
  dir: string;
  /** "Acme › tax-invoices". */
  label: string;
  pulled: string[];
  pushed: string[];
  /** Deleted here because they were deleted in Drive. */
  removed: string[];
  /** Deleted in Drive because they were deleted here. */
  deleted: string[];
  conflicts: { path: string; copy: string }[];
  proposals: { path: string; id: string }[];
  warnings: { path: string; flags: SensitiveFlag[] }[];
  large: string[];
  /** In Drive but not written here: why (an unsafe name on this disk). */
  skipped: { path: string; why: string }[];
  /** Here but not sent: why (a name Drive doesn't take). */
  stays: { path: string; why: string }[];
  errors: string[];
  links: string[];
  /** Another 0b was syncing this folder: nothing done. */
  busy?: boolean;
}

const hashFile = (p: string) => sha256(readFileSync(p));

/**
 * Pull, then push, one synced folder. Holds the folder's lock for the whole run (another sync of it
 * returns `busy`), and the state file's lock only to read and write it.
 */
export async function syncFolder(ctx: Context, dir: string, o: { quiet?: boolean; client?: CloudClient } = {}): Promise<SyncReport> {
  dir = resolve(dir);
  const r: SyncReport = { dir, label: "", pulled: [], pushed: [], removed: [], deleted: [], conflicts: [], proposals: [], warnings: [], large: [], skipped: [], stays: [], errors: [], links: [] };
  const release = tryLock(folderLockPath(ctx, dir));
  if (!release) return { ...r, busy: true };
  try {
    const saved = loadDriveState(ctx).folders[dir];
    if (!saved) throw new Error(`${tilde(ctx, dir)} isn't synced with Drive (0b drive clone <folder> <dir>)`);
    if (!existsSync(dir)) throw new Error(`${tilde(ctx, dir)} doesn't exist anymore (0b drive unlink ${dir} stops syncing it)`);
    const st: FolderState = structuredClone(saved);
    r.label = folderLabel(st);
    const api = new DriveApi(o.client ?? clientFor(ctx, st), st.workspaceId);
    try {
      await runSync(api, dir, st, r);
    } finally {
      await editDriveState(ctx, (s) => {
        // Unlinked meanwhile: stays unlinked.
        if (s.folders[dir]) s.folders[dir] = st;
      });
    }
    return r;
  } finally {
    release();
  }
}

/**
 * Every remote change since the folder's cursor, by local path (one entry per path, the latest),
 * and the new cursor. From the start (cursor 0) or when the server no longer keeps the cursor's
 * changes (`reset`), the folder's tree stands in: its files as changes, and recorded files it
 * no longer has as deletes.
 */
async function remoteChanges(api: DriveApi, st: FolderState): Promise<{ remote: Map<string, RemoteChange>; cursor: number }> {
  const remote = new Map<string, RemoteChange>();
  const local = (p: string) => (p.startsWith(st.prefix) ? p.slice(st.prefix.length) : null);
  let cursor = st.cursor;
  for (;;) {
    const page = await api.changes(cursor, st.prefix);
    if (page.reset) {
      remote.clear();
      const t = await api.fullTree(st.prefix);
      for (const n of t.nodes) {
        const rel = local(n.path);
        if (rel) remote.set(rel, { path: n.path, version: n.version, sha256: n.sha256, size: n.size, mime: n.mime, deleted: false, seq: n.seq, at: n.updatedAt, via: n.updatedVia, trusted: n.trusted });
      }
      // Recorded but not in Drive: deleted there. Not when the tree may be cut short, and never a
      // proposal that was never applied (version 0): it's only here.
      if (t.complete)
        for (const [rel, f] of Object.entries(st.files))
          if (!remote.has(rel) && f.version > 0) remote.set(rel, { path: st.prefix + rel, version: f.version, sha256: null, size: 0, mime: "", deleted: true, seq: t.cursor, at: 0, via: null });
      return { remote, cursor: t.cursor };
    }
    for (const ch of page.changes) {
      const rel = local(ch.path);
      if (rel) remote.set(rel, ch);
    }
    // A page of other folders' changes can be empty here and still have more after it.
    const moved = page.cursor > cursor;
    cursor = page.cursor;
    if (!page.more || !moved) break;
  }
  return { remote, cursor };
}

async function runSync(api: DriveApi, dir: string, st: FolderState, r: SyncReport): Promise<void> {
  const remotePath = (rel: string) => st.prefix + rel;

  // What's here, hashed (re-using the recorded hash when size and mtime are the ones recorded).
  const rules = folderRules(dir);
  const scan = scanFolder(dir, rules);
  r.large = scan.large;
  const local = new Map<string, LocalFile & { sha256: string }>();
  for (const [path, f] of scan.files) {
    const known = st.files[path];
    const same = known && known.size === f.size && known.mtimeMs === f.mtimeMs;
    local.set(path, { ...f, sha256: same ? known.sha256 : hashFile(abs(dir, path)) });
  }

  // Pull: every change since the cursor.
  const { remote, cursor } = await remoteChanges(api, st);
  const handled = new Set<string>();
  const saveCopy = async (path: string, version: number, via: string | null, sha: string | null) => {
    const copy = conflictName(path, via, version);
    const bytes = await api.download(remotePath(path), version);
    if (sha && sha256(bytes) !== sha) throw new Error(`${path} v${version} came down damaged; try again`);
    writeHere(dir, copy, bytes, st);
    r.conflicts.push({ path, copy });
    return copy;
  };
  for (const [path, ch] of remote) {
    try {
      // Not here: conflict copies, what this folder ignores (.git/ among them), and what this disk can't hold safely.
      if (isConflictCopy(path) || ignoredHere(rules, path)) continue;
      const why = unsafePath(dir, path);
      if (why) {
        r.skipped.push({ path, why });
        continue;
      }
      // Instructions no owner or admin wrote or applied (saved before proposals existed) aren't
      // written where agents would follow them.
      if (!ch.deleted && ch.trusted === false && isInstructionPath(ch.path)) {
        r.skipped.push({ path, why: "it's an instruction file no owner or admin has approved (one of them saving it again approves it)" });
        continue;
      }
      const known = st.files[path];
      const here = local.get(path);
      if (known && known.version >= ch.version && !ch.deleted) continue; // what we pushed, coming back
      // There but not scanned: ignored here (.driveignore, too large), so it stays this machine's own.
      // Sync's own links (and paths through them) are replaced by Drive's real files.
      if (!here && lexists(abs(dir, path)) && !throughLink(path, st)) continue;
      const changedHere = here ? !known || here.sha256 !== known.sha256 : Boolean(known);
      if (ch.deleted) {
        handled.add(path);
        if (!here) delete st.files[path];
        else if (!changedHere) (removeHere(dir, path), delete st.files[path], r.removed.push(path));
        else delete st.files[path]; // changed here, deleted there: this copy stays, and goes up as new
        continue;
      }
      if (here && here.sha256 === ch.sha256) {
        st.files[path] = { version: ch.version, sha256: here.sha256, size: here.size, mtimeMs: here.mtimeMs };
        handled.add(path);
        continue;
      }
      if (here && changedHere) {
        // Both sides: theirs next to it, ours goes up on top of theirs.
        await saveCopy(path, ch.version, ch.via, ch.sha256);
        st.files[path] = { version: ch.version, sha256: known?.sha256 ?? "", size: known?.size ?? 0, mtimeMs: known?.mtimeMs ?? 0 };
        continue;
      }
      // New there, changed there, or deleted here while changed there (theirs comes back).
      const bytes = await api.download(remotePath(path));
      if (ch.sha256 && sha256(bytes) !== ch.sha256) throw new Error(`${path} came down damaged; try again`);
      const f = writeHere(dir, path, bytes, st);
      st.files[path] = { version: ch.version, sha256: sha256(bytes), ...f };
      local.set(path, { ...f, sha256: st.files[path]!.sha256 });
      handled.add(path);
      r.pulled.push(path);
    } catch (e) {
      r.errors.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!r.errors.length) st.cursor = cursor;

  // Push: what changed here (new files git ignores stay here).
  const fresh = [...local.keys()].filter((p) => !st.files[p]);
  const gitSkips = inGitRepo(dir) ? gitIgnored(dir, fresh) : new Set<string>();
  let readOnly = false;
  // Each file is its own request (about a second on the server), so a few go up at once.
  const pushOne = async ([path, f]: [string, LocalFile & { sha256: string }]) => {
    const known = st.files[path];
    if (known && known.sha256 === f.sha256) {
      known.size = f.size;
      known.mtimeMs = f.mtimeMs;
      return;
    }
    if ((!known && gitSkips.has(path)) || readOnly) return;
    // A name Drive refuses (a trailing dot, a `:`, a device name): it stays this machine's own.
    const why = unsafePath(dir, path);
    if (why) {
      r.stays.push({ path, why });
      return;
    }
    try {
      const bytes = readFileSync(abs(dir, path));
      let base: number | undefined = known ? known.version : 0;
      for (let attempt = 0; attempt < 2; attempt++) {
        const out = await api.put(remotePath(path), bytes, { base, sync: true, sha256: f.sha256 });
        if (out.ok && "node" in out) {
          st.files[path] = { version: out.node.version, sha256: f.sha256, size: f.size, mtimeMs: f.mtimeMs };
          if (!out.unchanged) r.pushed.push(path);
          if (out.warnings.length) r.warnings.push({ path, flags: out.warnings });
          break;
        }
        if (out.ok) {
          // An instruction file this account may not change directly: an owner or admin applies it. Not proposed again until it changes here.
          st.files[path] = { version: known?.version ?? 0, sha256: f.sha256, size: f.size, mtimeMs: f.mtimeMs };
          r.proposals.push({ path, id: out.proposal.id });
          if (out.warnings.length) r.warnings.push({ path, flags: out.warnings });
          break;
        }
        if (out.code !== "CONFLICT") {
          // A lapsed team takes no files at all: one line, not one per file (others may have been on their way up).
          if (out.code === "READ_ONLY") {
            if (!readOnly) r.errors.push(`${path}: ${out.error}`);
            readOnly = true;
          } else r.errors.push(`${path}: ${out.error}`);
          break;
        }
        // Changed there since our base: keep theirs next to ours, then go on top of it.
        const latest = out.latest;
        if (attempt === 1) {
          r.errors.push(`${path}: changed again in Drive while syncing; next sync tries again`);
          break;
        }
        if (!latest) base = 0; // deleted there: nothing live to keep
        else {
          await saveCopy(path, latest.version, latest.updatedVia, latest.sha256);
          base = latest.version;
        }
      }
    } catch (e) {
      r.errors.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  await inParallel([...local], PUSH_AT_ONCE, pushOne);
  // Reported in the folder's order, whichever finished first.
  const order = new Map([...local.keys()].map((p, i) => [p, i]));
  r.pushed.sort((a, b) => order.get(a)! - order.get(b)!);

  // Deleted here: deleted there (unless it's still here but ignored now: then it just stops syncing).
  for (const [path, known] of Object.entries(st.files)) {
    if (local.has(path) || handled.has(path) || readOnly) continue;
    if (lexists(abs(dir, path))) {
      delete st.files[path];
      continue;
    }
    try {
      const out = await api.remove(remotePath(path), known.version, { sync: true });
      if (out.ok && "proposal" in out) (r.proposals.push({ path, id: out.proposal.id }), delete st.files[path]);
      else if (out.ok || out.code === "NOT_FOUND") (delete st.files[path], out.ok && r.deleted.push(path));
      else if (out.latest) {
        // Changed there since: theirs comes back rather than being deleted.
        const bytes = await api.download(remotePath(path));
        const f = writeHere(dir, path, bytes, st);
        st.files[path] = { version: out.latest.version, sha256: sha256(bytes), ...f };
        r.pulled.push(path);
      } else delete st.files[path];
    } catch (e) {
      r.errors.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  r.links = linkSkills(dir, st);
}

/** Files uploaded at once by a sync. */
export const PUSH_AT_ONCE = 6;

/** `fn` over `items`, at most `limit` at a time. */
export async function inParallel<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// ── Reports ──

const FLAG_WORDS: Record<SensitiveFlag["kind"], string> = {
  rrn: "a resident registration number",
  card: "a card number",
  account: "a bank account number",
  password: "a password",
  secret: "an API key or secret",
};

/** "a resident registration number (900101-1******)", for sensitive-data warnings. */
export const describeFlags = (flags: SensitiveFlag[]) => flags.map((f) => `${FLAG_WORDS[f.kind] ?? f.kind}${f.sample ? ` (${f.sample})` : ""}`).join(", ");

export function printReport(ctx: Context, r: SyncReport, o: { quiet?: boolean; header?: boolean; server?: string } = {}): void {
  const noisy = r.conflicts.length || r.errors.length || r.proposals.length || r.warnings.length || r.skipped.length;
  if (o.quiet && !noisy) return;
  if (o.header) console.log(c.bold(`${r.label} ${c.dim(tilde(ctx, r.dir))}`));
  if (r.busy) return console.log(c.dim("  another 0b is syncing this folder right now"));
  for (const p of r.pulled) console.log(`${c.green("↓")} ${p}`);
  for (const p of r.pushed) console.log(`${c.green("↑")} ${p}`);
  for (const p of r.removed) console.log(`${c.dim("✕")} ${p} ${c.dim("(deleted in Drive)")}`);
  for (const p of r.deleted) console.log(`${c.dim("✕")} ${p} ${c.dim("(deleted here, so in Drive too; its versions keep it restorable)")}`);
  for (const x of r.conflicts) console.log(`${c.yellow("!")} ${x.path} ${c.dim(`— changed here and in Drive. Theirs is next to it as ${x.copy}; yours went up. Merge them and delete the copy.`)}`);
  for (const x of r.proposals)
    console.log(`${c.yellow("●")} ${x.path} ${c.dim(`is an instruction file: your change waits as proposal ${x.id} for an owner or admin to apply in the dashboard${o.server ? ` (${o.server}/app/drive/proposals)` : ""}`)}`);
  for (const w of r.warnings) console.log(`${c.yellow("!")} ${w.path} looks like it contains ${describeFlags(w.flags)}. Consider the vault, or a masked copy.`);
  for (const p of r.large) if (!o.quiet) console.log(`${c.dim("·")} ${p} ${c.dim("is over 25 MB, so it stays on this machine")}`);
  for (const x of r.skipped) console.log(`${c.yellow("!")} ${x.path} ${c.dim(`is in Drive but not synced here: ${x.why}`)}`);
  for (const x of r.stays) if (!o.quiet) console.log(`${c.dim("·")} ${x.path} ${c.dim(`stays on this machine: ${x.why}`)}`);
  for (const e of r.errors) console.log(`${c.red("✗")} ${e}`);
  if (!o.quiet && !r.pulled.length && !r.pushed.length && !r.removed.length && !r.deleted.length && !noisy) console.log(c.dim("Up to date."));
}

/** `0b background`: every synced folder, one at a time; a folder whose lock is held is skipped. */
export async function syncAllDriveFolders(ctx: Context, quiet: boolean): Promise<void> {
  const folders = Object.entries(loadDriveState(ctx).folders);
  for (const [dir, st] of folders) {
    if (!existsSync(dir)) {
      if (!quiet) console.log(c.yellow(`${tilde(ctx, dir)} is gone; 0b drive unlink ${dir} stops syncing it`));
      continue;
    }
    try {
      const r = await syncFolder(ctx, dir, { quiet });
      if (r.busy) continue;
      printReport(ctx, r, { quiet, header: true, server: st.server });
    } catch (e) {
      console.error(`${new Date().toISOString()} drive: ${tilde(ctx, dir)}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

/** A workspace by id or name (any case); none named: the personal one. */
export async function resolveWorkspace(api: DriveApi, which?: string | null): Promise<RemoteWorkspace> {
  const all = await api.workspaces();
  const w = !which || which === "personal" ? all.find((x) => x.personal) : (all.find((x) => x.id === which) ?? all.find((x) => x.name.toLowerCase() === which.toLowerCase()));
  if (!w) throw new Error(`no workspace "${which}" among yours (${all.map((x) => x.name).join(", ") || "none"})`);
  return w;
}

/**
 * `0b drive clone <folder> [dir]`: a new local folder synced with a Drive folder ("" for all of
 * Drive), named after the Drive folder in the current directory by default. A folder that isn't
 * empty is refused unless `force`: then the two are merged (files only here go up, a file on both
 * sides that differs keeps this machine's and saves Drive's next to it).
 */
export async function cloneFolder(ctx: Context, folder: string, dir?: string, o: { workspace?: string; client?: CloudClient; quiet?: boolean; force?: boolean } = {}): Promise<string> {
  const cfg = loadCloud(ctx);
  if (!cfg) throw new Error("Not signed in. Run `0b login` first.");
  const client = o.client ?? clientFor(ctx, cfg);
  const ws = await resolveWorkspace(new DriveApi(client), o.workspace);
  const api = new DriveApi(client, ws.id);
  folder = cleanFolder(folder);
  const prefix = prefixOf(folder);
  const target = resolve(dir ?? (folder ? folder.split("/").pop()! : "drive"));
  if (target === resolve(ctx.home) || target === dirname(target)) throw new Error(`${tilde(ctx, target)} is too big a place to sync; clone into a folder of its own`);
  const linked = loadDriveState(ctx).folders[target];
  const nonEmpty = existsSync(target) && readdirSync(target).length > 0 && !(linked?.workspaceId === ws.id && linked.prefix === prefix);
  if (nonEmpty && !o.force) throw new Error(`${tilde(ctx, target)} isn't empty; clone into a new folder, or add --force to merge it with ${folder || "Drive"} (files only here go up)`);
  if (folder && !nonEmpty && !(await api.tree(prefix, 1)).nodes.length) throw new Error(`${ws.name}'s Drive has no folder "${folder}" (0b drive ls lists them)`);
  mkdirSync(target, { recursive: true });
  await linkFolder(ctx, target, ws, prefix, { userId: cfg.userId, server: cfg.server });
  const r = await syncFolder(ctx, target, { client: o.client });
  if (!o.quiet) printReport(ctx, { ...r, pulled: [] }, { quiet: true, server: cfg.server });
  return target;
}

/**
 * `0b drive status`: what sync would do in a folder, without doing it: changed here, changed in
 * Drive, conflict copies waiting, and which of the files on both sides git tracks.
 */
export async function folderStatus(ctx: Context, dir: string, o: { client?: CloudClient } = {}) {
  dir = resolve(dir);
  const st = loadDriveState(ctx).folders[dir];
  if (!st) throw new Error(`${tilde(ctx, dir)} isn't synced with Drive`);
  const api = new DriveApi(o.client ?? clientFor(ctx, st), st.workspaceId);
  const rules = folderRules(dir);
  const scan = scanFolder(dir, rules);
  const git = inGitRepo(dir);
  // New files git ignores stay here (as in sync).
  const skip = git ? gitIgnored(dir, [...scan.files.keys()].filter((p) => !st.files[p])) : new Set<string>();
  const changedHere: string[] = [];
  const missingHere: string[] = [];
  for (const [path, f] of scan.files) {
    const known = st.files[path];
    if (known ? (known.size !== f.size || known.mtimeMs !== f.mtimeMs) && hashFile(abs(dir, path)) !== known.sha256 : !skip.has(path)) changedHere.push(path);
  }
  for (const path of Object.keys(st.files)) if (!scan.files.has(path) && !lexists(abs(dir, path))) missingHere.push(path);
  const changedThere: string[] = [];
  const { remote } = await remoteChanges(api, st);
  for (const [path, ch] of remote) {
    const known = st.files[path];
    if (isConflictCopy(path) || ignoredHere(rules, path) || (known && known.version >= ch.version && !ch.deleted) || (ch.deleted && !known)) continue;
    // What `reset` lists that matches what's recorded isn't a change.
    if (known && !ch.deleted && known.sha256 === ch.sha256 && known.version === ch.version) continue;
    changedThere.push(path);
  }
  const there = new Set(changedThere);
  const both = [...changedHere, ...missingHere].filter((p) => there.has(p));
  const copies: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && !["node_modules", ".git", "__pycache__", ".venv"].includes(e.name)) walk(join(d, e.name), path);
      else if (e.isFile() && isConflictCopy(path) && !e.name.endsWith(".tmp")) copies.push(path);
    }
  };
  walk(dir, "");
  let tracked: string[] = [];
  if (both.length && git) {
    const out = spawnSync("git", ["ls-files", "-z", "--", ...both], { cwd: dir, encoding: "utf8" }).stdout ?? "";
    const top = spawnSync("git", ["rev-parse", "--show-prefix"], { cwd: dir, encoding: "utf8" }).stdout?.trim() ?? "";
    tracked = out
      .split("\0")
      .filter(Boolean)
      .map((p) => (top && p.startsWith(top) ? p.slice(top.length) : p));
  }
  return { state: st, changedHere, missingHere, changedThere: [...there], both, copies, tracked, large: scan.large };
}

/** A relative POSIX path of `p` under `root` (for messages and Drive paths). */
export const posixRel = (root: string, p: string) => relative(root, p).split(sep).join("/");
