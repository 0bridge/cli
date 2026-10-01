import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAdapter } from "../src/agent/adapters/fake.ts";
import { Daemon } from "../src/agent/daemon.ts";
import { readTask } from "../src/agent/log.ts";
import { DEFAULT_DENY, saveAgentConfig, type AgentConfig } from "../src/agent/policy.ts";
import type { EventFrame, HubRequest } from "../src/agent/protocol.ts";

/** The daemon with stand-in agents, a scratch git repo and a fake hub that records frames. */
function setup(cfg: Partial<AgentConfig> = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "0b-agent-daemon-")));
  const ctx = { home: join(base, "home"), storeDir: join(base, "home", ".0bridge") };
  const repo = join(base, "work", "app");
  mkdirSync(repo, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "app\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  const other = join(base, "work", "secret");
  mkdirSync(other, { recursive: true });
  saveAgentConfig(ctx, { enabled: true, repos: [{ root: repo, mode: "edit", worktree: true, deny: [] }], ...cfg });
  const denyOf = (task: string) => (daemon as any).tasks.get(task)?.deny ?? DEFAULT_DENY;
  const daemon: Daemon = new Daemon(ctx, { adapters: { claude: new FakeAdapter("claude", denyOf), codex: new FakeAdapter("codex", denyOf) }, log: () => {} });
  const frames: any[] = [];
  daemon.connected((f) => {
    frames.push(f);
    return true;
  });
  const events = (task: string) => frames.filter((f): f is EventFrame => f.t === "event" && f.task === task);
  const until = async (fn: () => boolean, ms = 5000) => {
    for (const end = Date.now() + ms; !fn(); ) {
      if (Date.now() > end) throw new Error("timed out");
      await Bun.sleep(5);
    }
  };
  let n = 0;
  const req = (r: Record<string, unknown>) => daemon.request({ t: "req", rid: `r${++n}`, ...r } as HubRequest);
  return { base, ctx, repo, other, daemon, frames, events, until, req };
}

const finished = (evs: EventFrame[]) => evs.find((e) => e.kind === "done");

describe("agent daemon", () => {
  test("a task runs in its own worktree on 0b/<task> and reports what it did", async () => {
    const { repo, events, until, req, ctx } = setup();
    const r = (await req({ op: "start", task: "t_aaaa1111", agent: "claude", repo, prompt: "create hello.txt" })) as { cwd: string; branch: string; mode: string };
    expect(r.branch).toBe("0b/t_aaaa1111");
    expect(r.mode).toBe("edit");
    expect(r.cwd).toBe(join(repo, "..", ".0b-worktrees", "app-t_aaaa1111"));
    await until(() => Boolean(finished(events("t_aaaa1111"))));
    const evs = events("t_aaaa1111");
    expect(evs.map((e) => e.seq)).toEqual(evs.map((_, i) => i + 1));
    expect(evs.map((e) => e.kind)).toEqual(["status", "status", "text", "tool", "done"]);
    expect(evs[1]!.data.state).toBe("running");
    expect(evs[1]!.data.native).toStartWith("fake-");
    expect(evs[2]!.data.text).toBe("echo: create hello.txt");
    expect(finished(evs)!.data).toMatchObject({ state: "done", ok: true });
    expect(readFileSync(join(r.cwd, "hello.txt"), "utf8")).toBe("hi\n");
    expect(existsSync(join(repo, "hello.txt"))).toBe(false);
    expect(execFileSync("git", ["-C", r.cwd, "branch", "--show-current"], { encoding: "utf8" }).trim()).toBe("0b/t_aaaa1111");
    // The local log has the same events.
    expect(readTask(ctx, "t_aaaa1111")!.events.map((e) => e.kind)).toEqual(evs.map((e) => e.kind));
  });

  test("nothing runs outside allowed repos, with an unknown agent, or when it's off", async () => {
    const { repo, other, req, ctx } = setup({ repos: [] });
    await expect(req({ op: "start", task: "t_bbbb0001", agent: "claude", repo, prompt: "hi" })).rejects.toThrow(/isn't a repo agents may use/);
    saveAgentConfig(ctx, { enabled: true, repos: [{ root: repo, mode: "edit", worktree: true, deny: [], agents: ["codex"] }] });
    await expect(req({ op: "start", task: "t_bbbb0002", agent: "claude", repo, prompt: "hi" })).rejects.toThrow(/isn't allowed in/);
    await expect(req({ op: "start", task: "t_bbbb0003", agent: "codex", repo: other, prompt: "hi" })).rejects.toThrow(/isn't a repo agents may use/);
    await expect(req({ op: "start", task: "t_bbbb0004", agent: "codex", repo: join(repo, "..", "app-evil"), prompt: "hi" })).rejects.toThrow(/isn't a repo/);
    await expect(req({ op: "start", task: "t_bbbb0005", agent: "bash", repo, prompt: "hi" })).rejects.toThrow(/agents here/);
    await expect(req({ op: "start", task: "../../x", agent: "codex", repo, prompt: "hi" })).rejects.toThrow(/bad task id/);
    await expect(req({ op: "send", native: { tool: "claude", id: "abc", cwd: other }, text: "hi" })).rejects.toThrow(/isn't in a repo/);
    // A session the daemon didn't start: the repo's agent list holds there too, and its id is never an option.
    await expect(req({ op: "send", native: { tool: "claude", id: "abc", cwd: repo }, text: "hi" })).rejects.toThrow(/claude isn't allowed in/);
    await expect(req({ op: "send", native: { tool: "codex", id: "--dangerously-bypass-approvals-and-sandbox", cwd: repo }, text: "hi" })).rejects.toThrow(/bad session id/);
    saveAgentConfig(ctx, { enabled: false, repos: [{ root: repo, mode: "edit", worktree: true, deny: [] }] });
    await expect(req({ op: "start", task: "t_bbbb0006", agent: "codex", repo, prompt: "hi" })).rejects.toThrow(/agent control is off/);
  });

  test("a request never gets a mode above the repo's", async () => {
    const s = setup();
    saveAgentConfig(s.ctx, { enabled: true, repos: [{ root: s.repo, mode: "plan", worktree: true, deny: [] }] });
    const r = (await s.req({ op: "start", task: "t_cccc0001", agent: "claude", repo: s.repo, prompt: "[permission] create x.txt", mode: "auto" })) as { mode: string; cwd: string };
    expect(r.mode).toBe("plan");
    await s.until(() => Boolean(finished(s.events("t_cccc0001"))));
    // The plan-mode stand-in neither asks nor writes.
    expect(s.events("t_cccc0001").some((e) => e.kind === "permission")).toBe(false);
    expect(existsSync(join(r.cwd, "x.txt"))).toBe(false);
  });

  test("a permission prompt waits for the user's answer; a wrong request id is refused", async () => {
    const { repo, events, until, req } = setup();
    const r = (await req({ op: "start", task: "t_dddd0001", agent: "codex", repo, prompt: "[permission] create ok.txt" })) as { cwd: string };
    await until(() => events("t_dddd0001").some((e) => e.kind === "permission"));
    const ask = events("t_dddd0001").find((e) => e.kind === "permission")!;
    expect([ask.data.tool, ask.data.summary, /^p_/.test(ask.data.request ?? "")]).toEqual(["Bash", "touch hello.txt", true]);
    expect(events("t_dddd0001").at(-1)!.data.state).toBe("waiting");
    expect((await req({ op: "sessions" })) as unknown).toEqual({ running: [{ tool: "codex", native: expect.any(String), cwd: r.cwd, title: "t_dddd0001", via: "daemon" }] });
    await expect(req({ op: "approve", task: "t_dddd0001", request: "p_nope", decision: "allow" })).rejects.toThrow(/no permission request/);
    await req({ op: "approve", task: "t_dddd0001", request: ask.data.request, decision: "allow" });
    await until(() => Boolean(finished(events("t_dddd0001"))));
    expect(events("t_dddd0001").map((e) => e.data.text ?? e.data.state)).toContain("allowed");
    expect(existsSync(join(r.cwd, "ok.txt"))).toBe(true);
    // Denied: nothing written.
    await req({ op: "start", task: "t_dddd0002", agent: "codex", repo, prompt: "[permission] create no.txt" });
    await until(() => events("t_dddd0002").some((e) => e.kind === "permission"));
    const ask2 = events("t_dddd0002").find((e) => e.kind === "permission")!;
    await req({ op: "approve", task: "t_dddd0002", request: ask2.data.request, decision: "deny", note: "no" });
    await until(() => Boolean(finished(events("t_dddd0002"))));
    expect(existsSync(join(repo, "..", ".0b-worktrees", "app-t_dddd0002", "no.txt"))).toBe(false);
  });

  test("refused commands, stop, follow-ups, and events kept while the hub is away", async () => {
    const { repo, events, until, req, daemon, frames } = setup();
    await req({ op: "start", task: "t_eeee0001", agent: "claude", repo, prompt: "[cmd:git push origin main] ship it" });
    await until(() => Boolean(finished(events("t_eeee0001"))));
    expect(events("t_eeee0001").some((e) => e.kind === "text" && /rule "git push \* main"/.test(e.data.text ?? ""))).toBe(true);

    await req({ op: "start", task: "t_eeee0002", agent: "claude", repo, prompt: "[hang]" });
    expect(await req({ op: "stop", task: "t_eeee0002" })).toEqual({ task: "t_eeee0002", state: "stopped" });
    await until(() => Boolean(finished(events("t_eeee0002"))));
    expect(finished(events("t_eeee0002"))!.data.state).toBe("stopped");

    // A follow-up to a finished task continues the same session.
    const native = events("t_eeee0001").find((e) => e.data.native)!.data.native;
    daemon.connected(null);
    await req({ op: "send", task: "t_eeee0001", text: "and the docs" });
    await Bun.sleep(50);
    const before = frames.length;
    daemon.connected((f) => {
      frames.push(f);
      return true;
    });
    expect(frames.length).toBeGreaterThan(before);
    await until(() => events("t_eeee0001").filter((e) => e.kind === "done").length === 2);
    const evs = events("t_eeee0001");
    expect(evs.map((e) => e.seq)).toEqual(evs.map((_, i) => i + 1));
    expect(evs.some((e) => e.data.text === "echo: and the docs")).toBe(true);
    expect(evs.filter((e) => e.data.native).every((e) => e.data.native === native)).toBe(true);
  });

  test("a session open in a terminal is checked where it really runs, not where the request says", async () => {
    const { repo, other, ctx } = setup();
    const attached: string[] = [];
    const herdr = {
      id: "herdr" as const,
      available: async () => ({ ok: true }),
      start: async () => {
        throw new Error("no");
      },
      running: async () => [{ native: "w1:p4", cwd: other, tool: "claude" }],
      attach: async (n: { id: string }) => {
        attached.push(n.id);
        throw new Error("attached");
      },
    };
    const denyOf = () => DEFAULT_DENY;
    const daemon = new Daemon(ctx, { adapters: { claude: new FakeAdapter("claude", denyOf), herdr }, log: () => {} });
    daemon.connected(() => true);
    await expect(daemon.request({ t: "req", rid: "r1", op: "send", native: { tool: "claude", id: "w1:p4", cwd: repo }, text: "hi" })).rejects.toThrow(/isn't in a repo agents may use/);
    expect(attached).toEqual([]);
  });

  test("hello lists what this machine offers", async () => {
    const { daemon, repo } = setup({ profiles: { claude: { work: { CLAUDE_CONFIG_DIR: "/x" } } } });
    const h = await daemon.hello();
    expect(h).toMatchObject({ t: "hello", v: 1, machine: { os: process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux" }, profiles: { claude: ["work"] } });
    expect(h.agents).toEqual([
      { id: "claude", ok: true, version: "0.0.0-fake" },
      { id: "codex", ok: true, version: "0.0.0-fake" },
    ]);
    expect(h.repos).toEqual([{ root: repo, repo: "app", agents: ["claude", "codex"], mode: "edit", worktree: true }]);
  });
});
