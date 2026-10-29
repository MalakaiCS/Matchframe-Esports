import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { CAM_QUALITY_PRESETS, decodeCamFrame, encodeCamFrame, type CamRoomInfo, type CamRoster } from "@matchframe/cloud-contracts";
import { CloudApp } from "../src/app.ts";
import { loadCloudConfig } from "../src/config.ts";
import { PgliteSql } from "../src/db/sql.ts";
import { startCloudServer } from "../src/server.ts";
import { Client, freePort } from "./http.ts";

const PASSWORD = "correct horse battery";
const ROOM = "abcdefghij0123456789";
const roster: CamRoster = {
  title: "Alpha vs Bravo",
  teams: [
    { name: "Alpha", players: [{ key: "aaaaaa01", name: "nova" }, { key: "aaaaaa02", name: "flux" }] },
    { name: "Bravo", players: [{ key: "bbbbbb01", name: "zeal" }] },
  ],
};

type Msg = Record<string, unknown> & { type?: string };

/** A WebSocket that queues what it receives: JSON text and binary frames separately. */
class Peer {
  readonly texts: Msg[] = [];
  readonly frames: Buffer[] = [];
  closed: { code: number } | null = null;
  constructor(readonly ws: WebSocket) {
    ws.on("message", (d, bin) => (bin ? this.frames.push(d as Buffer) : this.texts.push(JSON.parse(String(d)) as Msg)));
    ws.on("close", (code) => (this.closed = { code }));
  }
  static open(url: string, headers: Record<string, string> = {}): Promise<Peer> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      const p = new Peer(ws);
      ws.on("open", () => resolve(p));
      ws.on("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.on("error", reject);
    });
  }
  send(o: unknown): void {
    this.ws.send(JSON.stringify(o));
  }
  async next(type: string, ms = 2000): Promise<Msg> {
    const end = Date.now() + ms;
    for (;;) {
      const i = this.texts.findIndex((m) => m.type === type);
      if (i >= 0) return this.texts.splice(i, 1)[0]!;
      if (Date.now() > end) throw new Error(`no ${type} message (have ${JSON.stringify(this.texts)})`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  async frameCount(n: number, ms = 2000): Promise<void> {
    const end = Date.now() + ms;
    while (this.frames.length < n) {
      if (Date.now() > end) throw new Error(`have ${this.frames.length} frames, want ${n}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  async closedWith(ms = 2000): Promise<number> {
    const end = Date.now() + ms;
    while (!this.closed) {
      if (Date.now() > end) throw new Error("still open");
      await new Promise((r) => setTimeout(r, 10));
    }
    return this.closed.code;
  }
}

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

describe("player cams relay (website)", () => {
  let app: CloudApp;
  let close: () => Promise<void>;
  let base: string;
  let wsBase: string;
  let tokenA: string;
  let tokenB: string;
  const peers: Peer[] = [];
  /** The program's connection, and the first player's. */
  let h: Peer;
  let first: Peer;

  const lastEmail = async (to: string) => (await app.sql.query<{ body_text: string }>("SELECT body_text FROM outbox_emails WHERE to_addr = $1 ORDER BY id DESC LIMIT 1", [to])).rows[0]!;
  async function deviceToken(email: string, installId: string): Promise<string> {
    const c = new Client(base);
    expect((await c.req("POST", "/v1/auth/signup", { email, password: PASSWORD, displayName: "Prod", orgName: `${email} Org` })).status).toBe(201);
    const token = /token=([A-Za-z0-9_-]+)/.exec((await lastEmail(email)).body_text)![1]!;
    expect((await c.req("POST", "/v1/auth/verify-email", { token })).status).toBe(200);
    const r = await new Client(base, null).req<{ deviceToken: string }>("POST", "/v1/device/login", { email, password: PASSWORD, deviceName: "Production PC", platform: "win32", appVersion: "0.8.0", installId });
    expect(r.status).toBe(200);
    return r.data.deviceToken;
  }
  const host = async (token: string) => {
    const p = await Peer.open(`${wsBase}/v1/cams/host`, { authorization: `Bearer ${token}` });
    peers.push(p);
    return p;
  };
  const player = async (key: string, room = ROOM) => {
    const p = await Peer.open(`${wsBase}/v1/cams/${room}/publish?key=${key}`);
    peers.push(p);
    return p;
  };
  const info = () => new Client(base).req<CamRoomInfo & { error: string; message: string }>("GET", `/v1/cams/${ROOM}`);
  const hello = { type: "hello", codec: "vp8", width: 640, height: 360, fps: 30, camera: "Logitech C920" };

  beforeAll(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    wsBase = `ws://127.0.0.1:${port}`;
    app = new CloudApp(loadCloudConfig({}, { publicUrl: base, port }), { sql: new PgliteSql(), rateLimitScale: 100 });
    await app.init();
    ({ close } = await startCloudServer(app));
    tokenA = await deviceToken("prod-a@example.com", "install-aaaaaaaaaaaaaaaa");
    tokenB = await deviceToken("prod-b@example.com", "install-bbbbbbbbbbbbbbbb");
  });

  afterAll(async () => {
    for (const p of peers) p.ws.terminate();
    await close?.();
    await app?.close();
  });

  it("opens a room only for a signed-in computer, and shows the match to the cam page", async () => {
    await expect(Peer.open(`${wsBase}/v1/cams/host`)).rejects.toThrow("HTTP 401");
    await expect(Peer.open(`${wsBase}/v1/cams/host`, { authorization: "Bearer nope" })).rejects.toThrow("HTTP 401");
    expect((await info()).status).toBe(404);
    h = await host(tokenA);
    h.send({ type: "open", room: ROOM, roster, quality: CAM_QUALITY_PRESETS.standard });
    expect(await h.next("opened")).toEqual({ type: "opened", room: ROOM });
    const r = await info();
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ room: ROOM, title: "Alpha vs Bravo", teams: roster.teams, quality: CAM_QUALITY_PRESETS.standard, hostConnected: true });
    // Another computer can't take the link.
    const other = await host(tokenB);
    other.send({ type: "open", room: ROOM, roster, quality: CAM_QUALITY_PRESETS.standard });
    expect(await other.next("error")).toMatchObject({ code: "room_taken" });
    expect(await other.closedWith()).toBe(4009);
  });

  it("relays a player's video to the program from their first keyframe, with the program's answers back", async () => {
    await expect(player("zzzzzz99")).rejects.toThrow("HTTP 404");
    await expect(player("aaaaaa01", "nosuchroom000000000")).rejects.toThrow("HTTP 404");
    const p = (first = await player("aaaaaa01"));
    p.send(hello);
    const join = await h.next("join");
    expect(join).toMatchObject({ key: "aaaaaa01", hello });
    expect(await p.next("status")).toEqual({ type: "status", state: "waiting_approval" });
    const id = join.id as number;
    // A frame before the first keyframe can't be decoded: dropped.
    p.ws.send(encodeCamFrame(false, 1000, new Uint8Array([9, 9, 9])));
    p.ws.send(encodeCamFrame(true, 2000, new Uint8Array([1, 2, 3])));
    p.ws.send(encodeCamFrame(false, 35333, new Uint8Array([4, 5])));
    await h.frameCount(2);
    await settle();
    expect(h.frames).toHaveLength(2);
    const [k, d] = h.frames.splice(0).map((b) => ({ id: b.readUInt32BE(0), f: decodeCamFrame(new Uint8Array(b.subarray(4)))! }));
    expect(k).toMatchObject({ id, f: { key: true, timestampUs: 2000 } });
    expect([...k!.f.data]).toEqual([1, 2, 3]);
    expect(d).toMatchObject({ id, f: { key: false, timestampUs: 35333 } });
    h.send({ type: "status", id, state: "live" });
    expect(await p.next("status")).toEqual({ type: "status", state: "live" });
    h.send({ type: "key", id });
    expect(await p.next("key")).toEqual({ type: "key" });
  });

  it("replaces a player who opens the page again, and lets the program send one away", async () => {
    const again = await player("aaaaaa01");
    again.send(hello);
    expect(await first.next("kicked")).toMatchObject({ reason: expect.stringMatching(/somewhere else/) });
    expect(await first.closedWith()).toBe(4003);
    const join = await h.next("join");
    await h.next("leave");
    h.send({ type: "kick", id: join.id, reason: "Wrong camera" });
    expect(await again.next("kicked")).toEqual({ type: "kicked", reason: "Wrong camera" });
    expect(await again.closedWith()).toBe(4003);
    expect(await h.next("leave")).toMatchObject({ id: join.id, key: "aaaaaa01" });
  });

  it("keeps players waiting while the program is away, and hands them over when it reconnects", async () => {
    const p = await player("bbbbbb01");
    p.send(hello);
    const join = await h.next("join");
    await p.next("status");
    h.ws.close();
    expect(await p.next("status")).toEqual({ type: "status", state: "waiting_host" });
    expect((await info()).data.hostConnected).toBe(false);
    // Frames while nobody hosts go nowhere.
    p.ws.send(encodeCamFrame(true, 5000, new Uint8Array([7])));
    h = await host(tokenA);
    h.send({ type: "open", room: ROOM, roster, quality: CAM_QUALITY_PRESETS.standard });
    await h.next("opened");
    expect(await h.next("join")).toMatchObject({ id: join.id, key: "bbbbbb01" });
    // A roster without them sends them away.
    h.send({ type: "roster", roster: { ...roster, teams: [roster.teams[0]!] } });
    expect(await p.next("kicked")).toMatchObject({ reason: expect.stringMatching(/no longer listed/) });
    expect((await info()).data.teams).toHaveLength(1);
  });

  it("caps what one player can send at a few times the room's bitrate", async () => {
    h.send({ type: "quality", quality: { ...CAM_QUALITY_PRESETS.low, bitrateKbps: 100 } });
    await settle();
    const p = (first = await player("aaaaaa02"));
    p.send(hello);
    await h.next("join");
    const before = h.frames.length;
    // 100 kbit/s × 5 s × 3 = 187.5 kB in 5 s: the third 80 kB keyframe is over.
    for (let i = 0; i < 3; i++) p.ws.send(encodeCamFrame(true, i * 1000, new Uint8Array(80_000)));
    await h.frameCount(before + 2);
    await settle(150);
    expect(h.frames.length - before).toBe(2);
  });

  it("closes the room when the program says so", async () => {
    h.send({ type: "close" });
    expect(await first.next("kicked")).toMatchObject({ reason: expect.stringMatching(/closed the player cams/) });
    await settle();
    expect((await info()).status).toBe(404);
    expect(app.cams.stats()).toEqual({ rooms: 0, players: 0 });
  });
});
