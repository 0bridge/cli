import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, utimesSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * A lock file shared by 0b processes on one machine (the hook worker, the periodic job and a
 * manual sync), so two of them never upload or rewrite history.json at once.
 */

/** A lock nobody touched for this long is stale even if its pid is alive (a hung process, or a reused pid). */
const STALE_MS = 10 * 60_000;
/** The holder touches the file this often, so a long first sync is never taken for stale. */
const HEARTBEAT_MS = 60_000;

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const read = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** Whether the lock at `path` belongs to nobody: its pid is gone, or it hasn't been touched in 10 minutes. */
function stale(path: string, body: string): boolean {
  const pid = Number(body.split("\n")[0]);
  if (!alive(pid)) return true;
  try {
    return Date.now() - statSync(path).mtimeMs > STALE_MS;
  } catch {
    return true;
  }
}

/** Take the lock at `path` (O_EXCL, holding our pid) or return null; a stale one (dead pid or >10 min) is taken over. Call the result to release it. */
export function tryLock(path: string): (() => void) | null {
  mkdirSync(dirname(path), { recursive: true });
  const body = `${process.pid}\n${Date.now()}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const held = read(path);
      if (held === null) continue; // released between our open and read: try again
      if (!stale(path, held)) return null;
      // Take it over, unless someone else did in the meantime (then it's theirs, and fresh).
      if (read(path) !== held) return null;
      rmSync(path, { force: true });
      continue;
    }
    writeSync(fd, body);
    closeSync(fd);
    const beat = setInterval(() => {
      try {
        const now = new Date();
        utimesSync(path, now, now);
      } catch {}
    }, HEARTBEAT_MS);
    beat.unref?.();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      clearInterval(beat);
      // Only our own: a lock taken over from us (we hung for 10 minutes) is someone else's now.
      if (read(path) === body) rmSync(path, { force: true });
    };
  }
  return null;
}

/** Run `fn` holding the lock at `path`; null when another process holds it. */
export async function withLock<T>(path: string, fn: () => Promise<T>): Promise<T | null> {
  const release = tryLock(path);
  if (!release) return null;
  try {
    return await fn();
  } finally {
    release();
  }
}
