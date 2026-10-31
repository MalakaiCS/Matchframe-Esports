import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HudLibraryEntry } from "@matchframe/contracts";
import { Engine } from "../src/app.ts";
import type { SyncView } from "../src/cloud/sync.ts";
import { loadConfig } from "../src/config.ts";
import { startServers } from "../src/servers.ts";
import type { FakeDevice } from "./helpers/fake-sync-cloud.ts";
import { FakeSyncCloud } from "./helpers/fake-sync-cloud.ts";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(fn: () => boolean | Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`not in time: ${what}`);
    await sleep(40);
  }
}

const NOVA = "76561198000000001";
const KITE = "76561198000000002";
const ZETA = "76561198000000003";
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 1, 2, 3, 4]);
const POOL = ["de_ancient", "de_anubis", "de_dust2", "de_inferno", "de_mirage", "de_nuke", "de_train"];
const BO1 = { bestOf: 1, regulationRounds: 24, overtimeEnabled: true, overtimeRounds: 6, allowTie: false };
const HUD_ID = "test.shared-hud";
const hudZip = () =>
  zipSync({
    "manifest.json": strToU8(
      JSON.stringify({
        manifestVersion: 1,
        id: HUD_ID,
        name: "Shared HUD",
        version: "1.0.0",
        author: "Tester",
        licence: "MIT",
        game: "cs2",
        schemaVersions: [1],
        entryPoints: { live: "index.html" },
        permissions: ["match.public"],
        settingsSchema: { accent: { type: "color", label: "Accent", default: "#ff3300" }, title: { type: "string", default: "Hello" } },
      }),
    ),
    "index.html": strToU8("<!doctype html><html><body><script src='app.js'></script></body></html>"),
    "app.js": strToU8("console.log('shared hud')"),
  });

interface Pc {
  engine: Engine;
  dataDir: string;
  apiPort: number;
  api: <T = Record<string, unknown>>(path: string, init?: { method?: string; body?: unknown; raw?: Uint8Array; type?: string }) => Promise<{ status: number; json: T }>;
  link: () => void;
  sync: () => SyncView;
  close: () => Promise<void>;
}

const ORG = { orgId: "org_night", orgName: "Night League" };

async function boot(cloud: FakeSyncCloud, device: FakeDevice, opts: { linked?: boolean; samples?: boolean } = {}): Promise<Pc> {
  const ports = { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
  const dataDir = mkdtempSync(join(tmpdir(), `mf-sync-${device.deviceId}-`));
  const engine = new Engine(
    loadConfig({
      dataDir,
      gsiPort: ports.gsi,
      apiPort: ports.api,
      overlayPort: ports.overlay,
      host: "127.0.0.1",
      captainUiDir: null,
      hudRendererDir: null,
      mapPackDir: null,
      workersDir: null,
      pythonPath: null,
      sampleHudsDirs: opts.samples ? [join(import.meta.dirname, "..", "..", "..", "assets", "hud-packages")] : [],
      cloudUrl: cloud.base,
      cloudPublicKeys: null,
      cloudEnforcement: "off",
    }),
  );
  const link = () => {
    engine.secrets.setSecret("cloud.deviceToken", device.token);
    engine.settings.set("cloud.link", { deviceId: device.deviceId, ...ORG, linkedAt: new Date().toISOString(), method: "code" });
  };
  if (opts.linked !== false) link();
  Object.assign(engine.cloudSync.timing, { tickMs: 40, scanMs: 150, debounceMs: 40, pullMs: 200, statusMs: 800, backoffMs: 100, backoffMaxMs: 300 });
  await engine.init();
  const servers = await startServers(engine);
  const token = engine.secrets.operatorToken;
  return {
    engine,
    dataDir,
    apiPort: ports.api,
    link,
    sync: () => engine.cloudSync.status(),
    api: async (path, init = {}) => {
      const res = await fetch(`http://127.0.0.1:${ports.api}${path}`, {
        method: init.method ?? "GET",
        headers: { authorization: `Bearer ${token}`, "content-type": init.raw ? (init.type ?? "application/zip") : "application/json" },
        body: init.raw ? Buffer.from(init.raw) : init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      const text = await res.text();
      return { status: res.status, json: (text ? JSON.parse(text) : null) as never };
    },
    close: async () => {
      await servers.close();
      await engine.shutdown();
    },
  };
}

describe("account sync between computers of one organisation (in-process website)", () => {
  const devices: FakeDevice[] = [
    { token: "tok-a", deviceId: "dev_a", deviceName: "Main PC" },
    { token: "tok-b", deviceId: "dev_b", deviceName: "Observer PC" },
    { token: "tok-c", deviceId: "dev_c", deviceName: "Studio PC" },
  ];
  const cloud = new FakeSyncCloud(devices);
  let A: Pc;
  let B: Pc;
  let C: Pc | null = null;
  const id: Record<string, string> = {};

  /** Both computers have sent everything and the website's changes stopped. */
  const settle = async (pcs: Pc[] = [A, B]) => {
    let last = -1;
    await until(async () => {
      const quiet = pcs.every((pc) => pc.sync().pending === 0) && cloud.seq === last;
      last = cloud.seq;
      if (!quiet) await sleep(250);
      return quiet;
    }, "both computers in step");
  };

  beforeAll(async () => {
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    await cloud.start();
    A = await boot(cloud, devices[0]!, { samples: true });
    B = await boot(cloud, devices[1]!);
  });

  afterAll(async () => {
    await C?.close();
    await B?.close();
    await A?.close();
    await cloud.close();
  });

  it("a team, player, roster, event and match (maps, veto) with a logo made on A appear on B, and nothing is sent back", async () => {
    const asset = await A.api<{ assetId: string }>("/api/v1/assets?name=logo.png", { method: "POST", raw: PNG, type: "image/png" });
    expect(asset.status).toBe(200);
    id.logo = asset.json.assetId;
    id.alpha = (await A.api<{ id: string }>("/api/v1/teams", { method: "POST", body: { name: "Alpha", shortName: "ALP", logoAssetId: id.logo } })).json.id;
    id.bravo = (await A.api<{ id: string }>("/api/v1/teams", { method: "POST", body: { name: "Bravo", shortName: "BRV" } })).json.id;
    id.nova = (await A.api<{ id: string }>("/api/v1/players", { method: "POST", body: { displayName: "nova", steamId: NOVA } })).json.id;
    id.kite = (await A.api<{ id: string }>("/api/v1/players", { method: "POST", body: { displayName: "kite", steamId: KITE } })).json.id;
    expect((await A.api(`/api/v1/teams/${id.alpha}/roster`, { method: "POST", body: { playerId: id.nova } })).status).toBe(200);
    expect((await A.api(`/api/v1/teams/${id.bravo}/roster`, { method: "POST", body: { playerId: id.kite } })).status).toBe(200);
    id.event = (await A.api<{ id: string }>("/api/v1/events", { method: "POST", body: { name: "Night Cup", logoAssetId: id.logo } })).json.id;
    id.match = (await A.api<{ id: string }>("/api/v1/matches", { method: "POST", body: { eventId: id.event, teamAId: id.alpha, teamBId: id.bravo, format: BO1, mapPool: POOL } })).json.id;
    expect((await A.api(`/api/v1/veto/${id.match}/act`, { method: "POST", body: { stepOrder: 1, teamId: id.alpha, mapName: "de_inferno" } })).status).toBe(200);
    expect((await A.api(`/api/v1/matches/${id.match}/maps`, { method: "PUT", body: { maps: [{ order: 1, mapName: "de_mirage", pickedByTeamId: null, startingCtTeamId: null, status: "upcoming" }] } })).status).toBe(200);

    const b = B.engine;
    await until(
      () => !!b.matches.get(id.match!) && b.mapInstances.forMatch(id.match!).length === 1 && b.vetoRepo.active(id.match!).length === 1 && b.roster.forTeam(id.bravo!).length === 1 && !!b.events.get(id.event!) && existsSync(join(B.dataDir, "assets", id.logo!)),
      "A's records on B",
    );
    const team = await B.api<{ name: string; logoAssetId: string; roster: { player: { displayName: string } }[] }>(`/api/v1/teams/${id.alpha}`);
    expect(team.json).toMatchObject({ name: "Alpha", logoAssetId: id.logo, roster: [{ player: { displayName: "nova" } }] });
    expect(b.steamIndex.lookup(NOVA)).toBe(id.nova);
    expect(b.matches.get(id.match!)!.data).toMatchObject({ eventId: id.event, teamAId: id.alpha, teamBId: id.bravo });
    expect(b.mapInstances.forMatch(id.match!)[0]!.mapName).toBe("de_mirage");
    expect(b.vetoRepo.active(id.match!)[0]).toMatchObject({ teamId: id.alpha, mapName: "de_inferno" });
    expect((await fetch(`http://127.0.0.1:${B.apiPort}/assets/${id.logo}`)).status).toBe(200);

    // Echo: once in step, nothing more is sent.
    await settle();
    const seq = cloud.seq;
    await sleep(800);
    expect(cloud.seq).toBe(seq);
    // The bundled sample HUD and the built-in HUD are not shared.
    expect(cloud.live("hud")).toEqual([]);
    await until(() => (A.sync().storage?.usedBytes ?? 0) === PNG.length, "storage on A");
    const st = await B.api<SyncView>("/api/v1/cloud/sync");
    expect(st.json).toMatchObject({ enabled: true, linked: true, orgName: "Night League", pending: 0, lastError: null, counts: { team: 2, player: 2, roster: 2, event: 1, match: 1, map: 1, veto: 1, asset: 1 } });
  });

  it("an edit on B reaches A", async () => {
    expect((await B.api(`/api/v1/teams/${id.alpha}`, { method: "PATCH", body: { name: "Alpha Esports" } })).status).toBe(200);
    await until(() => A.engine.teams.get(id.alpha!)?.data.name === "Alpha Esports", "B's edit on A");
  });

  it("deletions propagate (an event, a match's maps)", async () => {
    const spare = (await A.api<{ id: string }>("/api/v1/events", { method: "POST", body: { name: "Spare" } })).json.id;
    await until(() => !!B.engine.events.get(spare), "event on B");
    expect((await A.api(`/api/v1/events/${spare}`, { method: "DELETE" })).status).toBe(200);
    expect((await A.api(`/api/v1/matches/${id.match}/maps`, { method: "PUT", body: { maps: [] } })).status).toBe(200);
    await until(() => !B.engine.events.get(spare) && B.engine.mapInstances.forMatch(id.match!).length === 0, "deletions on B");
    expect(cloud.items.get(`event:${spare}`)?.data).toBeNull();
  });

  it("an imported HUD installs on B with its settings; a settings change on A reaches B without uploading the package again", async () => {
    const imp = await A.api<HudLibraryEntry>("/api/v1/hud/library/import", { method: "POST", raw: hudZip() });
    expect(imp.status).toBe(200);
    expect((await A.api(`/api/v1/hud/library/${HUD_ID}/settings`, { method: "PUT", body: { settings: { accent: "#00ff00", title: "Final" } } })).status).toBe(200);
    await until(() => B.engine.hudLibrary.has(HUD_ID) && B.engine.hudLibrary.entry(HUD_ID).settings.accent === "#00ff00", "HUD on B");
    const onB = B.engine.hudLibrary.entry(HUD_ID);
    expect(onB).toMatchObject({ kind: "imported", version: "1.0.0", name: "Shared HUD", settings: { accent: "#00ff00", title: "Final" } });
    // Each computer keeps its own HUD token (its OBS URLs).
    const tokenB = new URL(onB.urls.live!).searchParams.get("t");
    expect(tokenB).not.toBe(new URL(imp.json.urls.live!).searchParams.get("t"));
    expect(cloud.live("hud").map((h) => h.id)).toEqual([HUD_ID]);

    const uploads = cloud.count("PUT", "/v1/sync/blobs/");
    expect((await A.api(`/api/v1/hud/library/${HUD_ID}/settings`, { method: "PUT", body: { settings: { accent: "#0000ff", title: "Final" } } })).status).toBe(200);
    await until(() => B.engine.hudLibrary.entry(HUD_ID).settings.accent === "#0000ff", "settings change on B");
    expect(cloud.count("PUT", "/v1/sync/blobs/")).toBe(uploads);
    expect(new URL(B.engine.hudLibrary.entry(HUD_ID).urls.live!).searchParams.get("t")).toBe(tokenB);
    // The export is the same package as the shared one.
    await settle();
    const shared = cloud.items.get(`hud:${HUD_ID}`)!.blobs[0]!;
    const exported = await fetch(`http://127.0.0.1:${A.apiPort}/api/v1/hud/library/${HUD_ID}/export`, { headers: { authorization: `Bearer ${A.engine.secrets.operatorToken}` } });
    expect(cloud.blobs.get(shared)).toEqual(Buffer.from(await exported.arrayBuffer()));
  });

  it("a HUD removed on B is removed on A", async () => {
    expect((await B.api(`/api/v1/hud/library/${HUD_ID}`, { method: "DELETE" })).status).toBe(200);
    await until(() => !A.engine.hudLibrary.has(HUD_ID), "HUD removed on A");
    expect(cloud.items.get(`hud:${HUD_ID}`)?.data).toBeNull();
  });

  it("edits made while the website is down are kept and shared when it is back", async () => {
    cloud.online = false;
    expect((await A.api(`/api/v1/players/${id.nova}`, { method: "PATCH", body: { displayName: "nova2" } })).status).toBe(200);
    await until(() => A.sync().state === "offline" && A.sync().pending > 0, "A offline with a change waiting");
    expect(A.sync().lastError).toMatch(/Cannot reach the Matchframe website/);
    expect(B.engine.players.get(id.nova!)!.data.displayName).toBe("nova");
    cloud.online = true;
    await until(() => B.engine.players.get(id.nova!)?.data.displayName === "nova2", "offline edit on B");
    await until(() => A.sync().lastError === null, "A back online");
  });

  it("a conflict resolves by the last edit", async () => {
    cloud.online = false;
    expect((await A.api(`/api/v1/teams/${id.bravo}`, { method: "PATCH", body: { name: "Bravo A" } })).status).toBe(200);
    await sleep(30);
    expect((await B.api(`/api/v1/teams/${id.bravo}`, { method: "PATCH", body: { name: "Bravo B" } })).status).toBe(200);
    await sleep(300);
    cloud.online = true;
    await until(() => A.engine.teams.get(id.bravo!)?.data.name === "Bravo B" && B.engine.teams.get(id.bravo!)?.data.name === "Bravo B", "B's later edit on both");
    await settle();
    expect(A.engine.teams.get(id.bravo!)!.data.name).toBe("Bravo B");
    expect(cloud.items.get(`team:${id.bravo}`)!.data!.name).toBe("Bravo B");
  });

  it("a change another computer made between this computer's fetch and send wins when it is later (stale)", async () => {
    let injected = false;
    cloud.beforePush = (changes) => {
      if (injected || !changes.some((c) => c.kind === "team" && c.id === id.bravo)) return;
      injected = true;
      cloud.put({ kind: "team", id: id.bravo!, data: { ...A.engine.teams.get(id.bravo!)!.data, name: "Bravo C", archived: false }, blobs: [], editedAt: new Date(Date.now() + 60_000).toISOString() });
    };
    expect((await A.api(`/api/v1/teams/${id.bravo}`, { method: "PATCH", body: { name: "Bravo D" } })).status).toBe(200);
    await until(() => injected && A.engine.teams.get(id.bravo!)?.data.name === "Bravo C" && B.engine.teams.get(id.bravo!)?.data.name === "Bravo C", "the later edit on both");
    cloud.beforePush = null;
    await settle();
    expect(cloud.items.get(`team:${id.bravo}`)!.data!.name).toBe("Bravo C");
  });

  it("the switch turns sharing off on one computer, and Sync now catches up", async () => {
    expect((await B.api<SyncView>("/api/v1/cloud/sync", { method: "POST", body: { enabled: false } })).json).toMatchObject({ enabled: false, state: "off" });
    expect((await A.api(`/api/v1/events/${id.event}`, { method: "PATCH", body: { name: "Night Cup Finals" } })).status).toBe(200);
    await until(() => cloud.items.get(`event:${id.event}`)?.data?.name === "Night Cup Finals", "A's edit shared");
    await sleep(500);
    expect(B.engine.events.get(id.event!)!.data.name).toBe("Night Cup");
    expect((await B.api("/api/v1/cloud/sync/now", { method: "POST" })).status).toBe(409);
    expect((await B.api("/api/v1/cloud/sync", { method: "POST", body: { enabled: true } })).status).toBe(200);
    const now = await B.api<SyncView>("/api/v1/cloud/sync/now", { method: "POST" });
    expect(now.status).toBe(200);
    expect(now.json.lastSyncAt).not.toBeNull();
    expect(B.engine.events.get(id.event!)!.data.name).toBe("Night Cup Finals");
  });

  it("a computer that already has data merges its duplicates into the organisation's and shares the rest", async () => {
    C = await boot(cloud, devices[2]!, { linked: false });
    const c = C;
    const bravoLocal = (await c.api<{ id: string }>("/api/v1/teams", { method: "POST", body: { name: "BRAVO-C", shortName: "BC" } })).json.id;
    const charlie = (await c.api<{ id: string }>("/api/v1/teams", { method: "POST", body: { name: "Charlie", shortName: "CHA" } })).json.id;
    const kiteLocal = (await c.api<{ id: string }>("/api/v1/players", { method: "POST", body: { displayName: "Kite", realName: "Kite Local", steamId: KITE } })).json.id;
    const zeta = (await c.api<{ id: string }>("/api/v1/players", { method: "POST", body: { displayName: "zeta", steamId: ZETA } })).json.id;
    await c.api(`/api/v1/teams/${bravoLocal}/roster`, { method: "POST", body: { playerId: kiteLocal } });
    await c.api(`/api/v1/teams/${charlie}/roster`, { method: "POST", body: { playerId: zeta } });
    const match = (await c.api<{ id: string }>("/api/v1/matches", { method: "POST", body: { eventId: null, teamAId: bravoLocal, teamBId: charlie, format: BO1, mapPool: POOL } })).json.id;
    await sleep(300);
    // Not linked: nothing is shared.
    expect(cloud.requests.some((r) => r.deviceId === "dev_c")).toBe(false);

    c.link();
    await until(() => !!A.engine.matches.get(match) && !!A.engine.players.get(zeta) && A.engine.players.get(id.kite!)?.data.realName === "Kite Local", "C's records on A");
    await settle([A, B, c]);
    // C's own copies became the organisation's records.
    expect(c.engine.teams.get(bravoLocal)).toBeUndefined();
    expect(c.engine.players.get(kiteLocal)).toBeUndefined();
    expect(c.engine.teams.get(id.bravo!)!.data.name).toBe("Bravo C");
    expect(c.engine.steamIndex.lookup(KITE)).toBe(id.kite);
    expect(c.engine.matches.get(match)!.data.teamAId).toBe(id.bravo);
    expect(c.sync().merged).toBe(2);
    // The organisation has no duplicates: one Bravo, one kite (in Bravo once), and C's new records.
    expect(A.engine.teams.list().map((t) => t.data.name).sort()).toEqual(["Alpha Esports", "Bravo C", "Charlie"]);
    expect(A.engine.players.list().map((p) => p.data.displayName).sort()).toEqual(["kite", "nova2", "zeta"]);
    expect(A.engine.players.get(id.kite!)!.data.aliases).toEqual(["Kite"]);
    expect(A.engine.roster.forTeam(id.bravo!).map((m) => m.playerId)).toEqual([id.kite]);
    expect(A.engine.roster.forTeam(charlie).map((m) => m.playerId)).toEqual([zeta]);
    expect(A.engine.matches.get(match)!.data).toMatchObject({ teamAId: id.bravo, teamBId: charlie });
    expect(B.engine.matches.get(match)!.data).toMatchObject({ teamAId: id.bravo, teamBId: charlie });
    // C received everything else (the logo too).
    expect(existsSync(join(c.dataDir, "assets", id.logo!))).toBe(true);
    expect(cloud.items.get(`team:${bravoLocal}`)).toBeUndefined();
    expect(cloud.items.get(`player:${kiteLocal}`)).toBeUndefined();
  });
});
