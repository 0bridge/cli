import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Context } from "./types.ts";
import { readJson, writeAtomic } from "./util.ts";
import { accountSlot, loadCloud } from "./cloud.ts";

/**
 * The vault key: made on the user's machine, it never leaves their devices; the gateway
 * only records its id and relays it, sealed, between them. End-to-end history is encrypted
 * with it. The vault no longer holds secret values: only the key is left.
 */

/** Secret-store key of this device's copy of the vault key. */
export const VAULT_KEY = "vault.key";

export interface VaultState {
  /** Identifies the key without revealing it; null when the account has no vault yet. */
  keyId: string | null;
}

/** Where a sealed value belongs; it is bound to it, so the server can't move it elsewhere. */
export interface SealedAt {
  scope: string;
  env: string;
  name: string;
}

export function generateVaultKey(): Uint8Array<ArrayBuffer> {
  return new Uint8Array(randomBytes(32));
}

/** HMAC of a fixed label: tells keys apart (and checks a pasted recovery key) without revealing them. */
export function vaultKeyId(key: Uint8Array): string {
  return createHmac("sha256", key).update("0bridge vault key id v1").digest("hex").slice(0, 24);
}

const aad = (i: SealedAt) => Buffer.from(`0bridge vault v1\n${i.scope}\n${i.env}\n${i.name}`);

/** AES-256-GCM with the vault key, bound to its place. */
export function sealValue(key: Uint8Array, at: SealedAt, value: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv).setAAD(aad(at));
  const ct = Buffer.concat([c.update(value, "utf8"), c.final(), c.getAuthTag()]);
  return `v1.${Buffer.concat([iv, ct]).toString("base64url")}`;
}

export function openValue(key: Uint8Array, item: SealedAt & { ct: string | null }): string {
  if (!item.ct) throw new Error(`${item.name} (${item.env}) isn't available`);
  if (!item.ct.startsWith("v1.")) throw new Error(`${item.name}: unknown format`);
  const raw = Buffer.from(item.ct.slice(3), "base64url");
  try {
    const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12)).setAAD(aad(item));
    d.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString("utf8");
  } catch {
    throw new Error(`${item.name} (${item.scope}, ${item.env}) can't be decrypted with this device's vault key`);
  }
}

export { formatRecoveryKey, parseRecoveryKey } from "./vault-crypto.ts";

// ── Offline copy of the vault's key id, so this machine knows its key matches without a network ──
// Each signed-in account has its own vault: its copy and its key carry the account's slot (cloud.ts).
const cachePath = (ctx: Context) => join(ctx.storeDir, `vault-cache${accountSlot(ctx)}.json`);

/** Secret-store name of this device's key to the vault of the account `ctx` uses. */
export const vaultKeyName = (ctx: Context): string => VAULT_KEY + accountSlot(ctx);

/** The account `ctx` uses, if any: an offline copy records whose it is. */
function owner(ctx: Context): string | null {
  try {
    return loadCloud(ctx)?.userId ?? null;
  } catch {
    return null;
  }
}

/**
 * The offline copy, if it's this account's. A slot's files outlive a sign-out, and the next account
 * to sign in may get the same slot: it must not read (or, with the old key still there, open) them.
 */
export function loadVaultCache(ctx: Context): VaultState | null {
  const v = readJson<VaultState & { owner?: string | null }>(cachePath(ctx));
  if (!v) return null;
  const me = owner(ctx);
  if (v.owner && me && v.owner !== me) return null;
  return { keyId: v.keyId ?? null };
}

/** Only the key id is kept (a copy written before D86 may still list values; they're dropped on the next save). */
export function saveVaultCache(ctx: Context, v: VaultState): void {
  writeAtomic(cachePath(ctx), JSON.stringify({ keyId: v.keyId, owner: owner(ctx) }) + "\n", { mode: 0o600, dirMode: 0o700 });
}
