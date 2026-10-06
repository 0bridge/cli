// No imports: the web dashboard bundles this for the browser.

/**
 * Whether agents can use a connection, which isn't the same as whether it's signed in: a signed-in
 * connection with every tool turned off is kept (its sign-in stays) but gives agents nothing.
 *   usable    signed in, and agents get at least one tool (`on` of `total`)
 *   off       signed in, but agents get none: the user turned them off, or read-only leaves none
 *   no-tools  signed in, and the service offers no tools
 *   loading   still connecting or listing its tools
 *   sign-in / key / failed   a sign-in problem: shown as such, whatever its tools are set to
 */
export type ReadinessKind = "usable" | "off" | "no-tools" | "loading" | "sign-in" | "key" | "failed";

export interface Readiness {
  kind: ReadinessKind;
  /** Tools agents get, and tools it has. */
  on: number;
  total: number;
  /** "Ready", "In use 5/12", "Tools off", "No tools", "Connecting…", "Needs sign-in", "Needs key", "Failed". */
  label: string;
  tone: "ok" | "neutral" | "warn" | "error";
  /**
   * For "off": the user turned every tool off, read-only keeps out all of them (none turned off), or
   * both together (read-only, and some turned off: which one matters isn't known from counts).
   */
  offBy?: "user" | "read-only" | "both";
}

export interface ReadinessInput {
  state: string;
  tools: number;
  /** Missing from older servers: then every tool counts as on. */
  toolsOn?: number;
  readOnly?: boolean;
  /** Tool names the user turned off. */
  off?: string[];
}

export function readinessOf(c: ReadinessInput): Readiness {
  const total = c.tools;
  const on = Math.min(c.toolsOn ?? total, total);
  const is = (kind: ReadinessKind, label: string, tone: Readiness["tone"]): Readiness => ({ kind, on, total, label, tone });
  if (c.state === "failed") return is("failed", "Failed", "error");
  if (c.state === "authenticating") return is("sign-in", "Needs sign-in", "warn");
  if (c.state === "needs_key") return is("key", "Needs key", "warn");
  if (c.state !== "ready") return is("loading", "Connecting…", "neutral");
  if (!total) return is("no-tools", "No tools", "neutral");
  if (!on) return { ...is("off", "Tools off", "neutral"), offBy: !c.readOnly ? "user" : c.off?.length ? "both" : "read-only" };
  return on < total ? is("usable", `In use ${on}/${total}`, "ok") : is("usable", "Ready", "ok");
}

/** What agents get, in a few words: "12 tools", "5 of 12 tools on", "all 27 tools off". */
export function toolsText(r: Readiness): string {
  const tools = (n: number) => `${n} ${n === 1 ? "tool" : "tools"}`;
  if (r.kind === "off" && r.offBy === "read-only") return `read-only leaves none of ${tools(r.total)}`;
  if (r.kind === "off" && r.offBy === "both") return `none of ${tools(r.total)} on (some off, the rest kept out by read-only)`;
  if (r.kind === "off") return r.total === 1 ? "its 1 tool is off" : `all ${tools(r.total)} off`;
  if (r.kind === "usable" && r.on < r.total) return `${r.on} of ${tools(r.total)} on`;
  return tools(r.total);
}

/** What gets its tools back, by why they're off. */
export const OFF_FIX: Record<NonNullable<Readiness["offBy"]>, string> = {
  user: "turn a tool back on",
  "read-only": "turn read-only off",
  both: "turn read-only off or turn a read tool back on",
};

/** Why an all-off connection is still there: turning tools off isn't disconnecting. */
export const OFF_NOTE = "Still signed in: agents get none of its tools until one is turned back on. Disconnecting is what forgets the sign-in.";
