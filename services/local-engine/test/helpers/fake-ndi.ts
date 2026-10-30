import type { NdiModule, NdiVideoFrame } from "../../src/replay/feed-core.ts";
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

/**
 * A stand-in for the NDI binding (grandi): one source, "REPLAY-PC (vMix Desktop Capture)", sending
 * 320×180 UYVY at 30 fps whose brightness tells when each frame was sent (lumaAt).
 */
export function fakeNdi(opts: { fps?: number; width?: number; height?: number } = {}): NdiModule {
  const fps = opts.fps ?? 30;
  const w = opts.width ?? 320;
  const h = opts.height ?? 180;
  const source = { name: "REPLAY-PC (vMix Desktop Capture)" };
  return {
    version: () => "NDI SDK (stand-in)",
    COLOR_FORMAT_UYVY_BGRA: 1,
    FOURCC_UYVY: 0x59565955,
    FOURCC_BGRA: 0x41524742,
    FOURCC_BGRX: 0x58524742,
    FOURCC_RGBA: 0x41424752,
    FOURCC_RGBX: 0x58424752,
    find: async () => ({ sources: () => [source], wait: async () => true, destroy: () => true }),
    receive: async () => {
      let next = Date.now();
      return {
        video: async (): Promise<NdiVideoFrame> => {
          next += 1000 / fps;
          const wait = next - Date.now();
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
          const y = lumaAt(Date.now());
          const data = Buffer.alloc(w * h * 2);
          for (let i = 0; i < w * h * 2; i += 4) {
            data[i] = 128;
            data[i + 1] = y;
            data[i + 2] = 128;
            data[i + 3] = y;
          }
          return { xres: w, yres: h, frameRateN: fps, frameRateD: 1, fourCC: 0x59565955, lineStrideBytes: w * 2, data };
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
