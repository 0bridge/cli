import { DEFAULT_SERVER, accountName, defaultAccount, loadAccounts, type Context } from "@0bridge/core";
import { useAccount } from "./cloud.ts";
import { accountAt } from "./links.ts";
import { c } from "./ui.ts";

/**
 * `0b account`: the 0bridge accounts signed in here (D42). The default one is what every AI
 * tool's 0bridge entry uses; a checkout linked to a project uses the project's account.
 * Returns true when the tools need syncing (the default changed).
 */
export function accountCommand(ctx: Context, args: string[]): boolean {
  const [sub, who] = args;
  switch (sub) {
    case undefined:
    case "list":
    case "ls": {
      const all = loadAccounts(ctx);
      if (!all.accounts.length) {
        console.log(`Not signed in. ${c.cyan("0b login")}`);
        return false;
      }
      const main = defaultAccount(all)!;
      const here = accountAt(ctx, process.cwd());
      for (const a of all.accounts) {
        const tags = [a.userId === main.userId && "default · AI tools", a.userId === here && "this repo", a.server !== DEFAULT_SERVER && a.server].filter(Boolean).join(" · ");
        console.log(`${a.userId === main.userId ? c.green("●") : " "} ${c.bold(accountName(a))}${tags ? c.dim(`  ${tags}`) : ""}`);
      }
      console.log(c.dim(`\nAdd one: 0b login · default: 0b account use <email> · a repo's: 0b project link --account <email> · sign out: 0b logout <email>`));
      return false;
    }
    case "use":
    case "default": {
      if (!who) throw new Error("usage: 0b account use <email>");
      const changed = useAccount(ctx, who);
      const a = defaultAccount(loadAccounts(ctx))!;
      console.log(changed ? `${c.green("✓")} ${c.bold(accountName(a))} is the default: every AI tool's 0bridge entry uses it.` : c.dim(`${accountName(a)} is already the default.`));
      return changed;
    }
    default:
      throw new Error(`unknown subcommand "account ${sub}". Try: 0b account, 0b account use <email> (0b login adds one, 0b logout <email> signs one out)`);
  }
}
