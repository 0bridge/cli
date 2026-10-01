/**
 * Signing in on a headless machine (round 2, P2): the link first and plain, the code and the
 * dashboard number, the terminal QR and --qr PNG, a sign-in that outlives the command (pending →
 * resume), and asking for the vault key without blocking (requestUnlock). Against a fake gateway
 * (Bun.serve) and a temp home; the real flow is apps/gateway/test/approvals.ts.
 *   bun test apps/cli/test/login.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deviceTokenKey, generateVaultKey, openSecretStore, saveCloud, vaultKeyId, type Context } from "@0bridge/core";
import { sealForDevice } from "@0bridge/core/vault-crypto";
import { pollDeviceSignIn, signInLines, startDeviceSignIn, type DeviceStart } from "../src/cloud.ts";
import { localKey, requestUnlock } from "../src/vault.ts";

process.env.ZEROBRIDGE_SECRET_STORE = "file";
const CLI = join(import.meta.dir, "..", "src", "index.ts");
const ANSI = /\x1b\[/;

// ── A fake gateway: device flow, hint, tokens, vault pairing ──
const fake = {
  hints: [] as { device_code: string; email: string; machine: Record<string, unknown> }[],
  /** Polls answered "pending" before the device code is approved (Infinity: never). */
  pendingPolls: 2,
  polls: 0,
  denied: false,
  pairings: [] as { id: string; devicePub: string }[],
  /** The sealed vault key once "approved" on the dashboard. */
  sealed: null as { ephemeralPub: string; ct: string } | null,
  pairingStatus: "pending" as "pending" | "denied",
  vaultKeyId: "",
  failures: 0,
};
let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const json = (b: unknown, status = 200) => Response.json(b, { status });
      switch (`${req.method} ${u.pathname}`) {
        case "POST /auth/device/code":
          return json({ device_code: "dc-secret", user_code: "ABCD2345", verification_uri: "/device", verification_uri_complete: "/device?user_code=ABCD2345", interval: 0, expires_in: 600 });
        case "POST /device/hint":
          fake.hints.push((await req.json()) as (typeof fake.hints)[number]);
          return json({ match: "47" });
        case "POST /auth/device/token":
          if (fake.denied) return json({ error: "access_denied" }, 400);
          if (fake.failures > 0) {
            fake.failures--;
            return new Response("Network connection lost.", { status: 500 });
          }
          return ++fake.polls > fake.pendingPolls ? json({ access_token: "bootstrap-session" }) : json({ error: "authorization_pending" }, 400);
        case "POST /api/tokens":
          return json({ id: "t_1", token: "0b_device_token" }, 201);
        case "POST /auth/sign-out":
          return json({ success: true });
        case "GET /api/me":
          return json({ userId: "user-1", login: "me", email: "me@example.com", tokenId: "t_1", mcpUrl: `${base}/mcp` });
        case "GET /api/vault":
          return json({ keyId: fake.vaultKeyId, items: [] });
        case "POST /api/vault/pairings": {
          const { devicePub } = (await req.json()) as { devicePub: string };
          const id = `p_${fake.pairings.length + 1}`;
          fake.pairings.push({ id, devicePub });
          return json({ id, url: `${base}/app/secrets/pair/${id}`, expiresAt: Date.now() + 600_000 }, 201);
        }
        case "GET /api/vault/pairings":
          return json(fake.pairings.map((p) => ({ id: p.id, devicePub: p.devicePub, device: "vm", createdAt: Date.now() })));
      }
      const pairing = /^\/api\/vault\/pairings\/(p_\d+)$/.exec(u.pathname);
      if (pairing && req.method === "GET") {
        if (!fake.pairings.some((p) => p.id === pairing[1])) return json({ error: "not found" }, 404);
        if (fake.pairingStatus === "denied") return json({ status: "denied" });
        return json(fake.sealed ? { status: "approved", ...fake.sealed } : { status: "pending" });
      }
      return json({ error: "not found" }, 404);
    },
  });
  base = `http://localhost:${server.port}`;
});
afterAll(() => server.stop(true));
beforeEach(() => {
  Object.assign(fake, { hints: [], pendingPolls: 2, polls: 0, denied: false, pairings: [], sealed: null, pairingStatus: "pending", failures: 0 });
});

/** This environment plus `extra`, with no say either way on colors: piped output alone has to keep them off. */
function plainEnv(extra: Record<string, string>): Record<string, string> {
  const env = { ...(process.env as Record<string, string>), ...extra };
  for (const k of ["NO_COLOR", "FORCE_COLOR", "CI"]) delete env[k];
  return env;
}

function tempHome() {
  const home = mkdtempSync(join(tmpdir(), "0b-login-"));
  return { home, ctx: { home, storeDir: join(home, ".0bridge") } as Context };
}

describe("0b login on a machine with no browser", () => {
  test("the link comes first, alone and plain; then the code and the dashboard number; --qr saves a PNG", async () => {
    const { home } = tempHome();
    const qr = join(home, "qr.png");
    const p = Bun.spawn([process.execPath, CLI, "login", "--server", base, "--email", "Me@Example.com", "--qr", qr], {
      // Piped like an agent's shell; no browser to open, no colors asked for or against.
      env: plainEnv({ ZEROBRIDGE_USER_HOME: home, ZEROBRIDGE_DIR: join(home, ".0bridge"), ZEROBRIDGE_SECRET_STORE: "file", BROWSER: "", DISPLAY: "", WAYLAND_DISPLAY: "" }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = [await p.exited, await new Response(p.stdout).text(), await new Response(p.stderr).text()];
    expect(err + out).not.toMatch(ANSI);
    expect(code).toBe(0);
    const lines = out.split("\n");
    const link = `${base}/device?user_code=ABCD2345`;
    const at = lines.indexOf(link);
    expect(at).toBeGreaterThanOrEqual(0);
    // Nothing about the sign-in comes before the link.
    expect(lines.slice(0, at).join("\n")).not.toMatch(/ABCD|47|device/);
    const codeAt = lines.findIndex((l) => l.includes("ABCD-2345"));
    const pickAt = lines.findIndex((l) => /pick 47/.test(l));
    expect(codeAt).toBe(at + 1);
    expect(pickAt).toBe(at + 2);
    expect(lines[pickAt]).toContain(`${base}/app/approvals`);
    expect(out).toContain(`Saved a QR code: ${qr}`);
    // No terminal: no block-character QR in the output.
    expect(out).not.toMatch(/[▀▄█]/);
    // The PNG: signature and an IHDR for a square image.
    const png = readFileSync(qr);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.subarray(12, 16).toString()).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(png.readUInt32BE(20));
    // The hint named the account (lowercased by the server, not here) and this machine as a CLI.
    expect(fake.hints).toHaveLength(1);
    expect(fake.hints[0]!.device_code).toBe("dc-secret");
    expect(fake.hints[0]!.email).toBe("Me@Example.com");
    expect(fake.hints[0]!.machine).toMatchObject({ kind: "cli", os: process.platform, arch: process.arch });
    expect(out).toMatch(/Signed in as me/);
    rmSync(home, { recursive: true, force: true });
  });

  test("without --email no hint is filed and no number is shown", async () => {
    const s = await startDeviceSignIn(base);
    expect(s.match).toBeNull();
    expect(fake.hints).toHaveLength(0);
    const lines = signInLines(s, { tty: false });
    expect(lines[0]).toBe(s.link);
    expect(lines.join("\n")).not.toMatch(/pick|dashboard/);
  });

  test("ZEROB_EMAIL names the account when --email doesn't", async () => {
    const { home } = tempHome();
    const p = Bun.spawn([process.execPath, CLI, "login", "--server", base], {
      env: { ...(process.env as Record<string, string>), ZEROBRIDGE_USER_HOME: home, ZEROBRIDGE_DIR: join(home, ".0bridge"), ZEROBRIDGE_SECRET_STORE: "file", BROWSER: "", DISPLAY: "", WAYLAND_DISPLAY: "", ZEROB_EMAIL: "env@example.com" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await p.exited).toBe(0);
    expect(fake.hints.map((h) => h.email)).toEqual(["env@example.com"]);
    rmSync(home, { recursive: true, force: true });
  });

  test("on a terminal wide enough, a QR made of half blocks follows the code", () => {
    const s: DeviceStart = { deviceCode: "d", userCode: "ABCD-2345", link: `${base}/device?user_code=ABCD2345`, verifyUrl: `${base}/device`, match: "47", interval: 5, expiresAt: Date.now() + 600_000 };
    const wide = signInLines(s, { tty: true, columns: 100 });
    expect(wide[0]).toBe(s.link);
    const qrAt = wide.findIndex((l) => /[▀▄█]/.test(l));
    expect(qrAt).toBeGreaterThan(2);
    // Too narrow for the code: no QR rather than a broken one.
    expect(signInLines(s, { tty: true, columns: 30 }).join("\n")).not.toMatch(/[▀▄█]/);
    expect(signInLines(s, { tty: false, columns: 200 }).join("\n")).not.toMatch(/[▀▄█]/);
  });

  test("a failed hint still shows the link, and says why there's no number", () => {
    const s: DeviceStart = { deviceCode: "d", userCode: "ABCD-2345", link: `${base}/device?user_code=X`, verifyUrl: `${base}/device`, match: null, interval: 5, expiresAt: 0, hintNote: "couldn't ask me@example.com on the dashboard (429); use the link" };
    const lines = signInLines(s, { tty: false });
    expect(lines[0]).toBe(s.link);
    expect(lines.join("\n")).toContain("(429); use the link");
  });
});

describe("a sign-in that outlives the command", () => {
  test("pending when the wait ends first, then the same flow resumes to a token", async () => {
    fake.pendingPolls = Infinity;
    const s = await startDeviceSignIn(base);
    // Saved and loaded as JSON, the way an agent VM keeps it between runs.
    const saved = JSON.parse(JSON.stringify(s)) as DeviceStart;
    expect(await pollDeviceSignIn(base, saved, { untilMs: Date.now() + 50 })).toBe("pending");
    fake.pendingPolls = fake.polls; // approved now
    expect(await pollDeviceSignIn(base, saved, { untilMs: Date.now() + 5000 })).toBe("bootstrap-session");
  });

  test("a 5xx while waiting is tried again; six in a row give up", async () => {
    fake.failures = 2;
    expect(await pollDeviceSignIn(base, await startDeviceSignIn(base))).toBe("bootstrap-session");
    fake.failures = 6;
    await expect(pollDeviceSignIn(base, await startDeviceSignIn(base))).rejects.toThrow(/sign-in failed \(500\)/);
  });

  test("a denied sign-in throws", async () => {
    fake.denied = true;
    const s = await startDeviceSignIn(base);
    await expect(pollDeviceSignIn(base, s)).rejects.toThrow(/denied/);
  });

  test("an expired flow throws instead of waiting", async () => {
    const s = { ...(await startDeviceSignIn(base)), expiresAt: Date.now() - 1 };
    await expect(pollDeviceSignIn(base, s, { untilMs: Date.now() + 1000 })).rejects.toThrow(/expired/);
  });
});

describe("requestUnlock", () => {
  async function signedIn() {
    const t = tempHome();
    const account = saveCloud(t.ctx, { server: base, userId: "user-1", login: "me", email: "me@example.com", tokenId: "t_1" });
    openSecretStore(t.ctx.storeDir).set(deviceTokenKey(account), "0b_device_token");
    return t;
  }

  test("asks once without waiting, resumes the same request later, and opens the vault when approved", async () => {
    const { ctx, home } = await signedIn();
    const key = generateVaultKey();
    fake.vaultKeyId = vaultKeyId(key);
    const logs: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.join(" "));
    try {
      expect(await requestUnlock(ctx, { waitMs: 0, agentVm: true })).toBe("pending");
    } finally {
      console.log = log;
    }
    expect(fake.pairings).toHaveLength(1);
    // The link first and alone after its label, then the code.
    expect(logs[0]).toBe(`Approve the vault key: ${base}/app/secrets/pair/p_1`);
    expect(logs[1]).toMatch(/^Code: [A-Z2-7]{4}-[A-Z2-7]{4}/);
    expect(logs.join("\n")).toMatch(/AI agent's computer/);
    const file = join(ctx.storeDir, "vault-pending.json");
    expect(existsSync(file)).toBe(true);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);

    // Again (or `0b vault unlock`): the same request, not a new one.
    expect(await requestUnlock(ctx, { waitMs: 0, quiet: true })).toBe("pending");
    expect(fake.pairings).toHaveLength(1);

    // Approved on the dashboard: the key arrives sealed to the saved key pair.
    fake.sealed = await sealForDevice(key, fake.pairings[0]!.devicePub);
    expect(await requestUnlock(ctx, { waitMs: 0, quiet: true })).toBe("unlocked");
    expect(localKey(ctx)).toEqual(key);
    expect(existsSync(file)).toBe(false);
    expect(await requestUnlock(ctx, { waitMs: 0, quiet: true })).toBe("already");
    rmSync(home, { recursive: true, force: true });
  });

  test("an account without a vault: none, and nothing asked", async () => {
    const { ctx, home } = await signedIn();
    fake.vaultKeyId = "";
    expect(await requestUnlock(ctx, { waitMs: 0, quiet: true })).toBe("none");
    expect(fake.pairings).toHaveLength(0);
    rmSync(home, { recursive: true, force: true });
  });

  test("waits up to waitMs, and a denial clears the saved request", async () => {
    const { ctx, home } = await signedIn();
    fake.vaultKeyId = vaultKeyId(generateVaultKey());
    const started = Date.now();
    expect(await requestUnlock(ctx, { waitMs: 300, quiet: true })).toBe("pending");
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    fake.pairingStatus = "denied";
    expect(await requestUnlock(ctx, { waitMs: 0, quiet: true })).toBe("denied");
    expect(existsSync(join(ctx.storeDir, "vault-pending.json"))).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });

  test("a request the server no longer has makes way for a new one", async () => {
    const { ctx, home } = await signedIn();
    fake.vaultKeyId = vaultKeyId(generateVaultKey());
    expect(await requestUnlock(ctx, { waitMs: 0, quiet: true })).toBe("pending");
    fake.pairings = []; // gone (expired and cleaned up)
    expect(await requestUnlock(ctx, { waitMs: 0, quiet: true })).toBe("pending");
    expect(fake.pairings.map((p) => p.id)).toEqual(["p_1"]);
    rmSync(home, { recursive: true, force: true });
  });
});
