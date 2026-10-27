import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { NetconConnection } from "../src/index.ts";

const waitFor = async (fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

function fakeConsole(port: number) {
  const received: string[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("data", (d) => received.push(...d.toString().split("\n").filter(Boolean)));
  });
  return {
    received,
    listen: () => new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r())),
    /** Simulates the game quitting: drops clients and stops listening. */
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
    say: (line: string) => {
      for (const s of sockets) s.write(`${line}\r\n`);
    },
  };
}

const conns: NetconConnection[] = [];
afterEach(() => {
  for (const c of conns.splice(0)) c.stop();
});

describe("NetconConnection", () => {
  it("connects when the game comes up, re-applies on every connect and reconnects after the game restarts", async () => {
    const port = await freePort();
    const game = fakeConsole(port);
    const conn = new NetconConnection({ host: "127.0.0.1", port, retryMs: 50, maxRetryMs: 100, connectTimeoutMs: 300 });
    conns.push(conn);
    let connects = 0;
    conn.onConnect(() => {
      connects++;
      void conn.write("spec_show_xray 1");
    });
    conn.start();
    await waitFor(() => conn.status === "connecting" && conn.lastError !== null);
    await expect(conn.write("echo early")).rejects.toThrow(/not connected/);

    await game.listen();
    await waitFor(() => conn.status === "connected");
    await waitFor(() => game.received.includes("spec_show_xray 1"));
    expect(connects).toBe(1);

    const lines: string[] = [];
    conn.onLine((l) => lines.push(l));
    game.say("setpos 1 2 3;setang 4 5 0");
    await waitFor(() => lines.length === 1);
    expect(lines[0]).toBe("setpos 1 2 3;setang 4 5 0");

    await game.close();
    await waitFor(() => conn.status === "connecting");
    await game.listen();
    await waitFor(() => connects === 2);
    expect(game.received.filter((l) => l === "spec_show_xray 1")).toHaveLength(2);
    await game.close();
  });

  it("refuses lines with line breaks (no smuggled commands) and stops cleanly", async () => {
    const port = await freePort();
    const game = fakeConsole(port);
    await game.listen();
    const conn = new NetconConnection({ host: "127.0.0.1", port });
    conns.push(conn);
    await conn.ensure();
    await expect(conn.write("echo a\nquit")).rejects.toThrow(/line breaks/);
    await conn.write("echo ok");
    await waitFor(() => game.received.includes("echo ok"));
    expect(game.received).not.toContain("quit");
    conn.stop();
    expect(conn.status).toBe("stopped");
    expect(conn.connected).toBe(false);
    await game.close();
  });
});
