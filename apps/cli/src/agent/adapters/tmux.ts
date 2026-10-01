import { runAgent, runAgentAsync, versionOf } from "./spawn.ts";
import { deferred, type AgentAdapter, type Run, type Sink } from "./types.ts";

/**
 * Agents running in tmux panes, where herdr isn't used: `list-panes` finds them and
 * `capture-pane` reads them. Typing into a pane (`send-keys`) happens only in repos whose rules
 * say `keys: true` (the daemon checks). No approvals; nothing on Windows.
 */

export interface TmuxPane {
  pane: string;
  cwd: string;
  command: string;
  title: string;
  pid: number;
}

const AGENT_COMMANDS: Record<string, string> = { claude: "claude", codex: "codex", gemini: "gemini", "cursor-agent": "cursor" };

/** `list-panes -a -F` output, tab-separated as asked for below. */
export function parseTmuxPanes(out: string): TmuxPane[] {
  return out.split("\n").flatMap((line) => {
    const [pane, cwd, command, title, pid] = line.split("\t");
    return pane?.startsWith("%") && cwd ? [{ pane, cwd, command: command ?? "", title: title ?? "", pid: Number(pid) || 0 }] : [];
  });
}

const FORMAT = "#{pane_id}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_title}\t#{pane_pid}";
const TURN_MS = 10 * 60 * 1000;
const QUIET_MS = 8000;

export class TmuxAdapter implements AgentAdapter {
  readonly id = "tmux" as const;
  constructor(private bin = "tmux") {}

  async available() {
    if (process.platform === "win32") return { ok: false };
    return versionOf(this.bin, ["-V"]);
  }

  async start(): Promise<Run> {
    throw new Error("tmux only reaches sessions already open in a terminal");
  }

  async panes(): Promise<TmuxPane[]> {
    const r = await runAgentAsync(this.bin, ["list-panes", "-a", "-F", FORMAT], { timeout: 10_000 });
    return r.code === 0 ? parseTmuxPanes(r.out) : [];
  }

  async running() {
    return (await this.panes()).flatMap((p) => {
      const tool = AGENT_COMMANDS[p.command];
      return tool ? [{ native: p.pane, cwd: p.cwd, tool, ...(p.title ? { title: p.title } : {}) }] : [];
    });
  }

  /** The pane a process runs in (its own shell or an ancestor's), or null. */
  async paneOf(pid: number): Promise<string | null> {
    const panes = await this.panes();
    for (let p = pid, hops = 0; p > 1 && hops < 30; hops++) {
      const hit = panes.find((x) => x.pid === p);
      if (hit) return hit.pane;
      const r = runAgent("ps", ["-o", "ppid=", "-p", String(p)], { timeout: 5000 });
      p = Number(r.out.trim());
      if (!p) break;
    }
    return null;
  }

  async attach(native: { id: string; cwd: string }, sink: Sink): Promise<Run> {
    const pane = native.id;
    if (!(await this.panes()).some((p) => p.pane === pane)) throw new Error("that tmux pane is gone");
    const capture = async () => (await runAgentAsync(this.bin, ["capture-pane", "-p", "-t", pane, "-S", "-60"], { timeout: 10_000 })).out;
    const done = deferred<{ ok: boolean; error?: string }>();
    return {
      native: pane,
      send: async (text) => {
        if (done.settled()) throw new Error("this run has ended");
        const typed = await runAgentAsync(this.bin, ["send-keys", "-t", pane, "-l", text], { timeout: 10_000 });
        if (typed.code !== 0) throw new Error(typed.err.trim() || "tmux send-keys failed");
        await runAgentAsync(this.bin, ["send-keys", "-t", pane, "Enter"], { timeout: 10_000 });
        // No turn signal from a terminal: wait until the screen stops changing.
        let last = await capture();
        let quietSince = Date.now();
        for (const start = Date.now(); Date.now() - start < TURN_MS && Date.now() - quietSince < QUIET_MS && !done.settled(); ) {
          await new Promise((r) => setTimeout(r, 1000));
          const now = await capture();
          if (now !== last) {
            last = now;
            quietSince = Date.now();
          }
        }
        if (last.trim()) sink({ kind: "text", text: last.trimEnd().slice(-6000) });
        sink({ kind: "turn", ok: true });
        done.resolve({ ok: true });
      },
      approve: async () => {
        throw new Error("answer this one in the terminal: tmux sessions take no approvals from here");
      },
      stop: async () => {
        await runAgentAsync(this.bin, ["send-keys", "-t", pane, "Escape"], { timeout: 10_000 });
        done.resolve({ ok: false, error: "stopped" });
      },
      done: done.promise,
    };
  }
}
