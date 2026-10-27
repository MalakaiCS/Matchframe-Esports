import { Socket } from "node:net";

export type NetconStatus = "stopped" | "connecting" | "connected";

export interface NetconConnectionOptions {
  host: string;
  port: number;
  connectTimeoutMs?: number;
  /** Delay before the first reconnect attempt; doubles up to `maxRetryMs`. */
  retryMs?: number;
  maxRetryMs?: number;
  onLine?: (line: string) => void;
}

/**
 * A long-lived connection to CS2's TCP console (`-tools -netconport <port>`, loopback only). Once
 * started it keeps reconnecting with backoff, so it connects when the game comes up and again after
 * the game restarts. Listeners hear about every connect (to re-apply console settings) and status
 * change. Lines written while disconnected are refused, never queued: a console command sent
 * minutes late could cut the camera at the wrong moment.
 */
export class NetconConnection {
  private socket: Socket | null = null;
  private attempt: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay: number;
  private running = false;
  private buffer = "";
  private _status: NetconStatus = "stopped";
  private _lastError: string | null = null;
  private _connectedAt: string | null = null;
  private readonly connectListeners = new Set<() => void>();
  private readonly statusListeners = new Set<(s: NetconStatus) => void>();
  private readonly lineListeners = new Set<(line: string) => void>();

  constructor(private readonly opts: NetconConnectionOptions) {
    this.retryDelay = opts.retryMs ?? 2000;
    if (opts.onLine) this.lineListeners.add(opts.onLine);
  }

  get host(): string {
    return this.opts.host;
  }
  get port(): number {
    return this.opts.port;
  }
  get status(): NetconStatus {
    return this._status;
  }
  get lastError(): string | null {
    return this._lastError;
  }
  get connectedAt(): string | null {
    return this._connectedAt;
  }
  get connected(): boolean {
    return !!this.socket && !this.socket.destroyed;
  }

  onConnect(fn: () => void): () => void {
    this.connectListeners.add(fn);
    return () => this.connectListeners.delete(fn);
  }
  onStatus(fn: (s: NetconStatus) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }
  onLine(fn: (line: string) => void): () => void {
    this.lineListeners.add(fn);
    return () => this.lineListeners.delete(fn);
  }

  /** Keeps (re)connecting until stopped. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.retryDelay = this.opts.retryMs ?? 2000;
    if (!this.connected) void this.tryConnect();
  }

  stop(): void {
    this.running = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.socket?.destroy();
    this.socket = null;
    this.setStatus("stopped");
  }

  /** Connects once if not connected (used without `start()`, for on-demand writes). */
  ensure(): Promise<void> {
    if (this.connected) return Promise.resolve();
    return this.tryConnect();
  }

  write(line: string): Promise<void> {
    const s = this.socket;
    if (!s || s.destroyed) return Promise.reject(new Error("the CS2 console is not connected"));
    if (/[\r\n]/.test(line)) return Promise.reject(new Error("a console line cannot contain line breaks"));
    return new Promise((resolve, reject) => s.write(`${line}\n`, (err) => (err ? reject(err) : resolve())));
  }

  private setStatus(s: NetconStatus): void {
    if (this._status === s) return;
    this._status = s;
    for (const fn of this.statusListeners) fn(s);
  }

  private scheduleRetry(): void {
    if (!this.running || this.retryTimer) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, this.opts.maxRetryMs ?? 10_000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.tryConnect();
    }, delay);
    this.retryTimer.unref?.();
  }

  private tryConnect(): Promise<void> {
    if (this.attempt) return this.attempt;
    this.setStatus("connecting");
    this.attempt = new Promise<void>((resolve, reject) => {
      const s = new Socket();
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error("timed out connecting to the CS2 console"));
      }, this.opts.connectTimeoutMs ?? 1500);
      s.once("connect", () => {
        clearTimeout(timer);
        this.socket = s;
        this.buffer = "";
        this._lastError = null;
        this._connectedAt = new Date().toISOString();
        this.retryDelay = this.opts.retryMs ?? 2000;
        this.setStatus("connected");
        for (const fn of this.connectListeners) {
          try {
            fn();
          } catch {
            // A listener's failure must not drop the connection.
          }
        }
        resolve();
      });
      s.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      s.on("data", (d: Buffer) => this.onData(d.toString("utf8")));
      s.on("close", () => {
        if (this.socket === s) {
          this.socket = null;
          this._connectedAt = null;
          this.setStatus(this.running ? "connecting" : "stopped");
          this.scheduleRetry();
        }
      });
      s.connect(this.opts.port, this.opts.host);
    })
      .catch((e: unknown) => {
        this._lastError = e instanceof Error ? e.message : String(e);
        this.setStatus(this.running ? "connecting" : "stopped");
        this.scheduleRetry();
        throw e;
      })
      .finally(() => {
        this.attempt = null;
      });
    // Background attempts (start/retry) must not surface as unhandled rejections.
    this.attempt.catch(() => undefined);
    return this.attempt;
  }

  private onData(text: string): void {
    this.buffer += text;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) for (const fn of this.lineListeners) fn(line);
  }
}
