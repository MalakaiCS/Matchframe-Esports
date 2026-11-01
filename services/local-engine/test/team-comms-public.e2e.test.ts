import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Engine } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { OVERLAY_SOURCE } from "../src/comms/overlay.ts";
import { startServers } from "../src/servers.ts";
import { StandInObs } from "./stand-in-obs.ts";
import { buildSyntheticGsiPayload, syntheticRoster } from "../../../packages/cs2-state/src/testing/gsi-builder.ts";
import { FakeTs3Plugin, peakAmplitude, tone, until } from "./helpers/fake-ts3-plugin.ts";

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
 * Team Comms on air through the engine (ADR-066): the routes (Listen In by team id, End Listen-In,
 * Mute All Comms, the public settings), the team-only overlay page and its WebSocket on the overlay
 * server, the preview WebSocket's permission, the overlay put on top of the live scene in a stand-in
 * OBS and the OBS routing check. The engine's own clock and render timer; a stand-in TeamSpeak plugin.
 * NDI is off here (the real NDI process is tested in team-comms-ndi.test.ts).
 */
describe("Team Comms on air through the engine", () => {
  let e: Engine;
  let servers: Awaited<ReturnType<typeof startServers>>;
  let api: string;
  let overlay: string;
  let auth: Record<string, string>;
  let plugin: FakeTs3Plugin;
  let obs: StandInObs;
  let teamA: string;
  let teamB: string;
  let gsi: string;
  const get = async (path: string) => fetch(`${api}${path}`, { headers: auth });
  const post = async (path: string, body: unknown = {}) => fetch(`${api}${path}`, { method: "POST", headers: auth, body: JSON.stringify(body) });
  const put = async (path: string, body: unknown) => fetch(`${api}${path}`, { method: "PUT", headers: auth, body: JSON.stringify(body) });

  beforeAll(async () => {
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    const ports = { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
    api = `http://127.0.0.1:${ports.api}`;
    overlay = `http://127.0.0.1:${ports.overlay}`;
    gsi = `http://127.0.0.1:${ports.gsi}/gsi`;
    e = new Engine(loadConfig({ dataDir: mkdtempSync(join(tmpdir(), "mf-comms-air-")), gsiPort: ports.gsi, apiPort: ports.api, overlayPort: ports.overlay, host: "127.0.0.1", captainUiDir: null, hudRendererDir: null, mapPackDir: null, workersDir: null, pythonPath: null, cloudEnforcement: "off" }));
    // No NDI process here: the routing is what this checks.
    e.settings.set("comms.public", { ndi: { enabled: false } });
    await e.init();
    servers = await startServers(e);
    auth = { authorization: `Bearer ${e.secrets.operatorToken}`, "content-type": "application/json" };
    teamA = e.teams.create({ name: "Northern Lights", shortName: "NL", primaryColor: "#2f7cf6" }, "team").id;
    teamB = e.teams.create({ name: "Red Harbour", shortName: "RH" }, "team").id;
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
    plugin.openTab({ schid: 1, server, channel: { id: 1, name: "Team NL" }, self: { clientId: 2, uid: "listenerA=", nickname: "MF A" }, clients: [{ clientId: 10, uid: "nlPlayerOne=", nickname: "nl_one" }] });
    plugin.openTab({ schid: 2, server, channel: { id: 2, name: "Team RH" }, self: { clientId: 3, uid: "listenerB=", nickname: "MF B" }, clients: [{ clientId: 20, uid: "rhPlayerOne=", nickname: "rh_one" }] });
    obs = await StandInObs.attach(e, (o) => {
      o.addScene("Game");
      o.addInput("Game", "Game capture", "game_capture");
      o.addInput("Game", "Casters", "wasapi_input_capture");
      o.addInput("Game", "Desktop Audio", "wasapi_output_capture");
      o.addInput("Game", "TS3 capture", "wasapi_process_output_capture", { window: "TeamSpeak 3:Qt5QWindowIcon:ts3client_win64.exe" });
      o.program = "Game";
    });
    e.program.setScenes({ LIVE: "Game" });
  });

  afterAll(async () => {
    plugin?.kill();
    await servers?.close();
    await e?.shutdown();
  });

  type View = { onAir: { listenIn: { state: string; label: string; actions: { teamId: string; label: string; disabledReason: string | null }[] }; overlay: { url: string } }; slots: { ready: boolean }[] };

  it("Listen In by team id through the API: OFF at start, refused for an unknown team, then LISTENING IN — team; the overlay page shows the team only", async () => {
    let v = (await (await get("/api/v1/comms")).json()) as View;
    expect(v.onAir.listenIn.state).toBe("off");
    expect(v.onAir.listenIn.actions.map((a) => a.label)).toEqual(["Listen In — Northern Lights", "Listen In — Red Harbour"]);
    await until(() => e.teamComms.status().slots.every((s) => s.ready), 5000, "both ready (150 ms)");
    expect((await post("/api/v1/comms/listen-in", { teamId: "no-such-team" })).status).toBe(404);
    // The overlay page and its socket (team-level state only).
    const url = new URL(v.onAir.overlay.url);
    const token = url.searchParams.get("t")!;
    expect((await fetch(`${overlay}/comms/public`)).status).toBe(401);
    const page = await fetch(`${overlay}/comms/public?t=${token}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<script src="/comms/public.js"></script>');
    expect(html).toContain("TEAM COMMS");
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect((await fetch(`${overlay}/comms/public.js`)).headers.get("content-type")).toMatch(/javascript/);
    const bad = new WebSocket(`${overlay.replace("http", "ws")}/comms-ws?t=wrong`);
    const refused = await new Promise<number>((res) => bad.on("unexpected-response", (_req, r) => res(r.statusCode ?? 0)).on("error", () => res(-1)));
    expect(refused).toBe(401);
    const ws = new WebSocket(`${overlay.replace("http", "ws")}/comms-ws?t=${token}`);
    const msgs: { onAir: boolean; team: { name: string } | null }[] = [];
    ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
    await until(() => msgs.length > 0, 3000, "overlay state");
    expect(msgs[0]).toMatchObject({ onAir: false, team: null });
    const r = await post("/api/v1/comms/listen-in", { teamId: teamA });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ state: "listening", label: "LISTENING IN — NORTHERN LIGHTS" });
    await until(() => msgs.some((m) => m.onAir), 3000, "banner on");
    expect(msgs.find((m) => m.onAir)).toMatchObject({ team: { name: "Northern Lights", shortName: "NL", color: "#2f7cf6" } });
    expect(JSON.stringify(msgs)).not.toMatch(/nl_one|nlPlayerOne|rh_one/);
    // Mute All, then End: the banner goes, the state says so.
    const m = (await (await post("/api/v1/comms/mute-all")).json()) as { label: string; muted: boolean };
    expect(m).toMatchObject({ label: "OFF — MUTED", muted: true });
    await until(() => !msgs[msgs.length - 1]!.onAir, 3000, "banner off");
    expect((await post("/api/v1/comms/listen-in", { teamId: teamB })).status).toBe(200);
    expect((await (await post("/api/v1/comms/listen-in/end")).json()) as { state: string }).toMatchObject({ state: "off" });
    ws.close();
    v = (await (await get("/api/v1/comms")).json()) as View;
    expect(v.onAir.listenIn.state).toBe("off");
    // Audited.
    expect(e.audit.recent(50).map((x) => x.action)).toEqual(expect.arrayContaining(["comms.listen_in", "comms.mute_all", "comms.listen_in_end"]));
  });

  it("halftime in the game data (the teams swap CT and T): Team Comms' teams, the listen-in and the recording team stay with their team ids; the feeds don't swap", async () => {
    const roster = syntheticRoster();
    const swapped = roster.map((p) => ({ ...p, side: p.side === "CT" ? ("T" as const) : ("CT" as const) }));
    const postGsi = async (body: unknown) => (await fetch(gsi, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } })).status;
    const token = e.secrets.gsiToken;
    // First half: Northern Lights on CT.
    expect(await postGsi(buildSyntheticGsiPayload({ players: roster, token, timestamp: 1_700_000_100, round: 11, ctName: "Northern Lights", tName: "Red Harbour" }))).toBe(200);
    await until(() => e.session.state()?.teams.CT.name === "Northern Lights", 3000, "first half");
    for (const uid of ["nlPlayerOne=", "rhPlayerOne="]) {
      const key = e.teamComms.status().participants.find((p) => p.uid === uid)!.key;
      expect((await put(`/api/v1/comms/participants/${encodeURIComponent(key)}`, { includeBroadcast: true, includeRecording: true })).status).toBe(200);
    }
    await until(() => e.teamComms.status().slots.every((s) => s.ready), 5000, "ready");
    expect((await post("/api/v1/comms/listen-in", { teamId: teamA })).status).toBe(200);
    expect((await post("/api/v1/comms/recording/team", { teamId: teamA })).status).toBe(200);
    const before = e.teamComms.status().slots.map((s) => [s.id, s.team?.id, s.tab?.channel?.name]);
    // Halftime: intermission, then the second half with the sides swapped.
    expect(await postGsi(buildSyntheticGsiPayload({ players: roster, token, timestamp: 1_700_000_101, round: 12, mapPhase: "intermission", ctName: "Northern Lights", tName: "Red Harbour" }))).toBe(200);
    expect(await postGsi(buildSyntheticGsiPayload({ players: swapped, token, timestamp: 1_700_000_102, round: 12, ctName: "Red Harbour", tName: "Northern Lights" }))).toBe(200);
    await until(() => e.session.state()?.teams.CT.name === "Red Harbour", 3000, "second half: sides swapped");
    expect(e.teamComms.status().slots.map((s) => [s.id, s.team?.id, s.tab?.channel?.name])).toEqual(before);
    expect(before).toEqual([
      ["A", teamA, "Team NL"],
      ["B", teamB, "Team RH"],
    ]);
    const v = (await (await get("/api/v1/comms")).json()) as { onAir: { listenIn: { state: string; team: { id: string } | null } }; recorder: { heardTeamId: string | null } };
    expect(v.onAir.listenIn).toMatchObject({ state: "listening", team: { id: teamA } });
    expect(v.recorder.heardTeamId).toBe(teamA);
    // Both teams talk: the public and the recording outputs carry Northern Lights only, as before the swap.
    const pub: Float32Array[] = [];
    const rec: Float32Array[] = [];
    const offs = [e.commsPublic.outputs.onPublic((x) => pub.push(Float32Array.from(x))), e.commsPublic.outputs.onRecording((x) => rec.push(Float32Array.from(x)))];
    const t0 = performance.now();
    let phase = 0;
    while (performance.now() - t0 < 700) {
      plugin.audio(1, 10, tone(470, 20, 48000, 0.2, phase), performance.now());
      plugin.audio(2, 20, tone(1310, 20, 48000, 0.2, phase), performance.now());
      phase += 960;
      await new Promise((res) => setTimeout(res, 20));
    }
    await new Promise((res) => setTimeout(res, 400));
    for (const off of offs) off();
    const join2 = (bs: Float32Array[]) => {
      const out = new Float32Array(bs.reduce((n, b) => n + b.length, 0));
      let o = 0;
      for (const b of bs) out.set(b, (o += b.length) - b.length);
      return out;
    };
    for (const x of [join2(pub), join2(rec)]) {
      expect(peakAmplitude(x, 470)).toBeGreaterThan(0.1);
      expect(peakAmplitude(x, 1310)).toBeLessThan(0.002);
    }
    expect((await post("/api/v1/comms/listen-in/end")).status).toBe(200);
  });

  it("the preview socket is the operator's only (a viewer token is refused)", async () => {
    const ws = new WebSocket(`${api.replace("http", "ws")}/api/v1/comms/preview/ws?token=${e.secrets.operatorToken}`, { headers: { origin: api } });
    const hello = await new Promise<{ type: string; rate: number }>((res, rej) => {
      ws.once("message", (d) => res(JSON.parse(String(d))));
      ws.once("error", rej);
    });
    expect(hello).toMatchObject({ type: "hello", rate: 48000 });
    ws.close();
    const viewer = e.secrets.issue("viewer", "test viewer").token;
    const w2 = new WebSocket(`${api.replace("http", "ws")}/api/v1/comms/preview/ws?token=${viewer}`, { headers: { origin: api } });
    const code = await new Promise<number>((res) => w2.on("unexpected-response", (_req, r) => res(r.statusCode ?? 0)).on("error", () => res(-1)));
    expect(code).toBe(403);
  });

  it("puts the overlay on top of the live scene in OBS, and the routing check names Desktop Audio, the missing comms source and a TeamSpeak capture", async () => {
    const r = await post("/api/v1/comms/overlay/obs");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ scene: "Game", source: OVERLAY_SOURCE, created: true, onTop: true });
    const items = obs.scenes.get("Game")!;
    expect(items[items.length - 1]!.source).toBe(OVERLAY_SOURCE);
    expect(String(obs.inputs.get(OVERLAY_SOURCE)!.settings.url)).toMatch(/\/comms\/public\?t=[0-9a-f]{48}$/);
    // Pressed again: still one source, on top.
    expect((await (await post("/api/v1/comms/overlay/obs")).json()) as { created: boolean }).toMatchObject({ created: false, onTop: true });
    const check = (await (await get("/api/v1/comms/obs/check")).json()) as { connected: boolean; checks: { id: string; ok: boolean | null; detail: string }[] };
    const by = Object.fromEntries(check.checks.map((c) => [c.id, c]));
    expect(by["desktop-audio"]).toMatchObject({ ok: false });
    expect(by["desktop-audio"]!.detail).toMatch(/Desktop Audio/);
    expect(by["public-source"]).toMatchObject({ ok: false });
    expect(by["no-teamspeak"]).toMatchObject({ ok: false });
    expect(by["no-teamspeak"]!.detail).toMatch(/TS3 capture/);
    // Fixed as the docs say: Desktop Audio off, TeamSpeak capture gone, the comms source in the live scene, not monitored.
    obs.inputs.get("Desktop Audio")!.audio.muted = true;
    obs.inputs.delete("TS3 capture");
    obs.scenes.set("Game", obs.scenes.get("Game")!.filter((i) => i.source !== "TS3 capture"));
    obs.addInput("Game", "MatchFrame Comms", "ndi_source", { ndi_source_name: "PRODUCTION-PC (MatchFrame Comms)" });
    const fixed = (await (await get("/api/v1/comms/obs/check")).json()) as typeof check;
    expect(fixed.checks.filter((c) => c.ok === false)).toEqual([]);
  });

  it("the support file has the listen-in and outputs, not the overlay's token", async () => {
    const d = JSON.stringify(e.commsPublic.diagnostics());
    expect(d).toContain("t=[redacted]");
    expect(d).not.toContain(e.commsPublic.overlay.token());
  });
});
