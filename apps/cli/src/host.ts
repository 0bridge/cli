import { parseArgs } from "node:util";
import { CloudError, type Context, type McpToolResult } from "@0bridge/core";
import { cloudClient } from "./cloud.ts";

/**
 * `0b host`: hand work to the user's dev machine from any terminal (an agent's computer such as a
 * Dots VM, or a laptop), through the same bridge__host_* tools a chat app calls, by name on the
 * gateway's /mcp with this device's token. On the dev machine `0b agent supervisor ledger` writes
 * a request as a dev_request, a follow-up as a user_followup and an answer as a user_decision
 * into its work ledger. An agent computer's token (`0b setup --agent-vm`) reaches only such a
 * ledger machine; the gateway refuses one on OpenClaw.
 *
 * Exit codes: 0 done, 1 the tool or the gateway refused (printed as it said), 2 a usage mistake.
 */

export const HOST_USAGE = `Usage
  0b host request "<text>"            Hand work to your dev machine's work ledger; prints its request
        [--project p] [--repo r]       id (hr_…), or its task id once it has one
        [--priority P0-P3] [--machine m]
  0b host status [T-012|hr_…]         One task or request, or the recent tasks (--machine m)
  0b host followup <T-012|hr_…> "<text>"   More about a task, or a request with no task id yet
  0b host answer <question> "<text>"  Answer a question from the host (its id, e.g. 45); --choice A
        [--choice A]                   for one that lists options
  0b host questions                   Questions waiting for you (--machine m)
  0b host updates [--cursor c]        New questions, completions, failures and progress since the
        [--wait s] [--kinds k,…]       cursor; the last line is the next cursor, for the next run
                                       (--wait up to 20 s; kinds: question,completed,failed,progress,notice)
  "-" as the text reads it from stdin. --json prints {ok, text, data} for scripts.`;

const SUBS = ["request", "status", "followup", "answer", "questions", "updates"] as const;
type Sub = (typeof SUBS)[number];
const KINDS = ["question", "completed", "failed", "progress", "notice"];

/** One `0b host` command line as the tool call it makes. */
export interface HostCall {
  sub: Sub;
  tool: string;
  args: Record<string, unknown>;
  json: boolean;
}

export class HostUsage extends Error {}

/**
 * The tool call a command line makes, or HostUsage with what's wrong. `readStdin` gives the text
 * when the argument is "-". Pure apart from that, for tests. Null: print the usage.
 */
export async function parseHost(argv: string[], readStdin: () => Promise<string>): Promise<HostCall | null> {
  const parse = () => {
    try {
      return parseArgs({
        args: argv,
        allowPositionals: true,
        strict: true,
        options: {
          project: { type: "string" },
          repo: { type: "string" },
          priority: { type: "string" },
          machine: { type: "string" },
          choice: { type: "string" },
          cursor: { type: "string" },
          wait: { type: "string" },
          kinds: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
      });
    } catch (e) {
      throw new HostUsage((e as Error).message);
    }
  };
  const { values: v, positionals } = parse();
  const [sub, ...rest] = positionals;
  if (v.help || !sub) return null;
  if (!SUBS.includes(sub as Sub)) throw new HostUsage(`unknown command "0b host ${sub}" (${SUBS.join(", ")})`);
  const json = Boolean(v.json);
  const tool = `bridge__host_${sub}`;
  /** The words after the ids: the text, or stdin for "-". */
  const textOf = async (words: string[], what: string) => {
    const t = words.length === 1 && words[0] === "-" ? (await readStdin()).trim() : words.join(" ").trim();
    if (!t) throw new HostUsage(`pass ${what} (or "-" to read it from stdin)`);
    return t;
  };
  const allowed = (names: (keyof typeof v)[]) => {
    const extra = (Object.keys(v) as (keyof typeof v)[]).filter((k) => k !== "json" && k !== "help" && !names.includes(k));
    if (extra.length) throw new HostUsage(`0b host ${sub} doesn't take --${extra.join(", --")}`);
  };
  const machine = v.machine ? { machine: v.machine } : {};
  switch (sub as Sub) {
    case "request": {
      allowed(["project", "repo", "priority", "machine"]);
      const request = await textOf(rest, 'the request: 0b host request "what to do"');
      return {
        sub: "request",
        tool,
        json,
        args: { request, ...(v.project ? { project: v.project } : {}), ...(v.repo ? { repo: v.repo } : {}), ...(v.priority ? { priority: v.priority.toUpperCase() } : {}), ...machine },
      };
    }
    case "status": {
      allowed(["machine"]);
      if (rest.length > 1) throw new HostUsage("0b host status [T-012|hr_…]: one id at most");
      const id = rest[0]?.trim();
      return { sub: "status", tool, json, args: { ...(id ? (/^hr_/.test(id) ? { request: id } : { task: id }) : {}), ...machine } };
    }
    case "followup": {
      allowed(["machine"]);
      const [task, ...words] = rest;
      if (!task) throw new HostUsage('0b host followup <T-012|hr_…> "<text>"');
      return { sub: "followup", tool, json, args: { task, text: await textOf(words, 'the follow-up: 0b host followup T-012 "more"'), ...machine } };
    }
    case "answer": {
      allowed(["choice", "machine"]);
      const [question, ...words] = rest;
      if (!question || !/^#?\d+$/.test(question)) throw new HostUsage('0b host answer <question id, e.g. 45> "<text>"');
      return {
        sub: "answer",
        tool,
        json,
        args: { question: question.replace(/^#/, ""), text: await textOf(words, 'the answer: 0b host answer 45 "B, and keep the old page"'), ...(v.choice ? { choice: v.choice } : {}), ...machine },
      };
    }
    case "questions":
      allowed(["machine"]);
      if (rest.length) throw new HostUsage("0b host questions takes no arguments (--machine m)");
      return { sub: "questions", tool, json, args: { ...machine } };
    case "updates": {
      allowed(["cursor", "wait", "kinds"]);
      if (rest.length) throw new HostUsage("0b host updates takes no arguments (--cursor c, --wait s, --kinds k,…)");
      const args: Record<string, unknown> = {};
      if (v.cursor !== undefined && v.cursor.trim()) args.cursor = v.cursor.trim();
      if (v.wait !== undefined) {
        const w = Number(v.wait);
        if (!Number.isFinite(w) || w < 0 || w > 20) throw new HostUsage("--wait is 0 to 20 seconds");
        args.wait = w;
      }
      if (v.kinds !== undefined) {
        const kinds = v.kinds.split(",").map((k) => k.trim()).filter(Boolean);
        const bad = kinds.filter((k) => !KINDS.includes(k));
        if (!kinds.length || bad.length) throw new HostUsage(`--kinds takes ${KINDS.join(", ")}${bad.length ? ` (not ${bad.join(", ")})` : ""}`);
        args.kinds = kinds;
      }
      return { sub: "updates", tool, json, args };
    }
  }
}

/** The tools' words for the commands here: bridge__host_status task=T-012 is `0b host status T-012`. */
export function cliWords(s: string): string {
  return s
    .replace(/bridge__host_(status|followup) (?:task|request)=([A-Za-z0-9_-]+)/g, "0b host $1 $2")
    .replace(/bridge__host_(request|status|followup|answer|questions|updates)\b/g, "0b host $1");
}

/** What a tool's result prints: stdout, and whether it was an error (stderr, exit 1). */
export function renderHost(call: HostCall, r: McpToolResult): { out: string; error: boolean } {
  const text = r.content.map((c) => c.text ?? "").join("\n").trim();
  const data = r.structuredContent ?? null;
  const error = Boolean(r.isError);
  if (call.json) return { out: JSON.stringify({ ok: !error, text, data }, null, 2), error };
  if (error) return { out: cliWords(text), error };
  const lines = [cliWords(text)];
  // request: its id on a line of its own first (the task's once it has one, else hr_…).
  if (call.sub === "request") {
    const id = typeof data?.task === "string" ? data.task : typeof data?.request === "string" ? data.request : null;
    if (id) lines.unshift(id);
  }
  // updates: the next cursor alone on the last line, for a scheduled run to keep.
  if (call.sub === "updates" && data && data.cursor != null) lines.push(String(data.cursor));
  return { out: lines.join("\n"), error };
}

async function readAll(): Promise<string> {
  if (process.stdin.isTTY) throw new HostUsage('"-" reads the text from stdin: pipe it in (echo "…" | 0b host request -)');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** `0b host …`: exits 1 on a refusal, 2 on a usage mistake. */
export async function hostCommand(ctx: Context, argv: string[], version = "dev"): Promise<void> {
  let call: HostCall | null;
  try {
    call = await parseHost(argv, readAll);
  } catch (e) {
    if (!(e instanceof HostUsage)) throw e;
    console.error(`error: ${e.message}\n\n${HOST_USAGE}`);
    process.exit(2);
  }
  if (!call) return console.log(HOST_USAGE);
  let r: McpToolResult;
  try {
    r = await cloudClient(ctx).client.callTool(call.tool, call.args, { name: "0b host", version });
  } catch (e) {
    const msg = e instanceof CloudError || e instanceof Error ? e.message : String(e);
    if (call.json) console.log(JSON.stringify({ ok: false, text: msg, data: null }, null, 2));
    else console.error(msg);
    process.exit(1);
  }
  const { out, error } = renderHost(call, r);
  if (error && !call.json) console.error(out);
  else console.log(out);
  if (error) process.exit(1);
}
