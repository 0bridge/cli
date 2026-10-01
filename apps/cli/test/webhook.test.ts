/**
 * `0b webhook` (src/webhook.ts) against a fake gateway (Bun.serve), with a temp home and the file
 * secret store: add (each route), list, rm, rotate, test and events; a routine's bearer comes from
 * the hidden prompt or stdin, never a flag.
 *   bun test apps/cli/test/webhook.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deviceTokenKey, openSecretStore, saveCloud, type Context } from "@0bridge/core";
import { webhookCommand, type Endpoint, type WebhookIo } from "../src/webhook.ts";

process.env.ZEROBRIDGE_SECRET_STORE = "file";
process.env.NO_COLOR = "1";

type Req = { method: string; path: string; query: Record<string, string>; auth: string | null; body: unknown };
let reqs: Req[] = [];
let endpoints: Endpoint[] = [];
let createStatus = 201;

const endpoint = (name: string, extra: Partial<Endpoint> = {}): Endpoint => ({
  id: `wh_${name.padEnd(20, "0").slice(0, 20)}`,
  name,
  preset: "channeltalk",
  verify: { mode: "query", param: "token" },
  route: { kind: "queue" },
  notify: false,
  types: null,
  retentionDays: 7,
  enabled: true,
  url: `http://gw/hook/wh_${name}`,
  createdAt: 0,
  updatedAt: 0,
  lastEventAt: null,
  counts: { today: 0, total: 0 },
  lastError: null,
  ...extra,
});

const server = Bun.serve({
  port: 0,
  async fetch(r) {
    const u = new URL(r.url);
    const body = r.method === "GET" || r.method === "DELETE" ? undefined : await r.json().catch(() => undefined);
    reqs.push({ method: r.method, path: u.pathname, query: Object.fromEntries(u.searchParams), auth: r.headers.get("authorization"), body });
    const path = u.pathname.replace(/^\/api/, "");
    if (path === "/triggers" && r.method === "GET") return Response.json(endpoints);
    if (path === "/triggers" && r.method === "POST") {
      const b = body as { name: string; preset: Endpoint["preset"]; route?: Endpoint["route"] };
      if (createStatus !== 201) return Response.json({ error: "Confirm it's you with your passkey first.", code: "STEP_UP_REQUIRED" }, { status: createStatus });
      const e = endpoint(b.name, { preset: b.preset, route: b.route ?? { kind: "queue" }, verify: b.preset === "channeltalk" ? { mode: "query", param: "token" } : { mode: "standard" } });
      endpoints.push(e);
      const secret = b.preset === "channeltalk" ? "tok123" : "whsec_c2VjcmV0";
      return Response.json({ endpoint: e, secret, url: b.preset === "channeltalk" ? `${e.url}?token=${secret}` : e.url }, { status: 201 });
    }
    const m = /^\/triggers\/([^/]+)(?:\/(rotate|test))?$/.exec(path);
    if (path === "/triggers/events")
      return Response.json({
        events: u.searchParams.get("cursor") ? [] : [{ id: "ev_1", seq: 1, endpoint: "support", eventId: "m-1", type: "Message.push", receivedAt: 0, verified: true, size: 10, data: { hi: 1 }, route: { kind: "queue", ok: true, detail: "stored" } }],
        cursor: "c1",
        hasMore: false,
      });
    if (m && r.method === "DELETE") {
      endpoints = endpoints.filter((e) => e.id !== m[1]);
      return new Response(null, { status: 204 });
    }
    if (m?.[2] === "rotate") return Response.json({ secret: "tok456", url: `http://gw/hook/${m[1]}?token=tok456` });
    if (m?.[2] === "test") return Response.json({ id: "ev_t", seq: 2, endpoint: "support", eventId: "test_1", type: "Message.push", receivedAt: 0, verified: true, size: 10, data: {}, route: { kind: "agent", ok: true, detail: "started on devbox (claude, plan)", task: "t_00000001" } });
    return Response.json({ error: "not found" }, { status: 404 });
  },
});

let ctx: Context;
let out: string[] = [];
const realLog = console.log;
const io = (bearer: string | null = null): WebhookIo & { asked: number } => {
  const o = {
    asked: 0,
    async bearer() {
      o.asked++;
      return bearer;
    },
    confirm: async () => true,
    sleep: async () => {
      throw new Error("stop following");
    },
  };
  return o;
};

beforeAll(() => {
  const home = mkdtempSync(join(tmpdir(), "0b-webhook-"));
  ctx = { home, storeDir: join(home, ".0bridge") };
  const acct = saveCloud(ctx, { server: `http://localhost:${server.port}`, userId: "user1", login: "me", email: "me@example.com", tokenId: "t1" });
  openSecretStore(ctx.storeDir).set(deviceTokenKey(acct), "0b_device_token");
});
afterAll(() => server.stop(true));
beforeEach(() => {
  reqs = [];
  endpoints = [];
  createStatus = 201;
  out = [];
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
});
afterEach(() => {
  console.log = realLog;
});

describe("0b webhook", () => {
  test("add: the preset, the URL with its token once, and the setup steps; signed in with the device token", async () => {
    await webhookCommand(ctx, ["add", "support"], { preset: "channeltalk" }, io());
    const post = reqs.find((r) => r.method === "POST")!;
    expect(post.auth).toBe("Bearer 0b_device_token");
    expect(post.body).toEqual({ name: "support", preset: "channeltalk" });
    const text = out.join("\n");
    expect(text).toContain("URL:     http://gw/hook/wh_support?token=tok123");
    expect(text).not.toContain("Secret:");
    expect(text).toContain("Desk → Settings → Webhook");
    expect(text).toContain("message.created.userChat");
  });

  test("add --route agent: plan by default; edit refused for anything but plan|edit; step-up points at the dashboard", async () => {
    await webhookCommand(ctx, ["add", "support"], { preset: "channeltalk", route: "agent", repo: "acme/web", agent: "claude", notify: true }, io());
    expect(reqs.at(-1)!.body).toEqual({ name: "support", preset: "channeltalk", route: { kind: "agent", repo: "acme/web", mode: "plan", agent: "claude" }, notify: true });
    expect(out.join("\n")).toContain("agents start in plan mode");
    await expect(webhookCommand(ctx, ["add", "x"], { route: "agent", repo: "r", mode: "auto" }, io())).rejects.toThrow("never start agents in auto mode");
    await expect(webhookCommand(ctx, ["add", "x"], { route: "agent" }, io())).rejects.toThrow("--repo");
    createStatus = 403;
    await expect(webhookCommand(ctx, ["add", "x"], { route: "agent", repo: "r", mode: "edit" }, io())).rejects.toThrow("/app/triggers");
  });

  test("add --route routine: the bearer comes from the prompt or stdin, never a flag", async () => {
    const asked = io("sk-ant-oat01-secret");
    const tpl = join(ctx.home, "tpl.txt");
    writeFileSync(tpl, "CI failed: {{type}}");
    await webhookCommand(ctx, ["add", "ci"], { route: "routine", routineUrl: "https://api.anthropic.com/v1/claude_code/routines/trig_1/fire", template: tpl }, asked);
    expect(asked.asked).toBe(1);
    expect(reqs.at(-1)!.body).toEqual({
      name: "ci",
      preset: "generic",
      route: { kind: "routine", url: "https://api.anthropic.com/v1/claude_code/routines/trig_1/fire", template: "CI failed: {{type}}" },
      routineToken: "sk-ant-oat01-secret",
    });
    expect(out.join("\n")).toContain("Secret:  whsec_c2VjcmV0");
    expect(out.join("\n")).not.toContain("sk-ant-oat01");
    // A token passed as an option is ignored: only the prompt or stdin supply it.
    const none = io(null);
    await expect(webhookCommand(ctx, ["add", "ci2"], { route: "routine", routineUrl: "https://x.example/fire", routineToken: "flag-token" } as never, none)).rejects.toThrow("never a flag");
    expect(reqs.some((r) => JSON.stringify(r.body ?? "").includes("flag-token"))).toBe(false);
    await expect(webhookCommand(ctx, ["add", "ci3"], { route: "routine" }, io("x"))).rejects.toThrow("--routine-url");
  });

  test("the CLI has no flag for the bearer at all", () => {
    const r = Bun.spawnSync(["bun", join(import.meta.dir, "../src/index.ts"), "webhook", "add", "ci", "--route", "routine", "--routine-token", "abc"], {
      env: { ...process.env, ZEROBRIDGE_USER_HOME: ctx.home, ZEROBRIDGE_DIR: ctx.storeDir, ZEROBRIDGE_SECRET_STORE: "file" },
      stdin: "ignore",
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString() + r.stdout.toString()).toContain("routine-token");
    expect(reqs).toHaveLength(0);
  });

  test("list, rotate, test, events, rm", async () => {
    endpoints = [endpoint("support", { route: { kind: "agent", repo: "acme/web", mode: "plan", template: "x", cooldownSec: 300 }, lastError: "2026-10-01T12:00Z agent control is off" })];
    await webhookCommand(ctx, ["list"], {}, io());
    expect(out.join("\n")).toContain("support  Channel Talk  starts an agent in acme/web (plan, 5 min cooldown)");
    expect(out.join("\n")).toContain("agent control is off");
    out = [];
    await webhookCommand(ctx, [], { json: true }, io());
    expect(JSON.parse(out.join("\n"))).toHaveLength(1);

    out = [];
    await webhookCommand(ctx, ["rotate", "support"], {}, io());
    expect(reqs.at(-1)!.path).toBe(`/api/triggers/${endpoints[0]!.id}/rotate`);
    expect(out.join("\n")).toContain("?token=tok456");

    out = [];
    await webhookCommand(ctx, ["test", "support"], {}, io());
    expect(out.join("\n")).toContain("route agent: started on devbox (claude, plan) · task t_00000001");

    out = [];
    await expect(webhookCommand(ctx, ["events", "support"], { follow: true }, io())).rejects.toThrow("stop following");
    expect(out.join("\n")).toContain("Message.push");
    expect(reqs.find((r) => r.path === "/api/triggers/events")!.query).toEqual({ limit: "50", endpoint: "support" });

    await expect(webhookCommand(ctx, ["rm", "nope"], {}, io())).rejects.toThrow("no webhook named nope");
    const id = endpoints[0]!.id;
    await webhookCommand(ctx, ["rm", "support"], { yes: true }, io());
    expect(reqs.at(-1)).toMatchObject({ method: "DELETE", path: `/api/triggers/${id}` });
    expect(endpoints).toHaveLength(0);
  });
});
