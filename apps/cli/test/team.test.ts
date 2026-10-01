import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolInstructions, type Context } from "@0bridge/core";
import { asTeamSkill, teamSection } from "../src/team.ts";

// A team's skills and instructions on this machine (M8-3); the sync itself is in apps/gateway/test/team-shared.ts.

describe("team skills", () => {
  test("SKILL.md takes the name members see, keeping the rest", () => {
    expect(asTeamSkill("---\nname: deploy\ndescription: Ship it\n---\n\nRun the checks.\n", "acme--deploy", "Ship it")).toBe("---\nname: acme--deploy\ndescription: Ship it\n---\n\nRun the checks.\n");
  });

  test("one without front matter gets a name and its description", () => {
    expect(asTeamSkill("Run the checks.\n", "acme--deploy", 'Ship "it"')).toBe('---\nname: acme--deploy\ndescription: "Ship \\"it\\""\n---\n\nRun the checks.\n');
  });
});

describe("team instructions", () => {
  let home: string;
  let ctx: Context;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "0bridge-team-"));
    ctx = { home, storeDir: join(home, ".0bridge") };
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  test("every tool gets yours, then each team's section", () => {
    mkdirSync(join(ctx.storeDir, "teams"), { recursive: true });
    writeFileSync(join(ctx.storeDir, "AGENTS.md"), "Use pnpm.\n");
    writeFileSync(join(ctx.storeDir, "teams", "acme.md"), teamSection("Acme", "Ask before touching production."));
    expect(toolInstructions(ctx)).toBe("Use pnpm.\n\n## Team Acme\n\n<!-- from 0bridge: the team's admins change this on the dashboard -->\n\nAsk before touching production.");
  });

  test("with no instructions of your own, just the teams'; with none at all, nothing", () => {
    expect(toolInstructions(ctx)).toBe("");
    mkdirSync(join(ctx.storeDir, "teams"), { recursive: true });
    writeFileSync(join(ctx.storeDir, "teams", "acme.md"), teamSection("Acme", "Be kind."));
    expect(toolInstructions(ctx).startsWith("## Team Acme")).toBe(true);
  });
});
