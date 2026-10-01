// No imports: the web dashboard bundles this for the browser.
/**
 * Notes are shown in lists, which agents read, so a key pasted into one leaks. A run of 20+
 * characters with no spaces that mixes letters and digits and looks random (an R2 or Cloudflare
 * key, a long hex secret) counts, besides the shapes known tokens have.
 */
const RANDOM_RUN = /[A-Za-z0-9_\-+/=.]{20,}/g;
function looksRandom(run: string): boolean {
  if (!/[0-9]/.test(run) || !/[A-Za-z]/.test(run) || /^https?:|\//.test(run)) return false;
  const counts = new Map<string, number>();
  for (const ch of run) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / run.length) * Math.log2(n / run.length);
  return bits >= 3;
}
const KNOWN_TOKEN = [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bgh[pousr]_[A-Za-z0-9]{30,}\b/, /\bxox[abposr]-[A-Za-z0-9-]{10,}/, /\bAIza[0-9A-Za-z_-]{35}\b/, /\beyJ[A-Za-z0-9_-]{10,}\./, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];
export const noteHasCredential = (text: string) => KNOWN_TOKEN.some((re) => re.test(text)) || (text.match(RANDOM_RUN) ?? []).some(looksRandom);
/** A note with anything key-shaped replaced by ***, for showing it. */
export const maskNote = (text: string) => text.replace(RANDOM_RUN, (run) => (looksRandom(run) || KNOWN_TOKEN.some((re) => re.test(run)) ? "***" : run));
