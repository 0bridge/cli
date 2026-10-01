import { createHash } from "node:crypto";
import { chmodSync, rmSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (e: any) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

export function readJson<T = any>(path: string): T | null {
  const text = readText(path);
  return text == null || text.trim() === "" ? null : (JSON.parse(text) as T);
}

/**
 * Write via temp file + rename so a crash never leaves a half-written config.
 * Uses `opts.mode` if given, else keeps the original file's mode. The temp file is
 * created with that mode, so content is never briefly readable with looser permissions.
 */
export function writeAtomic(path: string, content: string, opts: { mode?: number; dirMode?: number } = {}): void {
  mkdirSync(dirname(path), { recursive: true, mode: opts.dirMode });
  let mode = opts.mode;
  if (mode == null) {
    try {
      mode = statSync(path).mode & 0o777;
    } catch {}
  }
  const tmp = `${path}.0bridge-${process.pid}.tmp`;
  rmSync(tmp, { force: true }); // stale temp from a crashed run; "wx" below must create a fresh file
  writeFileSync(tmp, content, { mode: mode ?? 0o666, flag: "wx" });
  if (mode != null) chmodSync(tmp, mode);
  renameSync(tmp, path);
}

/**
 * Whether `p` is `root` or under it. By path.relative, not by string prefix: `/a/bc` isn't under
 * `/a/b`, Windows compares without case, and a path on another drive (for which relative gives
 * back an absolute path) is outside.
 */
export function isInside(root: string, p: string): boolean {
  const r = relative(resolve(root), resolve(p));
  return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}

/** Recursively list files under dir (relative paths, sorted), skipping OS junk. */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      if (ent.name === ".DS_Store") continue;
      const p = join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile()) out.push(relative(dir, p));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

/** Content hash of a directory tree (paths + bytes). */
export function hashDir(dir: string): string {
  const h = createHash("sha256");
  for (const rel of listFiles(dir)) {
    h.update(rel).update("\0").update(readFileSync(join(dir, rel))).update("\0");
  }
  return h.digest("hex");
}

/** Deterministic JSON (sorted object keys) for structural comparison. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .filter((k) => (v as any)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as any)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Minimal shell-style split for commands stored as one string (Cursor allows `"command": "npx -y pkg"`). */
export function shellSplit(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === "\\" && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

export function isEmpty(o: object | undefined | null): boolean {
  return !o || Object.keys(o).length === 0;
}
