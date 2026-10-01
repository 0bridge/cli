import { styleText } from "node:util";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTwoFilesPatch } from "diff";
import * as p from "@clack/prompts";
import {
  computeStatus,
  getAdapters,
  mask,
  type Cell,
  type Context,
  type Manifest,
  type McpServer,
  type Plan,
  type SecretStore,
  type ToolId,
} from "@0bridge/core";

/** Colors only on a terminal (and not with NO_COLOR): agents and pipes read plain text. */
const colors = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const style = (format: Parameters<typeof styleText>[0]) => (s: string) => (colors ? styleText(format, s) : s);

/** Browsers can't be opened over SSH or without a display; print the link instead. */
export const canOpenBrowser = () =>
  Boolean(process.env.BROWSER) ||
  (!process.env.SSH_CONNECTION && !process.env.SSH_TTY && (process.platform !== "linux" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)));

export const c = {
  bold: style("bold"),
  dim: style("dim"),
  green: style("green"),
  red: style("red"),
  yellow: style("yellow"),
  cyan: style("cyan"),
};

/** The home folder as ~ in `s` (paths shown, and logs sent with feedback); Windows paths have \\ too. */
export const tilde = (ctx: Context, s: string) => {
  const out = s.split(ctx.home + "/").join("~/");
  return process.platform === "win32" ? out.split(ctx.home + "\\").join("~\\") : out;
};

/** Short human description of where a server runs. */
export function where(s: McpServer, max = 48): string {
  let out: string;
  if (s.transport === "stdio") out = [s.command?.split("/").pop(), ...(s.args ?? [])].join(" ");
  else {
    try {
      const u = new URL(s.url!);
      out = u.host + (u.pathname === "/" ? "" : u.pathname);
    } catch {
      out = s.url ?? "";
    }
  }
  return out.length > max ? out.slice(0, max - 1) + "…" : out;
}

export function kindLabel(s: McpServer): string {
  return s.transport === "stdio" ? "Local" : s.transport === "sse" ? "Remote (SSE)" : "Remote";
}

/** `description:` from a SKILL.md frontmatter, trimmed for a hint. */
export function skillDescription(dir: string, max = 60): string {
  try {
    const md = readFileSync(join(dir, "SKILL.md"), "utf8");
    const d = /^description:\s*["']?(.+?)["']?\s*$/m.exec(md)?.[1] ?? "";
    return d.length > max ? d.slice(0, max - 1) + "…" : d;
  } catch {
    return "";
  }
}

const CELL: Record<Cell, string> = {
  ok: c.green("✓"),
  differs: c.yellow("≠"),
  missing: c.red("✗"),
  off: c.dim("off"),
  "n/a": c.dim("—"),
  unsupported: c.dim("n/s"),
};

function table(rows: { name: string; cells: Partial<Record<ToolId, Cell>> }[], tools: ToolId[]) {
  const w = Math.max(12, ...rows.map((r) => r.name.length)) + 2;
  console.log(c.dim("  " + "".padEnd(w) + tools.map((t) => t.padEnd(8)).join("")));
  for (const r of rows) {
    const cells = tools.map((t) => {
      const cell = r.cells[t] ?? "n/a";
      const visible = cell === "off" || cell === "unsupported" ? 3 : 1;
      return CELL[cell] + " ".repeat(8 - visible);
    });
    console.log("  " + r.name.padEnd(w) + cells.join(""));
  }
}

export function printStatus(ctx: Context, m: Manifest, store: SecretStore): boolean {
  const s = computeStatus(ctx, m, store);
  const tools = s.tools.filter((t) => t.installed && t.enabled).map((t) => t.id);
  console.log(c.bold("Tools"));
  for (const t of s.tools) {
    const dot = t.installed ? (t.enabled ? c.green("●") : c.dim("○")) : c.dim("·");
    console.log(`  ${dot} ${t.label.padEnd(12)} ${c.dim(!t.installed ? "not installed" : t.enabled ? "" : "disabled")}`);
  }
  console.log(`\n${c.bold("MCP servers")}`);
  table(s.mcp, tools);
  if (s.skills.length) {
    console.log(`\n${c.bold("Skills")}`);
    table(s.skills, tools);
  }
  console.log(`\n${c.bold("Instructions")} ${c.dim("(~/.0bridge/AGENTS.md)")}`);
  table([{ name: "AGENTS.md", cells: s.instructions }], tools);
  if (s.unmanaged.length) {
    console.log(`\n${c.bold("Not managed by 0bridge")}`);
    for (const u of s.unmanaged) console.log(`  ${c.dim(u.tool.padEnd(7))} ${u.kind} ${u.name}`);
  }
  console.log(`\n${c.dim("✓ in sync  ≠ differs  ✗ missing  off disabled  — not targeted  n/s unsupported by tool")}`);
  return [...s.mcp, ...s.skills, { cells: s.instructions }].some((r) => Object.values(r.cells).some((v) => v === "missing" || v === "differs"));
}

export function printPlan(ctx: Context, plan: Plan, secrets: string[], showDiff: boolean) {
  const labels = getAdapters(ctx);
  for (const ch of plan.changes) {
    if (ch.kind === "skill") {
      const sym = ch.action === "remove" ? c.red("-") : ch.action === "install" ? c.green("+") : c.yellow("~");
      console.log(`${sym} ${ch.label ?? labels[ch.tool].label}: ${ch.action} skill ${ch.name} ${c.dim(tilde(ctx, ch.path))}`);
      continue;
    }
    console.log(`${c.yellow("~")} ${ch.label ?? labels[ch.tool].label}: ${ch.summary.join(", ")} ${c.dim(tilde(ctx, ch.path))}`);
    if (!showDiff) continue;
    const patch = createTwoFilesPatch("before", "after", ch.viewBefore, ch.viewAfter, "", "", { context: 2 });
    for (const line of mask(patch, secrets).split("\n").slice(4)) {
      if (!line) continue;
      const colored = line.startsWith("+") ? c.green(line) : line.startsWith("-") ? c.red(line) : line.startsWith("@@") ? c.cyan(line) : c.dim(line);
      console.log("    " + colored);
    }
  }
  printWarnings(ctx, plan);
}

export function printWarnings(ctx: Context, plan: Plan) {
  for (const w of plan.warnings) console.log(`${c.yellow("!")} ${tilde(ctx, w)}`);
  for (const m of plan.missing) console.log(`${c.red("✗")} unresolved ${m} — set it with ${c.cyan(`0b secret set ${m.replace(/^secret:/, "")}`)}`);
}

/** One line per tool (and per other copy of it: another account, a checkout): what a sync would change. */
export function planSummary(ctx: Context, plan: Plan): string[] {
  const labels = getAdapters(ctx);
  const by = new Map<string, { mcp: string[]; skills: string[]; instructions: boolean }>();
  const get = (ch: { tool: ToolId; label?: string }) => {
    const t = ch.label ?? labels[ch.tool].label;
    return by.get(t) ?? (by.set(t, { mcp: [], skills: [], instructions: false }), by.get(t)!);
  };
  for (const ch of plan.changes) {
    if (ch.kind === "skill") get(ch).skills.push(`${ch.action === "remove" ? "-" : ch.action === "install" ? "+" : "~"}${ch.name}`);
    else if (ch.what === "mcp") get(ch).mcp.push(...ch.summary);
    else get(ch).instructions = true;
  }
  const count = (xs: string[], p: string) => xs.filter((x) => x.startsWith(p)).length;
  return [...by].map(([t, v]) => {
    const skills = (n: number) => (n === 1 ? "skill" : "skills");
    const parts = [
      count(v.mcp, "add") && c.green(`+${count(v.mcp, "add")} MCP`),
      count(v.mcp, "update") && c.yellow(`~${count(v.mcp, "update")} MCP`),
      count(v.mcp, "remove") && c.red(`-${count(v.mcp, "remove")} MCP`),
      count(v.skills, "+") && c.green(`+${count(v.skills, "+")} ${skills(count(v.skills, "+"))}`),
      count(v.skills, "~") && c.yellow(`~${count(v.skills, "~")} ${skills(count(v.skills, "~"))}`),
      count(v.skills, "-") && c.red(`-${count(v.skills, "-")} ${skills(count(v.skills, "-"))}`),
      v.instructions && c.cyan("instructions"),
    ].filter(Boolean);
    return `${t.padEnd(12)} ${parts.join("  ")}`;
  });
}

/** clack's spinner on a terminal; plain one-line logs when piped (agents, CI), so output stays readable. */
export function spinner() {
  if (process.stdout.isTTY) return p.spinner();
  return {
    start: (msg: string) => p.log.step(`${msg}…`),
    stop: (msg: string) => p.log.success(msg),
    error: (msg: string) => p.log.error(msg),
  };
}
