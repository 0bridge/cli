import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { CloudError } from "@0bridge/core";
import { agentHere, grantAsk, waitForGrant } from "../src/vault.ts";

describe("what a prod request says about itself", () => {
  test("the agent comes from the variables each sets in its shells; none at a person's terminal", () => {
    expect(agentHere({ CLAUDECODE: "1" })).toBe("claude-code");
    expect(agentHere({ CODEX_SANDBOX: "seatbelt" })).toBe("codex");
    expect(agentHere({ CURSOR_AGENT: "1" })).toBe("cursor");
    expect(agentHere({ GEMINI_CLI: "1" })).toBe("gemini");
    expect(agentHere({ TERM: "xterm" })).toBeNull();
  });

  test("--why, the checkout's name, branch and folders (last two segments), and the names without repeats", () => {
    const repo = join(mkdtempSync(join(tmpdir(), "0b-ask-")), "acme-api");
    spawnSync("git", ["init", "-q", "-b", "fix-billing", repo]);
    const ask = grantAsk(join(repo), "  Deploy the fix  ", ["A_TOKEN", "B_KEY", "A_TOKEN"], { CLAUDECODE: "1" });
    expect(ask.why).toBe("Deploy the fix");
    expect(ask.context).toMatchObject({ agent: "claude-code", repo: "acme-api", branch: "fix-billing", names: ["A_TOKEN", "B_KEY"] });
    expect(ask.context!.cwd!.endsWith("/acme-api")).toBe(true);
    expect(ask.context!.root).toBe(ask.context!.cwd);
  });

  test("outside a repo and without an agent: just the folder and names", () => {
    const dir = mkdtempSync(join(tmpdir(), "0b-ask-"));
    const ask = grantAsk(dir, undefined, ["X"], {});
    expect(ask.why).toBeUndefined();
    expect(ask.context).toEqual({ cwd: ask.context!.cwd, names: ["X"] });
  });
});

describe("waiting for a prod approval", () => {
  type Answer = { status: "pending" | "approved" | "denied" | "expired"; until: number | null };
  /** A server that answers each poll in turn (an Error is thrown), on a clock that moves 2 s a poll. */
  const polls = (answers: (Answer | Error)[], expiresAt = 60_000) => {
    let t = 0;
    let n = 0;
    const client = {
      grant: async () => {
        const a = answers[Math.min(n++, answers.length - 1)]!;
        if (a instanceof Error) throw a;
        return a;
      },
    };
    const wait = () => waitForGrant(client, { id: "g_x", expiresAt }, "prod", async () => void (t += 2000), () => t);
    return { wait, polled: () => n };
  };
  const pending: Answer = { status: "pending", until: null };

  test("a 500 or a dropped connection while waiting isn't an answer: the approval that follows still counts (T-009 DK2C)", async () => {
    const p = polls([pending, new CloudError("500 Internal Server Error", 500), new CloudError("couldn't reach 0bridge.dev (ECONNRESET)", 0), pending, { status: "approved", until: 99 }]);
    expect(await p.wait()).toBe(99);
    expect(p.polled()).toBe(5);
  });

  test("a refusal still ends it at once: 4xx, denied, expired", async () => {
    await expect(polls([new CloudError("not found", 404)]).wait()).rejects.toThrow("not found");
    await expect(polls([{ status: "denied", until: null }]).wait()).rejects.toThrow("prod access was denied in the browser");
    await expect(polls([{ status: "expired", until: null }]).wait()).rejects.toThrow("wasn't given in time");
  });

  test("server errors past the request's expiry end it with that error", async () => {
    const p = polls([new CloudError("500 Internal Server Error", 500)], 5_000);
    await expect(p.wait()).rejects.toThrow("500 Internal Server Error");
    expect(p.polled()).toBe(3);
  });
});
