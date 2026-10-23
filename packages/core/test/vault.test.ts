import { describe, expect, test } from "bun:test";
import { formatRecoveryKey, generateVaultKey, openValue, parseRecoveryKey, sealValue, vaultKeyId } from "../src/vault.ts";

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

describe("sealing in the browser", () => {
  test("the browser seals what the CLI opens", async () => {
    const { sealValueAsync } = await import("../src/vault-crypto.ts");
    const key = generateVaultKey();
    const at = { scope: "github.com/a/b", env: "dev", name: "X" };
    expect(openValue(key, { ...at, ct: await sealValueAsync(key, at, "from the browser") })).toBe("from the browser");
  });
});
