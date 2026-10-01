import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCloud, loadHistoryConfig, type Context } from "@0bridge/core";
import { daysOf, defaultName, detectPlatform } from "../src/agent-vm.ts";

const CLI = join(import.meta.dir, "..", "src", "index.ts");
const CODE = "vm_0123456789abcdefghjk";

/** A stand-in gateway: the routes `0b setup --agent-vm` calls, and what it was asked. */
interface Fake {
  hits: string[];
  approved: boolean;
  attachUsed: boolean;
  devicePolls: number;
}
let fake: Fake;
let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const route = `${req.method} ${u.pathname}`;
      fake.hits.push(route);
      const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
      const auth = req.headers.get("authorization") ?? "";
      switch (route) {
        case "POST /agent-vm/attach":
          if (body.code !== CODE || fake.attachUsed) return Response.json({ error: "not found" }, { status: 404 });
          fake.attachUsed = true;
          return Response.json({ id: "t_vm1", token: "0b_vmtoken1", expiresAt: Date.now() + 7 * 86_400_000, name: body.name, server: base }, { status: 201 });
        case "POST /auth/device/code":
          return Response.json({ device_code: "dev-code", user_code: "ABCD2345", verification_uri: "/device", verification_uri_complete: "/device?user_code=ABCD2345", interval: 1 });
        case "POST /auth/device/token":
          fake.devicePolls++;
          return fake.approved ? Response.json({ access_token: "bootstrap-session" }) : Response.json({ error: "authorization_pending" }, { status: 400 });
        case "POST /api/agent-vm/tokens":
          if (auth !== "Bearer bootstrap-session") return Response.json({ error: "no" }, { status: 403 });
          return Response.json({ id: "t_vm2", token: "0b_vmtoken2", expiresAt: Date.now() + body.days * 86_400_000 }, { status: 201 });
        case "POST /auth/sign-out":
          return Response.json({ success: true });
        case "GET /api/me": {
          const id = auth === "Bearer 0b_vmtoken1" ? "t_vm1" : auth === "Bearer 0b_vmtoken2" ? "t_vm2" : null;
          if (!id) return Response.json({ error: "invalid_token" }, { status: 401 });
          return Response.json({ userId: "user1", login: "me@example.com", email: "me@example.com", tokenId: id, mcpUrl: `${base}/mcp` });
        }
        case "GET /api/context":
          return Response.json({ profile: null, instructions: { text: "# Always run the tests\n", hash: "h1", updatedAt: 1 }, skills: [], memory: { count: 0 } });
        case "GET /api/agent-vm":
          return Response.json({
            vms: [
              { tokenId: "t_vm1", name: "manus-box", platform: "manus", createdAt: 1, expiresAt: Date.now() + 7 * 86_400_000, lastUsedAt: null },
              { tokenId: "t_vm2", name: "muse-vm", platform: "muse", createdAt: 1, expiresAt: Date.now() + 3 * 86_400_000, lastUsedAt: null },
            ],
          });
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    },
  });
  base = `http://localhost:${server.port}`;
});
afterAll(() => server.stop(true));

let home: string;
let ctx: Context;
beforeEach(() => {
  fake = { hits: [], approved: false, attachUsed: false, devicePolls: 0 };
  home = mkdtempSync(join(tmpdir(), "0b-agent-vm-"));
  ctx = { home, storeDir: join(home, ".0bridge") };
  // The agents "installed" on this computer.
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** Run the CLI like an agent's shell does: stdin closed, no terminal, a temp home, nothing from this machine's config. */
async function run(args: string[], timeoutMs = 30_000) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    ZEROBRIDGE_USER_HOME: home,
    ZEROBRIDGE_DIR: ctx.storeDir,
    ZEROBRIDGE_SECRET_STORE: "file",
    ZEROBRIDGE_SERVER: base,
    NO_COLOR: "1",
  };
  const p = Bun.spawn([process.execPath, CLI, "setup", "--agent-vm", ...args], { env, cwd: home, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const code = await p.exited;
  clearTimeout(timer);
  return { code, out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text(), killed: p.signalCode !== null };
}

const pending = () => join(ctx.storeDir, "agent-vm", "pending.json");

describe("0b setup --agent-vm", () => {
  test("--attach: signs in with the code and sets up the account, both agents, history hooks; stdin closed never blocks", async () => {
    const r = await run(["--attach", CODE, "--platform", "manus", "--name", "manus-box"]);
    expect(r.killed).toBe(false);
    expect(r.code).toBe(0);
    expect(r.out).toContain("✓ Attached with the setup code. This computer is manus-box");
    expect(fake.hits).toContain("POST /agent-vm/attach");
    expect(fake.hits).not.toContain("POST /auth/device/code");
    // The account and its token.
    expect(loadCloud(ctx)?.tokenId).toBe("t_vm1");
    expect(readFileSync(join(ctx.storeDir, "secrets.json"), "utf8")).toContain("0b_vmtoken1");
    // The agents' config: the gateway entry, and the instructions pulled from 0bridge.
    expect(readFileSync(join(home, ".claude.json"), "utf8")).toContain(`${base}/mcp`);
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toContain(`${base}/mcp`);
    expect(readFileSync(join(ctx.storeDir, "AGENTS.md"), "utf8")).toContain("Always run the tests");
    // History on, by hooks only.
    expect(loadHistoryConfig(ctx).enabled).toBe(true);
    expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toContain("hook claude");
    expect(existsSync(join(home, ".config", "systemd"))).toBe(false);
    // The summary, the ToS line and how to sign the agents in.
    expect(r.out).toContain("manus-box is signed in as me@example.com until");
    expect(r.out).toContain("ANTHROPIC_API_KEY");
    expect(r.out).toContain("codex login --device-auth");
    expect(r.out).toContain("0b background on");
    expect(r.out).not.toMatch(/\x1b\[/); // plain lines for agents
    if (process.env.SHOW_OUTPUT) console.log(r.out, r.err);
  }, 60_000);

  test("a used code falls back to the link; --no-wait saves it, prints the link and exits 0; the next run picks it up", async () => {
    fake.attachUsed = true;
    const first = await run(["--attach", CODE, "--no-wait", "--platform", "muse", "--days", "3"]);
    expect(first.code).toBe(0);
    expect(first.out).toContain("! That setup code was already used or has expired");
    // The first address printed is the approval page, and the last line says what to do with it.
    const afterWarning = first.out.slice(first.out.indexOf("approve the link below"));
    expect(/https?:\/\/\S+/.exec(afterWarning.slice(afterWarning.indexOf("\n")))?.[0]).toStartWith(`${base}/device`);
    const last = first.out.trim().split("\n").at(-1)!;
    expect(last).toContain(`${base}/device?user_code=ABCD2345`);
    expect(last).toContain("run this same command again");
    const saved = JSON.parse(readFileSync(pending(), "utf8"));
    expect(saved).toMatchObject({ server: base, name: expect.stringMatching(/^muse-/), days: 3, platform: "muse", failedAttach: CODE });
    expect(loadCloud(ctx)).toBeNull();

    // Not approved yet: still pending, the same link, no new code and the used code isn't tried again.
    fake.hits = [];
    const second = await run(["--attach", CODE, "--no-wait", "--platform", "muse", "--days", "3"]);
    expect(second.code).toBe(0);
    expect(second.out).toContain("Not approved yet");
    expect(fake.hits).not.toContain("POST /auth/device/code");
    expect(fake.hits).not.toContain("POST /agent-vm/attach");

    // Approved: the same command finishes, with an agent-VM token for 3 days.
    fake.approved = true;
    const third = await run(["--attach", CODE, "--no-wait", "--platform", "muse", "--days", "3"]);
    expect(third.code).toBe(0);
    expect(fake.hits).toContain("POST /api/agent-vm/tokens");
    expect(fake.hits).toContain("POST /auth/sign-out");
    expect(loadCloud(ctx)?.tokenId).toBe("t_vm2");
    expect(existsSync(pending())).toBe(false);
    expect(third.out).toContain("its token expires");
    expect(third.out).toContain("muse-vm is signed in as me@example.com until");
    if (process.env.SHOW_OUTPUT) console.log(first.out, second.out, third.out);
  }, 90_000);

  test("--no-vault skips the vault request; without it the vault step runs", async () => {
    const without = await run(["--attach", CODE, "--no-vault"]);
    expect(without.code).toBe(0);
    expect(without.out).toContain("Vault: skipped (--no-vault)");
    expect(fake.hits.some((h) => h.includes("/vault"))).toBe(false);

    rmSync(ctx.storeDir, { recursive: true, force: true });
    fake.attachUsed = false;
    const withVault = await run(["--attach", CODE]);
    expect(withVault.code).toBe(0);
    expect(withVault.out).toMatch(/Vault/);
    expect(withVault.out).not.toContain("skipped (--no-vault)");
  }, 90_000);

  test("--days 40, an unknown platform and a bad name are refused before anything is written", async () => {
    for (const args of [["--days", "40"], ["--days", "0"], ["--platform", "windows95"], ["--name", "../etc"]]) {
      const r = await run(["--attach", CODE, ...args]);
      expect(r.code).toBe(1);
      expect(fake.hits).toEqual([]);
      expect(existsSync(ctx.storeDir)).toBe(false);
    }
  }, 60_000);

  test("already signed in: no new sign-in", async () => {
    expect((await run(["--attach", CODE, "--no-vault"])).code).toBe(0);
    fake.hits = [];
    const again = await run(["--attach", CODE, "--no-vault"]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("Already signed in as me@example.com");
    expect(fake.hits).not.toContain("POST /agent-vm/attach");
  }, 60_000);
});

describe("names, platforms and days", () => {
  test("the name is <platform>-<short hostname>; --platform wins, else other", () => {
    expect(defaultName("muse", "VM-1234.internal.example")).toBe("muse-vm-1234");
    expect(defaultName("other", "..")).toBe("other-vm");
    expect(detectPlatform(undefined)).toBe("other");
    expect(detectPlatform("Manus")).toBe("manus");
    expect(() => detectPlatform("nope")).toThrow("--platform is one of");
  });

  test("days: 7 by default, 1 to 30", () => {
    expect(daysOf(undefined)).toBe(7);
    expect(daysOf(30)).toBe(30);
    expect(() => daysOf(31)).toThrow("1 to 30");
    expect(() => daysOf(Number.NaN)).toThrow();
  });

  test("no prompts on this path: the module asks nothing on stdin", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "agent-vm.ts"), "utf8");
    expect(src).not.toMatch(/\bp\.(text|confirm|select|multiselect|password)\b|createInterface|@clack\/prompts/);
  });
});
