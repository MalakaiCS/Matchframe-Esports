/**
 * Operator WebSocket with reconnect + exponential backoff. The engine sends a full `state.snapshot`
 * on connect and at least once per second, so after a reconnect the UI simply resyncs from the next
 * snapshot (deltas are never replayed across connections).
 */

export type SocketStatus = "idle" | "connecting" | "open" | "reconnecting" | "unauthorized" | "closed";

/** Reconnect delay for the given attempt (1-based): 0.5 s doubling up to 10 s, ±20 % jitter. */
export function backoffDelay(attempt: number, rand: () => number = Math.random): number {
  const base = Math.min(10_000, 500 * 2 ** Math.max(0, attempt - 1));
  const jitter = base * 0.2 * (rand() * 2 - 1);
  return Math.round(base + jitter);
}

export interface SocketInfo {
  attempt: number;
  nextRetryInMs: number | null;
  lastError: string | null;
}

export interface OperatorSocketOptions {
  url: () => string | null;
  onMessage: (msg: unknown) => void;
  onStatus: (status: SocketStatus, info: SocketInfo) => void;
  /** Called after repeated failures: resolves false when the token is definitely rejected. */
  checkAuth?: () => Promise<boolean>;
  /** Close and reconnect when nothing arrives for this long while open (engine pushes ≥1 Hz). */
  watchdogMs?: number;
  pingMs?: number;
  WebSocketImpl?: typeof WebSocket;
}

export class OperatorSocket {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private stopped = true;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;
  private lastError: string | null = null;

  constructor(private readonly opts: OperatorSocketOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close(1000, "client stop");
      this.ws = null;
    }
    this.emit("closed", null);
  }

  /** Forces an immediate reconnect (e.g. operator pressed "Reconnect"). */
  reconnectNow(): void {
    if (this.stopped) return this.start();
    this.attempt = 0;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.connect();
  }

  send(msg: unknown): void {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  private emit(status: SocketStatus, nextRetryInMs: number | null): void {
    this.opts.onStatus(status, { attempt: this.attempt, nextRetryInMs, lastError: this.lastError });
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.retryTimer = this.pingTimer = this.watchdog = null;
  }

  private connect(): void {
    const url = this.opts.url();
    if (!url) {
      this.emit("unauthorized", null);
      return;
    }
    const Impl = this.opts.WebSocketImpl ?? WebSocket;
    this.emit(this.attempt === 0 ? "connecting" : "reconnecting", null);
    let ws: WebSocket;
    try {
      ws = new Impl(url);
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.lastError = null;
      this.lastMessageAt = Date.now();
      this.emit("open", null);
      const pingMs = this.opts.pingMs ?? 15_000;
      this.pingTimer = setInterval(() => this.send({ type: "ping" }), pingMs);
      const wd = this.opts.watchdogMs ?? 6_000;
      this.watchdog = setInterval(() => {
        if (Date.now() - this.lastMessageAt > wd) {
          this.lastError = `no data for ${Math.round(wd / 1000)} s`;
          ws.close();
        }
      }, Math.min(wd, 2_000));
    };
    ws.onmessage = (ev) => {
      this.lastMessageAt = Date.now();
      let msg: unknown;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      this.opts.onMessage(msg);
    };
    ws.onerror = () => {
      this.lastError = "connection error";
    };
    ws.onclose = (ev) => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (this.watchdog) clearInterval(this.watchdog);
      this.pingTimer = this.watchdog = null;
      this.ws = null;
      if (this.stopped) return;
      if (ev.code !== 1000 && ev.code !== 1005 && !this.lastError) this.lastError = `closed (${ev.code})`;
      this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    this.attempt++;
    const proceed = () => {
      if (this.stopped) return;
      const delay = backoffDelay(this.attempt);
      this.emit("reconnecting", delay);
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };
    // After a few failures, distinguish "engine down" from "token rejected" (browsers hide the 401).
    if (this.attempt >= 3 && this.attempt % 3 === 0 && this.opts.checkAuth) {
      this.opts
        .checkAuth()
        .then((ok) => {
          if (ok) proceed();
          else {
            this.lastError = "token rejected by the engine";
            this.stopped = true;
            this.emit("unauthorized", null);
          }
        })
        .catch(() => proceed());
      return;
    }
    proceed();
  }
}
