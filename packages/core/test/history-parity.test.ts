import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { converters, toConversation, type ConverterId } from "@0bridge/session";

/**
 * toConversation parity: the session converters give the same conversation as the parsers this
 * module had before @0bridge/session (kept below, verbatim, as the oracle), so moving to them
 * neither drops nor duplicates a message on the server (seq = base + index stays the same).
 */

const MAX_MESSAGE = 16 * 1024;
type HistoryMessage = { seq: number; role: "user" | "assistant" | "tool"; at: number; text: string };

// ── The parsers as they were (packages/core/src/history.ts before the session package) ──

const clip = (s: string, n = MAX_MESSAGE) => (s.length > n ? `${s.slice(0, n)}… [${s.length - n} more characters]` : s);
const ms = (t: unknown) => (typeof t === "string" || typeof t === "number" ? new Date(typeof t === "string" && /^\d+$/.test(t) ? Number(t) : t).getTime() || 0 : 0);
const json = (line: string): any => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

/** Text the tool injected rather than the person typed (environment, instructions, command wrappers). */
const injected = (t: string) =>
  /^\s*<(?:[a-z_-]+-)?(?:environment_context|user_instructions|permissions instructions|app-context|recommended_plugins|command-|local-command-|system-reminder|INSTRUCTIONS|turn_aborted|user_info|rules|topic)/i.test(t) ||
  /^\s*<(?:skill|subagent_notification|task-notification)>/i.test(t) ||
  /^(?:Caveat: The messages below|The following is the Codex agent history|# AGENTS\.md instructions for|This session is being continued from a previous conversation)/.test(t);

/** Tools an agent uses to ask the person something; their question and the answer are conversation. */
const ASKS = /^(?:AskUserQuestion|ask_user_question|ask_?user|request_user_input|ask_question)$/i;

/** "Which account?\n- A\n- B" from a question tool's input. */
function questionText(input: any): string {
  const qs: any[] = Array.isArray(input?.questions) ? input.questions : input?.question ? [input] : [];
  if (!qs.length) return typeof input === "string" ? input : JSON.stringify(input ?? {});
  return qs
    .map((q) => [String(q.question ?? q.prompt ?? ""), ...(Array.isArray(q.options) ? q.options.map((o: any) => `- ${o?.label ?? o}`) : [])].join("\n"))
    .join("\n\n");
}

/** The person's answers from a question tool's result. */
function answerText(result: unknown, structured?: any): string {
  const answers = structured?.answers;
  if (answers && typeof answers === "object") return Object.values(answers).map(String).join("\n");
  const text = typeof result === "string" ? result : Array.isArray(result) ? result.map((b: any) => b?.text ?? "").join("\n") : JSON.stringify(result ?? "");
  const pairs = [...text.matchAll(/"[^"]*"="([^"]*)"/g)].map((m) => m[1]);
  return pairs.length ? pairs.join("\n") : text.replace(/\s*Read the answers carefully[\s\S]*$/, "");
}

type Parsed = { messages: Omit<HistoryMessage, "seq">[]; cwd?: string; title?: string; startedAt?: number; session?: string; tool?: string };

/** Claude Code (and the Claude app's Code tab): ~/.claude/projects/<project>/<session>.jsonl. */
function parseClaude(lines: string[]): Parsed {
  const out: Parsed = { messages: [] };
  const asks = new Set<string>();
  for (const line of lines) {
    const d = json(line);
    if (!d) continue;
    if (d.type === "ai-title" && d.aiTitle) out.title = String(d.aiTitle);
    if (d.type === "summary" && d.summary && !out.title) out.title = String(d.summary);
    if (d.type !== "user" && d.type !== "assistant") continue;
    // Subagents' own turns and injected meta messages are noise when searching.
    if (d.isSidechain || d.isMeta) continue;
    if (d.cwd) out.cwd = d.cwd;
    if (d.sessionId) out.session ??= d.sessionId;
    const at = ms(d.timestamp);
    if (at) out.startedAt ??= at;
    const content = d.message?.content;
    const blocks: any[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
    for (const b of blocks) {
      if (b.type === "text" && typeof b.text === "string" && b.text.trim() && !injected(b.text)) out.messages.push({ role: d.type, at, text: clip(b.text.trim()) });
      else if (b.type === "tool_use" && ASKS.test(b.name ?? "")) {
        asks.add(b.id);
        out.messages.push({ role: "assistant", at, text: clip(questionText(b.input)) });
      } else if (b.type === "tool_result" && asks.has(b.tool_use_id)) out.messages.push({ role: "user", at, text: clip(answerText(b.content, d.toolUseResult)) });
    }
  }
  return out;
}

/** Codex CLI and the Codex app: ~/.codex/sessions/YYYY/MM/DD/rollout-….jsonl. */
function parseCodex(lines: string[]): Parsed {
  const out: Parsed = { messages: [] };
  const asks = new Set<string>();
  for (const line of lines) {
    const d = json(line);
    if (!d) continue;
    const p = d.payload ?? {};
    const at = ms(d.timestamp);
    if (d.type === "session_meta") {
      out.session ??= p.session_id ?? p.id;
      if (p.cwd) out.cwd = p.cwd;
      out.startedAt ??= ms(p.timestamp) || at;
      out.tool = /desktop/i.test(p.originator ?? "") ? "codex-app" : "codex";
      continue;
    }
    if (d.type === "turn_context" && p.cwd) out.cwd = p.cwd;
    if (d.type !== "response_item") continue;
    if (p.type === "message" && (p.role === "user" || p.role === "assistant")) {
      const text = (Array.isArray(p.content) ? p.content : [])
        .filter((c: any) => (c.type === "input_text" || c.type === "output_text") && typeof c.text === "string")
        .map((c: any) => c.text)
        .join("\n")
        .trim();
      if (text && !injected(text)) out.messages.push({ role: p.role, at, text: clip(text) });
    } else if ((p.type === "function_call" || p.type === "custom_tool_call") && ASKS.test(p.name ?? "")) {
      asks.add(p.call_id);
      out.messages.push({ role: "assistant", at, text: clip(questionText(json(p.arguments ?? p.input ?? "") ?? p.arguments ?? p.input)) });
    } else if ((p.type === "function_call_output" || p.type === "custom_tool_call_output") && asks.has(p.call_id)) {
      out.messages.push({ role: "user", at, text: clip(answerText(p.output)) });
    }
  }
  return out;
}

/** Grok: ~/.grok/sessions/<folder>/<session>/chat_history.jsonl. What the person typed is in <user_query>. */
function parseGrok(lines: string[]): Parsed {
  const out: Parsed = { messages: [] };
  const asks = new Set<string>();
  for (const line of lines) {
    const d = json(line);
    if (!d) continue;
    const at = ms(d.timestamp ?? d.ts ?? d.created_at);
    if (d.type === "user") {
      const blocks: any[] = typeof d.content === "string" ? [{ text: d.content }] : Array.isArray(d.content) ? d.content : [];
      for (const b of blocks) {
        const q = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(String(b?.text ?? ""))?.[1];
        if (q?.trim()) out.messages.push({ role: "user", at, text: clip(q.trim()) });
      }
    } else if (d.type === "assistant") {
      if (typeof d.content === "string" && d.content.trim()) out.messages.push({ role: "assistant", at, text: clip(d.content.trim()) });
      for (const t of Array.isArray(d.tool_calls) ? d.tool_calls : [])
        if (ASKS.test(t?.name ?? "")) {
          asks.add(t.id);
          out.messages.push({ role: "assistant", at, text: clip(questionText(json(t.arguments ?? "") ?? t.arguments)) });
        }
    } else if (d.type === "tool_result" && asks.has(d.tool_call_id)) out.messages.push({ role: "user", at, text: clip(answerText(d.content)) });
  }
  return out;
}

// ── Fixtures: the session package's, and the end-to-end test's (apps/gateway/test/history.ts) ──

const FIXTURES = join(import.meta.dir, "../../session/test/fixtures");
const read = (id: string) =>
  readdirSync(join(FIXTURES, id))
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ name: `${id}/${f}`, lines: readFileSync(join(FIXTURES, id, f), "utf8").replace(/\n$/, "").split("\n") }));

const LEAK = "sk-ant-api03-" + "Z".repeat(40);
const cl = (o: object) => JSON.stringify({ sessionId: "11111111-2222-3333-4444-555555555555", cwd: "/work/acme/web", timestamp: "2026-09-20T10:00:00Z", ...o });
const e2eClaude = [
  cl({ type: "user", message: { role: "user", content: "결제 웹훅이 두 번 호출되는 버그 고쳐줘. 키는 " + LEAK } }),
  cl({ type: "user", isMeta: true, message: { role: "user", content: "<local-command-stdout>noise</local-command-stdout>" } }),
  cl({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Stripe webhook idempotency key로 중복을 막았어요." }, { type: "tool_use", name: "Edit", input: { file_path: "src/webhook.ts" } }] } }),
  cl({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }),
  cl({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: { questions: [{ question: "Deploy the fix now?", options: [{ label: "Yes" }, { label: "Later" }] }] } }] } }),
  cl({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "q1", content: 'The user answered: "Deploy the fix now?"="Yes, deploy". Read the answers carefully.' }] } }),
  cl({ type: "ai-title", aiTitle: "Fix duplicate payment webhook" }),
];
const cx = (o: object) => JSON.stringify({ timestamp: "2026-09-21T09:00:00Z", ...o });
const e2eCodex = [
  cx({ type: "session_meta", payload: { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", cwd: "/work/acme/api", timestamp: "2026-09-21T09:00:00Z" } }),
  cx({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }] } }),
  cx({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Add rate limiting to the login endpoint" }] } }),
  cx({ type: "response_item", payload: { type: "function_call", name: "shell", arguments: '{"cmd":"rg login"}' } }),
  cx({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Added a sliding-window limiter keyed by IP." }] } }),
];

const cases: { converter: ConverterId; old: (lines: string[]) => Parsed; fixtures: { name: string; lines: string[] }[] }[] = [
  { converter: "claude-code", old: parseClaude, fixtures: [...read("claude-code"), { name: "e2e/claude", lines: e2eClaude }] },
  { converter: "codex", old: parseCodex, fixtures: [...read("codex"), { name: "e2e/codex", lines: e2eCodex }] },
  { converter: "openclaw", old: parseCodex, fixtures: read("openclaw") },
  { converter: "grok", old: parseGrok, fixtures: read("grok") },
];

describe("toConversation matches the parsers it replaced", () => {
  for (const c of cases)
    for (const f of c.fixtures)
      test(`${c.converter} on ${f.name}`, () => {
        const before = c.old(f.lines);
        const now = converters[c.converter](f.lines);
        expect(toConversation(now.events)).toEqual(before.messages);
        expect(now.meta.title).toBe(before.title);
        expect(now.meta.cwd).toBe(before.cwd);
        // Grok's start time is new (the old parser had none).
        if (c.converter !== "grok") expect(now.meta.startedAt).toBe(before.startedAt);
        // The one deliberate change: OpenClaw's rollouts are labeled openclaw, not codex.
        if (c.converter === "codex") expect(now.meta.tool).toBe(before.tool);
      });
});
