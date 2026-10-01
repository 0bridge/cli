import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { converters, cursorAgentMessageIds, unwrapOpenClaw, fromCursorBubbles, fromHermesMessages, SCHEMA, toConversation, validate, type ConverterId, type Event, type ParseResult } from "../src/index.ts";

/**
 * Each converter against its fixtures (synthetic, scrubbed): the conversation and metadata match
 * the reviewed `.expected.json` next to each fixture (UPDATE_FIXTURES=1 rewrites them), the events
 * are valid 0b.session/1, and reading a log in two pieces gives exactly what reading it whole does.
 */

const FIXTURES = join(import.meta.dir, "fixtures");
const ids = Object.keys(converters) as ConverterId[];

const fixtures = (id: ConverterId) =>
  existsSync(join(FIXTURES, id))
    ? readdirSync(join(FIXTURES, id))
        .filter((f) => !f.endsWith(".expected.json"))
        .sort()
    : [];

const lines = (id: ConverterId, f: string) => readFileSync(join(FIXTURES, id, f), "utf8").replace(/\n$/, "").split("\n");

/** A whole-document format (Gemini) is passed whole each time; its pieces are growing prefixes. */
const whole = (id: ConverterId) => id === "gemini-cli";

function doc(id: ConverterId, r: ParseResult, events: Event[]) {
  const tool = r.state.tool ?? id;
  return { schema: SCHEMA, id: `${tool}:fixture`, source: { vendor: "other", product: id, tool, nativeId: "fixture" }, createdAt: 0, updatedAt: 0, events };
}

describe("converters", () => {
  for (const id of ids) {
    test(`${id} has at least 3 fixtures`, () => expect(fixtures(id).length).toBeGreaterThanOrEqual(3));
    for (const f of fixtures(id)) {
      const src = lines(id, f);
      const one = converters[id](src);

      test(`${id}/${f}: conversation and metadata`, () => {
        const got = { meta: one.meta, conversation: toConversation(one.events) };
        const path = join(FIXTURES, id, f.replace(/\.jsonl?$/, ".expected.json"));
        if (process.env.UPDATE_FIXTURES || !existsSync(path)) writeFileSync(path, JSON.stringify(got, null, 2) + "\n");
        expect(got).toEqual(JSON.parse(readFileSync(path, "utf8")));
      });

      test(`${id}/${f}: events are valid 0b.session/1`, () => {
        const v = validate(doc(id, one, one.events));
        expect(v).toEqual({ ok: true });
        expect(one.events.map((e) => e.seq)).toEqual(one.events.map((_, i) => i));
        // Reasoning is stored redacted.
        for (const e of one.events) for (const p of e.parts) if (p.type === "thinking") expect(p).toEqual({ type: "thinking", text: "", redacted: true });
      });

      test(`${id}/${f}: read in two pieces equals read whole`, () => {
        for (let k = 0; k <= src.length; k++) {
          let a: ParseResult;
          let b: ParseResult;
          if (whole(id)) {
            const full = JSON.parse(src.join("\n"));
            const n = Math.min(k, full.messages.length);
            a = converters[id](JSON.stringify({ ...full, messages: full.messages.slice(0, n) }, null, 2).split("\n"));
            b = converters[id](src, a.state);
          } else {
            a = converters[id](src.slice(0, k));
            b = converters[id](src.slice(k), a.state);
          }
          expect([...a.events, ...b.events]).toEqual(one.events);
          expect(b.state).toEqual(one.state);
        }
      });
    }
  }
});

describe("toConversation", () => {
  test("keeps person and agent text and asked questions; drops injected, tool and system events", () => {
    const ev = (e: Partial<Event> & Pick<Event, "role" | "parts">, seq: number): Event => ({ id: `#${seq}`, seq, ts: seq, ...e });
    const events: Event[] = [
      ev({ role: "system", parts: [{ type: "text", text: "system prompt" }], injected: true }, 0),
      ev({ role: "user", parts: [{ type: "text", text: "<system-reminder>x</system-reminder>" }], injected: true }, 1),
      ev({ role: "user", parts: [{ type: "text", text: "  hello  " }] }, 2),
      ev({ role: "assistant", parts: [{ type: "thinking", text: "", redacted: true }] }, 3),
      ev({ role: "assistant", parts: [{ type: "tool_call", callId: "c", name: "Bash", input: { cmd: "ls" } }] }, 4),
      ev({ role: "tool", parts: [{ type: "tool_result", callId: "c", output: "a.txt" }] }, 5),
      ev({ role: "assistant", parts: [{ type: "tool_call", callId: "q", name: "AskUserQuestion", input: { question: "Ship it?", options: ["Yes", "No"] } }], ask: "question" }, 6),
      ev({ role: "user", parts: [{ type: "tool_result", callId: "q", output: "Yes" }], ask: "answer" }, 7),
      ev({ role: "assistant", parts: [{ type: "text", text: "x".repeat(16 * 1024 + 5) }] }, 8),
    ];
    const out = toConversation(events);
    expect(out.slice(0, 3)).toEqual([
      { role: "user", at: 2, text: "hello" },
      { role: "assistant", at: 6, text: "Ship it?\n- Yes\n- No" },
      { role: "user", at: 7, text: "Yes" },
    ]);
    expect(out[3]!.text.endsWith("… [5 more characters]")).toBe(true);
  });
});

describe("Cursor", () => {
  test("app bubbles: the person and the assistant, other bubble types left out", () => {
    const r = fromCursorBubbles([
      { bubbleId: "b1", type: 1, text: "Why is the build slow?", createdAt: "2026-09-01T00:00:00Z" },
      { bubbleId: "b2", type: 3, text: "tool run" },
      { bubbleId: "b3", type: 2, text: "The cache is cold.", createdAt: 1788220800500 },
    ]);
    expect(toConversation(r.events)).toEqual([
      { role: "user", at: Date.parse("2026-09-01T00:00:00Z"), text: "Why is the build slow?" },
      { role: "assistant", at: 1788220800500, text: "The cache is cold." },
    ]);
    const more = fromCursorBubbles([{ bubbleId: "b1", type: 1 }, { bubbleId: "b2", type: 3 }, { bubbleId: "b3", type: 2 }, { bubbleId: "b4", type: 1, text: "Thanks" }], r.state);
    expect(more.events.map((e) => [e.id, e.seq])).toEqual([["b4", 2]]);
  });

  test("CLI root blob: message ids in order from field 1, other fields skipped", () => {
    const h = (n: number) => Array.from({ length: 32 }, () => n);
    const str = [...new TextEncoder().encode("file:///work")];
    const root = new Uint8Array([0x0a, 32, ...h(1), 0x0a, 32, ...h(0xab), 0x4a, str.length, ...str, 0x50, 0x01, 0xd0, 0x01, 0xb6, 0xf8, 0x01, 0x0a, 32, ...h(2)]);
    expect(cursorAgentMessageIds(root)).toEqual(["01".repeat(32), "ab".repeat(32), "02".repeat(32)]);
    expect(cursorAgentMessageIds(new Uint8Array([0x0a, 0x20, 1, 2]))).toEqual([]);
  });
});

describe("Hermes", () => {
  test("OpenAI-style rows: text, tool calls and an answered question", () => {
    const r = fromHermesMessages(
      [
        { id: 1, role: "system", content: "You are Hermes.", timestamp: 1790000000 },
        { id: 2, role: "user", content: "Check the disk", timestamp: 1790000001 },
        { id: 3, role: "assistant", content: "", tool_calls: JSON.stringify([{ id: "c1", function: { name: "terminal", arguments: '{"cmd":"df -h"}' } }]), timestamp: 1790000002 },
        { id: 4, role: "tool", content: "50% used", tool_call_id: "c1", timestamp: 1790000003 },
        { id: 5, role: "assistant", content: "", tool_calls: JSON.stringify([{ id: "q1", function: { name: "ask_user", arguments: '{"question":"Clean the cache?"}' } }]), timestamp: 1790000004 },
        { id: 6, role: "tool", content: "yes", tool_call_id: "q1", timestamp: 1790000005 },
        { id: 7, role: "assistant", content: "Half the disk is used; cache cleaned.", timestamp: 1790000006000 },
      ],
      undefined,
      "hermes-4",
    );
    expect(toConversation(r.events)).toEqual([
      { role: "user", at: 1790000001000, text: "Check the disk" },
      { role: "assistant", at: 1790000004000, text: "Clean the cache?" },
      { role: "user", at: 1790000005000, text: "yes" },
      { role: "assistant", at: 1790000006000, text: "Half the disk is used; cache cleaned." },
    ]);
    expect(r.meta.model).toBe("hermes-4");
  });
});

describe("OpenClaw's Codex turns", () => {
  const wrapped = '[OpenClaw conversation info: sender={"id":"U1","name":"me"}]\nOpenClaw runtime context for this turn:\nTreat this as reference.\n\n## Workspace\nfiles…\n\nSystem: [2026-09-26 12:18:05 UTC] Slack message in #dev from me\n\n우선 레포 세팅부터 해줄래?';
  test("keeps the person's message and drops the context around it", () => {
    expect(unwrapOpenClaw(wrapped)).toBe("우선 레포 세팅부터 해줄래?");
    expect(unwrapOpenClaw("plain text")).toBe("plain text");
    expect(unwrapOpenClaw('[OpenClaw conversation info: sender={}]\nOpenClaw runtime context for this turn:\nonly context')).toBe("");
  });
  test("the Codex converter stores the message, and a wrapper without one as injected", () => {
    const line = (text: string) => JSON.stringify({ timestamp: "2026-09-26T12:18:05Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
    const r = converters.codex([line(wrapped), line("<external_openclaw_current_sender>{}</external_openclaw_current_sender>")]);
    expect(r.events.map((e) => [(e.parts[0] as { text: string }).text.slice(0, 20), e.injected ?? false])).toEqual([["우선 레포 세팅부터 해줄래?", false], ["<external_openclaw_c", true]]);
  });
});
