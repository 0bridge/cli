import { describe, expect, test } from "bun:test";
import { Masker, formatRecoveryKey, generateVaultKey, itemsFor, openValue, parseDotenv, parseRecoveryKey, sealValue, vaultKeyId } from "../src/vault.ts";

describe("vault", () => {
  test("values round-trip, and only open where they were sealed", () => {
    const key = generateVaultKey();
    const at = { scope: "github.com/acme/app", env: "dev", name: "STRIPE_KEY" };
    const ct = sealValue(key, at, "sk_test_123 ünïcode");
    expect(ct.startsWith("v1.")).toBe(true);
    expect(openValue(key, { ...at, ct })).toBe("sk_test_123 ünïcode");
    // Moved to another name or env by whoever stores it: refused.
    expect(() => openValue(key, { ...at, env: "prod", ct })).toThrow("can't be decrypted");
    expect(() => openValue(key, { ...at, name: "OTHER", ct })).toThrow("can't be decrypted");
    expect(() => openValue(generateVaultKey(), { ...at, ct })).toThrow("can't be decrypted");
  });

  test("recovery key round-trips and tolerates spacing and case", () => {
    const key = generateVaultKey();
    const r = formatRecoveryKey(key);
    expect(r).toMatch(/^0B-([A-Z2-7]{4}-){12}[A-Z2-7]{4}$/);
    expect(parseRecoveryKey(r)).toEqual(key);
    expect(parseRecoveryKey(` ${r.toLowerCase().replace(/-/g, " ")} `)).toEqual(key);
    expect(vaultKeyId(parseRecoveryKey(r))).toBe(vaultKeyId(key));
    expect(vaultKeyId(key)).toMatch(/^[0-9a-f]{24}$/);
    expect(() => parseRecoveryKey("0B-NOPE")).toThrow("recovery key");
  });

  test("a repo's values override global ones for the same env", () => {
    const i = (scope: string, env: string, name: string) => ({ scope, env, name, ct: `${scope}/${env}`, updatedAt: 0 });
    const v = { keyId: "k", items: [i("global", "dev", "A"), i("global", "dev", "B"), i("r", "dev", "B"), i("r", "prod", "A"), i("other", "dev", "C")] };
    expect(itemsFor(v, "r", "dev").map((x) => `${x.name}=${x.ct}`).sort()).toEqual(["A=global/dev", "B=r/dev"]);
    expect(itemsFor(v, null, "dev").map((x) => x.name).sort()).toEqual(["A", "B"]);
    expect(itemsFor(v, "r", "prod").map((x) => x.name)).toEqual(["A"]);
  });

  test("dotenv parsing", () => {
    const env = parseDotenv(`# comment
export A=1
B = "two words" 
C='single $x'
D=plain # trailing comment
E="line\\nbreak"
EMPTY=
`);
    expect(env).toEqual({ A: "1", B: "two words", C: "single $x", D: "plain", E: "line\nbreak", EMPTY: "" });
  });

  test("masking catches values split across chunks, and passes other text through", () => {
    const m = new Masker(["sk_live_abcdef", "no"]);
    expect(m.push("key=sk_live_abcdef\n")).toBe("key=***\n");
    const out = m.push("a sk_li") + m.push("ve_abc") + m.push("def b") + m.flush();
    expect(out).toBe("a *** b");
    // A held-back tail that turns out not to be a value comes through unchanged.
    expect(m.push("sk_l") + m.push("ater") + m.flush()).toBe("sk_later");
    // Values under 6 characters aren't masked (they'd hide ordinary words).
    expect(m.push("no no") + m.flush()).toBe("no no");
  });
});

describe("vault key outside the CLI (dashboard, new machines)", () => {
  test("the browser code opens what the CLI sealed, and names the key the same way", async () => {
    const { keyIdOf, openValueAsync } = await import("../src/vault-crypto.ts");
    const key = generateVaultKey();
    const at = { scope: "global", env: "dev", name: "API_KEY" };
    expect(await openValueAsync(key, { ...at, ct: sealValue(key, at, "v4lue") })).toBe("v4lue");
    expect(await keyIdOf(key)).toBe(vaultKeyId(key));
  });

  test("a passkey's PRF output wraps the key for that credential only", async () => {
    const { unwrapWithPrf, wrapWithPrf } = await import("../src/vault-crypto.ts");
    const key = generateVaultKey();
    const prf = crypto.getRandomValues(new Uint8Array(32));
    const wrapped = await wrapWithPrf(key, prf, "cred-1");
    expect(await unwrapWithPrf(wrapped, prf, "cred-1")).toEqual(key);
    await expect(unwrapWithPrf(wrapped, prf, "cred-2")).rejects.toThrow();
    await expect(unwrapWithPrf(wrapped, crypto.getRandomValues(new Uint8Array(32)), "cred-1")).rejects.toThrow();
  });

  test("pairing hands the key to the new machine; another key pair can't open it", async () => {
    const { openFromApprover, pairingCode, pairingKeyPair, sealForDevice } = await import("../src/vault-crypto.ts");
    const key = generateVaultKey();
    const device = await pairingKeyPair();
    const sealed = await sealForDevice(key, device.publicKey);
    expect(await openFromApprover(device.privateKey, device.publicKey, sealed.ephemeralPub, sealed.ct)).toEqual(key);
    const other = await pairingKeyPair();
    await expect(openFromApprover(other.privateKey, device.publicKey, sealed.ephemeralPub, sealed.ct)).rejects.toThrow();
    expect(await pairingCode(device.publicKey)).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    expect(await pairingCode(device.publicKey)).not.toBe(await pairingCode(other.publicKey));
  });
});

describe("pasting values", () => {
  test("public settings are variables, the rest secrets", async () => {
    const { guessKind } = await import("../src/vault-crypto.ts");
    const cases: [string, string, string][] = [
      ["PORT", "3000", "variable"],
      ["NODE_ENV", "production", "variable"],
      ["NEXT_PUBLIC_API_URL", "https://api.example.com", "variable"],
      ["DATABASE_URL", "postgres://u:p@h/db", "secret"],
      ["STRIPE_SECRET_KEY", "sk_live_x", "secret"],
      ["OPENAI_API_KEY", "sk-abc", "secret"],
      ["SOME_OPAQUE", "a8f7d9c0b1e2f3a4b5c6d7e8", "secret"],
      ["FEATURE_FLAG", "true", "variable"],
      ["NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "pk_live_x", "variable"],
      ["GITHUB_CLIENT_ID", "Iv1.8a61f9b3a7aba766", "secret"],
    ];
    for (const [name, value, kind] of cases) expect(`${name}=${guessKind(name, value)}`).toBe(`${name}=${kind}`);
  });

  test("the browser seals what the CLI opens", async () => {
    const { sealValueAsync } = await import("../src/vault-crypto.ts");
    const key = generateVaultKey();
    const at = { scope: "github.com/a/b", env: "dev", name: "X" };
    expect(openValue(key, { ...at, ct: await sealValueAsync(key, at, "from the browser") })).toBe("from the browser");
  });
});

describe("importing a .env", () => {
  test("values that name this machine are pointed out, others aren't", async () => {
    const { pointsAtThisMachine } = await import("../src/vault.ts");
    const local = [
      "postgres://user:pass@localhost:5434/app",
      "http://localhost:5173",
      "http://127.0.0.1:8787/v1",
      "redis://0.0.0.0:6379",
      "http://[::1]:3000",
      "postgres://u:p@host.docker.internal/db",
      "localhost",
    ];
    const elsewhere = [
      "https://api.example.com",
      "postgres://u:p@db.example.com/app",
      "sk-localhostish",
      "http://mylocalhost.dev",
      "notlocalhost:3000",
      "true",
    ];
    for (const v of local) expect(`${v}=${pointsAtThisMachine(v)}`).toBe(`${v}=true`);
    for (const v of elsewhere) expect(`${v}=${pointsAtThisMachine(v)}`).toBe(`${v}=false`);
  });
});
