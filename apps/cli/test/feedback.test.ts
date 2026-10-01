import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@0bridge/core";
import { buildReport, collectLogs, fromEditor, logFiles, tail } from "../src/feedback.ts";

/** `0b feedback`: what --include-logs reads and masks, the editor's text, and the report it sends. The send itself is in apps/gateway/test/feedback.ts. */

const CLI = join(import.meta.dir, "..", "src", "index.ts");
let home: string;
let ctx: Context;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "0b-feedback-"));
  ctx = { home, storeDir: join(home, ".0bridge") } as Context;
  mkdirSync(join(ctx.storeDir, "sync"), { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("--include-logs", () => {
  test("the last lines of each of 0b's logs, vault values and key-shaped text masked, the home folder as ~", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
    writeFileSync(join(ctx.storeDir, "background.log"), `${lines.join("\n")}\nsync with STRIPE_SECRET_KEY=sk_live_abcdefghijklmnop1234 in ${home}/code/acme\nvalue my-vault-value-123 leaked\n\n`);
    writeFileSync(join(ctx.storeDir, "sync", "worker.log"), "token 0b_AbCdEfGhIjKlMnOpQrStUvWxYz012345 refused\n");
    writeFileSync(join(ctx.storeDir, "clip.log"), "\n\n");
    const out = collectLogs(ctx, ["my-vault-value-123"], 5);
    expect(out).toBe(
      [
        "== ~/.0bridge/background.log ==",
        "line 57",
        "line 58",
        "line 59",
        "sync with STRIPE_SECRET_KEY=[secret] in ~/code/acme",
        "value [secret] leaked",
        "",
        "== ~/.0bridge/sync/worker.log ==",
        "token [secret] refused",
      ].join("\n"),
    );
    expect(logFiles(ctx).map((p) => p.slice(home.length))).toEqual([
      "/.0bridge/background.log",
      "/.0bridge/agent.log",
      "/.0bridge/clip.log",
      "/.0bridge/clipsync.log",
      "/.0bridge/sync/worker.log",
      "/.0bridge/status/worker.log",
    ]);
  });

  test("no logs: nothing; a big log is read from its end only, and the whole is capped keeping the newest", () => {
    expect(collectLogs(ctx, [])).toBe("");
    const big = Array.from({ length: 20_000 }, (_, i) => `entry ${i} ${"x".repeat(40)}`).join("\n");
    writeFileSync(join(ctx.storeDir, "agent.log"), big);
    expect(tail(join(ctx.storeDir, "agent.log"), 2)).toBe(`entry 19998 ${"x".repeat(40)}\nentry 19999 ${"x".repeat(40)}`);
    const all = collectLogs(ctx, [], 1000);
    expect(all.length).toBeLessThanOrEqual(20_000);
    expect(all.endsWith(`entry 19999 ${"x".repeat(40)}`)).toBe(true);
    expect(all.split("\n")[0]).toMatch(/^entry \d+ x+$/); // cut at a line
  });
});

test("the editor's text without the # lines", () => {
  expect(fromEditor("\n0b sync hangs\n\nafter update\n# Write your feedback above.\n# Kind: problem\n")).toBe("0b sync hangs\n\nafter update");
  expect(fromEditor("\n# only the template\n")).toBe("");
});

test("the report: kind, message, the CLI's version and this machine's OS, logs when added", () => {
  const r = buildReport("idea", "msg", "0.2.19");
  expect(r).toMatchObject({ kind: "idea", message: "msg", versions: { cli: "0.2.19" } });
  expect(r.versions.os).toContain(process.platform);
  expect("logs" in r).toBe(false);
  expect(buildReport("problem", "m", "dev", "l1\nl2")).toMatchObject({ logs: "l1\nl2" });
});

test("not signed in, or a kind it doesn't know: says so and sends nothing", () => {
  const env = { ...process.env, ZEROBRIDGE_USER_HOME: home, ZEROBRIDGE_DIR: ctx.storeDir, ZEROBRIDGE_SECRET_STORE: "file", NO_COLOR: "1" };
  const run = (args: string[]) => Bun.spawnSync(["bun", CLI, ...args], { env, stdin: "ignore" });
  const out = run(["feedback", "it broke"]);
  expect(out.exitCode).toBe(1);
  expect(out.stderr.toString()).toContain("Not signed in");
  const kind = run(["feedback", "--kind", "bug", "it broke"]);
  expect(kind.exitCode).toBe(1);
  expect(kind.stderr.toString()).toContain("--kind is one of problem, idea, other");
});
