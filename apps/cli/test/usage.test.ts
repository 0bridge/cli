import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHistoryConfig, saveHistoryConfig, usageOnly, usageWanted, type Context } from "@0bridge/core";
import { compact, money, renderUsage, type UsageSummary } from "../src/usage.ts";

/** `0b usage` (round 2, P5): the table it prints, and `0b usage on|off` in history.json. */

const CLI = join(import.meta.dir, "..", "src", "index.ts");
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };

describe("numbers", () => {
  test("compact token counts and money", () => {
    expect([compact(0), compact(999), compact(1234), compact(56_000), compact(5_600_000), compact(1_000_000), compact(123_456_789_012)]).toEqual(["0", "999", "1.2K", "56K", "5.6M", "1M", "123B"]);
    expect([money(null), money(0), money(0.004), money(12.345), money(1234.5)]).toEqual(["—", "$0.00", "<$0.01", "$12.35", "$1,234.50"]);
  });
});

describe("renderUsage", () => {
  const s: UsageSummary = {
    since: Date.parse("2026-09-02T00:00:00Z"),
    until: Date.parse("2026-10-01T12:00:00Z"),
    tz: 0,
    by: "tool",
    totals: { ...zero, input: 1_500_000, output: 300_000, cacheRead: 30_000_000, cacheWrite: 900_000, cost: 42.5, partial: true, sessions: 12 },
    groups: [
      { key: "claude-code", counts: { ...zero, input: 1_000_000, output: 200_000, cacheRead: 30_000_000, cacheWrite: 900_000 }, cost: 42.5, partial: false, sessions: 9 },
      { key: "gemini", counts: { ...zero, input: 500_000, output: 50_000 }, cost: null, partial: false, sessions: 3 },
    ],
    prices: { asOf: "2026-10-01", unpriced: ["gemini-2.5-pro"] },
  };

  test("a header with the totals, one row per group, and the estimate caveat", () => {
    const out = renderUsage(s).replace(/\x1b\[[0-9;]*m/g, "");
    const lines = out.split("\n");
    expect(lines[0]).toBe("Last 30 days, by tool: 32.7M tokens in 12 sessions · $42.50* estimated");
    // Before noon too: the window touches 30 days, today included.
    expect(renderUsage({ ...s, until: Date.parse("2026-10-01T06:00:00Z") }).replace(/\x1b\[[0-9;]*m/g, "").split("\n")[0]!.startsWith("Last 30 days,")).toBe(true);
    expect(lines[2]).toMatch(/^Tool\s+Input\s+Output\s+Cache read\s+Cache write\s+Total\s+Cost \(est\.\)$/);
    expect(lines[3]).toMatch(/^claude-code\s+1M\s+200K\s+30M\s+900K\s+32\.1M\s+\$42\.50$/);
    expect(lines[4]).toMatch(/^gemini\s+500K\s+50K\s+0\s+0\s+550K\s+—$/);
    expect(out).toContain("Estimated at API list prices as of 2026-10-01; subscriptions don't bill per token.");
    expect(out).toContain("* No price for gemini-2.5-pro: left out of the cost, not guessed.");
    // Columns line up.
    expect(lines[3]!.length).toBe(lines[2]!.length);
  });

  test("nothing yet says how to turn it on", () => {
    const out = renderUsage({ ...s, groups: [], totals: { ...s.totals, cost: null, partial: false, sessions: 0 } });
    expect(out).toContain("0b usage on");
  });
});

describe("0b usage on|off", () => {
  let home: string;
  let ctx: Context;
  let env: Record<string, string>;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "0bridge-usage-"));
    ctx = { home, storeDir: join(home, ".0bridge") };
    env = { ...(process.env as Record<string, string>), ZEROBRIDGE_USER_HOME: home, ZEROBRIDGE_DIR: ctx.storeDir, ZEROBRIDGE_SECRET_STORE: "file", NO_COLOR: "1" };
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const run = (...args: string[]) => {
    const r = Bun.spawnSync([process.execPath, CLI, "usage", ...args], { env, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  };

  test("on with history off: counts only, history stays off; signed out it says to sign in", () => {
    const r = run("on");
    expect(r.code).toBe(0);
    expect(r.out).toContain("never conversation text");
    expect(r.out).toContain("0b login");
    const cfg = loadHistoryConfig(ctx);
    expect([cfg.enabled, cfg.usage, usageOnly(cfg)]).toEqual([false, true, true]);
  });

  test("off with history on: history keeps going, counts stop", () => {
    saveHistoryConfig(ctx, { ...loadHistoryConfig(ctx), enabled: true });
    const r = run("off");
    expect(r.code).toBe(0);
    expect(r.out).toContain("history keeps uploading conversations");
    const cfg = loadHistoryConfig(ctx);
    expect([cfg.enabled, usageWanted(cfg)]).toEqual([true, false]);
    expect(run("status").out).toContain("not uploading token counts");
  });

  test("bad flags are refused before any request", () => {
    expect(run("--days", "400").code).toBe(1);
    expect(run("--by", "user").out).toContain("--by is one of tool, model, repo, day, device");
    expect(run("sideways").code).toBe(1);
  });
});
