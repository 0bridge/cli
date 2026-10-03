import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@0bridge/core";
import { ago, children, fileNotes, fmtBytes, printable, statusLine } from "../src/drive.ts";
import { loadDriveState, type RemoteNode } from "../src/drive-sync.ts";
import { canSymlink, PERSONAL, seed, startFake, testHome, type Fake } from "./drive-sync.test.ts";

/**
 * `0b drive …` (docs/plans/drive-plus.md §4.10): each command's arguments and output, the real CLI
 * in a temp home against the fake gateway from drive-sync.test.ts.
 */

const CLI = join(import.meta.dir, "..", "src", "index.ts");
/** The home folder as the CLI prints it (ui.ts tilde), and as a pattern. */
const H = process.platform === "win32" ? "~\\" : "~/";
const RH = H.replace(/\\/g, "\\\\");
let fake: Fake;
let home: string;
let ctx: Context;

beforeAll(() => {
  fake = startFake();
});
afterAll(() => fake.close());
beforeEach(() => {
  fake.reset();
  ({ home, ctx } = testHome(fake, "0b-drive-cli-"));
  // macOS's tmpdir is a symlink (/var → /private/var): the CLI sees the real path as its cwd.
  home = realpathSync(home);
  ctx = { home, storeDir: join(home, ".0bridge") };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** Run `0b <args>` (async: the fake answers from this process). */
async function ob(args: string[], cwd = home): Promise<{ code: number; out: string }> {
  const env = { ...process.env, ZEROBRIDGE_USER_HOME: home, ZEROBRIDGE_DIR: ctx.storeDir, ZEROBRIDGE_SECRET_STORE: "file", NO_COLOR: "1", ZEROBRIDGE_ACCOUNT: "" };
  const p = Bun.spawn(["bun", CLI, ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: out + err };
}
const write = (p: string, text: string) => (mkdirSync(join(p, ".."), { recursive: true }), writeFileSync(p, text));
const node = (o: Partial<RemoteNode>): RemoteNode => ({
  path: "a.md",
  size: 1,
  mime: "text/markdown",
  sha256: "x",
  version: 1,
  source: "upload",
  trusted: true,
  flags: [],
  extract: "ok",
  quality: "text",
  pages: null,
  extractError: null,
  updatedBy: null,
  updatedVia: null,
  updatedAt: 0,
  seq: 1,
  ...o,
});

describe("helpers", () => {
  test("sizes, times, the README's status line", () => {
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(3.4 * 1024 * 1024)).toBe("3.4 MB");
    expect(fmtBytes(250 * 1024)).toBe("250 KB");
    expect(ago(Date.now() - 5 * 60_000)).toBe("5m ago");
    expect(ago(Date.now() - 2 * 86_400_000)).toBe("2d ago");
    expect(statusLine("# Tax invoices\n\n| a | b |\n|---|---|\nPending: 2\n")).toBe("| a | b |");
    expect(statusLine("# Only a title\n")).toBeNull();
    expect(statusLine(`# T\n${"x".repeat(200)}`)!.length).toBe(90);
    // Escape sequences anyone who can write the README chose never reach the terminal (OSC 52 sets the clipboard).
    expect(statusLine("# T\nPending \u001b]52;c;Y3VybCBldmlsIHwgc2g=\u0007two\u009b2J")).toBe("Pending ]52;c;Y3VybCBldmlsIHwgc2g=two2J");
    expect(printable("a\u0000b\u007fc\u0085d")).toBe("abcd");
  });

  test("a folder's children: subfolders with what's in them, then files", () => {
    const nodes = [node({ path: "t/a.md", size: 10, updatedAt: 5 }), node({ path: "t/clients/x.md", size: 3, updatedAt: 7 }), node({ path: "t/clients/y/z.md", size: 4, updatedAt: 9 }), node({ path: "other.md" })];
    const { dirs, files } = children(nodes, "t/");
    expect(dirs).toEqual([{ name: "clients", files: 2, bytes: 7, at: 9 }]);
    expect(files.map((f) => f.name)).toEqual(["a.md"]);
  });

  test("a file's notes: extraction and flags, never a flag's sample", () => {
    expect(fileNotes(node({ extract: "pending" }))).toEqual(["extracting…"]);
    expect(fileNotes(node({ extract: "failed", extractError: "scanned PDF (OCR for scans comes later)" }))).toEqual(["scanned PDF (OCR for scans comes later)"]);
    expect(fileNotes(node({ pages: 3 }))).toEqual(["3 pages"]);
    expect(fileNotes(node({ flags: [{ kind: "rrn", count: 1, sample: "900101-1******" }] }))).toEqual(["⚠ a resident registration number"]);
  });
});

describe("0b drive", () => {
  test("ls: the top, a folder with its README, AGENTS.md, skills and address, --json, a missing folder", async () => {
    let r = await ob(["drive", "ls"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Your Drive");
    expect(r.out).toContain("Empty.");
    seed(fake);
    fake.team("Acme");
    fake.setInbound("tax-invoices", "tax-invoices.k3j7x2m9qa@in.0bridge.dev");
    r = await ob(["drive", "ls"]);
    expect(r.out).toMatch(/notes\/\s+1 file/);
    expect(r.out).toMatch(/tax-invoices\/\s+5 files/);
    expect(r.out).toContain("Teams: Acme (0b drive ls --workspace <name>)");

    r = await ob(["drive", "ls", "tax-invoices/"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Your Drive › tax-invoices");
    expect(r.out).toContain("README  Pending: 2 invoices (acme, beta)");
    expect(r.out).toContain("AGENTS.md  instructions for agents working here · Dashboard");
    expect(r.out).toContain("Skills  tax-invoice [chat, shell, browser]");
    expect(r.out).toContain("Email in  tax-invoices.k3j7x2m9qa@in.0bridge.dev");
    expect(r.out).toMatch(/\.agents\/\s+2 files/);
    expect(r.out).toMatch(/clients\/\s+1 file/);
    expect(r.out).toMatch(/README\.md\s+\d+ B · just now/);
    expect(r.out).not.toContain("Teams:");

    const js = JSON.parse((await ob(["drive", "ls", "tax-invoices", "--json"])).out);
    expect(js.workspace.id).toBe(PERSONAL);
    expect(js.context.skills[0].name).toBe("tax-invoice");
    expect(js.nodes.length).toBe(5);

    r = await ob(["drive", "ls", "nope"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('Your Drive has no folder "nope"');
  });

  test("ls --workspace: a team's Drive by name; an unknown one is an error", async () => {
    const acme = fake.team("Acme");
    seed(fake, acme.id);
    let r = await ob(["drive", "ls", "--workspace", "acme"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Acme's Drive");
    expect(r.out).toMatch(/tax-invoices\/\s+5 files/);
    expect(fake.requests.some((x) => x.startsWith("GET /api/drive/tree?") && x.includes(`workspace=${acme.id}`))).toBe(true);
    r = await ob(["drive", "ls", "--workspace", "Globex"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('no workspace "Globex" among yours (Personal, Acme)');
  });

  test("clone, then sync, status and ls in the folder, and unlink", async () => {
    seed(fake);
    let r = await ob(["drive", "clone", "tax-invoices"]);
    expect(r.code).toBe(0);
    const dir = join(home, "tax-invoices");
    expect(r.out).toContain(`Personal › tax-invoices is in ${H}tax-invoices (5 files)`);
    expect(r.out).toContain("syncs both ways in the background");
    if (canSymlink()) {
      expect(r.out).toContain("Claude Code reads its AGENTS.md (as CLAUDE.md) and skills (in .claude/skills) there too.");
      expect(readlinkSync(join(dir, "CLAUDE.md"))).toBe("AGENTS.md");
    }
    expect(readFileSync(join(dir, "clients/acme/notes.md"), "utf8")).toBe("ACME\n");
    expect(loadDriveState(ctx).folders[dir]!.prefix).toBe("tax-invoices/");

    // In the folder: ls lists its Drive folder, and where it's synced.
    r = await ob(["drive", "ls"], dir);
    expect(r.out).toContain("Your Drive › tax-invoices");
    expect(r.out).toContain(`synced here: ${H}tax-invoices`);
    r = await ob(["drive", "ls"], join(dir, "clients"));
    expect(r.out).toContain("Your Drive › tax-invoices/clients");
    expect((await ob(["drive", "ls"])).out).toMatch(new RegExp(`tax-invoices/\\s+5 files .*⇄ ${RH}tax-invoices`));

    fake.edit("tax-invoices/clients/acme/cert.md", "certificate\n");
    expect((await ob(["drive", "sync"], dir)).out).toContain("↓ clients/acme/cert.md");
    expect((await ob(["drive", "status"], dir)).out).toContain("In sync.");
    write(join(dir, "clients/acme/notes.md"), "ACME, November\n");
    r = await ob(["drive", "status"], dir);
    expect(r.out).toContain(`Personal › tax-invoices ⇄ ${H}tax-invoices · 6 files synced`);
    expect(r.out).toMatch(/Changed here.*\n\s+clients\/acme\/notes\.md/);
    // Status with no folder named, outside any: every synced folder.
    expect((await ob(["drive", "status"])).out).toMatch(new RegExp(`Personal › tax-invoices\\s+${RH}tax-invoices\\s+6 files`));

    // A conflict and a sensitive-data warning come out of sync as lines.
    fake.edit("tax-invoices/clients/acme/notes.md", "ACME, Claude's\n", { via: "Claude" });
    write(join(dir, "owner.txt"), "Owner 900101-1234567\n");
    r = await ob(["drive", "sync", dir]);
    expect(r.out).toContain("! clients/acme/notes.md — changed here and in Drive. Theirs is next to it as clients/acme/notes.0bridge-claude-v2.md; yours went up.");
    expect(r.out).toContain("owner.txt looks like it contains a resident registration number (900101-1******)");

    r = await ob(["drive", "unlink"], dir);
    expect(r.out).toContain(`${H}tax-invoices doesn't sync anymore. Its files stay here, and in Personal › tax-invoices.`);
    expect(loadDriveState(ctx).folders[dir]).toBeUndefined();
    expect(existsSync(join(dir, "README.md"))).toBe(true);
    expect((await ob(["drive", "unlink"], dir)).code).toBe(1);
  });

  test("clone: usage, a folder that isn't empty, a team's folder, all of Drive", async () => {
    let r = await ob(["drive", "clone"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("usage: 0b drive clone <folder> [dir]");
    seed(fake);
    write(join(home, "busy/x.md"), "x\n");
    r = await ob(["drive", "clone", "tax-invoices", "busy"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`${H}busy isn't empty; clone into a new folder, or add --force`);
    const acme = fake.team("Acme");
    seed(fake, acme.id);
    r = await ob(["drive", "clone", "tax-invoices", "acme-tax", "--workspace", "Acme"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Acme › tax-invoices is in ${H}acme-tax`);
    r = await ob(["drive", "clone", "", "everything"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Personal Drive is in ${H}everything (6 files)`);
    expect(readFileSync(join(home, "everything/notes/plan.md"), "utf8")).toBe("# Plan\n");
  });

  test("a member's change to AGENTS.md waits as a proposal, with where to apply it", async () => {
    seed(fake);
    await ob(["drive", "clone", "tax-invoices"]);
    const dir = join(home, "tax-invoices");
    fake.trusted = false;
    write(join(dir, "AGENTS.md"), "New rules.\n");
    const r = await ob(["drive", "sync"], dir);
    expect(r.out).toMatch(/● AGENTS\.md is an instruction file: your change waits as proposal pp_\w+ for an owner or admin to apply in the dashboard \(http:\/\/localhost:\d+\/app\/drive\/proposals\)/);
    expect((await ob(["drive", "sync"], dir)).out).toContain("Up to date.");
  });

  test("email: the folder's address, or where to make one", async () => {
    seed(fake);
    let r = await ob(["drive", "email"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("usage: 0b drive email <folder>");
    r = await ob(["drive", "email", "tax-invoices"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/tax-invoices\/ has no email address yet\. You make one in the dashboard: http:\/\/localhost:\d+\/app\/drive\/email/);
    fake.setInbound("tax-invoices", "tax-invoices.k3j7x2m9qa@in.0bridge.dev");
    r = await ob(["drive", "email", "tax-invoices"]);
    expect(r.code).toBe(0);
    expect(r.out.split("\n")[0]).toBe("tax-invoices.k3j7x2m9qa@in.0bridge.dev");
    expect(r.out).toContain("lands in tax-invoices/<date> <subject>/");
    expect((await ob(["drive", "email", "tax-invoices", "--quiet"])).out.trim()).toBe("tax-invoices.k3j7x2m9qa@in.0bridge.dev");
    // In a synced folder, its Drive folder.
    await ob(["drive", "clone", "tax-invoices"]);
    expect((await ob(["drive", "email", "--quiet"], join(home, "tax-invoices"))).out.trim()).toBe("tax-invoices.k3j7x2m9qa@in.0bridge.dev");
    const acme = fake.team("Acme");
    r = await ob(["drive", "email", "inbox", "--workspace", "Acme"]);
    expect(r.out).toContain("The workspace's owner or an admin makes one in the dashboard");
    fake.setInbound("inbox", "acme.a2b3c4d5e6@in.0bridge.dev", acme.id);
    expect((await ob(["drive", "email", "inbox", "--workspace", "Acme", "--quiet"])).out.trim()).toBe("acme.a2b3c4d5e6@in.0bridge.dev");
  });

  test("an unknown subcommand, and not signed in", async () => {
    let r = await ob(["drive", "frobnicate"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('unknown subcommand "drive frobnicate". Try: ls, clone, sync, status, unlink, email');
    rmSync(ctx.storeDir, { recursive: true, force: true });
    r = await ob(["drive", "ls"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Not signed in");
  });
});
