/**
 * Surgical edits of `[mcp_servers.<name>]` tables in a TOML file, leaving every other
 * byte (comments, ordering, unrelated tables) untouched.
 */
import { parse, stringify } from "smol-toml";
import { stableStringify } from "./util.ts";

const HEADER = /^\s*\[(?!\[)(.+?)\]\s*(#.*)?$/;
const ARRAY_HEADER = /^\s*\[\[/;

/** Parse a dotted TOML key path like `mcp_servers."a.b".env`. Returns null if malformed. */
export function parseKeyPath(src: string): string[] | null {
  const out: string[] = [];
  let i = 0;
  const s = src.trim();
  while (i < s.length) {
    while (s[i] === " " || s[i] === "\t") i++;
    let key = "";
    if (s[i] === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && i + 1 < s.length) {
          key += s[i + 1];
          i += 2;
        } else key += s[i++];
      }
      if (s[i] !== '"') return null;
      i++;
    } else if (s[i] === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return null;
      key = s.slice(i + 1, end);
      i = end + 1;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i));
      if (!m) return null;
      key = m[0];
      i += key.length;
    }
    out.push(key);
    while (s[i] === " " || s[i] === "\t") i++;
    if (i < s.length) {
      if (s[i] !== ".") return null;
      i++;
    }
  }
  return out;
}

interface Block {
  start: number; // line index of header
  end: number; // exclusive
  path: string[] | null;
}

function blocks(lines: string[]): Block[] {
  const out: Block[] = [];
  lines.forEach((line, i) => {
    const m = HEADER.exec(line);
    if (m || ARRAY_HEADER.test(line)) {
      if (out.length) out[out.length - 1]!.end = i;
      out.push({ start: i, end: lines.length, path: m && !ARRAY_HEADER.test(line) ? parseKeyPath(m[1]!) : null });
    }
  });
  return out;
}

/** Render one server as TOML tables. */
export function renderServerToml(name: string, table: Record<string, unknown>): string {
  return stringify({ mcp_servers: { [name]: table } }).trimEnd() + "\n";
}

/**
 * Replace/insert/remove `[mcp_servers.<name>]` tables. Existing servers are rewritten in place,
 * new ones appended. Throws if the result does not parse back to exactly what was requested
 * (e.g. the file defines servers with inline tables we can't edit safely).
 */
export function editMcpTables(text: string, upsert: Record<string, Record<string, unknown>>, remove: string[]): string {
  const lines = text.split("\n");
  const touched = new Set([...Object.keys(upsert), ...remove]);
  const bs = blocks(lines);
  const firstPos = new Map<string, number>();
  const drop = new Set<number>();
  for (const b of bs) {
    const name = b.path && b.path[0] === "mcp_servers" && b.path.length >= 2 ? b.path[1]! : null;
    if (name == null || !touched.has(name)) continue;
    if (!firstPos.has(name)) firstPos.set(name, b.start);
    for (let i = b.start; i < b.end; i++) drop.add(i);
  }

  const out: string[] = [];
  const insertedAt = new Map<number, string>();
  for (const [name, pos] of firstPos) if (upsert[name]) insertedAt.set(pos, name);
  for (let i = 0; i < lines.length; i++) {
    const name = insertedAt.get(i);
    if (name) out.push(...renderServerToml(name, upsert[name]!).split("\n"));
    if (!drop.has(i)) out.push(lines[i]!);
  }

  let result = out.join("\n");
  const appended = Object.keys(upsert).filter((n) => !firstPos.has(n));
  if (appended.length) {
    result = result.replace(/\s*$/, "") + (result.trim() ? "\n\n" : "");
    result += appended.map((n) => renderServerToml(n, upsert[n]!)).join("\n");
  }
  if (text.endsWith("\n") && !result.endsWith("\n")) result += "\n";

  // Verify: every requested change landed, nothing else in mcp_servers changed.
  const before = ((parse(text || "") as any).mcp_servers ?? {}) as Record<string, unknown>;
  const after = ((parse(result) as any).mcp_servers ?? {}) as Record<string, unknown>;
  for (const [n, t] of Object.entries(upsert)) {
    if (stableStringify(after[n]) !== stableStringify(t)) throw new Error(`codex config: could not safely update [mcp_servers.${n}]`);
  }
  for (const n of remove) {
    if (!upsert[n] && n in after) throw new Error(`codex config: could not safely remove [mcp_servers.${n}] (inline table?)`);
  }
  for (const n of Object.keys(before)) {
    if (!touched.has(n) && stableStringify(before[n]) !== stableStringify(after[n])) {
      throw new Error(`codex config: edit would have changed unrelated server ${n}`);
    }
  }
  return result;
}
