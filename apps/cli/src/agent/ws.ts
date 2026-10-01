/**
 * The daemon's connection to the machine hub: one WebSocket, opened again after 1 s, then 2, 4…
 * up to 30 s while it keeps failing (back to 1 s once one opens), with a ping every 50 s so idle
 * proxies don't close it. Close code 4001 means this device's token was deleted and 4003 that the
 * machine was removed: it stops, and `done` says which. A socket that never opens can't say why, so
 * `refused` (when given) is asked after each such failure whether the server turns the token away.
 */

export interface Conn {
  /** False when it isn't open (the frame is dropped; the caller keeps what must survive). */
  send(frame: object): boolean;
  close(): void;
}

export interface LoopOptions {
  onOpen?(conn: Conn): void;
  onClose?(code: number, reason: string): void;
  minDelay?: number;
  maxDelay?: number;
  pingMs?: number;
  /** For tests: what opens a socket. */
  open?: (url: string, token: string) => WebSocket;
  /** After a connection that never opened: true when the token itself is refused (reconnecting can't help). */
  refused?: () => Promise<boolean>;
}

/** Codes after which reconnecting can't help. */
const FINAL = new Set([4001, 4003]);

/** `done` settles with the close code that ended the loop (4001, 4003), or null when stopped. */
export function connectLoop(url: string, token: string, onMessage: (msg: unknown, conn: Conn) => void, opts: LoopOptions = {}): { stop(): void; done: Promise<number | null> } {
  const min = opts.minDelay ?? 1000;
  const max = opts.maxDelay ?? 30_000;
  // Node's and Bun's WebSocket both take headers here (not in the web standard).
  const open = opts.open ?? ((u: string, t: string) => new WebSocket(u, { headers: { Authorization: `Bearer ${t}` } } as never));
  let stopped = false;
  let current: WebSocket | null = null;
  let wake: (() => void) | null = null;

  const done = (async (): Promise<number | null> => {
    let delay = min;
    while (!stopped) {
      let opened = false;
      const code = await new Promise<number>((resolve) => {
        let ws: WebSocket;
        try {
          ws = open(url, token);
        } catch {
          return resolve(0);
        }
        current = ws;
        const conn: Conn = {
          send: (frame) => {
            if (ws.readyState !== WebSocket.OPEN) return false;
            ws.send(JSON.stringify(frame));
            return true;
          },
          close: () => ws.close(),
        };
        const ping = setInterval(() => conn.send({ t: "ping" }), opts.pingMs ?? 50_000);
        ws.onopen = () => {
          opened = true;
          delay = min;
          opts.onOpen?.(conn);
        };
        ws.onmessage = (e) => {
          let msg: unknown;
          try {
            msg = JSON.parse(String(e.data));
          } catch {
            return;
          }
          onMessage(msg, conn);
        };
        ws.onclose = (e) => {
          clearInterval(ping);
          current = null;
          opts.onClose?.(e.code, e.reason);
          resolve(e.code);
        };
        ws.onerror = () => {};
      });
      if (stopped) break;
      if (FINAL.has(code)) return code;
      if (!opened && opts.refused && (await opts.refused().catch(() => false))) return 4001;
      await new Promise<void>((r) => {
        const t = setTimeout(r, delay);
        wake = () => {
          clearTimeout(t);
          r();
        };
      });
      wake = null;
      delay = Math.min(delay * 2, max);
    }
    return null;
  })();

  return {
    stop() {
      stopped = true;
      current?.close();
      wake?.();
    },
    done,
  };
}
