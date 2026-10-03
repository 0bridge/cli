import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Starting agent CLIs the same way on every OS: on Windows a command found on PATH may be a .cmd
 * (npm installs) that only cmd.exe runs, so its arguments are quoted for cmd.exe; elsewhere
 * nothing goes through a shell.
 */

/** The full path of `cmd` on PATH (with Windows' extensions), or null. */
export function which(cmd: string): string | null {
  if (cmd.includes("/") || cmd.includes("\\")) return existsSync(cmd) ? cmd : null;
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, cmd + ext.toLowerCase());
      if (existsSync(p)) return p;
      const P = join(dir, cmd + ext);
      if (ext && existsSync(P)) return P;
    }
  }
  return null;
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * One argument for a .cmd shim run by cmd.exe (as cross-spawn does it): quoted for the program,
 * then cmd's metacharacters escaped twice, since the shim hands `%*` to cmd once more.
 */
export function cmdQuote(arg: string): string {
  const q = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
  return q.replace(CMD_META, "^$1").replace(CMD_META, "^$1");
}

const cmdLine = (bin: string, args: string[]) => `"${[bin.replace(CMD_META, "^$1"), ...args.map(cmdQuote)].join(" ")}"`;

export function spawnAgent(cmd: string, args: string[], opts: SpawnOptions): ChildProcess {
  const bin = which(cmd) ?? cmd;
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(bin)) return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", cmdLine(bin, args)], { ...opts, windowsVerbatimArguments: true });
  return spawn(bin, args, { ...opts, shell: false });
}

/** Run to completion (short commands: versions, listings). */
export function runAgent(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; input?: string } = {}): { code: number | null; out: string; err: string } {
  const bin = which(cmd);
  if (!bin) return { code: null, out: "", err: `${cmd} not found` };
  const r =
    process.platform === "win32" && /\.(cmd|bat)$/i.test(bin)
      ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", cmdLine(bin, args)], { ...opts, encoding: "utf8", windowsVerbatimArguments: true })
      : spawnSync(bin, args, { ...opts, encoding: "utf8", shell: false });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** Like runAgent without blocking the daemon (for commands that wait, like `herdr agent prompt --wait`). */
export function runAgentAsync(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    if (!which(cmd)) return resolve({ code: null, out: "", err: `${cmd} not found` });
    const p = spawnAgent(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout?.on("data", (d) => (out += d));
    p.stderr?.on("data", (d) => (err += d));
    const t = opts.timeout ? setTimeout(() => kill(p, 1000), opts.timeout) : null;
    p.on("error", (e) => resolve({ code: null, out, err: e.message }));
    p.on("close", (code) => {
      if (t) clearTimeout(t);
      resolve({ code, out, err });
    });
  });
}

/** An agent CLI's version (the first x.y.z in `--version`), or null when it isn't installed. */
export function versionOf(cmd: string, args = ["--version"]): { ok: boolean; version?: string } {
  const r = runAgent(cmd, args, { timeout: 10_000 });
  if (r.code !== 0) return { ok: false };
  const v = /\d+\.\d+(?:\.\d+)?/.exec(r.out + r.err)?.[0];
  return v ? { ok: true, version: v } : { ok: true };
}

/** Each complete line of a stream, as it arrives. */
export function onLines(stream: NodeJS.ReadableStream | null | undefined, fn: (line: string) => void): void {
  if (!stream) return;
  let buf = "";
  stream.setEncoding?.("utf8");
  stream.on("data", (d: string) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (line.trim()) fn(line);
    }
  });
  stream.on("end", () => {
    if (buf.trim()) fn(buf);
    buf = "";
  });
}

/**
 * Stop a process: a polite signal, then a hard one after `ms`. Windows has no signals, and an npm
 * .cmd shim runs the agent as cmd.exe's child, which outlives cmd.exe (keeping its pipes open)
 * when only cmd.exe is ended: there the whole tree goes at once.
 */
export function kill(child: ChildProcess, ms = 5000, o: { group?: boolean } = {}): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid && spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true }).status === 0) return;
  // `group`: the child was spawned detached (its own process group), and what it started goes too,
  // SIGKILL included, even when the child itself has exited by then.
  if (o.group && child.pid && process.platform !== "win32") {
    const pid = child.pid;
    const signal = (s: NodeJS.Signals) => {
      try {
        process.kill(-pid, s);
      } catch {}
    };
    signal("SIGTERM");
    setTimeout(() => signal("SIGKILL"), ms).unref?.();
    return;
  }
  child.kill("SIGTERM");
  const t = setTimeout(() => child.exitCode === null && child.signalCode === null && child.kill("SIGKILL"), ms);
  t.unref?.();
}
