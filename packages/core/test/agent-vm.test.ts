import { describe, expect, test } from "bun:test";
import { AGENT_VM_PLATFORMS, AGENT_VM_TOS, ATTACH_CODE, agentVmPlatform, agentVmPrompt } from "../src/agent-vm.ts";
import { INSTALL_COMMAND } from "../src/onboarding.ts";

const CODE = "vm_0123456789abcdefghjk";

describe("agent-VM platforms", () => {
  test("nothing says works without the date it was checked; every date is a real day", () => {
    for (const p of AGENT_VM_PLATFORMS) {
      expect(p.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(p.checked))).toBe(false);
      if (p.status === "works") expect(p.checked.length).toBeGreaterThan(0);
    }
  });

  test("honest statuses (R17): Instinct unsupported, Muse and Manus untested, Dots and Grok Bot unverified", () => {
    expect(agentVmPlatform("instinct")?.status).toBe("unsupported");
    expect(agentVmPlatform("muse")?.status).toBe("untested");
    expect(agentVmPlatform("manus")?.status).toBe("untested");
    expect(agentVmPlatform("dots")?.status).toBe("unverified");
    expect(agentVmPlatform("grok-bot")?.status).toBe("unverified");
    expect(AGENT_VM_PLATFORMS.some((p) => p.status === "works")).toBe(false);
    expect(new Set(AGENT_VM_PLATFORMS.map((p) => p.id)).size).toBe(AGENT_VM_PLATFORMS.length);
    expect(agentVmPlatform("nope")).toBeNull();
  });
});

describe("the setup prompt", () => {
  test("with a code: the install line, the code, under 900 characters, no email", () => {
    const text = agentVmPrompt({ server: "https://0bridge.dev", platform: "manus", attach: CODE, email: "me@example.com" });
    expect(text.length).toBeLessThan(900);
    expect(text).toContain(`\`${INSTALL_COMMAND}\``);
    expect(text).toContain(`0b setup --agent-vm --platform manus --attach ${CODE} --no-wait\``);
    expect(text).not.toContain("--email");
    expect(text).not.toContain("--server");
    expect(text).toContain("API key");
  });

  test("without a code: the email hint; another server is named", () => {
    const text = agentVmPrompt({ server: "http://localhost:8813/", email: "me@example.com" });
    expect(text).toContain("0b setup --agent-vm --email me@example.com --no-wait --server http://localhost:8813`");
    expect(text).not.toContain("--attach");
    expect(text).not.toContain("--platform");
  });

  test("Muse names the host to approve in Sentinel; the longest prompt still fits", () => {
    const text = agentVmPrompt({ server: "https://0bridge-staging.example.com", platform: "muse", attach: CODE });
    expect(text).toContain("Sentinel asks to allow 0bridge-staging.example.com");
    expect(text.length).toBeLessThan(900);
    const email = agentVmPrompt({ server: "https://0bridge-staging.example.com", platform: "grok-bot", email: "someone.with.a.long.name@example-company.co.uk" });
    expect(email.length).toBeLessThan(900);
  });

  test("nothing that isn't a plain word reaches the command", () => {
    const text = agentVmPrompt({ server: "https://0bridge.dev", attach: "vm_$(curl evil)", email: "a@b.c; rm -rf ~" });
    expect(text).toContain("`0b setup --agent-vm --no-wait`");
    expect(ATTACH_CODE.test(CODE)).toBe(true);
    expect(ATTACH_CODE.test("vm_0123456789abcdefghji")).toBe(false); // no i, l, o, u
  });

  test("the ToS line names API keys and the device sign-in for Codex", () => {
    expect(AGENT_VM_TOS).toContain("ANTHROPIC_API_KEY");
    expect(AGENT_VM_TOS).toContain("codex login --device-auth");
    expect(AGENT_VM_TOS).toContain("2026-02-19");
  });
});
