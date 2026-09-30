import { homedir } from "node:os";
import { join } from "node:path";
import type { Context, Manifest, McpServer, State, ToolId } from "./types.ts";
import { TOOL_IDS } from "./types.ts";
import { readJson, readText, writeAtomic } from "./util.ts";
import { resolveRefs, type SecretStore } from "./secrets.ts";

export function defaultContext(): Context {
  const home = process.env.ZEROBRIDGE_USER_HOME ?? homedir();
  return { home, storeDir: process.env.ZEROBRIDGE_DIR ?? join(home, ".0bridge") };
}

export const paths = (ctx: Context) => ({
  manifest: join(ctx.storeDir, "0bridge.json"),
  state: join(ctx.storeDir, "state.json"),
  skills: join(ctx.storeDir, "skills"),
  instructions: join(ctx.storeDir, "AGENTS.md"),
  backups: join(ctx.storeDir, "backups"),
});

export function emptyManifest(): Manifest {
  return {
    version: 1,
    tools: Object.fromEntries(TOOL_IDS.map((t) => [t, { enabled: true }])),
    mcpServers: {},
    skills: {},
    instructions: { enabled: true },
  };
}

export function loadManifest(ctx: Context): Manifest | null {
  return readJson<Manifest>(paths(ctx).manifest);
}

export function requireManifest(ctx: Context): Manifest {
  const m = loadManifest(ctx);
  if (!m) throw new Error(`No manifest at ${paths(ctx).manifest}. Run \`0b init\` first.`);
  return m;
}

export function saveManifest(ctx: Context, m: Manifest): void {
  writeAtomic(paths(ctx).manifest, JSON.stringify(m, null, 2) + "\n");
}

export function loadState(ctx: Context): State {
  return readJson<State>(paths(ctx).state) ?? { managed: {} };
}

export function saveState(ctx: Context, s: State): void {
  writeAtomic(paths(ctx).state, JSON.stringify(s, null, 2) + "\n");
}

export function managedOf(state: State, tool: ToolId) {
  return (state.managed[tool] ??= { mcp: [], skills: [] });
}

export function addManaged(list: string[], name: string) {
  if (!list.includes(name)) list.push(name);
  list.sort();
}

export function readInstructions(ctx: Context): string {
  return readText(paths(ctx).instructions) ?? "";
}

export function toolEnabled(m: Manifest, tool: ToolId): boolean {
  return m.tools[tool]?.enabled !== false;
}

export function targets(entry: { targets?: ToolId[] }, tool: ToolId): boolean {
  return !entry.targets || entry.targets.includes(tool);
}

/** Resolve every ref in a server definition. */
export function resolveServer(s: McpServer, store: SecretStore, missing?: Set<string>): McpServer {
  const r = (v: string) => resolveRefs(v, store, missing);
  const rec = (o?: Record<string, string>) => (o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, r(v)])) : undefined);
  const out: McpServer = { ...s };
  if (s.command) out.command = r(s.command);
  if (s.args) out.args = s.args.map(r);
  if (s.url) out.url = r(s.url);
  if (s.cwd) out.cwd = r(s.cwd);
  if (s.env) out.env = rec(s.env);
  if (s.headers) out.headers = rec(s.headers);
  return out;
}

/** All secret values referenced by the manifest, for masking in terminal output. */
export function secretValues(m: Manifest, store: SecretStore): string[] {
  const out = new Set<string>();
  const scan = (v?: string) => {
    for (const [, kind, name] of (v ?? "").matchAll(/\$\{(secret|env):([^}]+)\}/g)) {
      const val = kind === "secret" ? store.get(name!) : process.env[name!];
      if (val && val.length >= 6) out.add(val);
    }
  };
  for (const s of Object.values(m.mcpServers)) {
    [s.command, s.url, s.cwd, ...(s.args ?? []), ...Object.values(s.env ?? {}), ...Object.values(s.headers ?? {})].forEach(scan);
  }
  return [...out];
}

export function mask(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets.sort((a, b) => b.length - a.length)) out = out.split(s).join("***");
  return out;
}
