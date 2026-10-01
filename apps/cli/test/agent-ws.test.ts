import { describe, expect, test } from "bun:test";
import { connectLoop } from "../src/agent/ws.ts";

/** A hub stand-in: what it does with each new connection is up to the test. */
function fakeHub(onOpen: (ws: Bun.ServerWebSocket<unknown>, n: number) => void, onMessage: (msg: string) => void = () => {}) {
  const opens: number[] = [];
  const auth: (string | null)[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      auth.push(req.headers.get("authorization"));
      return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
    },
    websocket: {
      open(ws) {
        opens.push(Date.now());
        onOpen(ws, opens.length);
      },
      message(_ws, m) {
        onMessage(String(m));
      },
    },
  });
  return { url: `ws://localhost:${server.port}/api/machines/connect`, opens, auth, stop: () => server.stop(true) };
}

describe("connectLoop", () => {
  test("reconnects with a doubling delay up to the cap, and sends the token", async () => {
    const hub = fakeHub((ws) => ws.close(1011, "bye"));
    const loop = connectLoop(hub.url, "tok-1", () => {}, { minDelay: 40, maxDelay: 160 });
    while (hub.opens.length < 6) await Bun.sleep(10);
    loop.stop();
    await loop.done;
    hub.stop();
    // Each connection opened, so the delay starts over at the minimum every time.
    const gaps = hub.opens.slice(1).map((t, i) => t - hub.opens[i]!);
    for (const g of gaps) expect(g).toBeLessThan(140);
    expect(hub.auth[0]).toBe("Bearer tok-1");
  });

  test("backs off 1, 2, 4… (scaled) while connecting keeps failing, capped", async () => {
    // Nothing listens: every attempt fails before it opens.
    const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
    const url = `ws://localhost:${probe.port}/x`;
    probe.stop(true);
    const at: number[] = [];
    const loop = connectLoop(url, "t", () => {}, {
      minDelay: 20,
      maxDelay: 80,
      open: (u, t) => {
        at.push(Date.now());
        return new WebSocket(u, { headers: { Authorization: `Bearer ${t}` } } as never);
      },
    });
    while (at.length < 6) await Bun.sleep(5);
    loop.stop();
    await loop.done;
    const gaps = at.slice(1).map((t, i) => t - at[i]!);
    expect(gaps[0]!).toBeGreaterThanOrEqual(15);
    expect(gaps[1]!).toBeGreaterThanOrEqual(35);
    expect(gaps[2]!).toBeGreaterThanOrEqual(70);
    expect(gaps[3]!).toBeGreaterThanOrEqual(70);
    expect(gaps[3]!).toBeLessThan(200);
  });

  test("messages in, frames and pings out; 4001 (token deleted) stops it", async () => {
    const got: string[] = [];
    const hub = fakeHub(
      (ws) => {
        ws.send(JSON.stringify({ t: "req", rid: "r1", op: "sessions" }));
        ws.send("not json");
      },
      (m) => got.push(m),
    );
    const seen: unknown[] = [];
    let closed: number | null = null;
    const loop = connectLoop(hub.url, "tok", (msg, conn) => {
      seen.push(msg);
      conn.send({ t: "reply", rid: "r1", ok: true });
    }, { pingMs: 30, onOpen: (c) => c.send({ t: "hello", v: 1 }), onClose: (code) => (closed = code) });
    while (got.filter((m) => m.includes("ping")).length < 2) await Bun.sleep(10);
    expect(seen).toEqual([{ t: "req", rid: "r1", op: "sessions" }]);
    expect(JSON.parse(got[0]!)).toEqual({ t: "hello", v: 1 });
    expect(got.map((m) => JSON.parse(m).t)).toContain("reply");
    // The hub drops this machine for good: no reconnect.
    const opened = hub.opens.length;
    hub.stop();
    loop.stop();
    await loop.done;
    expect(hub.opens.length).toBe(opened);

    const hub2 = fakeHub((ws) => ws.close(4001, "token revoked"));
    const loop2 = connectLoop(hub2.url, "tok", () => {}, { minDelay: 10, onClose: (code) => (closed = code) });
    expect(await loop2.done).toBe(4001);
    expect(closed).toBe(4001);
    expect(hub2.opens.length).toBe(1);
    hub2.stop();
  });

  test("a socket that never opens because the token is refused ends it too", async () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
    const url = `ws://localhost:${probe.port}/x`;
    probe.stop(true);
    let asked = 0;
    const loop = connectLoop(url, "t", () => {}, { minDelay: 5, refused: async () => ++asked >= 2 });
    expect(await loop.done).toBe(4001);
    expect(asked).toBe(2);
  });
});
