import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CloudApp, loadCloudConfig, PgliteSql, startCloudServer } from "@matchframe/cloud-api";
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

async function until(fn: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`not in time: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const PASSWORD = "correct horse battery";
const EMAIL = "sync-producer@example.com";
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 9, 9]);
const HUD_ID = "test.website-hud";
const hudZip = () =>
  zipSync({
    "manifest.json": strToU8(JSON.stringify({ manifestVersion: 1, id: HUD_ID, name: "Website HUD", version: "1.0.0", author: "Tester", licence: "MIT", game: "cs2", schemaVersions: [1], entryPoints: { live: "index.html" }, permissions: ["match.public"], settingsSchema: { accent: { type: "color", default: "#ff3300" } } })),
    "index.html": strToU8("<!doctype html><html><body>hud</body></html>"),
  });

/** The desktop sync against the real website API (services/cloud-api on in-process Postgres). */
describe("account sync with the Matchframe website API", () => {
  let cloud: CloudApp;
  let closeCloud: () => Promise<void>;
  let base: string;
  const pcs: { engine: Engine; dataDir: string; api: (path: string, init?: { method?: string; body?: unknown; raw?: Uint8Array; type?: string }) => Promise<{ status: number; json: Record<string, unknown> }>; close: () => Promise<void> }[] = [];

  async function computer(name: string) {
    const ports = { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
    const dataDir = mkdtempSync(join(tmpdir(), "mf-sync-web-"));
    const engine = new Engine(loadConfig({ dataDir, gsiPort: ports.gsi, apiPort: ports.api, overlayPort: ports.overlay, host: "127.0.0.1", captainUiDir: null, hudRendererDir: null, mapPackDir: null, workersDir: null, pythonPath: null, sampleHudsDirs: [], cloudUrl: base, cloudPublicKeys: null, cloudEnforcement: "off" }));
    Object.assign(engine.cloudSync.timing, { tickMs: 50, scanMs: 200, debounceMs: 50, pullMs: 300, statusMs: 1000 });
    await engine.init();
    const servers = await startServers(engine);
    const token = engine.secrets.operatorToken;
    const pc = {
      engine,
      dataDir,
      api: async (path: string, init: { method?: string; body?: unknown; raw?: Uint8Array; type?: string } = {}) => {
        const res = await fetch(`http://127.0.0.1:${ports.api}${path}`, { method: init.method ?? "GET", headers: { authorization: `Bearer ${token}`, "content-type": init.raw ? (init.type ?? "application/zip") : "application/json" }, body: init.raw ? Buffer.from(init.raw) : init.body === undefined ? undefined : JSON.stringify(init.body) });
        return { status: res.status, json: (await res.json()) as Record<string, unknown> };
      },
      close: async () => {
        await servers.close();
        await engine.shutdown();
      },
    };
    pcs.push(pc);
    const login = await pc.api("/api/v1/cloud/login", { method: "POST", body: { email: EMAIL, password: PASSWORD, deviceName: name } });
    expect(login.json).toMatchObject({ status: "signed_in", orgName: "Night League" });
    return pc;
  }

  beforeAll(async () => {
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    cloud = new CloudApp(loadCloudConfig({}, { publicUrl: base, port }), { sql: new PgliteSql(), rateLimitScale: 100 });
    await cloud.init();
    ({ close: closeCloud } = await startCloudServer(cloud));
    const signup = await fetch(`${base}/v1/auth/signup`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ email: EMAIL, password: PASSWORD, displayName: "Producer", orgName: "Night League" }) });
    expect(signup.status).toBe(201);
    const { orgId } = (await signup.json()) as { orgId: string };
    const mail = (await cloud.sql.query<{ body_text: string }>("SELECT body_text FROM outbox_emails WHERE to_addr = $1 ORDER BY id DESC LIMIT 1", [EMAIL])).rows[0]!.body_text;
    const verify = await fetch(`${base}/v1/auth/verify-email`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ token: /token=([A-Za-z0-9_-]+)/.exec(mail)![1] }) });
    expect(verify.status).toBe(200);
    // Pro allows two computers.
    await cloud.sql.query("INSERT INTO subscription_overrides (org_id, plan_id, status, note, created_by) VALUES ($1, 'pro', 'active', 'sync test', 'test')", [orgId]);
  });

  afterAll(async () => {
    for (const pc of pcs) await pc.close();
    await closeCloud?.();
    await cloud?.close();
  });

  it("shares records, a logo and an imported HUD between two signed-in computers, both ways", async () => {
    const a = await computer("Main PC");
    const b = await computer("Observer PC");
    const logo = (await a.api("/api/v1/assets?name=logo.png", { method: "POST", raw: PNG, type: "image/png" })).json.assetId as string;
    const team = (await a.api("/api/v1/teams", { method: "POST", body: { name: "Alpha", shortName: "ALP", logoAssetId: logo } })).json.id as string;
    const player = (await a.api("/api/v1/players", { method: "POST", body: { displayName: "nova", steamId: "76561198000000001" } })).json.id as string;
    await a.api(`/api/v1/teams/${team}/roster`, { method: "POST", body: { playerId: player } });
    expect((await a.api("/api/v1/hud/library/import", { method: "POST", raw: hudZip() })).status).toBe(200);
    await a.api(`/api/v1/hud/library/${HUD_ID}/settings`, { method: "PUT", body: { settings: { accent: "#00ff00" } } });

    await until(() => b.engine.roster.forTeam(team).length === 1 && b.engine.hudLibrary.has(HUD_ID) && b.engine.hudLibrary.entry(HUD_ID).settings.accent === "#00ff00" && existsSync(join(b.dataDir, "assets", logo)), "A's records on B");
    expect(b.engine.teams.get(team)!.data).toMatchObject({ name: "Alpha", logoAssetId: logo });
    expect(b.engine.steamIndex.lookup("76561198000000001")).toBe(player);

    expect((await b.api(`/api/v1/teams/${team}`, { method: "PATCH", body: { name: "Alpha Esports" } })).status).toBe(200);
    await until(() => a.engine.teams.get(team)?.data.name === "Alpha Esports", "B's edit on A");
    await until(() => (a.engine.cloudSync.status().storage?.usedBytes ?? 0) > PNG.length, "storage from the website");
    const st = a.engine.cloudSync.status();
    expect(st).toMatchObject({ linked: true, orgName: "Night League", lastError: null, storage: { quotaBytes: 2 * 1024 ** 3 } });
    expect(st.orgItems).toMatchObject({ team: 1, player: 1, roster: 1, asset: 1, hud: 1 });
  });
});
