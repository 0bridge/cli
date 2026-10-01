import { runAgentAsync, versionOf } from "./spawn.ts";
import { deferred, type AgentAdapter, type Run, type Sink } from "./types.ts";

/**
 * Sessions the user started in a terminal under herdr (checked against herdr 0.9.1): `herdr agent
 * list` finds them, `prompt` sends a follow-up and waits for the agent to settle, `read` brings
 * back the end of its screen. It never starts a task and answers no prompts: a blocked agent waits
 * for the user at that terminal. The daemon only lets it reach sessions in allowed repos.
 */

export interface HerdrPane {
  pane: string;
  agent: string;
  status: string;
  cwd: string;
  native: string | null;
  title?: string;
}

/** `herdr agent list` output ({result: {agents: […]}}). */
export function parseHerdrList(out: string): HerdrPane[] {
  try {
    const agents = (JSON.parse(out) as { result?: { agents?: any[] } }).result?.agents ?? [];
    return agents.flatMap((a) =>
      typeof a?.pane_id === "string" && typeof a?.agent === "string"
        ? [
            {
              pane: a.pane_id,
              agent: a.agent,
              status: String(a.agent_status ?? "unknown"),
              cwd: String(a.foreground_cwd ?? a.cwd ?? ""),
              native: typeof a.agent_session?.value === "string" ? a.agent_session.value : null,
              ...(a.terminal_title_stripped || a.name ? { title: String(a.terminal_title_stripped || a.name) } : {}),
            },
          ]
        : [],
    );
  } catch {
    return [];
  }
}

const TURN_MS = 10 * 60 * 1000;

export class HerdrAdapter implements AgentAdapter {
  readonly id = "herdr" as const;
  constructor(private bin = "herdr") {}

  async available() {
    if (process.platform === "win32") return { ok: false };
    return versionOf(this.bin);
  }

  async start(): Promise<Run> {
    throw new Error("herdr only reaches sessions already open in a terminal");
  }

  async panes(): Promise<HerdrPane[]> {
    const r = await runAgentAsync(this.bin, ["agent", "list"], { timeout: 10_000 });
    return r.code === 0 ? parseHerdrList(r.out) : [];
  }

  async running() {
    return (await this.panes()).map((p) => ({ native: p.native ?? p.pane, cwd: p.cwd, tool: p.agent, ...(p.title ? { title: p.title } : {}) }));
  }

  /** `native.id`: the agent's session id, or a pane id (w1:p4). */
  async attach(native: { id: string; cwd: string }, sink: Sink): Promise<Run> {
    const pane = (await this.panes()).find((p) => p.native === native.id || p.pane === native.id);
    if (!pane) throw new Error("that session isn't open in herdr any more");
    const done = deferred<{ ok: boolean; error?: string }>();
    let busy = false;
    return {
      native: pane.native ?? pane.pane,
      send: async (text) => {
        if (done.settled()) throw new Error("this run has ended");
        if (busy) throw new Error("still waiting for the last message");
        busy = true;
        const r = await runAgentAsync(this.bin, ["agent", "prompt", pane.pane, text, "--wait", "--timeout", String(TURN_MS)], { timeout: TURN_MS + 10_000 });
        const screen = await runAgentAsync(this.bin, ["agent", "read", pane.pane, "--lines", "60", "--source", "recent"], { timeout: 10_000 });
        busy = false;
        if (screen.code === 0 && screen.out.trim()) sink({ kind: "text", text: screen.out.trimEnd().slice(-6000) });
        const after = (await this.panes()).find((p) => p.pane === pane.pane);
        if (after?.status === "blocked") sink({ kind: "text", text: "The agent is waiting for an answer in its terminal." });
        const ok = r.code === 0;
        const error = ok ? undefined : r.err.trim().split("\n").at(-1) || r.out.trim().split("\n").at(-1) || "herdr prompt failed";
        sink(ok ? { kind: "turn", ok } : { kind: "turn", ok, error });
        done.resolve(ok ? { ok } : { ok, error });
      },
      approve: async () => {
        throw new Error("answer this one in the terminal: herdr sessions take no approvals from here");
      },
      stop: async () => {
        await runAgentAsync(this.bin, ["agent", "send-keys", pane.pane, "esc"], { timeout: 10_000 });
        done.resolve({ ok: false, error: "stopped" });
      },
      done: done.promise,
    };
  }
}
