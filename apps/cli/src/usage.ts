import { loadCloud, loadHistoryConfig, saveHistoryConfig, usageWanted, type Context } from "@0bridge/core";
import { ensureBackground } from "./background.ts";
import { cloudClient } from "./cloud.ts";
import { syncHistory } from "./history.ts";
import { c } from "./ui.ts";

/**
 * `0b usage` (round 2, P5): tokens and estimated cost by tool, model, repo or day, and whether
 * this machine uploads token counts (never conversation text) with history off. The counts come
 * from the same log reads as history (`0b history sync`); the cost is an estimate at API list
 * prices (the gateway's prices.ts), since subscriptions don't bill per token.
 */

export interface UsageOptions {
  days?: string;
  by?: string;
  json?: boolean;
  quiet?: boolean;
}

/** Mirrors apps/gateway/src/usage.ts. */
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}
export type UsageBy = "tool" | "model" | "repo" | "day" | "device";
export interface UsageSummary {
  since: number;
  until: number;
  tz: number;
  by: UsageBy;
  totals: TokenCounts & { cost: number | null; partial: boolean; sessions: number };
  groups: { key: string; counts: TokenCounts; cost: number | null; partial: boolean; sessions: number }[];
  prices: { asOf: string; unpriced: string[] };
}

const BY: UsageBy[] = ["tool", "model", "repo", "day", "device"];

function fail(msg: string): never {
  console.error(c.red(`error: ${msg}`));
  process.exit(1);
}

/** 1234 → "1.2K", 5_600_000 → "5.6M". */
export function compact(n: number): string {
  const abs = Math.abs(n);
  for (const [d, s] of [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ] as const)
    if (abs >= d) {
      const v = n / d;
      return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, "")}${s}`;
    }
  return String(n);
}

/** "$12.34", "$0.004" → "<$0.01", null → "—". */
export function money(cost: number | null): string {
  if (cost === null) return "—";
  if (cost > 0 && cost < 0.01) return "<$0.01";
  return `$${cost.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const total = (t: TokenCounts) => t.input + t.output + t.cacheRead + t.cacheWrite;

/** The summary as a text table (what `0b usage` prints). Pure, for tests. */
export function renderUsage(s: UsageSummary): string {
  // The window starts at a local midnight and ends now, so the days it touches, today included.
  const days = Math.floor((s.until - s.since) / 86_400_000) + 1;
  const head = `Last ${days} ${days === 1 ? "day" : "days"}, by ${s.by}: ${c.bold(compact(total(s.totals)))} tokens in ${s.totals.sessions} ${s.totals.sessions === 1 ? "session" : "sessions"} · ${c.bold(money(s.totals.cost))}${s.totals.partial ? "*" : ""} estimated`;
  if (!s.groups.length) return `${head}\n${c.dim("No token counts yet. They go up with your history (0b history on), or on their own with 0b usage on.")}`;
  const rows = s.groups.map((g) => [g.key || "(none)", compact(g.counts.input), compact(g.counts.output), compact(g.counts.cacheRead), compact(g.counts.cacheWrite), compact(total(g.counts)), `${money(g.cost)}${g.partial ? "*" : ""}`]);
  const header = [s.by === "day" ? "Day" : s.by[0]!.toUpperCase() + s.by.slice(1), "Input", "Output", "Cache read", "Cache write", "Total", "Cost (est.)"];
  const width = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const keyWidth = Math.min(width[0]!, 40);
  const fit = (v: string) => (v.length > keyWidth ? `${v.slice(0, keyWidth - 1)}…` : v.padEnd(keyWidth));
  const line = (r: string[]) => [fit(r[0]!), ...r.slice(1).map((v, i) => v.padStart(width[i + 1]!))].join("  ");
  const notes = [
    `Estimated at API list prices as of ${s.prices.asOf || "?"}; subscriptions don't bill per token.`,
    ...(s.prices.unpriced.length ? [`* No price for ${s.prices.unpriced.join(", ")}: left out of the cost, not guessed.`] : []),
  ];
  return [head, "", c.dim(line(header)), ...rows.map(line), "", ...notes.map((n) => c.dim(n))].join("\n");
}

/** Where this machine stands: uploading counts or not, and why. */
function machineLine(ctx: Context): string {
  const cfg = loadHistoryConfig(ctx);
  if (!usageWanted(cfg)) return `This machine: ${c.yellow("not uploading token counts")} ${c.dim(`(${c.cyan("0b usage on")})`)}`;
  return `This machine: ${c.green("uploading token counts")} ${c.dim(cfg.enabled ? "(with history)" : "(history off: counts only)")}`;
}

async function show(ctx: Context, opts: UsageOptions): Promise<void> {
  const days = opts.days === undefined ? 30 : Number(opts.days);
  if (!Number.isInteger(days) || days < 1 || days > 365) fail("--days is a whole number from 1 to 365");
  const by = (opts.by ?? "tool") as UsageBy;
  if (!BY.includes(by)) fail(`--by is one of ${BY.join(", ")}`);
  const tz = -new Date().getTimezoneOffset();
  const { client } = cloudClient(ctx);
  const s = await client.call<UsageSummary>("GET", `/usage/summary?days=${days}&by=${by}&tz=${tz}`);
  if (opts.json) return console.log(JSON.stringify(s, null, 2));
  console.log(renderUsage(s));
  if (!opts.quiet) console.log(`\n${machineLine(ctx)}`);
}

export async function usageCommand(ctx: Context, args: string[], opts: UsageOptions): Promise<void> {
  const [sub] = args;
  switch (sub) {
    case undefined:
    case "show":
      return show(ctx, opts);
    case "status":
      return console.log(machineLine(ctx));
    case "on": {
      saveHistoryConfig(ctx, { ...loadHistoryConfig(ctx), usage: true });
      const cfg = loadHistoryConfig(ctx);
      console.log(
        `${c.green("✓")} Token counts go up from this machine: per session, model and hour, never conversation text${cfg.enabled ? "" : c.dim(" (history stays off)")}.`,
      );
      if (!loadCloud(ctx)) return console.log(c.dim(`Sign in to start: ${c.cyan("0b login")}`));
      await syncHistory(ctx, { quiet: opts.quiet });
      ensureBackground(ctx);
      if (!opts.quiet) console.log(c.dim(`See them with ${c.cyan("0b usage")}, or on the dashboard's Usage page.`));
      return;
    }
    case "off": {
      const cfg = loadHistoryConfig(ctx);
      saveHistoryConfig(ctx, { ...cfg, usage: false });
      console.log(`${c.green("✓")} Token counts stop going up from this machine${cfg.enabled ? "; history keeps uploading conversations" : ""}. What's uploaded stays until ${c.cyan("0b usage forget")}.`);
      return;
    }
    case "forget": {
      const r = await cloudClient(ctx).client.call<{ deleted: number }>("DELETE", "/usage");
      console.log(`${c.green("✓")} Deleted ${r.deleted} usage rows from 0bridge.${usageWanted(loadHistoryConfig(ctx)) ? c.dim(` This machine keeps uploading new counts (${c.cyan("0b usage off")} stops it).`) : ""}`);
      return;
    }
    default:
      fail(`unknown subcommand "usage ${sub}". Try: 0b usage [--days 30] [--by tool|model|repo|day|device], on, off, forget`);
  }
}
