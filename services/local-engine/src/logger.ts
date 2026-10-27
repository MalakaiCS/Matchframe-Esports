import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

/** Keys whose values are never written to logs. */
const SECRET_KEYS = /token|secret|password|auth|stream_?key|join_?key|credential/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (typeof value === "string") {
    // Strip tokens from URLs (overlay links, captain links).
    return value.replace(/([?&](?:t|token|key)=)[^&\s]+/gi, "$1[redacted]");
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? "[redacted]" : redact(v, depth + 1);
    return out;
  }
  return value;
}

/**
 * Bounded structured JSON-lines logger with size-based rotation and secret redaction.
 */
export class Logger {
  private readonly file: string | null;
  private readonly maxBytes: number;
  private readonly keep: number;
  readonly recent: { at: string; level: LogLevel; msg: string; data?: unknown }[] = [];

  constructor(
    private readonly level: LogLevel,
    logDir: string | null,
    opts: { maxBytes?: number; keep?: number; name?: string } = {},
  ) {
    this.maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
    this.keep = opts.keep ?? 5;
    if (logDir) {
      mkdirSync(logDir, { recursive: true });
      this.file = join(logDir, `${opts.name ?? "engine"}.log`);
    } else this.file = null;
  }

  private rotate(): void {
    if (!this.file || !existsSync(this.file)) return;
    if (statSync(this.file).size < this.maxBytes) return;
    for (let i = this.keep - 1; i >= 1; i--) {
      const from = `${this.file}.${i}`;
      if (existsSync(from)) renameSync(from, `${this.file}.${i + 1}`);
    }
    renameSync(this.file, `${this.file}.1`);
  }

  log(level: LogLevel, msg: string, data?: unknown): void {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const entry = { at: new Date().toISOString(), level, msg, ...(data === undefined ? {} : { data: redact(data) }) };
    this.recent.push(entry);
    if (this.recent.length > 500) this.recent.shift();
    const line = JSON.stringify(entry);
    if (this.file) {
      try {
        this.rotate();
        appendFileSync(this.file, line + "\n");
      } catch {
        // Logging must never take down the engine.
      }
    }
    if (process.env.MATCHFRAME_LOG_STDOUT !== "0") (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
  }

  debug(msg: string, data?: unknown) {
    this.log("debug", msg, data);
  }
  info(msg: string, data?: unknown) {
    this.log("info", msg, data);
  }
  warn(msg: string, data?: unknown) {
    this.log("warn", msg, data);
  }
  error(msg: string, data?: unknown) {
    this.log("error", msg, data);
  }
}
