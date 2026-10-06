import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deviceTokenKey, openSecretStore, saveCloud, type Context } from "@0bridge/core";
import { cliWords, HostUsage, parseHost, renderHost } from "../src/host.ts";

/**
 * `0b host`: the command lines it takes, the tool call each makes (by name on /mcp, MCP
 * 2026-07-28 envelope and headers), what it prints and how it exits, against a stand-in gateway.
 * The gateway's side (who may call, ledger machines only for an agent computer):
 * apps/gateway/test/host-tools.test.ts and host-relay.test.ts.
 */

const CLI = join(import.meta.dir, "..", "src", "index.ts");
const noStdin = async () => {
  throw new Error("stdin read");
};
const parse = (...argv: string[]) => parseHost(argv, noStdin);

describe("parseHost", () => {
  test("each command's tool and arguments", async () => {
    expect(await parse("request", "Fix", "the login page", "--project", "0bridge", "--repo", "web", "--priority", "p1", "--machine", "dgithost")).toEqual({
      sub: "request",
      tool: "bridge__host_request",
      json: false,
      args: { request: "Fix the login page", project: "0bridge", repo: "web", priority: "P1", machine: "dgithost" },
    });
    expect(await parse("status")).toMatchObject({ tool: "bridge__host_status", args: {} });
    expect(await parse("status", "T-012", "--machine", "m1")).toMatchObject({ args: { task: "T-012", machine: "m1" } });
    expect(await parse("status", "hr_abcdefghjk")).toMatchObject({ args: { request: "hr_abcdefghjk" } });
    expect(await parse("followup", "hr_abcdefghjk", "mobile first")).toMatchObject({ tool: "bridge__host_followup", args: { task: "hr_abcdefghjk", text: "mobile first" } });
    expect(await parse("answer", "#45", "B please", "--choice", "B", "--json")).toEqual({ sub: "answer", tool: "bridge__host_answer", json: true, args: { question: "45", text: "B please", choice: "B" } });
    expect(await parse("questions")).toMatchObject({ tool: "bridge__host_questions", args: {} });
    expect(await parse("updates", "--cursor", "17", "--wait", "5", "--kinds", "question,completed")).toMatchObject({
      tool: "bridge__host_updates",
      args: { cursor: "17", wait: 5, kinds: ["question", "completed"] },
    });
    expect(await parse("updates")).toMatchObject({ args: {} });
  });

  test('"-" reads the text from stdin; -- keeps text that looks like a flag', async () => {
    expect(await parseHost(["request", "-"], async () => "  from a pipe\n")).toMatchObject({ args: { request: "from a pipe" } });
    expect(await parseHost(["answer", "45", "-"], async () => "yes")).toMatchObject({ args: { question: "45", text: "yes" } });
    expect(await parse("request", "--", "--not-a-flag")).toMatchObject({ args: { request: "--not-a-flag" } });
  });

  test("usage mistakes: what's wrong; no subcommand or --help: the usage", async () => {
    expect(await parse()).toBeNull();
    expect(await parse("request", "--help")).toBeNull();
    const bad = async (argv: string[], msg: string) => {
      const e = await parseHost(argv, async () => "").catch((x) => x);
      expect(e).toBeInstanceOf(HostUsage);
      expect((e as Error).message).toContain(msg);
    };
    await bad(["launch"], 'unknown command "0b host launch"');
    await bad(["request"], "pass the request");
    await bad(["request", "-"], "pass the request");
    await bad(["request", "x", "--choice", "A"], "doesn't take --choice");
    await bad(["followup", "T-1"], "pass the follow-up");
    await bad(["answer", "abc", "x"], "question id");
    await bad(["status", "T-1", "T-2"], "one id at most");
    await bad(["questions", "T-1"], "takes no arguments");
    await bad(["updates", "--wait", "60"], "--wait is 0 to 20");
    await bad(["updates", "--kinds", "question,typo"], "not typo");
    await bad(["request", "x", "--bogus"], "bogus");
  });
});

describe("renderHost", () => {
  const result = (text: string, structuredContent?: Record<string, unknown>, isError = false) => ({ content: [{ type: "text", text }], structuredContent, isError });
  test("request: its id first; updates: the cursor alone last; the tools' names as these commands", async () => {
    const req = (await parse("request", "x"))!;
    const out = renderHost(req, result("Received on dgithost as a dev_request, request hr_abcdefghjk. Follow it with bridge__host_status request=hr_abcdefghjk; more goes with bridge__host_followup task=hr_abcdefghjk.", { task: null, request: "hr_abcdefghjk" }));
    expect(out.error).toBe(false);
    expect(out.out.split("\n")[0]).toBe("hr_abcdefghjk");
    expect(out.out).toContain("Follow it with 0b host status hr_abcdefghjk; more goes with 0b host followup hr_abcdefghjk.");
    expect(renderHost(req, result("Requested as T-012", { task: "T-012", request: "hr_abcdefghjk" })).out.split("\n")[0]).toBe("T-012");
    const upd = renderHost((await parse("updates"))!, result("Nothing new from the host. cursor=42", { updates: [], cursor: "42", more: false }));
    expect(upd.out.split("\n").at(-1)).toBe("42");
    expect(cliWords("answer it with bridge__host_answer")).toBe("answer it with 0b host answer");
  });

  test("--json: ok, the text and the tool's data; an error is an error either way", async () => {
    const j = (await parse("status", "--json"))!;
    expect(JSON.parse(renderHost(j, result("T-012 running", { tasks: [] })).out)).toEqual({ ok: true, text: "T-012 running", data: { tasks: [] } });
    expect(renderHost(j, result("refused", undefined, true))).toMatchObject({ error: true });
    expect(renderHost((await parse("status"))!, result("refused", undefined, true))).toEqual({ out: "refused", error: true });
  });
});

describe("0b host against the gateway", () => {
  let home: string;
  let env: Record<string, string>;
  const seen: { headers: Headers; body: { method: string; params: { name: string; arguments: Record<string, unknown>; _meta: Record<string, unknown> } } }[] = [];
  /** What the stand-in answers each tool with. */
  const answers: Record<string, { status?: number; json: unknown; sse?: boolean }> = {
    bridge__host_request: { json: { result: { content: [{ type: "text", text: "Received on dgithost as a dev_request, request hr_abcdefghjk." }], structuredContent: { task: null, request: "hr_abcdefghjk", machine: "dgithost" } } }, sse: true },
    bridge__host_answer: {
      json: { result: { content: [{ type: "text", text: "An agent computer's token (0b setup --agent-vm) reaches only a machine whose supervisor is the work ledger." }], isError: true } },
    },
    bridge__host_updates: { json: { result: { content: [{ type: "text", text: "Nothing new from the host. cursor=9" }], structuredContent: { updates: [], cursor: "9", more: false } } } },
    bridge__host_status: { status: 401, json: { error: "invalid_token" } },
  };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/mcp" || req.method !== "POST") return Response.json({ error: "not found" }, { status: 404 });
      const body = (await req.json()) as (typeof seen)[number]["body"];
      seen.push({ headers: req.headers, body });
      const a = answers[body.params.name]!;
      const rpc = { jsonrpc: "2.0", id: 1, ...(a.json as object) };
      if (a.sse) return new Response(`event: message\ndata: ${JSON.stringify(rpc)}\n\n`, { headers: { "content-type": "text/event-stream" } });
      return Response.json(a.status ? a.json : rpc, { status: a.status ?? 200 });
    },
  });

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "0b-host-"));
    const ctx: Context = { home, storeDir: join(home, ".0bridge") };
    env = { ...(process.env as Record<string, string>), ZEROBRIDGE_USER_HOME: home, ZEROBRIDGE_DIR: ctx.storeDir, ZEROBRIDGE_SECRET_STORE: "file", NO_COLOR: "1", BROWSER: "none" };
    process.env.ZEROBRIDGE_SECRET_STORE = "file";
    const account = saveCloud(ctx, { server: `http://localhost:${server.port}`, userId: "u1", login: "me", tokenId: "t1" });
    openSecretStore(ctx.storeDir).set(deviceTokenKey(account), "0b_vmtoken");
  });
  afterAll(() => {
    server.stop(true);
    rmSync(home, { recursive: true, force: true });
  });

  const run = async (args: string[], stdin?: string) => {
    const p = Bun.spawn([process.execPath, CLI, "host", ...args], { env, cwd: home, stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, out, err };
  };

  test("request from stdin: one tools/call by name with the token, the 2026-07-28 envelope and headers; the id first", async () => {
    const r = await run(["request", "-", "--project", "0bridge"], "결제 페이지 고쳐줘\n");
    expect(r.code).toBe(0);
    expect(r.out.split("\n")[0]).toBe("hr_abcdefghjk");
    const s = seen.at(-1)!;
    expect(s.headers.get("authorization")).toBe("Bearer 0b_vmtoken");
    expect(s.headers.get("mcp-method")).toBe("tools/call");
    expect(s.headers.get("mcp-name")).toBe("bridge__host_request");
    expect(s.headers.get("mcp-protocol-version")).toBe("2026-07-28");
    expect(s.body.method).toBe("tools/call");
    expect(s.body.params.arguments).toEqual({ request: "결제 페이지 고쳐줘", project: "0bridge" });
    expect(s.body.params._meta).toMatchObject({ "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "0b host" } });
  });

  test("a tool's refusal: printed plainly on stderr, exit 1; --json still prints {ok: false}", async () => {
    const r = await run(["answer", "45", "B"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("reaches only a machine whose supervisor is the work ledger");
    expect(seen.at(-1)!.body.params.arguments).toEqual({ question: "45", text: "B" });
    const j = await run(["answer", "45", "B", "--json"]);
    expect(j.code).toBe(1);
    expect(JSON.parse(j.out)).toMatchObject({ ok: false, data: null });
  });

  test("--account works with 0b host (taken before the command runs): a signed-in account is used, another is refused before any call", async () => {
    const n = seen.length;
    const ok = await run(["updates", "--account", "me"]);
    expect(ok.code).toBe(0);
    expect(seen.length).toBe(n + 1);
    const ok2 = await run(["--account=me", "updates"]);
    expect(ok2.code).toBe(0);
    const other = await run(["updates", "--account", "someone@else.test"]);
    expect(other.code).toBe(1);
    expect(other.err).toContain("isn't signed in on this machine");
    expect(seen.length).toBe(n + 2);
  });

  test("updates: the cursor alone on the last line; a sign-in the gateway refuses: exit 1 with how to sign in; a usage mistake: exit 2", async () => {
    const u = await run(["updates", "--cursor", "3", "--wait", "1"]);
    expect(u.code).toBe(0);
    expect(u.out.trim().split("\n").at(-1)).toBe("9");
    expect(seen.at(-1)!.body.params.arguments).toEqual({ cursor: "3", wait: 1 });
    const s = await run(["status", "T-012"]);
    expect(s.code).toBe(1);
    expect(s.err).toContain("0b setup --agent-vm");
    const n = seen.length;
    const bad = await run(["answer", "x"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("0b host answer <question id");
    expect(seen.length).toBe(n);
  });
});
