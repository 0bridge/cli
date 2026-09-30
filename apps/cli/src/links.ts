import { join } from "node:path";
import { loadAccounts, readJson, writeAtomic, type Context } from "@0bridge/core";

/**
 * Checkouts linked to a project (`0b project link`), and so to the account the project belongs
 * to: commands run inside one use that account without being told.
 */
export interface Link {
  projectId: string;
  repo: string;
  tokenId: string;
  /** The account the project belongs to. Missing on links from before several accounts: the account in the unsuffixed slot. */
  userId?: string;
}
export interface Links {
  /** Checkout path → its project. */
  links: Record<string, Link>;
}

const linksPath = (ctx: Context) => join(ctx.storeDir, "projects.json");
export const loadLinks = (ctx: Context): Links => readJson<Links>(linksPath(ctx)) ?? { links: {} };
export const saveLinks = (ctx: Context, l: Links) => writeAtomic(linksPath(ctx), JSON.stringify(l, null, 2) + "\n", { mode: 0o600 });

/** The account a link belongs to, if it's still signed in here. */
export function linkAccount(ctx: Context, link: Link): string | null {
  const all = loadAccounts(ctx);
  const id = link.userId ?? all.accounts.find((a) => a.slot === "")?.userId;
  return id && all.accounts.some((a) => a.userId === id) ? id : null;
}

/** The linked checkout `dir` is in (the innermost one), if any. */
export function linkAt(ctx: Context, dir: string): { root: string; link: Link } | null {
  let best: { root: string; link: Link } | null = null;
  for (const [root, link] of Object.entries(loadLinks(ctx).links))
    if ((dir === root || dir.startsWith(`${root}/`)) && (!best || root.length > best.root.length)) best = { root, link };
  return best;
}

/** The account for a command run in `dir`: its checkout's project's account, else none (the default). */
export function accountAt(ctx: Context, dir: string): string | null {
  const at = linkAt(ctx, dir);
  return at ? linkAccount(ctx, at.link) : null;
}

/** The account a repo's checkouts are linked with, if any (the background sync of personal files). */
export function accountForRepo(ctx: Context, repo: string): string | null {
  const link = Object.values(loadLinks(ctx).links).find((l) => l.repo === repo);
  return link ? linkAccount(ctx, link) : null;
}
