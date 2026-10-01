import type { Converter } from "../types";
import { ASKS, answerText, injected, json, ms, outputText } from "../text";
import { noTokens, tokens } from "../usage";
import { begin, note, noteStart, type Run } from "./base";

/** How many message ids the usage dedupe remembers across calls (a message's lines are adjacent). */
const USAGE_IDS = 64;

/**
 * Token usage, counted once per API message: Claude Code writes an assistant message as one line
 * per content block, and every line repeats the message's `usage`. Input and cache counts are
 * taken from the first line; output from the largest a line reports (a line written mid-stream
 * can carry less). `seen` is [message id, output counted] for the last USAGE_IDS messages.
 */
function countUsage(r: Run, d: any, seen: [string, number][]): void {
  const m = d.message;
  const u = m?.usage;
  if (d.type !== "assistant" || !u || typeof u !== "object" || typeof m.id !== "string") return;
  // <synthetic> messages (errors, interruptions) are Claude Code's own, not a model's.
  if (typeof m.model !== "string" || m.model.startsWith("<")) return;
  const at = ms(d.timestamp);
  const out = tokens(u.output_tokens);
  const i = seen.findIndex(([id]) => id === m.id);
  if (i < 0) {
    r.tokens(m.model, at, { input: tokens(u.input_tokens), output: out, cacheRead: tokens(u.cache_read_input_tokens), cacheWrite: tokens(u.cache_creation_input_tokens), reasoning: 0 });
    seen.push([m.id, out]);
    if (seen.length > USAGE_IDS) seen.shift();
  } else if (out > seen[i]![1]) {
    r.tokens(m.model, at, { ...noTokens(), output: out - seen[i]![1] });
    seen[i] = [m.id, out];
  }
}

/**
 * Claude Code (and the Claude app's Code tab): ~/.claude/projects/<project>/<session>.jsonl, one
 * JSON object per line. Each content block becomes one event, so injected text next to what the
 * person typed stays separate. Subagents' own turns (sidechains) are their own transcripts and
 * are left out; meta lines are kept as injected.
 */
export const claudeCode: Converter = (lines, prev) => {
  const r = begin(prev);
  const prior = r.state.x!.usageIds;
  const seen: [string, number][] = Array.isArray(prior) ? prior.map((e) => [String(e[0]), Number(e[1]) || 0]) : [];
  lines.forEach((line, i) => {
    const d = json(line);
    if (!d || typeof d !== "object") return;
    if (d.type === "ai-title" && d.aiTitle) note(r, "title", String(d.aiTitle));
    if (d.type === "summary" && d.summary && !r.meta.title) note(r, "title", String(d.summary));
    if (d.type !== "user" && d.type !== "assistant") return;
    // A sidechain's tokens were spent too, even though its turns aren't this conversation's.
    countUsage(r, d, seen);
    if (d.isSidechain) return;
    const at = ms(d.timestamp);
    const meta = !!d.isMeta;
    if (!meta) {
      note(r, "cwd", d.cwd);
      noteStart(r, at);
    }
    note(r, "branch", d.gitBranch && d.gitBranch !== "HEAD" ? d.gitBranch : undefined);
    const model = typeof d.message?.model === "string" && !d.message.model.startsWith("<") ? d.message.model : undefined;
    note(r, "model", model);
    const content = d.message?.content;
    const blocks: any[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
    const raw = { line: r.line(i) };
    blocks.forEach((b, k) => {
      const id = d.uuid ? (k ? `${d.uuid}:${k}` : String(d.uuid)) : undefined;
      const base = { id, ts: at, raw, ...(model ? { model } : {}), ...(meta ? { injected: true } : {}) };
      if (b?.type === "text" && typeof b.text === "string") {
        r.push({ ...base, role: d.type, parts: [{ type: "text", text: b.text }], ...(injected(b.text) ? { injected: true } : {}) });
      } else if (b?.type === "thinking" || b?.type === "redacted_thinking") {
        r.push({ ...base, role: "assistant", parts: [{ type: "thinking", text: "", redacted: true }] });
      } else if (b?.type === "tool_use") {
        const ask = ASKS.test(b.name ?? "");
        if (ask && b.id) r.asks.add(String(b.id));
        r.push({ ...base, role: "assistant", parts: [{ type: "tool_call", callId: String(b.id ?? ""), name: String(b.name ?? ""), input: b.input }], ...(ask ? { ask: "question" as const } : {}) });
      } else if (b?.type === "tool_result") {
        const callId = String(b.tool_use_id ?? "");
        const ask = r.asks.delete(callId);
        r.push({
          ...base,
          role: ask ? "user" : "tool",
          parts: [{ type: "tool_result", callId, output: ask ? answerText(b.content, d.toolUseResult) : outputText(b.content), ...(b.is_error ? { isError: true } : {}) }],
          ...(ask ? { ask: "answer" as const } : {}),
        });
      } else if (b?.type === "image" || b?.type === "document") {
        r.push({ ...base, role: d.type, parts: [{ type: "file", mime: String(b.source?.media_type ?? (b.type === "image" ? "image/*" : "application/octet-stream")) }] });
      }
    });
  });
  if (seen.length) r.state.x!.usageIds = seen;
  return r.done(lines.length);
};
