import type { Converter, ConverterId, ConversationMessage, Event } from "../types";
import { clip, questionText } from "../text";
import { claudeCode } from "./claude";
import { codex, openclaw } from "./codex";
import { cursorAgent } from "./cursor";
import { geminiCli } from "./gemini";
import { grok } from "./grok";

/**
 * Pure converters from each vendor's log lines to 0b.session/1 events. Each takes the lines read
 * since the last call and the state that call returned, so a log read in pieces converts exactly
 * as it would read whole.
 */
export const converters: Record<ConverterId, Converter> = {
  "claude-code": claudeCode,
  codex,
  grok,
  "gemini-cli": geminiCli,
  "cursor-agent": cursorAgent,
  openclaw,
};

/**
 * Today's upload rule: user/assistant text and asked questions/answers only; injected context
 * dropped. Tool calls, their output, reasoning and files stay out; a message over 16 KB is clipped.
 */
export function toConversation(events: Event[]): ConversationMessage[] {
  const out: ConversationMessage[] = [];
  for (const e of events) {
    if (e.injected || (e.role !== "user" && e.role !== "assistant")) continue;
    for (const p of e.parts) {
      if (p.type === "text") {
        const text = p.text.trim();
        if (text) out.push({ role: e.role, at: e.ts, text: clip(text) });
      } else if (p.type === "tool_call" && e.ask === "question") out.push({ role: "assistant", at: e.ts, text: clip(questionText(p.input)) });
      else if (p.type === "tool_result" && e.ask === "answer") out.push({ role: "user", at: e.ts, text: clip(p.output) });
    }
  }
  return out;
}

export { codexTool } from "./codex";
export { cursorAgentMessageIds, fromCursorBubbles } from "./cursor";
export { fromHermesMessages, type HermesMessage } from "./hermes";
