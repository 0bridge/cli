/**
 * 0b.session/1: one shape for a session from any AI tool (a coding agent's transcript or a chat
 * app's conversation), so it can move between tools and be kept anywhere. Additive changes keep
 * the version; a breaking change is 0b.session/2.
 */

export const SCHEMA = "0b.session/1";

export type Vendor = "anthropic" | "openai" | "google" | "xai" | "cursor" | "meta" | "nous" | "openclaw" | "other";

export interface Session {
  schema: typeof SCHEMA;
  /** Canonical "<tool>:<native>". */
  id: string;
  source: { vendor: Vendor; product: string; tool: string; nativeId: string; host?: string; account?: string };
  title?: string;
  cwd?: string;
  repo?: { remote?: string; branch?: string; commit?: string };
  createdAt: number;
  updatedAt: number;
  model?: string;
  resume?: { kind: "native-cli" | "acp" | "none"; command?: string; nativeId?: string };
  parentId?: string;
  usage?: { inputTokens?: number; outputTokens?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number };
  /** Vendor passthrough. */
  x?: Record<string, unknown>;
}

export type Part =
  | { type: "text"; text: string; redacted?: boolean }
  /** Stored redacted by default. */
  | { type: "thinking"; text: string; redacted?: boolean }
  | { type: "tool_call"; callId: string; name: string; input: unknown }
  | { type: "tool_result"; callId: string; output: string; isError?: boolean }
  | { type: "file"; mime: string; uri?: string; sha256?: string };

export interface Event {
  id: string;
  seq: number;
  ts: number;
  role: "user" | "assistant" | "system" | "tool";
  parts: Part[];
  model?: string;
  /** Context the tool added on its own (environment, reminders), not something the person typed. */
  injected?: boolean;
  ask?: "question" | "answer";
  raw?: { line: number };
}

/** Pure, incremental, no fs: state carries what a later call needs (cwd, title, last seq). */
export interface ParseState {
  seq: number;
  cwd?: string;
  title?: string;
  branch?: string;
  startedAt?: number;
  tool?: string;
  model?: string;
  x?: Record<string, unknown>;
}

/** Token counts, never content. `reasoning` is part of `output` (not added to it). */
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

/** New tokens for one model in one hour (`hour` = floor(ts / 3_600_000)). */
export interface UsageDelta extends TokenCounts {
  model: string;
  hour: number;
}

export interface ParseResult {
  events: Event[];
  state: ParseState;
  meta: Partial<Pick<Session, "title" | "cwd" | "model">> & { branch?: string; tool?: string; startedAt?: number };
  /** This chunk's new tokens, summed per model-hour (converters that can read usage). */
  usage?: UsageDelta[];
}

export type Converter = (lines: string[], prev?: ParseState) => ParseResult;

export type ConverterId = "claude-code" | "codex" | "grok" | "gemini-cli" | "cursor-agent" | "openclaw";

/** One row of Cursor's app database: a message header joined with its bubble (core reads the SQLite). */
export interface CursorBubble {
  bubbleId: string;
  /** 1 = user, 2 = assistant. */
  type: number;
  text?: string;
  createdAt?: number | string;
}

/** A conversation message as uploaded today: text only. */
export interface ConversationMessage {
  role: "user" | "assistant" | "tool";
  at: number;
  text: string;
}
