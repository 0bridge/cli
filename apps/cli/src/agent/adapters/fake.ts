import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { deniedBy, type Mode } from "../policy.ts";
import { deferred, type AgentAdapter, type Run, type Sink, type StartOptions } from "./types.ts";

/**
 * A stand-in agent for tests (ZEROBRIDGE_AGENT_FAKE=1): it echoes each message, and a few markers
 * in it act out the rest. `[permission]` asks before it goes on, `[cmd:<command>]` tries a
 * command (refused ones never get asked), `create <file>` writes that file (with "hi") in the
 * task's folder, `[fail]` ends the turn with an error, `[hang]` waits until stopped.
 */
export class FakeAdapter implements AgentAdapter {
  constructor(
    readonly id: "claude" | "codex" | "gemini",
    private deny: (task: string) => string[],
    private head: (task: string) => string | undefined = () => undefined,
  ) {}

  async available() {
    return { ok: true, version: "0.0.0-fake" };
  }

  start(o: StartOptions, sink: Sink): Promise<Run> {
    return this.run(o.task, o.cwd, o.mode, sink, `fake-${randomBytes(6).toString("hex")}`, o.prompt);
  }

  attach(native: { id: string; cwd: string }, sink: Sink, o?: { mode: Mode; task?: string }): Promise<Run> {
    return this.run(o?.task ?? "t_fake", native.cwd, o?.mode ?? "edit", sink, native.id, null);
  }

  private async run(task: string, cwd: string, mode: Mode, sink: Sink, native: string, first: string | null): Promise<Run> {
    const done = deferred<{ ok: boolean; error?: string }>();
    const asks = new Map<string, (d: "allow" | "deny") => void>();
    let stopped = false;
    sink({ kind: "native", native });
    const turn = async (text: string) => {
      sink({ kind: "text", text: `echo: ${text}` });
      const cmd = /\[cmd:([^\]]+)\]/.exec(text)?.[1];
      if (cmd) {
        const rule = deniedBy(this.deny(task), cmd, this.head(task));
        if (rule) sink({ kind: "text", text: `Refused on this machine (rule "${rule}"): ${cmd}` });
      }
      let allowed = mode !== "plan";
      if (text.includes("[permission]") && allowed) {
        const request = `p_${randomBytes(5).toString("hex")}`;
        const d = await new Promise<"allow" | "deny">((r) => {
          asks.set(request, r);
          sink({ kind: "permission", request, tool: "Bash", summary: cmd ?? "touch hello.txt" });
        });
        allowed = d === "allow";
        sink({ kind: "text", text: allowed ? "allowed" : "denied" });
      }
      const file = /\bcreate (\S+)/.exec(text)?.[1];
      if (file && allowed) {
        writeFileSync(join(cwd, basename(file)), "hi\n");
        sink({ kind: "tool", tool: "Write", summary: basename(file) });
      }
      if (text.includes("[hang]")) await done.promise;
      if (stopped) return;
      if (text.includes("[fail]")) {
        sink({ kind: "turn", ok: false, error: "fake failure" });
        return done.resolve({ ok: false, error: "fake failure" });
      }
      sink({ kind: "turn", ok: true, summary: "ok" });
      done.resolve({ ok: true });
    };
    if (first !== null) void turn(first);
    return {
      native,
      send: async (text) => {
        if (done.settled()) throw new Error("this run has ended");
        void turn(text);
      },
      approve: async (request, d) => {
        const r = asks.get(request);
        if (!r) throw new Error(`no permission request ${request} is waiting`);
        asks.delete(request);
        r(d);
      },
      stop: async () => {
        stopped = true;
        for (const r of asks.values()) r("deny");
        done.resolve({ ok: false, error: "stopped" });
      },
      done: done.promise,
    };
  }
}
