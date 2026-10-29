import { encodeCamFrame, type CamHello, type CamPlayerStatus, type CamPublisherMessage, type CamQuality } from "@matchframe/cloud-contracts";

/**
 * Sends a player's camera to the production (player cams, ADR-048): frames are encoded in the
 * browser with WebCodecs (VP8, a keyframe every few seconds or when the production asks) and sent
 * over a WebSocket to the website, which passes them to the production's program.
 *
 * Frames come from the camera track itself where the browser can (MediaStreamTrackProcessor: Chrome
 * and Edge), so they keep flowing while the game covers the browser; elsewhere from a canvas on a
 * timer, which the browser slows down when the page is hidden.
 */

export type SenderState = { kind: "connecting" } | { kind: "status"; status: CamPlayerStatus } | { kind: "reconnecting"; inSec: number } | { kind: "kicked"; reason: string } | { kind: "error"; message: string } | { kind: "stopped" };

export interface SenderStats {
  frames: number;
  kbps: number;
  width: number;
  height: number;
  /** Frames come from a timer (slowed down by the browser when the page is hidden). */
  timerSource: boolean;
}

type Processor = { readable: ReadableStream<VideoFrame> };
type ProcessorCtor = new (init: { track: MediaStreamTrack }) => Processor;

/** True when this browser can send (WebCodecs VP8). */
export async function canSend(quality: CamQuality): Promise<boolean> {
  if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") return false;
  try {
    const r = await VideoEncoder.isConfigSupported(encoderConfig(quality, quality.width, quality.height));
    return !!r.supported;
  } catch {
    return false;
  }
}

function encoderConfig(q: CamQuality, width: number, height: number): VideoEncoderConfig {
  return { codec: "vp8", width, height, bitrate: q.bitrateKbps * 1000, framerate: q.fps, latencyMode: "realtime" };
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** The encoded size for a camera picture: the room's height, the camera's shape (never stretched), at most the room's width. */
export function encodedSize(q: CamQuality, srcW: number, srcH: number): { width: number; height: number } {
  if (!srcW || !srcH) return { width: q.width, height: q.height };
  const aspect = srcW / srcH;
  let height = Math.min(q.height, srcH);
  let width = height * aspect;
  if (width > q.width) {
    width = q.width;
    height = width / aspect;
  }
  return { width: even(width), height: even(height) };
}

export class CamSender {
  private ws: WebSocket | null = null;
  private encoder: VideoEncoder | null = null;
  private size: { width: number; height: number } | null = null;
  private stopped = false;
  private wantKey = true;
  private lastKeyUs = -Infinity;
  private lastFrameUs = -Infinity;
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pump: { cancel: () => void } | null = null;
  private wake: { release: () => Promise<void> } | null = null;
  private readonly bytes: { at: number; n: number }[] = [];
  private framesSent = 0;
  private timerSource = false;

  constructor(
    private readonly opts: {
      url: string;
      stream: MediaStream;
      quality: CamQuality;
      camera: string;
      onState: (s: SenderState) => void;
    },
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
    this.startPump();
    void this.keepAwake();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.pump?.cancel();
    this.pump = null;
    try {
      this.encoder?.close();
    } catch {
      // already closed
    }
    this.encoder = null;
    this.ws?.close(1000, "stopped");
    this.ws = null;
    void this.wake?.release().catch(() => undefined);
    this.wake = null;
    this.opts.onState({ kind: "stopped" });
  }

  stats(): SenderStats {
    const now = performance.now();
    while (this.bytes.length && now - this.bytes[0]!.at > 3000) this.bytes.shift();
    const n = this.bytes.reduce((s, b) => s + b.n, 0);
    return { frames: this.framesSent, kbps: Math.round((n * 8) / 3000), width: this.size?.width ?? 0, height: this.size?.height ?? 0, timerSource: this.timerSource };
  }

  private connect(): void {
    this.opts.onState({ kind: "connecting" });
    const ws = new WebSocket(this.opts.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    let kicked = false;
    ws.onopen = () => {
      this.retries = 0;
      const s = this.size ?? { width: this.opts.quality.width, height: this.opts.quality.height };
      const hello: CamHello = { type: "hello", codec: "vp8", width: s.width, height: s.height, fps: this.opts.quality.fps, camera: this.opts.camera.slice(0, 80) };
      ws.send(JSON.stringify(hello));
      this.wantKey = true;
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      let m: CamPublisherMessage;
      try {
        m = JSON.parse(ev.data) as CamPublisherMessage;
      } catch {
        return;
      }
      if (m.type === "status") this.opts.onState({ kind: "status", status: m.state });
      else if (m.type === "key") this.wantKey = true;
      else if (m.type === "kicked") {
        kicked = true;
        this.opts.onState({ kind: "kicked", reason: m.reason });
      }
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped || kicked) return;
      if (ev.code === 4003) return;
      // The link closed (404 on connect shows as 1006 before open): try again a few times.
      const inSec = Math.min(10, 2 ** this.retries);
      this.retries++;
      this.opts.onState({ kind: "reconnecting", inSec });
      this.retryTimer = setTimeout(() => this.connect(), inSec * 1000);
    };
  }

  private ensureEncoder(srcW: number, srcH: number): VideoEncoder | null {
    const want = encodedSize(this.opts.quality, srcW, srcH);
    if (this.encoder && this.size && this.size.width === want.width && this.size.height === want.height) return this.encoder;
    try {
      this.encoder?.close();
    } catch {
      // already closed
    }
    this.size = want;
    const enc = new VideoEncoder({
      output: (chunk) => this.onChunk(chunk),
      error: (e) => {
        this.encoder = null;
        this.opts.onState({ kind: "error", message: `The browser's video encoder stopped: ${e.message}` });
      },
    });
    enc.configure(encoderConfig(this.opts.quality, want.width, want.height));
    this.encoder = enc;
    this.wantKey = true;
    return enc;
  }

  /** One camera frame: encoded unless the encoder is behind or it comes sooner than the room's frame rate. */
  private onFrame(frame: VideoFrame): void {
    try {
      if (this.stopped) return;
      const ts = frame.timestamp;
      if (ts - this.lastFrameUs < (1e6 / this.opts.quality.fps) * 0.85) return;
      const enc = this.ensureEncoder(frame.displayWidth, frame.displayHeight);
      if (!enc || enc.encodeQueueSize > 2) return;
      this.lastFrameUs = ts;
      const key = this.wantKey || ts - this.lastKeyUs >= this.opts.quality.keyframeSec * 1e6;
      if (key) {
        this.wantKey = false;
        this.lastKeyUs = ts;
      }
      enc.encode(frame, { keyFrame: key });
    } finally {
      frame.close();
    }
  }

  private onChunk(chunk: EncodedVideoChunk): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.wantKey = true;
      return;
    }
    // A slow connection: skip until the next keyframe rather than fall behind.
    if (ws.bufferedAmount > 1_000_000) {
      this.wantKey = true;
      return;
    }
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const msg = encodeCamFrame(chunk.type === "key", chunk.timestamp, data);
    ws.send(msg);
    this.framesSent++;
    this.bytes.push({ at: performance.now(), n: msg.byteLength });
  }

  private startPump(): void {
    const track = this.opts.stream.getVideoTracks()[0];
    if (!track) {
      this.opts.onState({ kind: "error", message: "No camera picture to send." });
      return;
    }
    const Ctor = (globalThis as { MediaStreamTrackProcessor?: ProcessorCtor }).MediaStreamTrackProcessor;
    if (Ctor) {
      const reader = new Ctor({ track }).readable.getReader();
      let live = true;
      const loop = async () => {
        while (live) {
          const r = await reader.read().catch(() => ({ done: true as const, value: undefined }));
          if (r.done || !r.value) break;
          this.onFrame(r.value);
        }
      };
      void loop();
      this.pump = {
        cancel: () => {
          live = false;
          void reader.cancel().catch(() => undefined);
        },
      };
      return;
    }
    // Without the processor: draw the camera onto a canvas at the room's frame rate.
    this.timerSource = true;
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = this.opts.stream;
    void video.play().catch(() => undefined);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const t0 = performance.now();
    const timer = setInterval(() => {
      if (!ctx || video.videoWidth === 0) return;
      const size = encodedSize(this.opts.quality, video.videoWidth, video.videoHeight);
      if (canvas.width !== size.width || canvas.height !== size.height) {
        canvas.width = size.width;
        canvas.height = size.height;
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      this.onFrame(new VideoFrame(canvas, { timestamp: Math.round((performance.now() - t0) * 1000) }));
    }, 1000 / this.opts.quality.fps);
    this.pump = {
      cancel: () => {
        clearInterval(timer);
        video.srcObject = null;
      },
    };
  }

  private async keepAwake(): Promise<void> {
    try {
      const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } };
      this.wake = (await nav.wakeLock?.request("screen")) ?? null;
    } catch {
      // not allowed here: the camera still sends
    }
  }
}
