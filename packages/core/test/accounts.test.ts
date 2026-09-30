import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountSlot, clearCloud, deviceTokenKey, findAccount, gatewayEntry, loadAccounts, loadCloud, saveAccounts, saveCloud, DEVICE_TOKEN } from "../src/cloud.ts";
import { loadVaultCache, saveVaultCache, vaultKeyName } from "../src/vault.ts";
import type { Context } from "../src/types.ts";

const fresh = (): Context => {
  const home = mkdtempSync(join(tmpdir(), "0b-accounts-"));
  return { home, storeDir: join(home, ".0bridge") };
};
const A = { server: "https://0bridge.dev", userId: "userAAAA1", login: "Sam", email: "me@example.com", tokenId: "t1" };
const B = { server: "https://0bridge.dev", userId: "userBBBB2", login: "Sam at Acme", email: "sam@acme.com", tokenId: "t2" };

describe("several accounts", () => {
  test("a sign-in from before several accounts (cloud.json only) is the first account, in the unsuffixed slot", () => {
    const ctx = fresh();
    saveCloud(ctx, A);
    // Old layout: just cloud.json.
    const legacy = join(ctx.storeDir, "cloud.json");
    rmSync(join(ctx.storeDir, "accounts.json"));
    expect(JSON.parse(readFileSync(legacy, "utf8")).userId).toBe(A.userId);
    const all = loadAccounts(ctx);
    expect(all.default).toBe(A.userId);
    expect(all.accounts[0]!.slot).toBe("");
    expect(deviceTokenKey(all.accounts[0]!)).toBe(DEVICE_TOKEN);
  });

  test("a second sign-in adds an account in its own slot; the first stays the default", () => {
    const ctx = fresh();
    const a = saveCloud(ctx, A);
    const b = saveCloud(ctx, B);
    expect(a.slot).toBe("");
    expect(b.slot).toBe(`@${B.userId}`);
    expect(loadCloud(ctx)!.userId).toBe(A.userId);
    expect(loadCloud({ ...ctx, account: "SAM@acme.com" })!.userId).toBe(B.userId);
    expect(loadCloud({ ...ctx, account: B.userId })!.userId).toBe(B.userId);
    expect(() => loadCloud({ ...ctx, account: "nobody@x.com" })).toThrow("isn't signed in");
    // Signing in again as A keeps its slot.
    expect(saveCloud(ctx, { ...A, tokenId: "t3" }).slot).toBe("");
    expect(loadAccounts(ctx).accounts).toHaveLength(2);
  });

  test("each account has its own device token and vault key names", () => {
    const ctx = fresh();
    saveCloud(ctx, A);
    saveCloud(ctx, B);
    expect(accountSlot(ctx)).toBe("");
    expect(vaultKeyName(ctx)).toBe("vault.key");
    expect(vaultKeyName({ ...ctx, account: B.email })).toBe(`vault.key@${B.userId}`);
    expect(gatewayEntry(A.server, `@${B.userId}`).headers!.Authorization).toBe(`Bearer \${secret:cloud.device-token@${B.userId}}`);
  });

  test("signing the default out makes the next one the default; cloud.json follows the unsuffixed slot", () => {
    const ctx = fresh();
    saveCloud(ctx, A);
    saveCloud(ctx, B);
    const left = clearCloud(ctx, A.userId);
    expect(left.default).toBe(B.userId);
    expect(existsSync(join(ctx.storeDir, "cloud.json"))).toBe(false);
    // The unsuffixed slot is free again: a new sign-in takes it.
    expect(saveCloud(ctx, A).slot).toBe("");
    expect(loadAccounts(ctx).default).toBe(B.userId);
    clearCloud(ctx, A.userId);
    clearCloud(ctx, B.userId);
    expect(loadAccounts(ctx)).toEqual({ default: null, accounts: [] });
    expect(loadCloud(ctx)).toBeNull();
  });

  test("the default can be changed", () => {
    const ctx = fresh();
    saveCloud(ctx, A);
    saveCloud(ctx, B);
    saveAccounts(ctx, { ...loadAccounts(ctx), default: B.userId });
    expect(loadCloud(ctx)!.userId).toBe(B.userId);
    expect(findAccount(loadAccounts(ctx), "sam")!.userId).toBe(A.userId);
  });

  test("an account that gets a signed-out account's slot doesn't read its offline vault copy", () => {
    const ctx = fresh();
    saveCloud(ctx, A);
    saveCloud(ctx, B);
    saveVaultCache(ctx, { keyId: "kA", items: [] } as never);
    expect(loadVaultCache(ctx)?.keyId).toBe("kA");
    clearCloud(ctx, A.userId);
    const C = { ...A, userId: "userCCCC3", email: "c@example.com", login: "C" };
    expect(saveCloud(ctx, C).slot).toBe("");
    expect(loadVaultCache({ ...ctx, account: C.email })).toBeNull();
    // A signing back in into that slot gets its copy back.
    clearCloud(ctx, C.userId);
    saveCloud(ctx, A);
    expect(loadVaultCache({ ...ctx, account: A.email })?.keyId).toBe("kA");
  });
});
