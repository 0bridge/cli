import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryLock, type Context } from "@0bridge/core";
import { runHook, statusLockPath, statusMark, statusMarksDir, takeStatusMarks, type StatusMark } from "../src/hook.ts";
import { firstLine, lastAssistantText, POST_GAP_MS, renderBoard, StatusWorker, type Board, type StatusUpdate, type WorkerDeps } from "../src/sessions.ts";

/**
 * The status board on the machine (round 2, P1): what each agent's hook input means, the hook's
 * marks (fast, silent, one per session), and the worker that posts them (batched, at most one POST
 * per 2 s, needs-you turning back into working when the transcript grows), on a fake clock.
 *   bun test apps/cli/test/status.test.ts
 */

const CLI = join(import.meta.dir, "..", "src", "index.ts");
const UUID = "1b2c3d4e-0000-4000-8000-0123456789ab";
const CLAUDE_T = `/home/me/.claude/projects/-home-me-acme-web/${UUID}.jsonl`;
const CODEX_T = `/home/me/.codex/sessions/2026/10/01/rollout-2026-10-01T10-00-00-${UUID}.jsonl`;

let home: string;
let ctx: Context;
let env: Record<string, string>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "0bridge-status-"));
  ctx = { home, storeDir: join(home, ".0bridge") };
  env = { ...(process.env as Record<string, string>), ZEROBRIDGE_USER_HOME: home, ZEROBRIDGE_DIR: ctx.storeDir, ZEROBRIDGE_SECRET_STORE: "file" };
  mkdirSync(ctx.storeDir, { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const claude = (event: string, extra: Record<string, unknown> = {}) =>
  statusMark(["claude"], JSON.stringify({ session_id: UUID, transcript_path: CLAUDE_T, cwd: "/home/me/acme/web", hook_event_name: event, ...extra }), 1000);
const codex = (event: string, extra: Record<string, unknown> = {}) =>
  statusMark(["codex"], JSON.stringify({ session_id: UUID, transcript_path: CODEX_T, cwd: "/home/me/acme/web", hook_event_name: event, ...extra }), 1000);
const cursor = (payload: Record<string, unknown>) => statusMark(["cursor"], JSON.stringify({ conversation_id: "c0nv-1", workspace_roots: ["/home/me/acme/web"], ...payload }), 1000);

describe("what a hook's input means", () => {
  test("Claude Code: prompt → working, permission or question → needs you, turn done → idle, closed → ended", () => {
    expect(claude("UserPromptSubmit", { prompt: "Add a checkout page", session_title: "Checkout" })).toEqual({
      tool: "claude-code",
      native: UUID,
      event: "UserPromptSubmit",
      state: "working",
      at: 1000,
      cwd: "/home/me/acme/web",
      transcript: CLAUDE_T,
      prompt: "Add a checkout page",
      title: "Checkout",
    });
    expect(claude("Notification", { message: "Claude needs your permission to use Bash", notification_type: "permission_prompt" })).toMatchObject({ state: "needs-you", reason: "permission", message: "Claude needs your permission to use Bash" });
    expect(claude("Notification", { message: "Claude needs your permission to use Bash" })).toMatchObject({ state: "needs-you", reason: "permission" }); // older, no type
    expect(claude("Notification", { message: "An MCP server needs your input", notification_type: "elicitation_dialog" })).toMatchObject({ state: "needs-you", reason: "input" });
    expect(claude("Notification", { message: "Claude is waiting for your input", notification_type: "idle_prompt" })).toBeNull();
    expect(claude("Notification", { message: "Signed in", notification_type: "auth_success" })).toBeNull();
    expect(claude("PermissionRequest", { tool_name: "Bash", tool_input: { command: "rm -rf dist\nls" } })).toMatchObject({
      state: "needs-you",
      reason: "permission",
      message: "Claude needs your permission to use Bash",
      detail: "Bash: rm -rf dist",
    });
    expect(claude("PermissionRequest", { tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Which database?" }] } })).toMatchObject({ state: "needs-you", reason: "input", message: "Which database?" });
    expect(claude("Stop", { last_assistant_message: "Added /checkout.", stop_hook_active: false })).toMatchObject({ state: "idle", message: "Added /checkout." });
    expect(claude("SessionEnd", { reason: "prompt_input_exit" })).toMatchObject({ state: "ended" });
    expect(claude("PreToolUse", { tool_name: "Bash" })).toBeNull();
  });

  test("the id is the one history uses: Claude's file name, the uuid in a Codex rollout's name", () => {
    expect(statusMark(["claude"], JSON.stringify({ session_id: "other", transcript_path: "/x/abc-def.jsonl", hook_event_name: "Stop" }))?.native).toBe("abc-def");
    expect(codex("Stop")?.native).toBe(UUID);
    expect(statusMark(["claude"], JSON.stringify({ session_id: "no/slashes here", hook_event_name: "Stop" }))?.native).toBe("noslasheshere");
    expect(statusMark(["claude"], JSON.stringify({ hook_event_name: "Stop" }))).toBeNull();
  });

  test("Codex: hooks.json events, and the notify fallback's argument (a finished turn)", () => {
    expect(codex("UserPromptSubmit", { prompt: "fix the tests" })).toMatchObject({ tool: "codex", state: "working", prompt: "fix the tests" });
    expect(codex("PermissionRequest", { tool_name: "shell", tool_input: { command: "npm publish" } })).toMatchObject({ state: "needs-you", reason: "permission", message: "Codex needs your permission to use shell", detail: "shell: npm publish" });
    expect(codex("Stop", { last_assistant_message: "All green." })).toMatchObject({ state: "idle", message: "All green." });
    expect(codex("SessionEnd")).toMatchObject({ state: "ended" });
    const notify = JSON.stringify({ type: "agent-turn-complete", "thread-id": UUID, cwd: "/w", "last-assistant-message": "Done." });
    expect(statusMark(["codex", notify], "")).toMatchObject({ tool: "codex", native: UUID, event: "notify", state: "idle", message: "Done.", cwd: "/w" });
  });

  test("Cursor: beforeSubmitPrompt → working, stop → idle or error; older payloads by their shape; no needs-you", () => {
    expect(cursor({ hook_event_name: "beforeSubmitPrompt", prompt: "rename it" })).toMatchObject({ tool: "cursor", native: "c0nv-1", state: "working", cwd: "/home/me/acme/web" });
    expect(cursor({ hook_event_name: "stop", status: "completed" })).toMatchObject({ state: "idle" });
    expect(cursor({ hook_event_name: "stop", status: "aborted" })).toMatchObject({ state: "idle" });
    expect(cursor({ hook_event_name: "stop", status: "error" })).toMatchObject({ state: "error" });
    expect(cursor({ status: "completed" })).toMatchObject({ event: "stop", state: "idle" });
    expect(cursor({ prompt: "x" })).toMatchObject({ event: "beforeSubmitPrompt", state: "working" });
  });

  test("garbage, a terminal and unknown targets say nothing", () => {
    expect(statusMark(["claude"], "not json")).toBeNull();
    expect(statusMark(["claude"], "")).toBeNull();
    expect(statusMark(["gemini"], JSON.stringify({ session_id: "x", hook_event_name: "Stop" }))).toBeNull();
  });
});

describe("the hook", () => {
  const statusOn = () => writeFileSync(join(ctx.storeDir, "status.json"), JSON.stringify({ enabled: true }));
  const input = (event: string, extra: Record<string, unknown> = {}) => JSON.stringify({ session_id: UUID, transcript_path: CLAUDE_T, cwd: "/w", hook_event_name: event, ...extra });

  test("board off: no status mark", () => {
    runHook(ctx, ["claude"], input("UserPromptSubmit", { prompt: "hi" }));
    expect(existsSync(statusMarksDir(ctx))).toBe(false);
  });

  test("one mark per session, the newest wins; well under 150 ms in process", () => {
    statusOn();
    const release = tryLock(statusLockPath(ctx))!; // a worker "runs": none is started from here
    const start = performance.now();
    expect(runHook(ctx, ["claude"], input("UserPromptSubmit", { prompt: "first" }))).toEqual({ history: false, status: false });
    runHook(ctx, ["claude"], input("PermissionRequest", { tool_name: "Bash", tool_input: { command: "ls" } }));
    expect(performance.now() - start).toBeLessThan(150);
    runHook(ctx, ["codex"], JSON.stringify({ session_id: UUID, transcript_path: CODEX_T, hook_event_name: "Stop" }));
    release();
    expect(readdirSync(statusMarksDir(ctx)).length).toBe(2);
    const marks = takeStatusMarks(ctx);
    expect(marks.map((m) => `${m.tool}:${m.state}`).sort()).toEqual(["claude-code:needs-you", "codex:idle"]);
    expect(takeStatusMarks(ctx)).toEqual([]);
  });

  test("the CLI on UserPromptSubmit: exit 0, nothing on stdout (it would join the prompt), the mark written", async () => {
    statusOn();
    const release = tryLock(statusLockPath(ctx))!;
    const t0 = performance.now();
    const p = Bun.spawn([process.execPath, CLI, "hook", "claude"], { env, stdin: new Blob([input("UserPromptSubmit", { prompt: "make it faster" })]), stdout: "pipe", stderr: "pipe" });
    const code = await p.exited;
    const ms = performance.now() - t0;
    release();
    expect(code).toBe(0);
    expect(await new Response(p.stdout).text()).toBe("");
    expect(await new Response(p.stderr).text()).toBe("");
    expect(ms).toBeLessThan(process.env.CI ? 1500 : 500);
    const [m] = takeStatusMarks(ctx);
    expect(m).toMatchObject({ tool: "claude-code", native: UUID, state: "working", prompt: "make it faster" });
  });
});

// ── The worker, on a fake clock ──

type Post = { at: number; updates: StatusUpdate[] };

function fakeWorld(
  schedule: { at: number; mark: Partial<StatusMark> & Pick<StatusMark, "native" | "state"> }[],
  o: { size?: (path: string, now: number) => number | null; fail?: number; text?: boolean; noText?: boolean } = {},
) {
  let now = 0;
  const posts: Post[] = [];
  const queue = [...schedule].sort((a, b) => a.at - b.at);
  const titles = new Map<string, string>();
  let failures = o.fail ?? 0;
  const deps: WorkerDeps = {
    now: () => now,
    sleep: async (ms) => void (now += ms),
    take: () => {
      const due = queue.filter((q) => q.at <= now);
      queue.splice(0, due.length);
      return due.map((q) => ({ tool: "claude-code", event: "x", at: q.at, cwd: "/home/me/acme/web", ...q.mark }) as StatusMark);
    },
    post: async (updates) => {
      if (failures > 0) {
        failures--;
        throw new Error("offline");
      }
      posts.push({ at: now, updates });
      return o.text === undefined ? undefined : { text: o.text };
    },
    size: (p) => (o.size ? o.size(p, now) : 100),
    repo: () => "github.com/acme/web",
    branch: () => "feat-x",
    lastAssistant: () => "From the transcript.\nMore.",
    values: () => ["hunter2-secret"],
    titles: { get: (id) => titles.get(id), set: (id, t) => void titles.set(id, t), save: () => {} },
    machine: "devbox",
    log: () => {},
    noText: { get: () => noText, set: (off) => void (noText = off) },
  };
  let noText = o.noText ?? false;
  return { deps, posts, clock: () => now, noText: () => noText };
}

describe("the status worker", () => {
  test("the first change goes at once; then at most one POST per 2 s, the newest state per session", async () => {
    const w = fakeWorld([
      { at: 0, mark: { native: "a", state: "working", prompt: "build the thing" } },
      { at: 0, mark: { native: "b", state: "working", prompt: "fix the bug" } },
      { at: 500, mark: { native: "a", state: "idle", message: "Built it." } },
      { at: 900, mark: { native: "b", state: "idle" } },
      { at: 1200, mark: { native: "b", state: "ended" } },
    ]);
    await new StatusWorker(w.deps).run();
    expect(w.posts.map((p) => p.at)).toEqual([0, POST_GAP_MS]);
    expect(w.posts[0]!.updates.map((u) => `${u.native}:${u.state}`)).toEqual(["a:working", "b:working"]);
    expect(w.posts[1]!.updates.map((u) => `${u.native}:${u.state}`)).toEqual(["a:idle", "b:ended"]);
    const first = w.posts[0]!.updates[0]!;
    expect(first).toMatchObject({ tool: "claude-code", repo: "github.com/acme/web", branch: "feat-x", title: "build the thing", lines: ["build the thing"], machine: "devbox", cwd: "/home/me/acme/web" });
    // The title the first prompt gave stays with the session.
    expect(w.posts[1]!.updates[0]).toMatchObject({ title: "build the thing", lines: ["Built it."] });
    // It left 15 s after the last thing it did.
    expect(w.clock()).toBeGreaterThanOrEqual(POST_GAP_MS + 15_000);
    expect(w.clock()).toBeLessThan(POST_GAP_MS + 16_000);
  });

  test("a prompt the tool wrote itself (a task notification) gives no line and no title", async () => {
    const w = fakeWorld([{ at: 0, mark: { native: "a", state: "working", prompt: "<task-notification>\n<task-id>x</task-id>" } }]);
    await new StatusWorker(w.deps).run();
    const u = w.posts[0]!.updates[0]!;
    expect(u.lines).toEqual([]);
    expect(u.title).toBeUndefined();
  });

  test("lines: the prompt, the notice and what it's for, the agent's last words (from the transcript when the hook had none); secrets masked", async () => {
    const w = fakeWorld([
      { at: 0, mark: { native: "a", state: "working", prompt: "## Use key sk-ant-api03-" + "x".repeat(30) + " and hunter2-secret\nsecond line" } },
      { at: 3000, mark: { native: "a", state: "needs-you", reason: "permission", message: "Claude needs your permission to use Bash", detail: "Bash: npm test" } },
      { at: 6000, mark: { native: "a", state: "idle", transcript: "/t.jsonl" } },
    ]);
    await new StatusWorker(w.deps).run();
    const [working, waiting, idle] = w.posts.map((p) => p.updates[0]!);
    expect(working!.lines).toEqual(["Use key [secret] and [secret]"]);
    expect(waiting).toMatchObject({ state: "needs-you", reason: "permission", lines: ["Claude needs your permission to use Bash", "Bash: npm test"] });
    expect(idle!.lines).toEqual(["From the transcript."]);
  });

  test("needs you → working once the transcript grows (you answered); watched every 3 s", async () => {
    const w = fakeWorld([{ at: 0, mark: { native: "a", state: "needs-you", reason: "permission", transcript: "/t.jsonl", message: "Claude needs your permission to use Bash" } }], {
      size: (_, now) => (now < 20_000 ? 100 : 180),
    });
    await new StatusWorker(w.deps).run();
    expect(w.posts.length).toBe(2);
    expect(w.posts[0]!.updates[0]).toMatchObject({ state: "needs-you" });
    const back = w.posts[1]!;
    expect(back.updates[0]).toMatchObject({ native: "a", state: "working", lines: [] });
    expect(back.updates[0]!.reason).toBeUndefined();
    expect(back.at).toBeGreaterThanOrEqual(20_000);
    expect(back.at).toBeLessThan(23_500);
  });

  test("a session that keeps needing you holds the worker up to 10 minutes, then it lets go", async () => {
    const w = fakeWorld([{ at: 0, mark: { native: "a", state: "needs-you", transcript: "/t.jsonl" } }]);
    await new StatusWorker(w.deps).run();
    expect(w.posts.length).toBe(1);
    expect(w.clock()).toBeGreaterThan(10 * 60_000);
    expect(w.clock()).toBeLessThan(10 * 60_000 + 20_000);
  });

  test("end-to-end history: once the server says no text, no title or lines go up (and that's remembered)", async () => {
    const w = fakeWorld(
      [
        { at: 0, mark: { native: "a", state: "working", prompt: "migrate the billing db for ACME" } },
        { at: 3000, mark: { native: "a", state: "idle", message: "Migrated." } },
      ],
      { text: false },
    );
    await new StatusWorker(w.deps).run();
    expect(w.posts[0]!.updates[0]).toMatchObject({ title: "migrate the billing db for ACME" });
    expect(w.posts[1]!.updates[0]).toMatchObject({ state: "idle", lines: [] });
    expect(w.posts[1]!.updates[0]!.title).toBeUndefined();
    expect(w.noText()).toBe(true);
    const next = fakeWorld([{ at: 0, mark: { native: "b", state: "working", prompt: "secret plans" } }], { noText: true, text: true });
    await new StatusWorker(next.deps).run();
    expect(next.posts[0]!.updates[0]).toMatchObject({ lines: [] });
    expect(next.posts[0]!.updates[0]!.title).toBeUndefined();
    // History back to server mode: text goes up again from the next post.
    expect(next.noText()).toBe(false);
  });

  test("a failed POST is tried again 2 s later with what's newest", async () => {
    const w = fakeWorld(
      [
        { at: 0, mark: { native: "a", state: "working" } },
        { at: 1000, mark: { native: "a", state: "idle" } },
      ],
      { fail: 1 },
    );
    await new StatusWorker(w.deps).run();
    expect(w.posts.map((p) => [p.at, p.updates.map((u) => u.state).join()])).toEqual([[POST_GAP_MS, "idle"]]);
  });
});

describe("reading the board", () => {
  test("firstLine: markdown and spaces out, clipped", () => {
    expect(firstLine("\n\n## **Done**: added `x`\nmore")).toBe("Done: added x");
    expect(firstLine("- item one")).toBe("item one");
    expect(firstLine("a".repeat(300))!.length).toBe(200);
    expect(firstLine("   ")).toBeUndefined();
  });

  test("the agent's last words from a Claude Code or Codex transcript's end", () => {
    const claudeT = join(home, "c.jsonl");
    writeFileSync(
      claudeT,
      [
        { type: "user", message: { role: "user", content: "hi" } },
        { type: "assistant", message: { content: [{ type: "text", text: "First answer." }] } },
        { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "Last answer." }] } },
        { type: "user", message: { role: "user", content: [{ type: "tool_result" }] } },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n",
    );
    expect(lastAssistantText(claudeT)).toBe("Last answer.");
    const codexT = join(home, "x.jsonl");
    writeFileSync(codexT, [{ type: "event_msg", payload: { type: "agent_message", message: "Codex says done." } }, { type: "event_msg", payload: { type: "token_count" } }].map((l) => JSON.stringify(l)).join("\n") + "\n");
    expect(lastAssistantText(codexT)).toBe("Codex says done.");
    expect(lastAssistantText(join(home, "missing.jsonl"))).toBeUndefined();
  });

  test("the terminal board: counts, then needs-you first with its line", () => {
    const e = (state: Board["entries"][number]["state"], extra: Partial<Board["entries"][number]> = {}) => ({
      id: `claude-code:${state}`,
      tool: "claude-code",
      machine: "devbox",
      machineId: "t1",
      kind: "local" as const,
      repo: "github.com/acme/web",
      branch: "feat-x",
      cwd: "acme/web",
      title: "Checkout",
      state,
      reason: null,
      lines: [] as string[],
      since: 0,
      updatedAt: 0,
      stale: false,
      ...extra,
    });
    const out = renderBoard({ entries: [e("needs-you", { lines: ["Claude needs your permission to use Bash"], since: 4 * 60_000 }), e("working", { tool: "codex", repo: null, cwd: "me/scratch" })], counts: { "needs-you": 1, working: 1, idle: 0, ended: 0, error: 0 }, now: 8 * 60_000 }, false);
    expect(out[0]).toBe("1 needs you · 1 working · 0 idle");
    expect(out[1]).toMatch(/^NEEDS YOU {2}devbox {2}Claude Code {2}acme\/web@feat-x {2}4m {2}"Claude needs your permission to use Bash"$/);
    expect(out[2]).toMatch(/^WORKING {4}devbox {2}Codex {8}me\/scratch {7}8m {2}"Checkout"$/);
  });
});

describe("0b sessions on|off", () => {
  test("on puts the board's hooks next to a foreign entry (it stays); off takes ours out again", () => {
    const settings = join(home, ".claude", "settings.json");
    const FOREIGN = { hooks: [{ type: "command", command: "bash '/h/.claude/herdr-agent-state.sh' prompt" }] };
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(settings, JSON.stringify({ model: "opus", hooks: { UserPromptSubmit: [FOREIGN] } }, null, 2));
    const run = (args: string[]) => Bun.spawnSync([process.execPath, CLI, ...args], { env: { ...env, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
    let r = run(["sessions", "on"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("Claude Code now report");
    const on = JSON.parse(readFileSync(settings, "utf8"));
    for (const ev of ["UserPromptSubmit", "Notification", "PermissionRequest", "Stop", "SessionEnd"]) expect(JSON.stringify(on.hooks[ev])).toContain(" hook claude");
    expect(on.hooks.UserPromptSubmit[0]).toEqual(FOREIGN);
    expect(on.model).toBe("opus");
    expect(JSON.parse(readFileSync(join(ctx.storeDir, "status.json"), "utf8")).enabled).toBe(true);
    expect(JSON.parse(readFileSync(join(ctx.storeDir, "state.json"), "utf8")).managed.claude.hooks).toEqual(["UserPromptSubmit", "Notification", "PermissionRequest", "Stop", "SessionEnd"]);
    r = run(["sessions", "off"]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ model: "opus", hooks: { UserPromptSubmit: [FOREIGN] } });
    expect(JSON.parse(readFileSync(join(ctx.storeDir, "status.json"), "utf8")).enabled).toBe(false);
  });

  test("off keeps history's turn-end hooks when history had them before", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), "{}");
    writeFileSync(join(ctx.storeDir, "history.json"), JSON.stringify({ enabled: true }));
    const run = (args: string[]) => Bun.spawnSync([process.execPath, CLI, ...args], { env: { ...env, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
    expect(run(["history", "hooks", "on"]).exitCode).toBe(0);
    expect(run(["sessions", "on"]).exitCode).toBe(0);
    expect(run(["sessions", "off"]).exitCode).toBe(0);
    expect(Object.keys(JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")).hooks)).toEqual(["Stop", "SessionEnd"]);
  });

  test("history hooks on turns the board on too (R5), unless sessions off said no", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), "{}");
    writeFileSync(join(ctx.storeDir, "history.json"), JSON.stringify({ enabled: true }));
    const run = (args: string[]) => Bun.spawnSync([process.execPath, CLI, ...args], { env: { ...env, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
    const events = () => Object.keys(JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")).hooks ?? {});
    const r = run(["history", "hooks", "on"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("Session board on");
    expect(events()).toEqual(["UserPromptSubmit", "Notification", "PermissionRequest", "Stop", "SessionEnd"]);
    // Off keeps history's hooks; history hooks on again leaves the board off.
    expect(run(["sessions", "off"]).exitCode).toBe(0);
    expect(events()).toEqual(["Stop", "SessionEnd"]);
    expect(run(["history", "hooks", "on"]).stdout.toString()).not.toContain("Session board on");
    expect(events()).toEqual(["Stop", "SessionEnd"]);
    // History off while the board is on: the board keeps its hooks and says how to remove them.
    expect(run(["sessions", "on"]).exitCode).toBe(0);
    expect(run(["history", "hooks", "off"]).stdout.toString()).toContain("0b sessions off removes them");
    expect(events().sort()).toEqual(["Notification", "PermissionRequest", "SessionEnd", "Stop", "UserPromptSubmit"]);
  });
});
