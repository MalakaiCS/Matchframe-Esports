import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CRASH_REPORT_MAX_BYTES } from "@matchframe/cloud-contracts";
import type { CrashDetails, CrashReportUpload } from "@matchframe/cloud-contracts";
import { CloudApp } from "../src/app.ts";
import { loadCloudConfig } from "../src/config.ts";
import { PgliteSql } from "../src/db/sql.ts";
import { startCloudServer } from "../src/server.ts";
import { Client, freePort } from "./http.ts";

const PASSWORD = "correct horse battery";
const DAY = 86_400_000;

type ApiError = { error: string; message: string };
type Receipt = { id: string; duplicate: boolean };
interface ListedReport {
  id: string;
  appVersion: string;
  os: string;
  process: string;
  reason: string;
  error: string | null;
  orgId: string | null;
  orgName: string | null;
  deviceName: string | null;
  hasSupportFile: boolean;
  hasMinidump: boolean;
  receivedAt: string;
  expiresAt: string;
}
type ListResponse = { reports: ListedReport[]; total: number; page: number; pageSize: number; storedBytes: number };

describe("crash reports: the program sends them, staff read them, they are deleted after 90 days (/v1/crash-reports)", () => {
  let app: CloudApp;
  let close: () => Promise<void>;
  let base: string;
  let clock = Date.now();

  let admin: Client;
  let customer: Client;
  let deviceToken: string;
  let deviceId: string;
  let orgId: string;

  function crash(over: Partial<CrashDetails> = {}, extra: Partial<CrashReportUpload> = {}): CrashReportUpload {
    return {
      v: 1,
      crash: {
        reportId: randomUUID().replace(/-/g, ""),
        occurredAt: new Date(clock - 5000).toISOString(),
        appVersion: "0.12.4",
        os: { platform: "win32", release: "10.0.22631", arch: "x64" },
        process: "engine",
        reason: "exit code 3",
        error: "Error: the engine stopped\nsecond line",
        stack: "Error: the engine stopped\n    at main (engine.mjs:10:5)",
        uptimeSeconds: 120,
        programUptimeSeconds: 300,
        detail: { exitCode: 3 },
        ...over,
      },
      supportFile: { generatedAt: new Date(clock).toISOString(), app: { version: "0.12.4" }, logs: [{ msg: "engine started" }] },
      minidump: null,
      ...extra,
    };
  }

  const send = (body: CrashReportUpload | Buffer, opts: { token?: string; gzip?: boolean } = {}) => {
    const json = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const payload = opts.gzip ? gzipSync(json) : json;
    // Each report arrives a second after the one before.
    clock += 1000;
    return fetch(`${base}/v1/crash-reports`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(opts.gzip ? { "content-encoding": "gzip" } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
      body: payload,
    }).then(async (r) => ({ status: r.status, data: (await r.json()) as Receipt & ApiError }));
  };

  /** Headers through node:http (a declared length without sending the body), from the signed-in computer. */
  function declared(length: number): Promise<{ status: number; data: ApiError }> {
    return new Promise((resolve, reject) => {
      const req = request(`${base}/v1/crash-reports`, { method: "POST", headers: { "content-type": "application/json", "content-length": String(length), authorization: `Bearer ${deviceToken}` } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({ status: res.statusCode!, data: JSON.parse(Buffer.concat(chunks).toString("utf8")) as ApiError });
          req.destroy();
        });
      });
      req.on("error", reject);
      req.flushHeaders();
    });
  }

  const lastEmail = async (to: string) => (await app.sql.query<{ body_text: string }>("SELECT body_text FROM outbox_emails WHERE to_addr = $1 ORDER BY id DESC LIMIT 1", [to])).rows[0]!;
  async function signup(email: string): Promise<{ client: Client; userId: string; orgId: string }> {
    const client = new Client(base);
    const r = await client.req<{ userId: string; orgId: string }>("POST", "/v1/auth/signup", { email, password: PASSWORD, displayName: email.split("@")[0], orgName: "Northside Broadcast" });
    expect(r.status).toBe(201);
    const token = /token=([A-Za-z0-9_-]+)/.exec((await lastEmail(email)).body_text)![1]!;
    expect((await client.req("POST", "/v1/auth/verify-email", { token })).status).toBe(200);
    return { client, ...r.data };
  }
  const auditActions = async () => (await app.sql.query<{ actor: string; action: string; org_id: string | null; detail: Record<string, unknown> }>("SELECT actor, action, org_id, detail FROM audit_log WHERE action LIKE '%crash%' ORDER BY id")).rows;

  beforeAll(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    // Real limits (scale 1): 3 anonymous reports an hour from one address.
    app = new CloudApp(loadCloudConfig({}, { publicUrl: base, port, staffEmails: ["admin@example.com"] }), { sql: new PgliteSql(), rateLimitScale: 1, now: () => new Date(clock) });
    await app.init();
    ({ close } = await startCloudServer(app));
    admin = (await signup("admin@example.com")).client;
    const owner = await signup("owner@example.com");
    customer = owner.client;
    orgId = owner.orgId;
    const login = await new Client(base, null).req<{ deviceToken: string; deviceId: string }>("POST", "/v1/device/login", { email: "owner@example.com", password: PASSWORD, deviceName: "Production PC", platform: "win32", appVersion: "0.12.4", installId: "install-aaaaaaaaaaaaaaaa" });
    expect(login.status).toBe(200);
    ({ deviceToken, deviceId } = login.data);
  });

  afterAll(async () => {
    await close?.();
    await app?.close();
  });

  // The signed-in computer's hourly limit is tested on its own; the other tests start with it unused.
  beforeEach(() => void app.limits.crashDevice.clear(`crash:${deviceId}`));

  it("takes a signed-in computer's report under its organisation, gzip-compressed, and recognises it when sent again", async () => {
    const r = crash();
    const first = await send(r, { token: deviceToken, gzip: true });
    expect(first.status).toBe(201);
    expect(first.data).toEqual({ id: expect.stringMatching(/^CR-[A-Z]{4}-[A-Z]{4}$/), duplicate: false });

    // The program never heard the answer and sends the same report again: same id, stored once.
    const again = await send(r, { token: deviceToken, gzip: true });
    expect([again.status, again.data]).toEqual([200, { id: first.data.id, duplicate: true }]);
    const { rows } = await app.sql.query<{ org_id: string; device_id: string; process: string; error: string; has_support_file: boolean; report: Uint8Array }>("SELECT org_id, device_id, process, error, has_support_file, report FROM crash_reports");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ org_id: orgId, process: "engine", error: "Error: the engine stopped", has_support_file: true });
    // Stored as received: gzip.
    expect(JSON.parse(gunzipSync(Buffer.from(rows[0]!.report)).toString("utf8"))).toEqual(r);

    expect(await auditActions()).toEqual([{ actor: `device:${rows[0]!.device_id}`, action: "crash_report.received", org_id: orgId, detail: expect.objectContaining({ reportId: first.data.id, process: "engine", appVersion: "0.12.4" }) }]);
  });

  it("refuses what isn't a crash report", async () => {
    expect((await send(Buffer.from("not json"), { token: deviceToken })).data.error).toBe("bad_json");
    expect((await send(Buffer.from([0x1f, 0x8b, 1, 2, 3]), { token: deviceToken })).data.error).toBe("bad_gzip");
    const missing = await send({ ...crash(), crash: { ...crash().crash, process: "toaster" as never } }, { token: deviceToken });
    expect([missing.status, missing.data.error]).toEqual([400, "validation"]);
    const badDump = await send(crash({}, { minidump: { name: "a.dmp", size: 10, base64: "AAAA" } }), { token: deviceToken });
    expect([badDump.status, badDump.data.error]).toEqual([400, "bad_minidump"]);
  });

  it("caps a report at 10 MB, sent or unpacked", async () => {
    const tooBig = await declared(CRASH_REPORT_MAX_BYTES + 1);
    expect([tooBig.status, tooBig.data.error]).toEqual([413, "too_large"]);
    expect(tooBig.data.message).toBe("a crash report can be at most 10 MB");

    // A small gzip that unpacks past the limit is refused without unpacking it all.
    const r = crash();
    const padded = Buffer.from(JSON.stringify({ ...r, supportFile: { pad: "x".repeat(CRASH_REPORT_MAX_BYTES) } }));
    const bomb = await send(padded, { token: deviceToken, gzip: true });
    expect([bomb.status, bomb.data.error]).toEqual([413, "too_large"]);
    expect(bomb.data.message).toBe("a crash report can be at most 10 MB once unpacked");

    // Just under the limit is fine.
    const fits = await send(Buffer.from(JSON.stringify({ ...r, supportFile: { pad: "x".repeat(CRASH_REPORT_MAX_BYTES - 4096) } })), { token: deviceToken, gzip: true });
    expect(fits.status).toBe(201);
  });

  it("takes reports from programs that aren't signed in, under strict limits", async () => {
    const plain = await send(crash({ process: "renderer", reason: "crashed" }));
    expect(plain.status).toBe(201);
    // A computer signed out on the website: its report still arrives, without an organisation.
    const revoked = await send(crash({ process: "hud", reason: "oom" }), { token: "mfd_signed-out-long-ago-0000000000000", gzip: true });
    expect(revoked.status).toBe(201);
    const third = await send(crash({ process: "main", reason: "uncaughtException" }));
    expect(third.status).toBe(201);
    const { rows } = await app.sql.query<{ org_id: string | null; device_id: string | null }>("SELECT org_id, device_id FROM crash_reports WHERE id IN ($1, $2, $3)", [plain.data.id, revoked.data.id, third.data.id]);
    expect(rows).toEqual([0, 1, 2].map(() => ({ org_id: null, device_id: null })));
    expect((await auditActions()).filter((a) => a.actor === "anonymous")).toHaveLength(3);

    // Three an hour from one address.
    const fourth = await send(crash());
    expect([fourth.status, fourth.data.error]).toEqual([429, "rate_limited"]);
    expect(fourth.data.message).toMatch(/sends it later/);
    // A signed-in computer has its own limit.
    expect((await send(crash(), { token: deviceToken })).status).toBe(201);

    // Twenty an hour from all addresses together.
    app.limits.crashAnonymous.clear("crash:127.0.0.1");
    for (let i = 0; i < 20; i++) app.limits.crashAnonymousAll.take("all");
    const busy = await send(crash());
    expect([busy.status, busy.data.error]).toEqual([429, "rate_limited"]);
    app.limits.crashAnonymousAll.clear("all");

    // And not past the anonymous storage limit.
    app.limits.crashAnonymous.clear("crash:127.0.0.1");
    const limit = app.cfg.crashAnonymousMaxBytes;
    app.cfg.crashAnonymousMaxBytes = 1;
    const full = await send(crash());
    expect([full.status, full.data.error]).toEqual([503, "crash_storage_full"]);
    expect((await send(crash(), { token: deviceToken })).status).toBe(201);
    app.cfg.crashAnonymousMaxBytes = limit;
    app.limits.crashAnonymous.clear("crash:127.0.0.1");
  });

  it("limits a signed-in computer to ten reports an hour", async () => {
    for (let i = 0; i < 10; i++) expect((await send(crash({ reason: `exit code ${i}` }), { token: deviceToken, gzip: true })).status).toBe(201);
    const over = await send(crash(), { token: deviceToken, gzip: true });
    expect([over.status, over.data.error]).toEqual([429, "rate_limited"]);
  });

  it("only staff list, read and download crash reports", async () => {
    const dump = Buffer.from("MDMP minidump bytes");
    const sent = await send(crash({ process: "native", reason: "minidump", error: null, stack: null }, { minidump: { name: "1234.dmp", size: dump.length, base64: dump.toString("base64") } }), { token: deviceToken, gzip: true });
    expect(sent.status).toBe(201);
    const id = sent.data.id;

    for (const path of ["/v1/admin/crash-reports", `/v1/admin/crash-reports/${id}`, `/v1/admin/crash-reports/${id}/download`, `/v1/admin/crash-reports/${id}/minidump`]) {
      expect((await new Client(base).req("GET", path)).status, path).toBe(401);
      const r = await customer.req<ApiError>("GET", path);
      expect([r.status, r.data.error], path).toEqual([403, "forbidden"]);
    }

    const list = await admin.req<ListResponse>("GET", "/v1/admin/crash-reports");
    expect(list.status).toBe(200);
    expect(list.data.total).toBe(list.data.reports.length);
    expect(list.data.reports[0]).toMatchObject({ id, appVersion: "0.12.4", os: "win32 10.0.22631", process: "native", reason: "minidump", orgId, orgName: "Northside Broadcast", deviceName: "Production PC", hasMinidump: true, hasSupportFile: true });
    expect(Date.parse(list.data.reports[0]!.expiresAt) - Date.parse(list.data.reports[0]!.receivedAt)).toBe(90 * DAY);
    expect(list.data.storedBytes).toBeGreaterThan(0);
    const anonymous = list.data.reports.find((x) => x.process === "renderer")!;
    expect([anonymous.orgId, anonymous.orgName, anonymous.deviceName]).toEqual([null, null, null]);

    const byProcess = await admin.req<ListResponse>("GET", "/v1/admin/crash-reports?process=hud");
    expect(byProcess.data.reports.map((x) => x.reason)).toEqual(["oom"]);
    expect((await admin.req<ListResponse>("GET", `/v1/admin/crash-reports?q=${id.slice(3)}`)).data.reports.map((x) => x.id)).toEqual([id]);
    expect((await admin.req<ListResponse>("GET", "/v1/admin/crash-reports?q=northside&pageSize=2")).data).toMatchObject({ pageSize: 2, reports: [expect.anything(), expect.anything()] });

    const detail = await admin.req<{ report: ListedReport; crash: CrashDetails; supportFile: { included: boolean; sections: string[] }; minidump: { name: string; size: number } | null }>("GET", `/v1/admin/crash-reports/${id}`);
    expect(detail.data.report.id).toBe(id);
    expect(detail.data.crash).toMatchObject({ process: "native", reason: "minidump", uptimeSeconds: 120, detail: { exitCode: 3 } });
    expect(detail.data.supportFile).toEqual({ included: true, generatedAt: expect.any(String), sections: ["generatedAt", "app", "logs"] });
    expect(detail.data.minidump).toEqual({ name: "1234.dmp", size: dump.length });
    expect((await admin.req("GET", "/v1/admin/crash-reports/CR-NONE-NONE")).status).toBe(404);
    expect((await admin.req("GET", "/v1/admin/crash-reports/not-an-id")).status).toBe(404);

    const file = await fetch(`${base}/v1/admin/crash-reports/${id}/download`, { headers: { cookie: admin.cookie } });
    expect(file.headers.get("content-disposition")).toBe(`attachment; filename="matchframe-crash-${id}.json"`);
    expect(((await file.json()) as CrashReportUpload).crash.process).toBe("native");
    const dmp = await fetch(`${base}/v1/admin/crash-reports/${id}/minidump`, { headers: { cookie: admin.cookie } });
    expect(dmp.headers.get("content-type")).toBe("application/octet-stream");
    expect(Buffer.from(await dmp.arrayBuffer())).toEqual(dump);
    const anonymousDetail = await admin.req<ApiError>("GET", `/v1/admin/crash-reports/${anonymous.id}/minidump`);
    expect([anonymousDetail.status, anonymousDetail.data.message]).toEqual([404, "this crash report has no minidump"]);

    // Support staff too.
    const adminId = (await app.sql.query<{ id: string }>("SELECT id FROM users WHERE email = 'admin@example.com'")).rows[0]!.id;
    const supportUser = await signup("support@example.com");
    expect((await admin.req("PUT", `/v1/admin/users/${supportUser.userId}/staff-role`, { role: "support" })).status).toBe(200);
    expect((await supportUser.client.req("GET", "/v1/admin/crash-reports")).status).toBe(200);

    const downloads = (await auditActions()).filter((a) => a.action === "admin.crash_report_downloaded");
    expect(downloads).toEqual([
      { actor: adminId, action: "admin.crash_report_downloaded", org_id: orgId, detail: { reportId: id, file: "report" } },
      { actor: adminId, action: "admin.crash_report_downloaded", org_id: orgId, detail: { reportId: id, file: "minidump" } },
    ]);
  });

  it("deletes reports 90 days after they arrive", async () => {
    const before = (await admin.req<ListResponse>("GET", "/v1/admin/crash-reports?pageSize=100")).data.total;
    expect(before).toBeGreaterThan(3);
    clock += 60 * DAY;
    const recent = await send(crash({ reason: "exit code 9" }), { token: deviceToken });
    expect(recent.status).toBe(201);

    clock += 31 * DAY;
    expect(await app.purgeCrashReports()).toBe(before);
    // Website sessions last 30 days: sign in again three months on.
    admin = new Client(base);
    expect((await admin.req("POST", "/v1/auth/login", { email: "admin@example.com", password: PASSWORD })).status).toBe(200);
    const after = await admin.req<ListResponse>("GET", "/v1/admin/crash-reports");
    expect(after.data.reports.map((x) => x.id)).toEqual([recent.data.id]);
    expect((await admin.req("GET", `/v1/admin/crash-reports/${after.data.reports[0]!.id}`)).status).toBe(200);
    expect((await auditActions()).filter((a) => a.action === "crash_report.purged")).toEqual([{ actor: "system", action: "crash_report.purged", org_id: null, detail: { count: before, retentionDays: 90 } }]);

    // Nothing more to delete until the next one is 90 days old.
    expect(await app.purgeCrashReports()).toBe(0);
    clock += 60 * DAY;
    expect(await app.purgeCrashReports()).toBe(1);
  });
});
