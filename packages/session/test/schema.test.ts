import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { converters, SCHEMA, toDti, validate, type Session } from "../src/index.ts";

const SRC = join(import.meta.dir, "../src");

const session = (over: Partial<Session> = {}): Session => ({
  schema: SCHEMA,
  id: "claude-code:0f2c4a7e-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
  source: { vendor: "anthropic", product: "Claude Code", tool: "claude-code", nativeId: "0f2c4a7e-1b3d-4e5f-8a9b-0c1d2e3f4a5b", host: "laptop" },
  title: "Fix duplicate payment webhook",
  cwd: "/work/acme/web",
  repo: { remote: "github.com/acme/web", branch: "fix/webhook" },
  createdAt: Date.parse("2026-09-20T10:00:00Z"),
  updatedAt: Date.parse("2026-09-20T10:00:09Z"),
  model: "claude-opus-5-5",
  resume: { kind: "native-cli", command: "claude --resume 0f2c4a7e-1b3d-4e5f-8a9b-0c1d2e3f4a5b", nativeId: "0f2c4a7e-1b3d-4e5f-8a9b-0c1d2e3f4a5b" },
  ...over,
});

describe("the package stays pure", () => {
  test("nothing in src imports node:*, bun:* or reads the environment", () => {
    const files = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : [join(d, f)]));
    for (const f of files(SRC)) {
      const s = readFileSync(f, "utf8");
      expect({ f, hit: /from\s+["'](?:node:|bun:)|require\(|import\(\s*["'](?:node:|bun:)|process\.env|\bBuffer\b/.exec(s)?.[0] }).toEqual({ f, hit: undefined });
    }
  });
});

describe("validate", () => {
  test("a full session document with events is valid", () => {
    const lines = readFileSync(join(import.meta.dir, "fixtures/claude-code/basic.jsonl"), "utf8").trim().split("\n");
    expect(validate({ ...session(), events: converters["claude-code"](lines).events })).toEqual({ ok: true });
  });
  test("names what's wrong", () => {
    const r = validate({ ...session(), schema: "0b.session/2", source: { vendor: "acme", product: "X", tool: "codex", nativeId: "n" }, createdAt: "yesterday", events: [{ id: "1", seq: -1, ts: 0, role: "bot", parts: [{ type: "video" }] }] });
    expect(r.ok).toBe(false);
    const errors = r.ok ? [] : r.errors;
    for (const want of ['$.schema: expected "0b.session/1"', "$.source.vendor", "$.createdAt: expected a number", "$.events[0].seq", "$.events[0].role", "$.events[0].parts[0].type", "$.id: expected to start with source.tool"])
      expect(errors.some((e) => e.startsWith(want))).toBe(true);
    expect(validate(null)).toEqual({ ok: false, errors: ["$: expected an object"] });
  });
  test("schema/session-1.json names the same version and the same required fields", () => {
    const schema = JSON.parse(readFileSync(join(import.meta.dir, "../schema/session-1.json"), "utf8"));
    expect(schema.properties.schema.const).toBe(SCHEMA);
    expect(schema.required.sort()).toEqual(["createdAt", "id", "schema", "source", "updatedAt"]);
    expect(schema.$defs.event.required.sort()).toEqual(["id", "parts", "role", "seq", "ts"]);
  });
});

describe("toDti", () => {
  const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;
  /** The documented shape of DTI "AI Conversation History" (schemas.pub/schemas/24). */
  function dtiErrors(x: any): string[] {
    const e: string[] = [];
    const d = x?.details;
    if (!d || typeof d.createdBy !== "string") e.push("details.createdBy");
    for (const k of ["createdAt", "startTime", "endTime"]) if (!ISO.test(d?.[k] ?? "")) e.push(`details.${k}`);
    if (d?.modality !== undefined && d.modality !== "text") e.push("details.modality");
    if (!Array.isArray(x?.identifiers) || !x.identifiers.length) e.push("identifiers");
    for (const i of x?.identifiers ?? []) if (typeof i.name !== "string" || typeof i.identifier !== "string" || (i.type !== undefined && i.type !== "email")) e.push("identifiers[]");
    if (!Array.isArray(x?.messages) || !x.messages.length) e.push("messages");
    const senders = new Set([...(x?.identifiers ?? []).map((i: any) => i.identifier), "AI"]);
    for (const m of x?.messages ?? []) if (!ISO.test(m.sentAt ?? "") || typeof m.text !== "string" || !senders.has(m.sender) || (m.channel !== undefined && m.channel !== "Web")) e.push("messages[]");
    const keys = (o: object, allowed: string[]) => Object.keys(o ?? {}).filter((k) => !allowed.includes(k));
    if (keys(x, ["details", "identifiers", "messages"]).length) e.push("extra top-level keys");
    return e;
  }

  test("exports the conversation in the documented shape, losing tools and reasoning", () => {
    const lines = readFileSync(join(import.meta.dir, "fixtures/claude-code/resumed.jsonl"), "utf8").trim().split("\n");
    const out: any = toDti(session({ source: { ...session().source, account: "me@example.com" } }), converters["claude-code"](lines).events);
    expect(dtiErrors(out)).toEqual([]);
    expect(out.identifiers).toEqual([{ name: "me@example.com", identifier: "me@example.com", type: "email" }]);
    expect(out.messages.map((m: any) => [m.sender, m.text])).toEqual([
      ["me@example.com", "Carry on with the migration."],
      ["AI", "Run it on production now?\n- Yes\n- Later"],
      ["me@example.com", "Later, after the backup"],
      ["AI", "OK, I'll wait for the backup."],
    ]);
    expect(out.details).toEqual({ createdBy: "Claude Code", createdAt: "2026-09-20T10:00:09.000Z", startTime: "2026-09-20T10:00:00.000Z", endTime: "2026-09-20T10:00:09.000Z", modality: "text" });
    expect(JSON.stringify(out)).not.toContain("tool");
  });
});
