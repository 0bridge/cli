import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { writeAtomic, type Context } from "@0bridge/core";
import { trelloEvent } from "@0bridge/core/trello";
import { HostTaskClient } from "./agent/supervisor.ts";
import { cloudClient } from "./cloud.ts";
import { loadAgentConfig } from "./agent/policy.ts";
import { redact } from "../../../packages/session/src/redact.ts";

export type DeliveryResult = { status: "ignored" | "proposed" | "pending" | "unconfirmed" | "delivered"; task?: string; detail: string };
// Structural REST contract from PR5 docs/plans/dots-host.md §4.9. No delivery engine here.
export interface TrelloContextInput {
  task: string;
  provider: { kind: "trello"; board: string; card: string; action: string; url: string };
  dedupe: string;
  text: string;
}
export interface TrelloContextResult {
  delivery: { key: string; kind: string; task: string | null; state: string; provenance: Record<string, string> | null };
}
export interface CommentRecord { status: "typing" | "delivered" | "context"; task: string; hash: string; pane?: string; worker?: string; seq?: number | null }
export interface ProposalRecord { status: "proposing" | "proposed"; task: string; hash: string }
export type TrelloRecord = CommentRecord | ProposalRecord;
export interface TrelloHostDeps {
  host: Pick<HostTaskClient, "list" | "show" | "emit">;
  context?: (input: TrelloContextInput) => Promise<TrelloContextResult>;
  doneList?: string;
  records: { get(id: string): TrelloRecord | undefined; set(id: string, record: TrelloRecord): void };
  mask(text: string): string;
}
const approvedBoard = "6ac3b9821dc2644f39df0761", approvedDone = "6ac3bd28ee18025f5f7f62b0";
/** Separate local opt-in for host records. This grants no worker-input or agent-control authority. */
export interface TrelloRelayConfig { enabled: boolean; board: string; doneList: string; hostTask: string }
export function trelloRelayConfig(raw: unknown): TrelloRelayConfig {
  const c = raw as TrelloRelayConfig | null;
  if (!c || typeof c !== "object" || Object.keys(c).some(k => !["enabled", "board", "doneList", "hostTask"].includes(k)) || typeof c.enabled !== "boolean" || typeof c.board !== "string" || !/^[a-f0-9]{24}$/.test(c.board) || typeof c.doneList !== "string" || !/^[a-f0-9]{24}$/.test(c.doneList) || typeof c.hostTask !== "string" || !c.hostTask.trim() || c.hostTask.startsWith("-") || /[\r\n\0]/.test(c.hostTask)) throw new Error("relay config needs enabled, raw board/doneList ids and a hostTask executable; no other fields");
  return { enabled: c.enabled, board: c.board, doneList: c.doneList, hostTask: c.hostTask };
}
export function loadTrelloRelay(ctx: Context): TrelloRelayConfig | undefined {
  let text: string;
  try { text = readFileSync(join(ctx.storeDir, "trello-relay.json"), "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
  return trelloRelayConfig(JSON.parse(text));
}
export function saveTrelloRelay(ctx: Context, raw: unknown): TrelloRelayConfig {
  const cfg = trelloRelayConfig(raw);
  writeAtomic(join(ctx.storeDir, "trello-relay.json"), JSON.stringify(cfg) + "\n", { mode: 0o600 });
  return cfg;
}
const rawCard = (id: unknown) => typeof id === "string" && /^(?:[a-f0-9]{24}|ari:cloud:trello::card\/workspace\/[a-f0-9]{24}\/[a-f0-9]{24})$/.test(id) ? id.split("/").at(-1) : null;

/** Outside context or a completion proposal, never command authority or completion evidence. */
export async function deliverTrelloComment(board: string, input: unknown, d: TrelloHostDeps): Promise<DeliveryResult> {
  const wrapped = input as { verified?: boolean; data?: unknown } | null;
  if (wrapped?.verified !== true) throw new Error("trello-host requires a verified runner event");
  const e = trelloEvent(wrapped.data, board);
  if (!e) throw new Error("invalid Trello board/action");
  const doneList = d.doneList ?? (board === approvedBoard ? approvedDone : undefined);
  const proposal = e.action.type === "updateCard" && !!doneList && e.action.data.listAfter?.id === doneList && !!e.action.data.listBefore && e.action.data.listBefore.id !== doneList;
  if (e.action.type !== "commentCard" && !proposal) return { status: "ignored", detail: "card changes are not commands or completion evidence" };
  const text = e.action.data.text;
  if (!proposal && (typeof text !== "string" || !text.trim() || text.length > 8000)) throw new Error("comment must be 1–8000 characters");
  if (!proposal && text!.startsWith("[0bridge-sync:")) return { status: "ignored", detail: "own synchronization marker" };
  const card = e.action.data.card?.id;
  if (!card) throw new Error("event has no raw card id");
  const tasks = (await d.host.list()).filter(t => (board === "6ac3b9821dc2644f39df0761" && t.trello_board === "https://trello.com/b/Rmgi2lRQ/tasks") || t.trello_board_id === board);
  const hits = tasks.filter(t => rawCard(t.trello_card_id) === card);
  if (hits.length !== 1) throw new Error("card needs exactly one existing host-task mapping on the approved board");
  const task = String(hits[0]!.task_id);
  if (!/^T-\d{1,9}$/.test(task)) throw new Error("invalid mapped task id");
  const hash = createHash("sha256").update(JSON.stringify([card, proposal ? [e.action.type, e.action.data.listBefore!.id, doneList] : text!])).digest("hex");
  const id = `${board}:${e.action.id}`;
  const old = d.records.get(id);
  const legacyHash = createHash("sha256").update(proposal ? JSON.stringify([e.action.type, card, e.action.data.listBefore!.id, doneList]) : text!).digest("hex");
  if (old && ((old.hash !== hash && old.hash !== legacyHash) || old.task !== task || proposal !== ["proposing", "proposed"].includes(old.status))) throw new Error("action id conflicts with the recorded event");
  const source = `https://trello.com/c/${card} (action ${e.action.id}; task ${task})`;
  const live = await d.host.show(task);
  if (rawCard(live.trello_card_id) !== card || !((board === approvedBoard && live.trello_board === "https://trello.com/b/Rmgi2lRQ/tasks") || live.trello_board_id === board)) throw new Error("task mapping changed before recording");
  let contextText: string;
  if (proposal) {
    const criteria = (live.contract as { criteria?: { state?: string; evidence?: string }[] } | undefined)?.criteria;
    if (!old && ["completed", "done"].includes(String(live.status)) && live.evidence && criteria?.length && criteria.every(c => c.state === "met" && c.evidence)) return { status: "ignored", task, detail: "already verified host completion; synchronization return ignored" };
    d.records.set(id, { status: "proposing", task, hash });
    await d.host.emit(task, "trello_completion_proposed", `${source}; list ${e.action.data.listBefore!.id} → ${doneList}. Completion proposal only: review every original contract condition and evidence. No completion or worker receipt inferred.`, `trello-proposal:${id}`);
    d.records.set(id, { status: "proposed", task, hash });
    contextText = `Completion proposal only: list ${e.action.data.listBefore!.id} → ${doneList}. Review every original contract condition and evidence. This card move is not command authority or completion evidence.`;
  } else {
    await d.host.emit(task, "trello_comment_received", `${source}\n${d.mask(text!)}`, `trello:${id}`);
    // Old typing/activity observations are not worker acknowledgements. Never upgrade or resend them.
    if (old && ["typing", "delivered"].includes(old.status)) return { status: "unconfirmed", task, detail: "legacy pane submission has no correlated worker_ack; inspect before migration, never retyped" };
    d.records.set(id, { status: "context", task, hash });
    contextText = d.mask(text!);
  }
  if (!d.context) return { status: proposal ? "proposed" : "pending", task, detail: "host context recorded; worker receipt requires the enabled common hostContext supervisor path" };
  const dedupe = `trello:${id}`;
  let r: TrelloContextResult;
  try {
    r = await d.context({ task, provider: { kind: "trello", board, card, action: e.action.id, url: `https://trello.com/c/${card}` }, dedupe, text: contextText });
  } catch {
    // No credential-bearing transport errors or upstream bodies in runner logs.
    return { status: "pending", task, detail: "common hostContext unavailable; replay the same action key, no receipt claimed" };
  }
  const delivery = r?.delivery, p = delivery?.provenance;
  if (!delivery || delivery.key !== dedupe || delivery.kind !== "context" || delivery.task !== task || p?.source !== "context" || p.provider !== "trello" || p.board !== board || p.card !== card || p.action !== e.action.id)
    return { status: "unconfirmed", task, detail: "hostContext response does not match this task and provider action; no receipt claimed" };
  if (delivery.state === "worker_acked") {
    await d.host.emit(task, proposal ? "trello_proposal_delivered" : "trello_comment_delivered", `${source}; common host delivery worker_acked for provider action ${e.action.id} (delivery key ${dedupe}). Worker receipt only, no completion or representative receipt inferred.`, `trello-delivered:${id}`);
    return { status: "delivered", task, detail: "common supervisor confirms worker_ack on the exact task and action key; no completion inferred" };
  }
  if (["recorded", "pending", "queued", "supervisor_reply"].includes(delivery.state)) return { status: "pending", task, detail: `hostContext ${delivery.state}; awaiting worker_ack for the exact task and action key` };
  return { status: "unconfirmed", task, detail: "hostContext refused or unsupported state; no worker receipt claimed" };

}

/** Configured as the existing local runner command; credentials and commands stay on the machine. */
export async function trelloHostCommand(ctx: Context, board: string, input: unknown): Promise<DeliveryResult> {
  const policy = loadAgentConfig(ctx);
  const cfg = policy.supervisor;
  const relay = loadTrelloRelay(ctx);
  if (relay ? !relay.enabled || relay.board !== board : !policy.enabled || !cfg) throw new Error("enable a board-scoped local Trello relay or configure the existing enabled supervisor");
  const dir = join(ctx.storeDir, "agent", "trello-comments");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, "lock");
  try { mkdirSync(lock); } catch { throw new Error("Trello host delivery locked; check for a live process before removing a stale lock"); }
  const host = new HostTaskClient(relay?.hostTask ?? cfg!.hostTask);
  try {
    return await deliverTrelloComment(board, input, {
      host, context: policy.enabled && cfg ? input => cloudClient(ctx).client.call<TrelloContextResult>("POST", "/machines/host/context", input) : undefined, doneList: relay?.doneList, mask: redact,
      records: {
        get(id) {
          const path = join(dir, createHash("sha256").update(id).digest("hex") + ".json");
          try { return JSON.parse(readFileSync(path, "utf8")); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error("Trello delivery record unreadable; refusing retyping"); }
        },
        set(id, record) { writeAtomic(join(dir, createHash("sha256").update(id).digest("hex") + ".json"), JSON.stringify(record), { mode: 0o600 }); },
      },
    });
  } finally { rmSync(lock, { recursive: true }); }
}
