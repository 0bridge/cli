import type { Mode } from "../policy.ts";

/**
 * One interface over each coding agent's own headless protocol (K7): Claude Code's stream-json,
 * Codex's app-server, Gemini's ACP, and herdr or tmux for sessions open in a terminal.
 */

/** What an agent did, as the daemon relays it (it adds the task, seq and time). */
export type AgentEvent =
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: string; summary: string }
  /** A permission prompt: answered with Run.approve(request, …). */
  | { kind: "permission"; request: string; tool: string; summary: string }
  /** The agent's own id for the conversation (Claude session, Codex thread), once known. */
  | { kind: "native"; native: string }
  /** A turn ended; the run is idle until the next send. */
  | { kind: "turn"; ok: boolean; summary?: string; error?: string }
  | { kind: "error"; error: string };

export type Sink = (e: AgentEvent) => void;

export interface StartOptions {
  task: string;
  cwd: string;
  prompt: string;
  mode: Mode;
  env?: Record<string, string>;
}

export interface Run {
  native: string;
  send(text: string): Promise<void>;
  approve(request: string, d: "allow" | "deny", note?: string): Promise<void>;
  stop(): Promise<void>;
  /** Settles when the run has nothing left to do (its last turn ended, or it was stopped). */
  done: Promise<{ ok: boolean; error?: string }>;
}

export interface AgentAdapter {
  id: "claude" | "codex" | "gemini" | "herdr" | "tmux";
  available(): Promise<{ ok: boolean; version?: string }>;
  start(o: StartOptions, sink: Sink): Promise<Run>;
  /** Follow-ups to a session not started by this run (a finished task, or one from a terminal). */
  attach?(native: { id: string; cwd: string }, sink: Sink, o?: { mode: Mode; env?: Record<string, string>; task?: string }): Promise<Run>;
  /** Sessions open right now (terminal panes, interactive processes). */
  running?(): Promise<{ native: string; cwd: string; title?: string; tool?: string; pid?: number }[]>;
}

/** One line about a tool call, for a phone screen: the command, the file, or the first input value. */
export function summarize(tool: string, input: unknown): string {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const pick = i.command ?? i.cmd ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.query ?? i.description ?? Object.values(i).find((v) => typeof v === "string");
  const s = Array.isArray(pick) ? pick.join(" ") : typeof pick === "string" ? pick : tool;
  return s.replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Settle-once promise with its resolver, for runs whose end comes from an event. */
export function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; settled: () => boolean } {
  let resolve!: (v: T) => void;
  let done = false;
  const promise = new Promise<T>((r) => (resolve = r));
  return {
    promise,
    resolve: (v) => {
      if (done) return;
      done = true;
      resolve(v);
    },
    settled: () => done,
  };
}
