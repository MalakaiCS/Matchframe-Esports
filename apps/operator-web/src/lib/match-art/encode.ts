import type { AlphaFrame } from "./webm.ts";
import { writeAlphaWebm } from "./webm.ts";

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface AlphaVideoOptions {
  width: number;
  height: number;
  fps: number;
  frames: number;
  /** Draws frame `i` on a cleared, transparent canvas. */
  draw: (ctx: Ctx, i: number) => void;
  onProgress?: (done: number, total: number) => void;
  /** A keyframe every this many frames (default 30). */
  keyEvery?: number;
}

/** Whether this browser can make the stingers (WebCodecs VP8 encoding). */
export async function canEncodeVideo(width = 1920, height = 1080): Promise<boolean> {
  if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") return false;
  try {
    const r = await VideoEncoder.isConfigSupported({ codec: "vp8", width, height, bitrate: 8_000_000, framerate: 60, hardwareAcceleration: "prefer-software" });
    return r.supported === true;
  } catch {
    return false;
  }
}

/**
 * Canvas RGBA to two I420 pictures: the colour (BT.601, limited range, as VP8 expects) and the alpha
 * as the brightness of a grey picture (full range: 0 transparent, 255 opaque). Chroma is averaged
 * over the visible pixels only, so edges don't pick up the black of the transparent pixels around them.
 */
export function rgbaToI420Pair(rgba: Uint8ClampedArray, w: number, h: number): { color: Uint8Array; alpha: Uint8Array } {
  const ySize = w * h;
  const cw = w >> 1;
  const chh = h >> 1;
  const color = new Uint8Array(ySize + 2 * cw * chh);
  const alpha = new Uint8Array(ySize + 2 * cw * chh);
  alpha.fill(128, ySize);
  for (let i = 0, p = 0; i < ySize; i++, p += 4) {
    const r = rgba[p]!;
    const g = rgba[p + 1]!;
    const b = rgba[p + 2]!;
    color[i] = ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16;
    alpha[i] = rgba[p + 3]!;
  }
  const uOff = ySize;
  const vOff = ySize + cw * chh;
  for (let cy = 0; cy < chh; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const p = ((cy * 2 + dy) * w + cx * 2 + dx) * 4;
          const a = rgba[p + 3]! + 1;
          sr += rgba[p]! * a;
          sg += rgba[p + 1]! * a;
          sb += rgba[p + 2]! * a;
          sa += a;
        }
      }
      const r = sr / sa;
      const g = sg / sa;
      const b = sb / sa;
      const o = cy * cw + cx;
      color[uOff + o] = Math.max(0, Math.min(255, Math.round((-38 * r - 74 * g + 112 * b) / 256 + 128)));
      color[vOff + o] = Math.max(0, Math.min(255, Math.round((112 * r - 94 * g - 18 * b) / 256 + 128)));
    }
  }
  return { color, alpha };
}

/** The next turn of the event loop, through a message rather than a timer (messages aren't throttled). */
function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/** Until the encoder takes the next frame off its queue (its "dequeue" event). */
function dequeued(enc: VideoEncoder): Promise<void> {
  return new Promise((resolve) => enc.addEventListener("dequeue", () => resolve(), { once: true }));
}

/**
 * What the stinger encoder is doing, for the program's smoke test (`window.__matchframeEncode`):
 * frames submitted and encoded, the encoders' queues, and where the time went (totals in ms).
 */
export interface EncodeTrace {
  frames: number;
  submitted: number;
  encoded: [number, number];
  queue: [number, number];
  ms: { draw: number; read: number; convert: number; submit: number; wait: number };
  lastFrameAt: number;
}

function newTrace(frames: number): EncodeTrace {
  const t: EncodeTrace = { frames, submitted: 0, encoded: [0, 0], queue: [0, 0], ms: { draw: 0, read: 0, convert: 0, submit: 0, wait: 0 }, lastFrameAt: 0 };
  (globalThis as { __matchframeEncode?: EncodeTrace }).__matchframeEncode = t;
  return t;
}

interface Chunk {
  data: Uint8Array;
  key: boolean;
  ts: number;
}

/** Draws every frame, encodes colour and alpha as two VP8 streams, and writes one WebM with alpha. */
export async function encodeAlphaWebm(o: AlphaVideoOptions): Promise<Uint8Array> {
  const { width: w, height: h, fps } = o;
  const keyEvery = o.keyEvery ?? 30;
  const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = canvas.getContext("2d", { willReadFrequently: true }) as Ctx | null;
  if (!ctx) throw new Error("This computer can't draw the stinger (no 2D canvas).");
  const out: { color: Chunk[]; alpha: Chunk[] } = { color: [], alpha: [] };
  const trace = newTrace(o.frames);
  let failure: Error | null = null;
  const make = (which: "color" | "alpha", bitrate: number) => {
    const e = new VideoEncoder({
      output: (chunk) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        out[which].push({ data, key: chunk.type === "key", ts: chunk.timestamp });
        trace.encoded[which === "color" ? 0 : 1]++;
      },
      error: (err) => {
        failure = err instanceof Error ? err : new Error(String(err));
        // A failed encoder takes nothing more off its queue: wake the loop waiting for it.
        e.dispatchEvent(new Event("dequeue"));
      },
    });
    // The software VP8 encoder (libvpx) everywhere: the same, predictable encoder on every computer
    // (on a Windows machine without a usable GPU another path made the stinger crawl).
    e.configure({ codec: "vp8", width: w, height: h, bitrate, framerate: fps, latencyMode: "quality", hardwareAcceleration: "prefer-software" });
    return e;
  };
  const colorEnc = make("color", 12_000_000);
  const alphaEnc = make("alpha", 4_000_000);
  const frameUs = 1_000_000 / fps;
  try {
    for (let i = 0; i < o.frames; i++) {
      if (failure) throw failure;
      let t = performance.now();
      const lap = (k: keyof EncodeTrace["ms"]) => {
        const now = performance.now();
        trace.ms[k] += now - t;
        t = now;
      };
      ctx.clearRect(0, 0, w, h);
      ctx.save();
      o.draw(ctx, i);
      ctx.restore();
      lap("draw");
      const pixels = ctx.getImageData(0, 0, w, h).data;
      lap("read");
      const { color, alpha } = rgbaToI420Pair(pixels, w, h);
      lap("convert");
      const timestamp = Math.round(i * frameUs);
      const key = i % keyEvery === 0;
      for (const [enc, buf] of [
        [colorEnc, color],
        [alphaEnc, alpha],
      ] as const) {
        const frame = new VideoFrame(buf, { format: "I420", codedWidth: w, codedHeight: h, timestamp, duration: Math.round(frameUs) });
        enc.encode(frame, { keyFrame: key });
        frame.close();
      }
      // Let the window breathe between frames, and don't run ahead of the encoders. Neither waits on
      // a timer: a window the system reports as hidden (covered by OBS, minimised) gets its chained
      // timers held back to one a minute after a few minutes, which stalled a stinger half way.
      trace.submitted = i + 1;
      trace.queue = [colorEnc.encodeQueueSize, alphaEnc.encodeQueueSize];
      lap("submit");
      await nextTask();
      for (const enc of [colorEnc, alphaEnc]) while (enc.encodeQueueSize > 4 && !failure) await dequeued(enc);
      lap("wait");
      trace.lastFrameAt = Date.now();
      o.onProgress?.(i + 1, o.frames);
    }
    await Promise.all([colorEnc.flush(), alphaEnc.flush()]);
    if (failure) throw failure;
  } finally {
    colorEnc.close();
    alphaEnc.close();
  }
  const byTs = new Map(out.alpha.map((c) => [c.ts, c]));
  const frames: AlphaFrame[] = [];
  for (const c of out.color) {
    const a = byTs.get(c.ts);
    if (!a) throw new Error(`The stinger's alpha is missing a frame at ${c.ts} µs.`);
    // A frame is only a keyframe when both pictures are (the decoder needs both).
    if (c.key !== a.key) throw new Error(`The stinger's colour and alpha keyframes differ at ${c.ts} µs.`);
    frames.push({ color: c.data, alpha: a.data, key: c.key, timeMs: c.ts / 1000 });
  }
  if (frames.length !== o.frames) throw new Error(`The encoder returned ${frames.length} of ${o.frames} frames.`);
  return writeAlphaWebm({ width: w, height: h, fps, frames });
}
