import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { join } from "node:path";
import type { SecretStore } from "./secrets.ts";
import type { Context } from "./types.ts";
import { readJson, writeAtomic } from "./util.ts";
import { accountSlot, loadCloud } from "./cloud.ts";

/**
 * The secrets vault (D28): values encrypted on this machine with the vault key, which never
 * leaves the user's devices. The gateway stores and syncs ciphertext only. Names, scopes and
 * environments stay readable so they can be listed without the key.
 */

/** Secret-store key of this device's copy of the vault key. */
export const VAULT_KEY = "vault.key";
/** Secrets for every repo; otherwise the scope is a repo ("github.com/owner/repo"). */
export const GLOBAL_SCOPE = "global";
export const DEFAULT_ENV = "dev";

/** Names are environment variable names, since that's how they reach commands. */
export const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const ENV_NAME = /^[a-z][a-z0-9-]{0,31}$/;
export const MAX_VALUE_BYTES = 32 * 1024;
/**
 * Environments a device only gets after the user approves it in the browser (the gateway
 * withholds their ciphertext until then). Kept in step with apps/gateway/src/vault.ts.
 */
export const PROTECTED_ENVS = new Set(["prod"]);

export interface VaultItem {
  scope: string;
  env: string;
  name: string;
  /** "v1." + base64url(iv ‖ AES-GCM ciphertext); null while a protected env isn't approved for this device. */
  ct: string | null;
  /** "secret" (hidden, masked in agents' output) or "variable" (shown as is). Both are encrypted. */
  kind?: "secret" | "variable";
  locked?: boolean;
  /** Off: kept, but commands don't get it (instead of commenting a line out of .env). Missing means on. */
  enabled?: boolean;
  /** What the value is ("acme org token, expires 2027-03"), sealed like the value at `NAME#note`. */
  note?: string | null;
  updatedAt: number;
}

export interface VaultState {
  /** Identifies the key without revealing it; null when the account has no vault yet. */
  keyId: string | null;
  items: VaultItem[];
}

export function generateVaultKey(): Uint8Array<ArrayBuffer> {
  return new Uint8Array(randomBytes(32));
}

/** HMAC of a fixed label: tells keys apart (and checks a pasted recovery key) without revealing them. */
export function vaultKeyId(key: Uint8Array): string {
  return createHmac("sha256", key).update("0bridge vault key id v1").digest("hex").slice(0, 24);
}

/** Binds a ciphertext to its place, so the server can't move a value to another name or env. */
const aad = (i: Pick<VaultItem, "scope" | "env" | "name">) => Buffer.from(`0bridge vault v1\n${i.scope}\n${i.env}\n${i.name}`);

/** AES-256-GCM, synchronous so `${secret:…}` references can resolve from the vault too. */
export function sealValue(key: Uint8Array, at: Pick<VaultItem, "scope" | "env" | "name">, value: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv).setAAD(aad(at));
  const ct = Buffer.concat([c.update(value, "utf8"), c.final(), c.getAuthTag()]);
  return `v1.${Buffer.concat([iv, ct]).toString("base64url")}`;
}

/** Where a value's note is sealed: next to it, under a name no value can have. */
export const noteAt = (i: Pick<VaultItem, "scope" | "env" | "name">) => ({ scope: i.scope, env: i.env, name: `${i.name}#note` });

export const sealNote = (key: Uint8Array, at: Pick<VaultItem, "scope" | "env" | "name">, text: string) => sealValue(key, noteAt(at), text);

/** The note in plain text, or null when there's none (or it can't be opened with this key). */
export function openNote(key: Uint8Array, item: Pick<VaultItem, "scope" | "env" | "name" | "note">): string | null {
  if (!item.note) return null;
  try {
    return openValue(key, { ...noteAt(item), ct: item.note });
  } catch {
    return null;
  }
}

export function openValue(key: Uint8Array, item: Pick<VaultItem, "scope" | "env" | "name" | "ct">): string {
  if (!item.ct) throw new Error(`${item.name} (${item.env}) needs your approval first`);
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

export { formatRecoveryKey, guessKind, parseDotenv, parseRecoveryKey, pointsAtThisMachine, type VaultKind } from "./vault-crypto.ts";

// ── Offline copy of the ciphertext, so `0b exec` works without a network ──
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
  const { owner: _, ...state } = v;
  return state;
}

/** Protected environments' ciphertext is never kept on disk: it's only held while a command runs. */
export function saveVaultCache(ctx: Context, v: VaultState): void {
  const items = v.items.map((i) => (PROTECTED_ENVS.has(i.env) ? { ...i, ct: null, locked: true } : i));
  writeAtomic(cachePath(ctx), JSON.stringify({ ...v, items, owner: owner(ctx) }) + "\n", { mode: 0o600, dirMode: 0o700 });
}

/**
 * The values a command in `scope` gets for `env`: global ones, overridden by the repo's own.
 * Switched-off values are left out; a repo value that's off lets the global one through, the way
 * commenting a line out of .env.local lets .env's value through.
 */
export function itemsFor(v: VaultState, scope: string | null, env: string): VaultItem[] {
  const byName = new Map<string, VaultItem>();
  const on = (i: VaultItem) => i.enabled !== false && i.env === env;
  for (const i of v.items) if (on(i) && i.scope === GLOBAL_SCOPE) byName.set(i.name, i);
  if (scope) for (const i of v.items) if (on(i) && i.scope === scope) byName.set(i.name, i);
  return [...byName.values()];
}

/**
 * Replaces secret values in streamed output with `***`. A value split across two chunks is
 * still caught: the end of a chunk that could be the start of a value is held back until the
 * next chunk (or `flush`).
 */
export class Masker {
  private values: string[];
  private held = "";
  constructor(values: string[]) {
    // Very short values would mask ordinary text ("1", "yes") without protecting anything.
    this.values = [...new Set(values.filter((v) => v.length >= 6))].sort((a, b) => b.length - a.length);
  }

  push(chunk: string): string {
    let s = this.held + chunk;
    for (const v of this.values) s = s.split(v).join("***");
    let keep = 0;
    for (const v of this.values)
      for (let n = Math.min(v.length - 1, s.length); n > keep; n--)
        if (s.endsWith(v.slice(0, n))) {
          keep = n;
          break;
        }
    this.held = s.slice(s.length - keep);
    return s.slice(0, s.length - keep);
  }

  /** Whatever was held back; it wasn't a whole value after all. */
  flush(): string {
    const s = this.held;
    this.held = "";
    return s;
  }
}

/**
 * `${secret:NAME}` references (local MCP servers) resolve from the secret store first (older
 * values kept in the keychain), then from the vault's global dev values, read from the offline
 * copy with this device's key.
 */
export function withVault(ctx: Context, base: SecretStore): SecretStore {
  let values: Map<string, string> | null = null;
  const vaultValues = () => {
    if (values) return values;
    values = new Map();
    const raw = base.get(vaultKeyName(ctx));
    const cache = loadVaultCache(ctx);
    if (!raw || !cache) return values;
    const key = new Uint8Array(Buffer.from(raw, "base64url"));
    if (vaultKeyId(key) !== cache.keyId) return values;
    for (const i of itemsFor(cache, null, DEFAULT_ENV)) {
      if (!i.ct) continue;
      try {
        values.set(i.name, openValue(key, i));
      } catch {}
    }
    return values;
  };
  return {
    kind: base.kind,
    get: (name) => base.get(name) ?? (SECRET_NAME.test(name) ? (vaultValues().get(name) ?? null) : null),
    set: (name, value) => base.set(name, value),
    delete: (name) => base.delete(name),
  };
}
