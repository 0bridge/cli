import type { Mode } from "./policy.ts";
import type { HostAckFrame, HostCursorFrame, HostEventsFrame, HostOp, HostSupervisorInfo } from "@0bridge/core/host";

export type {
  HostAckFrame,
  HostChoice,
  HostLedgerReceipt,
  HostQuestionSource,
  HostSupervisorKind,
  HostAnswerReply,
  HostAnswerStatus,
  HostContextReply,
  HostCursorFrame,
  HostDeliveryState,
  HostEvent,
  HostEventsFrame,
  HostFollowupReply,
  HostLookupReply,
  HostOp,
  HostProvider,
  HostQuestionsReply,
  HostRequestReply,
  HostStatusReply,
  HostSupervisorInfo,
  HostTask,
  HostVia,
} from "@0bridge/core/host";
export { HOST_BATCH_MAX, HOST_CONTEXT_KEY, HOST_REQUEST_ID, HOST_RESET_ID, HOST_TEXT_MAX, isHostAck, newHostAck, parseChoices } from "@0bridge/core/host";

/**
 * The frames between a machine's daemon and the machine hub (spec 6.6): JSON text, version 1.
 * The hub sends requests (`req`), the daemon answers each with a `reply` (the hub waits 15 s) and
 * streams what its tasks do as `event`s. With a supervisor set up (docs/plans/dots-host.md), the
 * hello says so (`host`), the daemon streams host-task events as `host-events` and the hub acks
 * them (`host-ack`) and tells it where to resume (`host-cursor`).
 */

export type TaskState = "starting" | "running" | "waiting" | "done" | "failed" | "stopped";
export type EventKind = "status" | "text" | "tool" | "permission" | "done" | "error";
export type DaemonAgentId = "claude" | "codex" | "gemini" | "herdr" | "tmux";

export interface EventData {
  state?: TaskState;
  text?: string;
  tool?: string;
  summary?: string;
  request?: string;
  native?: string;
  ok?: boolean;
  error?: string;
}

export interface HelloFrame {
  t: "hello";
  v: 1;
  machine: { name: string; os: "darwin" | "linux" | "win32"; arch: string; version: string };
  agents: { id: DaemonAgentId; version?: string; ok: boolean }[];
  repos: { root: string; repo: string | null; agents: string[]; mode: Mode; worktree: boolean }[];
  profiles?: Record<string, string[]>;
  /** Only when agent control is on here and agent.json has a supervisor. */
  host?: HostSupervisorInfo;
}
export interface EventFrame {
  t: "event";
  task: string;
  seq: number;
  at: number;
  kind: EventKind;
  data: EventData;
}
export interface ReplyFrame {
  t: "reply";
  rid: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}
export type DaemonFrame = HelloFrame | { t: "ping" } | EventFrame | ReplyFrame | HostEventsFrame;

export type HubRequest =
  | { t: "req"; rid: string; op: "start"; task: string; agent: string; repo: string; prompt: string; mode?: string; worktree?: boolean; profile?: string }
  | { t: "req"; rid: string; op: "send"; task?: string; native?: { tool: string; id: string; cwd: string }; text: string }
  | { t: "req"; rid: string; op: "approve"; task: string; request: string; decision: "allow" | "deny"; note?: string }
  | { t: "req"; rid: string; op: "stop"; task: string }
  | { t: "req"; rid: string; op: "sessions" }
  | ({ t: "req"; rid: string } & HostOp);

/** Everything the hub sends a daemon. */
export type HubFrame = HubRequest | HostAckFrame | HostCursorFrame;

export interface RunningSession {
  tool: string;
  native: string;
  cwd: string;
  title?: string;
  via: "daemon" | "herdr" | "tmux" | "process";
}
