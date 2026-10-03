/**
 * `0b webhook` (src/webhook.ts) against a fake gateway (Bun.serve), with a temp home and the file
 * secret store: add (each route, and the action prompt on a terminal), run (the command saved here,
 * never sent), set, forward-secret, listen, list, rm, rotate, test (waiting for a run's result) and
 * events; a routine's bearer comes from the hidden prompt or stdin, never a flag.
 *   bun test apps/cli/test/webhook.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deviceTokenKey, openSecretStore, saveCloud, type Context } from "@0bridge/core";
import { shellLine, splitCommand, webhookCommand, type Endpoint, type StoredEvent, type WebhookIo } from "../src/webhook.ts";
import { loadRuns, runsPath } from "../src/webhook-run.ts";

process.env.ZEROBRIDGE_SECRET_STORE = "file";
process.env.NO_COLOR = "1";

type Req = { method: string; path: string; query: Record<string, string>; auth: string | null; body: unknown; raw: string };
let reqs: Req[] = [];
let endpoints: Endpoint[] = [];
let createStatus = 201;
/** What GET /triggers/events/:id answers, in turn (a run's result arriving). */
let polls: StoredEvent["route"][] = [];
let testRoute: StoredEvent["route"] = { kind: "agent", ok: true, detail: "started on devbox (claude, plan)", task: "t_00000001" };

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
  runners: [],
  ...extra,
});

const testEvent = (route: StoredEvent["route"]): StoredEvent => ({ id: "ev_t", seq: 2, endpoint: "support", eventId: "test_1", type: "Message.push", receivedAt: 0, verified: true, size: 10, data: {}, route });
/** The wire value for Store is still "queue". */
const stored = (r: Record<string, unknown> | undefined) => (r ? (r.kind === "store" ? { kind: "queue" } : r) : { kind: "queue" });

const server = Bun.serve({
  port: 0,
  async fetch(r) {
    const u = new URL(r.url);
    const raw = r.method === "GET" || r.method === "DELETE" ? "" : await r.text();
    const body = raw ? JSON.parse(raw) : undefined;
    reqs.push({ method: r.method, path: u.pathname, query: Object.fromEntries(u.searchParams), auth: r.headers.get("authorization"), body, raw });
    const path = u.pathname.replace(/^\/api/, "");
    if (path === "/triggers" && r.method === "GET") return Response.json(endpoints);
    if (path === "/triggers" && r.method === "POST") {
      const b = body as { name: string; preset: Endpoint["preset"]; route?: Record<string, unknown> };
      if (createStatus !== 201) return Response.json({ error: "Confirm it's you with your passkey first.", code: "STEP_UP_REQUIRED" }, { status: createStatus });
      const e = endpoint(b.name, { preset: b.preset, route: stored(b.route) as Endpoint["route"], verify: b.preset === "channeltalk" ? { mode: "query", param: "token" } : { mode: "standard" } });
      endpoints.push(e);
      const secret = b.preset === "channeltalk" ? "tok123" : "whsec_c2VjcmV0";
      return Response.json({ endpoint: e, secret, url: b.preset === "channeltalk" ? `${e.url}?token=${secret}` : e.url, ...(e.route.kind === "forward" ? { forwardSecret: "whsec_Zm9yd2FyZA==" } : {}) }, { status: 201 });
    }
    const ev = /^\/triggers\/events\/([^/]+)$/.exec(path);
    if (ev) return Response.json(testEvent(polls.shift() ?? { kind: "run", ok: null, detail: "sent to mbp" }));
    const m = /^\/triggers\/([^/]+)(?:\/(rotate|test|forward-secret))?$/.exec(path);
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
    if (m && r.method === "PATCH") {
      const e = endpoints.find((x) => x.id === m[1])!;
      const b = body as { route?: Record<string, unknown> };
      const was = e.route.kind;
      if (b.route) e.route = stored(b.route) as Endpoint["route"];
      return Response.json({ ...e, ...(e.route.kind === "forward" && was !== "forward" ? { forwardSecret: "whsec_bmV3" } : {}) });
    }
    if (m?.[2] === "rotate") return Response.json({ secret: "tok456", url: `http://gw/hook/${m[1]}?token=tok456` });
    if (m?.[2] === "forward-secret") return Response.json({ secret: "whsec_cm90YXRlZA==" });
    if (m?.[2] === "test") return Response.json(testEvent(testRoute));
    return Response.json({ error: "not found" }, { status: 404 });
  },
});

let ctx: Context;
let out: string[] = [];
const realLog = console.log;
const io = (bearer: string | null = null, o: { interactive?: boolean; picks?: string[]; texts?: string[]; confirms?: boolean[] } = {}) => {
  const asked: string[] = [];
  const x = {
    asked: 0,
    prompts: asked,
    interactive: o.interactive ?? false,
    async bearer() {
      x.asked++;
      return bearer;
    },
    async confirm(message: string) {
      asked.push(message);
      return o.confirms?.shift() ?? true;
    },
    async select(message: string, options: { value: string; label: string }[]) {
      asked.push(`${message} [${options.map((p) => p.value).join(",")}]`);
      return o.picks?.shift() ?? null;
    },
    async text(message: string) {
      asked.push(message);
      return o.texts?.shift() ?? null;
    },
    sleep: async () => {
      if (!polls.length) throw new Error("stop following");
    },
  };
  return x as WebhookIo & { asked: number; prompts: string[] };
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
  polls = [];
  testRoute = { kind: "agent", ok: true, detail: "started on devbox (claude, plan)", task: "t_00000001" };
  out = [];
  rmSync(runsPath(ctx), { force: true });
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
});
afterEach(() => {
  console.log = realLog;
});

describe("0b webhook", () => {
  test("add: the preset, the URL with its token once, and the setup steps; signed in with the device token; Store by default", async () => {
    await webhookCommand(ctx, ["add", "support"], { preset: "channeltalk" }, io());
    const post = reqs.find((r) => r.method === "POST")!;
    expect(post.auth).toBe("Bearer 0b_device_token");
    expect(post.body).toEqual({ name: "support", preset: "channeltalk" });
    const text = out.join("\n");
    expect(text).toContain("support: stored for agents to read");
    expect(text).toContain("URL:     http://gw/hook/wh_support?token=tok123");
    expect(text).not.toContain("Secret:");
    expect(text).toContain("Desk → Settings → Webhook");
    expect(text).toContain("message.created.userChat");
    // --route queue still works and means Store.
    await webhookCommand(ctx, ["add", "old"], { route: "queue" }, io());
    expect(reqs.at(-1)!.body).toEqual({ name: "old", preset: "generic" });
  });

  test("add on a terminal without --route asks what each event does; run asks for the command and keeps it here", async () => {
    const ask = io(null, { interactive: true, picks: ["run"], texts: [`python3 sync.py --label "new chat" '$(touch pwned)'`] });
    await webhookCommand(ctx, ["add", "support"], { preset: "channeltalk" }, ask);
    expect(ask.prompts[0]).toBe("What should each event do? [run,forward,agent,notify,store,routine]");
    expect(reqs.at(-1)!.body).toEqual({ name: "support", preset: "channeltalk", route: { kind: "run" } });
    const runs = loadRuns(ctx)!;
    expect(runs).toMatchObject({ v: 1, userId: "user1", server: `http://localhost:${server.port}` });
    expect(runs.runs.support).toMatchObject({ argv: ["python3", "sync.py", "--label", "new chat", "$(touch pwned)"], cwd: process.cwd(), timeoutSec: 300, debounceSec: 0 });
    expect(reqs.some((r) => r.raw.includes("sync.py"))).toBe(false);
    expect(out.join("\n")).toContain("Runs here: python3 sync.py --label 'new chat' '$(touch pwned)'");
    // Picking store sends no route.
    await webhookCommand(ctx, ["add", "quiet"], {}, io(null, { interactive: true, picks: ["store"] }));
    expect(reqs.at(-1)!.body).toEqual({ name: "quiet", preset: "generic" });
    // Off a terminal nothing is asked.
    const piped = io(null, { picks: ["run"] });
    await webhookCommand(ctx, ["add", "piped"], {}, piped);
    expect(piped.prompts).toEqual([]);
  });

  test("add --route run without a terminal: the command from after --, else how to set it on the machine", async () => {
    await webhookCommand(ctx, ["add", "ct"], { preset: "channeltalk", route: "run", command: ["./sync.sh", "a b"], debounce: "30" }, io());
    expect(reqs.at(-1)!.body).toEqual({ name: "ct", preset: "channeltalk", route: { kind: "run" } });
    expect(loadRuns(ctx)!.runs.ct).toMatchObject({ argv: ["./sync.sh", "a b"], debounceSec: 30 });
    out = [];
    await webhookCommand(ctx, ["add", "elsewhere"], { route: "run", machine: "devbox" }, io());
    expect(reqs.at(-1)!.body).toEqual({ name: "elsewhere", preset: "generic", route: { kind: "run", machine: "devbox" } });
    expect(out.join("\n")).toContain("0b webhook run elsewhere -- <command>");
    expect(loadRuns(ctx)!.runs.elsewhere).toBeUndefined();
  });

  test("add --route forward: the URL, and the forward secret shown once", async () => {
    await webhookCommand(ctx, ["add", "orders"], { route: "forward", url: "https://hooks.example.com/in" }, io());
    expect(reqs.at(-1)!.body).toEqual({ name: "orders", preset: "generic", route: { kind: "forward", url: "https://hooks.example.com/in" } });
    expect(out.join("\n")).toContain("orders: forwards to hooks.example.com");
    expect(out.join("\n")).toContain("Forward secret: whsec_Zm9yd2FyZA==");
    await expect(webhookCommand(ctx, ["add", "x"], { route: "forward" }, io())).rejects.toThrow("--url");
    await expect(webhookCommand(ctx, ["add", "x"], { route: "pipe" }, io())).rejects.toThrow("--route is run, forward, agent, notify, store, routine");
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

  test("run: the command as given after --, kept here; the route switched to run (Store without asking); --off forgets it", async () => {
    endpoints = [endpoint("support")];
    await webhookCommand(ctx, ["run", "support"], { command: ["python3", "sync.py", "; rm -rf ~", "$HOME"], timeout: "60", debounce: "30" }, io());
    expect(loadRuns(ctx)!.runs.support).toMatchObject({ argv: ["python3", "sync.py", "; rm -rf ~", "$HOME"], cwd: process.cwd(), timeoutSec: 60, debounceSec: 30 });
    const patch = reqs.find((r) => r.method === "PATCH")!;
    expect(patch.body).toEqual({ route: { kind: "run" } });
    // Never the command, its folder, or its settings on the wire.
    for (const r of reqs) for (const s of ["sync.py", "rm -rf", process.cwd()]) expect(r.raw).not.toContain(s);
    const text = out.join("\n");
    expect(text).toContain("support runs python3 sync.py '; rm -rf ~' '$HOME' on this machine for each event");
    expect(text).toContain("events within 30 s run once, with the newest");

    // Already run: nothing to patch. Without a command: what runs here.
    reqs = [];
    out = [];
    await webhookCommand(ctx, ["run", "support"], {}, io());
    expect(out.join("\n")).toContain("support runs here: python3 sync.py");
    await webhookCommand(ctx, ["run", "support"], { command: ["./other.sh"] }, io());
    expect(reqs.filter((r) => r.method === "PATCH")).toHaveLength(0);

    await expect(webhookCommand(ctx, ["run", "support"], { command: ["x"], timeout: "0" }, io())).rejects.toThrow("--timeout is 1 to 3600 seconds");
    await expect(webhookCommand(ctx, ["run", "support"], { command: ["x"], debounce: "3601" }, io())).rejects.toThrow("--debounce is 0 to 3600 seconds");
    await expect(webhookCommand(ctx, ["run", "nope"], { command: ["x"] }, io())).rejects.toThrow("no webhook named nope");

    out = [];
    await webhookCommand(ctx, ["run", "support"], { off: true }, io());
    expect(loadRuns(ctx)!.runs).toEqual({});
    expect(out.join("\n")).toContain("no longer runs a command on this machine");
  });

  test("run on a webhook that does something else asks first (--yes doesn't); --machine pins it; on a terminal it offers a test and waits for the result", async () => {
    endpoints = [endpoint("support", { route: { kind: "agent", repo: "acme/web", mode: "plan", template: "x", cooldownSec: 300 } })];
    const no = io(null, { confirms: [false] });
    await webhookCommand(ctx, ["run", "support"], { command: ["true"] }, no);
    expect(no.prompts[0]).toContain("starts an agent in acme/web");
    expect(reqs.filter((r) => r.method === "PATCH")).toHaveLength(0);
    expect(out.join("\n")).toContain("still starts an agent");

    await webhookCommand(ctx, ["run", "support"], { command: ["true"], machine: "mbp", yes: true }, io());
    expect(reqs.find((r) => r.method === "PATCH")!.body).toEqual({ route: { kind: "run", machine: "mbp" } });

    // A terminal: send a test event, then wait for the machine's result.
    out = [];
    testRoute = { kind: "run", ok: null, detail: "sent to mbp" };
    polls = [
      { kind: "run", ok: null, detail: "running on mbp" },
      { kind: "run", ok: true, exit: 0, ms: 2100, machine: "mbp", detail: "exit 0 on mbp, 2.1 s" },
    ];
    const tty = io(null, { interactive: true, confirms: [true] });
    await webhookCommand(ctx, ["run", "support"], { command: ["true"], machine: "mbp" }, tty);
    expect(tty.prompts).toEqual(["Send a test event now?"]);
    expect(out.join("\n")).toContain("✓ route run: exit 0 on mbp, 2.1 s");
  });

  test("set: a new route (forward shows its secret once); forward-secret makes a new one; store is sent as store", async () => {
    endpoints = [endpoint("orders")];
    await webhookCommand(ctx, ["set", "orders"], { route: "forward", url: "https://hooks.example.com/in" }, io());
    expect(reqs.at(-1)!.body).toEqual({ route: { kind: "forward", url: "https://hooks.example.com/in" } });
    expect(out.join("\n")).toContain("Forward secret: whsec_bmV3");
    out = [];
    await webhookCommand(ctx, ["forward-secret", "orders"], {}, io());
    expect(reqs.at(-1)!.path).toBe(`/api/triggers/${endpoints[0]!.id}/forward-secret`);
    expect(out.join("\n")).toContain("Forward secret: whsec_cm90YXRlZA==");
    await webhookCommand(ctx, ["set", "orders"], { route: "store" }, io());
    expect(reqs.at(-1)!.body).toEqual({ route: { kind: "store" } });
    out = [];
    await webhookCommand(ctx, ["set", "orders"], { route: "run" }, io());
    expect(out.join("\n")).toContain("0b webhook run orders -- <command>");
    await expect(webhookCommand(ctx, ["set", "orders"], {}, io())).rejects.toThrow("--route");
  });

  test("list: what runs here and which machines have a command", async () => {
    endpoints = [
      endpoint("support", { route: { kind: "run" }, runners: [{ machine: "devbox", online: true, lastSeen: Date.now() }] }),
      endpoint("bare", { route: { kind: "run" } }),
    ];
    await webhookCommand(ctx, ["run", "support"], { command: ["python3", "sync.py"] }, io());
    out = [];
    await webhookCommand(ctx, ["list"], {}, io());
    const text = out.join("\n");
    expect(text).toContain("support  Channel Talk  runs a command on your machine");
    expect(text).toContain("runs here: python3 sync.py");
    expect(text).toContain("machines with a command: devbox (online)");
    expect(text).toContain("no machine has a command for it yet: 0b webhook run bare -- <command>");
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
    expect(out.join("\n")).toContain("store stored");
    expect(reqs.find((r) => r.path === "/api/triggers/events")!.query).toEqual({ limit: "50", endpoint: "support" });

    await expect(webhookCommand(ctx, ["rm", "nope"], {}, io())).rejects.toThrow("no webhook named nope");
    const id = endpoints[0]!.id;
    await webhookCommand(ctx, ["rm", "support"], { yes: true }, io());
    expect(reqs.at(-1)).toMatchObject({ method: "DELETE", path: `/api/triggers/${id}` });
    expect(endpoints).toHaveLength(0);
  });

  test("test on a run route waits for the machine's result", async () => {
    endpoints = [endpoint("support", { route: { kind: "run" } })];
    testRoute = { kind: "run", ok: null, detail: "sent to mbp" };
    polls = [{ kind: "run", ok: false, exit: 1, ms: 40, machine: "mbp", detail: "exit 1 on mbp, 40 ms" }];
    await webhookCommand(ctx, ["test", "support"], {}, io());
    expect(out.join("\n")).toContain("✗ route run: exit 1 on mbp, 40 ms");
    expect(reqs.some((r) => r.path === "/api/triggers/events/ev_t")).toBe(true);
  });
});

describe("commands as typed", () => {
  test("split like a shell, without expanding anything", () => {
    expect(splitCommand("python3 sync.py")).toEqual(["python3", "sync.py"]);
    expect(splitCommand(`  a  'b c'  "d \\"e\\""  f\\ g ''  `, "linux")).toEqual(["a", "b c", 'd "e"', "f g", ""]);
    expect(splitCommand("echo $(whoami) `id` ; ls | wc", "linux")).toEqual(["echo", "$(whoami)", "`id`", ";", "ls", "|", "wc"]);
    expect(splitCommand(String.raw`C:\tools\sync.exe --dir C:\data`, "win32")).toEqual([String.raw`C:\tools\sync.exe`, "--dir", String.raw`C:\data`]);
    expect(() => splitCommand("echo 'oops")).toThrow("unclosed");
    expect(shellLine(["python3", "sync.py", "a b", "it's"])).toBe(`python3 sync.py 'a b' 'it'\\''s'`);
  });
});
