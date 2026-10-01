import type { Event, ParseResult, ParseState, TokenCounts, UsageDelta } from "../types";
import { HOUR_MS, isEmpty, sumUsage } from "../usage";

/**
 * What every converter does around its own format: carry the state from the last call (so a log
 * read in pieces gives the same events as one read whole), number events, and remember the
 * question tools still waiting for an answer.
 */
export interface Run {
  state: ParseState;
  events: Event[];
  /** Questions the agent asked whose answer hasn't been seen yet (tool call ids). */
  asks: Set<string>;
  /** This call's metadata: only what its lines said. */
  meta: ParseResult["meta"];
  /** Absolute index of the line (or record) at `i` in this call. */
  line(i: number): number;
  push(e: Omit<Event, "seq" | "id"> & { id?: string }): void;
  /** Count tokens the log says a model used at `ts` (ms); nothing without a time or a count. */
  tokens(model: string | undefined, ts: number, c: TokenCounts): void;
  done(consumed: number): ParseResult;
}

export function begin(prev?: ParseState): Run {
  const state: ParseState = { ...prev, seq: prev?.seq ?? 0, x: { ...prev?.x } };
  const base = typeof state.x!.line === "number" ? (state.x!.line as number) : 0;
  const asks = new Set<string>(Array.isArray(state.x!.asks) ? (state.x!.asks as string[]) : []);
  const events: Event[] = [];
  const usage: UsageDelta[] = [];
  const run: Run = {
    state,
    events,
    asks,
    meta: {},
    line: (i) => base + i,
    push(e) {
      const seq = state.seq++;
      const { id, ...rest } = e;
      events.push({ id: id ?? `#${seq}`, seq, ...rest });
    },
    tokens(model, ts, c) {
      if (!ts || isEmpty(c)) return;
      usage.push({ ...c, model: model || "unknown", hour: Math.floor(ts / HOUR_MS) });
    },
    done(consumed) {
      state.x!.line = base + consumed;
      if (asks.size) state.x!.asks = [...asks].slice(-50);
      else delete state.x!.asks;
      return { events, state, meta: run.meta, ...(usage.length ? { usage: sumUsage(usage) } : {}) };
    },
  };
  return run;
}

/** Record metadata on both this call's meta and the carried state. */
export function note(r: Run, k: "cwd" | "title" | "branch" | "model" | "tool", v: unknown): void {
  if (typeof v !== "string" || !v) return;
  r.meta[k] = v;
  r.state[k] = v;
}

export function noteStart(r: Run, at: number): void {
  if (!at || r.state.startedAt) return;
  r.state.startedAt = at;
  r.meta.startedAt = at;
}
