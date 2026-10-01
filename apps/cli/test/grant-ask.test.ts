import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { agentHere, grantAsk } from "../src/vault.ts";

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
