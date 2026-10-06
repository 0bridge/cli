/**
 * Host tasks on the user's dev machine (docs/plans/dots-host.md, section 4.1): the wire types
 * between the `0b agent` daemon (its supervisor adapter: OpenClaw over `host-task` and Herdr) and
 * the gateway's MachineHub, the hub's request ops and replies, and the payloads of the public MCP
 * events. Imported by the CLI and the gateway, so it stays free of Node APIs.
 *
 * Frozen after S0: a change is an additive optional field, agreed between the daemon's and the
 * hub's sides and noted in the plan. Old daemons and old gateways ignore frames they don't know.
 */

/**
 * What a machine's hello says about its supervisor: never paths or flags. `openclaw`: a request
 * becomes a host-task task at once and goes to an OpenClaw agent. `ledger` (docs/plans/dots-host.md,
 * "Ledger mode"): requests, follow-ups and answers are written into host-task's log the way the
 * host's own desk writes the user's words (dev_request, user_followup, user_decision), and the
 * team there gives a request its task id; `agent` is then "ledger".
 */
export interface HostSupervisorInfo {
  kind: HostSupervisorKind;
  agent: string;
  label: string | null;
}
export type HostSupervisorKind = "openclaw" | "ledger";

/** Public MCP event names (stable). */
export const HOST_EVENT_NAMES = ["host.task.question", "host.task.completed", "host.task.failed"] as const;
export type HostEventName = (typeof HOST_EVENT_NAMES)[number];
/** The user's webhooks' events, as one MCP event type. */
export const WEBHOOK_EVENT_NAME = "webhook.received";

/** A host-task task, trimmed (from `host-task show|list`). Times in ms. */
export interface HostTask {
  id: string;
  title: string;
  status: string;
  project: string | null;
  repo: string | null;
  worker: string | null;
  priority: string | null;
  agent: string | null;
  pane: string | null;
  pendingQuestion: number | null;
  evidence: string | null;
  result: string | null;
  pr: string | null;
  waiting: string | null;
  updatedAt: number;
  /** The worker's native session id (Claude Code/Codex UUID) host-task bound to the task, if any. Added for outside context (T-024). */
  nativeSession?: string | null;
}

/** One host-task event as the daemon relays it: text masked (vault values, redact()) and capped at HOST_TEXT_MAX. */
export interface HostEvent {
  id: number;
  at: number;
  kind: string;
  task: string | null;
  /** data.text */
  text: string | null;
  /** task_updated / task_completed / task_requested fields. */
  fields: Record<string, string> | null;
  dedupe: string | null;
  /**
   * question_required: herdr-watch (data.agent set) or emit. A primary_handoff with a `[선택지]`
   * block: "devlead" (the team asks the user; its options in `options`).
   */
  source: HostQuestionSource | null;
  /** data.pane / data.target */
  pane: string | null;
  /** answer_*: the question event id (parsed from data or dedupe). */
  question: number | null;
  /** A devlead question's options, from its `[선택지]` block (parseChoices). */
  options?: HostChoice[];
}

/** Where a question came from: herdr-watch saw the worker blocked, a worker emitted it, or the team (devlead) asks the user. */
export type HostQuestionSource = "herdr" | "worker" | "devlead";

/** One option of a question's `[선택지]` block: `A) 이름 — 결과 (추천: 이유)`. */
export interface HostChoice {
  /** The option's letter (or number), as written: "A". */
  key: string;
  label: string;
  /** What choosing it does, as written after the dash; null when the line has none. */
  detail: string | null;
  /** The line says it's the recommended one ("(추천…"). */
  recommended: boolean;
}

/**
 * The options of a question the team asks the user (devlead's rule for primary_handoff: a line
 * `[선택지]`, then one line per option, `A) <name> — <what happens> (추천: <why>)`), or [] when
 * the text has no such block or fewer than two options. A line after the options that isn't one
 * (a blank line, `기한: …`) ends the block.
 */
export function parseChoices(text: string | null | undefined): HostChoice[] {
  if (typeof text !== "string") return [];
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === "[선택지]");
  if (start < 0) return [];
  const out: HostChoice[] = [];
  for (const line of lines.slice(start + 1)) {
    const m = /^\s*([A-Za-z0-9]{1,2})[).]\s*(\S.*?)\s*$/.exec(line);
    if (!m) {
      if (!out.length && !line.trim()) continue;
      break;
    }
    const key = m[1]!;
    const body = m[2]!;
    const dash = /\s[—–-]\s/.exec(body);
    const label = (dash ? body.slice(0, dash.index) : body).trim().slice(0, 200);
    const detail = dash ? body.slice(dash.index + dash[0].length).trim().slice(0, 1000) || null : null;
    if (!label || out.some((o) => o.key.toLowerCase() === key.toLowerCase())) break;
    out.push({ key, label, detail, recommended: /\((?:추천|recommended)/i.test(body) });
    if (out.length >= 10) break;
  }
  return out.length >= 2 ? out : [];
}

/** An event's text, at most (characters). */
export const HOST_TEXT_MAX = 4000;
/** Events in one host-events frame, at most. */
export const HOST_BATCH_MAX = 100;

/** Daemon → hub: new host events in id order, with the snapshots of the tasks they touch. */
export interface HostEventsFrame {
  t: "host-events";
  events: HostEvent[];
  tasks: HostTask[];
  cursor: number;
  /**
   * host-task's log starts over (its database was reset or replaced: it ends before the hub's
   * cursor), and these are from the new one: the reset's id (`rs_` + 10 base32, kept by the
   * daemon until the hub acks it). The hub drops what it kept from the old log, whose ids the new
   * one reuses, once per id: a frame repeating an id it applied is stored as any other. Sent until acked.
   */
  reset?: string;
}
/** Hub → daemon: the batch up to `cursor` is stored; the daemon persists its cursor only now. */
export interface HostAckFrame {
  t: "host-ack";
  cursor: number;
  /** The frame's reset id, applied (now or before). */
  reset?: string;
}
/** Hub → daemon, after a hello with `host`: the last host event id the hub stored for this machine. */
export interface HostCursorFrame {
  t: "host-cursor";
  cursor: number | null;
  /** The last reset id the hub applied: `cursor` is in that log. */
  reset?: string | null;
}

/** A reset's id. */
export const HOST_RESET_ID = /^rs_[0-9a-z]{10}$/;

/**
 * Who a Dots-side write came from (D): the calling app or token as the user knows it (the OAuth
 * app's name, the device token's label) and how it signed in. Written into host-task with the
 * request, follow-up or answer; never an instruction to anyone.
 */
export interface HostVia {
  client: string;
  kind: "oauth" | "token" | "session";
}

/**
 * Where an outside-context item came from (a Trello webhook action, …): the provider and its ids.
 * Not a user: never a request, follow-up, approval or answer.
 */
export interface HostProvider {
  /** "trello", or another provider's short name. */
  kind: string;
  board?: string;
  card?: string;
  /** The provider's id for the action (Trello's action.id). */
  action: string;
  url?: string;
}

/** Hub → daemon requests (inside the existing {t:"req", rid, op, …} envelope). */
export type HostOp =
  | { op: "host.request"; requestId: string; text: string; title: string; project?: string; repo?: string; worker?: string; priority?: string; via?: HostVia }
  /** Ledger mode also takes `request` (hr_…): with no task, a follow-up to a request the team hasn't given a task id yet. */
  | { op: "host.followup"; requestId: string; task?: string; request?: string; text: string; via?: HostVia }
  /**
   * ack: the answer's acknowledgement key if it goes to the supervisor (HOST_ACK_KEY: `ha_<question>:<nonce>`).
   * choice: ledger mode, the option the user picked (its key in the question's `[선택지]`).
   */
  | { op: "host.answer"; question: number; text: string; via?: HostVia; ack?: string; choice?: string }
  | { op: "host.status"; task?: string; project?: string; limit?: number }
  | { op: "host.questions" }
  /** An existing task or question the hub hasn't seen (made outside 0bridge): does this machine have it? Ledger mode: a request's task, by its id. */
  | { op: "host.lookup"; task?: string; question?: number; request?: string }
  /** Outside context for a task's existing worker, through the supervisor (docs/plans/dots-host.md, "Outside context"). */
  | { op: "host.context"; id: string; task: string; dedupe: string; provider: HostProvider; text: string; ack?: string };

export interface HostLookupReply {
  task: HostTask | null;
  question: { question: number; task: string; text: string | null; askedAt: number | null; source: HostQuestionSource } | null;
  /** Asked with `request` (ledger mode): that request as this machine has it, null when it doesn't. */
  request?: HostLedgerReceipt | null;
}

/**
 * Ledger mode (docs/plans/dots-host.md, "Ledger mode"): a request as the machine has it, a
 * dev_request in host-task's log (`event`), and once the team made a task for it (a later event
 * on a task names the request id), that task.
 */
export interface HostLedgerReceipt {
  requestId: string;
  event: number | null;
  task: string | null;
}
/** A request id the hub makes (hr_ + 10 base32); the daemon takes 4 to 40 letters and digits. */
export const HOST_REQUEST_ID = /^hr_[A-Za-z0-9]{4,40}$/;

/**
 * An outside-context item's dedupe key, the same on the hub and the daemon: `<provider>:<board>:<action>`,
 * at most 200 characters in all (host-task's `context-pending:<key>:<n>` and the like stay under
 * what the hub keeps of an event's dedupe key, HOST_DEDUPE_MAX).
 */
export const HOST_CONTEXT_KEY = /^(?=.{3,200}$)[a-z][a-z0-9_-]{0,31}:[A-Za-z0-9._:-]{1,190}$/;
/** An event's dedupe key, at most (characters), as the hub keeps it. */
export const HOST_DEDUPE_MAX = 256;

/**
 * How a worker acknowledges a delivery: `host-task emit --kind worker_ack --dedupe ack:<ack key>`.
 * For a context item or an answer passed to the supervisor the key is the supervisor message's id
 * and a random nonce (`hc_…:<nonce>`, `ha_45:<nonce>`), made by the hub with the delivery and
 * given to the worker only in the supervisor's message, so nobody can acknowledge it from the
 * provider's key or the question's id. A Dots request's or follow-up's key is its random id (hr_, hf_).
 */
export const HOST_ACK_NONCE = /^[0-9a-z]{16}$/;
export const isHostAck = (id: string, ack: unknown): ack is string =>
  typeof ack === "string" && ack.startsWith(`${id}:`) && HOST_ACK_NONCE.test(ack.slice(id.length + 1));
/** A new acknowledgement key for the supervisor message `id`. */
export function newHostAck(id: string): string {
  const abc = "0123456789abcdefghjkmnpqrstvwxyz";
  return `${id}:${[...crypto.getRandomValues(new Uint8Array(16))].map((b) => abc[b & 31]).join("")}`;
}

/**
 * Where one delivery stands (a context item, a Dots request, follow-up or answer):
 * recorded (host-task has it) → queued (with the supervisor) → supervisor_reply (lead answered) →
 * worker_acked (the worker ran `host-task emit --kind worker_ack --dedupe ack:<ack key>` after the
 * supervisor had it: an earlier one is ignored), or delivered
 * (an answer typed into a herdr question and confirmed). pending: waiting for the worker (why in
 * detail; retried); refused: never delivered (why in detail).
 */
export type HostDeliveryState = "recorded" | "pending" | "queued" | "supervisor_reply" | "delivered" | "worker_acked" | "refused";
export const HOST_DELIVERY_STATES: readonly HostDeliveryState[] = ["recorded", "pending", "queued", "supervisor_reply", "delivered", "worker_acked", "refused"];

export interface HostContextReply {
  id: string;
  task: string;
  dedupe: string;
  state: Extract<HostDeliveryState, "recorded" | "pending" | "queued" | "supervisor_reply" | "worker_acked" | "refused">;
  detail: string | null;
  worker?: string;
  pane?: string;
}

/** dispatch recorded: ledger mode, written into host-task's log for the team (no task made, nothing sent to an agent). */
export interface HostRequestReply {
  /** null in ledger mode until the team gives the request a task. */
  task: HostTask | null;
  dispatch: "queued" | "duplicate" | "recorded";
  /** Ledger mode: where the request is in host-task. */
  receipt?: HostLedgerReceipt;
}
export interface HostFollowupReply {
  /** null in ledger mode for a follow-up to a request with no task id yet. */
  task: string | null;
  dispatch: "queued" | "duplicate" | "recorded";
  /** Ledger mode: the user_followup event, and the request it's about. */
  event?: number | null;
  request?: string | null;
}
/** recorded: ledger mode, the answer is in host-task's log as the user's decision on the task. */
export type HostAnswerStatus = "delivered" | "pending" | "forwarded" | "refused" | "recorded";
export interface HostAnswerReply {
  question: number;
  task: string | null;
  status: HostAnswerStatus;
  detail: string;
  worker?: string;
  pane?: string;
  /** delivered: the state herdr showed before and after, and the host-task event that records it. */
  confirmation?: { from: string; to: string; event: number | null };
  /** refused because a newer question is current: its id. */
  current?: number | null;
  /** recorded: the user_decision event. */
  event?: number | null;
}
export interface HostStatusReply {
  tasks: HostTask[];
}
export interface HostQuestionsReply {
  questions: { question: number; task: string; text: string | null; askedAt: number | null }[];
}

// Event payloads (events/list payloadSchema mirrors these). Times are ISO 8601.
export interface HostQuestionData {
  machine: string;
  task: string;
  questionId: string;
  title: string;
  project: string | null;
  worker: string | null;
  question: string;
  source: HostQuestionSource;
  /** A devlead question's options ([] for a worker's). */
  options: HostChoice[];
  askedAt: string;
}
export interface HostCompletedData {
  machine: string;
  task: string;
  title: string;
  project: string | null;
  evidence: string;
  result: string | null;
  pr: string | null;
  completedAt: string;
}
export interface HostFailedData {
  machine: string;
  task: string;
  title: string;
  project: string | null;
  reason: string | null;
  failedAt: string;
}
