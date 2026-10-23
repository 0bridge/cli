/**
 * The vault key without `0b secret set`: `0b history mode e2e` makes it when the account has
 * none, and `0b vault create` does so on its own. Against a fake gateway (Bun.serve) and a temp home.
 *   bun test apps/cli/test/vault-create.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deviceTokenKey, generateVaultKey, openSecretStore, parseRecoveryKey, saveCloud, vaultKeyId, vaultKeyName, type Context } from "@0bridge/core";

const CLI = join(import.meta.dir, "..", "src", "index.ts");

const fake = {
  keyId: null as string | null,
  created: [] as string[],
  mode: "server" as "server" | "e2e",
  modes: [] as string[],
  forgot: 0,
};
let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const json = (b: unknown, status = 200) => Response.json(b, { status });
      switch (`${req.method} ${new URL(req.url).pathname}`) {
        case "GET /api/vault":
          // What the gateway answers since D86: the key id, and never any values.
          return json({ keyId: fake.keyId, items: [] });
        case "POST /api/vault": {
          const { keyId } = (await req.json()) as { keyId: string };
          if (fake.keyId) return json({ keyId: fake.keyId, error: "this account already has a vault" }, 409);
          fake.created.push(keyId);
          fake.keyId = keyId;
          return json({ keyId }, 201);
        }
        case "GET /api/history":
          return json({ mode: fake.mode, sessions: 0, messages: 0, bytes: 0, tools: {} });
        case "DELETE /api/history":
          fake.forgot++;
          return json({ deleted: 0 });
        case "PUT /api/history/mode": {
          const { mode } = (await req.json()) as { mode: "server" | "e2e" };
          fake.modes.push(mode);
          fake.mode = mode;
          return json({ mode });
        }
      }
      return json({ error: "not found" }, 404);
    },
  });
  base = `http://localhost:${server.port}`;
});
afterAll(() => server.stop(true));
beforeEach(() => Object.assign(fake, { keyId: null, created: [], mode: "server", modes: [], forgot: 0 }));

function signedIn(): { home: string; ctx: Context } {
  const home = mkdtempSync(join(tmpdir(), "0b-vault-create-"));
  const ctx = { home, storeDir: join(home, ".0bridge") };
  const account = saveCloud(ctx, { server: base, userId: "user-1", login: "me", email: "me@example.com", tokenId: "t_1" });
  openSecretStore(ctx.storeDir).set(deviceTokenKey(account), "0b_device_token");
  return { home, ctx };
}

async function ob(home: string, args: string[]) {
  const p = Bun.spawn([process.execPath, CLI, ...args], {
    env: { ...(process.env as Record<string, string>), ZEROBRIDGE_USER_HOME: home, ZEROBRIDGE_DIR: join(home, ".0bridge"), ZEROBRIDGE_SECRET_STORE: "file", BROWSER: "none", NO_COLOR: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = [await p.exited, await new Response(p.stdout).text(), await new Response(p.stderr).text()];
  return { code, out, err };
}

process.env.ZEROBRIDGE_SECRET_STORE = "file";
const localKey = (ctx: Context) => {
  const raw = openSecretStore(ctx.storeDir).get(vaultKeyName(ctx));
  return raw ? new Uint8Array(Buffer.from(raw, "base64url")) : null;
};

describe("0b history mode e2e", () => {
  test("an account with no vault gets one: the key stays here, its id goes up, the recovery key is handed over once", async () => {
    const { home, ctx } = signedIn();
    const r = await ob(home, ["history", "mode", "e2e"]);
    expect(r.code).toBe(0);
    const key = localKey(ctx)!;
    expect(key).not.toBeNull();
    expect(fake.created).toEqual([vaultKeyId(key)]);
    expect(fake.modes).toEqual(["e2e"]);
    // No terminal here: the recovery key went to a 0600 file, never to this command's output.
    const file = join(ctx.storeDir, "vault-recovery-key.txt");
    expect(r.out).toContain(file);
    expect(parseRecoveryKey(readFileSync(file, "utf8"))).toEqual(key);
    expect(r.out + r.err).not.toContain(readFileSync(file, "utf8").trim());
    expect(r.out).toMatch(/end-to-end encrypted/);
    rmSync(home, { recursive: true, force: true });
  });

  test("an account whose vault this machine can't open: told to unlock it; no new vault, mode unchanged", async () => {
    const { home, ctx } = signedIn();
    fake.keyId = vaultKeyId(generateVaultKey());
    const r = await ob(home, ["history", "mode", "e2e"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("0b vault unlock");
    expect(fake.created).toEqual([]);
    expect(fake.modes).toEqual([]);
    expect(localKey(ctx)).toBeNull();
    rmSync(home, { recursive: true, force: true });
  });

  test("this machine has the account's key: no new vault, just the switch", async () => {
    const { home, ctx } = signedIn();
    const key = generateVaultKey();
    openSecretStore(ctx.storeDir).set(vaultKeyName(ctx), Buffer.from(key).toString("base64url"));
    fake.keyId = vaultKeyId(key);
    const r = await ob(home, ["history", "mode", "e2e"]);
    expect(r.code).toBe(0);
    expect(fake.created).toEqual([]);
    expect(fake.modes).toEqual(["e2e"]);
    expect(existsSync(join(ctx.storeDir, "vault-recovery-key.txt"))).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });
});

describe("0b vault create", () => {
  test("makes the vault when there's none; a second run changes nothing", async () => {
    const { home, ctx } = signedIn();
    expect((await ob(home, ["vault", "create"])).code).toBe(0);
    const key = localKey(ctx)!;
    expect(fake.created).toEqual([vaultKeyId(key)]);
    expect(existsSync(join(ctx.storeDir, "vault-recovery-key.txt"))).toBe(true);
    const again = await ob(home, ["vault", "create"]);
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/already/);
    expect(fake.created).toHaveLength(1);
    expect((await ob(home, ["vault", "status"])).out).toMatch(/this machine can open it/);
    rmSync(home, { recursive: true, force: true });
  });
});
