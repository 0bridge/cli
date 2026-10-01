import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { batchSessions, collectHistory, HISTORY_SOURCES, historyPath, loadHistoryConfig, type HistoryConfig, type HistorySession } from "../src/history.ts";

const FIXTURES = join(import.meta.dir, "../../session/test/fixtures");

describe("batchSessions", () => {
  const s = (id: string, n: number, size: number): HistorySession => ({
    id,
    tool: "codex",
    device: "d",
    startedAt: 0,
    updatedAt: 0,
    messages: Array.from({ length: n }, (_, i) => ({ seq: i, role: "user" as const, at: 0, text: "x".repeat(size) })),
  });
  test("splits a long session across batches without losing messages", () => {
    const batches = batchSessions([s("codex:a", 10, 400), s("codex:b", 1, 10)], 1500);
    expect(batches.length).toBeGreaterThan(1);
    const seqs = batches.flat().filter((x) => x.id === "codex:a").flatMap((x) => x.messages.map((m) => m.seq));
    expect(seqs).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(batches.flat().some((x) => x.id === "codex:b")).toBe(true);
  });
});

describe("loadHistoryConfig", () => {
  const ctx = { home: "", storeDir: mkdtempSync(join(tmpdir(), "0b-hist-cfg-")) };
  const save = (c: object) => {
    mkdirSync(ctx.storeDir, { recursive: true });
    writeFileSync(historyPath(ctx), JSON.stringify(c));
  };
  afterAll(() => rmSync(ctx.storeDir, { recursive: true, force: true }));

  test("the new sources are on for someone who kept the old default list", () => {
    save({ enabled: true, tools: ["cursor", "grok", "codex", "claude-code"] });
    expect(loadHistoryConfig(ctx).tools).toEqual(HISTORY_SOURCES);
    expect(HISTORY_SOURCES).toEqual(expect.arrayContaining(["gemini", "cursor-agent", "openclaw", "hermes"]));
  });
  test("a list someone chose stays theirs", () => {
    save({ enabled: true, tools: ["codex", "claude-code"] });
    expect(loadHistoryConfig(ctx).tools).toEqual(["codex", "claude-code"]);
  });
  test("no saved list means every source", () => {
    save({ enabled: false });
    expect(loadHistoryConfig(ctx).tools).toEqual(HISTORY_SOURCES);
  });
});

describe("collectHistory", () => {
  const home = mkdtempSync(join(tmpdir(), "0b-hist-"));
  const ctx = { home, storeDir: join(home, ".0bridge") };
  const env = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
  const cfg = (tools: HistoryConfig["tools"], files: HistoryConfig["files"] = {}): HistoryConfig => ({ enabled: true, tools, exclude: [], files });
  const byId = (sessions: HistorySession[]) => Object.fromEntries(sessions.map((s) => [s.id, s]));
  const texts = (s: HistorySession | undefined) => s?.messages.map((m) => [m.seq, m.role, m.text]);

  beforeAll(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CODEX_HOME;
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    rmSync(home, { recursive: true, force: true });
  });

  test("Claude Code in a second config folder is tagged with that account, with branch and model", () => {
    const dir = join(home, ".claude-work");
    mkdirSync(join(dir, "projects", "-work-acme-web"), { recursive: true });
    writeFileSync(join(dir, ".claude.json"), "{}");
    copyFileSync(join(FIXTURES, "claude-code/basic.jsonl"), join(dir, "projects", "-work-acme-web", "0f2c4a7e-1b3d-4e5f-8a9b-0c1d2e3f4a5b.jsonl"));
    const s = byId(collectHistory(ctx, cfg(["claude-code"])).sessions)["claude-code:0f2c4a7e-1b3d-4e5f-8a9b-0c1d2e3f4a5b"];
    expect(s).toMatchObject({ tool: "claude-code", account: "work", branch: "fix/webhook", model: "claude-opus-5-5", title: "Fix duplicate payment webhook", cwd: "/work/acme/web" });
    expect(s!.messages[0]!.text).toBe("Fix the duplicate payment webhook. The key is [secret]");
  });

  test("OpenClaw's Codex rollouts are their own source, read once even when CODEX_HOME points there", () => {
    const sessions = join(home, ".openclaw", "agents", "coding", "agent", "codex-home", "sessions", "2026", "09", "23");
    mkdirSync(sessions, { recursive: true });
    copyFileSync(join(FIXTURES, "openclaw/basic.jsonl"), join(sessions, "rollout-2026-09-23T07-00-00-33333333-4444-4555-8666-777777777777.jsonl"));
    process.env.CODEX_HOME = join(home, ".openclaw", "agents", "coding", "agent", "codex-home");
    try {
      const got = collectHistory(ctx, cfg(["codex", "openclaw"])).sessions;
      expect(got.map((s) => s.id)).toEqual(["openclaw:33333333-4444-4555-8666-777777777777"]);
      expect(got[0]).toMatchObject({ tool: "openclaw", model: "gpt-6-sol" });
      expect(texts(got[0])).toEqual([
        [0, "user", "Summarise today's failing CI jobs"],
        [1, "assistant", "Two jobs failed: lint and e2e."],
      ]);
    } finally {
      delete process.env.CODEX_HOME;
    }
  });

  test("Gemini CLI: the whole chat file, then only the records added since", () => {
    const chats = join(home, ".gemini", "tmp", "f00d", "chats");
    mkdirSync(chats, { recursive: true });
    writeFileSync(join(chats, "..", ".project_root"), "/work/acme/cli\n");
    const file = join(chats, "session-2026-09-25T06-00-66666666.json");
    const doc = JSON.parse(readFileSync(join(FIXTURES, "gemini-cli/basic.json"), "utf8"));
    writeFileSync(file, JSON.stringify({ ...doc, messages: doc.messages.slice(0, 2) }, null, 2));
    const first = collectHistory(ctx, cfg(["gemini"]));
    const s = first.sessions[0];
    expect(s).toMatchObject({ id: "gemini:66666666-7777-4888-8999-aaaaaaaaaaaa", tool: "gemini", cwd: "/work/acme/cli", model: "gemini-3-pro" });
    expect(texts(s)).toEqual([
      [0, "user", "Explain the build script"],
      [1, "assistant", "It bundles src with bun and writes dist/0b.js."],
    ]);
    writeFileSync(file, JSON.stringify(doc, null, 2));
    const second = collectHistory(ctx, cfg(["gemini"], first.cursors));
    expect(texts(second.sessions[0])).toEqual([
      [2, "user", "And the banner?"],
      [3, "assistant", "It adds the node shebang."],
    ]);
    expect(collectHistory(ctx, cfg(["gemini"], { ...first.cursors, ...second.cursors })).sessions).toEqual([]);
  });

  test("Cursor CLI: the chat store's messages in order, then only new ones", () => {
    const dir = join(home, ".cursor", "chats", "5095a9a2", "48472034-260d-4b33-ab17-73c90834833f");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ schemaVersion: 1, cwd: "/work/acme/velcro" }));
    const msgs = readFileSync(join(FIXTURES, "cursor-agent/injected.jsonl"), "utf8").trim().split("\n");
    const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest();
    const db = new Database(join(dir, "store.db"));
    db.run("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)");
    db.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
    const write = (lines: string[]) => {
      for (const l of lines) db.query("INSERT OR IGNORE INTO blobs VALUES (?, ?)").run(sha(l).toString("hex"), Buffer.from(l));
      const root = Buffer.concat([...lines.map((l) => Buffer.concat([Buffer.from([0x0a, 32]), sha(l)])), Buffer.from([0x4a, 4]), Buffer.from("file")]);
      const rootId = sha(root).toString("hex");
      db.query("INSERT OR REPLACE INTO blobs VALUES (?, ?)").run(rootId, root);
      const meta = { agentId: "48472034-260d-4b33-ab17-73c90834833f", latestRootBlobId: rootId, name: "List TODOs", createdAt: 1790499900000 };
      db.query("INSERT OR REPLACE INTO meta VALUES ('0', ?)").run(Buffer.from(JSON.stringify(meta)).toString("hex"));
    };
    write(msgs.slice(0, 3));
    const first = collectHistory(ctx, cfg(["cursor-agent"]));
    expect(first.sessions[0]).toMatchObject({ id: "cursor-agent:48472034-260d-4b33-ab17-73c90834833f", tool: "cursor-agent", title: "List TODOs", cwd: "/work/acme/velcro" });
    expect(texts(first.sessions[0])).toEqual([[0, "user", "List the TODOs in src"]]);
    expect(collectHistory(ctx, cfg(["cursor-agent"], first.cursors)).sessions).toEqual([]);
    write(msgs);
    db.close();
    const second = collectHistory(ctx, cfg(["cursor-agent"], first.cursors));
    expect(texts(second.sessions[0])).toEqual([[1, "assistant", "One TODO, in src/a.ts."]]);
  });

  test("Hermes: messages by session, continuing from the last message id", () => {
    mkdirSync(join(home, ".hermes"), { recursive: true });
    const db = new Database(join(home, ".hermes", "state.db"));
    db.run("CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, model TEXT, title TEXT, started_at REAL)");
    db.run("CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL)");
    db.run("INSERT INTO sessions VALUES ('s1', 'cli', 'hermes-4', 'Disk check', 1790000000)");
    const add = (role: string, content: string, t: number) => db.query("INSERT INTO messages (session_id, role, content, timestamp) VALUES ('s1', ?, ?, ?)").run(role, content, t);
    add("system", "You are Hermes.", 1790000000);
    add("user", "Check the disk", 1790000001);
    const first = collectHistory(ctx, cfg(["hermes"]));
    expect(first.sessions[0]).toMatchObject({ id: "hermes:s1", tool: "hermes", title: "Disk check", model: "hermes-4", startedAt: 1790000000000 });
    expect(texts(first.sessions[0])).toEqual([[0, "user", "Check the disk"]]);
    add("assistant", "Half full.", 1790000002);
    db.close();
    const second = collectHistory(ctx, cfg(["hermes"], first.cursors));
    expect(texts(second.sessions[0])).toEqual([[1, "assistant", "Half full."]]);
  });

  test("an appended Claude line continues the numbering and carries a question across reads", () => {
    const dir = join(home, ".claude", "projects", "-work-acme-api");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "9a8b7c6d-0000-4000-8000-000000000001.jsonl");
    const lines = readFileSync(join(FIXTURES, "claude-code/resumed.jsonl"), "utf8").trim().split("\n");
    writeFileSync(file, lines.slice(0, 3).join("\n") + "\n");
    const first = collectHistory(ctx, cfg(["claude-code"]));
    const id = "claude-code:9a8b7c6d-0000-4000-8000-000000000001";
    expect(texts(byId(first.sessions)[id])).toEqual([
      [0, "user", "Carry on with the migration."],
      [1, "assistant", "Run it on production now?\n- Yes\n- Later"],
    ]);
    appendFileSync(file, lines.slice(3).join("\n") + "\n");
    const second = collectHistory(ctx, cfg(["claude-code"], { ...first.cursors }));
    expect(texts(byId(second.sessions)[id])).toEqual([
      [2, "user", "Later, after the backup"],
      [3, "assistant", "OK, I'll wait for the backup."],
    ]);
  });

  test("a line still being written (no newline yet) moves no cursor, so a sync loop ends", () => {
    const dir = join(home, ".claude", "projects", "-work-acme-tail");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "9a8b7c6d-0000-4000-8000-000000000002.jsonl");
    const lines = readFileSync(join(FIXTURES, "claude-code/resumed.jsonl"), "utf8").trim().split("\n");
    writeFileSync(file, lines.slice(0, 3).join("\n") + "\n" + lines[3]!.slice(0, 20));
    const first = collectHistory(ctx, cfg(["claude-code"]));
    const key = Object.keys(first.cursors).find((k) => k.endsWith("0002.jsonl"))!;
    expect(key).toBeDefined();
    const again = collectHistory(ctx, cfg(["claude-code"], { ...first.cursors }));
    expect(again.cursors[key]).toBeUndefined();
    expect(again.sessions.some((s) => s.id.endsWith("0002"))).toBe(false);
  });
});
