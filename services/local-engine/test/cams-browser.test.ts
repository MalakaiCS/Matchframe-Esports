import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CloudApp, loadCloudConfig, PgliteSql, startCloudServer } from "@matchframe/cloud-api";
import { buildSyntheticGsiPayload, syntheticRoster } from "@matchframe/cs2-state";
import { Engine } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { playerKey } from "../src/live/cams.ts";
import { startServers } from "../src/servers.ts";

/** The part of Playwright this test uses (it is not a dependency of the repository). */
interface Page {
  goto(url: string): Promise<unknown>;
  evaluate(script: string): Promise<unknown>;
  waitForFunction(script: string, arg: null, opts: { timeout: number }): Promise<unknown>;
  addScriptTag(opts: { url: string }): Promise<unknown>;
  close(): Promise<void>;
}
interface BrowserContext {
  newPage(): Promise<Page>;
}
interface Browser {
  newContext(opts: { bypassCSP: boolean }): Promise<BrowserContext>;
  close(): Promise<void>;
}

/** Chromium through Playwright when this machine has it (CI images and developer machines may not). */
function loadPlaywright(): { chromium: { launch(): Promise<Browser> } } | null {
  try {
    return createRequire(import.meta.url)("playwright") as { chromium: { launch(): Promise<Browser> } };
  } catch {
    return null;
  }
}
const pw = loadPlaywright();

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

/**
 * Player cams in a real browser: VP8 encoded in Chromium (WebCodecs) and sent to the website as
 * the cam page does, relayed to the program, delayed, and decoded on the OBS cam page; and an LHM
 * HUD's side (the calls simple-peer makes on RTCPeerConnection) answered by lhm-cams.js.
 */
describe.skipIf(!pw)("player cams in Chromium", () => {
  let cloud: CloudApp;
  let closeCloud: () => Promise<void>;
  let engine: Engine;
  let closeEngine: () => Promise<void>;
  let browser: Browser;
  /** The test drives pages with evaluated code, which the pages' own CSP (rightly) forbids. */
  let ctx: BrowserContext;
  let cloudBase: string;
  let steamId: string;

  beforeAll(async () => {
    const cloudPort = await freePort();
    cloudBase = `http://127.0.0.1:${cloudPort}`;
    cloud = new CloudApp(loadCloudConfig({}, { publicUrl: cloudBase, port: cloudPort }), { sql: new PgliteSql(), rateLimitScale: 100 });
    await cloud.init();
    ({ close: closeCloud } = await startCloudServer(cloud));
    const post = (path: string, body: unknown) => fetch(cloudBase + path, { method: "POST", headers: { "content-type": "application/json", origin: cloudBase }, body: JSON.stringify(body) });
    await post("/v1/auth/signup", { email: "p@example.com", password: "correct horse battery", displayName: "P", orgName: "P Org" });
    const mail = (await cloud.sql.query<{ body_text: string }>("SELECT body_text FROM outbox_emails ORDER BY id DESC LIMIT 1")).rows[0]!.body_text;
    await post("/v1/auth/verify-email", { token: /token=([A-Za-z0-9_-]+)/.exec(mail)![1] });

    const ports = { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    engine = new Engine(loadConfig({ dataDir: mkdtempSync(join(tmpdir(), "mf-cams-browser-")), gsiPort: ports.gsi, apiPort: ports.api, overlayPort: ports.overlay, host: "127.0.0.1", captainUiDir: null, hudRendererDir: null, mapPackDir: null, workersDir: null, pythonPath: null, cloudUrl: cloudBase, cloudPublicKeys: null, cloudEnforcement: "off" }));
    await engine.init();
    const servers = await startServers(engine);
    closeEngine = async () => {
      await servers.close();
      await engine.shutdown();
    };
    const roster = syntheticRoster().map((pl, i) => ({ ...pl, position: { x: i * 120, y: 40, z: 0 }, forward: { x: 1, y: 0, z: 0 } }));
    steamId = roster[0]!.steamId;
    await fetch(`http://127.0.0.1:${ports.gsi}/gsi`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(buildSyntheticGsiPayload({ players: roster, token: engine.secrets.gsiToken, timestamp: 1_700_000_001, mapName: "de_inferno", mapPhase: "live", roundPhase: "live", observed: steamId })) });
    await engine.cloud.login({ email: "p@example.com", password: "correct horse battery", deviceName: "PC" });
    engine.cams.setSettings({ enabled: true, delayMs: 500 });
    for (let i = 0; i < 200 && !engine.cams.status().websiteConnected; i++) await new Promise((r) => setTimeout(r, 25));
    browser = await pw!.chromium.launch();
    ctx = await browser.newContext({ bypassCSP: true });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    await closeEngine?.();
    await closeCloud?.();
    await cloud?.close();
  });

  it("shows a cam encoded in the browser on the OBS cam page, and hands it to an LHM HUD's peer connection", async () => {
    const st = engine.cams.status();
    expect(st.websiteConnected).toBe(true);
    const room = st.link!.split("/cam/")[1]!;
    // The player's side: a red picture, VP8 at 30 frames a second, as the cam page sends it.
    const sender = await ctx.newPage();
    await sender.goto(`${cloudBase}/v1/health`);
    const publishUrl = `${cloudBase.replace("http", "ws")}/v1/cams/${room}/publish?key=${playerKey(room, steamId)}`;
    const sending = sender.evaluate(`(async function () {
      var ws = new WebSocket(${JSON.stringify(publishUrl)});
      ws.binaryType = "arraybuffer";
      await new Promise(function (r) { ws.onopen = r; });
      ws.send(JSON.stringify({ type: "hello", codec: "vp8", width: 320, height: 180, fps: 30 }));
      var canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 180;
      var ctx = canvas.getContext("2d");
      var enc = new VideoEncoder({ output: function (chunk) {
        var data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
        var out = new Uint8Array(10 + data.byteLength); var v = new DataView(out.buffer);
        v.setUint8(0, 1); v.setUint8(1, chunk.type === "key" ? 1 : 0); v.setFloat64(2, chunk.timestamp); out.set(data, 10);
        ws.send(out);
      }, error: function () {} });
      enc.configure({ codec: "vp8", width: 320, height: 180, bitrate: 300000, framerate: 30 });
      for (var i = 0; i < 150; i++) {
        ctx.fillStyle = "rgb(220,30,30)"; ctx.fillRect(0, 0, 320, 180);
        ctx.fillStyle = "white"; ctx.fillRect((i * 4) % 300, 10, 20, 20);
        var f = new VideoFrame(canvas, { timestamp: i * 33333 });
        enc.encode(f, { keyFrame: i % 30 === 0 }); f.close();
        await new Promise(function (r) { setTimeout(r, 33); });
      }
    })()`).catch(() => undefined);

    // The OBS page: the observed player's cam, decoded.
    const obs = await ctx.newPage();
    await obs.goto(st.outputs!.observed);
    await obs.waitForFunction(`window.MatchframeCams && window.MatchframeCams.lastFrameAt(${JSON.stringify(steamId)}) > 0 && document.getElementById("mf-cam").className === "on"`, null, { timeout: 15_000 });
    const px = (await obs.evaluate(`(function () {
      var c = window.MatchframeCams.canvas(${JSON.stringify(steamId)});
      var d = c.getContext("2d").getImageData(160, 140, 1, 1).data;
      return { w: c.width, h: c.height, rgba: [d[0], d[1], d[2], d[3]], on: document.getElementById("mf-cam").className };
    })()`)) as { w: number; h: number; rgba: number[]; on: string };
    expect(px).toMatchObject({ w: 320, h: 180, on: "on" });
    expect(px.rgba[0]).toBeGreaterThan(180); // red, as sent (VP8 is lossy)
    expect(px.rgba[1]).toBeLessThan(80);
    expect(px.rgba[3]).toBe(255);

    // An LHM HUD: the calls simple-peer makes for an offer from Matchframe, answered in the page.
    await obs.addScriptTag({ url: "/hud-runtime/lhm-cams.js" });
    const lhm = (await obs.evaluate(`(async function () {
      var pc = new RTCPeerConnection({ iceServers: [] });
      var got = { identity: typeof pc.peerIdentity, ice: false, stream: false, video: null };
      var shown = new Promise(function (resolve) {
        pc.ontrack = function (e) {
          got.stream = e.streams.length === 1 && e.streams[0].getVideoTracks().length === 1;
          var v = document.createElement("video"); v.muted = true; v.srcObject = e.streams[0]; document.body.appendChild(v); v.play();
          (function wait() { if (v.videoWidth > 0) { got.video = [v.videoWidth, v.videoHeight]; resolve(); } else setTimeout(wait, 50); })();
        };
      });
      pc.onicecandidate = function (e) { if (!e.candidate) got.ice = true; };
      await pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: "v=0\\r\\na=x-matchframe-cam:${steamId}\\r\\n" }));
      got.remote = pc.remoteDescription.type;
      var answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      got.answer = pc.localDescription.type;
      await Promise.race([shown, new Promise(function (r) { setTimeout(r, 5000); })]);
      return got;
    })()`)) as Record<string, unknown>;
    expect(lhm).toEqual({ identity: "undefined", ice: true, stream: true, video: [320, 180], remote: "offer", answer: "answer" });
    await sender.close();
    await sending;
  }, 40_000);
});
