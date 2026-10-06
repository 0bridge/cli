// No imports: the gateway (a Worker), the dashboard and the CLI all use this. WebCrypto only.

/** The sign-in code's alphabet: Better Auth's device codes (no I, O, 0 or 1 to misread). */
export const LOGIN_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LABEL = "0bridge sign-in code v1\n";

/**
 * The code `0b login` shows (ABCD2345, without the dash) when it asks for the vault key with the
 * sign-in: made from the new machine's public key (base64url), so the code the person already
 * compares on the approval page also shows the page is encrypting the key to that machine (T-039).
 * 40 bits, like the pairing code.
 */
export async function loginCode(devicePub: string): Promise<string> {
  const b = devicePub.replaceAll("-", "+").replaceAll("_", "/");
  const pub = Uint8Array.from(atob(b + "=".repeat((4 - (b.length % 4)) % 4)), (ch) => ch.charCodeAt(0));
  const label = new TextEncoder().encode(LABEL);
  const data = new Uint8Array(label.length + pub.length);
  data.set(label);
  data.set(pub, label.length);
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  let code = "";
  let acc = 0;
  let bits = 0;
  for (const x of h.subarray(0, 5)) {
    acc = (acc << 8) | x;
    bits += 8;
    while (bits >= 5) {
      code += LOGIN_CODE_CHARS[(acc >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return code;
}
