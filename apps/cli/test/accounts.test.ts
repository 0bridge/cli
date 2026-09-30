import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifest, saveCloud, type Context } from "@0bridge/core";
import { useAccount } from "../src/cloud.ts";
import { accountAt, accountForRepo, saveLinks } from "../src/links.ts";

const fresh = (): Context => {
  const home = mkdtempSync(join(tmpdir(), "0b-cli-accounts-"));
  return { home, storeDir: join(home, ".0bridge") };
};
const A = { server: "https://0bridge.dev", userId: "userAAAA1", login: "me", email: "me@example.com", tokenId: "t1" };
const B = { server: "https://0bridge.dev", userId: "userBBBB2", login: "work", email: "me@acme.com", tokenId: "t2" };

describe("which account a command uses", () => {
  test("inside a checkout linked to a project: the project's account; links from before several accounts belong to the first account", () => {
    const ctx = fresh();
    saveCloud(ctx, A);
    saveCloud(ctx, B);
    saveLinks(ctx, {
      links: {
        "/src/acme": { projectId: "p1", repo: "github.com/acme/app", tokenId: "x", userId: B.userId },
        "/src/acme/tools/inner": { projectId: "p2", repo: "github.com/me/inner", tokenId: "y" },
        "/src/mine": { projectId: "p3", repo: "github.com/me/mine", tokenId: "z" },
      },
    });
    expect(accountAt(ctx, "/src/acme")).toBe(B.userId);
    expect(accountAt(ctx, "/src/acme/packages/api")).toBe(B.userId);
    expect(accountAt(ctx, "/src/acme/tools/inner/x")).toBe(A.userId); // the innermost checkout wins
    expect(accountAt(ctx, "/src/acmex")).toBeNull();
    expect(accountAt(ctx, "/tmp")).toBeNull();
    expect(accountForRepo(ctx, "github.com/acme/app")).toBe(B.userId);
    expect(accountForRepo(ctx, "github.com/me/mine")).toBe(A.userId);
    expect(accountForRepo(ctx, "github.com/other/x")).toBeNull();
  });

  test("a link to an account that signed out falls back to the default", () => {
    const ctx = fresh();
    saveCloud(ctx, A);
    saveLinks(ctx, { links: { "/src/acme": { projectId: "p1", repo: "r", tokenId: "x", userId: B.userId } } });
    expect(accountAt(ctx, "/src/acme")).toBeNull();
  });

  test("the default account is the one the tools' 0bridge entry uses", () => {
    const ctx = fresh();
    saveCloud(ctx, A);
    saveCloud(ctx, B);
    expect(useAccount(ctx, "me@acme.com")).toBe(true);
    expect(loadManifest(ctx)!.mcpServers["0bridge"]!.headers!.Authorization).toBe(`Bearer \${secret:cloud.device-token@${B.userId}}`);
    expect(useAccount(ctx, "work")).toBe(false);
    expect(useAccount(ctx, A.userId)).toBe(true);
    expect(loadManifest(ctx)!.mcpServers["0bridge"]!.headers!.Authorization).toBe("Bearer ${secret:cloud.device-token}");
    expect(() => useAccount(ctx, "nobody@x.com")).toThrow("isn't signed in");
  });
});
