export type ToolId = "claude" | "codex" | "cursor" | "gemini";
export const TOOL_IDS: ToolId[] = ["claude", "codex", "cursor", "gemini"];

export type Transport = "stdio" | "http" | "sse";

/** Tool-neutral MCP server definition. String values may contain `${secret:NAME}` / `${env:NAME}` refs. */
export interface McpServer {
  transport: Transport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** Default true. */
  enabled?: boolean;
  /** Tools this server is written to. Default: all enabled tools. */
  targets?: ToolId[];
  /** Tool-specific keys passed through verbatim (e.g. codex `default_tools_approval_mode`). */
  native?: Partial<Record<ToolId, Record<string, unknown>>>;
}

export interface SkillEntry {
  enabled?: boolean;
  targets?: ToolId[];
}

export interface Manifest {
  version: 1;
  tools: Partial<Record<ToolId, { enabled: boolean }>>;
  mcpServers: Record<string, McpServer>;
  skills: Record<string, SkillEntry>;
  instructions: { enabled: boolean; targets?: ToolId[] };
}

/** What 0bridge has written into each tool, so it only ever removes things it owns. */
export interface State {
  /** `hooks`: the hook entries (`0b hook …` commands) 0bridge added to the tool's settings. */
  managed: Partial<Record<ToolId, { mcp: string[]; skills: string[]; hooks?: string[] }>>;
}

export interface Context {
  /** Home directory whose tool configs are managed (overridable for tests). */
  home: string;
  /** 0bridge store directory, default ~/.0bridge */
  storeDir: string;
  /** Which signed-in 0bridge account to use (email, name or user id); unset: the default one (cloud.ts). */
  account?: string;
}
