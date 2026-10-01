import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  applyBlock,
  computeStatus,
  editMcpTables,
  emptyManifest,
  executePlan,
  getAdapters,
  importFromTools,
  loadState,
  openSecretStore,
  planApply,
  restoreBackup,
  saveManifest,
  shellSplit,
  type Context,
  type Manifest,
} from "../src/index.ts";

process.env.ZEROBRIDGE_SECRET_STORE = "file";

const CODEX_TOML = `# user comment stays
model = "gpt-5.5"

[mcp_servers.axiom]
url = "https://mcp.axiom.co/mcp"
auth = "oauth"
default_tools_approval_mode = "writes"

[mcp_servers.computer-use]
command = "./Codex Computer Use.app/Contents/MacOS/client"
args = ["mcp"]
enabled = false

[profiles.fast]
model = "gpt-5.5-mini"
`;

let home: string;
let ctx: Context;

function write(rel: string, content: string) {
  const p = join(home, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
}
const read = (rel: string) => readFileSync(join(home, rel), "utf8");

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "0bridge-test-"));
  ctx = { home, storeDir: join(home, ".0bridge") };
  write(".claude.json", JSON.stringify({ numStartups: 3, projects: { "/x": { mcpServers: { p: { type: "http", url: "https://p" } } } }, mcpServers: {} }, null, 2));
  write(".claude/skills/playwriter/SKILL.md", "---\nname: playwriter\n---\nbody");
  write(".claude/skills/synced/abc/SKILL.md", "claude.ai managed");
  write(".codex/config.toml", CODEX_TOML);
  write(".codex/skills/pdf/SKILL.md", "---\nname: pdf\n---\npdf");
  write(".codex/skills/.system/x/SKILL.md", "internal");
  write(".codex/AGENTS.md", "");
  write(
    ".cursor/mcp.json",
    JSON.stringify(
      {
        mcpServers: {
          playwright: { command: "npx @playwright/mcp@latest", env: {} },
          posthog: { url: "https://mcp.posthog.com/mcp", headers: { Authorization: "Bearer phx_abc123secretvalue" } },
          Linear: { url: "https://mcp.linear.app/sse", headers: {} },
        },
      },
      null,
      2,
    ),
  );
  write(".gemini/settings.json", JSON.stringify({ ui: { theme: "x" }, mcpServers: { pencil: { command: "/Applications/Pencil.app/bin/mcp", args: ["--app", "desktop"], env: {} } } }, null, 2));
  write(".gemini/GEMINI.md", "Always answer in Korean.\n");
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

function importAll(): Manifest {
  const m = emptyManifest();
  const state = loadState(ctx);
  importFromTools(ctx, m, state, openSecretStore(ctx.storeDir));
  saveManifest(ctx, m);
  writeFileSync(join(ctx.storeDir, "state.json"), JSON.stringify(state));
  return m;
}

describe("toml surgery", () => {
  test("updates in place, appends, removes, keeps everything else", () => {
    const out = editMcpTables(
      CODEX_TOML,
      { axiom: { url: "https://new" }, "a.b": { command: "npx", args: ["x"] } },
      ["computer-use"],
    );
    expect(out).toContain("# user comment stays");
    expect(out).toContain("[profiles.fast]");
    expect(out.indexOf("[mcp_servers.axiom]")).toBeLessThan(out.indexOf("[profiles.fast]"));
    const parsed = parseToml(out) as any;
    expect(parsed.mcp_servers.axiom).toEqual({ url: "https://new" });
    expect(parsed.mcp_servers["a.b"]).toEqual({ command: "npx", args: ["x"] });
    expect(parsed.mcp_servers["computer-use"]).toBeUndefined();
    expect(parsed.profiles.fast.model).toBe("gpt-5.5-mini");
  });

  test("refuses inline tables it cannot edit safely", () => {
    const inline = `[mcp_servers]\nfoo = { command = "x" }\n`;
    expect(() => editMcpTables(inline, {}, ["foo"])).toThrow(/could not safely remove/);
  });
});

test("shellSplit handles quotes", () => {
  expect(shellSplit(`npx -y "@scope/pkg" --flag='a b'`)).toEqual(["npx", "-y", "@scope/pkg", "--flag=a b"]);
});

test("adapters normalize each tool's dialect", () => {
  const a = getAdapters(ctx);
  expect(a.cursor.readServers().playwright).toEqual({ transport: "stdio", command: "npx", args: ["@playwright/mcp@latest"] });
  expect(a.cursor.readServers().Linear!.transport).toBe("sse");
  expect(a.codex.readServers().axiom).toEqual({
    transport: "http",
    url: "https://mcp.axiom.co/mcp",
    native: { codex: { auth: "oauth", default_tools_approval_mode: "writes" } },
  });
  expect(a.codex.readServers()["computer-use"]!.enabled).toBe(false);
});

describe("import → apply", () => {
  test("import merges tools, moves secrets out, pins tool-bound servers", () => {
    const m = importAll();
    expect(Object.keys(m.mcpServers).sort()).toEqual(["Linear", "axiom", "computer-use", "pencil", "playwright", "posthog"]);
    expect(m.mcpServers.posthog!.headers!.Authorization).toBe("${secret:posthog.headers.Authorization}");
    expect(readFileSync(join(ctx.storeDir, "secrets.json"), "utf8")).toContain("phx_abc123secretvalue");
    expect(m.mcpServers["computer-use"]!.targets).toEqual(["codex"]);
    expect(m.mcpServers.pencil!.targets).toBeUndefined();
    expect(Object.keys(m.skills).sort()).toEqual(["pdf", "playwriter"]);
    expect(readFileSync(join(ctx.storeDir, "AGENTS.md"), "utf8")).toBe("Always answer in Korean.\n");
  });

  test("a second Claude Code config folder (CLAUDE_CONFIG_DIR=~/.claude-b) gets what ~/.claude gets", () => {
    write(".claude-b/.claude.json", JSON.stringify({ oauthAccount: { emailAddress: "b@x" }, mcpServers: {} }, null, 2));
    write(".claude-old/notes.txt", "not a Claude Code folder: no .claude.json");
    importAll();
    const plan = planApply(ctx, JSON.parse(read(".0bridge/0bridge.json")), loadState(ctx), openSecretStore(ctx.storeDir));
    executePlan(ctx, plan);
    const b = JSON.parse(read(".claude-b/.claude.json"));
    expect(b.oauthAccount.emailAddress).toBe("b@x");
    expect(b.mcpServers.posthog).toEqual(JSON.parse(read(".claude.json")).mcpServers.posthog);
    expect(existsSync(join(home, ".claude-b/skills/pdf/SKILL.md"))).toBe(true);
    expect(read(".claude-b/CLAUDE.md")).toContain("0bridge:begin");
    expect(existsSync(join(home, ".claude-old/skills"))).toBe(false);
    // Converged: nothing left to do for either folder.
    expect(planApply(ctx, JSON.parse(read(".0bridge/0bridge.json")), loadState(ctx), openSecretStore(ctx.storeDir)).changes).toEqual([]);
  });

  test("apply converges every tool and is idempotent; restore undoes it", () => {
    importAll();
    const store = openSecretStore(ctx.storeDir);
    const before = { claude: read(".claude.json"), codex: read(".codex/config.toml"), gemini: read(".gemini/GEMINI.md") };

    const plan = planApply(ctx, JSON.parse(read(".0bridge/0bridge.json")), loadState(ctx), store);
    expect(plan.missing).toEqual([]);
    expect(plan.warnings.some((w) => w.includes("Linear") && w.includes("SSE"))).toBe(true);
    const id = executePlan(ctx, plan);

    const claude = JSON.parse(read(".claude.json"));
    expect(claude.numStartups).toBe(3);
    expect(claude.projects["/x"].mcpServers.p.url).toBe("https://p");
    expect(claude.mcpServers.posthog).toEqual({ type: "http", url: "https://mcp.posthog.com/mcp", headers: { Authorization: "Bearer phx_abc123secretvalue" } });
    expect(claude.mcpServers.playwright).toEqual({ type: "stdio", command: "npx", args: ["@playwright/mcp@latest"], env: {} });
    expect(claude.mcpServers["computer-use"]).toBeUndefined();

    const codex = parseToml(read(".codex/config.toml")) as any;
    expect(read(".codex/config.toml")).toContain("# user comment stays");
    expect(codex.mcp_servers.axiom.auth).toBe("oauth");
    expect(codex.mcp_servers.pencil.command).toBe("/Applications/Pencil.app/bin/mcp");
    expect(codex.mcp_servers.Linear).toBeUndefined();

    const gemini = JSON.parse(read(".gemini/settings.json"));
    expect(gemini.ui.theme).toBe("x");
    expect(gemini.mcpServers.axiom).toEqual({ httpUrl: "https://mcp.axiom.co/mcp" });
    expect(gemini.mcpServers.Linear).toEqual({ url: "https://mcp.linear.app/sse" });

    expect(existsSync(join(home, ".codex/skills/playwriter/SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".claude/skills/pdf/SKILL.md"))).toBe(true);
    expect(read(".codex/AGENTS.md")).toContain("Always answer in Korean.");
    expect(read(".claude/CLAUDE.md")).toContain("0bridge:begin");

    const again = planApply(ctx, JSON.parse(read(".0bridge/0bridge.json")), loadState(ctx), store);
    expect(again.changes).toEqual([]);
    const status = computeStatus(ctx, JSON.parse(read(".0bridge/0bridge.json")), store);
    expect(status.mcp.find((r) => r.name === "posthog")!.cells).toEqual({ claude: "ok", codex: "ok", cursor: "ok", gemini: "ok" });
    expect(status.mcp.find((r) => r.name === "Linear")!.cells.codex).toBe("unsupported");

    restoreBackup(ctx, id);
    expect(read(".claude.json")).toBe(before.claude);
    expect(read(".codex/config.toml")).toBe(before.codex);
    expect(read(".gemini/GEMINI.md")).toBe(before.gemini);
    expect(existsSync(join(home, ".codex/skills/playwriter"))).toBe(false);
    expect(existsSync(join(home, ".claude/CLAUDE.md"))).toBe(false);
  });

  test("disable removes from JSON tools, marks codex enabled=false; never touches unmanaged entries", () => {
    const m = importAll();
    const store = openSecretStore(ctx.storeDir);
    executePlan(ctx, planApply(ctx, m, loadState(ctx), store));

    m.mcpServers.playwright!.enabled = false;
    // A server the user added by hand to Claude with the same name as a manifest entry.
    const claude = JSON.parse(read(".claude.json"));
    claude.mcpServers.mine = { type: "http", url: "https://hand-made" };
    write(".claude.json", JSON.stringify(claude, null, 2));
    m.mcpServers.mine = { transport: "http", url: "https://from-manifest" };

    const plan = planApply(ctx, m, loadState(ctx), store);
    expect(plan.warnings.some((w) => w.includes("mine") && w.includes("left as is"))).toBe(true);
    executePlan(ctx, plan);

    expect(JSON.parse(read(".claude.json")).mcpServers.playwright).toBeUndefined();
    expect(JSON.parse(read(".claude.json")).mcpServers.mine.url).toBe("https://hand-made");
    expect((parseToml(read(".codex/config.toml")) as any).mcp_servers.playwright.enabled).toBe(false);
    expect(JSON.parse(read(".cursor/mcp.json")).mcpServers.playwright).toBeUndefined();
  });
});

test("instructions block keeps user text", () => {
  expect(applyBlock("mine\n", "shared")).toBe("mine\n\n<!-- 0bridge:begin (managed by 0bridge; edit ~/.0bridge/AGENTS.md instead) -->\nshared\n<!-- 0bridge:end -->\n");
  const once = applyBlock("mine\n", "shared");
  expect(applyBlock(once, "shared")).toBe(once);
  expect(applyBlock(once, "")).toBe("mine\n");
  expect(applyBlock("shared\n", "shared")).not.toContain("shared\n\n<!--");
});

// POSIX modes: Windows has none to set (stat reports 0666), and there the default store is DPAPI.
test.skipIf(process.platform === "win32")("file secret store is 0600 inside a 0700 dir from the first write", () => {
  const dir = join(home, "private-store");
  const s = openSecretStore(dir);
  s.set("a", "v1");
  const { statSync } = require("node:fs");
  expect(statSync(join(dir, "secrets.json")).mode & 0o777).toBe(0o600);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  s.delete("a");
  expect(statSync(join(dir, "secrets.json")).mode & 0o777).toBe(0o600);
});

test("secret names/values that could smuggle extra `security -i` commands are rejected", () => {
  const s = openSecretStore(join(home, "st"));
  expect(() => s.set('x"\ndelete-keychain login.keychain\n"', "v")).toThrow(/invalid secret name/);
  expect(() => s.set("ok", "v\ndump-keychain -d")).toThrow(/control characters/);
  expect(() => s.set("server.env.API_KEY", `plain "quoted" \\ value`)).not.toThrow();
});

test("explicit choices: one context7 everywhere, Linear moved off SSE, skills filtered", () => {
  const codex = read(".codex/config.toml") + `\n[mcp_servers.context7]\ncommand = "npx"\nargs = ["-y", "@upstash/context7-mcp"]\n`;
  write(".codex/config.toml", codex);
  const cursor = JSON.parse(read(".cursor/mcp.json"));
  cursor.mcpServers.context7 = { url: "https://mcp.context7.com/mcp" };
  write(".cursor/mcp.json", JSON.stringify(cursor, null, 2));

  const m = emptyManifest();
  const state = loadState(ctx);
  const store = openSecretStore(ctx.storeDir);
  const report = importFromTools(ctx, m, state, store, {
    include: { skills: ["playwriter"] },
    prefer: { mcp: { context7: "cursor" } },
    overrides: { Linear: { transport: "http", url: "https://mcp.linear.app/mcp" } },
  });
  saveManifest(ctx, m);
  writeFileSync(join(ctx.storeDir, "state.json"), JSON.stringify(state));

  expect(m.mcpServers.context7).toEqual({ transport: "http", url: "https://mcp.context7.com/mcp" });
  expect(report.replaced).toContainEqual({ kind: "mcp", name: "context7", tool: "codex" });
  expect(m.mcpServers.Linear).toEqual({ transport: "http", url: "https://mcp.linear.app/mcp" });
  expect(Object.keys(m.skills)).toEqual(["playwriter"]);

  executePlan(ctx, planApply(ctx, m, loadState(ctx), store));
  const toml = parseToml(read(".codex/config.toml")) as any;
  expect(toml.mcp_servers.context7).toEqual({ url: "https://mcp.context7.com/mcp" });
  expect(toml.mcp_servers.Linear).toEqual({ url: "https://mcp.linear.app/mcp" });
  expect(JSON.parse(read(".cursor/mcp.json")).mcpServers.Linear).toEqual({ url: "https://mcp.linear.app/mcp" });
  expect(existsSync(join(home, ".claude/skills/pdf"))).toBe(false);
  expect(existsSync(join(home, ".codex/skills/playwriter"))).toBe(true);
});
