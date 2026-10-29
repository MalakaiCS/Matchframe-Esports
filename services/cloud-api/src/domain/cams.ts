import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { CAM_ROOM_RE, CamHello, CamHostMessage, decodeCamFrame, type CamQuality, type CamRelayMessage, type CamRoomInfo, type CamRoster, type CamPublisherMessage } from "@matchframe/cloud-contracts";

/**
 * Player cams relay (ADR-048). A production's program hosts a room (`/v1/cams/host`, with its
 * computer's credential); players open the room's page and send their encoded video to
 * `/v1/cams/<room>/publish?key=<player>`; the relay forwards each frame to the program, prefixed
 * with the player's connection id. Nothing is stored: rooms live in memory while their program or
 * players are connected. Video goes through only while the program is connected.
 */

/** Players sending at once in one room. */
const MAX_PUBLISHERS = 16;
/** Largest message (an encoded keyframe at 1080p fits easily). */
const MAX_FRAME = 512 * 1024;
/** Program connection backed up beyond this: drop players' frames until their next keyframe. */
const HOST_BACKLOG = 8 * 1024 * 1024;
/** A player may send up to this many times the room's bitrate (bursts at keyframes), measured over 5 s. */
const BITRATE_SLACK = 3;
const PING_MS = 25_000;
/** A room with no program and no players is forgotten after this long. */
const IDLE_ROOM_MS = 10 * 60_000;
/** The program must say which room within this long after connecting. */
const OPEN_TIMEOUT_MS = 10_000;

interface Publisher {
  id: number;
  key: string;
  ws: WebSocket;
  hello: CamHello | null;
  needKey: boolean;
  window: { start: number; bytes: number };
}

interface Room {
  code: string;
  deviceId: string;
  orgId: string;
  roster: CamRoster;
  quality: CamQuality;
  host: WebSocket | null;
  publishers: Map<number, Publisher>;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export interface CamDevice {
  deviceId: string;
  orgId: string;
}

export class CamRelay {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
  private readonly rooms = new Map<string, Room>();
  private nextId = 1;
  private readonly pinger: ReturnType<typeof setInterval>;

  constructor(
    private readonly deps: {
      /** The program's credential from the Authorization header, or null when it isn't valid. */
      device: (authorization: string | undefined) => Promise<CamDevice | null>;
      /** False when this address opens rooms too often. */
      allowJoin: (ip: string) => boolean;
      now?: () => number;
    },
  ) {
    this.pinger = setInterval(() => {
      for (const ws of this.wss.clients) {
        if ((ws as WebSocket & { mfAlive?: boolean }).mfAlive === false) {
          ws.terminate();
          continue;
        }
        (ws as WebSocket & { mfAlive?: boolean }).mfAlive = false;
        ws.ping();
      }
    }, PING_MS);
    this.pinger.unref?.();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** GET /v1/cams/:room: the match and the video settings, or null for no such room. */
  info(code: string): CamRoomInfo | null {
    const r = CAM_ROOM_RE.test(code) ? this.rooms.get(code) : undefined;
    if (!r) return null;
    return { room: r.code, title: r.roster.title, teams: r.roster.teams, quality: r.quality, hostConnected: !!r.host };
  }

  /** Handles `/v1/cams/host` and `/v1/cams/<room>/publish`; false for other paths. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, ip: string): boolean {
    const url = new URL(req.url ?? "/", "http://local");
    const refuse = (status: number, text: string) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (url.pathname === "/v1/cams/host") {
      void this.deps.device(req.headers.authorization).then(
        (dev) => {
          if (!dev) return refuse(401, "Unauthorized");
          this.wss.handleUpgrade(req, socket, head, (ws) => this.attachHost(ws, dev));
        },
        () => refuse(500, "Internal Server Error"),
      );
      return true;
    }
    const m = /^\/v1\/cams\/([a-z0-9]+)\/publish$/.exec(url.pathname);
    if (!m) return false;
    const room = CAM_ROOM_RE.test(m[1]!) ? this.rooms.get(m[1]!) : undefined;
    const key = url.searchParams.get("key") ?? "";
    if (!this.deps.allowJoin(ip)) {
      refuse(429, "Too Many Requests");
      return true;
    }
    if (!room || !room.roster.teams.some((t) => t.players.some((p) => p.key === key))) {
      refuse(404, "Not Found");
      return true;
    }
    if (room.publishers.size >= MAX_PUBLISHERS && ![...room.publishers.values()].some((p) => p.key === key)) {
      refuse(503, "Service Unavailable");
      return true;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.attachPublisher(ws, room, key));
    return true;
  }

  private alive(ws: WebSocket): void {
    (ws as WebSocket & { mfAlive?: boolean }).mfAlive = true;
    ws.on("pong", () => ((ws as WebSocket & { mfAlive?: boolean }).mfAlive = true));
  }

  private sendHost(room: Room, msg: CamRelayMessage): void {
    const h = room.host;
    if (h && h.readyState === h.OPEN) h.send(JSON.stringify(msg));
  }

  private sendPublisher(p: Publisher, msg: CamPublisherMessage): void {
    if (p.ws.readyState === p.ws.OPEN) p.ws.send(JSON.stringify(msg));
  }

  private attachHost(ws: WebSocket, dev: CamDevice): void {
    this.alive(ws);
    let room: Room | null = null;
    const timer = setTimeout(() => {
      if (room) return;
      ws.send(JSON.stringify({ type: "error", code: "timeout", message: "no room opened" } satisfies CamRelayMessage));
      ws.close(4008, "timeout");
    }, OPEN_TIMEOUT_MS);
    ws.on("message", (raw, isBinary) => {
      if (isBinary) return;
      let msg: CamHostMessage;
      try {
        msg = CamHostMessage.parse(JSON.parse(String(raw)));
      } catch {
        ws.send(JSON.stringify({ type: "error", code: "bad_message", message: "not a cam host message" } satisfies CamRelayMessage));
        return;
      }
      if (!room) {
        if (msg.type !== "open") return;
        const existing = this.rooms.get(msg.room);
        if (existing && existing.deviceId !== dev.deviceId) {
          ws.send(JSON.stringify({ type: "error", code: "room_taken", message: "this cam link belongs to another computer" } satisfies CamRelayMessage));
          ws.close(4009, "room taken");
          return;
        }
        clearTimeout(timer);
        room = existing ?? { code: msg.room, deviceId: dev.deviceId, orgId: dev.orgId, roster: msg.roster, quality: msg.quality, host: null, publishers: new Map(), idleTimer: null };
        if (room.host && room.host !== ws) room.host.close(4000, "replaced");
        room.host = ws;
        room.roster = msg.roster;
        room.quality = msg.quality;
        if (room.idleTimer) clearTimeout(room.idleTimer);
        room.idleTimer = null;
        this.rooms.set(room.code, room);
        ws.send(JSON.stringify({ type: "opened", room: room.code } satisfies CamRelayMessage));
        this.dropUnlisted(room);
        // Players already waiting: the program sees them now.
        for (const p of room.publishers.values()) if (p.hello) this.sendHost(room, { type: "join", id: p.id, key: p.key, hello: p.hello });
        return;
      }
      const r = room;
      switch (msg.type) {
        case "open":
          return;
        case "roster":
          r.roster = msg.roster;
          this.dropUnlisted(r);
          return;
        case "quality":
          r.quality = msg.quality;
          return;
        case "status": {
          const p = r.publishers.get(msg.id);
          if (p) this.sendPublisher(p, { type: "status", state: msg.state });
          return;
        }
        case "key": {
          const p = r.publishers.get(msg.id);
          if (p) this.sendPublisher(p, { type: "key" });
          return;
        }
        case "kick": {
          const p = r.publishers.get(msg.id);
          if (p) this.kick(p, msg.reason);
          return;
        }
        case "close":
          for (const p of r.publishers.values()) this.kick(p, "The production closed the player cams.");
          this.rooms.delete(r.code);
          ws.close(1000, "closed");
          return;
      }
    });
    ws.on("close", () => {
      clearTimeout(timer);
      if (!room || room.host !== ws) return;
      room.host = null;
      for (const p of room.publishers.values()) this.sendPublisher(p, { type: "status", state: "waiting_host" });
      this.scheduleIdle(room);
    });
    ws.on("error", () => ws.close());
  }

  private attachPublisher(ws: WebSocket, room: Room, key: string): void {
    this.alive(ws);
    for (const old of room.publishers.values()) if (old.key === key) this.kick(old, "You opened your camera somewhere else.");
    const p: Publisher = { id: this.nextId++, key, ws, hello: null, needKey: true, window: { start: this.now(), bytes: 0 } };
    room.publishers.set(p.id, p);
    if (room.idleTimer) clearTimeout(room.idleTimer);
    room.idleTimer = null;
    ws.on("message", (raw: RawData, isBinary) => {
      if (!isBinary) {
        if (p.hello) return;
        try {
          p.hello = CamHello.parse(JSON.parse(String(raw)));
        } catch {
          ws.close(4000, "bad hello");
          return;
        }
        this.sendPublisher(p, { type: "status", state: room.host ? "waiting_approval" : "waiting_host" });
        this.sendHost(room, { type: "join", id: p.id, key: p.key, hello: p.hello });
        return;
      }
      if (!p.hello || !room.host || room.host.readyState !== room.host.OPEN) return;
      const buf = raw instanceof Buffer ? raw : Buffer.concat(Array.isArray(raw) ? raw : [Buffer.from(raw as ArrayBuffer)]);
      const frame = decodeCamFrame(buf);
      if (!frame) return;
      // At most a few times the room's bitrate (a player can't flood the program).
      const now = this.now();
      if (now - p.window.start > 5000) p.window = { start: now, bytes: 0 };
      p.window.bytes += buf.byteLength;
      const allowed = ((room.quality.bitrateKbps * 1000) / 8) * 5 * BITRATE_SLACK;
      if (p.window.bytes > allowed) {
        p.needKey = true;
        return;
      }
      if (room.host.bufferedAmount > HOST_BACKLOG) p.needKey = true;
      if (p.needKey && !frame.key) return;
      p.needKey = false;
      const out = Buffer.allocUnsafe(4 + buf.byteLength);
      out.writeUInt32BE(p.id, 0);
      buf.copy(out, 4);
      room.host.send(out);
    });
    ws.on("close", () => {
      if (room.publishers.get(p.id) !== p) return;
      room.publishers.delete(p.id);
      if (p.hello) this.sendHost(room, { type: "leave", id: p.id, key: p.key });
      this.scheduleIdle(room);
    });
    ws.on("error", () => ws.close());
  }

  private kick(p: Publisher, reason: string): void {
    this.sendPublisher(p, { type: "kicked", reason });
    p.ws.close(4003, "kicked");
  }

  /** Players no longer in the match (the roster changed) are sent away. */
  private dropUnlisted(room: Room): void {
    const keys = new Set(room.roster.teams.flatMap((t) => t.players.map((p) => p.key)));
    for (const p of room.publishers.values()) if (!keys.has(p.key)) this.kick(p, "You are no longer listed in this match.");
  }

  private scheduleIdle(room: Room): void {
    if (room.host || room.publishers.size > 0 || room.idleTimer) return;
    room.idleTimer = setTimeout(() => {
      if (!room.host && room.publishers.size === 0 && this.rooms.get(room.code) === room) this.rooms.delete(room.code);
    }, IDLE_ROOM_MS);
    room.idleTimer.unref?.();
  }

  /** Rooms and players connected (health and tests). */
  stats(): { rooms: number; players: number } {
    let players = 0;
    for (const r of this.rooms.values()) players += r.publishers.size;
    return { rooms: this.rooms.size, players };
  }

  close(): void {
    clearInterval(this.pinger);
    for (const r of this.rooms.values()) if (r.idleTimer) clearTimeout(r.idleTimer);
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
    this.rooms.clear();
  }
}

