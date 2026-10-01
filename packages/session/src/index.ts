/**
 * @0bridge/session: the 0b.session/1 schema, pure converters from each AI tool's logs, secret
 * masking and a DTI export. No fs and no network, so the CLI and the gateway (a Worker) share it.
 */

import { SCHEMA } from "./types";

export * from "./types";
export { redact } from "./redact";
export { HOUR_MS, addTokens, bucketKey, countsOf, isEmpty, noTokens, parseBucket, sumUsage, totalTokens } from "./usage";
export { converters, codexTool, cursorAgentMessageIds, fromCursorBubbles, fromHermesMessages, toConversation, type HermesMessage } from "./convert/index";
export { toDti, type DtiConversation } from "./export/dti";
export { injected, unwrapOpenClaw } from "./text";

const VENDORS = ["anthropic", "openai", "google", "xai", "cursor", "meta", "nous", "openclaw", "other"];
const ROLES = ["user", "assistant", "system", "tool"];

type Check = (x: any, at: string, errors: string[]) => void;

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const str: Check = (x, at, e) => void (typeof x !== "string" && e.push(`${at}: expected a string`));
const num: Check = (x, at, e) => void ((typeof x !== "number" || !Number.isFinite(x)) && e.push(`${at}: expected a number`));
const int: Check = (x, at, e) => void ((!Number.isInteger(x) || x < 0) && e.push(`${at}: expected a non-negative integer`));
const bool: Check = (x, at, e) => void (typeof x !== "boolean" && e.push(`${at}: expected true or false`));
const oneOf =
  (values: string[]): Check =>
  (x, at, e) =>
    void (!values.includes(x) && e.push(`${at}: expected one of ${values.join(", ")}`));

/** Check an object's fields: required ones must be there, optional ones may be missing (not null). */
function fields(x: unknown, at: string, e: string[], required: Record<string, Check>, optional: Record<string, Check> = {}): x is Record<string, any> {
  if (!isObj(x)) {
    e.push(`${at}: expected an object`);
    return false;
  }
  for (const [k, c] of Object.entries(required)) x[k] === undefined ? e.push(`${at}.${k}: required`) : c(x[k], `${at}.${k}`, e);
  for (const [k, c] of Object.entries(optional)) if (x[k] !== undefined) c(x[k], `${at}.${k}`, e);
  return true;
}

const part: Check = (p, at, e) => {
  if (!isObj(p)) return void e.push(`${at}: expected an object`);
  switch (p.type) {
    case "text":
    case "thinking":
      return void fields(p, at, e, { text: str }, { redacted: bool });
    case "tool_call":
      return void fields(p, at, e, { callId: str, name: str }, {});
    case "tool_result":
      return void fields(p, at, e, { callId: str, output: str }, { isError: bool });
    case "file":
      return void fields(p, at, e, { mime: str }, { uri: str, sha256: str });
    default:
      e.push(`${at}.type: expected text, thinking, tool_call, tool_result or file`);
  }
};

const event: Check = (ev, at, e) =>
  void fields(ev, at, e, { id: str, seq: int, ts: num, role: oneOf(ROLES), parts: (x, a, er) => void (Array.isArray(x) ? x.forEach((p, i) => part(p, `${a}[${i}]`, er)) : er.push(`${a}: expected an array`)) }, { model: str, injected: bool, ask: oneOf(["question", "answer"]), raw: (x, a, er) => void fields(x, a, er, { line: int }) });

/**
 * Check a session document against 0b.session/1: a Session, optionally with its `events`
 * (`Session & { events?: Event[] }`, the shape of schema/session-1.json).
 */
export function validate(x: unknown): { ok: true } | { ok: false; errors: string[] } {
  const e: string[] = [];
  const ok = fields(
    x,
    "$",
    e,
    {
      schema: (v, at, er) => void (v !== SCHEMA && er.push(`${at}: expected "${SCHEMA}"`)),
      id: (v, at, er) => void (typeof v !== "string" || !/^[a-z][a-z0-9-]*:./.test(v) ? er.push(`${at}: expected "<tool>:<native id>"`) : undefined),
      source: (v, at, er) => void fields(v, at, er, { vendor: oneOf(VENDORS), product: str, tool: str, nativeId: str }, { host: str, account: str }),
      createdAt: num,
      updatedAt: num,
    },
    {
      title: str,
      cwd: str,
      model: str,
      parentId: str,
      repo: (v, at, er) => void fields(v, at, er, {}, { remote: str, branch: str, commit: str }),
      resume: (v, at, er) => void fields(v, at, er, { kind: oneOf(["native-cli", "acp", "none"]) }, { command: str, nativeId: str }),
      usage: (v, at, er) => void fields(v, at, er, {}, { inputTokens: num, outputTokens: num }),
      x: (v, at, er) => void (!isObj(v) && er.push(`${at}: expected an object`)),
      events: (v, at, er) => void (Array.isArray(v) ? v.forEach((ev, i) => event(ev, `${at}[${i}]`, er)) : er.push(`${at}: expected an array`)),
    },
  );
  if (ok) {
    const s = x as Record<string, any>;
    if (typeof s.id === "string" && typeof s.source?.tool === "string" && !s.id.startsWith(`${s.source.tool}:`)) e.push(`$.id: expected to start with source.tool ("${s.source.tool}:")`);
  }
  return e.length ? { ok: false, errors: e } : { ok: true };
}
