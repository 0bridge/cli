import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyManifest, saveManifest, type Context, type McpServer } from "@0bridge/core";
import { directEntryChange } from "../src/cloud.ts";

/**
 * `0b connect vercel` (a DIRECT_ONLY service) writes the server into the manifest itself. A server
 * of the same name the user already has is theirs: kept unless --yes (#99).
 *   bun test apps/cli/test/connect-direct.test.ts
 */

const CLI = join(import.meta.dir, "..", "src", "index.ts");
const VERCEL = "https://mcp.vercel.com";

let home: string;
let ctx: Context;
let env: Record<string, string>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "0bridge-direct-"));
  ctx = { home, storeDir: join(home, ".0bridge") };
  env = { ...(process.env as Record<string, string>), ZEROBRIDGE_USER_HOME: home, ZEROBRIDGE_DIR: ctx.storeDir, ZEROBRIDGE_SECRET_STORE: "file", BROWSER: "none", NO_COLOR: "1" };
  mkdirSync(ctx.storeDir, { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const seed = (vercel?: McpServer) => {
  const m = emptyManifest();
  if (vercel) m.mcpServers.vercel = vercel;
  saveManifest(ctx, m);
};
const manifest = () => JSON.parse(readFileSync(join(ctx.storeDir, "0bridge.json"), "utf8")) as { mcpServers: Record<string, McpServer> };
const connect = (...extra: string[]) => {
  const r = Bun.spawnSync([process.execPath, CLI, "connect", "vercel", ...extra], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
};

describe("which change a direct server makes", () => {
  test("none yet → add; same URL over HTTP → same; another URL, transport or a command → conflict", () => {
    expect(directEntryChange(undefined, VERCEL)).toBe("add");
    expect(directEntryChange({ transport: "http", url: VERCEL }, VERCEL)).toBe("same");
    expect(directEntryChange({ transport: "http", url: "https://example.com/mcp" }, VERCEL)).toBe("conflict");
    expect(directEntryChange({ transport: "sse", url: VERCEL }, VERCEL)).toBe("conflict");
    expect(directEntryChange({ transport: "stdio", command: "npx", args: ["vercel-mcp"] }, VERCEL)).toBe("conflict");
  });
});

describe("0b connect vercel and the user's own entry", () => {
  test("another server named vercel is kept and the command says how to replace it", () => {
    const mine: McpServer = { transport: "stdio", command: "npx", args: ["my-vercel-mcp"], env: { TOKEN: "${secret:VERCEL}" } };
    seed(mine);
    const r = connect();
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("already have an MCP server named vercel");
    expect(r.out).toContain("--yes");
    expect(manifest().mcpServers.vercel).toEqual(mine);
  });

  test("--yes replaces it", () => {
    seed({ transport: "http", url: "https://example.com/mcp" });
    const r = connect("--yes");
    expect(r.code).toBe(0);
    expect(manifest().mcpServers.vercel).toEqual({ transport: "http", url: VERCEL });
  });

  test("the same URL already there changes nothing in the manifest", () => {
    const same: McpServer = { transport: "http", url: VERCEL, targets: ["claude"] };
    seed(same);
    const r = connect();
    expect(r.code).toBe(0);
    expect(manifest().mcpServers.vercel).toEqual(same);
  });

  test("none yet: added", () => {
    seed();
    const r = connect();
    expect(r.code).toBe(0);
    expect(manifest().mcpServers.vercel).toEqual({ transport: "http", url: VERCEL });
  });
});
