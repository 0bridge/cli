import type { Converter, CursorBubble, ParseResult, ParseState } from "../types";
import { ASKS, answerText, args, injected, json, ms, outputText } from "../text";
import { begin, noteStart } from "./base";

/** "<timestamp>Saturday, Sep 26, 2026, 11:43 AM (UTC)</timestamp>" in a Cursor CLI user turn. */
function stamp(text: string): number {
  const t = /<timestamp>([^<]+)<\/timestamp>/.exec(text)?.[1];
  if (!t) return 0;
  const s = t.replace(/^[A-Za-z]+,\s*/, "").trim();
  // "(UTC)" and "(GMT+9)" parse; a zone name like "(Asia/Seoul)" doesn't, so that falls back to local time.
  return Date.parse(s.replace(/\(([^)]+)\)/, "$1")) || Date.parse(s.replace(/\s*\([^)]*\)/, "")) || 0;
}

function partText(c: unknown): string[] {
  if (typeof c === "string") return [c];
  return (Array.isArray(c) ? c : []).filter((p: any) => p?.type === "text" && typeof p.text === "string").map((p: any) => p.text);
}

/** An AI SDK tool output ({type: "text" | "json" | "error-text", value}) or a plain result as text. */
function toolOutput(p: any): { output: unknown; isError: boolean } {
  const o = p?.output ?? p?.result;
  if (o && typeof o === "object" && "value" in o) return { output: o.value, isError: /error/.test(String(o.type ?? "")) };
  return { output: o, isError: !!p?.isError };
}

/**
 * Cursor CLI (cursor-agent): each chat is a small SQLite store (~/.cursor/chats/<hash>/<id>/store.db,
 * or ~/.cursor/acp-sessions/<id>/store.db when run over ACP) of content-addressed blobs. Core
 * reads the store and passes the messages in order, one JSON message per line, in the AI SDK
 * shape ({role: "system" | "user" | "assistant" | "tool", content}). What the person typed is in
 * <user_query>; other user text is context the CLI added. Messages carry no time, so each takes
 * the last <timestamp> seen (0 before the first; core fills that in).
 */
export const cursorAgent: Converter = (lines, prev) => {
  const r = begin(prev);
  let last = typeof r.state.x!.ts === "number" ? (r.state.x!.ts as number) : 0;
  lines.forEach((line, i) => {
    const m = json(line);
    if (!m || typeof m !== "object" || typeof m.role !== "string") return;
    const raw = { line: r.line(i) };
    const id = typeof m.id === "string" ? m.id : typeof m.providerOptions?.cursor?.requestId === "string" ? m.providerOptions.cursor.requestId : undefined;
    if (m.role === "system") {
      for (const text of partText(m.content)) r.push({ id, ts: last, raw, role: "system", parts: [{ type: "text", text }], injected: true });
    } else if (m.role === "user") {
      for (const text of partText(m.content)) {
        last = stamp(text) || last;
        noteStart(r, last);
        const q = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(text)?.[1];
        if (q !== undefined) r.push({ id, ts: last, raw, role: "user", parts: [{ type: "text", text: q }] });
        else r.push({ id, ts: last, raw, role: "user", parts: [{ type: "text", text }], ...(injected(text) || /^\s*<[a-z_]+>/.test(text) ? { injected: true } : {}) });
      }
    } else if (m.role === "assistant") {
      const parts: any[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content : [];
      parts.forEach((p, k) => {
        const pid = id && (k ? `${id}:${k}` : id);
        if (p?.type === "text" && typeof p.text === "string") r.push({ id: pid, ts: last, raw, role: "assistant", parts: [{ type: "text", text: p.text }] });
        else if (p?.type === "reasoning") r.push({ id: pid, ts: last, raw, role: "assistant", parts: [{ type: "thinking", text: "", redacted: true }] });
        else if (p?.type === "tool-call") {
          const callId = String(p.toolCallId ?? "");
          const ask = ASKS.test(p.toolName ?? "");
          if (ask && callId) r.asks.add(callId);
          r.push({ id: pid, ts: last, raw, role: "assistant", parts: [{ type: "tool_call", callId, name: String(p.toolName ?? ""), input: args(p.input ?? p.args) }], ...(ask ? { ask: "question" as const } : {}) });
        }
      });
    } else if (m.role === "tool") {
      for (const p of Array.isArray(m.content) ? m.content : []) {
        if (p?.type !== "tool-result") continue;
        const callId = String(p.toolCallId ?? "");
        const ask = r.asks.delete(callId);
        const { output, isError } = toolOutput(p);
        r.push({
          ts: last,
          raw,
          role: ask ? "user" : "tool",
          parts: [{ type: "tool_result", callId, output: ask ? answerText(output) : outputText(output), ...(isError ? { isError: true } : {}) }],
          ...(ask ? { ask: "answer" as const } : {}),
        });
      }
    }
  });
  if (last) r.state.x!.ts = last;
  return r.done(lines.length);
};

/**
 * The message blob ids, in order, from a Cursor CLI store's root blob (meta.latestRootBlobId): a
 * protobuf whose field 1 repeats the 32-byte SHA-256 of each message blob. Lowercase hex, as the
 * blobs table keys them.
 */
export function cursorAgentMessageIds(root: Uint8Array): string[] {
  const ids: string[] = [];
  let i = 0;
  const varint = () => {
    let x = 0;
    let s = 0;
    for (;;) {
      if (i >= root.length) throw new Error("truncated");
      const c = root[i++]!;
      x += (c & 0x7f) * 2 ** s;
      s += 7;
      if (!(c & 0x80)) return x;
    }
  };
  try {
    while (i < root.length) {
      const key = varint();
      const field = Math.floor(key / 8);
      const wire = key & 7;
      if (wire === 0) varint();
      else if (wire === 1) i += 8;
      else if (wire === 5) i += 4;
      else if (wire === 2) {
        const n = varint();
        if (i + n > root.length) break;
        if (field === 1 && n === 32) ids.push([...root.subarray(i, i + n)].map((b) => b.toString(16).padStart(2, "0")).join(""));
        i += n;
      } else break;
    }
  } catch {}
  return ids;
}

/**
 * Cursor's app database rows (read by core, which has SQLite) to events: 1 is the person, 2 the
 * assistant, other bubble types (tool runs, status) are left out. `prev` continues numbering; rows
 * before its record count were converted already.
 */
export function fromCursorBubbles(rows: CursorBubble[], prev?: ParseState): ParseResult {
  const r = begin(prev);
  const done = r.line(0);
  rows.slice(done).forEach((b, k) => {
    if (b.type !== 1 && b.type !== 2) return;
    const at = ms(b.createdAt);
    noteStart(r, at);
    r.push({ id: b.bubbleId, ts: at, raw: { line: r.line(k) }, role: b.type === 1 ? "user" : "assistant", parts: [{ type: "text", text: b.text ?? "" }] });
  });
  return r.done(Math.max(0, rows.length - done));
}
