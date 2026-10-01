import type { Event, Session } from "../types";
import { toConversation } from "../convert/index";

/** DTI "AI Conversation History" (schemas.pub/schemas/24, id.schemas.pub/o/DTI/ai-personal-history). */
export interface DtiConversation {
  details: { createdBy: string; createdAt: string; startTime: string; endTime: string; modality: "text" };
  identifiers: { name: string; identifier: string; type?: "email" }[];
  messages: { sentAt: string; sender: string; text: string }[];
}

const iso = (t: number) => new Date(Number.isFinite(t) && t > 0 ? t : 0).toISOString();

/**
 * Export to DTI "AI Conversation History". Lossy: DTI has text messages between a person and "AI"
 * only, so tool calls and their output, reasoning, files, injected context, cwd, repo, branch,
 * model, usage and the resume command are dropped. The conversation is the same one 0bridge
 * uploads (toConversation): what the person typed, what the agent answered, and the questions
 * it asked with their answers. `createdAt` is the session's last update, so the export is
 * reproducible; the person is identified by `source.account` when known.
 */
export function toDti(session: Session, events: Event[]): DtiConversation {
  const who = session.source.account ?? "user";
  const person = { name: who, identifier: who, ...(/^[^\s@]+@[^\s@]+$/.test(who) ? { type: "email" as const } : {}) };
  return {
    details: { createdBy: session.source.product, createdAt: iso(session.updatedAt), startTime: iso(session.createdAt), endTime: iso(session.updatedAt), modality: "text" },
    identifiers: [person],
    messages: toConversation(events).map((m) => ({ sentAt: iso(m.at || session.updatedAt), sender: m.role === "user" ? person.identifier : "AI", text: m.text })),
  };
}
