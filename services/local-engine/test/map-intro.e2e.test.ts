import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SyntheticPayloadSpec, SyntheticPlayer } from "@matchframe/cs2-state";
import { buildSyntheticGsiPayload } from "../../../packages/cs2-state/src/testing/gsi-builder.ts";
import { Engine } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { startServers } from "../src/servers.ts";
import { StandInObs } from "./stand-in-obs.ts";
import { StandInVmix } from "./stand-in-vmix.ts";

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-hide_banner", "-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

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
const waitFor = async (fn: () => boolean, ms = 20000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(20);
  }
};

type Weapon = NonNullable<SyntheticPlayer["weapons"]>[number];
const team = (T: Weapon[], CT: Weapon[], money: number): SyntheticPlayer[] => [
  ...[1, 2, 3, 4, 5].map((i): SyntheticPlayer => ({ steamId: `7656119800000000${i}`, name: `T${i}`, slot: i, side: "T", money, weapons: T })),
  ...[6, 7, 8, 9, 0].map((i): SyntheticPlayer => ({ steamId: `7656119800000001${i}`, name: `CT${i}`, slot: i, side: "CT", money, weapons: CT })),
];
const KNIFE_T: Weapon = { name: "weapon_knife_t", type: "Knife", state: "active" };
const KNIFE_CT: Weapon = { name: "weapon_knife", type: "Knife", state: "active" };
const PISTOLS = team([KNIFE_T, { name: "weapon_glock", type: "Pistol" }], [KNIFE_CT, { name: "weapon_usp_silencer", type: "Pistol" }], 800);
const KNIVES = team([KNIFE_T], [KNIFE_CT], 0);
const RIFLES = team([KNIFE_T, { name: "weapon_ak47", type: "Rifle" }], [KNIFE_CT, { name: "weapon_m4a1", type: "Rifle" }], 4000);

/** Tiny intro videos made by ffmpeg (a second or two at 160×90; Inferno's is 6 s, for a round going live during it). */
function makeVideos(dir: string): Record<"mirage" | "fallback" | "inferno", string> {
  const make = (name: string, sec: number, size = "160x90", rate = 10) => {
    const out = join(dir, name);
    execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", `testsrc=size=${size}:rate=${rate}:duration=${sec}`, "-f", "lavfi", "-i", `sine=frequency=330:duration=${sec}`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out], { stdio: "ignore" });
    return out;
  };
  return { mirage: make("mirage.mp4", 1.5), fallback: make("default.mp4", 1), inferno: make("inferno.mp4", 6, "160x90", 5) };
}

/**
 * Map intros with a stand-in OBS at the obs-websocket level (stand-in-obs.ts), its media events
 * included: uploads through the route, the "MatchFrame Map Intro" scene made, the MatchFrame Stinger
 * in and out, back to where the program came from (the live scene, the operator's own scene; the
 * live scene when the round goes live, or from the studio scene as the next map loads), the live
 * audio down and back, cut back or finish when the round goes live, once per map per match, never
 * during a live round, Play next map's intro from the active match's veto, waiting for the round's
 * replays, the fallback without media events, the operator taking the program, Stop, the device
 * actions and the tally.
 */
describe.skipIf(!hasFfmpeg)("Map intros (OBS)", () => {
  let e: Engine;
  let o: StandInObs;
  let servers: Awaited<ReturnType<typeof startServers>>;
  let gsiPort: number;
  let apiPort: number;
  let ts = 1_700_700_000;
  const data = mkdtempSync(join(tmpdir(), "mf-intro-data-"));
  const src = mkdtempSync(join(tmpdir(), "mf-intro-videos-"));
  let videos: ReturnType<typeof makeVideos>;
  let matchId = "";

  const feed = async (spec: SyntheticPayloadSpec, wait = 300) => {
    const payload = buildSyntheticGsiPayload({ mapName: "de_mirage", players: PISTOLS, token: e.secrets.gsiToken, timestamp: ts++, ...spec });
    expect((await fetch(`http://127.0.0.1:${gsiPort}/gsi`, { method: "POST", body: JSON.stringify(payload) })).status).toBe(200);
    await sleep(wait);
  };
  const warmup = (map = "de_mirage") => feed({ mapName: map, mapPhase: "warmup", roundPhase: "live", phase: "warmup", phaseEndsIn: 60 });
  /** A freeze time (round is 1-based), and the same again past the loadouts' settling time. */
  const freeze = async (round: number, opts: { map?: string; players?: SyntheticPlayer[]; left?: number; scoreT?: number; scoreCT?: number; settle?: boolean } = {}) => {
    const spec = (left: number): SyntheticPayloadSpec => ({ mapName: opts.map ?? "de_mirage", mapPhase: "live", round: round - 1, roundPhase: "freezetime", phase: "freezetime", phaseEndsIn: left, players: opts.players ?? PISTOLS, scoreT: opts.scoreT ?? 0, scoreCT: opts.scoreCT ?? 0 });
    await feed(spec(opts.left ?? 15));
    if (opts.settle === false) return;
    await sleep(1000);
    await feed(spec((opts.left ?? 15) - 1.4));
  };
  const live = (round: number, opts: { map?: string; scoreT?: number; scoreCT?: number } = {}) => feed({ mapName: opts.map ?? "de_mirage", mapPhase: "live", round: round - 1, roundPhase: "live", phase: "live", phaseEndsIn: 110, scoreT: opts.scoreT ?? 0, scoreCT: opts.scoreCT ?? 0 });
  const api = async (path: string, body?: unknown, method = "POST") => {
    const r = await fetch(`http://127.0.0.1:${apiPort}${path}`, { method, headers: { authorization: `Bearer ${e.secrets.operatorToken}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> & { message?: string } };
  };
  const upload = async (slot: string, file: string, name: string) => {
    const r = await fetch(`http://127.0.0.1:${apiPort}/api/v1/map-intros/${slot}?name=${encodeURIComponent(name)}`, { method: "POST", headers: { authorization: `Bearer ${e.secrets.operatorToken}`, "content-type": "video/mp4" }, body: readFileSync(file) });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> & { message?: string; intro?: { file: string; durationMs: number; previewUrl: string } } };
  };
  const theyShow = async (scene: string) => {
    await o.call("SetCurrentProgramScene", { sceneName: scene });
    await waitFor(() => e.obs.state.programScene === scene);
    await sleep(250);
  };
  const running = () => e.mapIntros.onAir();
  /** Plays to its end (or the given end), returning the program changes OBS made meanwhile. */
  const untilOver = async () => {
    await waitFor(() => running());
    await waitFor(() => !running(), 20000);
    await sleep(300);
  };
  const volume = () => o.inputs.get("Game audio")!.audio.volumeMul;
  const changes = () => o.changes.map((c) => [c.scene, c.transition]);
  const introFile = (slot: string) => join(data, "map-intros", e.mapIntros.store.get(slot as never)!.file);

  beforeAll(async () => {
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    videos = makeVideos(src);
    const ports = { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
    gsiPort = ports.gsi;
    apiPort = ports.api;
    const renderer = join(src, "renderer");
    mkdirSync(renderer, { recursive: true });
    writeFileSync(join(renderer, "index.html"), "<!doctype html><title>renderer</title>");
    e = new Engine(loadConfig({ dataDir: data, gsiPort: ports.gsi, apiPort: ports.api, overlayPort: ports.overlay, host: "127.0.0.1", captainUiDir: null, hudRendererDir: renderer, mapPackDir: null, workersDir: null, pythonPath: null, sampleHudsDirs: [], cloudEnforcement: "off" }));
    await e.init();
    servers = await startServers(e);
    o = await StandInObs.attach(e, (obs) => {
      obs.addScene("Game");
      obs.addInput("Game", "Game audio", "wasapi_output_capture");
      obs.inputs.get("Game audio")!.audio.volumeMul = 0.8;
      obs.addScene("Analysis");
      obs.addScene("Desk");
      obs.addScene("Break");
      obs.program = "Game";
      obs.current = "Cut";
      obs.defaultDurationMs = 1500;
      obs.transitions.push({ name: "MatchFrame Stinger", kind: "obs_stinger_transition", fixed: true, settings: { path: "stinger.mov", transition_point: 300, tp_type: 0 }, lengthMs: 600 });
    });
    const scenes = { LIVE: "Game", STUDIO: "Desk", BREAK: "Break" };
    e.settings.set("program.scenes", scenes);
    e.program.setScenes(scenes);
    e.autoReplay.setSettings({ enabled: false, duckInputs: ["Game audio"], duckTo: -20, duckRampMs: 100 });
    e.obsAuto.setSettings({ otherScenes: "", mapEnd: true, timeouts: false });
    // The active match: a best of three on Mirage, Inferno, then Nuke.
    const a = e.teams.create({ name: "Northern Lights", shortName: "NL" }, "team").id;
    const b = e.teams.create({ name: "Red Harbour", shortName: "RH" }, "team").id;
    const m = e.matches.create({ eventId: null, teamAId: a, teamBId: b, format: { bestOf: 3, regulationRounds: 24, overtimeEnabled: true, overtimeRounds: 6 }, status: "live" }, "match");
    matchId = m.id;
    ["de_mirage", "de_inferno", "de_nuke"].forEach((mapName, k) => e.mapInstances.upsert({ id: `mi-${k}`, matchId: m.id, order: k + 1, mapName, pickedByTeamId: k === 2 ? null : k === 0 ? a : b, isDecider: k === 2, startingCtTeamId: null, status: k === 0 ? "live" : "upcoming", scoreA: 0, scoreB: 0, winnerTeamId: null, mapRevision: null }));
    e.setActiveMatch(m.id);
    e.mapIntros.setSettings({ trigger: "manual" });
    await warmup();
  }, 60000);

  afterAll(async () => {
    o?.close();
    await servers?.close();
    await e?.shutdown();
  });

  it("uploads: Mirage's and the default intro checked and kept with a preview frame; a file that isn't one refused with why; not shared by account sync", async () => {
    const r = await upload("de_mirage", videos.mirage, "Mirage intro.mp4");
    expect(r.status, r.json.message).toBe(200);
    expect(r.json.intro).toMatchObject({ slot: "de_mirage", durationMs: 1500, videoCodec: "h264", audioCodec: "aac", originalName: "Mirage intro.mp4" });
    expect(existsSync(introFile("de_mirage"))).toBe(true);
    const preview = await fetch(`http://127.0.0.1:${apiPort}${r.json.intro!.previewUrl}`);
    expect([preview.status, preview.headers.get("content-type")]).toEqual([200, "image/jpeg"]);
    expect((await upload("default", videos.fallback, "sting.mp4")).status).toBe(200);
    // Not a video: refused, with why; nothing kept for Anubis.
    writeFileSync(join(src, "notes.mp4"), "not a video");
    const bad = await upload("de_anubis", join(src, "notes.mp4"), "notes.mp4");
    expect([bad.status, bad.json.message]).toEqual([422, expect.stringMatching(/can't read it as a video/)]);
    expect((await upload("de_tuscan", videos.mirage, "x.mp4")).status).toBe(404);
    const view = await api("/api/v1/map-intros", undefined, "GET");
    const slots = view.json.slots as { slot: string; label: string; intro: { durationMs: number } | null }[];
    expect(slots.map((s) => s.slot)).toEqual(["de_ancient", "de_anubis", "de_dust2", "de_inferno", "de_mirage", "de_nuke", "de_overpass", "de_train", "de_vertigo", "de_cache", "default"]);
    expect(slots.filter((s) => s.intro).map((s) => [s.label, s.intro!.durationMs])).toEqual([
      ["Mirage", 1500],
      ["Default", 1000],
    ]);
    expect(view.json).toMatchObject({ shared: false, settings: { trigger: "manual", onLive: "cut", vmixIn: null, vmixOut: null } });
    // The status line, with the trigger chosen.
    expect((view.json.status as { next: string }).next).toBe("Next intro: Mirage, when you press Play map intro.");
    await api("/api/v1/map-intros/settings", { trigger: "pistol" }, "PUT");
    expect(e.mapIntros.status().next).toBe("Next intro: Mirage, at pistol round start.");
    await api("/api/v1/map-intros/settings", { trigger: "manual" }, "PUT");
  }, 30000);

  it("Play map intro from the live scene: the scene and its media source made, the MatchFrame Stinger in and out, until OBS says the media ended, the live audio down and back", async () => {
    o.changes.length = 0;
    o.volumeLog.length = 0;
    const history = e.program.history.length;
    const r = await api("/api/v1/map-intros/play");
    expect(r.status, r.json.message).toBe(200);
    expect((r.json.status as { running: boolean }).running).toBe(true);
    const t0 = Date.now();
    await untilOver();
    // OBS's "ended", not the fallback (1.5 s + 2 s).
    expect(Date.now() - t0).toBeLessThan(3400);
    expect(o.scenes.get("MatchFrame Map Intro")!.map((i) => i.source)).toEqual(["MatchFrame Map Intro Video"]);
    expect(o.inputs.get("MatchFrame Map Intro Video")!.kind).toBe("ffmpeg_source");
    expect(o.inputs.get("MatchFrame Map Intro Video")!.settings).toMatchObject({ is_local_file: true, local_file: introFile("de_mirage"), restart_on_activate: true, close_when_inactive: false, clear_on_media_end: false, looping: false });
    expect(o.mediaEventLog).toContain("MatchFrame Map Intro Video ended");
    expect(changes()).toEqual([
      ["MatchFrame Map Intro", "MatchFrame Stinger"],
      ["Game", "MatchFrame Stinger"],
    ]);
    // The intro started from its beginning as the program went to it.
    expect(o.changes[0]!.media["MatchFrame Map Intro Video"]!.cursorMs).toBeLessThan(150);
    expect(e.program.history.slice(history).map((t) => `${t.from}>${t.to}`)).toEqual(["LIVE>MAP_INTRO", "MAP_INTRO>LIVE"]);
    // OBS's own transition back once the stinger has run.
    await waitFor(() => o.current === "Cut", 3000);
    expect([e.program.mode, o.program, o.current]).toEqual(["LIVE", "Game", "Cut"]);
    expect(e.program.sceneMap.MAP_INTRO).toBe("MatchFrame Map Intro");
    expect(e.settings.get("program.scenes", {})).toMatchObject({ MAP_INTRO: "MatchFrame Map Intro" });
    expect(Math.min(...o.volumeLog.filter((v) => v.input === "Game audio").map((v) => v.mul))).toBeCloseTo(0.08, 3);
    expect(volume()).toBe(0.8);
    expect(e.mapIntros.status().last).toMatchObject({ map: "de_mirage", by: "operator", kind: "manual", end: "ended", error: null, backTo: "Game" });
    // The source lets go of the file once the transition back is over.
    await waitFor(() => o.inputs.get("MatchFrame Map Intro Video")!.settings.local_file === "", 6000);
  }, 30000);

  it("from the operator's own scene, and back to it (still theirs); the chosen intro transitions; OBS's own when it has no MatchFrame Stinger", async () => {
    await theyShow("Analysis");
    expect(e.program.mode).toBe("MANUAL");
    e.obsAuto.setSettings({ introIn: "Fade", introOut: "" });
    o.changes.length = 0;
    expect((await api("/api/v1/map-intros/play")).status).toBe(200);
    await untilOver();
    expect(changes()).toEqual([
      ["MatchFrame Map Intro", "Fade"],
      ["Analysis", "Cut"],
    ]);
    expect([e.program.mode, e.program.operatorScene, e.program.owner.holder]).toEqual(["MANUAL", "Analysis", "OBS: Analysis"]);
    // The default again (null), with no MatchFrame Stinger in OBS: OBS's own (Cut) both ways.
    e.obsAuto.setSettings({ introIn: null, introOut: null });
    const stinger = o.transitions.findIndex((t) => t.name === "MatchFrame Stinger");
    const [kept] = o.transitions.splice(stinger, 1);
    await theyShow("Game");
    o.changes.length = 0;
    expect((await api("/api/v1/map-intros/play")).status).toBe(200);
    await untilOver();
    expect(changes()).toEqual([
      ["MatchFrame Map Intro", "Cut"],
      ["Game", "Cut"],
    ]);
    o.transitions.push(kept!);
  }, 30000);

  it("by itself at pistol round start: not in the warmup, not before the loadouts settle, once per map per match (a press plays it again); never during a live round", async () => {
    await api("/api/v1/map-intros/settings", { trigger: "pistol" }, "PUT");
    e.settings.set("mapIntro.played", []);
    o.changes.length = 0;
    await warmup();
    await sleep(500);
    expect(running()).toBe(false);
    expect(e.mapIntros.status().next).toBe("Next intro: Mirage, at pistol round start.");
    // The pistol round's freeze time: it starts once the loadouts are read.
    await freeze(1, { settle: false });
    await sleep(300);
    expect(running()).toBe(false);
    await freeze(1, { left: 14 });
    await untilOver();
    expect(changes()).toEqual([
      ["MatchFrame Map Intro", "MatchFrame Stinger"],
      ["Game", "MatchFrame Stinger"],
    ]);
    expect(e.mapIntros.status().auto).toMatchObject({ map: "de_mirage", kind: "pistol", started: true, detail: "Mirage's intro played at pistol round start: 10 of 10 players have a gun or grenade." });
    expect(e.mapIntros.status().last).toMatchObject({ by: "automation", kind: "pistol", end: "ended" });
    // Recorded under the active match, once.
    expect(e.settings.get<{ key: string }[]>("mapIntro.played", []).map((p) => p.key)).toEqual([`${matchId}|de_mirage|first`]);
    expect(e.mapIntros.status().current).toMatchObject({ map: "de_mirage", played: { by: "automation", kind: "pistol" } });
    // The round goes live, ends, the game restarts (a technical restart): round 1 again, no second play.
    await live(1);
    await feed({ mapPhase: "live", round: 1, roundPhase: "over", phase: "over", scoreT: 1 });
    o.changes.length = 0;
    await freeze(1);
    await sleep(600);
    expect(running()).toBe(false);
    expect(o.changes).toEqual([]);
    // A press plays it again.
    expect((await api("/api/v1/map-intros/play")).status).toBe(200);
    await untilOver();
    expect(changes().length).toBe(2);
    // Never during a live round: a press is refused, with why.
    await live(1);
    const r = await api("/api/v1/map-intros/play");
    expect([r.status, r.json.message]).toEqual([409, "A round is live: the intro plays between rounds (in the warmup, a freeze time, or after the round)."]);
    expect((await api("/api/v1/map-intros/play-next")).json.message).toBe("A round is live: the intro plays between rounds (in the warmup, a freeze time, or after the round).");
  }, 40000);

  it("at the knife round (a knife round seen); both pistol rounds: round 1 and the second half's first round (13 in MR12)", async () => {
    e.settings.set("mapIntro.played", []);
    await api("/api/v1/map-intros/settings", { trigger: "knife" }, "PUT");
    await warmup();
    o.changes.length = 0;
    await freeze(1, { players: KNIVES });
    await untilOver();
    expect(e.mapIntros.status().auto).toMatchObject({ kind: "knife", started: true, detail: "Mirage's intro played at knife round start: knives only (10 players, no money)." });
    // Both pistol rounds, on a fresh record: round 1's freeze time, then round 13's.
    e.settings.set("mapIntro.played", []);
    await api("/api/v1/map-intros/settings", { trigger: "pistols" }, "PUT");
    await live(1);
    await freeze(1, { left: 13 });
    await untilOver();
    expect(e.mapIntros.status().next).toBe("Next intro: Mirage, at the second half's pistol round.");
    await live(1);
    await freeze(7, { players: RIFLES, scoreT: 4, scoreCT: 2 });
    await sleep(400);
    expect(running()).toBe(false);
    await feed({ mapPhase: "intermission", round: 12, roundPhase: "over", phase: "over", scoreT: 7, scoreCT: 5 });
    await freeze(13, { scoreT: 7, scoreCT: 5, settle: false });
    await untilOver();
    expect(e.mapIntros.status().auto).toMatchObject({ kind: "pistol2", started: true, detail: "Mirage's intro played at the second half's pistol round." });
    expect(e.settings.get<{ key: string }[]>("mapIntro.played", []).map((p) => p.key).sort()).toEqual([`${matchId}|de_mirage|first`, `${matchId}|de_mirage|pistol2`]);
    await live(13, { scoreT: 7, scoreCT: 5 });
  }, 40000);

  it("the round going live during the intro: Cut back to the game (by default, just before the freeze time ends) goes to the live scene, not the scene it came from; Finish the intro plays it out, then the live scene", async () => {
    expect((await upload("de_inferno", videos.inferno, "inferno.mp4")).status).toBe(200);
    o.durations.set(introFile("de_inferno"), 6000);
    await api("/api/v1/map-intros/settings", { trigger: "manual", onLive: "cut" }, "PUT");
    await warmup("de_inferno");
    await freeze(1, { map: "de_inferno", left: 4.5, settle: false });
    await theyShow("Analysis");
    o.changes.length = 0;
    const t0 = Date.now();
    expect((await api("/api/v1/map-intros/play")).status).toBe(200);
    await waitFor(() => !running(), 10000);
    // 4.5 s of freeze time when it started: cut back with about 1 s left, well before its 6 s.
    expect(Date.now() - t0).toBeGreaterThan(2500);
    expect(Date.now() - t0).toBeLessThan(4500);
    await sleep(300);
    expect(e.mapIntros.status().last).toMatchObject({ map: "de_inferno", end: "cut", backTo: "Game" });
    expect(changes()).toEqual([
      ["MatchFrame Map Intro", "MatchFrame Stinger"],
      ["Game", "MatchFrame Stinger"],
    ]);
    expect(e.program.mode).toBe("LIVE");
    // Finish the intro: the round goes live a second in, the intro plays on to its end, then the live scene.
    await api("/api/v1/map-intros/settings", { onLive: "finish" }, "PUT");
    await freeze(2, { map: "de_inferno", left: 4, scoreT: 1, settle: false });
    await theyShow("Analysis");
    o.changes.length = 0;
    const t1 = Date.now();
    expect((await api("/api/v1/map-intros/play")).status).toBe(200);
    await sleep(1000);
    await live(2, { map: "de_inferno", scoreT: 1 });
    expect(e.program.mode).toBe("MAP_INTRO");
    await waitFor(() => !running(), 12000);
    expect(Date.now() - t1).toBeGreaterThan(5800);
    await sleep(300);
    expect(e.mapIntros.status().last).toMatchObject({ map: "de_inferno", end: "ended", backTo: "Game" });
    expect(changes()).toEqual([
      ["MatchFrame Map Intro", "MatchFrame Stinger"],
      ["Game", "MatchFrame Stinger"],
    ]);
    await api("/api/v1/map-intros/settings", { onLive: "cut" }, "PUT");
  }, 40000);

  it("OBS without media events: back by the fallback from the probed length; the operator taking the program stops it and is left there; Stop goes back", async () => {
    await freeze(3, { map: "de_inferno", left: 20, scoreT: 2, settle: false });
    await theyShow("Game");
    o.mediaEvents = false;
    try {
      const t0 = Date.now();
      // Mirage's 1.5 s intro (by name, as Play map intro takes it).
      expect((await api("/api/v1/map-intros/play", { map: "de_mirage" })).status).toBe(200);
      await waitFor(() => !running(), 10000);
      expect(Date.now() - t0).toBeGreaterThan(3300);
      expect(e.mapIntros.status().last).toMatchObject({ map: "de_mirage", end: "timeout", backTo: "Game" });
    } finally {
      o.mediaEvents = true;
    }
    // Taken: OBS switched to another scene by the operator meanwhile.
    await sleep(300);
    o.changes.length = 0;
    expect((await api("/api/v1/map-intros/play")).status).toBe(200);
    await waitFor(() => e.program.mode === "MAP_INTRO");
    await sleep(700);
    await theyShow("Desk");
    await waitFor(() => !running(), 5000);
    expect(e.mapIntros.status().last).toMatchObject({ end: "taken", backTo: null });
    expect([e.program.mode, e.program.operatorScene, o.program]).toEqual(["MANUAL", "Desk", "Desk"]);
    expect(volume()).toBe(0.8);
    // Stop: back to where it came from (the operator's Desk).
    expect((await api("/api/v1/map-intros/play")).status).toBe(200);
    await waitFor(() => e.program.mode === "MAP_INTRO");
    await sleep(500);
    expect((await api("/api/v1/map-intros/stop")).status).toBe(200);
    await waitFor(() => !running(), 5000);
    expect(e.mapIntros.status().last).toMatchObject({ end: "stopped", backTo: "Desk" });
    expect((await api("/api/v1/map-intros/stop")).json.message).toBe("No map intro is on air.");
    await theyShow("Game");
  }, 40000);

  it("Play next map's intro: the active match's next map (from Inferno, Nuke: the default intro), before the server changes map; then not again by itself on that map", async () => {
    e.settings.set("mapIntro.played", []);
    await api("/api/v1/map-intros/settings", { trigger: "map_load" }, "PUT");
    await feed({ mapName: "de_inferno", mapPhase: "gameover", round: 16, roundPhase: "over", phase: "gameover", scoreT: 13, scoreCT: 4 });
    expect(e.mapIntros.status()).toMatchObject({ nextMap: { map: "de_nuke", displayName: "Nuke", hasIntro: true, isDefault: true }, blockedNext: null });
    await waitFor(() => e.program.mode === "STUDIO");
    o.changes.length = 0;
    const r = await api("/api/v1/devices/actions/map_intro_next", {});
    expect(r.status, r.json.message).toBe(200);
    expect(r.json.result).toMatchObject({ running: true, onAir: "Nuke" });
    await untilOver();
    expect(e.mapIntros.status().last).toMatchObject({ map: "de_nuke", isDefault: true, by: "operator", kind: "manual", end: "ended", backTo: "Desk" });
    expect(changes()).toEqual([
      ["MatchFrame Map Intro", "MatchFrame Stinger"],
      ["Desk", "MatchFrame Stinger"],
    ]);
    // Nuke loads: its intro played already this match, so not again; the studio scene goes live as before.
    o.changes.length = 0;
    await warmup("de_nuke");
    await waitFor(() => e.program.mode === "LIVE");
    await sleep(500);
    expect(changes()).toEqual([["Game", "Cut"]]);
    expect(e.mapIntros.status().current).toMatchObject({ map: "de_nuke", played: { by: "operator", kind: "manual" } });
    // The tally.
    const tally = await api("/api/v1/devices/tally", undefined, "GET");
    expect(tally.json.mapIntro).toMatchObject({ running: false, onAir: null, ready: true });
  }, 40000);

  it("when the map loads, from the OBS automation's studio scene: the intro first, then straight to the live scene (not the studio scene again)", async () => {
    e.settings.set("mapIntro.played", []);
    await feed({ mapName: "de_nuke", mapPhase: "gameover", round: 20, roundPhase: "over", phase: "gameover", scoreT: 13, scoreCT: 7 });
    await waitFor(() => e.program.mode === "STUDIO");
    await sleep(300);
    o.changes.length = 0;
    await warmup("de_mirage");
    await untilOver();
    await sleep(400);
    expect(changes()).toEqual([
      ["MatchFrame Map Intro", "MatchFrame Stinger"],
      ["Game", "MatchFrame Stinger"],
    ]);
    expect(e.mapIntros.status().auto).toMatchObject({ map: "de_mirage", kind: "map_load", started: true });
    expect(e.program.mode).toBe("LIVE");
  }, 30000);

  it("waits for the round's replays while its moment lasts; never by itself over the operator's own scene, with why", async () => {
    e.settings.set("mapIntro.played", []);
    await api("/api/v1/map-intros/settings", { trigger: "match_live" }, "PUT");
    const real = e.autoReplay.runningKind.bind(e.autoReplay);
    let replays = true;
    e.autoReplay.runningKind = () => (replays ? "break" : real());
    try {
      await freeze(1, { settle: false, left: 15 });
      await sleep(500);
      expect(running()).toBe(false);
      expect(e.mapIntros.status()).toMatchObject({ state: "waiting", waiting: { map: "de_mirage", kind: "match_live" }, detail: "Mirage's intro waits: the round's replays are on air." });
      replays = false;
      await untilOver();
      expect(e.mapIntros.status().auto).toMatchObject({ kind: "match_live", started: true });
      // Waiting until the round went live: not played, with why.
      e.settings.set("mapIntro.played", []);
      replays = true;
      await feed({ mapName: "de_mirage", mapPhase: "warmup", roundPhase: "live", phase: "warmup", phaseEndsIn: 60 });
      await freeze(1, { settle: false });
      await live(1);
      await sleep(400);
      expect(e.mapIntros.status().auto).toMatchObject({ kind: "match_live", started: false, detail: "Mirage's intro wasn't played when the match went live: the round's replays were on air until the round went live." });
    } finally {
      e.autoReplay.runningKind = real;
    }
    // The operator's own scene at the moment: not played over it.
    e.settings.set("mapIntro.played", []);
    await theyShow("Analysis");
    await feed({ mapName: "de_mirage", mapPhase: "warmup", roundPhase: "live", phase: "warmup", phaseEndsIn: 60 });
    o.changes.length = 0;
    await freeze(1, { settle: false });
    await sleep(500);
    expect(o.changes).toEqual([]);
    expect(e.mapIntros.status().auto).toMatchObject({ started: false, detail: "Mirage's intro wasn't played when the match went live: OBS showed your scene “Analysis”. Press Play map intro to play it." });
    await theyShow("Game");
  }, 40000);
});

/** Map intros with vMix as the mixer (stand-in-vmix.ts): the intro as an input, Map intro in and out, the live audio down and back, cut back when the round goes live. */
describe.skipIf(!hasFfmpeg)("Map intros (vMix)", () => {
  let e: Engine;
  let servers: Awaited<ReturnType<typeof startServers>>;
  let gsiPort: number;
  let apiPort: number;
  let ts = 1_700_800_000;
  const v = new StandInVmix();
  const data = mkdtempSync(join(tmpdir(), "mf-intro-vmix-data-"));
  const src = mkdtempSync(join(tmpdir(), "mf-intro-vmix-videos-"));

  const feed = async (spec: SyntheticPayloadSpec) => {
    const payload = buildSyntheticGsiPayload({ mapName: "de_mirage", players: PISTOLS, token: e.secrets.gsiToken, timestamp: ts++, ...spec });
    expect((await fetch(`http://127.0.0.1:${gsiPort}/gsi`, { method: "POST", body: JSON.stringify(payload) })).status).toBe(200);
    await sleep(300);
  };
  const api = async (path: string, body?: unknown, method = "POST") => {
    const r = await fetch(`http://127.0.0.1:${apiPort}${path}`, { method, headers: { authorization: `Bearer ${e.secrets.operatorToken}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> & { message?: string } };
  };

  beforeAll(async () => {
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    const videos = makeVideos(src);
    v.clipMs = 1500;
    await v.start();
    const ports = { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
    gsiPort = ports.gsi;
    apiPort = ports.api;
    e = new Engine(loadConfig({ dataDir: data, gsiPort: ports.gsi, apiPort: ports.api, overlayPort: ports.overlay, host: "127.0.0.1", captainUiDir: null, hudRendererDir: null, mapPackDir: null, workersDir: null, pythonPath: null, sampleHudsDirs: [], cloudEnforcement: "off" }));
    await e.init();
    servers = await startServers(e);
    e.autoReplay.setSettings({ enabled: false, mixer: "vmix", vmixUrl: v.url, vmixTransition: "Fade", vmixTransitionOut: "CutDirect", duckVmixInputs: ["game-key"], duckTo: -20, duckRampMs: 100 });
    await e.autoReplay.checkVmix();
    const r = await fetch(`http://127.0.0.1:${apiPort}/api/v1/map-intros/de_mirage?name=mirage.mp4`, { method: "POST", headers: { authorization: `Bearer ${e.secrets.operatorToken}` }, body: readFileSync(videos.mirage) });
    expect(r.status).toBe(200);
    e.mapIntros.setSettings({ trigger: "pistol", vmixIn: "Stinger1" });
  }, 60000);

  afterAll(async () => {
    v.close();
    await servers?.close();
    await e?.shutdown();
  });

  it("by itself at pistol round start: added as an input, Stinger 1 to it, back to the input before with the replays' Replay out, the input removed, the live audio down and back", async () => {
    await feed({ mapPhase: "warmup", roundPhase: "live", phase: "warmup", phaseEndsIn: 60 });
    expect((await api("/api/v1/map-intros", undefined, "GET")).json.setup).toMatchObject({ mixer: "vmix" });
    await feed({ mapPhase: "live", round: 0, roundPhase: "freezetime", phase: "freezetime", phaseEndsIn: 15 });
    await sleep(1300);
    await feed({ mapPhase: "live", round: 0, roundPhase: "freezetime", phase: "freezetime", phaseEndsIn: 13.4 });
    await waitFor(() => e.mapIntros.onAir());
    await waitFor(() => !e.mapIntros.onAir(), 10000);
    await sleep(2500);
    expect(v.calls.filter((c) => /^(AddInput|Play|Stinger1|Fade|CutDirect|RemoveInput) /.test(c)).map((c) => c.replace(/ k\d+/, " intro"))).toEqual(["AddInput Video", "Play intro", "Stinger1 intro", "CutDirect live", "RemoveInput intro"]);
    expect(v.calls.find((c) => c.startsWith("AddInput"))).toBe("AddInput Video");
    expect(v.active).toBe(1);
    expect(v.audioLog.filter((a) => a.title === "Game audio").map((a) => Math.round(a.volume ?? -1))).toEqual([45, 80, 80]);
    expect(e.mapIntros.status().last).toMatchObject({ map: "de_mirage", by: "automation", kind: "pistol", end: "ended", backTo: "CS2" });
  }, 30000);

  it("cut back to the game when the round goes live during it; refused during a live round", async () => {
    v.clipMs = 9000;
    v.calls.length = 0;
    await feed({ mapPhase: "live", round: 1, roundPhase: "freezetime", phase: "freezetime", phaseEndsIn: 10, scoreT: 1 });
    expect((await api("/api/v1/map-intros/play")).status).toBe(200);
    await sleep(800);
    await feed({ mapPhase: "live", round: 1, roundPhase: "live", phase: "live", phaseEndsIn: 110, scoreT: 1 });
    await waitFor(() => !e.mapIntros.onAir(), 5000);
    expect(e.mapIntros.status().last).toMatchObject({ end: "cut", backTo: "CS2" });
    expect(v.calls.filter((c) => /^(Stinger1|CutDirect) /.test(c)).map((c) => c.replace(/ k\d+/, " intro"))).toEqual(["Stinger1 intro", "CutDirect live"]);
    expect((await api("/api/v1/map-intros/play")).json.message).toBe("A round is live: the intro plays between rounds (in the warmup, a freeze time, or after the round).");
  }, 30000);
});
