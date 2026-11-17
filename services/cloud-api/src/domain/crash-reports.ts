import { gunzipSync, gzipSync } from "node:zlib";
import { CRASH_REPORT_MAX_BYTES, CRASH_REPORT_RETENTION_DAYS, CrashReportUpload } from "@matchframe/cloud-contracts";
import type { CrashDetails, CrashProcess } from "@matchframe/cloud-contracts";
import type { Queryable } from "../db/sql.ts";
import { HttpError } from "../http/router.ts";
import { newUserCode } from "../ids.ts";

/**
 * Crash reports sent by the program (ADR-077). Each report is stored once, gzip-compressed, in the
 * database like account sync's files (`bytea`, no second compression by Postgres), with the few
 * fields the staff list needs beside it. Reports are deleted 90 days after they arrive.
 */

export const CRASH_RETENTION_MS = CRASH_REPORT_RETENTION_DAYS * 86_400_000;
const MAX_MB = CRASH_REPORT_MAX_BYTES / (1024 * 1024);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export interface DecodedCrashReport {
  report: CrashReportUpload;
  /** Bytes of the report as JSON. */
  size: number;
  /** What is stored: the report gzip-compressed (as received when it came compressed). */
  stored: Buffer;
}

/** Unpacks an upload (gzip, else plain JSON) without ever holding more than the 10 MB limit unpacked, and validates it. */
export function decodeCrashReport(raw: Buffer): DecodedCrashReport {
  const gzipped = raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b;
  let json: Buffer = raw;
  if (gzipped) {
    try {
      json = gunzipSync(raw, { maxOutputLength: CRASH_REPORT_MAX_BYTES });
    } catch (e) {
      if (e instanceof RangeError || (e as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw new HttpError(413, "too_large", `a crash report can be at most ${MAX_MB} MB once unpacked`);
      throw new HttpError(400, "bad_gzip", "the crash report isn't valid gzip");
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json.toString("utf8"));
  } catch {
    throw new HttpError(400, "bad_json", "the crash report isn't valid JSON");
  }
  const r = CrashReportUpload.safeParse(parsed);
  if (!r.success) throw new HttpError(400, "validation", "crash report validation failed", r.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })));
  const dump = r.data.minidump;
  if (dump && (!BASE64.test(dump.base64) || Buffer.byteLength(dump.base64, "base64") !== dump.size)) throw new HttpError(400, "bad_minidump", "the minidump isn't valid base64 of its stated size");
  return { report: r.data, size: json.length, stored: gzipped ? raw : gzipSync(json) };
}

/** The first line of the error, short enough for a list. */
const errorLine = (c: CrashDetails) => (c.error ?? "").split("\n")[0]!.trim().slice(0, 300) || null;

/**
 * Stores a report under a new id ("CR-XXXX-XXXX", easy to read out to support). A report the
 * program sends again (it never heard the answer) is recognised by its own id and not stored twice.
 */
export async function storeCrashReport(db: Queryable, d: DecodedCrashReport, from: { orgId: string | null; deviceId: string | null }, now: Date): Promise<{ id: string; duplicate: boolean }> {
  const c = d.report.crash;
  const existing = async () => (await db.query<{ id: string }>("SELECT id FROM crash_reports WHERE client_report_id = $1", [c.reportId])).rows[0]?.id ?? null;
  const before = await existing();
  if (before) return { id: before, duplicate: true };
  for (let attempt = 0; ; attempt++) {
    const id = `CR-${newUserCode()}`;
    try {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO crash_reports (id, client_report_id, org_id, device_id, app_version, os_platform, os_release, process, reason, error, occurred_at, received_at, size_bytes, stored_bytes, has_support_file, has_minidump, report)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         ON CONFLICT (client_report_id) DO NOTHING RETURNING id`,
        [id, c.reportId, from.orgId, from.deviceId, c.appVersion, c.os.platform, c.os.release, c.process, c.reason, errorLine(c), new Date(c.occurredAt), now, d.size, d.stored.length, d.report.supportFile !== null, d.report.minidump !== null, d.stored],
      );
      if (rows[0]) return { id: rows[0].id, duplicate: false };
      // Sent twice at the same moment: the other request stored it.
      return { id: (await existing())!, duplicate: true };
    } catch (e) {
      // The generated id was taken (about one in 25 billion): try another.
      if (attempt < 4 && /duplicate key|crash_reports_pkey/.test(String(e))) continue;
      throw e;
    }
  }
}

/** Bytes kept for reports from programs that were not signed in (the anonymous storage limit). */
export async function anonymousCrashBytes(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ n: number | string }>("SELECT COALESCE(sum(stored_bytes), 0) AS n FROM crash_reports WHERE org_id IS NULL");
  return Number(rows[0]!.n);
}

/** Deletes reports received more than 90 days before `now`; returns how many. */
export async function purgeCrashReports(db: Queryable, now: Date): Promise<number> {
  const { rows } = await db.query("DELETE FROM crash_reports WHERE received_at < $1 RETURNING id", [new Date(now.getTime() - CRASH_RETENTION_MS)]);
  return rows.length;
}

interface ListRow {
  id: string;
  org_id: string | null;
  org_name: string | null;
  device_id: string | null;
  device_name: string | null;
  app_version: string;
  os_platform: string;
  os_release: string;
  process: CrashProcess;
  reason: string;
  error: string | null;
  occurred_at: Date;
  received_at: Date;
  size_bytes: number;
  stored_bytes: number;
  has_support_file: boolean;
  has_minidump: boolean;
}

const LIST_COLUMNS = `c.id, c.org_id, o.name AS org_name, c.device_id, d.name AS device_name, c.app_version, c.os_platform, c.os_release, c.process, c.reason, c.error,
  c.occurred_at, c.received_at, c.size_bytes, c.stored_bytes, c.has_support_file, c.has_minidump`;
const LIST_FROM = "crash_reports c LEFT JOIN orgs o ON o.id = c.org_id LEFT JOIN devices d ON d.id = c.device_id";

export const crashReportView = (r: ListRow) => ({
  id: r.id,
  receivedAt: r.received_at.toISOString(),
  occurredAt: r.occurred_at.toISOString(),
  expiresAt: new Date(r.received_at.getTime() + CRASH_RETENTION_MS).toISOString(),
  appVersion: r.app_version,
  os: `${r.os_platform} ${r.os_release}`.trim(),
  process: r.process,
  reason: r.reason,
  error: r.error,
  orgId: r.org_id,
  orgName: r.org_name,
  deviceId: r.device_id,
  deviceName: r.device_name,
  sizeBytes: r.size_bytes,
  storedBytes: r.stored_bytes,
  hasSupportFile: r.has_support_file,
  hasMinidump: r.has_minidump,
});

/** Staff list, newest first. `q` matches the id, version, organisation, computer or error; `process` narrows to one part of the program. */
export async function listCrashReports(db: Queryable, f: { q: string; process: CrashProcess | null; page: number; pageSize: number }) {
  const where = [
    "($1 = '' OR lower(c.id) = $1 OR lower(c.id) = 'cr-' || $1 OR lower(c.app_version) = $1 OR lower(COALESCE(o.name, '')) LIKE '%' || $1 || '%' OR c.org_id = $1 OR lower(COALESCE(d.name, '')) LIKE '%' || $1 || '%' OR lower(COALESCE(c.error, '')) LIKE '%' || $1 || '%')",
    "($2::text IS NULL OR c.process = $2)",
  ].join(" AND ");
  const params = [f.q.toLowerCase(), f.process];
  const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${LIST_FROM} WHERE ${where}`, params)).rows[0]!.n);
  const { rows } = await db.query<ListRow>(`SELECT ${LIST_COLUMNS} FROM ${LIST_FROM} WHERE ${where} ORDER BY c.received_at DESC, c.id LIMIT $3 OFFSET $4`, [...params, f.pageSize, (f.page - 1) * f.pageSize]);
  const bytes = Number((await db.query<{ n: string | number }>("SELECT COALESCE(sum(stored_bytes), 0) AS n FROM crash_reports")).rows[0]!.n);
  return { reports: rows.map(crashReportView), total, storedBytes: bytes };
}

/** One report: its list fields and the whole report as received (unpacked). */
export async function readCrashReport(db: Queryable, id: string): Promise<{ row: ReturnType<typeof crashReportView>; json: Buffer } | null> {
  const { rows } = await db.query<ListRow & { report: Uint8Array }>(`SELECT ${LIST_COLUMNS}, c.report FROM ${LIST_FROM} WHERE c.id = $1`, [id]);
  const r = rows[0];
  if (!r) return null;
  return { row: crashReportView(r), json: gunzipSync(Buffer.from(r.report.buffer, r.report.byteOffset, r.report.byteLength)) };
}
