/**
 * Secret masking for session text (moved here from @0bridge/core's history.ts). Pure, no fs: the
 * CLI masks before anything leaves a machine, and the gateway masks again what reaches it another
 * way (a chat app saving a session, a cloud agent's transcript).
 */

/**
 * Credentials with a recognizable shape. Masked before anything leaves the machine, on top of the
 * vault's own values; a conversation that pasted a key shouldn't put it in the cloud.
 */
export const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk)-(?:live|test|proj|ant|or)?[-_]?[A-Za-z0-9_-]{20,}/g, // OpenAI, Anthropic, Stripe, OpenRouter
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\bya29\.[0-9A-Za-z_-]{20,}/g, // Google OAuth access token
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b0B(?:-[A-Z2-7]{4}){13}\b/g, // 0bridge vault recovery key
  /(?<=:\/\/[^\s/:@]+:)[^\s/@]{6,}(?=@)/g, // password in a URL
  // KEY=value / "token": "value" where the name says it's a secret
  /(?<=\b[A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|ACCESS_KEY)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?)[^\s"'`,;]{8,}/gi,
];

/** Mask known secret values (from the vault) and anything shaped like a credential. */
export function redact(text: string, values: string[] = []): string {
  let s = text;
  for (const v of [...new Set(values.filter((v) => v.length >= 6))].sort((a, b) => b.length - a.length)) s = s.split(v).join("[secret]");
  for (const re of SECRET_PATTERNS) s = s.replace(re, "[secret]");
  return s;
}
