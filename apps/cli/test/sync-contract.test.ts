/**
 * The CLI's two sync engines side by side (T-075 7747): `0b context` (planSync in core, run() in
 * context.ts) and `0b drive` folder sync (drive-sync.ts). Both decide from three states (here, there,
 * and both at the last sync), so one table of cases runs through both, and each row's name says
 * whether they agree (common) or differ on purpose (intentional, and why). Then what each does when a
 * write is refused (a 409, a 202 proposal), and that neither ever uploads a conflict copy.
 *
 * Stand-ins only, nothing is sent anywhere: for /context, a client that answers as the gateway's
 * ContextStore and context-drive.ts do (the same text is fine whatever its base; a stale base is 409
 * with `current`; a proposal is 202 with `waiting`); for Drive, the fake gateway from
 * drive-sync.test.ts (a stale If-Match is 409 with `latest`, checked before the bytes, as drive.ts
 * does). The servers' own halves are pinned in apps/gateway/test/context-drive.test.ts and
 * drive-core.test.ts. (Importing the Drive fake runs drive-sync.test.ts's tests here too, as
 * drive.test.ts does.)
 *   env -u CLAUDE_CONFIG_DIR -u CODEX_HOME BROWSER=none bun test apps/cli/test/sync-contract.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudClient, CloudError, planSync, readSkill, sha256Hex, skillHash, type Context, type ContextDoc } from "@0bridge/core";
import { planContext, run } from "../src/context";
import { cloneFolder, isConflictCopy, loadDriveState, syncFolder } from "../src/drive-sync.ts";
import { startFake, testHome, TOKEN, type Fake } from "./drive-sync.test.ts";

// ── The context side: a stand-in for 0bridge's /context ──

interface FakeSkill {
  body: string;
  files: Record<string, string>;
  hash: string;
}

interface ContextFake {
  profile: ContextDoc | null;
  skills: Map<string, FakeSkill>;
  /** An agent's computer with Drive the source: a write that would change something waits for the owner (202). */
  waiting: boolean;
  /** The owner rejected this change in Drive: 409 with `current` as it is, null if there's none (context-drive.ts REJECTED). */
  refuse?: boolean;
  /** Called before a PUT is answered, to change 0bridge in between. */
  beforePut?: (path: string) => void;
  sent: { method: string; path: string; body?: any }[];
  client: CloudClient;
}

const doc = (text: string): ContextDoc => ({ text, hash: sha256Hex(text), updatedAt: 1 });
const skill = (body: string, files: Record<string, string> = {}): FakeSkill => ({ body, files, hash: skillHash(body, files) });
/** ContextStore's baseOk: undefined overwrites, null or "" means "there was none", a hash has to be the current one. */
const baseOk = (base: string | null | undefined, current: { hash: string } | null) => base === undefined || (base ? current?.hash === base : !current);

function contextFake(): ContextFake {
  const f = { profile: null, skills: new Map(), waiting: false, sent: [] } as unknown as ContextFake;
  const meta = (name: string, s: FakeSkill) => ({ name, description: "", hash: s.hash, updatedAt: 1 });
  const answer = (method: string, path: string, body: any): [number, unknown] => {
    if (method === "GET" && path === "/context") return [200, { profile: f.profile, instructions: null, skills: [...f.skills].map(([n, s]) => meta(n, s)), memory: { count: 0 } }];
    if (method === "GET" && path === "/context/profile") return f.profile ? [200, f.profile] : [404, { error: "no profile yet" }];
    const sk = /^\/context\/skills\/([^/]+)$/.exec(path);
    if (method === "GET" && sk) {
      const s = f.skills.get(decodeURIComponent(sk[1]!));
      return s ? [200, { name: sk[1], description: "", ...s, updatedAt: 1 }] : [404, { error: "no such skill" }];
    }
    if (method === "PUT" && (path === "/context/profile" || sk)) {
      f.beforePut?.(path);
      const name = sk ? decodeURIComponent(sk[1]!) : null;
      const next = name ? skill(body.body, body.files ?? {}) : doc(body.text);
      const cur = name ? (f.skills.has(name) ? meta(name, f.skills.get(name)!) : null) : f.profile;
      // context.ts putDoc / putSkill, context-drive.ts writeDriveDoc: the same text first, then the base, then who may write.
      if (cur?.hash === next.hash) return [200, cur];
      if (!baseOk(body.base, cur)) return [409, { error: "changed elsewhere since", current: cur }];
      if (f.refuse) return [409, { error: "the owner rejected this change in Drive", current: cur }];
      if (f.waiting) return [202, { error: "waiting for the owner's approval in Drive (Drive → Proposals); nothing changed yet", waiting: [{ id: "pp_1", path: name ? `.0bridge/skills/${name}/SKILL.md` : ".0bridge/PROFILE.md" }], current: cur }];
      if (name) {
        f.skills.set(name, next as FakeSkill);
        return [200, meta(name, next as FakeSkill)];
      }
      f.profile = next as ContextDoc;
      return [200, f.profile];
    }
    return [404, { error: `not in the stand-in: ${method} ${path}` }];
  };
  // CloudClient.call's contract: a status in `allow` comes back as the body, any other error is thrown.
  f.client = {
    call: async (method: string, path: string, body?: unknown, allow: number[] = []) => {
      f.sent.push({ method, path, body });
      const [status, res] = answer(method, path, body);
      if (status >= 400 && !allow.includes(status)) throw new CloudError((res as { error: string }).error, status);
      return res;
    },
  } as unknown as CloudClient;
  return f;
}

/** A home for `0b context`; what each side holds is given as text, null for none. */
function contextHome() {
  const home = mkdtempSync(join(tmpdir(), "0b-sync-contract-"));
  const ctx: Context = { home, storeDir: join(home, ".0bridge") };
  mkdirSync(ctx.storeDir, { recursive: true });
  return { home, ctx };
}

// ── The table: one item through both engines ──

/** `undefined`: as it was at the last sync; null: removed; text: changed to it. */
type Side = string | null | undefined;
interface Row {
  /** Both sides at the last sync; null: they never synced it. */
  base: string | null;
  here: Side;
  there: Side;
}

describe("one three-way table, both engines", () => {
  let fake: Fake;
  let home: string;
  let ctx: Context;
  const homes: string[] = [];

  beforeAll(() => {
    fake = startFake();
  });
  afterAll(() => fake.close());
  beforeEach(() => {
    fake.reset();
    ({ home, ctx } = testHome(fake, "0b-sync-contract-drive-"));
    homes.push(home);
  });
  afterEach(() => {
    for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
  });

  /** The profile through `0b context sync`. */
  async function viaContext(row: Row) {
    const h = contextHome();
    homes.push(h.home);
    const c = contextFake();
    const file = join(h.ctx.storeDir, "PROFILE.md");
    const now = (s: Side) => (s === undefined ? row.base : s);
    if (row.base !== null) writeFileSync(join(h.ctx.storeDir, "context.json"), JSON.stringify({ u1: { profile: sha256Hex(row.base), instructions: null, skills: {} } }));
    if (now(row.here) !== null) writeFileSync(file, now(row.here)!);
    c.profile = now(row.there) === null ? null : doc(now(row.there)!);
    const plan = await planContext(h.ctx, c.client, "u1", "profile");
    const action = plan.items[0]!.action;
    const report = await run(h.ctx, c.client, "u1", plan, "sync");
    const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : null);
    return {
      action,
      report,
      here: read(file),
      copy: read(`${file}.0bridge-remote`),
      there: c.profile?.text ?? null,
      base: plan.state.profile,
      writes: c.sent.filter((s) => s.method !== "GET"),
      /** Sync again: what it sends, and what's then here and its base. */
      again: async () => {
        c.sent.length = 0;
        const p2 = await planContext(h.ctx, c.client, "u1", "profile");
        const r2 = await run(h.ctx, c.client, "u1", p2, "sync");
        return { action: p2.items[0]!.action, report: r2, writes: c.sent.filter((s) => s.method !== "GET"), here: read(file), base: p2.state.profile };
      },
      ctx: h.ctx,
      fake: c,
    };
  }

  /** `notes.md` in a folder cloned from Drive, through `0b drive sync`. */
  async function viaDrive(row: Row) {
    fake.edit("work/keep.md", "keep\n");
    if (row.base !== null) fake.edit("work/notes.md", row.base, { via: "Dashboard" });
    const dir = await cloneFolder(ctx, "work", join(home, "work"), { quiet: true });
    const file = join(dir, "notes.md");
    if (row.here === null) rmSync(file);
    else if (row.here !== undefined) writeFileSync(file, row.here);
    if (row.there === null) fake.remove("work/notes.md");
    else if (row.there !== undefined) fake.edit("work/notes.md", row.there, { via: "Claude" });
    const sent: { method: string; path: string; ifMatch?: string }[] = [];
    // The real client, its writes noted with their If-Match.
    const client = new (class extends CloudClient {
      override raw(method: string, path: string, body?: BodyInit | null, headers: Record<string, string> = {}) {
        if (method !== "GET") sent.push({ method, path: decodeURIComponent(path), ifMatch: headers["If-Match"] });
        return super.raw(method, path, body, headers);
      }
    })(fake.url, TOKEN);
    const r = await syncFolder(ctx, dir, { client });
    return {
      r,
      here: existsSync(file) ? readFileSync(file, "utf8") : null,
      copies: readdirSync(dir).filter((n) => n.includes(".0bridge-")),
      there: fake.text("work/notes.md"),
      base: loadDriveState(ctx).folders[dir]!.files["notes.md"],
      sent,
      dir,
    };
  }

  test("unchanged on both sides: neither sends anything (common)", async () => {
    const row: Row = { base: "v0", here: undefined, there: undefined };
    const cx = await viaContext(row);
    expect(cx.action).toBe("same");
    expect(cx.writes).toEqual([]);
    expect(cx.base).toBe(sha256Hex("v0"));
    const dr = await viaDrive(row);
    expect(dr.sent).toEqual([]);
    expect([dr.r.pulled, dr.r.pushed, dr.r.conflicts]).toEqual([[], [], []]);
    expect(dr.base!.version).toBe(1);
  });

  test("changed here only: both push it against the recorded base, which then moves to the new copy (common)", async () => {
    const row: Row = { base: "v0", here: "mine", there: undefined };
    const cx = await viaContext(row);
    expect(cx.action).toBe("push");
    expect(cx.writes).toEqual([{ method: "PUT", path: "/context/profile", body: { text: "mine", base: sha256Hex("v0") } }]);
    expect([cx.there, cx.base]).toEqual(["mine", sha256Hex("mine")]);
    const dr = await viaDrive(row);
    expect(dr.sent).toEqual([{ method: "PUT", path: "/drive/content?workspace=ws_personal&path=work/notes.md", ifMatch: "1" }]);
    expect(dr.r.pushed).toEqual(["notes.md"]);
    expect(dr.there).toBe("mine");
    expect(dr.base).toMatchObject({ version: 2, sha256: sha256Hex("mine") });
  });

  test("changed there only: both pull it and record it as the base (common)", async () => {
    const row: Row = { base: "v0", here: undefined, there: "theirs" };
    const cx = await viaContext(row);
    expect(cx.action).toBe("pull");
    expect(cx.writes).toEqual([]);
    expect([cx.here, cx.base]).toEqual(["theirs", sha256Hex("theirs")]);
    const dr = await viaDrive(row);
    expect(dr.r.pulled).toEqual(["notes.md"]);
    expect(dr.sent).toEqual([]);
    expect(dr.here).toBe("theirs");
    expect(dr.base).toMatchObject({ version: 2, sha256: sha256Hex("theirs") });
  });

  test("changed on both sides to the same text: both just record it, with no copy and nothing sent (common)", async () => {
    const row: Row = { base: "v0", here: "same", there: "same" };
    const cx = await viaContext(row);
    expect(cx.action).toBe("same");
    expect(cx.writes).toEqual([]);
    expect([cx.copy, cx.base]).toEqual([null, sha256Hex("same")]);
    const dr = await viaDrive(row);
    expect(dr.sent).toEqual([]);
    expect(dr.copies).toEqual([]);
    expect(dr.r.conflicts).toEqual([]);
    expect(dr.base).toMatchObject({ version: 2, sha256: sha256Hex("same") });
  });

  test("changed on both sides differently: context keeps this machine's copy, writes 0bridge's beside it and sends nothing; Drive sync saves theirs beside it and pushes ours on top (intentional: a context sync never overwrites a copy changed on both sides, a Drive folder is this machine's to push)", async () => {
    const row: Row = { base: "v0", here: "mine", there: "theirs" };
    const cx = await viaContext(row);
    expect(cx.action).toBe("conflict");
    expect(cx.writes).toEqual([]);
    expect([cx.here, cx.copy, cx.there]).toEqual(["mine", "theirs", "theirs"]);
    expect(cx.base).toBe(sha256Hex("v0")); // the base stays, so the next sync sees the conflict again
    expect(cx.report.conflicts).toHaveLength(1);
    expect(cx.report.pushed).toEqual([]);
    const dr = await viaDrive(row);
    expect(dr.r.conflicts).toEqual([{ path: "notes.md", copy: "notes.0bridge-claude-v2.md" }]);
    expect(readFileSync(join(dr.dir, "notes.0bridge-claude-v2.md"), "utf8")).toBe("theirs");
    expect([dr.here, dr.there]).toEqual(["mine", "mine"]);
    expect(dr.sent).toEqual([{ method: "PUT", path: "/drive/content?workspace=ws_personal&path=work/notes.md", ifMatch: "2" }]);
    expect(dr.base).toMatchObject({ version: 3, sha256: sha256Hex("mine") });
  });

  test("new on both sides with different text, never synced: both call it a conflict (common), and each handles it as above (intentional)", async () => {
    const row: Row = { base: null, here: "mine", there: "theirs" };
    const cx = await viaContext(row);
    expect(cx.action).toBe("conflict");
    expect(cx.writes).toEqual([]);
    expect([cx.here, cx.copy, cx.there, cx.base]).toEqual(["mine", "theirs", "theirs", null]);
    const dr = await viaDrive(row);
    expect(dr.r.conflicts).toEqual([{ path: "notes.md", copy: "notes.0bridge-claude-v1.md" }]);
    expect([dr.here, dr.there]).toEqual(["mine", "mine"]);
    expect(dr.base!.version).toBe(2);
  });

  test("new on both sides with the same text: both record it, nothing sent (common)", async () => {
    const row: Row = { base: null, here: "same", there: "same" };
    const cx = await viaContext(row);
    expect(cx.action).toBe("same");
    expect([cx.writes, cx.copy, cx.base]).toEqual([[], null, sha256Hex("same")]);
    const dr = await viaDrive(row);
    expect([dr.sent, dr.copies]).toEqual([[], []]);
    expect(dr.base).toMatchObject({ version: 1, sha256: sha256Hex("same") });
  });

  test("deleted there, unchanged here: a skill is removed here as a Drive file is (common)", async () => {
    // A skill: a document isn't removed here (see the profile's case below).
    const h = contextHome();
    homes.push(h.home);
    const c = contextFake();
    const s = skill("---\ndescription: Demo\n---\nDo it.\n");
    mkdirSync(join(h.ctx.storeDir, "skills", "demo"), { recursive: true });
    writeFileSync(join(h.ctx.storeDir, "skills", "demo", "SKILL.md"), s.body);
    writeFileSync(join(h.ctx.storeDir, "context.json"), JSON.stringify({ u1: { profile: null, instructions: null, skills: { demo: s.hash } } }));
    const plan = await planContext(h.ctx, c.client, "u1");
    expect(plan.items.find((it) => it.name === "demo")!.action).toBe("delete-local");
    const report = await run(h.ctx, c.client, "u1", plan, "sync");
    expect(report.removed).toEqual(["skill demo"]);
    expect(existsSync(join(h.ctx.storeDir, "skills", "demo"))).toBe(false);
    expect(plan.state.skills.demo).toBeUndefined();
    expect(c.sent.filter((x) => x.method !== "GET")).toEqual([]);

    const dr = await viaDrive({ base: "v0", here: undefined, there: null });
    expect(dr.r.removed).toEqual(["notes.md"]);
    expect([dr.here, dr.base, dr.sent]).toEqual([null, undefined, []]);
  });

  // planSync says delete-local, which planContext turns into a push for a document ("missing there
  // means push it again"), on the old base. 0bridge (ContextStore's baseOk; context-drive.ts the
  // same) refuses a hash base when there is none: 409 with `current: null`. Reachable with
  // CONTEXT_DRIVE on: PROFILE.md deleted in Drive. There's no copy to fetch, so run() never does.
  test("deleted there, unchanged here: the profile stays here with its base cleared and isn't sent again until it changes; Drive sync removes the file (intentional: a sync never removes a document from this machine)", async () => {
    const cx = await viaContext({ base: "v0", here: undefined, there: null });
    expect(cx.action).toBe("push");
    expect(cx.writes).toEqual([{ method: "PUT", path: "/context/profile", body: { text: "v0", base: sha256Hex("v0") } }]);
    expect([cx.here, cx.there, cx.copy, cx.base]).toEqual(["v0", null, null, null]);
    expect([cx.report.pushed, cx.report.conflicts]).toEqual([[], []]);
    expect(cx.report.notes.join("\n")).toContain("removed on 0bridge");
    expect(cx.fake.sent.some((s) => s.method === "GET" && s.path !== "/context")).toBe(false);
    // The state is saved, so the next sync doesn't throw; and with a base of null planSync says
    // "push", so the hash it had when it went is remembered, and it isn't sent back up.
    expect(planSync(sha256Hex("v0"), null, null)).toBe("push");
    expect(JSON.parse(readFileSync(join(cx.ctx.storeDir, "context.json"), "utf8")).u1).toMatchObject({ profile: null, gone: { profile: sha256Hex("v0") } });
    const next = await cx.again();
    expect([next.action, next.writes, next.here, next.base]).toEqual(["none", [], "v0", null]);
    // Changed here later: it goes up as new.
    writeFileSync(join(cx.ctx.storeDir, "PROFILE.md"), "v1");
    const later = await cx.again();
    expect(later.writes).toEqual([{ method: "PUT", path: "/context/profile", body: { text: "v1", base: null } }]);
    expect([cx.fake.profile?.text, later.base]).toEqual(["v1", sha256Hex("v1")]);
    expect(JSON.parse(readFileSync(join(cx.ctx.storeDir, "context.json"), "utf8")).u1.gone).toEqual({});

    const dr = await viaDrive({ base: "v0", here: undefined, there: null });
    expect(dr.r.removed).toEqual(["notes.md"]);
  });

  test("deleted there, unchanged here, then written there again: the new copy comes down (a pull), not a conflict; the old one isn't sent", async () => {
    const cx = await viaContext({ base: "v0", here: undefined, there: null });
    expect(cx.report.notes.join("\n")).toContain("removed on 0bridge");
    cx.fake.profile = doc("v2");
    const next = await cx.again();
    expect(next.action).toBe("pull");
    expect([next.writes, next.here, next.base]).toEqual([[], "v2", sha256Hex("v2")]);
    expect(existsSync(join(cx.ctx.storeDir, "PROFILE.md.0bridge-remote"))).toBe(false);
    expect(JSON.parse(readFileSync(join(cx.ctx.storeDir, "context.json"), "utf8")).u1.gone).toEqual({});
  });

  test("deleted there, unchanged here, a skill's push refused with current null anyway: it goes here as delete-local does, manifest too, and nothing is fetched", async () => {
    // planSync gives delete-local, which sends nothing; a push planned on the old base (and removed
    // on 0bridge in between) is what reaches the 409.
    const h = contextHome();
    homes.push(h.home);
    const c = contextFake();
    const s = skill("---\ndescription: Demo\n---\nv0\n");
    mkdirSync(join(h.ctx.storeDir, "skills", "demo"), { recursive: true });
    writeFileSync(join(h.ctx.storeDir, "skills", "demo", "SKILL.md"), s.body);
    writeFileSync(join(h.ctx.storeDir, "0bridge.json"), JSON.stringify({ version: 1, tools: {}, mcpServers: {}, skills: { demo: {} }, instructions: { enabled: true } }));
    writeFileSync(join(h.ctx.storeDir, "context.json"), JSON.stringify({ u1: { profile: null, instructions: null, skills: { demo: s.hash } } }));
    const plan = await planContext(h.ctx, c.client, "u1");
    const it = plan.items.find((x) => x.name === "demo")!;
    expect(it.action).toBe("delete-local");
    it.action = "push";
    const report = await run(h.ctx, c.client, "u1", plan, "sync");
    expect(c.sent.filter((x) => x.path !== "/context").map((x) => `${x.method} ${x.path}`)).toEqual(["PUT /context/skills/demo"]);
    expect([report.removed, report.conflicts]).toEqual([["skill demo"], []]);
    expect(existsSync(join(h.ctx.storeDir, "skills", "demo"))).toBe(false);
    expect(JSON.parse(readFileSync(join(h.ctx.storeDir, "0bridge.json"), "utf8")).skills).toEqual({});
    expect(JSON.parse(readFileSync(join(h.ctx.storeDir, "context.json"), "utf8")).u1.skills).toEqual({});
  });

  test("deleted there, changed here: both decide to push this machine's copy, and Drive sync sends it as a new file (common decision)", async () => {
    expect(planSync(sha256Hex("mine"), null, sha256Hex("v0"))).toBe("push");
    const dr = await viaDrive({ base: "v0", here: "mine", there: null });
    expect(dr.r.pushed).toEqual(["notes.md"]);
    expect(dr.sent).toEqual([{ method: "PUT", path: "/drive/content?workspace=ws_personal&path=work/notes.md", ifMatch: "0" }]);
    expect([dr.here, dr.there]).toEqual(["mine", "mine"]);
  });

  // The PUT carries the old base, and 0bridge answers 409 with `current: null`: this machine's copy
  // goes up again as new (base null), as Drive sync sends a file with If-Match 0.
  test("deleted there, changed here: context pushes this machine's profile again as new, noting it had been removed (common outcome)", async () => {
    const cx = await viaContext({ base: "v0", here: "mine", there: null });
    expect(cx.action).toBe("push");
    expect(cx.writes).toEqual([
      { method: "PUT", path: "/context/profile", body: { text: "mine", base: sha256Hex("v0") } },
      { method: "PUT", path: "/context/profile", body: { text: "mine", base: null } },
    ]);
    expect([cx.here, cx.there, cx.copy, cx.base]).toEqual(["mine", "mine", null, sha256Hex("mine")]);
    expect([cx.report.pushed.length, cx.report.conflicts]).toEqual([1, []]);
    expect(cx.report.notes.join("\n")).toContain("had been removed on 0bridge");
    const next = await cx.again();
    expect([next.action, next.writes, next.base]).toEqual(["same", [], sha256Hex("mine")]);
  });

  test("deleted there (0b context rm on another machine), changed here: context pushes this machine's skill again as new, noting it had been removed", async () => {
    const h = contextHome();
    homes.push(h.home);
    const c = contextFake();
    mkdirSync(join(h.ctx.storeDir, "skills", "demo"), { recursive: true });
    writeFileSync(join(h.ctx.storeDir, "skills", "demo", "SKILL.md"), "---\ndescription: Demo\n---\nmine\n");
    const v0 = skill("---\ndescription: Demo\n---\nv0\n").hash;
    writeFileSync(join(h.ctx.storeDir, "context.json"), JSON.stringify({ u1: { profile: null, instructions: null, skills: { demo: v0 } } }));
    let plan = await planContext(h.ctx, c.client, "u1");
    expect(plan.items.find((it) => it.name === "demo")!.action).toBe("push");
    const report = await run(h.ctx, c.client, "u1", plan, "sync");
    expect(c.sent.filter((s) => s.method === "PUT").map((s) => s.body.base)).toEqual([v0, null]);
    expect(c.sent.some((s) => s.method === "GET" && s.path === "/context/skills/demo")).toBe(false);
    expect([report.pushed, report.conflicts]).toEqual([["skill demo"], []]);
    expect(report.notes.join("\n")).toContain("had been removed on 0bridge");
    expect(c.skills.get("demo")!.body).toContain("mine");
    expect(existsSync(join(h.ctx.storeDir, "skills", ".0bridge-remote"))).toBe(false);
    // Saved: the next sync doesn't throw and sends nothing.
    c.sent.length = 0;
    plan = await planContext(h.ctx, c.client, "u1");
    expect(plan.state.skills.demo).toBe(c.skills.get("demo")!.hash);
    await run(h.ctx, c.client, "u1", plan, "sync");
    expect(c.sent.filter((s) => s.method !== "GET")).toEqual([]);
  });

  test("deleted here, changed there: both bring theirs back (common)", async () => {
    const row: Row = { base: "v0", here: null, there: "theirs" };
    const cx = await viaContext(row);
    expect(cx.action).toBe("pull");
    expect([cx.here, cx.base, cx.writes]).toEqual(["theirs", sha256Hex("theirs"), []]);
    const dr = await viaDrive(row);
    expect(dr.r.pulled).toEqual(["notes.md"]);
    expect([dr.here, dr.there, dr.sent]).toEqual(["theirs", "theirs", []]);
  });

  test("deleted here, unchanged there: context leaves 0bridge's copy and its base alone; Drive sync deletes it with If-Match (intentional: one machine's delete never reaches 0bridge for context, `0b context rm` does; a Drive folder mirrors)", async () => {
    const row: Row = { base: "v0", here: null, there: undefined };
    const cx = await viaContext(row);
    expect(cx.action).toBe("none");
    expect([cx.here, cx.there, cx.writes]).toEqual([null, "v0", []]);
    expect(cx.base).toBe(sha256Hex("v0"));
    const dr = await viaDrive(row);
    expect(dr.sent).toEqual([{ method: "DELETE", path: "/drive/content?workspace=ws_personal&path=work/notes.md", ifMatch: "1" }]);
    expect(dr.r.deleted).toEqual(["notes.md"]);
    expect([dr.there, dr.base]).toEqual([null, undefined]);
  });

  test("the same text landing there between the read and the write: context's 0bridge answers 200 whatever the base, Drive answers 409 and sync saves a copy identical to ours (intentional: context writes are idempotent, a Drive write on a stale base is shown to the caller)", async () => {
    // Context: planned as a push on base v0, and by the PUT 0bridge already has "mine".
    const h = contextHome();
    homes.push(h.home);
    const c = contextFake();
    writeFileSync(join(h.ctx.storeDir, "PROFILE.md"), "mine");
    writeFileSync(join(h.ctx.storeDir, "context.json"), JSON.stringify({ u1: { profile: sha256Hex("v0"), instructions: null, skills: {} } }));
    c.profile = doc("v0");
    c.beforePut = () => (c.profile = doc("mine"));
    const plan = await planContext(h.ctx, c.client, "u1", "profile");
    const report = await run(h.ctx, c.client, "u1", plan, "sync");
    expect(report.pushed).toHaveLength(1);
    expect(report.conflicts).toEqual([]);
    expect(plan.state.profile).toBe(sha256Hex("mine"));
    expect(existsSync(join(h.ctx.storeDir, "PROFILE.md.0bridge-remote"))).toBe(false);

    // Drive: the same, the PUT on If-Match 1 meets v2 with the same bytes.
    let once = false;
    fake.beforePut = (path) => {
      if (path !== "work/notes.md" || once) return;
      once = true;
      fake.edit("work/notes.md", "mine", { via: "Claude" });
    };
    const dr = await viaDrive({ base: "v0", here: "mine", there: undefined });
    expect(dr.sent.map((s) => s.ifMatch)).toEqual(["1", "2"]);
    expect(dr.r.conflicts).toEqual([{ path: "notes.md", copy: "notes.0bridge-claude-v2.md" }]);
    expect(readFileSync(join(dr.dir, "notes.0bridge-claude-v2.md"), "utf8")).toBe("mine");
    expect(dr.r.pushed).toEqual([]); // the second PUT is unchanged
    expect(dr.base).toMatchObject({ version: 2, sha256: sha256Hex("mine") });
    expect(dr.r.errors).toEqual([]);
  });
});

// ── A refused write ──

describe("a refused write", () => {
  let fake: Fake;
  let home: string;
  let ctx: Context;
  const homes: string[] = [];
  beforeAll(() => {
    fake = startFake();
  });
  afterAll(() => fake.close());
  beforeEach(() => {
    fake.reset();
    ({ home, ctx } = testHome(fake, "0b-sync-contract-drive-"));
    homes.push(home);
  });
  afterEach(() => {
    for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
  });
  const fresh = () => {
    const h = contextHome();
    homes.push(h.home);
    return h;
  };

  test("context, 409 on the profile: this machine's copy and the base stay, 0bridge's text from the 409 is written beside it, and the next sync sends nothing", async () => {
    const { ctx: cctx } = fresh();
    const c = contextFake();
    writeFileSync(join(cctx.storeDir, "PROFILE.md"), "mine");
    writeFileSync(join(cctx.storeDir, "context.json"), JSON.stringify({ u1: { profile: sha256Hex("v0"), instructions: null, skills: {} } }));
    c.profile = doc("v0");
    c.beforePut = () => (c.profile = doc("theirs"));
    let plan = await planContext(cctx, c.client, "u1", "profile");
    expect(plan.items[0]!.action).toBe("push");
    const report = await run(cctx, c.client, "u1", plan, "sync");
    expect(report.pushed).toEqual([]);
    expect(report.conflicts).toHaveLength(1);
    expect(readFileSync(join(cctx.storeDir, "PROFILE.md"), "utf8")).toBe("mine");
    expect(readFileSync(join(cctx.storeDir, "PROFILE.md.0bridge-remote"), "utf8")).toBe("theirs");
    expect(c.sent.some((s) => s.method === "GET" && s.path === "/context/profile")).toBe(false); // the 409's `current` is the copy
    expect(plan.state.profile).toBe(sha256Hex("v0"));
    expect(c.profile!.text).toBe("theirs");

    c.beforePut = undefined;
    c.sent.length = 0;
    plan = await planContext(cctx, c.client, "u1", "profile");
    expect(plan.items[0]!.action).toBe("conflict");
    await run(cctx, c.client, "u1", plan, "sync");
    expect(c.sent.filter((s) => s.method === "PUT")).toEqual([]);
  });

  test("context, 409 on a skill: 0bridge's copy goes under skills/.0bridge-remote/<name>/, this machine's stays, and so does the base", async () => {
    const { ctx: cctx } = fresh();
    const c = contextFake();
    const base = skill("---\ndescription: Demo\n---\nv0\n");
    const dir = join(cctx.storeDir, "skills", "demo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\ndescription: Demo\n---\nmine\n");
    writeFileSync(join(cctx.storeDir, "context.json"), JSON.stringify({ u1: { profile: null, instructions: null, skills: { demo: base.hash } } }));
    c.skills.set("demo", base);
    c.beforePut = () => c.skills.set("demo", skill("---\ndescription: Demo\n---\ntheirs\n", { "ref.md": "theirs" }));
    const plan = await planContext(cctx, c.client, "u1");
    const report = await run(cctx, c.client, "u1", plan, "sync");
    expect(report.conflicts).toHaveLength(1);
    expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toContain("mine");
    expect(readFileSync(join(cctx.storeDir, "skills", ".0bridge-remote", "demo", "SKILL.md"), "utf8")).toContain("theirs");
    expect(readFileSync(join(cctx.storeDir, "skills", ".0bridge-remote", "demo", "ref.md"), "utf8")).toBe("theirs");
    expect(plan.state.skills.demo).toBe(base.hash);
  });

  test("context, 409 with current null and the push as new refused too: a conflict without a copy, the sync goes on and saves its state", async () => {
    const { ctx: cctx } = fresh();
    const c = contextFake();
    c.refuse = true;
    writeFileSync(join(cctx.storeDir, "PROFILE.md"), "mine");
    const dir = join(cctx.storeDir, "skills", "other");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\ndescription: Other\n---\nmine\n");
    const other = skill("---\ndescription: Other\n---\nv0\n");
    writeFileSync(join(cctx.storeDir, "context.json"), JSON.stringify({ u1: { profile: sha256Hex("v0"), instructions: null, skills: { other: other.hash } } }));
    c.skills.set("other", other);
    c.beforePut = (path) => {
      if (path === "/context/skills/other") c.refuse = false;
    };
    const plan = await planContext(cctx, c.client, "u1");
    const report = await run(cctx, c.client, "u1", plan, "sync");
    expect(c.sent.filter((s) => s.method === "PUT").map((s) => [s.path, s.body.base])).toEqual([
      ["/context/profile", sha256Hex("v0")],
      ["/context/profile", null],
      ["/context/skills/other", other.hash],
    ]);
    // Not a conflict to merge (nothing is there, and --force wouldn't change a refusal): a note.
    expect(report.conflicts).toEqual([]);
    expect(report.notes).toContainEqual(expect.stringContaining("the owner rejected this change in Drive"));
    expect(report.pushed).toEqual(["skill other"]);
    expect(existsSync(join(cctx.storeDir, "PROFILE.md.0bridge-remote"))).toBe(false);
    expect(c.sent.some((s) => s.method === "GET" && s.path === "/context/profile")).toBe(false);
    const saved = JSON.parse(readFileSync(join(cctx.storeDir, "context.json"), "utf8")).u1;
    expect([saved.profile, saved.skills.other, typeof saved.lastSync]).toEqual([sha256Hex("v0"), c.skills.get("other")!.hash, "number"]);
  });

  test("Drive, 409: theirs is saved beside it, ours goes up on top, and the base becomes the version it went on top of", async () => {
    fake.edit("work/notes.md", "v0");
    const dir = await cloneFolder(ctx, "work", join(home, "work"), { quiet: true });
    writeFileSync(join(dir, "notes.md"), "mine");
    let once = false;
    fake.beforePut = (path) => {
      if (path !== "work/notes.md" || once) return;
      once = true;
      fake.edit("work/notes.md", "theirs", { via: "Claude" });
    };
    const r = await syncFolder(ctx, dir);
    expect(r.conflicts).toEqual([{ path: "notes.md", copy: "notes.0bridge-claude-v2.md" }]);
    expect(readFileSync(join(dir, "notes.0bridge-claude-v2.md"), "utf8")).toBe("theirs");
    expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("mine");
    expect(fake.text("work/notes.md")).toBe("mine");
    expect(loadDriveState(ctx).folders[dir]!.files["notes.md"]).toMatchObject({ version: 3, sha256: sha256Hex("mine") });
  });

  test("context, 202: the copy and the base stay, nothing is written beside it, and every sync sends the same PUT again", async () => {
    const { ctx: cctx } = fresh();
    const c = contextFake();
    c.waiting = true;
    writeFileSync(join(cctx.storeDir, "PROFILE.md"), "mine");
    writeFileSync(join(cctx.storeDir, "context.json"), JSON.stringify({ u1: { profile: sha256Hex("v0"), instructions: null, skills: {} } }));
    c.profile = doc("v0");
    for (let i = 0; i < 2; i++) {
      const plan = await planContext(cctx, c.client, "u1", "profile");
      const report = await run(cctx, c.client, "u1", plan, "sync");
      expect(report.notes.join("\n")).toContain("waits for your approval");
      expect([report.pushed, report.conflicts]).toEqual([[], []]);
      expect(plan.state.profile).toBe(sha256Hex("v0"));
    }
    expect(c.sent.filter((s) => s.method === "PUT").map((s) => s.body)).toEqual([
      { text: "mine", base: sha256Hex("v0") },
      { text: "mine", base: sha256Hex("v0") },
    ]);
    expect(readFileSync(join(cctx.storeDir, "PROFILE.md"), "utf8")).toBe("mine");
    expect(existsSync(join(cctx.storeDir, "PROFILE.md.0bridge-remote"))).toBe(false);
    expect(c.profile!.text).toBe("v0");
  });

  test("Drive, 202: the proposal is reported once, its hash is recorded at the old version, and it isn't sent again until it changes here", async () => {
    fake.edit("work/AGENTS.md", "v0");
    const dir = await cloneFolder(ctx, "work", join(home, "work"), { quiet: true });
    fake.trusted = false;
    writeFileSync(join(dir, "AGENTS.md"), "mine");
    let r = await syncFolder(ctx, dir);
    expect(r.proposals.map((p) => p.path)).toEqual(["AGENTS.md"]);
    expect(r.pushed).toEqual([]);
    expect(loadDriveState(ctx).folders[dir]!.files["AGENTS.md"]).toMatchObject({ version: 1, sha256: sha256Hex("mine") });
    expect(fake.text("work/AGENTS.md")).toBe("v0");
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe("mine");
    expect(readdirSync(dir).filter((n) => n.includes(".0bridge-"))).toEqual([]);
    fake.requests.length = 0;
    r = await syncFolder(ctx, dir);
    expect(r.proposals).toEqual([]);
    expect(fake.requests.filter((q) => q.startsWith("PUT"))).toEqual([]);
  });
});

// ── Conflict copies never travel ──

describe("conflict copies never travel", () => {
  let fake: Fake;
  let home: string;
  let ctx: Context;
  const homes: string[] = [];
  beforeAll(() => {
    fake = startFake();
  });
  afterAll(() => fake.close());
  beforeEach(() => {
    fake.reset();
    ({ home, ctx } = testHome(fake, "0b-sync-contract-drive-"));
    homes.push(home);
  });
  afterEach(() => {
    for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
  });

  test("context: after a conflict, neither PROFILE.md.0bridge-remote nor skills/.0bridge-remote/ goes up, not even with push --force", async () => {
    const h = contextHome();
    homes.push(h.home);
    const c = contextFake();
    const store = h.ctx.storeDir;
    const base = skill("---\ndescription: Demo\n---\nv0\n");
    mkdirSync(join(store, "skills", "demo"), { recursive: true });
    writeFileSync(join(store, "skills", "demo", "SKILL.md"), "---\ndescription: Demo\n---\nmine\n");
    writeFileSync(join(store, "PROFILE.md"), "mine");
    writeFileSync(join(store, "context.json"), JSON.stringify({ u1: { profile: sha256Hex("v0"), instructions: null, skills: { demo: base.hash } } }));
    c.profile = doc("theirs");
    c.skills.set("demo", skill("---\ndescription: Demo\n---\ntheirs\n"));
    let plan = await planContext(h.ctx, c.client, "u1");
    await run(h.ctx, c.client, "u1", plan, "sync");
    expect(existsSync(join(store, "PROFILE.md.0bridge-remote"))).toBe(true);
    expect(existsSync(join(store, "skills", ".0bridge-remote", "demo", "SKILL.md"))).toBe(true);
    // A copy of a skill's own file beside it stays out of the skill too.
    writeFileSync(join(store, "skills", "demo", "ref.md.0bridge-remote"), "theirs");

    plan = await planContext(h.ctx, c.client, "u1");
    expect(plan.items.map((it) => it.name)).not.toContain(".0bridge-remote");
    await run(h.ctx, c.client, "u1", plan, "push", true);
    const puts = c.sent.filter((s) => s.method === "PUT");
    expect(puts.map((s) => s.path).sort()).toEqual(["/context/profile", "/context/skills/demo"]);
    expect(puts.find((s) => s.path === "/context/profile")!.body).toEqual({ text: "mine" });
    expect(puts.find((s) => s.path === "/context/skills/demo")!.body.files).toEqual({});
  });

  test("Drive: its own copies and context-style ones in a synced folder never go up, now or on the next sync", async () => {
    fake.edit("work/notes.md", "v0");
    const dir = await cloneFolder(ctx, "work", join(home, "work"), { quiet: true });
    writeFileSync(join(dir, "notes.md"), "mine");
    fake.edit("work/notes.md", "theirs", { via: "Claude" });
    mkdirSync(join(dir, ".agents", "skills", ".0bridge-remote", "demo"), { recursive: true });
    writeFileSync(join(dir, ".agents", "skills", ".0bridge-remote", "demo", "SKILL.md"), "theirs");
    writeFileSync(join(dir, "PROFILE.md.0bridge-remote"), "theirs");
    expect(isConflictCopy("PROFILE.md.0bridge-remote")).toBe(true);
    expect(isConflictCopy("notes.0bridge-claude-v2.md")).toBe(true);
    const r = await syncFolder(ctx, dir);
    expect(r.conflicts).toEqual([{ path: "notes.md", copy: "notes.0bridge-claude-v2.md" }]);
    await syncFolder(ctx, dir);
    const puts = fake.requests.filter((q) => q.startsWith("PUT")).map((q) => decodeURIComponent(q));
    expect(puts.length).toBeGreaterThan(0);
    expect(puts.filter((q) => q.includes(".0bridge-"))).toEqual([]);
    expect([...fake.workspaces.get("ws_personal")!.nodes.keys()].filter((p) => p.includes(".0bridge-"))).toEqual([]);
  });

  test("context and Drive name copies differently: a Drive-style copy inside a context skill is taken as one of its files (the audit's accidental mismatch, pinned as it is)", () => {
    const dir = mkdtempSync(join(tmpdir(), "0b-sync-contract-skill-"));
    try {
      writeFileSync(join(dir, "SKILL.md"), "---\ndescription: Demo\n---\n");
      writeFileSync(join(dir, "ref.md.0bridge-remote"), "context's copy");
      writeFileSync(join(dir, "ref.0bridge-claude-v3.md"), "Drive's copy");
      expect(Object.keys(readSkill(dir, "demo")!.files)).toEqual(["ref.0bridge-claude-v3.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
