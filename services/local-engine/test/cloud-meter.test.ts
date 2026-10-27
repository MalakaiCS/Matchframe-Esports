import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EntitlementPayload } from "@matchframe/cloud-contracts";
import { generateSigningKey, signEntitlement } from "@matchframe/cloud-contracts/token";
import { SecretStore } from "../src/auth.ts";
import { CloudLink } from "../src/cloud/link.ts";
import type { MeterInput } from "../src/cloud/meter.ts";
import { AutoDirectorMeter, isBillable, UsageLedger } from "../src/cloud/meter.ts";
import { Database } from "../src/db/database.ts";
import { SettingsRepo } from "../src/db/store.ts";
import { Logger } from "../src/logger.ts";

const live: MeterInput = { accountLinked: true, automationActive: true, controlAvailable: true, mode: "automatic", simulated: false, telemetryLive: true, sessionId: "session_a", mapName: "de_inferno", matchRef: "m1" };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "mf-cloud-"));
  const db = new Database(join(dir, "db.sqlite"));
  db.migrate(join(dir, "backups"));
  const clock = { mono: 0, wall: Date.parse("2026-10-01T12:00:00Z") };
  const ledger = new UsageLedger(db);
  const meter = new AutoDirectorMeter(ledger, { appVersion: "0.1.0", monoNow: () => clock.mono, wallNow: () => clock.wall });
  const advance = (ms: number, input: MeterInput = live, stepMs = 1000) => {
    for (let t = 0; t < ms; t += stepMs) {
      clock.mono += stepMs;
      clock.wall += stepMs;
      meter.tick(input);
    }
  };
  return { dir, db, clock, ledger, meter, advance };
}

describe("auto-director meter", () => {
  it("bills only automation that owns a real camera on live, non-simulated telemetry of a linked computer", () => {
    expect(isBillable(live)).toBe(true);
    expect(isBillable({ ...live, mode: "assisted" })).toBe(true);
    const free: Partial<MeterInput>[] = [{ mode: "advisory" }, { mode: "shadow" }, { mode: "off" }, { mode: "delayed_lookahead" }, { automationActive: false }, { controlAvailable: false }, { simulated: true }, { telemetryLive: false }, { accountLinked: false }];
    for (const change of free) {
      expect(isBillable({ ...live, ...change }), JSON.stringify(change)).toBe(false);
    }
  });

  it("records continuous segments, splits on map/session change and every five minutes, and never bills sleep", () => {
    const { ledger, meter, advance, clock } = setup();
    meter.tick(live);
    advance(12 * 60_000); // 12 minutes on one map -> 5 + 5 + open 2
    expect(ledger.pending().map((r) => r.seconds)).toEqual([300, 300]);
    expect(meter.openSeconds()).toBe(120);
    advance(30_000, { ...live, mapName: "de_mirage" }); // map change closes the open segment at the change tick
    expect(ledger.pending().map((r) => r.seconds)).toEqual([300, 300, 121]);
    advance(30_000, { ...live, mapName: "de_mirage", mode: "advisory" }); // operator drops to advisory: closes, then free
    expect(ledger.pending().at(-1)).toMatchObject({ seconds: 29, mapName: "de_mirage", matchRef: "m1", kind: "auto_director" });
    const before = ledger.stats().pendingSeconds;
    advance(10 * 60_000, { ...live, simulated: true });
    expect(ledger.stats().pendingSeconds).toBe(before);

    // Laptop sleeps for an hour mid-segment: the open segment ends at the last tick before sleep.
    advance(20_000);
    clock.mono += 3_600_000;
    clock.wall += 3_600_000;
    meter.tick(live);
    advance(10_000);
    meter.flush();
    const tail = ledger.pending().slice(-2);
    expect(tail.map((r) => r.seconds)).toEqual([19, 10]);
    for (const r of ledger.pending()) {
      expect(Date.parse(r.endedAt) - Date.parse(r.startedAt)).toBeGreaterThanOrEqual(r.seconds * 1000);
      expect(r.recordId).toMatch(/^[0-9a-f-]{36}$/);
    }
    const total = ledger.pending().reduce((s, r) => s + r.seconds, 0);
    expect(total).toBeLessThanOrEqual(12 * 60 + 60 + 30 + 10);
  });

  it("tracks upload state and abandons records that can no longer be uploaded", () => {
    const { ledger, advance, meter } = setup();
    advance(90_000);
    meter.flush();
    const [rec] = ledger.pending();
    ledger.markUploaded([rec!.recordId], new Date().toISOString());
    expect(ledger.pending()).toHaveLength(0);
    advance(5_000);
    meter.flush();
    expect(ledger.abandonPending("unlinked")).toBe(1);
    expect(ledger.stats()).toMatchObject({ pendingRecords: 0, rejected: 1 });
    expect(ledger.recent(10)[0]).toMatchObject({ rejectedReason: "unlinked" });
  });
});

describe("cloud link (offline licence checks, against a fake website)", () => {
  const key = generateSigningKey();
  const otherKey = generateSigningKey();
  let ctx: ReturnType<typeof setup>;
  let link: CloudLink;
  let settings: SettingsRepo;
  let secrets: SecretStore;
  let wall: Date;
  let served: { token: string | null; keys: Record<string, string>; status: number };
  const calls: string[] = [];

  const payload = (over: Partial<EntitlementPayload> = {}): EntitlementPayload => ({
    v: 1,
    iss: "http://cloud.test",
    kid: key.kid,
    orgId: "org_1",
    orgName: "Org",
    deviceId: "dev_1",
    plan: { id: "pro", name: "Pro" },
    subscriptionStatus: "active",
    features: { autoDirector: true, learnedDirectorShadow: true, fullActionObserver: false, maxDevices: 2, maxMembers: 5 },
    autoDirector: { periodStart: "2026-10-01T00:00:00.000Z", periodEnd: "2026-11-01T00:00:00.000Z", includedSeconds: 7200, creditSeconds: 0, usedSeconds: 0, remainingSeconds: 600, overageAllowed: false },
    issuedAt: wall.toISOString(),
    expiresAt: new Date(wall.getTime() + 86_400_000).toISOString(),
    graceUntil: new Date(wall.getTime() + 7 * 86_400_000).toISOString(),
    ...over,
  });

  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push(`${init?.method ?? "GET"} ${path}`);
    const body = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
    if (path === "/v1/keys") return body({ keys: served.keys });
    if (path === "/v1/device/entitlement") return served.status === 200 ? body({ token: served.token }) : body({ error: "device_revoked", message: "This computer was unlinked." }, served.status);
    if (served.status !== 200) return body({ error: "device_revoked", message: "This computer was unlinked." }, served.status);
    if (path === "/v1/device/usage") {
      const { records } = JSON.parse(String(init?.body)) as { records: { recordId: string }[] };
      return body({ accepted: records.map((r) => r.recordId), duplicates: [], rejected: [] });
    }
    return body({ error: "not_found" }, 404);
  }) as typeof fetch;

  beforeEach(() => {
    ctx = setup();
    wall = new Date(ctx.clock.wall);
    settings = new SettingsRepo(ctx.db);
    secrets = new SecretStore(join(ctx.dir, "secrets.json"), undefined);
    served = { token: null, keys: { [key.kid]: key.publicKeyPem }, status: 200 };
    calls.length = 0;
    link = new CloudLink({ settings, secrets, ledger: ctx.ledger, meter: ctx.meter, logger: new Logger("error", null), appVersion: "0.1.0", enforcement: "required", wallNow: () => wall, fetchImpl: fakeFetch, fixedUrl: "http://cloud.test" });
    settings.set("cloud.link", { deviceId: "dev_1", orgId: "org_1", orgName: "Org", linkedAt: wall.toISOString() });
    secrets.setSecret("cloud.deviceToken", "mfd_test");
  });

  afterEach(() => link.stopBackground());

  it("arms from a verified licence, works offline through the grace window, then refuses", async () => {
    served.token = signEntitlement(payload(), key.privateKeyPem);
    expect(link.canArm(false)).toMatchObject({ ok: false, code: "no_entitlement" });
    await link.refresh();
    expect(calls).toEqual(["POST /v1/device/entitlement", "GET /v1/keys"]); // nothing to upload; unknown key -> fetched once
    expect(link.canArm(false)).toEqual({ ok: true });
    wall = new Date(wall.getTime() + 3 * 86_400_000); // offline for three days
    expect(link.status(false).entitlement?.state).toBe("grace");
    expect(link.canArm(false)).toEqual({ ok: true });
    wall = new Date(wall.getTime() + 5 * 86_400_000);
    expect(link.canArm(false)).toMatchObject({ ok: false, code: "entitlement_expired" });
    expect(link.canArm(true)).toMatchObject({ ok: true, free: true }); // simulation is always free
  });

  it("subtracts local usage recorded since the licence was issued and blocks re-arming at zero", async () => {
    served.token = signEntitlement(payload(), key.privateKeyPem);
    await link.refresh();
    ctx.advance(400_000); // billing starts at the first tick: 300 s recorded + 99 s open
    expect(link.status(false).entitlement?.localRemainingSeconds).toBe(600 - 300 - 99);
    wall = new Date(ctx.clock.wall);
    ctx.advance(202_000); // crosses the next five-minute rollover: 600 s recorded, ~0 open
    expect(link.status(false).entitlement?.localRemainingSeconds).toBeLessThanOrEqual(0);
    expect(link.canArm(false)).toMatchObject({ ok: false, code: "hours_exhausted" });
    const sync = await link.sync();
    expect(sync?.accepted).toHaveLength(2);
    expect(ctx.ledger.stats().pendingRecords).toBe(0);
  });

  it("rejects forged, foreign-device and plan-excluded licences; honours pinned keys", async () => {
    served.token = signEntitlement(payload({ kid: otherKey.kid }), otherKey.privateKeyPem);
    await link.refresh(); // other key is not published by the website
    expect(link.lastError).toMatch(/unknown_key/);
    served.token = signEntitlement(payload({ deviceId: "dev_other" }), key.privateKeyPem);
    await link.refresh();
    expect(link.lastError).toMatch(/wrong_device/);
    served.token = signEntitlement(payload({ features: { autoDirector: false, learnedDirectorShadow: false, fullActionObserver: false, maxDevices: 1, maxMembers: 1 } }), key.privateKeyPem);
    await link.refresh();
    expect(link.canArm(false)).toMatchObject({ ok: false, code: "plan_excludes" });

    // A build with pinned keys never trusts keys served by the website.
    const pinned = new CloudLink({ settings, secrets, ledger: ctx.ledger, meter: ctx.meter, logger: new Logger("error", null), appVersion: "0.1.0", enforcement: "required", wallNow: () => wall, fetchImpl: fakeFetch, fixedUrl: "http://cloud.test", pinnedKeys: { [otherKey.kid]: otherKey.publicKeyPem } });
    served.token = signEntitlement(payload(), key.privateKeyPem);
    calls.length = 0;
    expect(await pinned.refresh()).toBeNull();
    expect(calls).not.toContain("GET /v1/keys");
    expect(pinned.lastError).toMatch(/unknown_key/);
  });

  it("treats a revoked credential as unlinked and abandons usage it can no longer upload", async () => {
    ctx.advance(10_000);
    ctx.meter.flush();
    served.status = 401;
    await link.refresh();
    expect(link.link).toBeNull();
    expect(secrets.getSecret("cloud.deviceToken")).toBeUndefined();
    expect(link.status(false).linkState).toBe("revoked");
    expect(link.canArm(false)).toMatchObject({ ok: false, code: "not_linked" });
    expect(ctx.ledger.stats()).toMatchObject({ pendingRecords: 0, rejected: 1 });
  });

  it("enforcement off (development builds) never blocks", () => {
    const off = new CloudLink({ settings, secrets, ledger: ctx.ledger, meter: ctx.meter, logger: new Logger("error", null), appVersion: "0.1.0", enforcement: "off", fetchImpl: fakeFetch });
    expect(off.canArm(false)).toMatchObject({ ok: true, free: true });
  });
});
