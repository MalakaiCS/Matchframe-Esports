import { CRASH_REPORT_MAX_BYTES, CrashProcess } from "@matchframe/cloud-contracts";
import type { CrashDetails, CrashReportReceipt, CrashReportUpload } from "@matchframe/cloud-contracts";
import type { CloudApp } from "../app.ts";
import type { RateLimiter } from "../auth/ratelimit.ts";
import { audit } from "../domain/audit.ts";
import { anonymousCrashBytes, decodeCrashReport, listCrashReports, readCrashReport, storeCrashReport } from "../domain/crash-reports.ts";
import type { Router } from "../http/router.ts";
import { HttpError, reply } from "../http/router.ts";

const MAX_MB = CRASH_REPORT_MAX_BYTES / (1024 * 1024);
const REPORT_ID = /^CR-[A-Z]{4}-[A-Z]{4}$/;

/**
 * Crash reports (ADR-077). The program sends one after a crash when the operator has turned crash
 * reports on (or said Send after the crash): with its device token when it is signed in, otherwise
 * anonymously under strict limits. Only staff can list, read and download them.
 */
export function registerCrashReportRoutes(r: Router, app: CloudApp): void {
  /** Hourly limits: the program keeps the report and tries again later, so the message says so. */
  const limit = (limiter: RateLimiter, key: string) => {
    if (!limiter.take(key)) throw new HttpError(429, "rate_limited", "too many crash reports from here this hour; the program keeps this one and sends it later");
  };

  r.add(
    "POST",
    "/v1/crash-reports",
    {
      lazyBody: { maxBytes: CRASH_REPORT_MAX_BYTES },
      browserMutation: false,
      summary: `Program: send a crash report (opt-in): the support file and what crashed, gzip or JSON, at most ${MAX_MB} MB unpacked. Device token when signed in, otherwise anonymous with strict limits`,
    },
    async (ctx) => {
      // A computer signed out on the website still gets its report in, as an anonymous one.
      const device = await app.deviceFrom(ctx.headers.authorization);
      if (device) limit(app.limits.crashDevice, `crash:${device.deviceId}`);
      else {
        limit(app.limits.crashAnonymous, `crash:${ctx.ip}`);
        limit(app.limits.crashAnonymousAll, "all");
        if ((await anonymousCrashBytes(app.sql)) >= app.cfg.crashAnonymousMaxBytes) throw new HttpError(503, "crash_storage_full", "the website isn't taking crash reports from programs that aren't signed in right now; the program keeps this one and sends it later");
      }
      let raw: Buffer;
      try {
        ({ raw } = await ctx.readBody());
      } catch (e) {
        if (e instanceof HttpError && e.code === "too_large") throw new HttpError(413, "too_large", `a crash report can be at most ${MAX_MB} MB`);
        throw e;
      }
      const decoded = decodeCrashReport(raw);
      const out: CrashReportReceipt = await storeCrashReport(app.sql, decoded, { orgId: device?.orgId ?? null, deviceId: device?.deviceId ?? null }, app.now());
      const c = decoded.report.crash;
      if (!out.duplicate) await audit(app.sql, device ? `device:${device.deviceId}` : "anonymous", device?.orgId ?? null, "crash_report.received", { reportId: out.id, process: c.process, reason: c.reason, appVersion: c.appVersion, bytes: decoded.size });
      return reply({ status: out.duplicate ? 200 : 201, json: out });
    },
  );

  // ---------------------------------------------------------------- staff

  const load = async (id: string) => {
    const found = REPORT_ID.test(id) ? await readCrashReport(app.sql, id) : null;
    if (!found) throw new HttpError(404, "not_found", "crash report not found (reports are deleted 90 days after they arrive)");
    return found;
  };

  r.add("GET", "/v1/admin/crash-reports", { summary: "Staff: crash reports sent by programs, newest first (q = id, version, organisation, computer or error; process = main | renderer | hud | engine | native)" }, async (ctx) => {
    await app.requireStaff(ctx);
    const q = (ctx.query.get("q") ?? "").trim().slice(0, 200);
    const proc = CrashProcess.safeParse(ctx.query.get("process"));
    const page = Math.max(1, Math.floor(Number(ctx.query.get("page")) || 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(Number(ctx.query.get("pageSize")) || 25)));
    return { ...(await listCrashReports(app.sql, { q, process: proc.success ? proc.data : null, page, pageSize })), page, pageSize };
  });

  r.add("GET", "/v1/admin/crash-reports/:reportId", { summary: "Staff: one crash report: what crashed, the error and stack, and what the support file holds" }, async (ctx) => {
    await app.requireStaff(ctx);
    const { row, json } = await load(ctx.params.reportId!);
    const report = JSON.parse(json.toString("utf8")) as CrashReportUpload & { crash: CrashDetails };
    const sf = report.supportFile;
    return {
      report: row,
      crash: report.crash,
      supportFile: sf ? { included: true, generatedAt: typeof sf.generatedAt === "string" ? sf.generatedAt : null, sections: Object.keys(sf) } : { included: false, generatedAt: null, sections: [] },
      minidump: report.minidump ? { name: report.minidump.name, size: report.minidump.size } : null,
    };
  });

  r.add("GET", "/v1/admin/crash-reports/:reportId/download", { summary: "Staff: download a crash report as received (JSON with the support file)" }, async (ctx) => {
    const staff = await app.requireStaff(ctx);
    const { row, json } = await load(ctx.params.reportId!);
    await audit(app.sql, staff.id, row.orgId, "admin.crash_report_downloaded", { reportId: row.id, file: "report" });
    return reply({ body: json, contentType: "application/json; charset=utf-8", headers: { "content-disposition": `attachment; filename="matchframe-crash-${row.id}.json"`, "cache-control": "no-store" } });
  });

  r.add("GET", "/v1/admin/crash-reports/:reportId/minidump", { summary: "Staff: download a crash report's minidump (.dmp), when it has one" }, async (ctx) => {
    const staff = await app.requireStaff(ctx);
    const { row, json } = await load(ctx.params.reportId!);
    const dump = (JSON.parse(json.toString("utf8")) as CrashReportUpload).minidump;
    if (!dump) throw new HttpError(404, "not_found", "this crash report has no minidump");
    await audit(app.sql, staff.id, row.orgId, "admin.crash_report_downloaded", { reportId: row.id, file: "minidump" });
    return reply({ body: Buffer.from(dump.base64, "base64"), contentType: "application/octet-stream", headers: { "content-disposition": `attachment; filename="matchframe-crash-${row.id}.dmp"`, "cache-control": "no-store" } });
  });
}
