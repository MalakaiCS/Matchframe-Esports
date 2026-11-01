import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Engine } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { CommsRecording, GAME_AUDIO_COPY, RECORDER_FILTER, RECORDING_SCENE, type RecordingDeps } from "../src/comms/recording.ts";
import { RECORDING_NDI_NAME } from "../src/comms/outputs.ts";
import { STRIP_SOURCE, type SpeakerStrip } from "../src/comms/strip.ts";
import { startServers } from "../src/servers.ts";
import { StandInObs } from "./stand-in-obs.ts";
import { FakeTs3Plugin, tone, until } from "./helpers/fake-ts3-plugin.ts";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

const GB = 1024 ** 3;

/**
 * The dedicated comms recording through the engine (ADR-068): its routes, the recording scene set up
 * in a stand-in OBS (Source Record's filter kind there or not), Start/Stop over the filter's record
 * mode, the TeamSpeak recording signal, the team by id, levels, folder, status (file, free space,
 * OBS's track 1, faults), adoption after a restart; the speaker strip's page, token and socket, kept
 * apart from the public overlay. The engine's own clock; a stand-in TeamSpeak plugin; NDI off.
 */
describe("the dedicated comms recording through the engine", () => {
  let e: Engine;
  let servers: Awaited<ReturnType<typeof startServers>>;
  let api: string;
  let overlay: string;
  let auth: Record<string, string>;
  let plugin: FakeTs3Plugin;
  let obs: StandInObs;
  let teamA: string;
  let teamB: string;
  let folder: string;
  const get = async (path: string) => fetch(`${api}${path}`, { headers: auth });
  const post = async (path: string, body: unknown = {}) => fetch(`${api}${path}`, { method: "POST", headers: auth, body: JSON.stringify(body) });
  const put = async (path: string, body: unknown) => fetch(`${api}${path}`, { method: "PUT", headers: auth, body: JSON.stringify(body) });
  type View = { recorder: ReturnType<CommsRecording["status"]>; strip: ReturnType<SpeakerStrip["status"]>; onAir: { overlay: { url: string } } };
  const view = async () => (await (await get("/api/v1/comms")).json()) as View;
  const deps = () => (e.commsRecording as unknown as { d: RecordingDeps }).d;
  const filter = () => obs.filtersOf(RECORDING_SCENE).find((f) => f.name === RECORDER_FILTER);
  const nl = [
    { clientId: 10, uid: "nlOne=", nickname: "nl_one" },
    { clientId: 11, uid: "nlTwo=", nickname: "nl_two" },
    { clientId: 12, uid: "nlCoach=", nickname: "nl_coach" },
  ];

  beforeAll(async () => {
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    const ports = { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
    api = `http://127.0.0.1:${ports.api}`;
    overlay = `http://127.0.0.1:${ports.overlay}`;
    const dir = mkdtempSync(join(tmpdir(), "mf-comms-rec-"));
    folder = join(dir, "recordings");
    e = new Engine(loadConfig({ dataDir: dir, gsiPort: ports.gsi, apiPort: ports.api, overlayPort: ports.overlay, host: "127.0.0.1", captainUiDir: null, hudRendererDir: null, mapPackDir: null, workersDir: null, pythonPath: null, cloudEnforcement: "off" }));
    e.settings.set("comms.public", { ndi: { enabled: false } });
    await e.init();
    servers = await startServers(e);
    auth = { authorization: `Bearer ${e.secrets.operatorToken}`, "content-type": "application/json" };
    teamA = e.teams.create({ name: "Northern Lights", shortName: "NL" }, "team").id;
    teamB = e.teams.create({ name: "Red Harbour", shortName: "RH" }, "team").id;
    const p1 = e.players.create({ displayName: "Kestrel", avatarAssetId: "aaaaaaaaaaaaaaaaaaaaaaaa.png" }, "player");
    e.roster.join(teamA, p1.id, "player");
    const m = e.matches.create({ eventId: null, teamAId: teamA, teamBId: teamB, format: { bestOf: 1, regulationRounds: 24, overtimeEnabled: true, overtimeRounds: 6 }, status: "live" }, "match");
    e.setActiveMatch(m.id);
    expect((await put("/api/v1/comms/slots/A", { channel: "Team NL", serverHost: "ts.example.org" })).status).toBe(200);
    expect((await put("/api/v1/comms/slots/B", { channel: "Team RH", serverHost: "ts.example.org" })).status).toBe(200);
    expect((await put("/api/v1/comms/settings", { enabled: true, bridgePort: 0, delaySec: 0, fineMs: 0 })).status).toBe(200);
    const st = (await (await get("/api/v1/comms")).json()) as { bridge: { port: number } };
    plugin = new FakeTs3Plugin(st.bridge.port, e.secrets.getSecret("comms.bridgeToken")!, () => performance.now());
    await plugin.connect();
    await until(() => plugin.welcomed, 3000, "welcome");
    const server = { uid: "srv=", name: "Scrims", host: "ts.example.org", port: 9987 };
    plugin.openTab({ schid: 1, server, channel: { id: 1, name: "Team NL" }, self: { clientId: 2, uid: "listenerA=", nickname: "MF A" }, clients: nl });
    plugin.openTab({ schid: 2, server, channel: { id: 2, name: "Team RH" }, self: { clientId: 3, uid: "listenerB=", nickname: "MF B" }, clients: [{ clientId: 20, uid: "rhOne=", nickname: "rh_one" }] });
    await until(() => e.teamComms.status().participants.length === 4, 3000, "four people");
    const key = (uid: string) => e.teamComms.status().participants.find((p) => p.uid === uid)!.key;
    // Two players in the recording (one mapped to the roster), the coach not.
    expect((await put(`/api/v1/comms/participants/${encodeURIComponent(key("nlOne="))}`, { includeRecording: true, playerId: p1.id })).status).toBe(200);
    expect((await put(`/api/v1/comms/participants/${encodeURIComponent(key("nlTwo="))}`, { includeRecording: true })).status).toBe(200);
    expect((await put(`/api/v1/comms/participants/${encodeURIComponent(key("rhOne="))}`, { includeRecording: true })).status).toBe(200);
    obs = await StandInObs.attach(e, (o) => {
      o.addScene("Game");
      o.addInput("Game", "Game Capture", "game_capture", { capture_mode: "window" }, { positionX: 10, positionY: 20, scaleX: 0.5, scaleY: 0.5 });
      o.addInput("Game", "Matchframe HUD", "browser_source", { url: `http://127.0.0.1:${ports.overlay}/overlay/main/live?t=x`, width: 1920, height: 1080 });
      o.addInput("Game", "Game audio", "wasapi_process_output_capture", { window: "Counter-Strike 2:SDL_app:cs2.exe", priority: 2 });
      o.addInput("Game", "Casters", "wasapi_input_capture", { device_id: "casters-mic" });
      o.addScene("Casters");
      o.program = "Game";
      o.filterKinds.clear();
    });
    e.program.setScenes({ LIVE: "Game" });
    deps().ndiHost = () => "TESTPC";
  });

  afterAll(async () => {
    plugin?.kill();
    await servers?.close();
    await e?.shutdown();
  });

  it("without Source Record in OBS: says so plainly with the install steps, and won't start", async () => {
    const src = (await (await get("/api/v1/comms/recording/obs/sources")).json()) as { sourceRecord: boolean; suggested: Record<string, string | null> };
    expect(src.sourceRecord).toBe(false);
    // Found: the game capture, the Matchframe HUD page, the CS2 application audio.
    expect(src.suggested).toEqual({ gameSource: "Game Capture", hudSource: "Matchframe HUD", gameAudioSource: "Game audio" });
    const r = await post("/api/v1/comms/recording/obs", {});
    expect(r.status).toBe(200);
    const res = (await r.json()) as { ok: boolean; steps: { id: string; ok: boolean | null; detail: string }[] };
    expect(res.ok).toBe(false);
    expect(res.steps.find((s) => s.id === "source-record")).toMatchObject({ ok: false });
    expect(res.steps.find((s) => s.id === "source-record")!.detail).toMatch(/obsproject\.com\/forum\/resources\/source-record/);
    expect(res.steps.find((s) => s.id === "filter")).toMatchObject({ ok: false });
    await post("/api/v1/comms/recording/team", { teamId: teamA });
    const start = await post("/api/v1/comms/recording/start");
    expect(start.status).toBe(409);
    expect(((await start.json()) as { message: string }).message).toMatch(/Source Record isn't installed in OBS/);
    expect((await view()).recorder.actions.start.disabledReason).toMatch(/Source Record isn't installed/);
  });

  it("sets up the recording scene: the live scene's gameplay and HUD shared with their transforms, the strip on top, the recording comms and a game audio copy on track 1, Source Record stopped", async () => {
    obs.filterKinds.add("source_record_filter");
    expect((await put("/api/v1/comms/recording", { folder: "not/absolute" })).status).toBe(400);
    expect((await put("/api/v1/comms/recording", { folder })).status).toBe(200);
    for (let i = 0; i < 2; i++) {
      const r = await post("/api/v1/comms/recording/obs", { gameSource: "Game Capture", hudSource: "Matchframe HUD", gameAudioSource: "Game audio" });
      expect(r.status).toBe(200);
      const res = (await r.json()) as { ok: boolean; steps: { id: string; ok: boolean | null }[] };
      expect(res.steps.filter((s) => s.ok === false)).toEqual([]);
      expect(res.ok).toBe(true);
    }
    // Twice: the same scene, nothing doubled. Bottom to top: audio, gameplay, HUD, strip. No casters.
    expect(obs.scenes.get(RECORDING_SCENE)!.map((i) => i.source)).toEqual([GAME_AUDIO_COPY, RECORDING_NDI_NAME, "Game Capture", "Matchframe HUD", STRIP_SOURCE]);
    const items = obs.scenes.get(RECORDING_SCENE)!;
    expect(items.find((i) => i.source === "Game Capture")!.transform).toMatchObject({ positionX: 10, positionY: 20, scaleX: 0.5, scaleY: 0.5 });
    // One gameplay source, shared with the live scene (not a second capture).
    expect([...obs.inputs.keys()].filter((n) => obs.inputs.get(n)!.kind === "game_capture")).toEqual(["Game Capture"]);
    expect(obs.inputs.get(STRIP_SOURCE)).toMatchObject({ kind: "browser_source", settings: { url: e.speakerStrip.url(), width: 1920, height: 1080, shutdown: false } });
    expect(obs.inputs.get(RECORDING_NDI_NAME)).toMatchObject({ kind: "ndi_source", settings: { ndi_source_name: `TESTPC (${RECORDING_NDI_NAME})`, ndi_bw_mode: 2, ndi_behavior: 0, ndi_audio: true } });
    expect(obs.inputs.get(GAME_AUDIO_COPY)).toMatchObject({ kind: "wasapi_process_output_capture", settings: { window: "Counter-Strike 2:SDL_app:cs2.exe", priority: 2 } });
    for (const n of [RECORDING_NDI_NAME, GAME_AUDIO_COPY]) expect(obs.inputs.get(n)!.audio).toMatchObject({ tracks: { "1": true, "2": false, "3": false, "4": false, "5": false, "6": false }, monitorType: "OBS_MONITORING_TYPE_NONE", muted: false });
    // The live scene is untouched (nothing of the recording on air).
    expect(obs.scenes.get("Game")!.map((i) => i.source)).toEqual(["Game Capture", "Matchframe HUD", "Game audio", "Casters"]);
    expect(filter()).toMatchObject({ kind: "source_record_filter", settings: { record_mode: 0, path: folder, different_audio: false, audio_track: 0, rec_format: "mkv" } });
    // The routing check: the strip kept off the live scene.
    const check = (await (await get("/api/v1/comms/obs/check")).json()) as { checks: { id: string; ok: boolean | null }[] };
    expect(check.checks.find((c) => c.id === "strip-off-air")).toMatchObject({ ok: true });
    expect(check.checks.find((c) => c.id === "recording-off-air")).toMatchObject({ ok: true });
  });

  it("Start: Source Record records (Always), TeamSpeak shows recording; the team by id, levels, status with the file, free space and OBS's track 1; Mute All Comms doesn't touch it; Stop", async () => {
    const recTaps: Float32Array[] = [];
    const off = e.commsPublic.outputs.onRecording((s) => recTaps.push(Float32Array.from(s)));
    const r = await post("/api/v1/comms/recording/start");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ state: "recording", label: "RECORDING — NORTHERN LIGHTS", teamspeakSignal: true });
    expect(filter()!.settings).toMatchObject({ record_mode: 1, filename_formatting: "MatchFrame Comms NL %CCYY-%MM-%DD %hh-%mm-%ss", path: folder });
    await until(() => plugin.recording, 3000, "TeamSpeak's recording signal");
    // OBS isn't streaming or recording: track 1 isn't mixed, so the file would be silent: said plainly.
    await e.commsRecording.tick();
    let v = await view();
    expect(v.recorder.obs.track1.inUse).toBe(false);
    expect(v.recorder.errors.join(" ")).toMatch(/track 1/);
    obs.outputs.stream = true;
    obs.emit("StreamStateChanged", { outputActive: true });
    (e.commsRecording as unknown as { track1: { checkedAtMs: number } }).track1.checkedAtMs = -Infinity;
    await e.commsRecording.tick();
    expect((await view()).recorder.obs.track1.inUse).toBe(true);
    // Advanced output with the stream on track 2 and no recording: track 1 unused.
    obs.profile.set("Output/Mode", "Advanced");
    obs.profile.set("AdvOut/TrackIndex", "2");
    (e.commsRecording as unknown as { track1: { checkedAtMs: number } }).track1.checkedAtMs = -Infinity;
    await e.commsRecording.tick();
    expect((await view()).recorder.obs.track1).toMatchObject({ inUse: false });
    obs.profile.set("AdvOut/TrackIndex", "1");
    (e.commsRecording as unknown as { track1: { checkedAtMs: number } }).track1.checkedAtMs = -Infinity;
    await e.commsRecording.tick();
    // Source Record's file appears and grows.
    mkdirSync(folder, { recursive: true });
    const file = join(folder, "MatchFrame Comms NL 2026-11-01 10-00-00.mkv");
    writeFileSync(file, Buffer.alloc(1000));
    await e.commsRecording.tick();
    v = await view();
    expect(v.recorder.file).toMatchObject({ path: file, bytes: 1000, growing: true });
    appendFileSync(file, Buffer.alloc(5000));
    await e.commsRecording.tick();
    expect((await view()).recorder.file!.bytes).toBe(6000);
    // Free space: a warning under the setting, an error under 2 GB.
    deps().freeBytes = () => 10 * GB;
    expect((await view()).recorder.warnings.join(" ")).toMatch(/10\.0 GB free/);
    deps().freeBytes = () => 1 * GB;
    expect((await view()).recorder.errors.join(" ")).toMatch(/Only 1\.0 GB free/);
    deps().freeBytes = () => 500 * GB;
    // The levels: the game audio copy's fader in OBS; the comms as Matchframe's gain (off: silence and nobody lit).
    expect((await put("/api/v1/comms/recording", { gameLevelDb: -6 })).status).toBe(200);
    expect(obs.inputs.get(GAME_AUDIO_COPY)!.audio.volumeMul).toBeCloseTo(10 ** (-6 / 20), 4);
    expect(obs.inputs.get("Game audio")!.audio.volumeMul).toBe(1);
    // nl_one talks: the recording carries it; Mute All Comms (public) changes nothing there.
    const talk = async (ms: number) => {
      const t0 = performance.now();
      let phase = 0;
      while (performance.now() - t0 < ms) {
        plugin.audio(1, 10, tone(470, 20, 48000, 0.2, phase), performance.now());
        phase += 960;
        await new Promise((res) => setTimeout(res, 20));
      }
    };
    const loud = () => Math.max(0, ...recTaps.map((b) => Math.max(...b.map(Math.abs))));
    await until(() => e.teamComms.status().slots.every((s) => s.ready), 3000, "ready");
    recTaps.length = 0;
    await talk(600);
    await new Promise((res) => setTimeout(res, 300));
    expect(loud()).toBeGreaterThan(0.05);
    expect((await post("/api/v1/comms/mute-all")).status).toBe(200);
    recTaps.length = 0;
    await talk(600);
    await new Promise((res) => setTimeout(res, 300));
    expect(loud()).toBeGreaterThan(0.05);
    expect(filter()!.settings.record_mode).toBe(1);
    expect((await view()).recorder.state).toBe("recording");
    expect((await put("/api/v1/comms/recording", { commsLevelDb: -60 })).status).toBe(200);
    await new Promise((res) => setTimeout(res, 100));
    recTaps.length = 0;
    await talk(600);
    await new Promise((res) => setTimeout(res, 300));
    expect(loud()).toBe(0);
    expect((await put("/api/v1/comms/recording", { commsLevelDb: 0 })).status).toBe(200);
    // The recording team by team id: the mix follows.
    expect((await post("/api/v1/comms/recording/team", { teamId: "no-such-team" })).status).toBe(404);
    expect((await post("/api/v1/comms/recording/team", { teamId: teamB })).status).toBe(200);
    expect(e.teamComms.recordingTeam).toBe(teamB);
    // The folder can't change mid-recording.
    expect((await put("/api/v1/comms/recording", { folder: join(folder, "other") })).status).toBe(409);
    // Stop: Source Record stopped, TeamSpeak's indicator off, the last file named.
    const s = await post("/api/v1/comms/recording/stop");
    expect(await s.json()).toMatchObject({ state: "idle", teamspeakSignal: false, last: { path: file, bytes: 6000 } });
    expect(filter()!.settings.record_mode).toBe(0);
    await until(() => !plugin.recording, 3000, "TeamSpeak's recording signal off");
    off();
    const audit = e.audit.recent(200).map((a) => a.action);
    expect(audit).toEqual(expect.arrayContaining(["comms.recording_start", "comms.recording_stop", "comms.recording_team", "comms.recording_obs"]));
  });

  it("a fault: Source Record stopped in OBS, or the file not growing; after a restart, a recording still running in OBS is carried on (never started by itself)", async () => {
    expect((await post("/api/v1/comms/recording/team", { teamId: teamA })).status).toBe(200);
    expect((await post("/api/v1/comms/recording/start")).status).toBe(200);
    // Someone stops it in OBS.
    filter()!.settings.record_mode = 0;
    await e.commsRecording.tick();
    let v = await view();
    expect(v.recorder.state).toBe("fault");
    expect(v.recorder.label).toBe("RECORDING FAULT");
    expect(v.recorder.detail).toMatch(/stopped in OBS/);
    filter()!.settings.record_mode = 1;
    // No file growth for long: a fault too.
    let now = Date.now();
    deps().wallNow = () => now;
    await e.commsRecording.tick();
    now += 20_000;
    await e.commsRecording.tick();
    v = await view();
    expect(v.recorder.state).toBe("fault");
    expect(v.recorder.detail).toMatch(/hasn't grown|No file/);
    deps().wallNow = undefined;
    // A new engine (the same OBS, Source Record still recording): carried on, TeamSpeak's indicator back on.
    e.teamComms.setRecordingSignal(false);
    const again = new CommsRecording({ ...deps() });
    await again.tick();
    expect(again.status()).toMatchObject({ state: "recording" });
    expect(e.teamComms.recordingSignalOn).toBe(true);
    again.dispose();
    // ...and with nothing recording in OBS, a new one starts idle.
    filter()!.settings.record_mode = 0;
    const idle = new CommsRecording({ ...deps() });
    await idle.tick();
    expect(idle.status().state).toBe("idle");
    idle.dispose();
    await post("/api/v1/comms/recording/stop");
  });

  it("the strip page has its own token and socket, carries the included people of the recording team only, and the public overlay never carries any of it", async () => {
    const v = await view();
    const url = new URL(v.strip.url);
    const token = url.searchParams.get("t")!;
    const publicToken = new URL(v.onAir.overlay.url).searchParams.get("t")!;
    expect(token).not.toBe(publicToken);
    expect((await fetch(`${overlay}/comms/recording`)).status).toBe(401);
    expect((await fetch(`${overlay}/comms/recording?t=${publicToken}`)).status).toBe(401);
    expect((await fetch(`${overlay}/comms/public?t=${token}`)).status).toBe(401);
    const page = await fetch(`${overlay}/comms/recording?t=${token}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<script src="/comms/recording.js"></script>');
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect((await fetch(`${overlay}/comms/recording.js`)).headers.get("content-type")).toMatch(/javascript/);
    const refused = async (path: string) => {
      const ws = new WebSocket(`${overlay.replace("http", "ws")}${path}`);
      return new Promise<number>((res) => ws.on("unexpected-response", (_req, r) => res(r.statusCode ?? 0)).on("error", () => res(-1)));
    };
    expect(await refused(`/comms-rec-ws?t=${publicToken}`)).toBe(401);
    expect(await refused(`/comms-ws?t=${token}`)).toBe(401);
    const strip: { type: string; cards?: { name: string; pictureUrl: string }[] }[] = [];
    const pub: unknown[] = [];
    const ws = new WebSocket(`${overlay.replace("http", "ws")}/comms-rec-ws?t=${token}`);
    ws.on("message", (d) => strip.push(JSON.parse(String(d))));
    const pws = new WebSocket(`${overlay.replace("http", "ws")}/comms-ws?t=${publicToken}`);
    pws.on("message", (d) => pub.push(JSON.parse(String(d))));
    await until(() => strip.some((m) => m.type === "strip-config" && (m.cards?.length ?? 0) > 0), 3000, "strip cards");
    const cards = strip.filter((m) => m.type === "strip-config").at(-1)!.cards!;
    // Team NL's included people: the mapped player with their roster picture, the other as TeamSpeak names them; never the coach.
    expect(cards.map((c) => c.name)).toEqual(["Kestrel", "nl_two"]);
    expect(cards[0]!.pictureUrl).toBe("/assets/aaaaaaaaaaaaaaaaaaaaaaaa.png");
    expect(JSON.stringify(strip)).not.toMatch(/nl_coach|nlOne=|nlTwo=/);
    // The public overlay: team-level only, nothing of the strip.
    await until(() => pub.length > 0, 3000, "public state");
    expect(JSON.stringify(pub)).not.toMatch(/Kestrel|nl_two|nl_one|assets|strip/);
    ws.close();
    pws.close();
  });

  it("the support file carries the recording and the strip without the strip's token or names", async () => {
    const r = await get("/api/v1/diagnostics/bundle");
    expect(r.status).toBe(200);
    const text = await r.text();
    const token = new URL((await view()).strip.url).searchParams.get("t")!;
    expect(text).toContain("teamCommsRecording");
    expect(text).toContain("teamCommsStrip");
    expect(text).not.toContain(token);
    expect(text).not.toMatch(/"name":"Kestrel"/);
  });
});
