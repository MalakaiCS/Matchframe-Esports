import { z } from "zod";

/**
 * The Team Comms bridge's wire format (ADR-065): what the TeamSpeak plugin
 * (native/ts3-matchframe-plugin) and the engine send each other over TCP on 127.0.0.1.
 *
 * Every message is a 12-byte header and a payload:
 *   "MFTC" | version u8 (1) | type u8 | reserved u16 (0) | payload length u32 LE (at most 1 MiB)
 *
 * Plugin to engine: HELLO (JSON, first and only before WELCOME), EVENT (JSON), STATS (JSON, each
 * second), AUDIO (binary, below), PONG (u64 engine µs echoed, u64 plugin µs).
 * Engine to plugin: WELCOME (u16 protocol, u16 0, u32 0), ERROR (UTF-8 reason; the engine then
 * closes), MANAGE (u64 schid, u8 capture, u8 listenOnly, u8 suppressPlayback, u8 0), RECORDING
 * (u8 on, 3 × u8 0), SNAPSHOT (empty), PING (u64 engine µs).
 *
 * AUDIO payload (little-endian), one TeamSpeak playback callback for one speaker:
 *   0 u64 schid (the TeamSpeak tab) | 8 u64 capture time, plugin monotonic µs | 16 u32 sequence |
 *   20 u32 sample rate | 24 u32 frames (samples per channel) | 28 u16 client id (session) |
 *   30 u16 the listener's own client id | 32 u8 channels | 33 u8 format (1 = int16 LE) |
 *   34 u8 part of a split callback | 35 u8 identity length | 36 u32 flags (0) |
 *   40 identity (CLIENT_UNIQUE_IDENTIFIER, UTF-8) | then frames × channels int16 samples.
 */

export const PROTOCOL = 1;
export const HEADER_BYTES = 12;
export const MAX_PAYLOAD = 1 << 20;
export const AUDIO_HEADER_BYTES = 40;
/** At most this many samples (all channels) in one AUDIO message: the plugin's frame size. */
export const MAX_AUDIO_SAMPLES = 4096;
/** Sample rates accepted (TeamSpeak's playback is 48 kHz; the rest are converted). */
export const ACCEPTED_RATES = [8000, 12000, 16000, 24000, 32000, 44100, 48000] as const;

export const MsgType = {
  HELLO: 0x01,
  WELCOME: 0x02,
  EVENT: 0x03,
  AUDIO: 0x04,
  STATS: 0x05,
  PONG: 0x06,
  ERROR: 0x0f,
  MANAGE: 0x10,
  RECORDING: 0x11,
  SNAPSHOT: 0x12,
  PING: 0x13,
} as const;
export type MsgType = (typeof MsgType)[keyof typeof MsgType];
const KNOWN = new Set<number>(Object.values(MsgType));

/** A message the bridge could not accept: `code` names the rule broken. */
export class WireError extends Error {
  constructor(
    readonly code: "bad_magic" | "bad_version" | "bad_type" | "too_large" | "bad_length" | "bad_format" | "bad_rate" | "bad_channels" | "bad_frames" | "bad_identity" | "bad_json",
    message: string,
  ) {
    super(message);
  }
}

export interface Frame {
  type: MsgType;
  payload: Buffer;
}

/** Splits a byte stream into messages. Bounded: a message's declared length is checked before it is buffered. */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0);

  /** Bytes waiting for the rest of a message (for the bound and the diagnostics). */
  get pending(): number {
    return this.buf.length;
  }

  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: Frame[] = [];
    let off = 0;
    while (this.buf.length - off >= HEADER_BYTES) {
      const h = this.buf.subarray(off, off + HEADER_BYTES);
      if (h[0] !== 0x4d || h[1] !== 0x46 || h[2] !== 0x54 || h[3] !== 0x43) throw new WireError("bad_magic", "not a MatchFrame Team Comms message (no MFTC header)");
      if (h[4] !== PROTOCOL) throw new WireError("bad_version", `protocol version ${h[4]}, this MatchFrame speaks ${PROTOCOL}: update the TeamSpeak plugin`);
      const type = h[5]!;
      if (!KNOWN.has(type)) throw new WireError("bad_type", `unknown message type 0x${type.toString(16)}`);
      const len = h.readUInt32LE(8);
      if (len > MAX_PAYLOAD) throw new WireError("too_large", `message of ${len} bytes (at most ${MAX_PAYLOAD})`);
      if (this.buf.length - off < HEADER_BYTES + len) break;
      out.push({ type: type as MsgType, payload: this.buf.subarray(off + HEADER_BYTES, off + HEADER_BYTES + len) });
      off += HEADER_BYTES + len;
    }
    this.buf = off === this.buf.length ? Buffer.alloc(0) : this.buf.subarray(off);
    return out;
  }
}

export function encodeFrame(type: MsgType, payload: Buffer = Buffer.alloc(0)): Buffer {
  const h = Buffer.alloc(HEADER_BYTES);
  h.write("MFTC", 0, "latin1");
  h[4] = PROTOCOL;
  h[5] = type;
  h.writeUInt32LE(payload.length, 8);
  return Buffer.concat([h, payload]);
}

export const encodeJson = (type: MsgType, value: unknown) => encodeFrame(type, Buffer.from(JSON.stringify(value), "utf8"));

export function encodeWelcome(): Buffer {
  const p = Buffer.alloc(8);
  p.writeUInt16LE(PROTOCOL, 0);
  return encodeFrame(MsgType.WELCOME, p);
}

export function encodeManage(schid: number, m: { capture: boolean; listenOnly: boolean; suppressPlayback: boolean }): Buffer {
  const p = Buffer.alloc(12);
  p.writeBigUInt64LE(BigInt(schid), 0);
  p[8] = m.capture ? 1 : 0;
  p[9] = m.listenOnly ? 1 : 0;
  p[10] = m.suppressPlayback ? 1 : 0;
  return encodeFrame(MsgType.MANAGE, p);
}

export function encodeRecording(on: boolean): Buffer {
  const p = Buffer.alloc(4);
  p[0] = on ? 1 : 0;
  return encodeFrame(MsgType.RECORDING, p);
}

export function encodePing(engineUs: number): Buffer {
  const p = Buffer.alloc(8);
  p.writeBigUInt64LE(BigInt(Math.max(0, Math.round(engineUs))), 0);
  return encodeFrame(MsgType.PING, p);
}

export function decodePong(payload: Buffer): { engineUs: number; pluginUs: number } {
  if (payload.length < 16) throw new WireError("bad_length", "PONG shorter than 16 bytes");
  return { engineUs: Number(payload.readBigUInt64LE(0)), pluginUs: Number(payload.readBigUInt64LE(8)) };
}

/** One AUDIO message: one speaker's samples from one TeamSpeak callback. */
export interface WireAudio {
  schid: number;
  /** Plugin monotonic clock, µs, when TeamSpeak handed over these samples. */
  captureUs: number;
  seq: number;
  sampleRate: number;
  frames: number;
  clientId: number;
  ownClientId: number;
  channels: 1 | 2;
  part: number;
  /** The speaker's TeamSpeak unique identity (CLIENT_UNIQUE_IDENTIFIER). */
  uid: string;
  /** Interleaved samples (a copy, aligned). */
  pcm: Int16Array;
}

const UID = /^[\x21-\x7e]{1,64}$/;

/** Reads and checks an AUDIO payload: format, rate, channels, frames, identity and exact length. */
export function decodeAudio(p: Buffer): WireAudio {
  if (p.length < AUDIO_HEADER_BYTES) throw new WireError("bad_length", `AUDIO of ${p.length} bytes is shorter than its ${AUDIO_HEADER_BYTES}-byte header`);
  const sampleRate = p.readUInt32LE(20);
  const frames = p.readUInt32LE(24);
  const channels = p[32]!;
  const format = p[33]!;
  const uidLen = p[35]!;
  if (format !== 1) throw new WireError("bad_format", `sample format ${format}: only 1 (16-bit signed little-endian) is accepted`);
  if (!(ACCEPTED_RATES as readonly number[]).includes(sampleRate)) throw new WireError("bad_rate", `sample rate ${sampleRate} Hz: accepted ${ACCEPTED_RATES.join(", ")}`);
  if (channels !== 1 && channels !== 2) throw new WireError("bad_channels", `${channels} channels: 1 or 2 accepted`);
  if (frames < 1 || frames * channels > MAX_AUDIO_SAMPLES) throw new WireError("bad_frames", `${frames} frames of ${channels} channels (1 to ${MAX_AUDIO_SAMPLES / channels})`);
  const expected = AUDIO_HEADER_BYTES + uidLen + frames * channels * 2;
  if (p.length !== expected) throw new WireError("bad_length", `AUDIO of ${p.length} bytes, its header says ${expected}`);
  const uid = p.toString("utf8", AUDIO_HEADER_BYTES, AUDIO_HEADER_BYTES + uidLen);
  if (!UID.test(uid)) throw new WireError("bad_identity", "AUDIO without a valid TeamSpeak unique identity");
  const schid = p.readBigUInt64LE(0);
  const captureUs = p.readBigUInt64LE(8);
  if (schid > BigInt(Number.MAX_SAFE_INTEGER) || captureUs > BigInt(Number.MAX_SAFE_INTEGER)) throw new WireError("bad_length", "connection id or time out of range");
  const off = AUDIO_HEADER_BYTES + uidLen;
  const pcm = new Int16Array(frames * channels);
  for (let i = 0; i < pcm.length; i++) pcm[i] = p.readInt16LE(off + i * 2);
  return { schid: Number(schid), captureUs: Number(captureUs), seq: p.readUInt32LE(16), sampleRate, frames, clientId: p.readUInt16LE(28), ownClientId: p.readUInt16LE(30), channels, part: p[34]!, uid, pcm };
}

/** Builds an AUDIO payload (the plugin's layout): for tests and the stand-in plugin. */
export function encodeAudio(a: Omit<WireAudio, "frames"> & { frames?: number; format?: number }): Buffer {
  const uid = Buffer.from(a.uid, "utf8");
  const frames = a.frames ?? a.pcm.length / a.channels;
  const p = Buffer.alloc(AUDIO_HEADER_BYTES + uid.length + a.pcm.length * 2);
  p.writeBigUInt64LE(BigInt(a.schid), 0);
  p.writeBigUInt64LE(BigInt(Math.round(a.captureUs)), 8);
  p.writeUInt32LE(a.seq >>> 0, 16);
  p.writeUInt32LE(a.sampleRate, 20);
  p.writeUInt32LE(frames, 24);
  p.writeUInt16LE(a.clientId, 28);
  p.writeUInt16LE(a.ownClientId, 30);
  p[32] = a.channels;
  p[33] = a.format ?? 1;
  p[34] = a.part;
  p[35] = uid.length;
  uid.copy(p, AUDIO_HEADER_BYTES);
  for (let i = 0; i < a.pcm.length; i++) p.writeInt16LE(a.pcm[i]!, AUDIO_HEADER_BYTES + uid.length + i * 2);
  return encodeFrame(MsgType.AUDIO, p);
}

// ------------------------------------------------------------------------------------------------ JSON messages

export const Hello = z.object({
  token: z.string().min(1).max(256),
  protocol: z.literal(PROTOCOL),
  /** Random per TeamSpeak process: a reconnect of the same plugin keeps its connections. */
  instance: z.string().max(64).optional(),
  plugin: z.object({ name: z.string().max(80), version: z.string().max(40), apiVersion: z.number().int() }),
  ts3: z.object({ clientLibVersion: z.string().max(200), clientLibVersionNumber: z.number() }).partial().default({}),
  platform: z.string().max(20),
  clock: z.object({ nowUs: z.number().nonnegative() }),
  queue: z.object({ capacity: z.number().int(), maxFrameSamples: z.number().int() }).partial().optional(),
});
export type Hello = z.infer<typeof Hello>;

export const WireClient = z.object({
  clientId: z.number().int().min(0).max(65535),
  uid: z.string().max(64),
  nickname: z.string().max(200),
  channelId: z.number().int().nonnegative(),
});
export type WireClient = z.infer<typeof WireClient>;

const ConnectionEvent = z.object({
  type: z.literal("connection"),
  schid: z.number().int().positive(),
  reason: z.string().max(40),
  status: z.number().int().min(0).max(4),
  statusName: z.string().max(40),
  error: z.number().int().optional(),
  errorText: z.string().max(400).optional(),
  server: z.object({ uid: z.string().max(100), name: z.string().max(200), host: z.string().max(300), port: z.number().int().min(0).max(65535) }).optional(),
  self: z.object({ clientId: z.number().int(), uid: z.string().max(64), nickname: z.string().max(200), inputMuted: z.number().int(), inputDeactivated: z.number().int(), outputMuted: z.number().int(), recording: z.number().int() }).optional(),
  channel: z.object({ id: z.number().int().nonnegative(), name: z.string().max(200) }).optional(),
  managed: z.object({ capture: z.boolean(), listenOnly: z.boolean(), suppressPlayback: z.boolean() }),
  clients: z.array(WireClient).max(1024),
});
const ClientEvent = z.object({
  type: z.literal("client"),
  schid: z.number().int().positive(),
  change: z.enum(["enter", "leave", "update", "discovered"]),
  client: WireClient,
});
const TalkEvent = z.object({
  type: z.literal("talk"),
  schid: z.number().int().positive(),
  clientId: z.number().int(),
  talking: z.number().int(),
  whisper: z.number().int(),
  tUs: z.number().nonnegative(),
});
const SelfEvent = z.object({
  type: z.literal("self"),
  schid: z.number().int().positive(),
  flag: z.number().int(),
  old: z.string().max(40),
  new: z.string().max(40),
});
/** TeamSpeak refused something on a tab (the connection: identity already connected, flood prevention, password, ban). */
const ErrorEvent = z.object({
  type: z.literal("error"),
  schid: z.number().int().positive(),
  error: z.number().int(),
  message: z.string().max(400),
  extra: z.string().max(400),
  tUs: z.number().nonnegative(),
});
export const PluginEvent = z.discriminatedUnion("type", [ConnectionEvent, ClientEvent, TalkEvent, SelfEvent, ErrorEvent]);
export type PluginEvent = z.infer<typeof PluginEvent>;
export type ConnectionEvent = z.infer<typeof ConnectionEvent>;

const CallbackCounts = z.object({
  schid: z.number().int(),
  voiceCalls: z.number(),
  voiceSamples: z.number(),
  captured: z.number(),
  dropped: z.number(),
  zeroed: z.number(),
  badFormat: z.number(),
  mixedCalls: z.number(),
  mixedNonSilent: z.number(),
  mixedZeroed: z.number(),
  capturedSendBlocked: z.number(),
  lastChannels: z.number(),
  lastSampleCount: z.number(),
  managed: z.number(),
});
export const PluginStats = z.object({
  type: z.literal("stats"),
  tUs: z.number(),
  queue: z.object({ capacity: z.number(), depth: z.number(), maxDepth: z.number(), dropped: z.number() }),
  sent: z.object({ frames: z.number(), bytes: z.number() }),
  discardedOffline: z.number(),
  unknownClient: z.number(),
  otherChannel: z.number(),
  identityLookups: z.number(),
  recording: z.boolean(),
  connections: z.array(CallbackCounts).max(64),
});
export type PluginStats = z.infer<typeof PluginStats>;

export function parseJson<T>(schema: z.ZodType<T>, payload: Buffer, what: string): T {
  let raw: unknown;
  try {
    raw = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new WireError("bad_json", `${what}: not JSON`);
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new WireError("bad_json", `${what}: ${r.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}`);
  return r.data;
}
