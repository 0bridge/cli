/**
 * The hook `0b project cloud` commits as .0bridge/hooks/push.mjs (D49, round 2 R5). Claude Code on
 * the web runs it (see .claude/settings.json): as a prompt is sent, when the session waits for the
 * user, and when a turn or the session ends, it posts the session's state to the user's session
 * board; when a turn or the session ends it also sends the transcript's new complete lines to
 * 0bridge, so the cloud session is searchable and resumable from every other tool. Both with the
 * project token from ZEROB_TOKEN. Anywhere else (a laptop, where `0b history` and `0b sessions`
 * already work) it does nothing. Plain Node 18+, no dependencies: the cloud machine has no 0b CLI.
 * It never fails the turn: every error ends in exit 0.
 */

export const CLOUD_HOOK_PATH = ".0bridge/hooks/push.mjs";
export const CLOUD_HOOK_COMMAND = `node "$CLAUDE_PROJECT_DIR/${CLOUD_HOOK_PATH}"`;

export function cloudHookScript(server: string): string {
  return `#!/usr/bin/env node
// 0bridge: shows what this Claude Code on the web session is doing on your session board, and
// uploads it to your 0bridge history, so you can search and continue it from any AI tool. Written
// by \`0b project cloud\`; runs only in the cloud (CLAUDE_CODE_REMOTE=true) with ZEROB_TOKEN set,
// and never fails the turn.
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER = ${JSON.stringify(server.replace(/\/+$/, ""))};
const MAX = 2 * 1024 * 1024; // the server takes up to 2 MB of lines per request
const token = process.env.ZEROB_TOKEN;
if (!token || process.env.CLAUDE_CODE_REMOTE !== "true") process.exit(0);
const auth = { Authorization: \`Bearer \${token}\` };

// Keys pasted into a prompt are masked here already (and again on the server).
const KEYS = [/\\b(?:sk|pk|rk)-[A-Za-z0-9_-]{20,}/g, /\\bAKIA[0-9A-Z]{16}\\b/g, /\\bgh[pousr]_[A-Za-z0-9]{30,}/g, /\\bgithub_pat_[A-Za-z0-9_]{40,}/g, /\\bxox[abposr]-[A-Za-z0-9-]{10,}/g, /\\bAIza[0-9A-Za-z_-]{35}/g, /\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}/g];
const line = (s) => {
  let l = typeof s === "string" ? (s.split("\\n").map((x) => x.trim()).find(Boolean) ?? "") : "";
  for (const re of KEYS) l = l.replace(re, "[secret]");
  return l ? [l.slice(0, 200)] : [];
};

/** The session board: working (a prompt), needs you (a permission or a question), idle (turn done), ended. */
async function status(input, id, branch) {
  const ev = input.hook_event_name;
  const type = String(input.notification_type ?? "");
  const s =
    ev === "UserPromptSubmit" ? ["working", null, input.prompt]
    : ev === "Notification" && (/permission/.test(type) || (!type && /permission/i.test(input.message ?? ""))) ? ["needs-you", "permission", input.message]
    : ev === "Notification" && /elicitation|needs_input/.test(type) ? ["needs-you", "input", input.message]
    : ev === "Stop" ? ["idle", null, input.last_assistant_message]
    : ev === "SessionEnd" ? ["ended", null, null]
    : null;
  if (!s) return;
  // While history is end-to-end encrypted the server answers text: false, and no lines go up after that.
  const noText = join(process.env.TMPDIR || tmpdir(), "0b-status-no-text");
  const update = { tool: "claude-web", native: id, state: s[0], ...(s[1] ? { reason: s[1] } : {}), at: Date.now(), ...(input.cwd ? { cwd: input.cwd } : {}), ...(branch ? { branch } : {}), lines: existsSync(noText) ? [] : line(s[2]) };
  const res = await fetch(\`\${SERVER}/api/status\`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ updates: [update] }), signal: AbortSignal.timeout(5000) }).catch(() => null);
  const text = res && res.ok ? (await res.json().catch(() => ({}))).text : undefined;
  if (text === false) writeFileSync(noText, "");
  else if (text === true) rmSync(noText, { force: true });
}

const stdin = () =>
  new Promise((done) => {
    let s = "";
    process.stdin.setEncoding("utf8").on("data", (d) => (s += d)).on("end", () => done(s)).on("error", () => done(s));
    setTimeout(() => done(s), 2000).unref();
  });

async function main() {
  const input = JSON.parse((await stdin()) || "{}");
  const path = input.transcript_path;
  const id = String(input.session_id ?? "");
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(id)) return;
  let branch = "";
  try {
    branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: input.cwd || process.cwd(), encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {}
  if (branch === "HEAD") branch = "";
  await status(input, id, branch);
  // The transcript goes up when a turn or the session ends.
  if (!path || (input.hook_event_name && input.hook_event_name !== "Stop" && input.hook_event_name !== "SessionEnd")) return;
  const stateFile = join(process.env.TMPDIR || tmpdir(), \`0b-ingest-\${id}.json\`);
  let st = { offset: 0, seq: 0 };
  try {
    st = { ...st, ...JSON.parse(readFileSync(stateFile, "utf8")) };
  } catch {}
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size < st.offset) st = { offset: 0, seq: 0 }; // rewritten: start over
    while (st.offset < size) {
      const buf = Buffer.alloc(Math.min(MAX, size - st.offset));
      const n = readSync(fd, buf, 0, buf.length, st.offset);
      const end = buf.subarray(0, n).lastIndexOf(0x0a);
      if (end < 0) {
        // One line longer than a request (a pasted image): skip it once it's complete.
        if (n < MAX) break;
        const rest = Buffer.alloc(Math.min(64 * 1024 * 1024, size - st.offset));
        const next = rest.subarray(0, readSync(fd, rest, 0, rest.length, st.offset)).indexOf(0x0a);
        if (next < 0) break;
        st.offset += next + 1;
        continue;
      }
      const q = new URLSearchParams({ native: id, seq: String(st.seq), ...(input.cwd ? { cwd: input.cwd } : {}), ...(branch ? { branch } : {}) });
      const res = await fetch(\`\${SERVER}/api/ingest/claude-code?\${q}\`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "text/plain; charset=utf-8" },
        body: buf.subarray(0, end + 1),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) break;
      st = { offset: st.offset + end + 1, seq: (await res.json()).seq };
      writeFileSync(stateFile, JSON.stringify(st));
    }
  } finally {
    closeSync(fd);
  }
}

main().catch(() => {}).finally(() => process.exit(0));
`;
}
