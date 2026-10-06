import { describe, expect, test } from "bun:test";
import { readinessOf, toolsText } from "../src/readiness.ts";

describe("readinessOf", () => {
  // The Slack connections the user turned every tool off on (2026-10-06): signed in, but nothing for agents.
  test.each([
    ["slack › dgit", 27],
    ["slack › neotax", 7],
    ["slack › blankthe", 7],
    ["slack › photoito", 7],
    ["slack › tmp-seoul", 7],
  ])("%s with 0 of %i tools on is tools off, not ready", (_, n) => {
    const r = readinessOf({ state: "ready", tools: n, toolsOn: 0, readOnly: false, off: Array.from({ length: n }, (_, i) => `t${i}`) });
    expect(r).toMatchObject({ kind: "off", label: "Tools off", tone: "neutral", offBy: "user", on: 0, total: n });
    expect(toolsText(r)).toBe(`all ${n} tools off`);
  });

  test("all on is ready, some on is in use N/M", () => {
    expect(readinessOf({ state: "ready", tools: 33, toolsOn: 33 })).toMatchObject({ kind: "usable", label: "Ready", tone: "ok" });
    const some = readinessOf({ state: "ready", tools: 12, toolsOn: 5 });
    expect(some).toMatchObject({ kind: "usable", label: "In use 5/12", tone: "ok" });
    expect(toolsText(some)).toBe("5 of 12 tools on");
  });

  test("an older server without toolsOn counts every tool as on", () => {
    expect(readinessOf({ state: "ready", tools: 3 })).toMatchObject({ kind: "usable", label: "Ready", on: 3 });
  });

  test("no tools offered, and still connecting, are neither ready nor off", () => {
    expect(readinessOf({ state: "ready", tools: 0, toolsOn: 0 })).toMatchObject({ kind: "no-tools", tone: "neutral" });
    for (const state of ["connecting", "connected", "discovering"]) expect(readinessOf({ state, tools: 0, toolsOn: 0 })).toMatchObject({ kind: "loading", label: "Connecting…" });
  });

  test("a sign-in problem shows as one even with every tool off", () => {
    expect(readinessOf({ state: "authenticating", tools: 7, toolsOn: 0 })).toMatchObject({ kind: "sign-in", tone: "warn" });
    expect(readinessOf({ state: "needs_key", tools: 0, toolsOn: 0 })).toMatchObject({ kind: "key", tone: "warn" });
    expect(readinessOf({ state: "failed", tools: 27, toolsOn: 0 })).toMatchObject({ kind: "failed", tone: "error" });
  });

  test("read-only with some tools turned off: both, and the hint names both ways back", () => {
    const r = readinessOf({ state: "ready", tools: 10, toolsOn: 0, readOnly: true, off: ["a", "b"] });
    expect(r).toMatchObject({ kind: "off", offBy: "both" });
    expect(toolsText(r)).toBe("none of 10 tools on (some off, the rest kept out by read-only)");
  });

  test("read-only that leaves no tool is off because of read-only", () => {
    const r = readinessOf({ state: "ready", tools: 4, toolsOn: 0, readOnly: true, off: [] });
    expect(r).toMatchObject({ kind: "off", offBy: "read-only" });
    expect(toolsText(r)).toBe("read-only leaves none of 4 tools");
  });
});
