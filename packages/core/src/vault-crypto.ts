// No imports: the dashboard bundles this for the browser, and the CLI uses it in Node.
// Everything is WebCrypto, so both sides compute the same bytes.

/**
 * The vault's key handling that happens outside the CLI's own machine:
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

export { LOGIN_CODE_CHARS, loginCode } from "./login-code.ts";

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
