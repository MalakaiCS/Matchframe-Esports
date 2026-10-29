import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { CloudApp, loadCloudConfig, PgliteSql, startCloudServer } from "@matchframe/cloud-api";
import { encodeCamFrame, type CamRoomInfo } from "@matchframe/cloud-contracts";
import { buildSyntheticGsiPayload, syntheticRoster } from "@matchframe/cs2-state";
import { Engine } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { playerKey, type CamStatus } from "../src/live/cams.ts";
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

async function until(fn: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** A local consumer of /cams-ws or /api/v1/cams/ws: the list and the frames with their arrival times. */
class Viewer {
  readonly frames: { s: string; k: number; t: number; at: number; n: number }[] = [];
  list: { steamId: string; onAir: boolean; state?: string }[] = [];
  observed: string | null = null;
  constructor(readonly ws: WebSocket) {
    ws.on("message", (d, bin) => {
      if (bin) {
        const b = d as Buffer;
        const h = JSON.parse(b.subarray(1, 1 + b[0]!).toString()) as { s: string; k: number; t: number };
        this.frames.push({ ...h, at: Date.now(), n: b.byteLength - 1 - b[0]! });
        return;
      }
      const m = JSON.parse(String(d)) as { type: string; list?: Viewer["list"]; steamId?: string | null };
      if (m.type === "cams") this.list = m.list!;
      if (m.type === "observed") this.observed = m.steamId ?? null;
    });
  }
  static open(url: string, headers: Record<string, string> = {}): Promise<Viewer> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      const v = new Viewer(ws);
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "sub", players: null }));
        resolve(v);
      });
      ws.on("unexpected-response", (_q, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.on("error", reject);
    });
  }
}

const roster = syntheticRoster().map((pl, i) => ({ ...pl, position: { x: i * 120, y: 40, z: 0 }, forward: { x: 1, y: 0, z: 0 } }));
const hello = { type: "hello", codec: "vp8", width: 640, height: 360, fps: 30, camera: "Logitech C920" };

describe("player cams: website → program → HUDs and OBS, delayed", () => {
  let cloud: CloudApp;
  let closeCloud: () => Promise<void>;
  let cloudBase: string;
  let engine: Engine;
  let closeEngine: () => Promise<void>;
  let ports: { gsi: number; api: number; overlay: number };
  let api: <T = CamStatus>(path: string, init?: RequestInit) => Promise<{ status: number; data: T }>;
  const open: WebSocket[] = [];
  let ts = 1_700_000_000;
  let room = "";
  const nova = roster[0]!;
  const zeal = roster[6]!;

  const gsi = () => fetch(`http://127.0.0.1:${ports.gsi}/gsi`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(buildSyntheticGsiPayload({ players: roster, token: engine.secrets.gsiToken, timestamp: ++ts, mapName: "de_inferno", mapPhase: "live", roundPhase: "live", observed: nova.steamId })) });
  const status = async () => (await api("/api/v1/cams")).data;
  const player = (steamId: string) =>
    new Promise<WebSocket & { msgs: Record<string, unknown>[] }>((resolve, reject) => {
      const ws = new WebSocket(`${cloudBase.replace("http", "ws")}/v1/cams/${room}/publish?key=${playerKey(room, steamId)}`) as WebSocket & { msgs: Record<string, unknown>[] };
      ws.msgs = [];
      open.push(ws);
      ws.on("message", (d) => ws.msgs.push(JSON.parse(String(d)) as Record<string, unknown>));
      ws.on("open", () => {
        ws.send(JSON.stringify(hello));
        resolve(ws);
      });
      ws.on("error", reject);
    });
  const hudViewer = async () => {
    const v = await Viewer.open(`ws://127.0.0.1:${ports.overlay}/cams-ws?t=${engine.cams.token()}`);
    open.push(v.ws);
    return v;
  };
  const operatorViewer = async () => {
    const v = await Viewer.open(`ws://127.0.0.1:${ports.api}/api/v1/cams/ws`, { authorization: `Bearer ${engine.secrets.operatorToken}` });
    open.push(v.ws);
    return v;
  };
  /** A second of video: a keyframe, then deltas, 30 a second. */
  const sendVideo = async (ws: WebSocket, startUs: number, n = 30) => {
    for (let i = 0; i < n; i++) {
      ws.send(encodeCamFrame(i === 0, startUs + i * 33_333, new Uint8Array(i === 0 ? 4000 : 600).fill(i)));
      await new Promise((r) => setTimeout(r, 33));
    }
  };

  beforeAll(async () => {
    const cloudPort = await freePort();
    cloudBase = `http://127.0.0.1:${cloudPort}`;
    cloud = new CloudApp(loadCloudConfig({}, { publicUrl: cloudBase, port: cloudPort }), { sql: new PgliteSql(), rateLimitScale: 100 });
    await cloud.init();
    ({ close: closeCloud } = await startCloudServer(cloud));
    const signupRes = await fetch(`${cloudBase}/v1/auth/signup`, { method: "POST", headers: { "content-type": "application/json", origin: cloudBase }, body: JSON.stringify({ email: "prod@example.com", password: "correct horse battery", displayName: "Prod", orgName: "Night League" }) });
    expect(signupRes.status).toBe(201);
    const mail = (await cloud.sql.query<{ body_text: string }>("SELECT body_text FROM outbox_emails ORDER BY id DESC LIMIT 1")).rows[0]!.body_text;
    await fetch(`${cloudBase}/v1/auth/verify-email`, { method: "POST", headers: { "content-type": "application/json", origin: cloudBase }, body: JSON.stringify({ token: /token=([A-Za-z0-9_-]+)/.exec(mail)![1] }) });

    ports = { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    engine = new Engine(loadConfig({ dataDir: mkdtempSync(join(tmpdir(), "mf-engine-cams-")), gsiPort: ports.gsi, apiPort: ports.api, overlayPort: ports.overlay, host: "127.0.0.1", captainUiDir: null, hudRendererDir: null, mapPackDir: null, workersDir: null, pythonPath: null, cloudUrl: cloudBase, cloudPublicKeys: null, cloudEnforcement: "off" }));
    await engine.init();
    const servers = await startServers(engine);
    closeEngine = async () => {
      await servers.close();
      await engine.shutdown();
    };
    api = async (path, init = {}) => {
      const res = await fetch(`http://127.0.0.1:${ports.api}${path}`, { ...init, headers: { authorization: `Bearer ${engine.secrets.operatorToken}`, "content-type": "application/json", ...(init.headers ?? {}) } });
      return { status: res.status, data: (await res.json()) as never };
    };
    expect((await gsi()).status).toBe(200);
  });

  afterAll(async () => {
    for (const ws of open) ws.terminate();
    await closeEngine?.();
    await closeCloud?.();
    await cloud?.close();
  });

  it("needs the program signed in; then opens a room on the website with the match's players", async () => {
    let st = (await api("/api/v1/cams/settings", { method: "PUT", body: JSON.stringify({ enabled: true, delayMs: 1000 }) })).data;
    expect(st).toMatchObject({ enabled: true, signedIn: false, websiteConnected: false, link: null, delayMs: 1000 });
    await engine.cloud.login({ email: "prod@example.com", password: "correct horse battery", deviceName: "Production PC" });
    await until(async () => (await status()).websiteConnected);
    st = await status();
    expect(st.link).toMatch(new RegExp(`^${cloudBase}/cam/[a-z0-9]{20}$`));
    room = st.link!.split("/cam/")[1]!;
    expect(st.outputs!.observed).toBe(`http://127.0.0.1:${ports.overlay}/cams/observed?t=${engine.cams.token()}`);
    // The cam page sees the teams from the game data, players under opaque keys (never SteamIDs).
    const info = (await (await fetch(`${cloudBase}/v1/cams/${room}`)).json()) as CamRoomInfo;
    expect(info.hostConnected).toBe(true);
    expect(info.teams.map((t) => t.players.length)).toEqual([5, 5]);
    expect(info.teams.flatMap((t) => t.players).find((p) => p.key === playerKey(room, nova.steamId))?.name).toBe(nova.name);
    expect(JSON.stringify(info)).not.toContain(nova.steamId);
    expect(st.players.find((p) => p.steamId === nova.steamId)).toMatchObject({ state: "offline", onAir: false });
  });

  it("shows a cam to the operator as it arrives and to HUDs and OBS pages the set delay later", async () => {
    const hud = await hudViewer();
    const op = await operatorViewer();
    const cam = await player(nova.steamId);
    await until(() => cam.msgs.some((m) => m.type === "status" && m.state === "live"));
    await until(async () => (await status()).players.find((p) => p.steamId === nova.steamId)?.state === "live");
    expect(hud.observed).toBe(nova.steamId);
    const sentAt = Date.now();
    await sendVideo(cam, 5_000_000);
    await until(() => op.frames.length >= 30, 3000);
    // The operator's first frame within a moment; the HUD's about a second after it was sent.
    expect(op.frames[0]!.at - sentAt).toBeLessThan(400);
    await until(() => hud.frames.length >= 30, 4000);
    expect(hud.frames[0]!.at - sentAt).toBeGreaterThanOrEqual(900);
    expect(hud.frames[0]).toMatchObject({ s: nova.steamId, k: 1, t: 5_000_000, n: 4000 });
    expect(hud.frames.map((f) => f.t)).toEqual(op.frames.map((f) => f.t));
    // Played out at the pace it was filmed (not in a burst).
    const span = hud.frames.at(-1)!.at - hud.frames[0]!.at;
    expect(span).toBeGreaterThan(800);
    expect(hud.list.find((p) => p.steamId === nova.steamId)?.onAir).toBe(true);
    const st = await status();
    expect(st.players.find((p) => p.steamId === nova.steamId)).toMatchObject({ camera: "Logitech C920", width: 640, height: 360, onAir: true });
  });

  it("takes a cam off air for HUDs (the operator still sees it) and puts it back from its next keyframe", async () => {
    const hud = await hudViewer();
    const op = await operatorViewer();
    const cam = open.find((w) => w.url.includes(playerKey(room, nova.steamId))) as WebSocket & { msgs: Record<string, unknown>[] };
    await api(`/api/v1/cams/settings`, { method: "PUT", body: JSON.stringify({ delayMs: 0 }) });
    await api(`/api/v1/cams/players/${nova.steamId}/hidden`, { method: "PUT", body: JSON.stringify({ hidden: true }) });
    await until(() => cam.msgs.some((m) => m.type === "status" && m.state === "hidden"));
    await until(() => hud.list.find((p) => p.steamId === nova.steamId)?.onAir === false);
    await sendVideo(cam, 9_000_000, 10);
    await until(() => op.frames.length >= 10);
    expect(hud.frames).toHaveLength(0);
    await api(`/api/v1/cams/players/${nova.steamId}/hidden`, { method: "PUT", body: JSON.stringify({ hidden: false }) });
    await until(() => hud.list.find((p) => p.steamId === nova.steamId)?.onAir === true);
    // Mid-stream deltas are skipped until a keyframe.
    cam.send(encodeCamFrame(false, 9_400_000, new Uint8Array(500)));
    await sendVideo(cam, 9_500_000, 5);
    await until(() => hud.frames.length >= 5);
    expect(hud.frames[0]).toMatchObject({ k: 1, t: 9_500_000 });
  });

  it("waits for the operator's approval when cams aren't approved automatically, and can send a player away", async () => {
    await api("/api/v1/cams/settings", { method: "PUT", body: JSON.stringify({ autoApprove: false }) });
    const hud = await hudViewer();
    const cam = await player(zeal.steamId);
    await until(() => cam.msgs.some((m) => m.type === "status" && m.state === "waiting_approval"));
    expect((await status()).players.find((p) => p.steamId === zeal.steamId)).toMatchObject({ state: "waiting_approval", onAir: false });
    await sendVideo(cam, 1_000_000, 5);
    await new Promise((r) => setTimeout(r, 200));
    expect(hud.frames.filter((f) => f.s === zeal.steamId)).toHaveLength(0);
    await api(`/api/v1/cams/players/${zeal.steamId}/approve`, { method: "POST" });
    await until(() => cam.msgs.some((m) => m.type === "status" && m.state === "live"));
    await sendVideo(cam, 2_000_000, 5);
    await until(() => hud.frames.filter((f) => f.s === zeal.steamId).length >= 5);
    await api(`/api/v1/cams/players/${zeal.steamId}/kick`, { method: "POST" });
    await until(() => cam.msgs.some((m) => m.type === "kicked"));
    await until(async () => (await status()).players.find((p) => p.steamId === zeal.steamId)?.state === "offline");
  });

  it("refuses local viewers without a token, and serves the OBS cam pages with one", async () => {
    await expect(Viewer.open(`ws://127.0.0.1:${ports.overlay}/cams-ws?t=nope`)).rejects.toThrow("HTTP 401");
    await expect(Viewer.open(`ws://127.0.0.1:${ports.api}/api/v1/cams/ws`)).rejects.toThrow("HTTP 401");
    expect((await fetch(`http://127.0.0.1:${ports.overlay}/cams/observed`)).status).toBe(401);
    const page = await fetch(`http://127.0.0.1:${ports.overlay}/cams/player/${nova.steamId}?t=${engine.cams.token()}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(`data-player="${nova.steamId}"`);
    expect(html).toContain('<script src="/hud-runtime/cams.js"></script>');
    expect((await fetch(`http://127.0.0.1:${ports.overlay}/hud-runtime/cams.js`)).headers.get("content-type")).toMatch(/javascript/);
  });

  it("a new link closes the old one on the website", async () => {
    const old = room;
    const st = (await api("/api/v1/cams/new-link", { method: "POST" })).data;
    expect(st.link).not.toContain(old);
    await until(async () => (await status()).websiteConnected);
    expect((await fetch(`${cloudBase}/v1/cams/${old}`)).status).toBe(404);
    room = (await status()).link!.split("/cam/")[1]!;
    expect((await fetch(`${cloudBase}/v1/cams/${room}`)).status).toBe(200);
    await api("/api/v1/cams/settings", { method: "PUT", body: JSON.stringify({ enabled: false }) });
    await until(async () => (await fetch(`${cloudBase}/v1/cams/${room}`)).status === 404);
  });
});
