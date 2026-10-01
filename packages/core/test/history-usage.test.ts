import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addUsage, collectHistory, historyPath, loadHistoryConfig, syncWanted, usageOnly, usageWanted, type HistoryConfig, type UsageIn } from "../src/history.ts";

/**
 * Token usage in the collectors (round 2, P5): each log's cursor keeps absolute totals per model
 * and hour, so uploading a bucket again changes nothing; buckets leave the cursor 48 hours on;
 * usage-only mode reads with its own cursors and hands back no conversation.
 */

const H = 3_600_000;
const T0 = Date.parse("2026-09-20T10:15:00Z");
const iso = (t: number) => new Date(t).toISOString();
const hour = (t: number) => Math.floor(t / H);

const line = (id: string, at: number, usage: Record<string, number>, model = "claude-opus-5-5") =>
  JSON.stringify({ type: "assistant", timestamp: iso(at), cwd: "/work/acme/web", uuid: `${id}-${at}`, message: { id, model, role: "assistant", content: [{ type: "text", text: `answer ${id}` }], usage } }) + "\n";
const ask = (text: string, at: number) => JSON.stringify({ type: "user", timestamp: iso(at), cwd: "/work/acme/web", uuid: `u-${at}`, message: { role: "user", content: text } }) + "\n";

const pick = (rows: UsageIn[]) => rows.map((r) => ({ hour: r.hour, model: r.model, input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite })).sort((a, b) => a.hour - b.hour);

describe("collectHistory usage", () => {
  const home = mkdtempSync(join(tmpdir(), "0b-hist-usage-"));
  const ctx = { home, storeDir: join(home, ".0bridge") };
  const dir = join(home, ".claude", "projects", "-work-acme-web");
  const file = join(dir, "abcdef01-2345-4678-9abc-def012345678.jsonl");
  const SESSION = "claude-code:abcdef01-2345-4678-9abc-def012345678";
  const env = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
  const cfg = (files: HistoryConfig["files"] = {}, extra: Partial<HistoryConfig> = {}): HistoryConfig => ({ enabled: true, tools: ["claude-code", "grok"], exclude: [], files, ...extra });

  beforeAll(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CODEX_HOME;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      file,
      ask("Why is the webhook firing twice?", T0) +
        line("msg_1", T0 + 1000, { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 500 }) +
        line("msg_1", T0 + 2000, { input_tokens: 10, output_tokens: 30, cache_creation_input_tokens: 500 }) +
        line("msg_2", T0 + 3000, { input_tokens: 4, output_tokens: 8, cache_read_input_tokens: 500 }),
    );
    // A Grok session: no token counts in its logs.
    mkdirSync(join(home, ".grok", "sessions", "%2Fwork%2Fx", "g1"), { recursive: true });
    writeFileSync(join(home, ".grok", "sessions", "%2Fwork%2Fx", "g1", "chat_history.jsonl"), JSON.stringify({ type: "user", content: "hi", timestamp: iso(T0) }) + "\n");
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    rmSync(home, { recursive: true, force: true });
  });

  let saved: HistoryConfig["files"] = {};

  test("the first read uploads each bucket's totals, with the session, tool and device", () => {
    const got = collectHistory(ctx, cfg(), [], { now: T0 + H });
    expect(pick(got.usage)).toEqual([{ hour: hour(T0), model: "claude-opus-5-5", input: 14, output: 38, cacheRead: 500, cacheWrite: 500 }]);
    expect(got.usage[0]).toMatchObject({ session: SESSION, tool: "claude-code", reasoning: 0 });
    expect(typeof got.usage[0]!.device).toBe("string");
    expect(got.cursors[file]!.usage).toEqual({ [`claude-opus-5-5|${hour(T0)}`]: { input: 14, output: 38, cacheRead: 500, cacheWrite: 500, reasoning: 0 } });
    // Messages and their seqs are what they always were.
    expect(got.sessions.find((s) => s.id === SESSION)!.messages.map((m) => [m.seq, m.role])).toEqual([
      [0, "user"],
      [1, "assistant"],
      [2, "assistant"],
      [3, "assistant"],
    ]);
    saved = got.cursors;
  });

  test("nothing new: no rows; the same lines read from scratch give the same absolute rows (re-upload is harmless)", () => {
    expect(collectHistory(ctx, cfg(saved), [], { now: T0 + H }).usage).toEqual([]);
    const again = collectHistory(ctx, cfg(), [], { now: T0 + H });
    expect(pick(again.usage)).toEqual(pick(collectHistory(ctx, cfg(), [], { now: T0 + H }).usage));
  });

  test("appended lines: the grown bucket's new total, and a new hour's own bucket", () => {
    appendFileSync(file, line("msg_2", T0 + 4000, { input_tokens: 4, output_tokens: 20, cache_read_input_tokens: 500 }) + line("msg_3", T0 + H, { input_tokens: 1, output_tokens: 1 }, "claude-haiku-4-5"));
    const got = collectHistory(ctx, cfg(saved), [], { now: T0 + H });
    expect(pick(got.usage)).toEqual([
      { hour: hour(T0), model: "claude-opus-5-5", input: 14, output: 50, cacheRead: 500, cacheWrite: 500 },
      { hour: hour(T0) + 1, model: "claude-haiku-4-5", input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    ]);
    // The message upload goes on from where it stopped.
    expect(got.sessions[0]!.messages.map((m) => m.seq)).toEqual([4, 5]);
    saved = { ...saved, ...got.cursors };
  });

  test("48 hours on, the old buckets leave the cursor", () => {
    const later = T0 + 50 * H;
    appendFileSync(file, line("msg_4", later, { input_tokens: 2, output_tokens: 2 }));
    const got = collectHistory(ctx, cfg(saved), [], { now: later });
    expect(pick(got.usage)).toEqual([{ hour: hour(later), model: "claude-opus-5-5", input: 2, output: 2, cacheRead: 0, cacheWrite: 0 }]);
    expect(Object.keys(got.cursors[file]!.usage!)).toEqual([`claude-opus-5-5|${hour(later)}`]);
  });

  test("an excluded repo's tokens still count, without the repo; its messages don't go up", () => {
    const got = collectHistory(ctx, cfg({}, { exclude: ["/work/acme"] }), [], { now: T0 + H });
    expect(got.sessions.filter((s) => s.id === SESSION)).toEqual([]);
    expect(got.usage.length).toBeGreaterThan(0);
    expect(got.usage.every((r) => r.repo === undefined)).toBe(true);
  });

  test("counts only (usage without history): no sessions, sources without token counts skipped", () => {
    const got = collectHistory(ctx, cfg({}), [], { now: T0 + 60 * H, countsOnly: true });
    expect(got.sessions).toEqual([]);
    expect(Object.keys(got.cursors)).toEqual([file]);
    expect(got.usage.length).toBe(3);
  });
});

describe("usage-only config", () => {
  const ctx = { home: "", storeDir: mkdtempSync(join(tmpdir(), "0b-hist-usage-cfg-")) };
  afterAll(() => rmSync(ctx.storeDir, { recursive: true, force: true }));
  const save = (c: object) => writeFileSync(historyPath(ctx), JSON.stringify(c));

  test("usage follows history unless it's set; usage on with history off syncs counts only", () => {
    const c = (o: Partial<HistoryConfig>): HistoryConfig => ({ enabled: false, tools: [], exclude: [], files: {}, ...o });
    expect([usageWanted(c({ enabled: true })), syncWanted(c({ enabled: true })), usageOnly(c({ enabled: true }))]).toEqual([true, true, false]);
    expect([usageWanted(c({})), syncWanted(c({})), usageOnly(c({}))]).toEqual([false, false, false]);
    expect([usageWanted(c({ usage: true })), syncWanted(c({ usage: true })), usageOnly(c({ usage: true }))]).toEqual([true, true, true]);
    expect([usageWanted(c({ enabled: true, usage: false })), syncWanted(c({ enabled: true, usage: false }))]).toEqual([false, true]);
  });

  test("the usage switch and usage-only cursors survive a load, apart from history's cursors", () => {
    save({ enabled: false, usage: true, files: { a: { offset: 1, seq: 1, session: "x" } }, usageFiles: { b: { offset: 9, seq: 0, session: "y" } } });
    const c = loadHistoryConfig(ctx);
    expect(c.usage).toBe(true);
    expect(Object.keys(c.files)).toEqual(["a"]);
    expect(Object.keys(c.usageFiles!)).toEqual(["b"]);
    save({ enabled: true });
    expect("usage" in loadHistoryConfig(ctx)).toBe(false);
  });
});

describe("addUsage", () => {
  test("adds deltas into absolute buckets, drops old untouched ones, keeps the prior total of an old bucket that grew", () => {
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
    const prev = { "m|100": { ...zero, input: 5 }, "m|10": { ...zero, input: 7 }, "m|11": { ...zero, input: 1 } };
    const r = addUsage(prev, [{ ...zero, model: "m", hour: 100, input: 1 }, { ...zero, model: "m", hour: 10, output: 3 }], 50);
    expect(r.buckets).toEqual({ "m|100": { ...zero, input: 6 }, "m|10": { ...zero, input: 7, output: 3 } });
    expect(r.touched.sort()).toEqual(["m|10", "m|100"]);
    expect(addUsage(prev, undefined, 50)).toEqual({ buckets: { "m|100": { ...zero, input: 5 } }, touched: [] });
  });
});
