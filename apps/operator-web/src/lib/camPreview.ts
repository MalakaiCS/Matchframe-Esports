import { getOperatorToken } from "../api/auth.ts";
import { engineWsUrl } from "./engine.ts";

/**
 * Live previews for the Player cameras screen (player cams, ADR-048): every cam as it arrives
 * (not delayed, approved or not), from `/api/v1/cams/ws`, decoded with WebCodecs into one canvas per
 * player.
 */
export class CamPreview {
  private ws: WebSocket | null = null;
  private stopped = false;
  private retry = 1000;
  private readonly cams = new Map<string, { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D | null; decoder: VideoDecoder | null; wantKey: boolean; frameAt: number }>();

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
    for (const c of this.cams.values()) {
      try {
        c.decoder?.close();
      } catch {
        // closed
      }
    }
  }

  canvas(steamId: string): HTMLCanvasElement {
    return this.cam(steamId).canvas;
  }

  /** A frame drew in the last 2 s. */
  receiving(steamId: string): boolean {
    const c = this.cams.get(steamId);
    return !!c && performance.now() - c.frameAt < 2000;
  }

  private cam(id: string) {
    let c = this.cams.get(id);
    if (!c) {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 360;
      c = { canvas, ctx: canvas.getContext("2d"), decoder: null, wantKey: true, frameAt: 0 };
      this.cams.set(id, c);
    }
    return c;
  }

  private connect(): void {
    const token = getOperatorToken();
    if (!token || this.stopped) return;
    const ws = new WebSocket(engineWsUrl(`/api/v1/cams/ws?token=${encodeURIComponent(token)}`));
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 1000;
      ws.send(JSON.stringify({ type: "sub", players: null }));
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") this.onFrame(ev.data as ArrayBuffer);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) return;
      setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(10_000, this.retry * 2);
    };
  }

  private onFrame(buf: ArrayBuffer): void {
    if (typeof VideoDecoder === "undefined") return;
    const u8 = new Uint8Array(buf);
    const n = u8[0]!;
    let h: { s: string; k: number; t: number; w: number; h: number; c: string };
    try {
      h = JSON.parse(new TextDecoder().decode(u8.subarray(1, 1 + n))) as typeof h;
    } catch {
      return;
    }
    const c = this.cam(h.s);
    if (!c.decoder || c.decoder.state === "closed") {
      c.decoder = new VideoDecoder({
        output: (frame) => {
          if (c.canvas.width !== frame.displayWidth || c.canvas.height !== frame.displayHeight) {
            c.canvas.width = frame.displayWidth;
            c.canvas.height = frame.displayHeight;
          }
          c.ctx?.drawImage(frame, 0, 0);
          frame.close();
          c.frameAt = performance.now();
        },
        error: () => {
          c.decoder = null;
          c.wantKey = true;
        },
      });
      c.decoder.configure({ codec: h.c || "vp8", codedWidth: h.w, codedHeight: h.h, optimizeForLatency: true });
      c.wantKey = true;
    }
    if (c.wantKey && !h.k) return;
    c.wantKey = false;
    try {
      c.decoder.decode(new EncodedVideoChunk({ type: h.k ? "key" : "delta", timestamp: h.t, data: u8.subarray(1 + n) }));
    } catch {
      c.wantKey = true;
    }
  }
}
