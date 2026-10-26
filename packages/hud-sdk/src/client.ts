import type { HudMessage, HudState } from "./state.ts";

export interface HudClientOptions {
  /** ws(s) URL of the overlay socket, e.g. ws://127.0.0.1:37212/overlay-ws?output=main&t=TOKEN */
  url: string;
  onState: (state: HudState, receivedAt: number) => void;
  onStatus?: (status: "connecting" | "open" | "closed") => void;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
}

/**
 * Minimal read-only HUD client. Reconnects with backoff and always resynchronizes from a full
 * snapshot; it never sends commands (the overlay socket accepts none).
 */
export class HudClient {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: HudClientOptions) {}

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
  }

  private connect(): void {
    this.opts.onStatus?.("connecting");
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.opts.onStatus?.("open");
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(typeof ev.data === "string" ? ev.data : "") as HudMessage;
        if (msg.topic === "hud.snapshot") this.opts.onState(msg.payload as HudState, performance.now());
      } catch {
        // Ignore malformed frames; the next snapshot resynchronizes.
      }
    };
    ws.onclose = () => {
      this.opts.onStatus?.("closed");
      if (this.closed) return;
      const min = this.opts.reconnectMinMs ?? 500;
      const max = this.opts.reconnectMaxMs ?? 8000;
      const delay = Math.min(max, min * 2 ** this.attempt++);
      this.timer = setTimeout(() => this.connect(), delay);
    };
  }
}

/** Phase/bomb clock for display: advances locally only while running and only up to `maxExtrapolationMs`. */
export function displayClock(remainingSec: number | null, running: boolean, receivedAt: number, now: number, maxExtrapolationMs = 1500): number | null {
  if (remainingSec === null) return null;
  if (!running) return remainingSec;
  const elapsed = Math.min(maxExtrapolationMs, Math.max(0, now - receivedAt));
  return Math.max(0, remainingSec - elapsed / 1000);
}

export function formatClock(sec: number | null): string {
  if (sec === null) return "--:--";
  const s = Math.ceil(sec);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}
