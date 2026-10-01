import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudClient, DEVICE_TOKEN, loadCloud, openSecretStore } from "@0bridge/core";

/**
 * The daemon against a local machine hub (`wrangler dev` with DEV_LOGIN=1 and agent control on
 * for the dev account), with the stand-in agent (ZEROBRIDGE_AGENT_FAKE=1):
 *   ZEROBRIDGE_E2E=1 GATEWAY_URL=http://localhost:8787 bun test apps/cli/test/agent-e2e.test.ts
 * A task starts from the API, asks permission, is approved, and ends done in its own worktree;
 * a refused command never reaches anyone.
 */

const SERVER = process.env.GATEWAY_URL ?? "http://localhost:8787";
const CLI = join(import.meta.dir, "../src/index.ts");
const GATEWAY = join(import.meta.dir, "../../gateway");

describe.skipIf(!process.env.ZEROBRIDGE_E2E)("agent daemon end to end", () => {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "0b-agent-e2e-")));
  const env = { ...process.env, ZEROBRIDGE_USER_HOME: home, ZEROBRIDGE_DIR: join(home, ".0bridge"), ZEROBRIDGE_SECRET_STORE: "file", ZEROBRIDGE_AGENT_FAKE: "1", BROWSER: join(GATEWAY, "test/fake-browser.ts"), NO_COLOR: "1" };
  const repo = join(home, "work", "app");
  let daemon: ReturnType<typeof spawn> | null = null;
  let daemonOut = "";
  afterAll(() => daemon?.kill());

  test("a task from the hub runs, asks, is approved and finishes in its worktree", async () => {
    // The dev account: no passkeys (they'd block device approval), and agent control on.
    const d1 = join(GATEWAY, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject");
    const db = new Database(join(d1, readdirSync(d1).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")!));
    const dev = `(SELECT id FROM user WHERE email = 'dev@0bridge.local')`;
    db.run(`DELETE FROM passkey WHERE userId IN ${dev}`);
    const login = spawnSync("bun", [CLI, "login", "--server", SERVER], { env, encoding: "utf8" });
    expect(login.status).toBe(0);
    db.run(
      `INSERT INTO account_setting (user_id, agent_control, updated_at) SELECT id, 1, ? FROM user WHERE email = 'dev@0bridge.local' ON CONFLICT(user_id) DO UPDATE SET agent_control = 1`,
      [Date.now()],
    );
    db.close();

    mkdirSync(repo, { recursive: true });
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "README.md"), "app\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    writeFileSync(join(home, ".0bridge", "agent.json"), JSON.stringify({ enabled: true, repos: [{ root: repo, mode: "edit", worktree: true, deny: [] }] }));

    daemon = spawn("bun", [CLI, "agent", "run"], { env, stdio: ["ignore", "pipe", "pipe"] });
    daemon.stdout!.on("data", (d) => (daemonOut += d));
    daemon.stderr!.on("data", (d) => (daemonOut += d));

    const ctx = { home, storeDir: join(home, ".0bridge") };
    const client = new CloudClient(loadCloud(ctx)!.server, openSecretStore(ctx.storeDir).get(DEVICE_TOKEN)!);
    const until = async <T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 20_000): Promise<T> => {
      for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(250)) {
        const v = await fn().catch(() => null);
        if (v) return v;
      }
      throw new Error(`timed out waiting for ${what}\n${daemonOut}`);
    };

    type Machine = { id: string; name: string; online?: boolean };
    const machine = await until("the machine online", async () => (await client.call<Machine[]>("GET", "/machines")).find((m) => m.online !== false));
    const started = await client.call<{ id: string }>("POST", "/machines/tasks", { machine: machine.id, repo, agent: "claude", prompt: "[permission] create hello.txt" });
    const id = started.id;
    expect(id).toMatch(/^t_/);

    type View = { task: { state: string }; events: { kind: string; text: string }[]; pending: { id: string }[] };
    const view = () => client.call<View>("GET", `/machines/tasks/${id}?after=0`);
    const asked = await until("the permission prompt", async () => ((await view()).pending.length ? view() : null));
    const request = asked.pending[0]!.id;
    await client.call("POST", `/machines/tasks/${id}/approve`, { request, decision: "allow" });
    const done = await until("the task to finish", async () => {
      const v = await view();
      return ["done", "failed", "stopped"].includes(v.task.state) ? v : null;
    });
    expect(done.task.state).toBe("done");
    expect(done.events.some((e) => e.text === "echo: [permission] create hello.txt")).toBe(true);
    const tree = join(home, "work", ".0b-worktrees", `app-${id}`);
    expect(readFileSync(join(tree, "hello.txt"), "utf8")).toBe("hi\n");
    expect(existsSync(join(repo, "hello.txt"))).toBe(false);

    // A refused command: the agent hears no at once, and nobody is asked.
    const second = await client.call<{ id: string }>("POST", "/machines/tasks", { machine: machine.id, repo, agent: "claude", prompt: "[cmd:git push origin main] ship" });
    const id2 = second.id;
    const v2 = await until("the second task to finish", async () => {
      const v = await client.call<View>("GET", `/machines/tasks/${id2}?after=0`);
      return v.task.state === "done" ? v : null;
    });
    expect(v2.events.some((e) => /refused|Refused/.test(e.text))).toBe(true);
    expect(v2.pending).toHaveLength(0);

    // Removed on the dashboard: the daemon stops and turns agent control off here, so a service
    // manager restarting it doesn't bring the machine back.
    const exited = new Promise<number | null>((r) => daemon!.once("exit", (code) => r(code)));
    await client.call("DELETE", `/machines/${machine.id}`);
    expect(await exited).toBe(0);
    daemon = null;
    expect(JSON.parse(readFileSync(join(home, ".0bridge", "agent.json"), "utf8")).enabled).toBe(false);
    expect(daemonOut).toContain("removed on the dashboard");
  }, 90_000);
});
