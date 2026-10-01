/**
 * Helpers the converters share: lenient JSON and time parsing, what counts as injected context,
 * and how an agent's question to the person (and the answer) reads as conversation.
 */

/** A message longer than this is clipped in the conversation (the upload rule, D34). */
export const MAX_MESSAGE = 16 * 1024;
/** Tool output kept on an event; longer output is clipped so a big file read doesn't fill memory. */
export const MAX_OUTPUT = 16 * 1024;

export const clip = (s: string, n = MAX_MESSAGE) => (s.length > n ? `${s.slice(0, n)}… [${s.length - n} more characters]` : s);

/** Milliseconds from an ISO date, epoch milliseconds, or a string of digits; 0 when it isn't one. */
export const ms = (t: unknown) => (typeof t === "string" || typeof t === "number" ? new Date(typeof t === "string" && /^\d+$/.test(t) ? Number(t) : t).getTime() || 0 : 0);

export const json = (line: string): any => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

/** Text the tool injected rather than the person typed (environment, instructions, command wrappers). */
export const injected = (t: string) =>
  /^\s*<(?:[a-z_-]+-)?(?:environment_context|user_instructions|permissions instructions|app-context|recommended_plugins|external_openclaw_|command-|local-command-|system-reminder|INSTRUCTIONS|turn_aborted|user_info|rules|topic)/i.test(t) ||
  /^\s*<(?:skill|subagent_notification|task-notification)>/i.test(t) ||
  /^(?:Caveat: The messages below|The following is the Codex agent history|# AGENTS\.md instructions for|This session is being continued from a previous conversation)/.test(t);

/**
 * OpenClaw sends each chat message to Codex wrapped in its runtime context (workspace files,
 * channel history); the person's words come after the last "System: [time] … from …" line.
 * Text without that wrapper comes back as is; a wrapper with no message comes back empty.
 */
export function unwrapOpenClaw(t: string): string {
  if (!/^\[OpenClaw conversation info/.test(t)) return t;
  const parts = t.split(/\n\nSystem: \[[^\]\n]+\] [^\n]*\n\n/);
  return parts.length > 1 ? parts.at(-1)!.trim() : "";
}

/** Tools an agent uses to ask the person something; their question and the answer are conversation. */
export const ASKS = /^(?:AskUserQuestion|ask_user_question|ask_?user|request_user_input|ask_question)$/i;

/** "Which account?\n- A\n- B" from a question tool's input. */
export function questionText(input: any): string {
  const qs: any[] = Array.isArray(input?.questions) ? input.questions : input?.question ? [input] : [];
  if (!qs.length) return typeof input === "string" ? input : JSON.stringify(input ?? {});
  return qs
    .map((q) => [String(q.question ?? q.prompt ?? ""), ...(Array.isArray(q.options) ? q.options.map((o: any) => `- ${o?.label ?? o}`) : [])].join("\n"))
    .join("\n\n");
}

/** The person's answers from a question tool's result. */
export function answerText(result: unknown, structured?: any): string {
  const answers = structured?.answers;
  if (answers && typeof answers === "object") return Object.values(answers).map(String).join("\n");
  const text = typeof result === "string" ? result : Array.isArray(result) ? result.map((b: any) => b?.text ?? "").join("\n") : JSON.stringify(result ?? "");
  const pairs = [...text.matchAll(/"[^"]*"="([^"]*)"/g)].map((m) => m[1]);
  return pairs.length ? pairs.join("\n") : text.replace(/\s*Read the answers carefully[\s\S]*$/, "");
}

/** A tool's output as text: strings as they are, content blocks by their text, anything else as JSON. */
export function outputText(o: unknown): string {
  const s =
    typeof o === "string"
      ? o
      : Array.isArray(o) && o.every((b) => b && typeof b === "object" && typeof (b as any).text === "string")
        ? o.map((b: any) => b.text).join("\n")
        : JSON.stringify(o ?? "");
  return clip(s, MAX_OUTPUT);
}

/** JSON arguments as an object when they parse, else as they came. */
export const args = (a: unknown): unknown => (typeof a === "string" ? (json(a) ?? a) : a);
