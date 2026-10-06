import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deviceTokenKey, openSecretStore, saveCloud, type Context } from "@0bridge/core";
import { parseSwitches, renderSettings, type AccountSettings } from "../src/settings.ts";

/** `0b settings` and `0b settings off <name>` against a stand-in gateway: what it prints and what it sends. */

const CLI = join(import.meta.dir, "..", "src", "index.ts");
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const ON: AccountSettings = { chatHistory: true, memory: true, profileInInstructions: true, agentControl: true, chatEvents: true, chatToolSearch: false };

describe("renderSettings and parseSwitches", () => {
  test("each switch with its state, and how to turn one off or on", () => {
    const out = plain(renderSettings({ ...ON, chatEvents: false }, "https://0bridge.test/"));
    expect(out).toMatch(/agent-control\s+on\s+AI apps start and steer coding agents/);
    expect(out).toMatch(/chat-events\s+off\s+Chat apps read your webhooks' events/);
    expect(out).toMatch(/chat-history\s+on\s+Chat apps search and resume/);
    expect(out).toContain("0b settings off <name>");
    expect(out).toContain("https://0bridge.test/app/settings/apps");
  });

  test("names: the three switches and chat-tool-search only, any case, each once", () => {
    expect(parseSwitches(["chat-history", "Agent-Control", "chat-history"])).toEqual(["chatHistory", "agentControl"]);
    expect(parseSwitches(["chat-tool-search", "Chat-Tool-Search"])).toEqual(["chatToolSearch"]);
    expect(parseSwitches([])).toContain("name one");
    expect(parseSwitches(["memory"])).toContain('unknown setting "memory"');
    expect(parseSwitches(["chatHistory"])).toContain("unknown setting");
    expect(parseSwitches(["chatToolSearch"])).toContain("unknown setting");
  });

  test("chat-tool-search is shown, off when a gateway older than it doesn't send it", () => {
    expect(plain(renderSettings({ ...ON, chatToolSearch: true }, "https://0bridge.test"))).toMatch(/chat-tool-search\s+on\s+Chat apps get a fixed tool list/);
    const { chatToolSearch: _, ...older } = ON;
    const out = plain(renderSettings(older, "https://0bridge.test"));
    expect(out).toMatch(/chat-tool-search\s+off/);
    expect(out).toContain("0b settings on|off chat-tool-search");
  });
});

describe("0b settings against the gateway", () => {
  let home: string;
  let env: Record<string, string>;
  let current: AccountSettings;
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "PATCH" ? await req.text() : "";
      seen.push(`${req.method} ${url.pathname} ${body}`.trim());
      if (url.pathname !== "/api/settings") return Response.json({ error: "not found" }, { status: 404 });
      if (req.method === "PATCH") {
        const b = JSON.parse(body) as Partial<AccountSettings>;
        // As the gateway: turning a guarded switch on needs the dashboard; chat-tool-search doesn't.
        if (Object.entries(b).some(([k, v]) => v === true && k !== "chatToolSearch")) return Response.json({ error: "turn this on from the dashboard", code: "STEP_UP" }, { status: 403 });
        current = { ...current, ...b };
      }
      return Response.json(current);
    },
  });

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "0b-settings-"));
    const ctx: Context = { home, storeDir: join(home, ".0bridge") };
    env = { ...(process.env as Record<string, string>), ZEROBRIDGE_USER_HOME: home, ZEROBRIDGE_DIR: ctx.storeDir, ZEROBRIDGE_SECRET_STORE: "file", NO_COLOR: "1", BROWSER: "none" };
    process.env.ZEROBRIDGE_SECRET_STORE = "file";
    const account = saveCloud(ctx, { server: `http://localhost:${server.port}`, userId: "u1", login: "me", tokenId: "t1" });
    openSecretStore(ctx.storeDir).set(deviceTokenKey(account), "0b_test");
  });
  afterAll(() => {
    server.stop(true);
    rmSync(home, { recursive: true, force: true });
  });

  const run = async (...args: string[]) => {
    const p = Bun.spawn([process.execPath, CLI, "settings", ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, out: plain(out + err) };
  };

  test("shows the account's switches", async () => {
    current = { ...ON };
    seen.length = 0;
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/chat-history\s+on/);
    expect(seen).toEqual(["GET /api/settings"]);
  }, 30_000);

  test("off sends only that switch as false and says it's off", async () => {
    current = { ...ON };
    seen.length = 0;
    const r = await run("off", "chat-history", "chat-events");
    expect(r.code).toBe(0);
    expect(r.out).toContain("chat-history is off");
    expect(r.out).toContain("chat-events is off");
    expect(seen).toEqual(['PATCH /api/settings {"chatHistory":false,"chatEvents":false}']);
    expect(current).toEqual({ ...ON, chatHistory: false, chatEvents: false });
  }, 30_000);

  test("on sends nothing and points at the dashboard; unknown names are refused before any request", async () => {
    seen.length = 0;
    const on = await run("on", "agent-control");
    expect(on.code).toBe(0);
    expect(on.out).toContain(`http://localhost:${server.port}/app/settings/apps`);
    expect(on.out).toContain("passkey");
    const bad = await run("off", "memory");
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('unknown setting "memory"');
    expect((await run("off")).code).toBe(1);
    expect((await run("sideways")).code).toBe(1);
    expect(seen).toEqual([]);
  }, 30_000);

  test("chat-tool-search turns on and off from here, and says to refresh the app once", async () => {
    current = { ...ON, chatToolSearch: false };
    seen.length = 0;
    const on = await run("on", "chat-tool-search");
    expect(on.code).toBe(0);
    expect(on.out).toContain("chat-tool-search is on");
    expect(on.out).toContain("Refresh 0bridge in the chat app once");
    expect(current.chatToolSearch).toBe(true);
    const off = await run("off", "chat-tool-search");
    expect(off.code).toBe(0);
    expect(off.out).toContain("chat-tool-search is off");
    expect(current.chatToolSearch).toBe(false);
    expect(seen).toEqual(['PATCH /api/settings {"chatToolSearch":true}', 'PATCH /api/settings {"chatToolSearch":false}']);
  }, 30_000);

  test("on with a guarded switch and chat-tool-search: only chat-tool-search is sent, the other points at the dashboard", async () => {
    current = { ...ON, chatToolSearch: false };
    seen.length = 0;
    const r = await run("on", "agent-control", "chat-tool-search");
    expect(r.code).toBe(0);
    expect(r.out).toContain("chat-tool-search is on");
    expect(r.out).toContain("Turning agent-control on asks for your passkey");
    expect(seen).toEqual(['PATCH /api/settings {"chatToolSearch":true}']);
  }, 30_000);
});
