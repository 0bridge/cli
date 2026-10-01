import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { CLAUDE_EVENTS, CODEX_EVENTS, CURSOR_EVENTS, executePlan, hookCommandLine, hooksStatus, isOurHook, loadState, ownedHooks, planHooks, restoreBackup, statusEnabled, type Context } from "../src/index.ts";

process.env.ZEROBRIDGE_SECRET_STORE = "file";
delete process.env.CLAUDE_CONFIG_DIR;

// The shapes on a real machine: herdr's state hooks already in each tool, and a hook of the user's own.
const CLAUDE_SETTINGS = {
  model: "opus",
  hooks: {
    SessionStart: [{ matcher: "^(startup|resume|clear|compact|fork)$", hooks: [{ type: "command", command: "bash '/h/.claude/hooks/herdr-agent-state.sh' session", timeout: 10 }] }],
    Stop: [{ hooks: [{ type: "command", command: "afplay /System/Library/Sounds/Glass.aiff" }] }],
  },
  statusLine: { type: "command", command: "~/.claude/statusline.sh" },
};
const CODEX_HOOKS = { hooks: { SessionStart: [{ hooks: [{ command: "bash '/h/.codex/herdr-agent-state.sh' session", timeout: 10, type: "command" }] }] } };
const CURSOR_HOOKS = { hooks: { sessionStart: [{ command: "bash '/h/.cursor/herdr-agent-state.sh' session" }] }, version: 1 };

let home: string;
let ctx: Context;
let bin: string;

const write = (rel: string, v: unknown) => {
  const p = join(home, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, typeof v === "string" ? v : JSON.stringify(v, null, 2) + "\n");
};
const read = (rel: string) => JSON.parse(readFileSync(join(home, rel), "utf8"));
const text = (rel: string) => readFileSync(join(home, rel), "utf8");

/** Write a plan's changes the way executePlan does, without the backup. */
function apply(on: boolean, b = bin) {
  const plan = planHooks(ctx, on, b);
  for (const c of plan.changes) {
    mkdirSync(join(c.path, ".."), { recursive: true });
    writeFileSync(c.path, c.rerender(existsSync(c.path) ? readFileSync(c.path, "utf8") : null));
  }
  return plan;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "0bridge-hooks-"));
  ctx = { home, storeDir: join(home, ".0bridge") };
  bin = join(ctx.storeDir, "bin", "0bridge");
  write(".claude/settings.json", CLAUDE_SETTINGS);
  write(".codex/hooks.json", CODEX_HOOKS);
  write(".codex/config.toml", 'model = "gpt-5.5"\n\n[features]\nhooks = true\n');
  write(".cursor/hooks.json", CURSOR_HOOKS);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("turn-end hooks", () => {
  test("merged into the arrays already there, next to the user's and herdr's", () => {
    const plan = apply(true);
    expect(plan.skipped.map((s) => s.target)).toEqual(["gemini"]);
    const claude = read(".claude/settings.json");
    expect(claude.model).toBe("opus");
    expect(claude.statusLine).toEqual(CLAUDE_SETTINGS.statusLine);
    expect(claude.hooks.SessionStart).toEqual(CLAUDE_SETTINGS.hooks.SessionStart);
    expect(claude.hooks.Stop).toEqual([...CLAUDE_SETTINGS.hooks.Stop, { hooks: [{ type: "command", command: hookCommandLine(bin, "claude"), timeout: 5 }] }]);
    expect(claude.hooks.SessionEnd).toEqual([{ hooks: [{ type: "command", command: hookCommandLine(bin, "claude"), timeout: 5 }] }]);

    const codex = read(".codex/hooks.json");
    expect(codex.hooks.SessionStart).toEqual(CODEX_HOOKS.hooks.SessionStart);
    expect(codex.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: hookCommandLine(bin, "codex"), timeout: 5 }] }]);
    expect(parseToml(text(".codex/config.toml")).notify).toBeUndefined();

    const cursor = read(".cursor/hooks.json");
    expect(cursor.version).toBe(1);
    expect(cursor.hooks.sessionStart).toEqual(CURSOR_HOOKS.hooks.sessionStart);
    expect(cursor.hooks.stop).toEqual([{ command: hookCommandLine(bin, "cursor") }]);

    expect(hooksStatus(ctx)).toEqual({ claude: "on", codex: "on", cursor: "on", gemini: "unsupported" });
    expect(ownedHooks(ctx)).toEqual({ claude: ["Stop", "SessionEnd"], codex: ["Stop"], cursor: ["stop"] });
  });

  test("idempotent: a second run plans nothing, and a moved 0b replaces its entry in place", () => {
    apply(true);
    expect(planHooks(ctx, true, bin).changes).toEqual([]);
    const moved = "/opt/other home/.0bridge/bin/0bridge";
    const plan = apply(true, moved);
    expect(plan.changes.map((c) => c.tool)).toEqual(["claude", "codex", "cursor"]);
    const stop = read(".claude/settings.json").hooks.Stop;
    expect(stop.length).toBe(2);
    expect(stop[1].hooks[0].command).toBe(`"${moved}" hook claude`);
    expect(isOurHook(stop[1].hooks[0].command)).toBe(true);
    expect(planHooks(ctx, true, moved).changes).toEqual([]);
  });

  test("off removes only our entries and leaves the files as they were", () => {
    const before = { claude: text(".claude/settings.json"), codex: text(".codex/hooks.json"), cursor: text(".cursor/hooks.json") };
    apply(true);
    apply(false);
    expect(read(".claude/settings.json")).toEqual(JSON.parse(before.claude));
    expect(read(".codex/hooks.json")).toEqual(JSON.parse(before.codex));
    expect(read(".cursor/hooks.json")).toEqual(JSON.parse(before.cursor));
    expect(hooksStatus(ctx)).toEqual({ claude: "off", codex: "off", cursor: "off", gemini: "unsupported" });
    expect(planHooks(ctx, false, bin).changes).toEqual([]);
  });

  test("other Claude Code config folders get the hook too", () => {
    write(".claude-work/.claude.json", { numStartups: 1 });
    apply(true);
    expect(read(".claude-work/settings.json").hooks.Stop[0].hooks[0].command).toBe(hookCommandLine(bin, "claude"));
    apply(false);
    expect(read(".claude-work/settings.json")).toEqual({});
  });

  test("files that don't exist yet are created, and off doesn't create them", () => {
    rmSync(join(home, ".cursor", "hooks.json"));
    expect(planHooks(ctx, false, bin).changes).toEqual([]);
    apply(true);
    expect(read(".cursor/hooks.json")).toEqual({ version: 1, hooks: { stop: [{ command: hookCommandLine(bin, "cursor") }] } });
  });

  test("Codex without hooks turned on: notify in config.toml, only when notify is free", () => {
    rmSync(join(home, ".codex", "hooks.json"));
    write(".codex/config.toml", 'model = "gpt-5.5"\n\n[mcp_servers.x]\nurl = "https://x"\n');
    apply(true);
    const toml = parseToml(text(".codex/config.toml")) as any;
    expect(toml.notify).toEqual([bin, "hook", "codex"]);
    expect(toml.model).toBe("gpt-5.5");
    expect(toml.mcp_servers.x.url).toBe("https://x");
    expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(false);
    expect(hooksStatus(ctx).codex).toBe("on");
    apply(false);
    expect(text(".codex/config.toml")).toBe('model = "gpt-5.5"\n\n[mcp_servers.x]\nurl = "https://x"\n');

    write(".codex/config.toml", 'notify = ["say", "done"]\n');
    const plan = apply(true);
    expect(plan.skipped.find((s) => s.target === "codex")?.why).toContain("notify");
    expect(text(".codex/config.toml")).toBe('notify = ["say", "done"]\n');
  });

  test("tools that aren't installed are skipped; invalid JSON is left alone", () => {
    rmSync(join(home, ".cursor"), { recursive: true });
    write(".claude/settings.json", "{ not json");
    const plan = apply(true);
    expect(plan.skipped.map((s) => s.target).sort()).toEqual(["claude", "cursor", "gemini"]);
    expect(text(".claude/settings.json")).toBe("{ not json");
  });

  test("applied through executePlan: backed up, and restore puts every file back", () => {
    const plan = planHooks(ctx, true, bin);
    const id = executePlan(ctx, { changes: plan.changes, warnings: [], missing: [], state: loadState(ctx) });
    expect(hooksStatus(ctx).claude).toBe("on");
    restoreBackup(ctx, id);
    expect(read(".claude/settings.json")).toEqual(CLAUDE_SETTINGS);
    expect(hooksStatus(ctx).claude).toBe("off");
  });

  test("only commands of the 0bridge script followed by hook are ours", () => {
    expect(isOurHook("/home/me/.0bridge/bin/0bridge hook claude")).toBe(true);
    expect(isOurHook('"C:\\Users\\Me Too\\.0bridge\\bin\\0bridge.cmd" hook codex')).toBe(true);
    expect(isOurHook("bash '/h/.claude/hooks/herdr-agent-state.sh' session")).toBe(false);
    expect(isOurHook("0b hooks status")).toBe(false);
    expect(isOurHook(undefined)).toBe(false);
    expect(hookCommandLine("C:\\Users\\me\\.0bridge\\bin\\0bridge.cmd", "codex")).toBe('"C:\\Users\\me\\.0bridge\\bin\\0bridge.cmd" hook codex');
  });
});

describe("status board hooks (round 2)", () => {
  // herdr's state hooks sit in the very arrays the board needs.
  const HERDR = (tool: string, ev: string) => ({ type: "command", command: `bash '/h/.${tool}/herdr-agent-state.sh' ${ev}`, timeout: 10 });
  const CLAUDE_HERDR = {
    hooks: {
      UserPromptSubmit: [{ hooks: [HERDR("claude", "prompt")] }],
      Notification: [{ matcher: "", hooks: [HERDR("claude", "notify")] }],
      Stop: [{ hooks: [HERDR("claude", "stop")] }],
    },
  };
  const CODEX_HERDR = { hooks: { UserPromptSubmit: [{ hooks: [HERDR("codex", "prompt")] }], Stop: [{ hooks: [HERDR("codex", "stop")] }] } };
  const CURSOR_HERDR = { version: 1, hooks: { beforeSubmitPrompt: [{ command: "bash '/h/.cursor/herdr-agent-state.sh' prompt" }], stop: [{ command: "bash '/h/.cursor/herdr-agent-state.sh' stop" }] } };
  const statusOn = (on: boolean) => write(".0bridge/status.json", { enabled: on });
  const ours = (tool: "claude" | "codex" | "cursor") => (tool === "cursor" ? { command: hookCommandLine(bin, "cursor") } : { hooks: [{ type: "command", command: hookCommandLine(bin, tool), timeout: 5 }] });

  beforeEach(() => {
    write(".claude/settings.json", CLAUDE_HERDR);
    write(".codex/hooks.json", CODEX_HERDR);
    write(".cursor/hooks.json", CURSOR_HERDR);
  });

  test("statusEnabled reads status.json; off, missing or broken is off", () => {
    expect(statusEnabled(ctx)).toBe(false);
    statusOn(true);
    expect(statusEnabled(ctx)).toBe(true);
    statusOn(false);
    expect(statusEnabled(ctx)).toBe(false);
    write(".0bridge/status.json", "{ broken");
    expect(statusEnabled(ctx)).toBe(false);
  });

  test("on: every event the board reads, after herdr's entries, which stay as they were", () => {
    statusOn(true);
    const plan = apply(false);
    expect(plan.changes.find((c) => c.tool === "claude")?.summary).toEqual(["add UserPromptSubmit, Notification, PermissionRequest, Stop, SessionEnd hooks"]);
    const claude = read(".claude/settings.json");
    expect(claude.hooks.UserPromptSubmit).toEqual([...CLAUDE_HERDR.hooks.UserPromptSubmit, ours("claude")]);
    expect(claude.hooks.Notification).toEqual([...CLAUDE_HERDR.hooks.Notification, ours("claude")]);
    expect(claude.hooks.Stop).toEqual([...CLAUDE_HERDR.hooks.Stop, ours("claude")]);
    expect(claude.hooks.PermissionRequest).toEqual([ours("claude")]);
    expect(claude.hooks.SessionEnd).toEqual([ours("claude")]);
    const codex = read(".codex/hooks.json");
    expect(codex.hooks.UserPromptSubmit).toEqual([...CODEX_HERDR.hooks.UserPromptSubmit, ours("codex")]);
    expect(codex.hooks.Stop).toEqual([...CODEX_HERDR.hooks.Stop, ours("codex")]);
    expect(codex.hooks.PermissionRequest).toEqual([ours("codex")]);
    expect(codex.hooks.SessionEnd).toEqual([ours("codex")]);
    const cursor = read(".cursor/hooks.json");
    expect(cursor.hooks.beforeSubmitPrompt).toEqual([...CURSOR_HERDR.hooks.beforeSubmitPrompt, ours("cursor")]);
    expect(cursor.hooks.stop).toEqual([...CURSOR_HERDR.hooks.stop, ours("cursor")]);
    expect(ownedHooks(ctx)).toEqual({ claude: CLAUDE_EVENTS, codex: CODEX_EVENTS, cursor: CURSOR_EVENTS });
    expect(hooksStatus(ctx)).toEqual({ claude: "on", codex: "on", cursor: "on", gemini: "unsupported" });
    // Idempotent, whichever way history asks.
    expect(planHooks(ctx, true, bin).changes).toEqual([]);
    expect(planHooks(ctx, false, bin).changes).toEqual([]);
  });

  test("history turning its hooks off keeps them while the board is on", () => {
    apply(true);
    expect(ownedHooks(ctx).claude).toEqual(["Stop", "SessionEnd"]);
    statusOn(true);
    apply(true);
    expect(ownedHooks(ctx).claude).toEqual(CLAUDE_EVENTS);
    // `0b history off` and `0b history hooks off` plan with on = false: the board still needs them.
    expect(apply(false).changes).toEqual([]);
    expect(ownedHooks(ctx)).toEqual({ claude: CLAUDE_EVENTS, codex: CODEX_EVENTS, cursor: CURSOR_EVENTS });
  });

  test("board off: history keeps only a turn's end; with history off too ours all go and herdr's stay", () => {
    statusOn(true);
    apply(false);
    statusOn(false);
    const plan = apply(true);
    expect(plan.changes.find((c) => c.tool === "claude")?.summary).toEqual(["remove UserPromptSubmit, Notification, PermissionRequest hooks"]);
    expect(ownedHooks(ctx)).toEqual({ claude: ["Stop", "SessionEnd"], codex: ["Stop"], cursor: ["stop"] });
    expect(read(".claude/settings.json").hooks.UserPromptSubmit).toEqual(CLAUDE_HERDR.hooks.UserPromptSubmit);
    apply(false);
    expect(read(".claude/settings.json")).toEqual(CLAUDE_HERDR);
    expect(read(".codex/hooks.json")).toEqual(CODEX_HERDR);
    expect(read(".cursor/hooks.json")).toEqual(CURSOR_HERDR);
    expect(hooksStatus(ctx)).toEqual({ claude: "off", codex: "off", cursor: "off", gemini: "unsupported" });
  });

  test("Codex without hooks.json: the notify fallback (a finished turn only) serves the board too", () => {
    rmSync(join(home, ".codex", "hooks.json"));
    write(".codex/config.toml", 'model = "gpt-5.5"\n');
    statusOn(true);
    apply(false);
    expect((parseToml(text(".codex/config.toml")) as any).notify).toEqual([bin, "hook", "codex"]);
    expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(false);
  });
});
