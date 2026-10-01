import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Context } from "@0bridge/core";

/**
 * The daemon's local socket (a unix socket in 0bridge's folder, a named pipe on Windows): the
 * permission tool a Claude Code task runs asks the daemon here, and waits for the user's answer.
 * One JSON line each way per connection. It only carries questions; answers come from the hub.
 */

export function ipcPath(ctx: Context): string {
  const tag = createHash("sha1").update(resolve(ctx.storeDir)).digest("hex").slice(0, 10);
  if (process.platform === "win32") {
    const user = userInfo().username.replace(/[^A-Za-z0-9_.-]/g, "_");
    return `\\\\.\\pipe\\0bridge-agent-${user}${ctx.storeDir === join(ctx.home, ".0bridge") ? "" : `-${tag}`}`;
  }
  const own = join(ctx.storeDir, "agent", "ipc.sock");
  // Unix socket paths are limited to about 104 bytes (macOS); a deep 0bridge folder uses /tmp.
  return Buffer.byteLength(own) < 100 ? own : join(tmpdir(), `0b-agent-${tag}.sock`);
}

/** Answer each request with `handle`. Throws when another daemon already listens there. */
export async function serveIpc(path: string, handle: (msg: Record<string, unknown>) => Promise<unknown>): Promise<{ close(): Promise<void> }> {
  if (process.platform !== "win32") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const sockets = new Set<Socket>();
  const server: Server = createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => {});
    let buf = "";
    sock.on("data", async (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl < 0) {
        if (buf.length > 1024 * 1024) sock.destroy();
        return;
      }
      const line = buf.slice(0, nl);
      buf = "";
      let out: unknown;
      try {
        out = { ok: true, data: await handle(JSON.parse(line)) };
      } catch (e) {
        out = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      if (!sock.destroyed) sock.end(JSON.stringify(out) + "\n");
    });
  });
  const listen = () =>
    new Promise<void>((res, rej) => {
      server.once("error", rej);
      server.listen(path, () => {
        server.off("error", rej);
        res();
      });
    });
  try {
    await listen();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    // Left over from a daemon that died, or another one running now.
    if (await ipcRequest(path, { op: "ping" }, 1000).then(() => true, () => false)) throw new Error("another `0b agent run` is already running on this machine");
    if (process.platform !== "win32") rmSync(path, { force: true });
    await listen();
  }
  if (process.platform !== "win32") chmodSync(path, 0o600);
  return {
    close: () =>
      new Promise<void>((res) => {
        for (const s of sockets) s.destroy();
        server.close(() => res());
        if (process.platform !== "win32") rmSync(path, { force: true });
      }),
  };
}

/** Send one request and wait up to `timeoutMs` for its answer. */
export function ipcRequest<T = unknown>(path: string, msg: object, timeoutMs: number): Promise<T> {
  return new Promise<T>((res, rej) => {
    const sock = createConnection(path);
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      rej(new Error("timed out"));
    }, timeoutMs);
    sock.on("connect", () => sock.write(JSON.stringify(msg) + "\n"));
    sock.on("data", (d) => (buf += d));
    sock.on("error", (e) => {
      clearTimeout(timer);
      rej(e);
    });
    sock.on("close", () => {
      clearTimeout(timer);
      try {
        const r = JSON.parse(buf.trim()) as { ok: boolean; data?: T; error?: string };
        r.ok ? res(r.data as T) : rej(new Error(r.error ?? "failed"));
      } catch {
        rej(new Error("the 0b agent daemon closed the connection"));
      }
    });
  });
}
