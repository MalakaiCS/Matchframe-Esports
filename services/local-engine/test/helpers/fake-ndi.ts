import type { NdiAudioFrame, NdiModule, NdiVideoFrame } from "../../src/replay/feed-core.ts";
import type { FeedWorker } from "../../src/replay/feed.ts";
import { handle, type WorkerReply } from "../../src/replay/feed-worker.ts";
import type { FeedRecording } from "../../src/replay/feed-core.ts";

/** The picture's brightness at wall time t: it steps every 100 ms (16..215, round every 20 s). */
export const lumaAt = (t: number): number => 16 + (Math.floor(t / 100) % 200);

/** How far apart two brightness values are in 100 ms steps (on the 20 s round). */
export const lumaSteps = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 200;
  return Math.min(d, 200 - d);
};

/** The stand-in's tone (Hz) and level, and its audio frames: 1600 samples (a 30 fps frame's worth) at 48 kHz. */
export const TONE_HZ = 1000;
export const TONE_LEVEL = 0.5;
const AUDIO_FRAME = 1600;
/** The tone sounds for half a second, then stops for half a second, by wall time: a clip's sound tells when it was sent, as its brightness does. */
export const toneOnAt = (t: number): boolean => Math.floor(t / 500) % 2 === 0;

/** With `counter`: the frame's number in its top COUNTER_ROWS rows, 16 bits as blocks COUNTER_ROWS wide (Y 235 for 1, 16 for 0), lowest bit first. */
export const COUNTER_ROWS = 20;

export interface FakeNdiOptions {
  /** The rate the source declares, and the rate it really sends at (fewer frames arriving). */
  fps?: number;
  sendFps?: number;
  width?: number;
  height?: number;
  audio?: boolean;
  channels?: number;
  /** Samples in each audio frame. */
  audioFrame?: number;
  /** "pulse": the tone on and off every 0.5 s of wall time; "continuous": an unbroken sine by sample count. */
  tone?: "pulse" | "continuous";
  /** The frame's number in its top rows (COUNTER_ROWS). */
  counter?: boolean;
  /** The sender submits each video frame up to this far (ms) either side of when it is due, and each audio frame up to `audioJitterMs` after its last sample: its timestamps jitter so. */
  jitterMs?: number;
  audioJitterMs?: number;
  /** Each frame reaches this process up to this much (ms) after it is sent. */
  arrivalJitterMs?: number;
  /** Every `everyMs` this process is busy for `ms`: what is sent meanwhile comes all at once at the end. */
  stalls?: { everyMs: number; ms: number };
  /** NDI drops every n-th video frame on this computer (counted in its performance). */
  ndiDropEvery?: number;
  /** The sender's audio clock runs this much fast (1.001 = 0.1 %). */
  audioClock?: number;
  /** Video frames carry no timestamp and timecode (a sender that gives none). */
  noVideoTimes?: boolean;
}

/**
 * A stand-in for the NDI binding (grandi): one source, "REPLAY-PC (vMix Desktop Capture)", sending
 * 320×180 UYVY at 30 fps whose brightness tells when each frame was sent (lumaAt), and, unless
 * `audio` is false, a 1 kHz stereo tone (48 kHz, `channels` channels, Float32Interleaved) in frames
 * of 1600 samples, through data() as grandi sends both. As real NDI: a video frame's timestamp is when
 * it was sent and its timecode steps evenly at the frame rate (NDI makes it so); an audio frame's
 * timestamp is when it was sent, just after its last sample. Options add the jitter, delays and
 * losses of a busy screen capture and a busy receiver.
 */
export function fakeNdi(opts: FakeNdiOptions = {}): NdiModule {
  const fps = opts.fps ?? 30;
  const sendFps = opts.sendFps ?? fps;
  const w = opts.width ?? 320;
  const h = opts.height ?? 180;
  const channels = opts.channels ?? 2;
  const n = opts.audioFrame ?? AUDIO_FRAME;
  const source = { name: "REPLAY-PC (vMix Desktop Capture)" };
  const r = (j: number | undefined) => (j ? (Math.random() * 2 - 1) * j : 0);
  return {
    version: () => "NDI SDK (stand-in)",
    COLOR_FORMAT_UYVY_BGRA: 1,
    FOURCC_UYVY: 0x59565955,
    FOURCC_BGRA: 0x41524742,
    FOURCC_BGRX: 0x58524742,
    FOURCC_RGBA: 0x41424752,
    FOURCC_RGBX: 0x58424752,
    AUDIO_FORMAT_FLOAT_32_INTERLEAVED: 1,
    find: async () => ({ sources: () => [source], wait: async () => true, destroy: () => true }),
    receive: async () => {
      const start = Date.now();
      // When a frame sent at `sent` reaches this process: a little later, never before the one before it, and at the end of a busy moment.
      const arrive = (sent: number, prev: number) => {
        let at = Math.max(prev, sent + Math.abs(r(opts.arrivalJitterMs)));
        if (opts.stalls) {
          const k = Math.floor((at - start) / opts.stalls.everyMs);
          const busyFrom = start + k * opts.stalls.everyMs;
          if (k > 0 && at < busyFrom + opts.stalls.ms) at = busyFrom + opts.stalls.ms;
        }
        return at;
      };
      let vi = 0;
      let vPrev = start;
      let ai = 0;
      let aPrev = start;
      let sample = 0;
      let dropped = 0;
      const nextVideo = () => {
        const due = start + ((vi + 1) * 1000) / sendFps;
        const sent = due + r(opts.jitterMs);
        const at = arrive(sent, vPrev);
        return { i: vi, due, sent, at };
      };
      const nextAudio = () => {
        const end = start + ((ai + 1) * n * 1000) / 48000 / (opts.audioClock ?? 1);
        // Submitted once its last sample is in, up to audioJitterMs later.
        const sent = end + Math.abs(r(opts.audioJitterMs));
        return { j: ai, end, sent, at: arrive(sent, aPrev) };
      };
      let v = nextVideo();
      let a = nextAudio();
      const picture = (x: { i: number; due: number; sent: number }): NdiVideoFrame & { type: "video" } => {
        const y = lumaAt(x.sent);
        const data = Buffer.alloc(w * h * 2);
        for (let i = 0; i < w * h * 2; i += 4) {
          data[i] = 128;
          data[i + 1] = y;
          data[i + 2] = 128;
          data[i + 3] = y;
        }
        if (opts.counter)
          for (let bit = 0; bit < 16; bit++) {
            const yy = (x.i >> bit) & 1 ? 235 : 16;
            for (let row = 0; row < COUNTER_ROWS; row++) for (let px = bit * COUNTER_ROWS; px < (bit + 1) * COUNTER_ROWS && px < w; px++) data[(row * w + px) * 2 + 1] = yy;
          }
        const times = opts.noVideoTimes ? {} : { timestamp: BigInt(Math.round(x.sent * 10_000)), timecode: BigInt(Math.round((start + (x.i * 1000) / sendFps) * 10_000)) };
        return { type: "video", xres: w, yres: h, frameRateN: fps, frameRateD: 1, fourCC: 0x59565955, lineStrideBytes: w * 2, data, ...times };
      };
      const sound = (x: { end: number; sent: number }): NdiAudioFrame => {
        const data = Buffer.alloc(n * channels * 4);
        for (let i = 0; i < n; i++, sample++) {
          const on = opts.tone === "continuous" || toneOnAt(x.end - ((n - i) * 1000) / 48000);
          for (let c = 0; c < channels; c++) data.writeFloatLE(on ? TONE_LEVEL * Math.sin((2 * Math.PI * TONE_HZ * sample) / 48000) : 0, (i * channels + c) * 4);
        }
        // Sent (the sender's clock, 100 ns) just after its last sample, as NDI stamps a frame.
        return { type: "audio", sampleRate: 48000, channels, samples: n, data, timestamp: BigInt(Math.round(x.sent * 10_000)) };
      };
      const until = async (t: number) => {
        const wait = t - Date.now();
        if (wait > 0) await new Promise((res) => setTimeout(res, wait));
      };
      const takeVideo = async (): Promise<NdiVideoFrame & { type: "video" }> => {
        for (;;) {
          const x = v;
          vi++;
          vPrev = x.at;
          v = nextVideo();
          if (opts.ndiDropEvery && x.i % opts.ndiDropEvery === opts.ndiDropEvery - 1) {
            dropped++;
            continue;
          }
          await until(x.at);
          return picture(x);
        }
      };
      return {
        video: () => takeVideo(),
        // Video and sound in the order they reach this process.
        data: async (): Promise<(NdiVideoFrame & { type: "video" }) | NdiAudioFrame> => {
          if (opts.audio !== false && a.at <= v.at) {
            const x = a;
            ai++;
            aPrev = x.at;
            a = nextAudio();
            await until(x.at);
            return sound(x);
          }
          return takeVideo();
        },
        performance: () => ({ total: { videoFrames: vi, audioFrames: ai }, dropped: { videoFrames: dropped, audioFrames: 0 } }),
        queue: () => {
          const now = Date.now();
          return { videoFrames: v.at <= now ? 1 : 0, audioFrames: opts.audio !== false && a.at <= now ? 1 : 0 };
        },
        destroy: () => true,
      };
    },
  };
}

/** The feed process run in this process, with the stand-in NDI binding. */
export function inProcessFeedWorker(ndi: NdiModule = fakeNdi()): FeedWorker {
  const listeners: ((r: WorkerReply) => void)[] = [];
  const state: { recording: FeedRecording | null } = { recording: null };
  return {
    send: (req) => void handle(req, (r) => listeners.forEach((fn) => fn(r)), state, async () => ndi),
    onMessage: (fn) => void listeners.push(fn),
    onExit: () => undefined,
    kill: () => {
      state.recording?.stop();
      state.recording = null;
    },
  };
}
