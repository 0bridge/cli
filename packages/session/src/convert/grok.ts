import type { Converter } from "../types";
import { ASKS, answerText, args, json, ms, outputText } from "../text";
import { begin, note, noteStart } from "./base";

/**
 * Grok CLI: ~/.grok/sessions/<folder>/<session>/chat_history.jsonl. What the person typed is in
 * <user_query>; the rest of a user turn is context the CLI added.
 */
export const grok: Converter = (lines, prev) => {
  const r = begin(prev);
  lines.forEach((line, i) => {
    const d = json(line);
    if (!d || typeof d !== "object") return;
    const at = ms(d.timestamp ?? d.ts ?? d.created_at);
    noteStart(r, at);
    const raw = { line: r.line(i) };
    if (typeof d.model === "string") note(r, "model", d.model);
    if (d.type === "user") {
      const blocks: any[] = typeof d.content === "string" ? [{ text: d.content }] : Array.isArray(d.content) ? d.content : [];
      for (const b of blocks) {
        const text = String(b?.text ?? "");
        const q = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(text)?.[1];
        if (q !== undefined) r.push({ ts: at, raw, role: "user", parts: [{ type: "text", text: q }] });
        else if (text) r.push({ ts: at, raw, role: "user", parts: [{ type: "text", text }], injected: true });
      }
    } else if (d.type === "assistant") {
      if (typeof d.content === "string") r.push({ ts: at, raw, role: "assistant", parts: [{ type: "text", text: d.content }], ...(r.state.model ? { model: r.state.model } : {}) });
      for (const t of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
        const ask = ASKS.test(t?.name ?? "");
        const callId = String(t?.id ?? "");
        if (ask && callId) r.asks.add(callId);
        r.push({ ts: at, raw, role: "assistant", parts: [{ type: "tool_call", callId, name: String(t?.name ?? ""), input: args(t?.arguments) }], ...(ask ? { ask: "question" as const } : {}) });
      }
    } else if (d.type === "tool_result") {
      const callId = String(d.tool_call_id ?? "");
      const ask = r.asks.delete(callId);
      r.push({ ts: at, raw, role: ask ? "user" : "tool", parts: [{ type: "tool_result", callId, output: ask ? answerText(d.content) : outputText(d.content) }], ...(ask ? { ask: "answer" as const } : {}) });
    } else if (d.type === "system") {
      if (typeof d.content === "string") r.push({ ts: at, raw, role: "system", parts: [{ type: "text", text: d.content }], injected: true });
    }
  });
  return r.done(lines.length);
};
