import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CloudApp, loadCloudConfig, PgliteSql, startCloudServer } from "@matchframe/cloud-api";
import { buildSyntheticGsiPayload, syntheticRoster } from "@matchframe/cs2-state";
import { Engine } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { startServers } from "../src/servers.ts";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

async function until(fn: () => boolean, timeoutMs = 15000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Website session (cookie + same-origin header), as the browser would send. */
class Browser {
  cookie = "";
  constructor(private readonly base: string) {}
  async req<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const res = await fetch(this.base + path, { method, headers: { "content-type": "application/json", origin: this.base, ...(this.cookie ? { cookie: this.cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) this.cookie = c.split(";")[0]!;
    return { status: res.status, data: (await res.json()) as T };
  }
}

const roster = syntheticRoster().map((pl, i) => ({ ...pl, position: { x: i * 120, y: 40, z: 0 }, forward: { x: 1, y: 0, z: 0 } }));

describe("desktop engine <-> Matchframe website (real servers on both sides)", () => {
  let cloud: CloudApp;
  let closeCloud: () => Promise<void>;
  let cloudBase: string;
  let engine: Engine;
  let closeEngine: () => Promise<void>;
  let ports: { gsi: number; api: number; overlay: number };
  let api: (path: string, init?: RequestInit) => Promise<{ status: number; data: Record<string, unknown> }>;
  let owner: Browser;
  let staff: Browser;
  let orgId: string;
  let ts = 1_700_000_000;

  const gsi = (mapName = "de_inferno") => fetch(`http://127.0.0.1:${ports.gsi}/gsi`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(buildSyntheticGsiPayload({ players: roster, token: engine.secrets.gsiToken, timestamp: ++ts, mapName, mapPhase: "live", roundPhase: "live", observed: roster[0]!.steamId })) });
  const lastEmail = async (to: string) => (await cloud.sql.query<{ body_text: string }>("SELECT body_text FROM outbox_emails WHERE to_addr = $1 ORDER BY id DESC LIMIT 1", [to])).rows[0]!.body_text;
  const signup = async (email: string, orgName: string) => {
    const b = new Browser(cloudBase);
    const r = await b.req<{ orgId: string }>("POST", "/v1/auth/signup", { email, password: "correct horse battery", displayName: "Producer", orgName });
    expect(r.status).toBe(201);
    expect((await b.req("POST", "/v1/auth/verify-email", { token: /token=([A-Za-z0-9_-]+)/.exec(await lastEmail(email))![1] })).status).toBe(200);
    return { browser: b, orgId: r.data.orgId };
  };
  const addUsage = (seconds: number) => {
    const end = Date.now() - 1000;
    engine.usageLedger.add({ recordId: randomUUID(), kind: "auto_director", startedAt: new Date(end - seconds * 1000).toISOString(), endedAt: new Date(end).toISOString(), seconds, sessionId: engine.session.sessionId, matchRef: null, mapName: "de_inferno", appVersion: "0.1.0" });
  };
  const arm = () => api("/api/v1/observer/resume", { method: "POST", body: JSON.stringify({ countdownMs: 0 }) });

  beforeAll(async () => {
    const cloudPort = await freePort();
    cloudBase = `http://127.0.0.1:${cloudPort}`;
    cloud = new CloudApp(loadCloudConfig({}, { publicUrl: cloudBase, port: cloudPort, staffEmails: ["staff@example.com"] }), { sql: new PgliteSql(), rateLimitScale: 100 });
    await cloud.init();
    ({ close: closeCloud } = await startCloudServer(cloud));

    ports = { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    const dataDir = mkdtempSync(join(tmpdir(), "mf-engine-cloud-"));
    engine = new Engine(loadConfig({ dataDir, gsiPort: ports.gsi, apiPort: ports.api, overlayPort: ports.overlay, host: "127.0.0.1", operatorUiDir: null, hudRendererDir: null, mapPackDir: null, workersDir: null, pythonPath: null, cloudUrl: cloudBase, cloudPublicKeys: null, cloudEnforcement: "required" }));
    await engine.init();
    const servers = await startServers(engine);
    closeEngine = async () => {
      await servers.close();
      await engine.shutdown();
    };
    const token = engine.secrets.operatorToken;
    api = async (path, init = {}) => {
      const res = await fetch(`http://127.0.0.1:${ports.api}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
      return { status: res.status, data: (await res.json()) as Record<string, unknown> };
    };
    ({ browser: owner, orgId } = await signup("producer@example.com", "Night League"));
    ({ browser: staff } = await signup("staff@example.com", "Matchframe Staff"));
  });

  afterAll(async () => {
    await closeEngine?.();
    await closeCloud?.();
    await cloud?.close();
  });

  it("without an account: HUD data and manual control work; automatic direction on live telemetry cannot be armed", async () => {
    expect((await gsi()).status).toBe(200);
    expect(engine.session.state()?.simulated).toBe(false);
    expect((await api("/api/v1/hud/outputs/main/state")).status).toBe(200);
    // Choosing a mode while manual is not arming; resuming automation is.
    expect((await api("/api/v1/director/mode", { method: "POST", body: JSON.stringify({ mode: "automatic" }) })).status).toBe(200);
    const blocked = await arm();
    expect(blocked.status).toBe(402);
    expect(blocked.data.error).toBe("not_linked");
    expect(engine.session.arbiter.automationAllowed).toBe(false);
    const st = await api("/api/v1/cloud/status");
    expect(st.data).toMatchObject({ url: cloudBase, linkState: "unlinked", enforcement: "required", gate: { ok: false, code: "not_linked" } });
    expect(((await api("/api/v1/audit")).data as unknown as { action: string }[]).some((a) => a.action === "observer.resume")).toBe(false);
  });

  it("links with a device code approved on the website, verifies the signed licence offline, and arms", async () => {
    const start = await api("/api/v1/cloud/link/start", { method: "POST", body: JSON.stringify({ deviceName: "Observer PC" }) });
    expect(start.status).toBe(200);
    const userCode = start.data.userCode as string;
    expect(userCode).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    expect(start.data.verificationUriComplete).toBe(`${cloudBase}/link?code=${userCode}`);
    expect(((await api("/api/v1/cloud/status")).data as { linkState: string }).linkState).toBe("linking");

    const preview = await owner.req<{ deviceName: string }>("GET", `/v1/device-link/${userCode}`);
    expect(preview.data.deviceName).toBe("Observer PC");
    expect((await owner.req("POST", "/v1/device-link/approve", { userCode, orgId })).status).toBe(200);
    if ((await engine.cloud.pollOnce()) !== "linked") await until(() => engine.cloud.link !== null);

    const st = (await api("/api/v1/cloud/status")).data as { linkState: string; device: { orgName: string }; entitlement: { state: string; plan: { id: string }; autoDirector: { remainingSeconds: number } }; gate: { ok: boolean } };
    expect(st.linkState).toBe("linked");
    expect(st.device.orgName).toBe("Night League");
    expect(st.entitlement).toMatchObject({ state: "valid", plan: { id: "free" }, autoDirector: { remainingSeconds: 7200 } });
    expect(st.gate.ok).toBe(true);
    // The device credential is kept in the secret store, never in settings or the status payload.
    expect(JSON.stringify(st)).not.toMatch(/mfd_/);
    expect(engine.settings.get<string | null>("cloud.deviceToken", null)).toBeNull();
    expect(engine.secrets.getSecret("cloud.deviceToken")).toMatch(/^mfd_/);

    expect((await arm()).status).toBe(200);
    expect(engine.session.arbiter.automationAllowed).toBe(true);
    const devices = await owner.req<{ name: string; platform: string }[]>("GET", `/v1/orgs/${orgId}/devices`);
    expect(devices.data.map((d) => d.name)).toEqual(["Observer PC"]);
  });

  it("uploads metered hours, blocks re-arming when the allowance is used, and re-arms after hours are added", async () => {
    addUsage(7140);
    expect(engine.cloud.canArm(false)).toEqual({ ok: true }); // 60 s left locally
    addUsage(120);
    expect(engine.cloud.canArm(false)).toMatchObject({ ok: false, code: "hours_exhausted" });
    // Running automation is never cut: it stays armed; only (re-)arming is refused.
    expect(engine.session.arbiter.automationAllowed).toBe(true);
    await api("/api/v1/observer/takeover", { method: "POST" });
    const refused = await arm();
    expect([refused.status, refused.data.error]).toEqual([402, "hours_exhausted"]);

    const refreshed = (await api("/api/v1/cloud/refresh", { method: "POST" })).data as { usage: { pendingRecords: number }; entitlement: { autoDirector: { usedSeconds: number; remainingSeconds: number } } };
    expect(refreshed.usage.pendingRecords).toBe(0);
    expect(refreshed.entitlement.autoDirector).toMatchObject({ usedSeconds: 7260, remainingSeconds: -60 });
    const usage = await owner.req<{ allowance: { usedSeconds: number }; byDevice: { name: string; seconds: number }[] }>("GET", `/v1/orgs/${orgId}/usage`);
    expect(usage.data.allowance.usedSeconds).toBe(7260);
    expect(usage.data.byDevice[0]).toMatchObject({ name: "Observer PC", seconds: 7260 });

    // Support adds an hour on the website (an hour pack purchase grants credits the same way).
    expect((await staff.req("POST", `/v1/admin/orgs/${orgId}/credits`, { hours: 1, note: "league trial extension" })).status).toBe(200);
    await api("/api/v1/cloud/refresh", { method: "POST" });
    expect(engine.cloud.status(false).entitlement?.autoDirector.remainingSeconds).toBe(3540);
    expect((await arm()).status).toBe(200);
  });

  it("never stops automation mid-map; hands the camera back at the next map when hours are used up", async () => {
    expect(engine.session.arbiter.automationAllowed).toBe(true);
    addUsage(3600);
    expect(engine.cloud.canArm(false)).toMatchObject({ ok: false, code: "hours_exhausted" });
    expect((await gsi("de_inferno")).status).toBe(200);
    expect(engine.session.arbiter.automationAllowed).toBe(true);
    expect((await gsi("de_mirage")).status).toBe(200);
    await until(() => !engine.session.arbiter.automationAllowed);
    expect(engine.session.director.currentMode).toBe("advisory");
    const audit = (await api("/api/v1/audit")).data as unknown as { action: string; target: string | null }[];
    expect(audit.find((a) => a.action === "cloud.allowance_takeover")).toBeTruthy();
    // Simulation stays free and armable regardless of the allowance.
    expect(engine.cloud.canArm(true)).toMatchObject({ ok: true });
  });

  it("a computer unlinked on the website stops refreshing its licence and cannot arm again", async () => {
    const deviceId = engine.cloud.link!.deviceId;
    expect((await owner.req("DELETE", `/v1/orgs/${orgId}/devices/${deviceId}`)).status).toBe(200);
    const st = (await api("/api/v1/cloud/refresh", { method: "POST" })).data as { linkState: string; gate: { code: string } };
    expect(st.linkState).toBe("revoked");
    expect(st.gate.code).toBe("not_linked");
    expect(engine.secrets.getSecret("cloud.deviceToken")).toBeUndefined();
    expect((await api("/api/v1/director/mode", { method: "POST", body: JSON.stringify({ mode: "automatic" }) })).status).toBe(200);
    const refused = await arm();
    expect([refused.status, refused.data.error]).toEqual([402, "not_linked"]);
  });
});
