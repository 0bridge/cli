import type { Converter } from "../types";
import { ASKS, answerText, args, json, ms, outputText } from "../text";
import { tokens } from "../usage";
import { begin, note, noteStart, type Run } from "./base";

/**
 * A model message's `tokens` ({input, output, cached, thoughts, tool, total}), when the CLI wrote
 * them: cached is part of input (here its own field), tool-use prompt tokens are input, and
 * thoughts are billed as output (reasoning, inside output here).
 */
function countUsage(r: Run, t: any, at: number): void {
  if (!t || typeof t !== "object") return;
  const input = tokens(t.input) + tokens(t.tool);
  const cached = Math.min(tokens(t.cached), input);
  const thoughts = tokens(t.thoughts);
  r.tokens(r.state.model, at, { input: input - cached, output: tokens(t.output) + thoughts, cacheRead: cached, cacheWrite: 0, reasoning: thoughts });
}

/** A Gemini part list (or a string) as text. */
function partsText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p: any) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : "")).join("");
  if (c && typeof c === "object" && typeof (c as any).text === "string") return (c as any).text;
  return "";
}

/** A tool call's result: functionResponse parts carry `response.output` (or `response.error`). */
function resultText(result: unknown): string {
  const parts: any[] = Array.isArray(result) ? result : result ? [result] : [];
  const out = parts.map((p) => {
    const r = p?.functionResponse?.response;
    return r ? (typeof r.output === "string" ? r.output : typeof r.error === "string" ? r.error : JSON.stringify(r)) : typeof p?.text === "string" ? p.text : "";
  });
  return out.join("\n");
}

/**
 * Gemini CLI: ~/.gemini/tmp/<project>/chats/session-<time>-<id>.json, one JSON document rewritten
 * as the chat grows ({sessionId, startTime, lastUpdated, messages: [{id, timestamp, type: "user" |
 * "gemini" | "info" | "error" | "warning", content, thoughts?, toolCalls?, model?}], summary?}).
 * The whole file is passed each time; the state remembers how many records were already
 * converted, so only new ones become events. A JSONL variant (a header line, then one record per
 * line) is read the same way.
 */
export const geminiCli: Converter = (lines, prev) => {
  const r = begin(prev);
  const whole = json(lines.join("\n"));
  let header: any = whole && typeof whole === "object" && !Array.isArray(whole) ? whole : null;
  let records: any[] = Array.isArray(header?.messages) ? header.messages : [];
  if (!header) {
    const rows = lines.map(json).filter((x) => x && typeof x === "object");
    header = rows.find((x) => !x.type && (x.sessionId || x.startTime)) ?? {};
    records = rows.filter((x) => typeof x.type === "string");
  }
  if (header.sessionId && !r.state.x!.session) r.state.x!.session = String(header.sessionId);
  noteStart(r, ms(header.startTime));
  if (typeof header.summary === "string") note(r, "title", header.summary);
  // For a whole document the "line" is the record: everything before line(0) was converted already.
  const done = r.line(0);
  records.slice(done).forEach((m, k) => {
    const at = ms(m.timestamp);
    noteStart(r, at);
    const raw = { line: r.line(k) };
    const id = typeof m.id === "string" ? m.id : undefined;
    if (m.type === "user") {
      r.push({ id, ts: at, raw, role: "user", parts: [{ type: "text", text: partsText(m.content) }] });
    } else if (m.type === "gemini" || m.type === "model" || m.type === "assistant") {
      if (typeof m.model === "string") note(r, "model", m.model);
      countUsage(r, m.tokens, at);
      const model = r.state.model ? { model: r.state.model } : {};
      if (Array.isArray(m.thoughts) && m.thoughts.length) r.push({ id: id && `${id}:thoughts`, ts: at, raw, role: "assistant", parts: [{ type: "thinking", text: "", redacted: true }], ...model });
      const text = partsText(m.content);
      if (text) r.push({ id, ts: at, raw, role: "assistant", parts: [{ type: "text", text }], ...model });
      for (const t of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
        const callId = String(t?.id ?? "");
        const ask = ASKS.test(t?.name ?? "");
        r.push({ ts: ms(t?.timestamp) || at, raw, role: "assistant", parts: [{ type: "tool_call", callId, name: String(t?.name ?? ""), input: args(t?.args) }], ...(ask ? { ask: "question" as const } : {}) });
        if (t?.result !== undefined || t?.resultDisplay !== undefined) {
          const out = resultText(t.result) || (typeof t.resultDisplay === "string" ? t.resultDisplay : "");
          r.push({
            ts: ms(t?.timestamp) || at,
            raw,
            role: ask ? "user" : "tool",
            parts: [{ type: "tool_result", callId, output: ask ? answerText(out) : outputText(out), ...(t.status === "error" ? { isError: true } : {}) }],
            ...(ask ? { ask: "answer" as const } : {}),
          });
        }
      }
    } else if (m.type === "info" || m.type === "error" || m.type === "warning") {
      r.push({ id, ts: at, raw, role: "system", parts: [{ type: "text", text: partsText(m.content) }], injected: true });
    }
  });
  return r.done(Math.max(0, records.length - done));
};
