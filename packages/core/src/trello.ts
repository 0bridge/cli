/** Board-scoped Trello payload validation shared by ingress and the local host runner. */
export interface TrelloEvent {
  action: { id: string; type: string; idMemberCreator?: string; data: { board?: { id: string }; card?: { id: string }; text?: string; listBefore?: { id: string }; listAfter?: { id: string } }; display?: unknown };
  model: { id: string };
}
/** Board subscriptions only. Missing/malformed action ids never fall back to a body hash. */
export function trelloEvent(data: unknown, board: string): TrelloEvent | null {
  const e = data as TrelloEvent | null;
  if (!e || e.model?.id !== board || !/^[a-f0-9]{24}$/.test(e.action?.id ?? "") || !/^[A-Za-z][A-Za-z0-9]{0,99}$/.test(e.action?.type ?? "") || !e.action.data || typeof e.action.data !== "object") return null;
  if (e.action.data.board && e.action.data.board.id !== board) return null;
  if (e.action.data.card && !/^[a-f0-9]{24}$/.test(e.action.data.card.id)) return null;
  for (const list of [e.action.data.listBefore, e.action.data.listAfter]) if (list && (typeof list.id !== "string" || !/^[a-f0-9]{24}$/.test(list.id))) return null;
  return e;
}
