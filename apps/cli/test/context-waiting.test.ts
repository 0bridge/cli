/**
 * `0b context` sync when 0bridge keeps a change as a proposal (T-075 8196: an agent's computer, with
 * Drive as the source, answers 202 with `waiting`): this machine's copy and its sync base stay as
 * they are, the report says what waits, and nothing is written beside it. A CLI from before this
 * reads the same reply as a 409 (`error`, `current`): it keeps its copy and writes 0bridge's beside it.
 * A stand-in for 0bridge; nothing is sent anywhere.
 *   bun test apps/cli/test/context-waiting.test.ts
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudClient } from "@0bridge/core";
import { planContext, run } from "../src/context";

const waitingReply = { error: "the profile: waiting for the owner's approval in Drive (Drive → Proposals); nothing changed yet", waiting: [{ id: "pp_1", path: ".0bridge/PROFILE.md" }], current: { text: "On 0bridge.", hash: "a".repeat(64), updatedAt: 1 } };

function setup() {
  const home = mkdtempSync(join(tmpdir(), "0b-ctx-wait-"));
  const ctx = { home, storeDir: join(home, ".0bridge") };
  mkdirSync(ctx.storeDir, { recursive: true });
  writeFileSync(join(ctx.storeDir, "PROFILE.md"), "From this agent's computer.");
  const sent: { method: string; path: string; body?: unknown }[] = [];
  const client = {
    call: async (method: string, path: string, body?: unknown) => {
      sent.push({ method, path, body });
      if (method === "GET" && path === "/context") return { profile: waitingReply.current, instructions: null, skills: [], memory: { count: 0 } };
      if (method === "PUT" && path === "/context/profile") return waitingReply;
      throw new Error(`unexpected ${method} ${path}`);
    },
  } as unknown as CloudClient;
  return { ctx, client, sent };
}

test("a proposal kept for the owner: the copy here and the sync base stay, the report says it waits, nothing written beside it", async () => {
  const { ctx, client, sent } = setup();
  const plan = await planContext(ctx, client, "u1", "profile");
  const report = await run(ctx, client, "u1", plan, "push", true);
  expect(sent.some((s) => s.method === "PUT")).toBe(true);
  expect(report.pushed).toEqual([]);
  expect(report.conflicts).toEqual([]);
  expect(report.notes.join("\n")).toContain("waits for your approval in 0bridge's Drive");
  expect(plan.state.profile).toBeNull();
  expect(readFileSync(join(ctx.storeDir, "PROFILE.md"), "utf8")).toBe("From this agent's computer.");
  expect(existsSync(join(ctx.storeDir, "PROFILE.md.0bridge-remote"))).toBe(false);
});

test("an earlier sync base stays as it was; a skill waiting is held the same way", async () => {
  const home = mkdtempSync(join(tmpdir(), "0b-ctx-wait-"));
  const ctx = { home, storeDir: join(home, ".0bridge") };
  mkdirSync(join(ctx.storeDir, "skills", "brief"), { recursive: true });
  writeFileSync(join(ctx.storeDir, "PROFILE.md"), "Edited on the agent's computer.");
  writeFileSync(join(ctx.storeDir, "skills", "brief", "SKILL.md"), "---\ndescription: Brief\n---\nEdited.\n");
  const base = "b".repeat(64);
  // The last sync left both at 0bridge's copy (`base`); both changed here since.
  writeFileSync(join(ctx.storeDir, "context.json"), JSON.stringify({ u1: { profile: base, instructions: null, skills: { brief: base }, lastSync: 1 } }));
  const client = {
    call: async (method: string, path: string) => {
      if (method === "GET" && path === "/context") return { profile: { text: "x", hash: base, updatedAt: 1 }, instructions: null, skills: [{ name: "brief", description: "Brief", hash: base, updatedAt: 1 }], memory: { count: 0 } };
      if (method === "PUT") return { ...waitingReply, current: { name: "brief", description: "Brief", hash: base, updatedAt: 1 } };
      throw new Error(`unexpected ${method} ${path}`);
    },
  } as unknown as CloudClient;
  const plan = await planContext(ctx, client, "u1");
  const report = await run(ctx, client, "u1", plan, "push");
  expect(report.notes.filter((n) => n.includes("waits for your approval"))).toHaveLength(2);
  expect(plan.state.profile).toBe(base);
  expect(plan.state.skills.brief).toBe(base);
  expect(report.conflicts).toEqual([]);
});
