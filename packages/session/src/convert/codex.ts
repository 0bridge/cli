import type { Converter, Event } from "../types";
import { ASKS, answerText, args, injected, json, ms, outputText, unwrapOpenClaw } from "../text";
import { tokens } from "../usage";
import { begin, note, noteStart, type Run } from "./base";

/** Codex's running totals for the session: [input (cached included), cached input, output (reasoning included), reasoning]. */
type CodexTotal = [number, number, number, number];

/**
 * Token usage from `token_count` events, which carry the session's running total: this event's
 * tokens are the difference from the last total seen (kept in state.x.codexTotal). A total that
 * went down (a resumed thread counting from zero again) is a new baseline, counted whole.
 * Cached input is part of Codex's input count; here it's its own field.
 */
function countUsage(r: Run, t: any, at: number): void {
  if (!t || typeof t !== "object") return;
  const now: CodexTotal = [tokens(t.input_tokens), tokens(t.cached_input_tokens), tokens(t.output_tokens), tokens(t.reasoning_output_tokens)];
  const prior = r.state.x!.codexTotal;
  const before: CodexTotal = Array.isArray(prior) && prior.length === 4 ? (prior as CodexTotal) : [0, 0, 0, 0];
  const reset = now.some((n, i) => n < before[i]!);
  const [input, cached, output, reasoning] = now.map((n, i) => (reset ? n : n - before[i]!)) as CodexTotal;
  r.state.x!.codexTotal = now;
  r.tokens(r.state.model, at, { input: Math.max(0, input - cached), output, cacheRead: Math.min(cached, input), cacheWrite: 0, reasoning: Math.min(reasoning, output) });
}

/** Which product wrote a rollout, from session_meta's originator. */
export function codexTool(originator: unknown): string {
  const o = String(originator ?? "");
  if (/openclaw/i.test(o)) return "openclaw";
  if (/desktop/i.test(o)) return "codex-app";
  return "codex";
}

/**
 * Codex CLI and the Codex app: ~/.codex/sessions/YYYY/MM/DD/rollout-….jsonl. The same rollout
 * format is written by anything embedding Codex (OpenClaw keeps one Codex home per agent), so
 * `tool` forces the label for such a source.
 */
export const codexLike =
  (tool?: string): Converter =>
  (lines, prev) => {
    const r = begin(prev);
    if (tool) note(r, "tool", tool);
    lines.forEach((line, i) => {
      const d = json(line);
      if (!d || typeof d !== "object") return;
      const p = d.payload ?? {};
      const at = ms(d.timestamp);
      const raw = { line: r.line(i) };
      if (d.type === "session_meta") {
        note(r, "cwd", p.cwd);
        noteStart(r, ms(p.timestamp) || at);
        note(r, "tool", tool ?? codexTool(p.originator));
        note(r, "branch", p.git?.branch);
        if (p.model) note(r, "model", p.model);
        const session = p.session_id ?? p.id;
        if (session && !r.state.x!.session) r.state.x!.session = String(session);
        return;
      }
      if (d.type === "turn_context") {
        note(r, "cwd", p.cwd);
        note(r, "model", p.model);
        return;
      }
      if (d.type === "event_msg" && p.type === "token_count") return countUsage(r, p.info?.total_token_usage, at);
      if (d.type !== "response_item") return;
      const model = r.state.model ? { model: r.state.model } : {};
      const base: Pick<Event, "ts" | "raw"> & { id?: string } = { ts: at, raw, ...(typeof p.id === "string" ? { id: p.id } : {}) };
      if (p.type === "message") {
        const text = (Array.isArray(p.content) ? p.content : [])
          .filter((c: any) => (c.type === "input_text" || c.type === "output_text") && typeof c.text === "string")
          .map((c: any) => c.text)
          .join("\n")
          .trim();
        // OpenClaw's Codex turns: keep the person's message, not the context wrapped around it.
        const said = p.role === "user" ? unwrapOpenClaw(text) : text;
        if (p.role === "user" || p.role === "assistant")
          r.push({ ...base, role: p.role, parts: [{ type: "text", text: said || text }], ...(p.role === "assistant" ? model : {}), ...(!said || injected(said) ? { injected: true } : {}) });
        else if (p.role === "developer" || p.role === "system") r.push({ ...base, role: "system", parts: [{ type: "text", text }], injected: true });
      } else if (p.type === "reasoning") {
        r.push({ ...base, role: "assistant", parts: [{ type: "thinking", text: "", redacted: true }], ...model });
      } else if (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") {
        const ask = ASKS.test(p.name ?? "");
        const callId = String(p.call_id ?? "");
        if (ask && callId) r.asks.add(callId);
        r.push({ ...base, role: "assistant", parts: [{ type: "tool_call", callId, name: String(p.name ?? p.type), input: args(p.arguments ?? p.input ?? p.action) }], ...(ask ? { ask: "question" as const } : {}) });
      } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output" || p.type === "local_shell_call_output") {
        const callId = String(p.call_id ?? "");
        const ask = r.asks.delete(callId);
        r.push({ ...base, role: ask ? "user" : "tool", parts: [{ type: "tool_result", callId, output: ask ? answerText(p.output) : outputText(p.output) }], ...(ask ? { ask: "answer" as const } : {}) });
      }
    });
    return r.done(lines.length);
  };

export const codex: Converter = codexLike();
export const openclaw: Converter = codexLike("openclaw");
