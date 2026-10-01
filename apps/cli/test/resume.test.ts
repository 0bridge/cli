import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deviceTokenKey, openSecretStore, saveCloud, sealValue, vaultKeyName, type Context } from "@0bridge/core";
import { agentOf, findCommand, inAgent, launch, pickRecent, renderPrompt, resumeCommand, type Handoff } from "../src/resume.ts";

process.env.ZEROBRIDGE_SECRET_STORE = "file";

const handoff = (over: Partial<Handoff> = {}): Handoff => ({
  id: "claude-code:11111111-2222-3333-4444-555555555555",
  ref: "0b:k3f9x2",
  tool: "claude-code",
  title: "Fix duplicate payment webhook",
  repo: "acme/web",
  branch: "fix/webhook",
  cwd: "/work/acme/web",
  device: "studio",
  startedAt: Date.UTC(2026, 8, 20, 10),
  updatedAt: Date.UTC(2026, 8, 20, 11, 30),
  messages: 12,
  enc: false,
  summary: "Idempotency key on the Stripe webhook.",
  open: "Add a regression test.",
  goal: "The payment webhook fires twice, fix it",
  recent: [
    { seq: 10, role: "user", at: 1, text: "Deploy the fix now?" },
    { seq: 11, role: "assistant", at: 2, text: "Deployed." },
  ],
  native: { tool: "claude", id: "11111111-2222-3333-4444-555555555555", command: "claude --resume 11111111-2222-3333-4444-555555555555" },
  ...over,
});

describe("the handoff prompt", () => {
  test("says where it's from, then summary, open items, goal, recent turns and what to do", () => {
    const text = renderPrompt(handoff());
    expect(text.split("\n").slice(0, 2)).toEqual([
      "I'm continuing a session from claude-code (0b:k3f9x2): Fix duplicate payment webhook",
      "acme/web@fix/webhook · /work/acme/web · studio · last active 2026-09-20 11:30",
    ]);
    const order = ["Summary:\nIdempotency", "Open items:\nAdd a regression", "Goal (the first ask):\nThe payment", "Recent turns (2 of 12):\n#10 user: Deploy the fix now?\n\n#11 assistant: Deployed.", "Check the current state"];
    const at = order.map((s) => text.indexOf(s));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(text).toContain("`0b history show claude-code:11111111-2222-3333-4444-555555555555`, or bridge__history_get session=0b:k3f9x2.");
  });

  test("leaves out what the session doesn't have", () => {
    const text = renderPrompt(handoff({ summary: null, open: null, goal: null, recent: [], repo: null, branch: "main", title: null }));
    expect(text).not.toContain("Summary:");
    expect(text).not.toContain("Recent turns");
    expect(text).toContain("(0b:k3f9x2): (untitled)\n/work/acme/web · studio");
  });

  test("recent turns: oldest first, secret-only skipped, each ≤ 1,500 and all ≤ 8,000", () => {
    const newestFirst = Array.from({ length: 10 }, (_, i) => ({ seq: 9 - i, role: "assistant" as const, at: i, text: i === 0 ? "[secret]" : "y".repeat(3_000) }));
    const r = pickRecent(newestFirst, 6);
    expect(r.map((t) => t.seq)).toEqual([3, 4, 5, 6, 7, 8]);
    expect(r.every((t) => t.text.length <= 1_500)).toBe(true);
    expect(r.reduce((n, t) => n + t.text.length, 0)).toBeLessThanOrEqual(8_000);
  });
});

describe("where it runs", () => {
  test("inside Claude Code or Codex, or piped, it prints", () => {
    expect(inAgent({ CLAUDECODE: "1" }, true)).toBe(true);
    expect(inAgent({ CODEX_SANDBOX: "seatbelt" }, true)).toBe(true);
    // A second Codex account set in the user's own shell isn't an agent.
    expect(inAgent({ CODEX_HOME: "/x" }, true)).toBe(false);
    expect(inAgent({}, false)).toBe(true);
    expect(inAgent({}, true)).toBe(false);
  });

  test("--tool names and session tools map to an agent", () => {
    expect(agentOf("claude-app")).toBe("claude");
    expect(agentOf("codex-app")).toBe("codex");
    expect(agentOf("cursor-agent")).toBe("cursor");
    expect(agentOf("grok")).toBeNull();
  });

  test("Windows: an .exe before a .cmd shim; a shim gets a prompt naming the file, never the text through cmd.exe", () => {
    const dir = mkdtempSync(join(tmpdir(), "0b-resume-bin-"));
    writeFileSync(join(dir, "codex.cmd"), "");
    expect(findCommand("codex", "win32", dir)).toBe(join(dir, "codex.cmd"));
    writeFileSync(join(dir, "codex.exe"), "");
    expect(findCommand("codex", "win32", dir)).toBe(join(dir, "codex.exe"));
    expect(findCommand("claude", "linux", dir)).toBeNull();
    expect(launch("C:\\bin\\claude.exe", ["fix & push"], ["Read x"], "win32")).toEqual({ file: "C:\\bin\\claude.exe", args: ["fix & push"], verbatim: false });
    expect(launch("/usr/bin/codex", ["fix & push"], ["Read x"], "linux").args).toEqual(["fix & push"]);
    const shim = launch("C:\\bin\\codex.cmd", ["fix & push"], ["Read C:\\h\\k3f9x2.md & continue"], "win32");
    expect(shim.verbatim).toBe(true);
    expect(shim.args).toEqual(["/d", "/s", "/c", '""C:\\bin\\codex.cmd" "Read C:\\h\\k3f9x2.md  continue""']);
    expect(launch("C:\\bin\\claude.cmd", ["--resume", "abc"], undefined, "win32").args[3]).toBe('""C:\\bin\\claude.cmd" "--resume" "abc""');
  });
});

describe("0b resume --print", () => {
  const seen: string[] = [];
  let reply: (url: URL) => Response = () => Response.json(handoff());
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push(`${req.headers.get("authorization")} ${url.pathname}${url.search}`);
      return reply(url);
    },
  });
  afterAll(() => server.stop(true));

  const signedIn = (): Context => {
    const home = mkdtempSync(join(tmpdir(), "0b-resume-"));
    const ctx = { home, storeDir: join(home, ".0bridge") };
    mkdirSync(ctx.storeDir, { recursive: true });
    const account = saveCloud(ctx, { server: `http://localhost:${server.port}`, userId: "u1", login: "me", tokenId: "t1" });
    openSecretStore(ctx.storeDir).set(deviceTokenKey(account), "0b_test");
    return ctx;
  };
  const printed = async (ctx: Context, args: string[], turns?: string) => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await resumeCommand(ctx, args, { print: true, turns });
      return log.mock.calls.map((c) => c.join(" ")).join("\n");
    } finally {
      log.mockRestore();
    }
  };

  test("fetches the handoff for the ref as typed and prints the prompt", async () => {
    const out = await printed(signedIn(), ["continue", "0b:K3F9X2"], "3");
    expect(seen.at(-1)).toBe("Bearer 0b_test /api/history/sessions/continue%200b%3AK3F9X2/handoff?turns=3");
    expect(out).toBe(renderPrompt(handoff()));
  });

  test("an end-to-end encrypted session is opened here with the vault key", async () => {
    const ctx = signedIn();
    const key = crypto.getRandomValues(new Uint8Array(32));
    openSecretStore(ctx.storeDir).set(vaultKeyName(ctx), Buffer.from(key).toString("base64url"));
    const h = handoff({ enc: true, messages: 3, goal: null, recent: [], summary: null, open: null });
    const at = (name: string) => ({ scope: "history", env: h.id, name });
    const msgs = [
      { seq: 0, role: "user", at: 1, text: sealValue(key, at("#0"), "Make the webhook idempotent") },
      { seq: 1, role: "assistant", at: 2, text: sealValue(key, at("#1"), "Done, with a key per event.") },
      { seq: 2, role: "user", at: 3, text: sealValue(key, at("#2"), "[secret]") },
    ];
    reply = (url) =>
      url.pathname.endsWith("/handoff")
        ? Response.json({ ...h, title: sealValue(key, at("title"), "Sealed title") })
        : Response.json({ session: { id: h.id }, messages: msgs.filter((m) => m.seq >= Number(url.searchParams.get("from") ?? 0)) });
    const out = await printed(ctx, ["0b:k3f9x2"]);
    expect(out).toContain("(0b:k3f9x2): Sealed title");
    expect(out).toContain("Goal (the first ask):\nMake the webhook idempotent");
    expect(out).toContain("Recent turns (2 of 3):\n#0 user: Make the webhook idempotent\n\n#1 assistant: Done, with a key per event.");
    expect(out).not.toContain("v1.");
  });
});
