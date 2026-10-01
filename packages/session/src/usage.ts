import type { TokenCounts, UsageDelta } from "./types";

/**
 * Token counts (never content): adding them up and naming a model-hour bucket. Shared by the
 * converters, the CLI's collectors and the gateway's usage store.
 */

export const HOUR_MS = 3_600_000;
export const COUNT_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "reasoning"] as const;

export const noTokens = (): TokenCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });

/** `a + b`, field by field (into a new object). */
export function addTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, reasoning: a.reasoning + b.reasoning };
}

/** Just the counts of something that carries more (a delta, a row). */
export const countsOf = (c: TokenCounts): TokenCounts => ({ input: c.input, output: c.output, cacheRead: c.cacheRead, cacheWrite: c.cacheWrite, reasoning: c.reasoning });

/** Every token the model read or wrote (reasoning is part of output, so it isn't added again). */
export const totalTokens = (c: TokenCounts) => c.input + c.output + c.cacheRead + c.cacheWrite;

export const isEmpty = (c: TokenCounts) => COUNT_FIELDS.every((k) => !c[k]);

/** A non-negative whole number of tokens from a log field (anything else is 0). */
export const tokens = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/** The bucket key a collector keeps absolute totals under: "<model>|<hour>". */
export const bucketKey = (model: string, hour: number) => `${model}|${hour}`;

export function parseBucket(key: string): { model: string; hour: number } | null {
  const i = key.lastIndexOf("|");
  const hour = Number(key.slice(i + 1));
  return i > 0 && key.length > i + 1 && Number.isInteger(hour) ? { model: key.slice(0, i), hour } : null;
}

/** Sum deltas per model-hour (a chunk's usage, in first-seen order). */
export function sumUsage(deltas: UsageDelta[]): UsageDelta[] {
  const out = new Map<string, UsageDelta>();
  for (const d of deltas) {
    const k = bucketKey(d.model, d.hour);
    const cur = out.get(k);
    out.set(k, cur ? { ...addTokens(cur, d), model: d.model, hour: d.hour } : { ...d });
  }
  return [...out.values()];
}
