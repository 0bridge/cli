/**
 * Sessions run inside a folder that `0b drive clone` syncs carry that Drive folder to the server
 * (withDriveFolders), which files them under the work folder there.
 *   bun test apps/cli/test/history-drive.test.ts
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editDriveState, type FolderState } from "../src/drive-sync.ts";
import { withDriveFolders } from "../src/history.ts";
import type { Context, HistorySession } from "@0bridge/core";

const home = mkdtempSync(join(tmpdir(), "0b-history-drive-"));
const ctx: Context = { home, storeDir: join(home, ".0bridge") };
const ME = { server: "https://0bridge.test", userId: "u1" };
const folder = (o: Partial<FolderState>): FolderState => ({ server: ME.server, userId: "u1", workspaceId: "ws_me", workspaceName: "Personal", prefix: "", cursor: 0, files: {}, ...o });
const session = (cwd: string | undefined): HistorySession => ({ id: `claude-code:${cwd ?? "none"}`, tool: "claude-code", device: "mac", ...(cwd ? { cwd } : {}), startedAt: 1, updatedAt: 2, messages: [] });

describe("withDriveFolders", () => {
  test("the innermost synced folder of this account, as a Drive path; others left alone", async () => {
    const projects = join(home, "projects");
    await editDriveState(ctx, (s) => {
      s.folders[join(projects, "acme-quote")] = folder({ prefix: "companies/acme/quote/" });
      s.folders[join(projects, "team")] = folder({ workspaceId: "ws_team", workspaceName: "Acme", prefix: "contracts/" });
      s.folders[join(projects, "other-account")] = folder({ userId: "u2" });
    });
    const out = withDriveFolders(ctx, ME, [
      session(join(projects, "acme-quote")),
      session(join(projects, "acme-quote", "pdf")),
      session(join(projects, "team", "opt-dent")),
      session(join(projects, "other-account", "x")),
      session(join(projects, "acme-quote-old")),
      session(undefined),
    ]);
    expect(out.map((s) => s.drive ?? null)).toEqual([
      { workspace: "ws_me", path: "companies/acme/quote" },
      { workspace: "ws_me", path: "companies/acme/quote/pdf" },
      { workspace: "ws_team", path: "contracts/opt-dent" },
      null,
      null,
      null,
    ]);
    // Another server's account with the same id gets nothing either.
    expect(withDriveFolders(ctx, { ...ME, server: "https://other.test" }, [session(join(projects, "acme-quote"))])[0]!.drive).toBeUndefined();
  });
});
