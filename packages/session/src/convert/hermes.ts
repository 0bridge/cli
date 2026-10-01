import type { ParseResult, ParseState } from "../types";
import { ASKS, answerText, args, json, outputText } from "../text";
import { begin, note, noteStart } from "./base";

/** One row of Hermes Agent's `messages` table (~/.hermes/state.db), as core reads it. */
export interface HermesMessage {
  id: number;
  role: string;
  content?: string | null;
  /** JSON: OpenAI-style [{id, function: {name, arguments}}]. */
  tool_calls?: string | null;
  tool_call_id?: string | null;
  tool_name?: string | null;
  /** Seconds or milliseconds since the epoch. */
  timestamp?: number | string | null;
}

const time = (t: unknown) => {
  const n = typeof t === "string" ? Number(t) : typeof t === "number" ? t : 0;
  return !Number.isFinite(n) || n <= 0 ? 0 : n < 1e12 ? Math.round(n * 1000) : n;
};

/**
 * Hermes Agent (Nous Research) keeps sessions in SQLite with OpenAI-style messages. Unverified: no
 * Hermes install was available when this was written, so the reader is defensive and core skips
 * the source when the tables don't look like this. Rows are converted in id order; `prev` continues.
 */
export function fromHermesMessages(rows: HermesMessage[], prev?: ParseState, model?: string): ParseResult {
  const r = begin(prev);
  note(r, "model", model);
  rows.forEach((m, k) => {
    const at = time(m.timestamp);
    noteStart(r, at);
    const raw = { line: r.line(k) };
    const id = `m${m.id}`;
    const text = typeof m.content === "string" ? m.content : "";
    if (m.role === "user") r.push({ id, ts: at, raw, role: "user", parts: [{ type: "text", text }] });
    else if (m.role === "system") r.push({ id, ts: at, raw, role: "system", parts: [{ type: "text", text }], injected: true });
    else if (m.role === "assistant") {
      if (text) r.push({ id, ts: at, raw, role: "assistant", parts: [{ type: "text", text }], ...(model ? { model } : {}) });
      const calls: any[] = Array.isArray(json(m.tool_calls ?? "")) ? json(m.tool_calls ?? "") : [];
      calls.forEach((c, j) => {
        const callId = String(c?.id ?? "");
        const name = String(c?.function?.name ?? c?.name ?? "");
        const ask = ASKS.test(name);
        if (ask && callId) r.asks.add(callId);
        r.push({ id: `${id}:${j}`, ts: at, raw, role: "assistant", parts: [{ type: "tool_call", callId, name, input: args(c?.function?.arguments ?? c?.arguments) }], ...(ask ? { ask: "question" as const } : {}) });
      });
    } else if (m.role === "tool") {
      const callId = String(m.tool_call_id ?? "");
      const ask = r.asks.delete(callId);
      r.push({ id, ts: at, raw, role: ask ? "user" : "tool", parts: [{ type: "tool_result", callId, output: ask ? answerText(text) : outputText(text) }], ...(ask ? { ask: "answer" as const } : {}) });
    }
  });
  return r.done(rows.length);
}
