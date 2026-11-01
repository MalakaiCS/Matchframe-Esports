import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import type { Logger } from "../logger.ts";
import { PluginClock } from "./clock.ts";
import {
  decodeAudio,
  decodePong,
  encodeFrame,
  encodeManage,
  encodePing,
  encodeRecording,
  encodeWelcome,
  FrameReader,
  Hello,
  MsgType,
  parseJson,
  PluginEvent,
  PluginStats,
  WireError,
  type WireAudio,
} from "./wire.ts";

/**
 * The Team Comms bridge (ADR-065): a TCP server on 127.0.0.1 that the TeamSpeak plugin connects to.
 *
 * - **Security:** listens on the loopback address only and refuses any other peer; the first message
 *   must be HELLO with the token Matchframe generated (compared in constant time) within
 *   AUTH_TIMEOUT_MS, else ERROR and the connection is closed. At most MAX_SESSIONS plugins at once.
 * - **Validation:** the stream must be MFTC version 1 frames of at most 1 MiB (else ERROR and close:
 *   the stream can't be trusted); a message whose content is wrong (an AUDIO block with another
 *   format, rate, channel count or length, an event that doesn't match its schema) is dropped,
 *   counted and named in the status, and the plugin is told (at most every 5 s).
 * - **Bounds:** before HELLO at most 64 KiB is buffered; a half-received message is never larger than
 *   its checked length; what the engine sends a plugin is dropped (pings) or the connection closed
 *   (commands) when more than MAX_OUTBOUND bytes are waiting.
 * - **Reconnects:** a plugin that reconnects is a new session; the comms service re-binds its
 *   TeamSpeak tabs from the snapshot it sends (instance id, server, channel).
 */

const AUTH_TIMEOUT_MS = 3000;
const PRE_AUTH_BYTES = 64 * 1024;
const MAX_SESSIONS = 4;
const MAX_OUTBOUND = 1 << 20;
const PING_MS = 1000;
const ERROR_NOTICE_MS = 5000;

export interface BridgeHandlers {
  onSession(s: PluginSession): void;
  onClose(s: PluginSession, reason: string): void;
  onEvent(s: PluginSession, ev: PluginEvent): void;
  onAudio(s: PluginSession, a: WireAudio, arrivalMs: number): void;
  onStats(s: PluginSession, st: PluginStats): void;
}

export interface BridgeOptions {
  /** 0: any free port (tests). */
  port: number;
  token: () => string;
  /** The engine's timeline (ms, monotonic). */
  now: () => number;
  logger: Logger;
  handlers: BridgeHandlers;
  /** Clock pings to the plugin (ms; 0: none, the audio alone sets the clock — tests on a simulated clock). */
  pingMs?: number;
}

export interface SessionCounters {
  messages: number;
  bytes: number;
  audioFrames: number;
  audioSamples: number;
  events: number;
  invalid: number;
  /** Plugin AUDIO sequence numbers skipped (blocks lost between the plugin's queue and here). */
  sequenceGaps: number;
}

export class PluginSession {
  readonly id = randomUUID().slice(0, 8);
  readonly connectedAt: number;
  readonly clock = new PluginClock();
  hello: Hello | null = null;
  readonly counters: SessionCounters = { messages: 0, bytes: 0, audioFrames: 0, audioSamples: 0, events: 0, invalid: 0, sequenceGaps: 0 };
  lastError: { code: string; message: string; atMs: number } | null = null;
  lastStats: PluginStats | null = null;
  closed: string | null = null;
  private readonly reader = new FrameReader();
  private lastSeq: number | null = null;
  private lastNotice = -Infinity;
  private readonly pending = new Map<number, number>();

  constructor(
    private readonly socket: Socket,
    private readonly bridge: CommsBridge,
    now: number,
  ) {
    this.connectedAt = now;
  }

  get authenticated(): boolean {
    return this.hello !== null;
  }

  /** The plugin's TeamSpeak process (stable across reconnects of the same plugin), else this session. */
  get instance(): string {
    return this.hello?.instance || `session-${this.id}`;
  }

  /** Captures (or not) one TeamSpeak tab, keeps its microphone off and its sound silent. */
  manage(schid: number, m: { capture: boolean; listenOnly: boolean; suppressPlayback: boolean }): boolean {
    return this.send(encodeManage(schid, m), true);
  }

  /** TeamSpeak's own recording indicator on the managed tabs (others see the listener recording). */
  recording(on: boolean): boolean {
    return this.send(encodeRecording(on), true);
  }

  snapshot(): boolean {
    return this.send(encodeFrame(MsgType.SNAPSHOT), true);
  }

  ping(nowMs: number): void {
    const us = Math.round(nowMs * 1000);
    this.pending.set(us, nowMs);
    if (this.pending.size > 16) this.pending.delete(this.pending.keys().next().value!);
    this.send(encodePing(us), false);
  }

  close(reason: string, notify?: string): void {
    if (this.closed) return;
    this.closed = reason;
    if (notify) this.socket.write(encodeFrame(MsgType.ERROR, Buffer.from(notify, "utf8")));
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 500).unref();
  }

  /** Bytes waiting to be sent to the plugin. */
  get outbound(): number {
    return this.socket.writableLength;
  }

  private send(buf: Buffer, essential: boolean): boolean {
    if (this.closed) return false;
    if (this.socket.writableLength + buf.length > MAX_OUTBOUND) {
      if (essential) this.close("the plugin is not reading what Matchframe sends");
      return false;
    }
    this.socket.write(buf);
    return true;
  }

  /** @internal Bytes from the socket. */
  receive(chunk: Buffer, now: number): void {
    if (this.closed) return;
    this.counters.bytes += chunk.length;
    if (!this.authenticated && this.reader.pending + chunk.length > PRE_AUTH_BYTES) return this.close("too much before HELLO", "send HELLO first");
    let frames;
    try {
      frames = this.reader.push(chunk);
    } catch (e) {
      const err = e as WireError;
      this.noteError(err.code ?? "bad_stream", err.message, now);
      return this.close(`invalid stream: ${err.message}`, err.message);
    }
    // The clock first sees every block of what arrived together (a burst after a busy moment), so
    // the first of them isn't placed by an estimate the rest would correct.
    if (this.authenticated) for (const f of frames) if (f.type === MsgType.AUDIO && f.payload.length >= 16) this.clock.onAudio(Number(f.payload.readBigUInt64LE(8)), now);
    for (const f of frames) {
      if (this.closed) return;
      this.counters.messages++;
      if (!this.authenticated) {
        if (f.type !== MsgType.HELLO) return this.close("no HELLO", "send HELLO first");
        let hello: Hello;
        try {
          hello = parseJson(Hello, f.payload, "HELLO");
        } catch (e) {
          this.noteError("bad_hello", (e as Error).message, now);
          return this.close(`bad HELLO: ${(e as Error).message}`, (e as Error).message);
        }
        if (!this.bridge.checkToken(hello.token)) return this.close("wrong token", "unauthorized: the token in bridge.json does not match (Matchframe rotated it, or another Matchframe wrote it)");
        this.hello = { ...hello, token: "[redacted]" };
        this.socket.write(encodeWelcome());
        this.bridge.authenticated(this);
        continue;
      }
      try {
        this.handle(f.type, f.payload, now);
      } catch (e) {
        if (!(e instanceof WireError)) throw e;
        this.counters.invalid++;
        this.noteError(e.code, e.message, now);
        if (now - this.lastNotice >= ERROR_NOTICE_MS) {
          this.lastNotice = now;
          this.send(encodeFrame(MsgType.ERROR, Buffer.from(`dropped: ${e.message}`, "utf8")), false);
        }
      }
    }
  }

  private handle(type: MsgType, payload: Buffer, now: number): void {
    const h = this.bridge.handlers;
    switch (type) {
      case MsgType.AUDIO: {
        const a = decodeAudio(payload);
        if (this.lastSeq !== null) {
          const gap = (a.seq - this.lastSeq - 1) >>> 0;
          if (gap > 0 && gap < 1_000_000) this.counters.sequenceGaps += gap;
        }
        this.lastSeq = a.seq;
        this.counters.audioFrames++;
        this.counters.audioSamples += a.frames;
        h.onAudio(this, a, now);
        return;
      }
      case MsgType.EVENT:
        this.counters.events++;
        h.onEvent(this, parseJson(PluginEvent, payload, "EVENT"));
        return;
      case MsgType.STATS:
        this.lastStats = parseJson(PluginStats, payload, "STATS");
        h.onStats(this, this.lastStats);
        return;
      case MsgType.PONG: {
        const p = decodePong(payload);
        const sent = this.pending.get(p.engineUs);
        if (sent === undefined) return;
        this.pending.delete(p.engineUs);
        this.clock.onPong(sent, now, p.pluginUs);
        return;
      }
      case MsgType.HELLO:
        throw new WireError("bad_type", "HELLO sent twice");
      default:
        throw new WireError("bad_type", `message type 0x${type.toString(16)} is not sent by a plugin`);
    }
  }

  private noteError(code: string, message: string, now: number): void {
    this.lastError = { code, message, atMs: now };
  }
}

export interface BridgeStatus {
  state: "stopped" | "listening" | "error";
  port: number | null;
  error: string | null;
  sessions: number;
  refused: { auth: number; foreign: number; full: number };
}

export class CommsBridge {
  private server: Server | null = null;
  private readonly list = new Set<PluginSession>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private port: number | null = null;
  private error: string | null = null;
  private readonly refused = { auth: 0, foreign: 0, full: 0 };

  constructor(private readonly opts: BridgeOptions) {}

  get handlers(): BridgeHandlers {
    return this.opts.handlers;
  }

  /** Starts listening; resolves with the port, or rejects (port in use). */
  async start(): Promise<number> {
    if (this.server) return this.port!;
    const server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.opts.port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    }).catch((e: NodeJS.ErrnoException) => {
      this.error = e.code === "EADDRINUSE" ? `port ${this.opts.port} on 127.0.0.1 is used by another program` : e.message;
      throw new Error(this.error);
    });
    server.on("error", (e) => {
      this.error = e.message;
      this.opts.logger.error("team comms bridge error", { error: e.message });
    });
    this.server = server;
    this.port = (server.address() as { port: number }).port;
    this.error = null;
    const pingMs = this.opts.pingMs ?? PING_MS;
    if (pingMs > 0) {
      this.pingTimer = setInterval(() => {
        const now = this.opts.now();
        for (const s of this.list) if (s.authenticated) s.ping(now);
      }, pingMs);
      this.pingTimer.unref();
    }
    return this.port;
  }

  async stop(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const s of this.list) s.close("Matchframe stopped the bridge");
    const server = this.server;
    this.server = null;
    this.port = null;
    if (server) await new Promise<void>((r) => server.close(() => r()));
  }

  sessions(): PluginSession[] {
    return [...this.list].filter((s) => s.authenticated && !s.closed);
  }

  status(): BridgeStatus {
    return { state: this.server ? "listening" : this.error ? "error" : "stopped", port: this.port, error: this.error, sessions: this.sessions().length, refused: { ...this.refused } };
  }

  /** @internal */
  checkToken(token: string): boolean {
    const want = Buffer.from(this.opts.token());
    const got = Buffer.from(token);
    const ok = want.length > 0 && want.length === got.length && timingSafeEqual(want, got);
    if (!ok) this.refused.auth++;
    return ok;
  }

  /** @internal */
  authenticated(s: PluginSession): void {
    this.opts.logger.info("team comms plugin connected", { session: s.id, plugin: s.hello?.plugin, ts3: s.hello?.ts3, platform: s.hello?.platform });
    this.opts.handlers.onSession(s);
  }

  private accept(socket: Socket): void {
    const remote = socket.remoteAddress ?? "";
    if (remote !== "127.0.0.1" && remote !== "::ffff:127.0.0.1" && remote !== "::1") {
      this.refused.foreign++;
      socket.destroy();
      return;
    }
    if (this.list.size >= MAX_SESSIONS) {
      this.refused.full++;
      socket.end(encodeFrame(MsgType.ERROR, Buffer.from(`at most ${MAX_SESSIONS} TeamSpeak plugins at once`, "utf8")));
      return;
    }
    socket.setNoDelay(true);
    const s = new PluginSession(socket, this, this.opts.now());
    this.list.add(s);
    const auth = setTimeout(() => {
      if (!s.authenticated) s.close("no HELLO in time", "send HELLO first");
    }, AUTH_TIMEOUT_MS);
    auth.unref();
    socket.on("data", (chunk: Buffer) => s.receive(chunk, this.opts.now()));
    socket.on("error", () => undefined);
    socket.on("close", () => {
      clearTimeout(auth);
      this.list.delete(s);
      const reason = s.closed ?? "the plugin disconnected";
      s.closed = reason;
      if (s.authenticated) {
        this.opts.logger.warn("team comms plugin disconnected", { session: s.id, reason });
        this.opts.handlers.onClose(s, reason);
      }
    });
  }
}
