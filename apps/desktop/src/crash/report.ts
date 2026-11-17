import { gzipSync } from "node:zlib";
import type { CrashDetails, CrashReportUpload } from "@matchframe/cloud-contracts";
import type { CrashItem } from "./queue.ts";
import { redactSupport, scrubBinary } from "./redact.ts";

/** The website's limit for a report, unpacked (CRASH_REPORT_MAX_BYTES in @matchframe/cloud-contracts; a test keeps them equal). */
export const REPORT_MAX_BYTES = 10 * 1024 * 1024;
/** A minidump is attached when it is at most this big (else only its name and size are). */
export const MINIDUMP_ATTACH_MAX_BYTES = 2 * 1024 * 1024;

const clip = (s: string | null, n: number) => (s === null ? null : s.length > n ? `${s.slice(0, n - 1)}…` : s);

export interface BuiltReport {
  report: CrashReportUpload;
  /** The report as JSON (at most `maxBytes`) and gzip-compressed, as sent. */
  json: Buffer;
  body: Buffer;
  /** What had to go to fit the limit ("minidump", "support file lists", "support file", "stack"). */
  trimmed: string[];
}

/** The largest list anywhere in a value (by its JSON size), for halving. */
function biggestList(root: unknown): { parent: Record<string, unknown> | unknown[]; key: string | number; list: unknown[]; bytes: number } | null {
  let best: { parent: Record<string, unknown> | unknown[]; key: string | number; list: unknown[]; bytes: number } | null = null;
  const walk = (v: unknown, parent: Record<string, unknown> | unknown[] | null, key: string | number) => {
    if (Array.isArray(v)) {
      if (parent && v.length > 1) {
        const bytes = JSON.stringify(v).length;
        if (!best || bytes > best.bytes) best = { parent, key, list: v, bytes };
      }
      v.forEach((x, i) => walk(x, v, i));
    } else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, v as Record<string, unknown>, k);
  };
  walk(root, null, "");
  return best;
}

/**
 * The report as sent: everything redacted again with the secrets the program knows (the engine's
 * support file already is; the engine's last output lines, errors and stacks are not), the minidump
 * scrubbed of those secrets, and the whole kept within the website's limit by dropping, in turn, the
 * minidump, the older half of the support file's longest lists, the support file, and most of the stack.
 */
export function buildReport(item: CrashItem, o: { secrets: readonly (string | null | undefined)[]; home: string | null; minidump: Buffer | null; maxBytes?: number }): BuiltReport {
  const max = o.maxBytes ?? REPORT_MAX_BYTES;
  const red = { secrets: o.secrets, home: o.home };
  const c = redactSupport(item.crash, red) as CrashDetails;
  const detail: Record<string, unknown> = { ...c.detail };
  if (item.repeats > 0) detail.repeats = item.repeats;
  if (item.supportFileAt) detail.supportFileAt = item.supportFileAt;
  // Within the website's limits (a clock moved back must not get a report refused).
  const seconds = (s: number | null) => (s === null || !Number.isFinite(s) ? null : Math.max(0, s));
  const crash: CrashDetails = {
    ...c,
    reportId: item.crash.reportId,
    reason: clip(c.reason, 200) || "unknown",
    error: clip(c.error, 4000),
    stack: clip(c.stack, 32_000),
    uptimeSeconds: seconds(c.uptimeSeconds),
    programUptimeSeconds: seconds(c.programUptimeSeconds),
    detail,
  };
  let supportFile = item.supportFile ? (redactSupport(item.supportFile, red) as Record<string, unknown>) : null;
  let minidump: CrashReportUpload["minidump"] = null;
  if (item.minidump) {
    const dump = { name: item.minidump.name, size: item.minidump.size, attached: false };
    if (o.minidump && o.minidump.length <= MINIDUMP_ATTACH_MAX_BYTES) {
      const scrubbed = scrubBinary(o.minidump, o.secrets).data;
      minidump = { name: item.minidump.name, size: scrubbed.length, base64: scrubbed.toString("base64") };
      dump.attached = true;
    }
    detail.minidump = dump;
  }
  const trimmed: string[] = [];
  const size = () => Buffer.byteLength(JSON.stringify({ v: 1, crash, supportFile, minidump }));
  if (minidump && size() > max) {
    minidump = null;
    detail.minidump = { ...(detail.minidump as object), attached: false };
    trimmed.push("minidump");
  }
  if (supportFile && size() > max) {
    for (let i = 0; i < 40 && size() > max; i++) {
      const big = biggestList(supportFile);
      if (!big) break;
      (big.parent as Record<string | number, unknown>)[big.key] = big.list.slice(Math.floor(big.list.length / 2));
    }
    trimmed.push("support file lists");
  }
  if (supportFile && size() > max) {
    supportFile = null;
    detail.supportFileOmitted = `larger than ${Math.round(max / 1024 / 1024)} MB`;
    trimmed.push("support file");
  }
  if (size() > max) {
    crash.stack = clip(crash.stack, 4000);
    delete detail.engineOutput;
    trimmed.push("stack");
  }
  if (trimmed.length) detail.trimmed = trimmed;
  const report: CrashReportUpload = { v: 1, crash, supportFile, minidump };
  const json = Buffer.from(JSON.stringify(report));
  return { report, json, body: gzipSync(json), trimmed };
}

/** The engine's last lines of output (its log lines and anything printed as it failed), for an engine crash. */
export class OutputTail {
  private lines: string[] = [];
  private partial = "";
  constructor(private readonly keep = 120) {}

  push(chunk: Buffer | string): void {
    const parts = (this.partial + chunk.toString()).split(/\r?\n/);
    this.partial = (parts.pop() ?? "").slice(-2000);
    for (const p of parts) if (p.trim()) this.lines.push(p.slice(0, 2000));
    if (this.lines.length > this.keep) this.lines = this.lines.slice(-this.keep);
  }

  snapshot(): string[] {
    return this.partial.trim() ? [...this.lines, this.partial].slice(-this.keep) : [...this.lines];
  }
}

/** The engine's last error in its output: an error log line (its message and stack), else a line that reads like a failure. */
export function engineErrorFrom(lines: readonly string[]): { error: string; stack: string | null } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.startsWith("{")) {
      try {
        const j = JSON.parse(line) as { level?: unknown; msg?: unknown; data?: { error?: unknown } };
        if (j.level === "error" && typeof j.msg === "string") {
          const stack = typeof j.data?.error === "string" ? j.data.error : null;
          return { error: stack ? `${j.msg}: ${stack.split("\n")[0]}` : j.msg, stack };
        }
      } catch {
        // not a log line
      }
    } else if (/error|fatal|failed|exception|out of memory/i.test(line)) return { error: line, stack: null };
  }
  return null;
}

export type UploadResult = { kind: "sent"; id: string } | { kind: "retry"; error: string } | { kind: "drop"; error: string };

/**
 * POST /v1/crash-reports. Sent: the website's id for it. Tried again later: no connection, a timeout,
 * too many reports this hour, the website busy or failing. Dropped: the website refused the report
 * itself (invalid, too large), which sending again would not change.
 */
export async function uploadReport(body: Buffer, o: { url: string; token: string | null; appVersion: string; fetch: typeof fetch; timeoutMs?: number }): Promise<UploadResult> {
  let res: Response;
  try {
    res = await o.fetch(`${o.url.replace(/\/+$/, "")}/v1/crash-reports`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "gzip", "x-matchframe-version": o.appVersion, ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(o.timeoutMs ?? 60_000),
    });
  } catch (e) {
    return { kind: "retry", error: `couldn't reach the website: ${e instanceof Error ? e.message : String(e)}` };
  }
  const data = (await res.json().catch(() => null)) as { id?: unknown; message?: unknown } | null;
  if ((res.status === 200 || res.status === 201) && typeof data?.id === "string") return { kind: "sent", id: data.id };
  const why = typeof data?.message === "string" ? data.message : `the website answered HTTP ${res.status}`;
  if (res.ok || res.status === 408 || res.status === 429 || res.status >= 500) return { kind: "retry", error: why };
  return { kind: "drop", error: why };
}
