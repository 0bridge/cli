import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { converters, sumUsage, type ConverterId, type ParseResult, type UsageDelta } from "../src/index.ts";

/**
 * Token counts from the converters (round 2, P5): counted once per Claude message, Codex's running
 * totals turned into deltas, Gemini's per-message tokens, bucketed by model and hour, and the same
 * whether a log is read in one go or in pieces.
 */

const H = 3_600_000;
const hourOf = (iso: string) => Math.floor(Date.parse(iso) / H);

const claudeLine = (o: { id: string; at: string; usage: Record<string, number>; model?: string; block?: object; sidechain?: boolean }) =>
  JSON.stringify({
    type: "assistant",
    timestamp: o.at,
    uuid: `${o.id}-${Math.random()}`,
    ...(o.sidechain ? { isSidechain: true } : {}),
    message: { id: o.id, model: o.model ?? "claude-opus-5-5", role: "assistant", content: [o.block ?? { type: "text", text: "ok" }], usage: o.usage },
  });

const codexLine = (at: string, t: Record<string, number> | null) => JSON.stringify({ timestamp: at, type: "event_msg", payload: { type: "token_count", info: t ? { total_token_usage: t } : null } });
const codexModel = (model: string) => JSON.stringify({ timestamp: "2026-09-21T09:00:00Z", type: "turn_context", payload: { cwd: "/w", model } });

/** Everything a sequence of parse results counted, summed per model-hour and sorted. */
const total = (rs: ParseResult[]): UsageDelta[] => sumUsage(rs.flatMap((r) => r.usage ?? [])).sort((a, b) => a.hour - b.hour || a.model.localeCompare(b.model));

describe("Claude Code", () => {
  const u = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 };

  test("a message written as several lines (one per block) is counted once", () => {
    const r = converters["claude-code"]([
      claudeLine({ id: "msg_1", at: "2026-09-20T10:00:00Z", usage: u, block: { type: "thinking", thinking: "x" } }),
      claudeLine({ id: "msg_1", at: "2026-09-20T10:00:01Z", usage: u }),
      claudeLine({ id: "msg_1", at: "2026-09-20T10:00:02Z", usage: u, block: { type: "tool_use", id: "t", name: "Bash", input: {} } }),
    ]);
    expect(r.usage).toEqual([{ model: "claude-opus-5-5", hour: hourOf("2026-09-20T10:00:00Z"), input: 10, output: 5, cacheRead: 1000, cacheWrite: 200, reasoning: 0 }]);
  });

  test("cache fields map to cacheRead and cacheWrite; a later line with more output adds only the difference", () => {
    const r = converters["claude-code"]([
      claudeLine({ id: "msg_1", at: "2026-09-20T10:00:00Z", usage: { ...u, output_tokens: 1 } }),
      claudeLine({ id: "msg_1", at: "2026-09-20T10:00:03Z", usage: { ...u, output_tokens: 40 } }),
      claudeLine({ id: "msg_2", at: "2026-09-20T10:05:00Z", usage: { input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 1200 } }),
    ]);
    expect(r.usage).toEqual([{ model: "claude-opus-5-5", hour: hourOf("2026-09-20T10:00:00Z"), input: 13, output: 47, cacheRead: 2200, cacheWrite: 200, reasoning: 0 }]);
  });

  test("models are kept apart, synthetic messages and user lines count nothing, sidechains count", () => {
    const r = converters["claude-code"]([
      JSON.stringify({ type: "user", timestamp: "2026-09-20T10:00:00Z", message: { role: "user", content: "hi", usage: u } }),
      claudeLine({ id: "msg_1", at: "2026-09-20T10:00:00Z", usage: u }),
      claudeLine({ id: "msg_2", at: "2026-09-20T10:00:00Z", usage: u, model: "claude-haiku-4-5" }),
      claudeLine({ id: "msg_3", at: "2026-09-20T10:00:00Z", usage: u, model: "<synthetic>" }),
      claudeLine({ id: "msg_4", at: "2026-09-20T10:00:00Z", usage: u, model: "claude-haiku-4-5", sidechain: true }),
    ]);
    expect(r.usage!.map((d) => [d.model, d.input])).toEqual([
      ["claude-opus-5-5", 10],
      ["claude-haiku-4-5", 20],
    ]);
    expect(r.events.length).toBe(4); // the sidechain's turn stays out of the conversation
  });

  test("the message ids remembered across calls are capped at 64", () => {
    const lines = Array.from({ length: 80 }, (_, i) => claudeLine({ id: `msg_${i}`, at: "2026-09-20T10:00:00Z", usage: u }));
    const r = converters["claude-code"](lines);
    expect((r.state.x!.usageIds as unknown[]).length).toBe(64);
    // A repeat of a remembered message adds nothing in a later call.
    expect(converters["claude-code"]([lines[79]!], r.state).usage).toBeUndefined();
  });
});

describe("Codex", () => {
  test("cumulative totals become deltas; cached input is a subset of input, reasoning of output", () => {
    const r = converters.codex([
      codexModel("gpt-5.4"),
      codexLine("2026-09-21T09:00:01Z", null),
      codexLine("2026-09-21T09:00:02Z", { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 100, reasoning_output_tokens: 60, total_tokens: 1100 }),
      codexLine("2026-09-21T09:10:00Z", { input_tokens: 2500, cached_input_tokens: 2000, output_tokens: 150, reasoning_output_tokens: 60, total_tokens: 2650 }),
      // The same total again (Codex repeats it with rate-limit updates): nothing new.
      codexLine("2026-09-21T09:11:00Z", { input_tokens: 2500, cached_input_tokens: 2000, output_tokens: 150, reasoning_output_tokens: 60, total_tokens: 2650 }),
    ]);
    expect(r.usage).toEqual([{ model: "gpt-5.4", hour: hourOf("2026-09-21T09:00:00Z"), input: 500, output: 150, cacheRead: 2000, cacheWrite: 0, reasoning: 60 }]);
  });

  test("a total that goes down starts a new baseline, counted whole", () => {
    const first = converters.codex([codexModel("gpt-5.4"), codexLine("2026-09-21T09:00:00Z", { input_tokens: 900, cached_input_tokens: 0, output_tokens: 90, reasoning_output_tokens: 0 })]);
    const again = converters.codex([codexLine("2026-09-21T11:00:00Z", { input_tokens: 300, cached_input_tokens: 100, output_tokens: 30, reasoning_output_tokens: 10 })], first.state);
    expect(again.usage).toEqual([{ model: "gpt-5.4", hour: hourOf("2026-09-21T11:00:00Z"), input: 200, output: 30, cacheRead: 100, cacheWrite: 0, reasoning: 10 }]);
  });

  test("OpenClaw's rollouts are read the same way", () => {
    const r = converters.openclaw([codexModel("gpt-5.2"), codexLine("2026-09-21T09:00:00Z", { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 })]);
    expect(r.usage?.[0]).toMatchObject({ model: "gpt-5.2", input: 10, output: 2 });
  });
});

describe("hours", () => {
  test("tokens on either side of midnight land in their own hour buckets", () => {
    const u = { input_tokens: 1, output_tokens: 1 };
    const r = converters["claude-code"]([
      claudeLine({ id: "a", at: "2026-09-20T23:59:59Z", usage: u }),
      claudeLine({ id: "b", at: "2026-09-21T00:00:00Z", usage: u }),
      claudeLine({ id: "c", at: "2026-09-21T00:59:00Z", usage: u }),
    ]);
    expect(r.usage!.map((d) => [d.hour, d.input])).toEqual([
      [hourOf("2026-09-20T23:00:00Z"), 1],
      [hourOf("2026-09-21T00:00:00Z"), 2],
    ]);
  });

  test("a line without a time counts nothing (there's no hour to put it in)", () => {
    const line = JSON.parse(claudeLine({ id: "a", at: "2026-09-20T10:00:00Z", usage: { input_tokens: 5 } }));
    delete line.timestamp;
    expect(converters["claude-code"]([JSON.stringify(line)]).usage).toBeUndefined();
  });
});

describe("Gemini", () => {
  test("per-message tokens when present: cached inside input, thoughts as reasoning inside output", () => {
    const doc = {
      sessionId: "g1",
      startTime: "2026-09-22T08:00:00Z",
      messages: [
        { id: "1", timestamp: "2026-09-22T08:00:00Z", type: "user", content: "hi" },
        { id: "2", timestamp: "2026-09-22T08:00:05Z", type: "gemini", model: "gemini-2.5-pro", content: "hello", tokens: { input: 100, output: 20, cached: 60, thoughts: 30, tool: 5, total: 155 } },
        { id: "3", timestamp: "2026-09-22T08:01:00Z", type: "gemini", model: "gemini-2.5-pro", content: "no tokens here" },
      ],
    };
    const r = converters["gemini-cli"](JSON.stringify(doc, null, 2).split("\n"));
    expect(r.usage).toEqual([{ model: "gemini-2.5-pro", hour: hourOf("2026-09-22T08:00:00Z"), input: 45, output: 50, cacheRead: 60, cacheWrite: 0, reasoning: 30 }]);
    // The whole document again: what was converted already isn't counted twice.
    expect(converters["gemini-cli"](JSON.stringify(doc).split("\n"), r.state).usage).toBeUndefined();
  });
});

describe("incremental parse", () => {
  const claude = [
    claudeLine({ id: "m1", at: "2026-09-20T10:00:00Z", usage: { input_tokens: 3, output_tokens: 1, cache_creation_input_tokens: 50 } }),
    claudeLine({ id: "m1", at: "2026-09-20T10:00:01Z", usage: { input_tokens: 3, output_tokens: 9, cache_creation_input_tokens: 50 } }),
    JSON.stringify({ type: "user", timestamp: "2026-09-20T10:00:02Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } }),
    claudeLine({ id: "m2", at: "2026-09-20T10:59:59Z", usage: { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 50 } }),
    claudeLine({ id: "m2", at: "2026-09-20T11:00:01Z", usage: { input_tokens: 4, output_tokens: 6, cache_read_input_tokens: 50 } }),
    claudeLine({ id: "m3", at: "2026-09-20T11:30:00Z", usage: { input_tokens: 1, output_tokens: 1 }, model: "claude-sonnet-5-5" }),
  ];
  const codex = [
    codexModel("gpt-5.4"),
    codexLine("2026-09-21T09:00:00Z", { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 5 }),
    codexLine("2026-09-21T09:30:00Z", { input_tokens: 300, cached_input_tokens: 150, output_tokens: 30, reasoning_output_tokens: 5 }),
    codexModel("gpt-5.5"),
    codexLine("2026-09-21T10:30:00Z", { input_tokens: 500, cached_input_tokens: 350, output_tokens: 70, reasoning_output_tokens: 25 }),
    codexLine("2026-09-21T11:00:00Z", { input_tokens: 40, cached_input_tokens: 0, output_tokens: 4, reasoning_output_tokens: 0 }),
  ];

  for (const [id, src] of [
    ["claude-code", claude],
    ["codex", codex],
  ] as [ConverterId, string[]][])
    test(`${id}: split anywhere (twice) equals one read`, () => {
      const one = converters[id](src);
      for (let a = 0; a <= src.length; a++)
        for (let b = a; b <= src.length; b++) {
          const p1 = converters[id](src.slice(0, a));
          const p2 = converters[id](src.slice(a, b), p1.state);
          const p3 = converters[id](src.slice(b), p2.state);
          expect(total([p1, p2, p3])).toEqual(total([one]));
          expect(p3.state).toEqual(one.state);
        }
    });

  // The checked-in fixtures, read in two pieces, count what one read does.
  const FIXTURES = join(import.meta.dir, "fixtures");
  for (const id of Object.keys(converters) as ConverterId[]) {
    if (id === "gemini-cli" || !existsSync(join(FIXTURES, id))) continue;
    for (const f of readdirSync(join(FIXTURES, id)).filter((f) => !f.endsWith(".expected.json"))) {
      const src = readFileSync(join(FIXTURES, id, f), "utf8").replace(/\n$/, "").split("\n");
      test(`${id}/${f}: usage in two pieces equals usage read whole`, () => {
        const one = total([converters[id](src)]);
        for (let k = 0; k <= src.length; k++) {
          const a = converters[id](src.slice(0, k));
          expect(total([a, converters[id](src.slice(k), a.state)])).toEqual(one);
        }
      });
    }
  }
});
