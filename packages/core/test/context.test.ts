/**
 * Your context on 0bridge, the local side: what a sync does with each item from the three
 * hashes (here, 0bridge, last sync), skill hashes, and which files of a skill go up.
 *   bun test packages/core/test/context.test.ts
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextPaths, planSync, readSkill, sha256Hex, skillHash, type SyncAction } from "../src/context.ts";

describe("planSync", () => {
  const cases: [string | null, string | null, string | null, SyncAction, string][] = [
    [null, null, null, "none", "nothing anywhere"],
    ["a", "a", null, "same", "the same copy on both sides, never synced"],
    ["a", "a", "a", "same", "in sync"],
    ["a", null, null, "push", "new here"],
    [null, "a", null, "pull", "new on 0bridge"],
    ["b", "a", "a", "push", "changed here only"],
    ["a", "b", "a", "pull", "changed on 0bridge only"],
    ["b", "c", "a", "conflict", "changed on both sides"],
    ["a", "b", null, "conflict", "both have one and never synced"],
    [null, "a", "a", "none", "removed here only: stays removed here, kept on 0bridge"],
    [null, "b", "a", "pull", "removed here, changed on 0bridge: comes back"],
    ["a", null, "a", "delete-local", "removed on 0bridge, unchanged here"],
    ["b", null, "a", "push", "removed on 0bridge, changed here: the edit wins"],
  ];
  for (const [local, remote, base, want, why] of cases) test(`${why} → ${want}`, () => expect(planSync(local, remote, base)).toBe(want));

  test("two machines: a push, a pull, then edits on both conflict until one side wins", () => {
    // Machine A pushes v1; B had nothing and pulls it.
    let remote: string | null = null;
    const a = { local: "v1" as string | null, base: null as string | null };
    const b = { local: null as string | null, base: null as string | null };
    expect(planSync(a.local, remote, a.base)).toBe("push");
    remote = a.base = "v1";
    expect(planSync(b.local, remote, b.base)).toBe("pull");
    b.local = b.base = remote;
    // Both edit before syncing again: A pushes first, B's sync is a conflict (its copy stays).
    a.local = "v2a";
    b.local = "v2b";
    expect(planSync(a.local, remote, a.base)).toBe("push");
    remote = a.base = "v2a";
    expect(planSync(b.local, remote, b.base)).toBe("conflict");
    // B merges and pushes with --force (no base): from then on both are in sync again.
    remote = b.base = b.local = "v3";
    expect(planSync(b.local, remote, b.base)).toBe("same");
    expect(planSync(a.local, remote, a.base)).toBe("pull");
  });
});

describe("skills", () => {
  test("the hash covers SKILL.md and files, not the order files were read in", () => {
    const one = skillHash("# s", { "b.md": "B", "a.md": "A" });
    expect(one).toBe(skillHash("# s", { "a.md": "A", "b.md": "B" }));
    expect(one).not.toBe(skillHash("# s ", { "a.md": "A", "b.md": "B" }));
    expect(one).not.toBe(skillHash("# s", { "a.md": "A", "b.md": "b" }));
    // The gateway's formula (context.ts skillDigest): sha256 of JSON [body, entries sorted by code unit].
    expect(skillHash("x", { "Z.md": "1", "a.md": "2" })).toBe(sha256Hex(JSON.stringify(["x", [["Z.md", "1"], ["a.md", "2"]]])));
  });

  test("readSkill takes text files, leaves binary, dot and conflict copies", () => {
    const dir = mkdtempSync(join(tmpdir(), "0b-skill-"));
    writeFileSync(join(dir, "SKILL.md"), "---\nname: deploy\ndescription: Ship it\n---\nSteps\n");
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts", "run.sh"), "#!/bin/sh\necho hi\n");
    writeFileSync(join(dir, "ref.md"), "reference");
    writeFileSync(join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
    writeFileSync(join(dir, ".DS_Store"), "x");
    writeFileSync(join(dir, "ref.md.0bridge-remote"), "theirs");
    const s = readSkill(dir, "deploy")!;
    expect(Object.keys(s.files).sort()).toEqual(["ref.md", "scripts/run.sh"]);
    expect(s.skipped).toEqual([{ path: "logo.png", why: "not text" }]);
    expect(s.hash).toBe(skillHash(s.body, s.files));
    expect(readSkill(join(dir, "scripts"), "none")).toBeNull();
  });
});

test("contextPaths: the profile is new, the instructions and skills are the store's", () => {
  const ctx = { home: "/h", storeDir: "/h/.0bridge" };
  expect(contextPaths(ctx)).toEqual({ profile: join("/h/.0bridge", "PROFILE.md"), instructions: join("/h/.0bridge", "AGENTS.md"), skills: join("/h/.0bridge", "skills") });
});
