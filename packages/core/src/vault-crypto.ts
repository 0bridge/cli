// No imports: the dashboard (apps/web) bundles this for the browser, and the CLI uses it in Node.
// Everything is WebCrypto, so both sides compute the same bytes.

/**
 * The vault's key handling that happens outside the CLI's own machine (D28 step 4):
 *  - opening values in the dashboard (same format as the CLI's AES-256-GCM seal),
 *  - wrapping the vault key with a passkey's PRF output, so a passkey can unlock the dashboard,
 *  - handing the vault key to a new machine over the gateway without the gateway reading it
 *    (ECDH P-256; both screens show a code derived from the new machine's public key, so a
 *    gateway that swapped the key would be caught).
 */

const subtle = () => globalThis.crypto.subtle;
const te = new TextEncoder();

export const b64u = (b: ArrayBuffer | Uint8Array): string => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (const x of u) s += String.fromCharCode(x);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

export const unb64u = (s: string): Uint8Array<ArrayBuffer> => {
  const b = s.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(b + "=".repeat((4 - (b.length % 4)) % 4)), (c) => c.charCodeAt(0));
};

// ── Recovery key: the vault key itself, in a form people can store and type ──
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(acc >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

export function formatRecoveryKey(key: Uint8Array): string {
  return `0B-${base32(key).match(/.{1,4}/g)!.join("-")}`;
}

export function parseRecoveryKey(text: string): Uint8Array<ArrayBuffer> {
  const s = text.trim().toUpperCase().replace(/^0B[\s-]?/, "").replace(/[\s-]/g, "");
  if (!/^[A-Z2-7]{52}$/.test(s)) throw new Error("that isn't a vault recovery key (0B-XXXX-XXXX-…)");
  const out = new Uint8Array(32);
  let bits = 0;
  let acc = 0;
  let n = 0;
  for (const ch of s) {
    acc = (acc << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8 && n < 32) {
      out[n++] = (acc >> (bits - 8)) & 255;
      bits -= 8;
    }
  }
  return out;
}

/** Same id as the CLI's `vaultKeyId`: an HMAC of a fixed label, to recognize a key without revealing it. */
export async function keyIdOf(key: Uint8Array<ArrayBuffer>): Promise<string> {
  const k = await subtle().importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await subtle().sign("HMAC", k, te.encode("0bridge vault key id v1")));
  return [...mac.slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Seal a value the way the CLI does, so either side can open it. */
export async function sealValueAsync(key: Uint8Array<ArrayBuffer>, at: { scope: string; env: string; name: string }, value: string): Promise<string> {
  const k = await subtle().importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const aad = te.encode(`0bridge vault v1\n${at.scope}\n${at.env}\n${at.name}`);
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv, additionalData: aad }, k, te.encode(value)));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return `v1.${b64u(out)}`;
}

/** Open a value sealed by the CLI (`v1.` + base64url(iv ‖ ciphertext ‖ tag), place as AAD). */
export async function openValueAsync(key: Uint8Array<ArrayBuffer>, item: { scope: string; env: string; name: string; ct: string | null }): Promise<string> {
  if (!item.ct?.startsWith("v1.")) throw new Error(`${item.name} isn't available`);
  const raw = unb64u(item.ct.slice(3));
  const k = await subtle().importKey("raw", key, "AES-GCM", false, ["decrypt"]);
  const aad = te.encode(`0bridge vault v1\n${item.scope}\n${item.env}\n${item.name}`);
  const pt = await subtle().decrypt({ name: "AES-GCM", iv: raw.slice(0, 12), additionalData: aad }, k, raw.slice(12));
  return new TextDecoder().decode(pt);
}

/** A value's note is sealed next to it, under a name no value can have (same as the CLI's `noteAt`). */
const noteAt = (at: { scope: string; env: string; name: string }) => ({ scope: at.scope, env: at.env, name: `${at.name}#note` });
export const sealNoteAsync = (key: Uint8Array<ArrayBuffer>, at: { scope: string; env: string; name: string }, text: string) => sealValueAsync(key, noteAt(at), text);
export async function openNoteAsync(key: Uint8Array<ArrayBuffer>, item: { scope: string; env: string; name: string; note?: string | null }): Promise<string | null> {
  if (!item.note) return null;
  return openValueAsync(key, { ...noteAt(item), ct: item.note }).catch(() => null);
}

async function hkdfAesKey(secret: Uint8Array<ArrayBuffer>, info: string): Promise<CryptoKey> {
  const base = await subtle().importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return subtle().deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: te.encode(info) }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function seal(k: CryptoKey, data: Uint8Array<ArrayBuffer>, aad: Uint8Array<ArrayBuffer>): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv, additionalData: aad }, k, data));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return b64u(out);
}

async function unseal(k: CryptoKey, blob: string, aad: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const raw = unb64u(blob);
  return new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: raw.slice(0, 12), additionalData: aad }, k, raw.slice(12)));
}

// ── Passkey unlock (WebAuthn PRF) ──
const PRF_INFO = "0bridge vault passkey unlock v1";

/** The vault key, encrypted with a key derived from one passkey's PRF output. Bound to that credential. */
export async function wrapWithPrf(vaultKey: Uint8Array<ArrayBuffer>, prfOutput: Uint8Array<ArrayBuffer>, credentialId: string): Promise<string> {
  return seal(await hkdfAesKey(prfOutput, PRF_INFO), vaultKey, te.encode(credentialId));
}

export async function unwrapWithPrf(wrapped: string, prfOutput: Uint8Array<ArrayBuffer>, credentialId: string): Promise<Uint8Array<ArrayBuffer>> {
  return unseal(await hkdfAesKey(prfOutput, PRF_INFO), wrapped, te.encode(credentialId));
}

// ── Handing the key to a new machine ──
const PAIR_INFO = "0bridge vault pairing v1";
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

/** The code both screens show: from the new machine's public key, so the approver sees the key it's encrypting to. */
export async function pairingCode(devicePub: string): Promise<string> {
  const h = new Uint8Array(await subtle().digest("SHA-256", unb64u(devicePub)));
  const c = base32(h).slice(0, 8);
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}

/** New machine: a key pair for this one request. Keep `privateKey` in memory; send `publicKey`. */
export async function pairingKeyPair(): Promise<{ privateKey: CryptoKey; publicKey: string }> {
  const kp = (await subtle().generateKey(ECDH, false, ["deriveBits"])) as CryptoKeyPair;
  return { privateKey: kp.privateKey, publicKey: b64u(await subtle().exportKey("raw", kp.publicKey)) };
}

async function sharedKey(priv: CryptoKey, pub: string): Promise<CryptoKey> {
  const peer = await subtle().importKey("raw", unb64u(pub), ECDH, false, []);
  const bits = new Uint8Array(await subtle().deriveBits({ name: "ECDH", public: peer }, priv, 256));
  return hkdfAesKey(bits, PAIR_INFO);
}

/** Approving machine or dashboard: encrypt the vault key to the new machine's public key. */
export async function sealForDevice(vaultKey: Uint8Array<ArrayBuffer>, devicePub: string): Promise<{ ephemeralPub: string; ct: string }> {
  const eph = (await subtle().generateKey(ECDH, false, ["deriveBits"])) as CryptoKeyPair;
  const ct = await seal(await sharedKey(eph.privateKey, devicePub), vaultKey, unb64u(devicePub));
  return { ephemeralPub: b64u(await subtle().exportKey("raw", eph.publicKey)), ct };
}

/** New machine: recover the vault key from the approval. */
export async function openFromApprover(privateKey: CryptoKey, devicePub: string, ephemeralPub: string, ct: string): Promise<Uint8Array<ArrayBuffer>> {
  return unseal(await sharedKey(privateKey, ephemeralPub), ct, unb64u(devicePub));
}

// ── Pasting .env files ──

/** KEY=value lines, as dotenv reads them: comments, `export`, quotes, escaped newlines in double quotes. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*('(?:[^'])*'|"(?:\\.|[^"\\])*"|[^\n]*)\s*$/gm;
  for (const m of text.matchAll(re)) {
    let v = m[2]!.trim();
    if (v.startsWith("'")) v = v.slice(1, -1);
    else if (v.startsWith('"')) v = v.slice(1, -1).replace(/\\n/g, "\n").replace(/\\(["\\])/g, "$1");
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]!] = v;
  }
  return out;
}

export type VaultKind = "secret" | "variable";

const SECRET_NAME_HINT = /(key|token|secret|passw|pwd|auth|credential|cookie|session|private|signing|salt|dsn|webhook)/i;
const PUBLIC_PREFIX = /^(NEXT_PUBLIC|VITE|EXPO_PUBLIC|PUBLIC|REACT_APP|NUXT_PUBLIC)_/;
const PLAIN_NAME_HINT = /^(NODE_ENV|PORT|HOST|HOSTNAME|TZ|LOG_LEVEL|DEBUG|ENV|ENVIRONMENT|APP_ENV|REGION|.*_(PORT|HOST|REGION|ENV|MODE|LEVEL|NAME|VERSION))$/;

/**
 * A first guess for pasted values: public-looking settings (PORT, NODE_ENV, NEXT_PUBLIC_*) are
 * variables, everything else is a secret (when unsure, hide it). URLs with credentials in them are secrets. The user
 * can switch any of them.
 */
export function guessKind(name: string, value: string): VaultKind {
  // Shipped to browsers by the framework anyway (NEXT_PUBLIC_…_KEY included).
  if (PUBLIC_PREFIX.test(name)) return "variable";
  if (SECRET_NAME_HINT.test(name)) return "secret";
  if (/:\/\/[^/\s:@]+:[^/\s@]+@/.test(value)) return "secret";
  if (PLAIN_NAME_HINT.test(name)) return "variable";
  if (/^(true|false|\d{1,6}|[a-z]+)$/i.test(value) && value.length <= 12) return "variable";
  return "secret";
}

/**
 * A value that names this machine (localhost, 127.0.0.1, a Docker host alias): a local database
 * or dev server address. Stored in the vault, every other machine gets the same address, which
 * usually means the wrong thing there, so an import points these out before storing them.
 */
export function pointsAtThisMachine(value: string): boolean {
  return /(^|[/@:\s=])(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal)([:/\s]|$)/i.test(value);
}
