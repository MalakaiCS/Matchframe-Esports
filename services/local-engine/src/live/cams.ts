import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { CAM_QUALITY_PRESETS, CAM_ROOM_RE, decodeCamFrame, type CamHello, type CamHostMessage, type CamPlayerStatus, type CamRelayMessage, type CamRoster } from "@matchframe/cloud-contracts";
import type { SettingsRepo } from "../db/store.ts";
import type { Logger } from "../logger.ts";

/**
 * Player cams (ADR-048), the program's side. While switched on and signed in, the program hosts a
 * room on the Matchframe website (`/v1/cams/host`); players open the room's link, pick themselves
 * and send their camera, and the website relays the encoded video here. Each player's video is
 * kept in a buffer and played out `delayMs` later (to match a CSTV delay), to:
 * - HUDs (LHM-format HUDs through their camera protocol, Matchframe HUDs) and the OBS cam pages, over
 *   `/cams-ws` on the HUD server: only cams that are on air (approved and not hidden), delayed;
 * - the operator's Player cams screen, over `/api/v1/cams/ws`: every cam, as it arrives.
 * Local consumers decode with WebCodecs (hud-runtime cams.js).
 */

export const CamSettings = z.object({
  enabled: z.boolean().default(false),
  /** The room code in the link players open; a new one makes the old link stop working. */
  room: z.string().regex(CAM_ROOM_RE).nullable().default(null),
  /** How long after it arrives a cam is shown (ms): the CSTV delay, so faces match the game. */
  delayMs: z.number().int().min(0).max(300_000).default(0),
  quality: z.enum(["low", "standard", "high"]).default("standard"),
  /** A cam goes on air as soon as it arrives; off: the operator approves each one. */
  autoApprove: z.boolean().default(true),
  /** Players whose cam the operator took off air (SteamIDs). */
  hidden: z.array(z.string()).default([]),
});
export type CamSettings = z.infer<typeof CamSettings>;
const SETTINGS_KEY = "cams";
const TOKEN_KEY = "cams.token";

/** A roster entry the program knows: SteamID, name, team. */
export interface CamRosterSource {
  title: string;
  teams: { name: string; players: { steamId: string; name: string }[] }[];
}

export type CamState = "offline" | "waiting_approval" | "live" | "hidden";

export interface CamPlayerView {
  steamId: string;
  name: string;
  team: string;
  state: CamState;
  /** Shown in HUDs and OBS pages right now (approved, not hidden, video still playing out). */
  onAir: boolean;
  camera: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  kbps: number;
  /** Seconds of video buffered for the delay. */
  bufferedSec: number;
}

export interface CamStatus {
  enabled: boolean;
  signedIn: boolean;
  websiteConnected: boolean;
  /** The link to send players (null while switched off or signed out). */
  link: string | null;
  delayMs: number;
  quality: CamSettings["quality"];
  autoApprove: boolean;
  error: string | null;
  players: CamPlayerView[];
  /** OBS browser source addresses: the observed player's cam, and one player's (replace STEAMID). */
  outputs: { observed: string; player: string } | null;
}

interface Frame {
  tsUs: number;
  key: boolean;
  data: Buffer;
  at: number;
}

interface Stream {
  id: number;
  steamId: string;
  hello: CamHello;
  connected: boolean;
  frames: Frame[];
  /** Index of the next frame to play out (delayed). */
  next: number;
  /** arrival ms − capture ms: the smallest seen recently (the least-delayed frames). */
  win: { start: number; min: number; prev: number | null } | null;
  bytes: { at: number; n: number }[];
}

interface Consumer {
  ws: WebSocket;
  /** The operator's preview: every cam, as it arrives. HUDs and OBS pages: on-air cams, delayed. */
  all: boolean;
  players: Set<string> | null;
  started: Set<string>;
  lastList: string;
}

/** Delay buffers keep this much more than the delay. */
const KEEP_EXTRA_MS = 20_000;
const TICK_MS = 10;
const RECONNECT_MAX_MS = 30_000;

export class CamHub {
  private ws: WebSocket | null = null;
  private connecting = false;
  private websiteConnected = false;
  private lastError: string | null = null;
  private retryMs = 2000;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly streams = new Map<string, Stream>();
  private readonly byId = new Map<number, Stream>();
  /** Approved this session (by SteamID), kept when a player reconnects. */
  private readonly approved = new Set<string>();
  private rosterSig = "";
  private keyToSteam = new Map<string, { steamId: string; name: string; team: string }>();
  private rosterNames = new Map<string, { name: string; team: string }>();
  private readonly consumers = new Set<Consumer>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private readonly listeners = new Set<() => void>();
  private observed: string | null = null;
  private onAirSig = "";
  private readonly ticker: ReturnType<typeof setInterval>;
  private readonly slow: ReturnType<typeof setInterval>;

  constructor(
    private readonly deps: {
      settings: SettingsRepo;
      logger: Pick<Logger, "info" | "warn">;
      /** The website and this computer's credential, or null when signed out. */
      credentials: () => { url: string; token: string; appVersion: string } | null;
      /** The match being played: teams and players with SteamIDs. */
      roster: () => CamRosterSource;
      /** The player the game shows now (SteamID), for the observed-cam page. */
      observed: () => string | null;
      overlayPort: () => number;
      now?: () => number;
      connect?: (url: string, headers: Record<string, string>) => WebSocket;
    },
  ) {
    this.ticker = setInterval(() => this.tick(), TICK_MS);
    this.ticker.unref?.();
    this.slow = setInterval(() => this.housekeep(), 1000);
    this.slow.unref?.();
    this.apply();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Kept in memory: read for every frame. */
  private cfg: CamSettings | null = null;

  settings(): CamSettings {
    if (!this.cfg) {
      const r = CamSettings.safeParse(this.deps.settings.get(SETTINGS_KEY, {}));
      this.cfg = r.success ? r.data : CamSettings.parse({});
    }
    return this.cfg;
  }

  private save(next: CamSettings): void {
    this.cfg = next;
    this.deps.settings.set(SETTINGS_KEY, next);
  }

  /** The token OBS cam pages and Matchframe's own pages use on `/cams-ws`. */
  token(): string {
    let t = this.deps.settings.get<string | null>(TOKEN_KEY, null);
    if (!t) {
      t = randomBytes(24).toString("hex");
      this.deps.settings.set(TOKEN_KEY, t);
    }
    return t;
  }

  checkToken(given: string | null): boolean {
    return !!given && given === this.token();
  }

  setSettings(patch: Partial<Pick<CamSettings, "enabled" | "delayMs" | "quality" | "autoApprove">>): CamStatus {
    const prev = this.settings();
    const next = CamSettings.parse({ ...prev, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) });
    if (next.enabled && !next.room) next.room = newRoom();
    this.save(next);
    if (prev.delayMs !== next.delayMs) this.resync();
    if (prev.quality !== next.quality) this.send({ type: "quality", quality: CAM_QUALITY_PRESETS[next.quality] });
    if (!prev.autoApprove && next.autoApprove) for (const s of this.streams.values()) this.approve(s.steamId, false);
    if (prev.enabled && !next.enabled) this.closeRoom();
    this.apply();
    this.changed();
    return this.status();
  }

  /** A new link: players on the old one are sent away and must open the new one. */
  newLink(): CamStatus {
    const s = this.settings();
    this.closeRoom();
    this.save({ ...s, room: newRoom() });
    this.apply();
    this.changed();
    return this.status();
  }

  approve(steamId: string, notify = true): void {
    this.approved.add(steamId);
    const s = this.streams.get(steamId);
    if (s?.connected) this.sendStatus(s);
    if (notify) this.changed();
  }

  setHidden(steamId: string, hidden: boolean): void {
    const s = this.settings();
    const set = new Set(s.hidden);
    if (hidden) set.add(steamId);
    else set.delete(steamId);
    this.save({ ...s, hidden: [...set] });
    const st = this.streams.get(steamId);
    if (st?.connected) this.sendStatus(st);
    this.changed();
  }

  kick(steamId: string, reason = "The production stopped your camera."): void {
    const s = this.streams.get(steamId);
    this.approved.delete(steamId);
    if (s?.connected) this.send({ type: "kick", id: s.id, reason });
    this.changed();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** SteamIDs whose cam is on air (HUDs show them). */
  onAir(): string[] {
    return [...this.streams.values()].filter((s) => this.isOnAir(s)).map((s) => s.steamId);
  }

  /** The players a HUD can have a cam for (the match's roster). */
  rosterPlayers(): { steamId: string; name: string }[] {
    return [...this.rosterNames].map(([steamId, v]) => ({ steamId, name: v.name }));
  }

  status(): CamStatus {
    const s = this.settings();
    const creds = this.deps.credentials();
    const port = this.deps.overlayPort();
    return {
      enabled: s.enabled,
      signedIn: !!creds,
      websiteConnected: this.websiteConnected,
      link: s.enabled && creds && s.room ? `${creds.url.replace(/\/+$/, "")}/cam/${s.room}` : null,
      delayMs: s.delayMs,
      quality: s.quality,
      autoApprove: s.autoApprove,
      error: this.lastError,
      players: this.views(),
      outputs: port ? { observed: `http://127.0.0.1:${port}/cams/observed?t=${this.token()}`, player: `http://127.0.0.1:${port}/cams/player/STEAMID?t=${this.token()}` } : null,
    };
  }

  // ------------------------------------------------------------------ website connection

  private apply(): void {
    const s = this.settings();
    const creds = this.deps.credentials();
    if (!s.enabled || !creds) {
      if (this.ws) this.ws.close(1000, "off");
      return;
    }
    if (this.ws || this.connecting || this.retryTimer) return;
    this.connectNow(creds, s);
  }

  private connectNow(creds: { url: string; token: string; appVersion: string }, s: CamSettings): void {
    this.connecting = true;
    const url = `${creds.url.replace(/\/+$/, "").replace(/^http/, "ws")}/v1/cams/host`;
    const headers = { authorization: `Bearer ${creds.token}`, "x-matchframe-version": creds.appVersion };
    let ws: WebSocket;
    try {
      ws = this.deps.connect ? this.deps.connect(url, headers) : new WebSocket(url, { headers, maxPayload: 1024 * 1024 });
    } catch (e) {
      this.connecting = false;
      this.lastError = `couldn't connect to the website: ${e instanceof Error ? e.message : String(e)}`;
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.on("open", () => {
      this.connecting = false;
      const room = s.room ?? newRoom();
      if (!s.room) this.save({ ...this.settings(), room });
      this.rosterSig = "";
      const roster = this.buildRoster(room);
      this.rosterSig = JSON.stringify(roster);
      ws.send(JSON.stringify({ type: "open", room, roster, quality: CAM_QUALITY_PRESETS[this.settings().quality] } satisfies CamHostMessage));
    });
    ws.on("message", (raw, isBinary) => (isBinary ? this.onVideo(raw as Buffer) : this.onText(String(raw))));
    ws.on("unexpected-response", (_req, res) => {
      this.lastError = res.statusCode === 401 ? "the website didn't accept this computer: sign in again in Settings → Account" : `the website answered ${res.statusCode}`;
    });
    ws.on("error", (e) => {
      if (!this.lastError) this.lastError = `website connection: ${e.message}`;
    });
    ws.on("close", (code) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.connecting = false;
      this.websiteConnected = false;
      for (const st of this.streams.values()) st.connected = false;
      this.changed();
      if (code === 4009) {
        // The code is someone else's (practically impossible): a new link.
        this.save({ ...this.settings(), room: newRoom() });
      }
      this.scheduleRetry();
    });
  }

  private scheduleRetry(): void {
    const s = this.settings();
    if (!s.enabled || this.retryTimer) return;
    const ms = this.retryMs;
    this.retryMs = Math.min(RECONNECT_MAX_MS, this.retryMs * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.apply();
    }, ms);
    this.retryTimer.unref?.();
  }

  private send(msg: CamHostMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private closeRoom(): void {
    this.send({ type: "close" });
    this.ws?.close(1000, "closed");
    this.ws = null;
    this.websiteConnected = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    for (const s of this.streams.values()) s.connected = false;
  }

  private onText(text: string): void {
    let m: CamRelayMessage;
    try {
      m = JSON.parse(text) as CamRelayMessage;
    } catch {
      return;
    }
    if (m.type === "opened") {
      this.websiteConnected = true;
      this.lastError = null;
      this.retryMs = 2000;
      this.deps.logger.info("player cams: room open on the website");
      this.changed();
    } else if (m.type === "error") {
      this.lastError = m.message;
    } else if (m.type === "join") {
      const who = this.keyToSteam.get(m.key);
      if (!who) return this.send({ type: "kick", id: m.id, reason: "You are not listed in this match." });
      const old = this.streams.get(who.steamId);
      if (old) this.byId.delete(old.id);
      const s: Stream = { id: m.id, steamId: who.steamId, hello: m.hello, connected: true, frames: [], next: 0, win: null, bytes: [] };
      if (this.settings().autoApprove) this.approved.add(who.steamId);
      this.streams.set(who.steamId, s);
      this.byId.set(m.id, s);
      this.sendStatus(s);
      this.deps.logger.info("player cam connected", { player: who.name, camera: m.hello.camera ?? null });
      this.changed();
    } else if (m.type === "leave") {
      const s = this.byId.get(m.id);
      if (s) s.connected = false;
      this.changed();
    }
  }

  private sendStatus(s: Stream): void {
    const st = this.state(s);
    if (st !== "offline") this.send({ type: "status", id: s.id, state: st as CamPlayerStatus });
  }

  private state(s: Stream | undefined): CamState {
    if (!s?.connected) return "offline";
    if (!this.approved.has(s.steamId)) return "waiting_approval";
    return this.settings().hidden.includes(s.steamId) ? "hidden" : "live";
  }

  private isOnAir(s: Stream): boolean {
    return this.approved.has(s.steamId) && !this.settings().hidden.includes(s.steamId) && (s.connected || s.next < s.frames.length);
  }

  // ------------------------------------------------------------------ video

  private onVideo(buf: Buffer): void {
    if (buf.byteLength < 5) return;
    const s = this.byId.get(buf.readUInt32BE(0));
    if (!s) return;
    const f = decodeCamFrame(new Uint8Array(buf.buffer, buf.byteOffset + 4, buf.byteLength - 4));
    if (!f) return;
    const at = this.now();
    const frame: Frame = { tsUs: f.timestampUs, key: f.key, data: Buffer.from(f.data), at };
    const o = at - f.timestampUs / 1000;
    if (!s.win || at - s.win.start > 20_000) s.win = { start: at, min: o, prev: s.win?.min ?? null };
    else s.win.min = Math.min(s.win.min, o);
    s.frames.push(frame);
    s.bytes.push({ at, n: buf.byteLength });
    // The operator's preview gets it now.
    this.deliver(s, frame, true);
  }

  private offset(s: Stream): number | null {
    if (!s.win) return null;
    return s.win.prev === null ? s.win.min : Math.min(s.win.min, s.win.prev);
  }

  /** Plays out the frames that are due (delayed consumers), and follows the observed player at once. */
  private tick(): void {
    if (this.consumers.size > 0) this.checkObserved();
    if (this.streams.size === 0) return;
    const now = this.now();
    const delay = this.settings().delayMs;
    for (const s of this.streams.values()) {
      const off = this.offset(s);
      if (off === null) continue;
      while (s.next < s.frames.length) {
        const f = s.frames[s.next]!;
        if (f.tsUs / 1000 + off + delay > now) break;
        s.next++;
        this.deliver(s, f, false);
      }
    }
  }

  /** After a delay change: the playout restarts at the frame that is due now, from a keyframe. */
  private resync(): void {
    const now = this.now();
    const delay = this.settings().delayMs;
    for (const s of this.streams.values()) {
      const off = this.offset(s);
      if (off === null) continue;
      let i = s.frames.findIndex((f) => f.tsUs / 1000 + off + delay > now);
      if (i < 0) i = s.frames.length;
      s.next = i;
    }
    for (const c of this.consumers) if (!c.all) c.started.clear();
  }

  private deliver(s: Stream, f: Frame, live: boolean): void {
    if (this.consumers.size === 0) return;
    const onAir = this.isOnAir(s);
    let msg: Buffer | null = null;
    for (const c of this.consumers) {
      if (c.all !== live) continue;
      if (!c.all && !onAir) continue;
      if (c.players && !c.players.has(s.steamId)) continue;
      if (!c.started.has(s.steamId)) {
        if (!f.key) continue;
        c.started.add(s.steamId);
      }
      if (c.ws.bufferedAmount > 4 * 1024 * 1024) {
        c.started.delete(s.steamId);
        continue;
      }
      msg ??= frameMessage(s.steamId, f, s.hello);
      c.ws.send(msg);
    }
  }

  private housekeep(): void {
    const now = this.now();
    const delay = this.settings().delayMs;
    for (const s of this.streams.values()) {
      // Older than the delay needs: dropped (never what is still to play).
      let drop = 0;
      while (drop < s.next && s.frames[drop]!.at < now - delay - KEEP_EXTRA_MS) drop++;
      if (drop > 0) {
        s.frames.splice(0, drop);
        s.next -= drop;
      }
      while (s.bytes.length && now - s.bytes[0]!.at > 3000) s.bytes.shift();
      // Gone and played out: forgotten.
      if (!s.connected && s.next >= s.frames.length && (s.frames.at(-1)?.at ?? 0) < now - 5000) {
        this.streams.delete(s.steamId);
        this.byId.delete(s.id);
      }
    }
    // The roster: the match's players (sent to the website when it changes).
    const room = this.settings().room;
    if (room && this.ws?.readyState === WebSocket.OPEN) {
      const roster = this.buildRoster(room);
      const sig = JSON.stringify(roster);
      if (sig !== this.rosterSig) {
        this.rosterSig = sig;
        this.send({ type: "roster", roster });
      }
    } else if (room) this.buildRoster(room);
    this.checkObserved();
    this.apply();
    this.changed();
  }

  private buildRoster(room: string): CamRoster {
    const src = this.deps.roster();
    const keys = new Map<string, { steamId: string; name: string; team: string }>();
    const names = new Map<string, { name: string; team: string }>();
    const teams = src.teams.slice(0, 2).map((t) => ({
      name: t.name.slice(0, 64),
      players: t.players.slice(0, 12).map((p) => {
        const key = playerKey(room, p.steamId);
        keys.set(key, { steamId: p.steamId, name: p.name, team: t.name });
        names.set(p.steamId, { name: p.name, team: t.name });
        return { key, name: (p.name || p.steamId).slice(0, 64) };
      }),
    }));
    this.keyToSteam = keys;
    this.rosterNames = names;
    return { title: src.title.slice(0, 120), teams };
  }

  private views(): CamPlayerView[] {
    const now = this.now();
    const out: CamPlayerView[] = [];
    const seen = new Set<string>();
    const view = (steamId: string, name: string, team: string): CamPlayerView => {
      const s = this.streams.get(steamId);
      const buffered = s && s.frames.length > s.next ? (s.frames.at(-1)!.tsUs - s.frames[s.next]!.tsUs) / 1e6 : 0;
      return {
        steamId,
        name,
        team,
        state: this.state(s),
        onAir: !!s && this.isOnAir(s),
        camera: s?.hello.camera ?? null,
        width: s?.hello.width ?? null,
        height: s?.hello.height ?? null,
        fps: s?.hello.fps ?? null,
        kbps: s ? Math.round((s.bytes.filter((b) => now - b.at <= 3000).reduce((a, b) => a + b.n, 0) * 8) / 3000) : 0,
        bufferedSec: Math.round(buffered * 10) / 10,
      };
    };
    for (const [steamId, v] of this.rosterNames) {
      seen.add(steamId);
      out.push(view(steamId, v.name, v.team));
    }
    for (const s of this.streams.values()) if (!seen.has(s.steamId)) out.push(view(s.steamId, s.steamId, ""));
    return out;
  }

  private changed(): void {
    const sig = this.onAir().sort().join(",");
    const onAirChanged = sig !== this.onAirSig;
    this.onAirSig = sig;
    for (const c of this.consumers) this.sendList(c);
    if (onAirChanged) for (const c of this.consumers) if (!c.all) for (const id of [...c.started]) if (!sig.split(",").includes(id)) c.started.delete(id);
    for (const fn of this.listeners) fn();
  }

  // ------------------------------------------------------------------ local consumers

  /** `/cams-ws` (HUD server; on-air cams, delayed) or `/api/v1/cams/ws` (operator; every cam, live). */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, opts: { all: boolean }): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const c: Consumer = { ws, all: opts.all, players: null, started: new Set(), lastList: "" };
      this.consumers.add(c);
      ws.on("message", (raw, isBinary) => {
        if (isBinary) return;
        try {
          const m = JSON.parse(String(raw)) as { type?: string; players?: unknown };
          if (m.type === "sub") {
            c.players = Array.isArray(m.players) ? new Set(m.players.filter((x): x is string => typeof x === "string").slice(0, 32)) : null;
            c.started.clear();
            // The operator's preview starts at once: ask the players for a keyframe.
            if (c.all) for (const s of this.streams.values()) if (s.connected) this.send({ type: "key", id: s.id });
          }
        } catch {
          // ignored
        }
      });
      ws.on("close", () => this.consumers.delete(c));
      ws.on("error", () => ws.close());
      this.sendList(c);
      if (!c.all) {
        this.checkObserved();
        ws.send(JSON.stringify({ type: "observed", steamId: this.observed }));
      }
    });
  }

  private sendList(c: Consumer): void {
    const list = c.all ? this.views() : this.views().map((v) => ({ steamId: v.steamId, name: v.name, onAir: v.onAir, width: v.width, height: v.height }));
    const text = JSON.stringify({ type: "cams", delayMs: this.settings().delayMs, list });
    if (text === c.lastList || c.ws.readyState !== WebSocket.OPEN) return;
    c.lastList = text;
    c.ws.send(text);
  }

  /** The observed-cam page switches with the observer (the game data is as delayed as the picture). */
  private checkObserved(): void {
    const obs = this.deps.observed();
    if (obs === this.observed) return;
    this.observed = obs;
    this.broadcastObserved();
  }

  private broadcastObserved(): void {
    const text = JSON.stringify({ type: "observed", steamId: this.observed });
    for (const c of this.consumers) if (!c.all && c.ws.readyState === WebSocket.OPEN) c.ws.send(text);
  }

  close(): void {
    clearInterval(this.ticker);
    clearInterval(this.slow);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close(1000, "program closing");
    this.ws = null;
    for (const c of this.consumers) c.ws.terminate();
    this.wss.close();
  }
}

/** A room code: 20 lowercase letters and digits (about 100 bits). */
export function newRoom(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(20);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

/** The opaque key a player is listed under on the cam page (the SteamID never leaves the program). */
export function playerKey(room: string, steamId: string): string {
  return createHash("sha256").update(`${room}:${steamId}`).digest("hex").slice(0, 12);
}

/** Local binary message: header length, a JSON header (player, keyframe, capture time, size), the encoded frame. */
export function frameMessage(steamId: string, f: { tsUs: number; key: boolean; data: Buffer }, hello: CamHello): Buffer {
  const header = Buffer.from(JSON.stringify({ s: steamId, k: f.key ? 1 : 0, t: f.tsUs, w: hello.width, h: hello.height, c: hello.codec }));
  return Buffer.concat([Buffer.from([header.byteLength]), header, f.data]);
}
