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

/**
 * A stand-in for the NDI binding (grandi): one source, "REPLAY-PC (vMix Desktop Capture)", sending
 * 320×180 UYVY at 30 fps whose brightness tells when each frame was sent (lumaAt), and, unless
 * `audio` is false, a 1 kHz stereo tone (48 kHz, `channels` channels, Float32Interleaved) in frames
 * of 1600 samples, through data() as grandi sends both.
 */
export function fakeNdi(opts: { fps?: number; width?: number; height?: number; audio?: boolean; channels?: number } = {}): NdiModule {
  const fps = opts.fps ?? 30;
  const w = opts.width ?? 320;
  const h = opts.height ?? 180;
  const channels = opts.channels ?? 2;
  const source = { name: "REPLAY-PC (vMix Desktop Capture)" };
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
      let next = Date.now();
      let nextAudio = Date.now() + (AUDIO_FRAME / 48000) * 1000;
      let sample = 0;
      const picture = (): NdiVideoFrame => {
        const y = lumaAt(Date.now());
        const data = Buffer.alloc(w * h * 2);
        for (let i = 0; i < w * h * 2; i += 4) {
          data[i] = 128;
          data[i + 1] = y;
          data[i + 2] = 128;
          data[i + 3] = y;
        }
        return { xres: w, yres: h, frameRateN: fps, frameRateD: 1, fourCC: 0x59565955, lineStrideBytes: w * 2, data };
      };
      // A frame of sound ends when it is sent (`end`, wall ms).
      const sound = (end: number): NdiAudioFrame => {
        const data = Buffer.alloc(AUDIO_FRAME * channels * 4);
        for (let i = 0; i < AUDIO_FRAME; i++, sample++) {
          const on = toneOnAt(end - ((AUDIO_FRAME - i) * 1000) / 48000);
          for (let c = 0; c < channels; c++) data.writeFloatLE(on ? TONE_LEVEL * Math.sin((2 * Math.PI * TONE_HZ * sample) / 48000) : 0, (i * channels + c) * 4);
        }
        // Sent by the sender's clock (100 ns), as NDI stamps a frame.
        return { type: "audio", sampleRate: 48000, channels, samples: AUDIO_FRAME, data, timestamp: BigInt(Math.round((end - (AUDIO_FRAME * 1000) / 48000) * 10_000)) };
      };
      const until = async (t: number) => {
        const wait = t - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      };
      return {
        video: async (): Promise<NdiVideoFrame> => {
          next += 1000 / fps;
          await until(next);
          return picture();
        },
        // Video and sound in the order they are due (a frame of sound ends when it is sent).
        data: async (): Promise<(NdiVideoFrame & { type: "video" }) | NdiAudioFrame> => {
          if (opts.audio !== false && nextAudio <= next + 1000 / fps) {
            await until(nextAudio);
            const end = nextAudio;
            nextAudio += (AUDIO_FRAME / 48000) * 1000;
            return sound(end);
          }
          next += 1000 / fps;
          await until(next);
          return { type: "video", ...picture() };
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
