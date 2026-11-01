/**
 * Team Comms' NDI output process (ADR-066), forked by comms/outputs.ts like the replay feed's process:
 * the NDI binding (grandi, a native module with the NDI runtime) is loaded here only, and a stall in
 * NDI or in this process can't hold up the engine.
 *
 * Two audio-only NDI senders: "MatchFrame Comms" (the public mix, for the program's audio in OBS) and
 * "MatchFrame Comms Recording" (the recording mix, for the dedicated recording). The engine sends
 * every 10 ms block of both mixes with where it sits on the engine's timeline (its wall time). Each
 * block goes out a fixed `latencyMs` after its own time, as 48 kHz stereo 32-bit float (FLTp, the
 * mix on both channels), 480 samples a frame:
 *
 * - a block not here when its turn comes (the engine was busy) goes out as silence, and the block
 *   is dropped when it comes (late): never stale, repeated or reordered audio;
 * - this process behind by more than RESYNC_MS (it stalled) skips ahead to its time;
 * - the engine's silence when the public gate is closed is sent as it is (zeros), so OBS's
 *   "MatchFrame Comms" source is silent because Matchframe sends silence, not because OBS mutes it;
 * - each frame carries its own time as its NDI timecode (100 ns units of wall time), so a receiver
 *   that times by timecode is exact even if a send leaves a little late.
 *
 * Sends are paced on the engine's clock by default. NDI's own clocking (clockAudio) is a setting: on
 * the test machine it ran 0.09 % slow (99.91 frames a second), so the latency crept up until a resync.
 *
 * Written without TypeScript-only syntax (no enums or parameter properties) so Node runs it as is in
 * development; the program bundles it (apps/desktop/scripts-build.mjs).
 */

export const RATE = 48_000;
export const FRAME = 480;
const RESYNC_MS = 120;
const MAX_QUEUE = 300;
/** grandi's FourCC.FLTp (planar 32-bit float): the only audio format NDI sends. */
const FOURCC_FLTP = 1884572742;

export interface NdiStartOptions {
  publicName: string;
  recordingName: string;
  /** How long after its own time a block goes out (ms): the room for the engine's jitter. */
  latencyMs: number;
  /** Let NDI clock the sends as well (grandi's clockAudio). */
  clockAudio: boolean;
}

export type NdiRequest = { type: "start"; options: NdiStartOptions } | { type: "block"; start: number; wallMs: number; pub: Float32Array; rec: Float32Array } | { type: "stop" };

export interface NdiStats {
  /** Frames sent by each sender (the same count: they go out together). */
  frames: number;
  /** Slots sent as silence: the engine's block wasn't here in time. */
  underruns: number;
  /** Blocks that came after their slot (dropped). */
  late: number;
  /** Times this process was behind and skipped ahead. */
  resyncs: number;
  /** Public frames that were all zeros (the gate closed, or nothing permitted to say). */
  publicSilent: number;
  queue: number;
  /** How far behind its own time the last frame went out (ms), and the extremes over the last second. */
  lagMs: number;
  lagMinMs: number;
  lagMaxMs: number;
  /** Longest a send took over the last second (ms). */
  sendMaxMs: number;
  /** NDI receivers connected to each sender (DistroAV in OBS is one). */
  connections: { public: number; recording: number };
}

export type NdiReply = { type: "status"; state: "running" | "error" | "stopped"; ndi: string | null; error: string | null } | { type: "stats"; stats: NdiStats };

export interface NdiAudioFrameOut {
  sampleRate: number;
  channels: number;
  samples: number;
  channelStrideBytes: number;
  data: Buffer;
  fourCC: number;
  /** 100 ns units. */
  timecode?: bigint;
}

export interface NdiSenderLike {
  audio(frame: NdiAudioFrameOut): Promise<void>;
  connections(): number;
  destroy(): boolean;
}

export interface NdiSendModule {
  version(): string;
  send(params: { name: string; clockAudio?: boolean; clockVideo?: boolean }): Promise<NdiSenderLike>;
  FourCC?: { FLTp?: number };
}

const wallNow = () => performance.timeOrigin + performance.now();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A 10 ms mono block as an NDI stereo FLTp frame (the mix on both channels). */
export function stereoFrame(block: Float32Array | null, fourCC: number, wallMs?: number): NdiAudioFrameOut {
  const data = Buffer.alloc(FRAME * 2 * 4);
  if (block) {
    const f = new Float32Array(data.buffer, data.byteOffset, FRAME * 2);
    f.set(block.subarray(0, FRAME), 0);
    f.set(block.subarray(0, FRAME), FRAME);
  }
  const frame: NdiAudioFrameOut = { sampleRate: RATE, channels: 2, samples: FRAME, channelStrideBytes: FRAME * 4, data, fourCC };
  if (wallMs !== undefined) frame.timecode = BigInt(Math.round(wallMs * 10_000));
  return frame;
}

const allZero = (b: Float32Array | null) => {
  if (!b) return true;
  for (let i = 0; i < b.length; i++) if (b[i] !== 0) return false;
  return true;
};

export class CommsNdiOutput {
  private readonly queue = new Map<number, { pub: Float32Array; rec: Float32Array }>();
  private origin: { start: number; wall: number } | null = null;
  private cursor: number | null = null;
  private stopped = false;
  private pub: NdiSenderLike | null = null;
  private rec: NdiSenderLike | null = null;
  private fourCC = FOURCC_FLTP;
  private lastStats = 0;
  private window = { lagMin: Infinity, lagMax: -Infinity, sendMax: 0 };
  readonly stats: NdiStats = { frames: 0, underruns: 0, late: 0, resyncs: 0, publicSilent: 0, queue: 0, lagMs: 0, lagMinMs: 0, lagMaxMs: 0, sendMaxMs: 0, connections: { public: 0, recording: 0 } };
  private readonly ndi: NdiSendModule;
  private readonly o: NdiStartOptions;
  private readonly emit: (r: NdiReply) => void;
  private readonly now: () => number;

  constructor(ndi: NdiSendModule, o: NdiStartOptions, emit: (r: NdiReply) => void, now: () => number = wallNow) {
    this.ndi = ndi;
    this.o = o;
    this.emit = emit;
    this.now = now;
  }

  async open(): Promise<void> {
    this.fourCC = this.ndi.FourCC?.FLTp ?? FOURCC_FLTP;
    this.pub = await this.ndi.send({ name: this.o.publicName, clockAudio: this.o.clockAudio, clockVideo: false });
    this.rec = await this.ndi.send({ name: this.o.recordingName, clockAudio: this.o.clockAudio, clockVideo: false });
  }

  push(start: number, wallMs: number, pub: Float32Array, rec: Float32Array): void {
    if (!this.origin) this.origin = { start, wall: wallMs - start / (RATE / 1000) };
    if (this.cursor !== null && start < this.cursor) {
      this.stats.late++;
      return;
    }
    this.queue.set(start, { pub, rec });
    if (this.queue.size > MAX_QUEUE) {
      const oldest = Math.min(...this.queue.keys());
      this.queue.delete(oldest);
      this.stats.late++;
    }
  }

  stop(): void {
    this.stopped = true;
  }

  /** The wall time (ms) of a timeline sample, as the engine gave it. */
  private wallOf(start: number): number {
    return this.origin!.wall + start / (RATE / 1000);
  }

  async run(): Promise<void> {
    try {
      while (!this.stopped) {
        if (this.cursor === null) {
          if (this.queue.size === 0) {
            await sleep(5);
            this.report();
            continue;
          }
          this.cursor = Math.min(...this.queue.keys());
        }
        const due = this.wallOf(this.cursor) + this.o.latencyMs;
        const wait = due - this.now();
        if (wait > 0.5) {
          await sleep(Math.min(Math.max(1, wait - 0.5), 20));
          continue;
        }
        if (-wait > RESYNC_MS) {
          // Behind (this process stalled): skip to the block that is due now.
          const skip = Math.floor(-wait / 10) * FRAME;
          this.cursor += skip;
          this.stats.resyncs++;
          this.dropBefore(this.cursor);
          continue;
        }
        this.dropBefore(this.cursor);
        const b = this.queue.get(this.cursor) ?? null;
        this.queue.delete(this.cursor);
        if (!b) this.stats.underruns++;
        if (allZero(b?.pub ?? null)) this.stats.publicSilent++;
        const lag = this.now() - this.wallOf(this.cursor);
        this.stats.lagMs = lag;
        this.window.lagMin = Math.min(this.window.lagMin, lag);
        this.window.lagMax = Math.max(this.window.lagMax, lag);
        const t0 = this.now();
        const tc = this.wallOf(this.cursor);
        await Promise.all([this.pub!.audio(stereoFrame(b?.pub ?? null, this.fourCC, tc)), this.rec!.audio(stereoFrame(b?.rec ?? null, this.fourCC, tc))]);
        this.window.sendMax = Math.max(this.window.sendMax, this.now() - t0);
        this.stats.frames++;
        this.cursor += FRAME;
        this.report();
      }
    } finally {
      this.pub?.destroy();
      this.rec?.destroy();
      this.pub = this.rec = null;
    }
  }

  /** Blocks whose slot has gone (they came late, or were skipped): dropped, counted. */
  private dropBefore(cursor: number): void {
    for (const k of [...this.queue.keys()]) {
      if (k >= cursor) continue;
      this.queue.delete(k);
      this.stats.late++;
    }
  }

  private report(): void {
    const now = this.now();
    if (now - this.lastStats < 1000) return;
    this.lastStats = now;
    this.stats.queue = this.queue.size;
    this.stats.lagMinMs = Number.isFinite(this.window.lagMin) ? this.window.lagMin : 0;
    this.stats.lagMaxMs = Number.isFinite(this.window.lagMax) ? this.window.lagMax : 0;
    this.stats.sendMaxMs = this.window.sendMax;
    this.stats.connections = { public: this.pub?.connections() ?? 0, recording: this.rec?.connections() ?? 0 };
    this.window = { lagMin: Infinity, lagMax: -Infinity, sendMax: 0 };
    this.emit({ type: "stats", stats: { ...this.stats, connections: { ...this.stats.connections } } });
  }
}

let ndiModule: NdiSendModule | null = null;

async function loadNdi(): Promise<NdiSendModule> {
  if (!ndiModule) {
    // A variable name: the engine's bundler leaves the native module out (it ships next to the bundle).
    const name = "grandi";
    const mod = (await import(name)) as { default?: NdiSendModule } & NdiSendModule;
    ndiModule = mod.default ?? mod;
  }
  return ndiModule;
}

/** Answers one request from the engine; `reply` sends back. */
export async function handle(req: NdiRequest, reply: (r: NdiReply) => void, state: { out: CommsNdiOutput | null }, load: () => Promise<NdiSendModule> = loadNdi): Promise<void> {
  if (req.type === "block") {
    state.out?.push(req.start, req.wallMs, req.pub, req.rec);
  } else if (req.type === "start") {
    state.out?.stop();
    state.out = null;
    let ndi: NdiSendModule;
    try {
      ndi = await load();
    } catch (err) {
      reply({ type: "status", state: "error", ndi: null, error: `NDI isn't available here: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    const out = new CommsNdiOutput(ndi, req.options, reply);
    try {
      await out.open();
    } catch (err) {
      reply({ type: "status", state: "error", ndi: ndi.version(), error: `NDI couldn't create the senders: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    state.out = out;
    reply({ type: "status", state: "running", ndi: ndi.version(), error: null });
    void out.run().catch((err) => reply({ type: "status", state: "error", ndi: ndi.version(), error: err instanceof Error ? err.message : String(err) }));
  } else if (req.type === "stop") {
    state.out?.stop();
    state.out = null;
    reply({ type: "status", state: "stopped", ndi: null, error: null });
  }
}

if (process.send && process.env.MATCHFRAME_COMMS_NDI_WORKER === "1") {
  const state: { out: CommsNdiOutput | null } = { out: null };
  const reply = (r: NdiReply) => process.send?.(r);
  process.on("message", (m) => void handle(m as NdiRequest, reply, state));
  // The engine went away: no comms leave this computer without it.
  process.on("disconnect", () => {
    state.out?.stop();
    setTimeout(() => process.exit(0), 300).unref();
  });
}
