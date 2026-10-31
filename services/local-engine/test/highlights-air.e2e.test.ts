import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClipRecord, ReplayPlay } from "@matchframe/replay-agent";
import { buildSyntheticGsiPayload, syntheticRoster } from "../../../packages/cs2-state/src/testing/gsi-builder.ts";
import { Engine } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { KeptClip, KeptMap } from "../src/replay/highlights.ts";
import { startServers } from "../src/servers.ts";
import { StandInObs } from "./stand-in-obs.ts";
import { StandInVmix } from "./stand-in-vmix.ts";

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

/** Each kept clip plays 3 s in the stand-ins; its part (the play and its lead-up) is the last 1.5 s. */
const DURATION = 3000;
const PLAY = 1500;
const T0 = Date.parse("2026-10-31T10:00:00Z");

/**
 * Kept clips (replay/highlights.ts's index, as a restart finds it): this map (de_dust2) with eight,
 * the previous one (de_mirage) with two. None of them is in the replay list any more.
 */
function keptIndex(data: string): { root: string; labels: Record<string, string> } {
  const root = join(data, "kept-clips");
  const labels: Record<string, string> = {};
  const clip = (map: string, id: string, round: number, label: string, p: ReplayPlay): KeptClip => {
    const file = `${map}/${id}.mp4`;
    mkdirSync(join(root, map), { recursive: true });
    writeFileSync(join(root, file), Buffer.alloc(64));
    labels[id] = label;
    return { id, label, reason: p.kind, roundNumber: round, createdAt: new Date(T0 + round * 120_000).toISOString(), origin: "replay_pc", play: p, played: true, file, root, bytes: 64, playMs: PLAY, leadMs: 800, trim: null, media: { durationMs: DURATION, width: 1920, height: 1080, frameRate: 60, hasAudio: true }, team: null, side: round <= 12 ? "T" : "CT", killAt: T0 + round * 120_000 };
  };
  const play = (killer: string, kills: number, weapon = "ak47", headshot = false): ReplayPlay => ({ kind: "shown", killer: { steamId: `steam-${killer}`, name: killer }, victims: Array.from({ length: kills }, (_, k) => `${killer}-v${k}`), kills, weapon, headshot });
  const dust: KeptMap = {
    key: "m2",
    mapName: "de_dust2",
    matchId: null,
    title: null,
    startedAt: new Date(T0).toISOString(),
    kills: [],
    winners: Object.fromEntries(Array.from({ length: 15 }, (_, k) => [String(k + 1), k % 2 ? "CT" : "T"])),
    clips: [
      clip("m2", "hl-alpha", 2, "2K alpha", play("alpha", 2, "ak47", true)),
      clip("m2", "hl-bravo", 4, "ACE bravo", play("bravo", 5)),
      clip("m2", "hl-charlie", 6, "3K charlie", play("charlie", 3)),
      clip("m2", "hl-delta", 8, "Knife delta", play("delta", 1, "knife")),
      clip("m2", "hl-echo", 10, "2K echo", play("echo", 2)),
      clip("m2", "hl-foxtrot", 11, "foxtrot", play("foxtrot", 1)),
      clip("m2", "hl-golf", 14, "3K golf", play("golf", 3)),
      clip("m2", "hl-hotel", 15, "2K hotel", play("hotel", 2)),
    ],
  };
  const mirage: KeptMap = { key: "m1", mapName: "de_mirage", matchId: null, title: null, startedAt: new Date(T0 - 3_600_000).toISOString(), kills: [], winners: {}, clips: [clip("m1", "pm-kilo", 3, "3K kilo", play("kilo", 3)), clip("m1", "pm-lima", 9, "2K lima", play("lima", 2))] };
  mkdirSync(join(data, "highlights"), { recursive: true });
  writeFileSync(join(data, "highlights", "index.json"), JSON.stringify({ version: 1, maps: [mirage, dust] }));
  return { root, labels };
}

/** The built-in HUD's page (its replay page shows the replay graphic). */
function renderer(dir: string): string {
  const r = join(dir, "renderer");
  mkdirSync(r, { recursive: true });
  writeFileSync(join(r, "index.html"), "<!doctype html><title>renderer</title>");
  return r;
}

/**
 * Highlights on air with a stand-in OBS at the obs-websocket level (stand-in-obs.ts): the highlights
 * scene set up (its media source, its twin, the replay graphic's source on top, shared with the
 * replay scene); a map's best kept clips played back to back from the live scene, the operator's own
 * scene and the studio scene, fading between the scene and its twin, with Highlights in and out, the
 * replay graphic on each clip, the live audio turned down and put back, and back to where the program
 * came from; Skip, Hold, Stop; the operator taking the program in OBS; refused while a round is live
 * and (by default) at halftime; a halftime ending mid-way cut back to live by the round clock; no
 * round replays while they play; the automatic starts; Studio Mode; Stream Deck actions.
 */
describe("Highlights on air (OBS)", () => {
  let e: Engine;
  let o: StandInObs;
  let servers: Awaited<ReturnType<typeof startServers>>;
  let gsiPort: number;
  let apiPort: number;
  let ts = 1_700_500_000;
  const roster = syntheticRoster();
  const data = mkdtempSync(join(tmpdir(), "mf-hl-air-data-"));
  const dir = mkdtempSync(join(tmpdir(), "mf-hl-air-"));
  const { labels } = keptIndex(data);
  const queueFile = join(dir, "queue-clip.mp4");

  /** Game data: `round` is the round's number (1-based). */
  const feed = async (roundPhase: "live" | "over" | "freezetime", round: number, opts: { phaseEndsIn?: number; phase?: string; mapPhase?: "live" | "intermission" | "gameover" } = {}) => {
    const payload = buildSyntheticGsiPayload({ mapName: "de_dust2", mapPhase: opts.mapPhase ?? "live", round: round - 1, players: roster, observed: roster[0]!.steamId, roundPhase, phase: opts.phase ?? roundPhase, phaseEndsIn: opts.phaseEndsIn ?? (roundPhase === "live" ? 115 : 15), token: e.secrets.gsiToken, timestamp: ts++ });
    expect((await fetch(`http://127.0.0.1:${gsiPort}/gsi`, { method: "POST", body: JSON.stringify(payload) })).status).toBe(200);
    await sleep(300);
  };
  const api = async (path: string, body?: unknown, method = "POST", token?: string) => {
    const r = await fetch(`http://127.0.0.1:${apiPort}${path}`, { method, headers: { authorization: `Bearer ${token ?? e.secrets.operatorToken}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> & { message?: string } };
  };
  /** The operator, in OBS (a multiview button, a scene clicked). */
  const theyShow = async (scene: string) => {
    await o.call("SetCurrentProgramScene", { sceneName: scene });
    await waitFor(() => e.obs.state.programScene === scene);
    await sleep(250);
  };
  const running = () => e.autoReplay.runningKind() === "highlights";
  const settle = () => sleep(600);
  /** Plays the highlights (as the operator's Play) and waits for them to end, collecting what was on air meanwhile. */
  const playThrough = async (during?: (seen: { lines: string[]; graphic: (string | null)[]; first: string }) => Promise<void> | void) => {
    const seen = { lines: [] as string[], graphic: [] as (string | null)[], first: "" };
    const watch = setInterval(() => {
      const line = e.highlightsAir.status().detail;
      if (running() && /^Highlight \d/.test(line) && seen.lines.at(-1) !== line) seen.lines.push(line);
      if (running() && !seen.lines.length && line !== seen.first) seen.first = line;
      const g = e.hudState("hud:matchframe-default", "replay")?.replay.clip?.id ?? null;
      if (seen.graphic.at(-1) !== g) seen.graphic.push(g);
    }, 30);
    try {
      const r = await api("/api/v1/highlights/air/play");
      expect(r.status, r.json.message).toBe(200);
      expect(running()).toBe(true);
      if (during) await during(seen);
      await waitFor(() => !running());
      await settle();
    } finally {
      clearInterval(watch);
    }
    return seen;
  };
  const volume = () => o.inputs.get("Game audio")!.audio.volumeMul;

  beforeAll(async () => {
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    writeFileSync(queueFile, Buffer.alloc(64));
    const ports = { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
    gsiPort = ports.gsi;
    apiPort = ports.api;
    e = new Engine(loadConfig({ dataDir: data, gsiPort: ports.gsi, apiPort: ports.api, overlayPort: ports.overlay, host: "127.0.0.1", captainUiDir: null, hudRendererDir: renderer(dir), mapPackDir: null, workersDir: null, pythonPath: null, sampleHudsDirs: [], cloudEnforcement: "off" }));
    await e.init();
    servers = await startServers(e);
    o = await StandInObs.attach(e, (obs) => {
      obs.addScene("Game");
      obs.addInput("Game", "Game audio", "wasapi_output_capture");
      obs.inputs.get("Game audio")!.audio.volumeMul = 0.8;
      obs.addScene("Analysis");
      obs.addScene("Casters");
      obs.addScene("Desk");
      obs.addScene("Break");
      obs.program = "Game";
      obs.current = "Cut";
      obs.defaultDurationMs = DURATION;
    });
    const scenes = { LIVE: "Game", STUDIO: "Desk", BREAK: "Break" };
    e.settings.set("program.scenes", scenes);
    e.program.setScenes(scenes);
    e.autoReplay.setSettings({ enabled: true, startDelayMs: 2000, perBreak: 3, order: "best", ownBigPlays: false, between: "fade", fadeMs: 400, duckInputs: ["Game audio"], duckTo: -20, duckRampMs: 150 });
    // Replay in: the stinger; Replay out: OBS's own (Cut). Highlights in and out the same until chosen.
    e.obsAuto.setSettings({ replayIn: "Matchframe Replay Stinger", replayOut: "", otherScenes: "", mapEnd: false });
    await feed("freezetime", 2);
  });

  afterAll(async () => {
    await servers?.close();
    await e?.shutdown();
  });

  it("sets up the highlights scene: its media source set like the replay scene's, the replay graphic's source on top (the replay scene's own), and its twin", async () => {
    expect((await api("/api/v1/replays/obs-setup")).status).toBe(200);
    expect((await api("/api/v1/replay-graphic/obs")).json).toMatchObject({ scene: "Matchframe Replay", created: true, onTop: true });
    // Before it is set up: Play says what to do.
    const before = await api("/api/v1/highlights/air", undefined, "GET");
    expect((before.json.status as { blocked: string }).blocked).toBe("Set up the highlights scene: Set up OBS highlights scene, or pick your own scene and its media source.");
    const r = await api("/api/v1/highlights/air/obs-setup");
    expect(r.status, r.json.message).toBe(200);
    expect(r.json).toMatchObject({ scene: "Matchframe Highlights", input: "Matchframe Highlights Clip", created: true, graphic: { created: false, onTop: true }, graphicError: null });
    expect(o.scenes.get("Matchframe Highlights")!.map((i) => i.source)).toEqual(["Matchframe Highlights Clip", "Matchframe Replay Graphic"]);
    // The twin: the same graphic source (shared), a media source of its own.
    expect(o.scenes.get("Matchframe Highlights B")!.map((i) => i.source)).toEqual(["Matchframe Highlights Clip B", "Matchframe Replay Graphic"]);
    expect([...o.inputs.keys()].filter((n) => n === "Matchframe Replay Graphic")).toHaveLength(1);
    expect(o.scenes.get("Matchframe Replay")!.map((i) => i.source)).toContain("Matchframe Replay Graphic");
    for (const n of ["Matchframe Highlights Clip", "Matchframe Highlights Clip B"]) expect(o.inputs.get(n)!.settings, n).toMatchObject({ is_local_file: true, restart_on_activate: false, close_when_inactive: false, clear_on_media_end: false });
    expect(o.inputs.get("Matchframe Highlights Clip")!.kind).toBe("ffmpeg_source");
    expect(e.program.sceneMap).toMatchObject({ LIVE: "Game", REPLAY: "Matchframe Replay", HIGHLIGHTS: "Matchframe Highlights" });
    expect(e.settings.get("program.scenes", {})).toMatchObject({ HIGHLIGHTS: "Matchframe Highlights" });
    expect(e.program.highlightsScenes).toEqual(["Matchframe Highlights", "Matchframe Highlights B"]);
    const view = await api("/api/v1/highlights/air", undefined, "GET");
    expect(view.json.setup).toMatchObject({ mixer: "obs", scene: "Matchframe Highlights", input: "Matchframe Highlights Clip", sceneReady: true, sameAsReplay: false, twin: { scene: "Matchframe Highlights B", ready: true }, graphic: { source: "Matchframe Replay Graphic", inScene: true, onTop: true } });
    expect(view.json.status).toMatchObject({ state: "ready", blocked: null, halftime: false });
    // The preview: this map's best five, in round order, with their length and the running time.
    const plan = (view.json.status as { plan: { clips: { id: string; roundNumber: number; playMs: number }[]; totalMs: number } }).plan;
    expect(plan.clips.map((c) => [c.id, c.roundNumber, c.playMs])).toEqual([
      ["hl-alpha", 2, PLAY],
      ["hl-bravo", 4, PLAY],
      ["hl-charlie", 6, PLAY],
      ["hl-delta", 8, PLAY],
      ["hl-golf", 14, PLAY],
    ]);
    expect(plan.totalMs).toBe(5 * PLAY - 4 * 400);
    // The OBS scenes panel's transitions: Highlights in and out the same as Replay in and out until chosen.
    expect((await api("/api/v1/obs/auto", undefined, "GET")).json).toMatchObject({ settings: { highlightsIn: null, highlightsOut: null }, highlightsScenes: ["Matchframe Highlights", "Matchframe Highlights B"] });
  });

  it("plays from the live scene: Highlights in, a fade between the scene and its twin each clip at its part, the replay graphic of each kept clip, the live audio down and back, then back to the live scene", async () => {
    o.changes.length = 0;
    o.volumeLog.length = 0;
    const history = e.program.history.length;
    const seen = await playThrough();
    // The status line, clip by clip (before the first is on air: going on air).
    expect(seen.first).toBe("Highlights going on air…");
    expect(seen.lines).toEqual(["Highlight 1 of 5: 2K alpha", "Highlight 2 of 5: ACE bravo", "Highlight 3 of 5: 3K charlie", "Highlight 4 of 5: Knife delta", "Highlight 5 of 5: 3K golf"]);
    // Highlights in (as Replay in: the stinger), fades between the scene and its twin, Highlights out (as Replay out: OBS's own, Cut).
    expect(o.changes.map((c) => [c.scene, c.transition])).toEqual([
      ["Matchframe Highlights", "Matchframe Replay Stinger"],
      ["Matchframe Highlights B", "Fade"],
      ["Matchframe Highlights", "Fade"],
      ["Matchframe Highlights B", "Fade"],
      ["Matchframe Highlights", "Fade"],
      ["Game", "Cut"],
    ]);
    for (const k of [1, 2, 3, 4]) {
      const to = k % 2 ? "Matchframe Highlights Clip B" : "Matchframe Highlights Clip";
      expect(o.changes[k]!.durationMs).toBe(400);
      // The next one waits at its part (the play and its lead-up: the last 1.5 s), and comes in from there.
      expect(o.changes[k]!.media[to]!.cursorMs, `clip ${k + 1} at the fade`).toBeGreaterThanOrEqual(DURATION - PLAY);
      expect(o.changes[k]!.media[to]!.cursorMs, `clip ${k + 1} at the fade`).toBeLessThanOrEqual(DURATION - PLAY + 80);
    }
    // The replay graphic showed each kept clip (none of them in the replay list), and nothing after.
    expect(seen.graphic.filter(Boolean)).toEqual(["hl-alpha", "hl-bravo", "hl-charlie", "hl-delta", "hl-golf"]);
    expect(e.replays.get("hl-bravo")).toBeUndefined();
    expect(seen.graphic.at(-1)).toBeNull();
    // The live audio down 20 dB, and back to exactly 0.8.
    expect(Math.min(...o.volumeLog.filter((v) => v.input === "Game audio").map((v) => v.mul))).toBeCloseTo(0.08, 3);
    expect(volume()).toBe(0.8);
    expect(e.autoReplay.audio.lowered).toBe(false);
    // One change in and one out for the program; the program live again, OBS's own transition back.
    expect(e.program.history.slice(history).map((t) => `${t.from}>${t.to}`)).toEqual(["LIVE>HIGHLIGHTS", "HIGHLIGHTS>LIVE"]);
    expect([e.program.mode, o.program, o.current]).toEqual(["LIVE", "Game", "Cut"]);
    expect(e.highlightsAir.status().last).toMatchObject({ by: "operator", played: 5, skipped: 0, failed: 0, stopped: "ended", backTo: "Game" });
    expect(e.highlightsAir.status().detail).toMatch(/^Play: 5 clips, 0:06\. Last highlights: 5 played\.$/);
  }, 30000);

  it("plays from the operator's own scene (a multiview's analysis scene) with the chosen Highlights in and out, and goes back to it: theirs again", async () => {
    e.highlightsAir.setSettings({ count: 2 });
    e.obsAuto.setSettings({ highlightsIn: "", highlightsOut: "Matchframe Replay Stinger" });
    await theyShow("Analysis");
    expect([e.program.mode, e.program.operatorScene]).toEqual(["MANUAL", "Analysis"]);
    o.changes.length = 0;
    await playThrough(async () => {
      await waitFor(() => e.program.mode === "HIGHLIGHTS");
      expect(e.program.highlightsReturn).toEqual({ mode: "MANUAL", scene: "Analysis", owner: { kind: "operator", holder: "OBS: Analysis" } });
    });
    expect(o.changes.map((c) => [c.scene, c.transition])).toEqual([
      ["Matchframe Highlights", "Cut"],
      ["Matchframe Highlights B", "Fade"],
      ["Analysis", "Matchframe Replay Stinger"],
    ]);
    expect([e.program.mode, e.program.operatorScene, e.program.owner, o.program]).toEqual(["MANUAL", "Analysis", { kind: "operator", holder: "OBS: Analysis" }, "Analysis"]);
    // Still theirs: automatic replays wait, nothing changes OBS.
    await sleep(500);
    expect(e.autoReplay.getStatus().detail).toBe("OBS shows “Analysis” (your scene): replays wait until you're back on the live scene.");
    expect(e.highlightsAir.status().last).toMatchObject({ backTo: "Analysis" });
    expect(volume()).toBe(0.8);
    e.obsAuto.setSettings({ highlightsIn: null, highlightsOut: null });
    await theyShow("Game");
    expect(e.program.mode).toBe("LIVE");
  }, 30000);

  it("plays from the studio scene and goes back to it with its owner; to the live scene when the scene it came from is gone", async () => {
    await e.program.request("STUDIO", "operator", "op");
    o.changes.length = 0;
    await playThrough();
    expect(o.changes.map((c) => c.scene)).toEqual(["Matchframe Highlights", "Matchframe Highlights B", "Desk"]);
    expect([e.program.mode, e.program.owner, o.program]).toEqual(["STUDIO", { kind: "operator", holder: "op" }, "Desk"]);
    // From the analysis scene, removed in OBS while the highlights play: the live scene.
    await theyShow("Analysis");
    o.changes.length = 0;
    await playThrough(async () => {
      o.scenes.delete("Analysis");
      await e.obs.refresh();
    });
    expect(o.changes.map((c) => c.scene)).toEqual(["Matchframe Highlights", "Matchframe Highlights B", "Game"]);
    expect([e.program.mode, o.program]).toEqual(["LIVE", "Game"]);
    o.addScene("Analysis");
    await e.obs.refresh();
  }, 30000);

  it("Skip, Hold and Stop: the next highlight at once, the clip on air held, back to where the program came from", async () => {
    e.highlightsAir.setSettings({ count: 3 });
    o.changes.length = 0;
    await playThrough(async (seen) => {
      await waitFor(() => seen.lines.length === 1 && o.changes.length === 1);
      await sleep(300);
      const at = Date.now();
      expect((await api("/api/v1/replays/auto/skip")).status).toBe(200);
      await waitFor(() => o.changes.length === 2);
      expect(Date.now() - at).toBeLessThan(600);
      expect(e.highlightsAir.status().detail).toBe("Highlight 2 of 3: 3K charlie");
      // Hold: the clip on air pauses (its cursor stays) until Resume.
      await sleep(200);
      expect(((await api("/api/v1/replays/auto/hold", { held: true })).json.status as { held: boolean }).held).toBe(true);
      expect(e.highlightsAir.status()).toMatchObject({ running: true, held: true, position: { n: 2, of: 3 } });
      await sleep(150);
      const a = o.media("Matchframe Highlights Clip B");
      await sleep(1500);
      const b = o.media("Matchframe Highlights Clip B");
      expect([a.state, b.state, b.cursorMs - a.cursorMs]).toEqual(["PAUSED", "PAUSED", 0]);
      expect(o.changes).toHaveLength(2);
      await api("/api/v1/replays/auto/hold", { held: false });
      await waitFor(() => o.changes.length === 3);
      // Stop: back to the live scene now, with Highlights out.
      await sleep(300);
      const stop = await api("/api/v1/highlights/air/stop");
      expect(stop.status).toBe(200);
      await waitFor(() => o.program === "Game", 2000);
    });
    expect(o.changes.map((c) => [c.scene, c.transition])).toEqual([
      ["Matchframe Highlights", "Matchframe Replay Stinger"],
      ["Matchframe Highlights B", "Fade"],
      ["Matchframe Highlights", "Fade"],
      ["Game", "Cut"],
    ]);
    expect(e.highlightsAir.status().last).toMatchObject({ played: 3, skipped: 1, stopped: "stopped", backTo: "Game" });
    expect(volume()).toBe(0.8);
    expect((await api("/api/v1/highlights/air/stop")).json).toMatchObject({ error: "no_highlights", message: "No highlights are on air." });
  }, 30000);

  it("stops and changes nothing more when the operator puts another scene on in OBS meanwhile", async () => {
    o.changes.length = 0;
    await playThrough(async (seen) => {
      await waitFor(() => seen.lines.length === 1 && o.changes.length === 1);
      await sleep(400);
      await theyShow("Casters");
    });
    await sleep(800);
    expect(o.changes.map((c) => c.scene)).toEqual(["Matchframe Highlights", "Casters"]);
    expect([e.program.mode, e.program.operatorScene, o.program]).toEqual(["MANUAL", "Casters", "Casters"]);
    expect(e.highlightsAir.status().last).toMatchObject({ stopped: "taken" });
    expect(volume()).toBe(0.8);
    await theyShow("Game");
  }, 30000);

  it("is refused while a round is live, and the round's replays never start while highlights are on air (nor after them, in that break)", async () => {
    await feed("live", 3);
    const live = await api("/api/v1/highlights/air/play");
    expect([live.status, live.json.message]).toEqual([409, "A round is live: highlights start between rounds, or after the map."]);
    // The round ends with a clip for its replays (they start 2 s after it); highlights go on air first.
    const play: ReplayPlay = { kind: "shown", killer: { steamId: "k-q", name: "quebec" }, victims: ["v-q"], kills: 1, weapon: "ak47", headshot: false };
    const c: ClipRecord = { clipId: "cq", providerId: "replay-pc", sourceId: "replay-pc", angle: "recorded_angle", matchTimeFromMs: null, matchTimeToMs: null, timeUncertaintyMs: null, epoch: null, roundNumber: 3, media: { path: queueFile, durationMs: DURATION, frameRate: 60, timebase: null, startPts: null, hasAudio: true, width: 1920, height: 1080 }, createdAt: new Date().toISOString() };
    const q = e.replays.addExternal("quebec", "shown", 3, c, { playMs: 2000, leadMs: 800, play });
    await feed("over", 3);
    o.changes.length = 0;
    await playThrough(async () => {
      await sleep(2500);
      expect(e.autoReplay.getStatus().detail).toMatch(/^Highlight/);
    });
    await sleep(2500);
    expect(o.changes.map((c) => c.scene)).not.toContain("Matchframe Replay");
    expect(e.replays.get(q.id)!.state).toBe("prepared");
    expect(e.autoReplay.getStatus().detail).toBe("Replays for this break are done (highlights went on air instead).");
    // The next round's replays play as before; Play is refused meanwhile.
    await feed("live", 4);
    e.replays.addExternal("romeo", "shown", 4, { ...c, clipId: "cr", roundNumber: 4, createdAt: new Date().toISOString() }, { playMs: 2000, leadMs: 800, play: { ...play, killer: { steamId: "k-r", name: "romeo" } } });
    await feed("over", 4);
    await waitFor(() => e.autoReplay.runningKind() === "break");
    const during = await api("/api/v1/highlights/air/play");
    expect([during.status, during.json.message]).toEqual([409, "The round's replays are playing: wait for them, or press Stop."]);
    await waitFor(() => e.autoReplay.getStatus().detail.startsWith("Replays for this break are done"));
    await settle();
    expect(e.program.mode).toBe("LIVE");
  }, 40000);

  it("Don't show highlights at halftime (on by default): highlights already playing play on; refused at halftime, by Play and the Stream Deck; the Stream Deck switches it", async () => {
    const deck = e.secrets.issue("replay", "Deck").token;
    const act = (id: string, body: unknown = {}) => api(`/api/v1/devices/actions/${id}`, body, "POST", deck);
    expect(e.highlightsAir.settings().noHalftime).toBe(true);
    // Highlights started before halftime (the half's last round over, the game's round number not moved
    // on yet) play on when it begins.
    await feed("live", 12);
    await feed("over", 12);
    expect(e.highlightsAir.halftime()).toBe(false);
    o.changes.length = 0;
    await playThrough(async (seen) => {
      await waitFor(() => seen.lines.length === 1);
      await feed("over", 13, { mapPhase: "intermission", phase: "over" });
      expect(e.highlightsAir.halftime()).toBe(true);
    });
    expect(e.highlightsAir.status().last).toMatchObject({ played: 3, stopped: "ended", backTo: "Game" });
    // At halftime (the game's halftime phase): refused, with why.
    const st = (await api("/api/v1/highlights/air", undefined, "GET")).json.status as { halftime: boolean; blocked: string };
    expect(st).toMatchObject({ halftime: true, blocked: "Highlights at halftime are off (Don't show highlights at halftime)." });
    expect((await api("/api/v1/highlights/air/play")).json.message).toBe("Highlights at halftime are off (Don't show highlights at halftime).");
    expect((await act("highlights_play")).json).toMatchObject({ error: "highlights_refused", message: "Highlights at halftime are off (Don't show highlights at halftime)." });
    // The freeze time before the second half's first round is halftime too.
    await feed("freezetime", 13);
    expect(e.highlightsAir.halftime()).toBe(true);
    expect((await api("/api/v1/highlights/air/play")).status).toBe(409);
    let tally = (await api("/api/v1/devices/tally", undefined, "GET", deck)).json as { highlights: Record<string, unknown> };
    expect(tally.highlights).toMatchObject({ running: false, ready: false, halftime: true, noHalftime: true });
    // Switched off from a Stream Deck: Play works at halftime.
    expect((await act("highlights_halftime", { on: false })).json).toMatchObject({ result: { noHalftime: false, halftime: true }, tally: { highlights: { noHalftime: false, ready: true } } });
    const played = await act("highlights_play");
    expect(played.status, played.json.message).toBe(200);
    expect(played.json.result).toMatchObject({ state: "playing", running: true });
    await waitFor(() => !running());
    await settle();
    // Toggled back on.
    expect((await act("highlights_halftime")).json.result).toMatchObject({ noHalftime: true });
    tally = (await api("/api/v1/devices/tally", undefined, "GET", deck)).json as { highlights: Record<string, unknown> };
    expect(tally.highlights).toMatchObject({ noHalftime: true, halftime: true, ready: false });
  }, 40000);

  it("halftime ending while they play (Don't show highlights at halftime off): they play on into the round until its clock reads the cut back, then the live scene, not the analysis scene", async () => {
    e.highlightsAir.setSettings({ noHalftime: false, count: "all" });
    e.autoReplay.setSettings({ cutBackClockSec: 112 });
    await feed("over", 13, { mapPhase: "intermission", phase: "over" });
    await theyShow("Analysis");
    o.changes.length = 0;
    let liveAt = 0;
    await playThrough(async (seen) => {
      await waitFor(() => seen.lines.length === 1);
      await feed("freezetime", 13, { phaseEndsIn: 1 });
      expect(running()).toBe(true);
      liveAt = Date.now();
      await feed("live", 13, { phaseEndsIn: 115 });
      await waitFor(() => !running());
      // On into the live round, and back by 1:52 on its clock (115 - 112 s, less the 0.25 s lead): a clip
      // that wouldn't end by then isn't started.
      expect(Date.now() - liveAt).toBeGreaterThan(1000);
      expect(Date.now() - liveAt).toBeLessThan(3400);
    });
    expect(["deadline", "ended"]).toContain(e.highlightsAir.status().last!.stopped);
    expect(e.highlightsAir.status().last!.played).toBeLessThan(8);
    expect(e.highlightsAir.status().last).toMatchObject({ backTo: "Game" });
    expect([e.program.mode, o.program]).toEqual(["LIVE", "Game"]);
    expect(o.changes.at(-1)!.scene).toBe("Game");
    expect(volume()).toBe(0.8);
    e.autoReplay.setSettings({ cutBackClockSec: 110 });
    e.highlightsAir.setSettings({ count: 2 });
  }, 40000);

  it("start by themselves at halftime only from the live scene, and never with Don't show highlights at halftime on", async () => {
    // On (with the automatic start ticked): nothing starts.
    e.highlightsAir.setSettings({ noHalftime: true, autoHalftime: true });
    await feed("live", 24);
    await feed("over", 25, { mapPhase: "live", phase: "over" });
    await sleep(1200);
    expect(running()).toBe(false);
    // Off, from the live scene: the first overtime half's halftime starts them.
    e.highlightsAir.setSettings({ noHalftime: false });
    await waitFor(() => running(), 3000);
    await waitFor(() => e.program.mode === "HIGHLIGHTS");
    expect(e.program.highlightsReturn?.mode).toBe("LIVE");
    await waitFor(() => !running());
    await settle();
    expect(e.highlightsAir.status().auto).toMatchObject({ trigger: "halftime", started: true });
    expect(e.highlightsAir.status().last).toMatchObject({ by: "automation", stopped: "ended", backTo: "Game" });
    // The next overtime half's halftime with the operator's own scene on: not started.
    await feed("live", 27);
    await theyShow("Analysis");
    await feed("over", 28, { phase: "over" });
    await sleep(1200);
    expect(running()).toBe(false);
    expect(e.highlightsAir.status().auto).toMatchObject({ trigger: "halftime", started: false, detail: "Not started at halftime: OBS showed your scene “Analysis”." });
    e.highlightsAir.setSettings({ autoHalftime: false, noHalftime: true });
    await theyShow("Game");
  }, 30000);

  it("Studio Mode: the operator's preview put back after each change; the Transition button meanwhile takes the program", async () => {
    await feed("freezetime", 29);
    await o.call("SetStudioModeEnabled", { studioModeEnabled: true });
    await o.call("SetCurrentPreviewScene", { sceneName: "Desk" });
    await e.obs.refresh();
    o.changes.length = 0;
    await playThrough();
    expect(o.changes.map((c) => c.scene)).toEqual(["Matchframe Highlights", "Matchframe Highlights B", "Game"]);
    await waitFor(() => o.preview === "Desk", 2000);
    // The Transition button during the highlights (the twin in preview): theirs.
    o.changes.length = 0;
    await playThrough(async (seen) => {
      await waitFor(() => seen.lines.length === 1 && o.changes.length === 1);
      await sleep(300);
      await o.call("SetCurrentPreviewScene", { sceneName: "Casters" });
      o.transitionButton();
    });
    await sleep(800);
    expect(o.changes.map((c) => c.scene)).toEqual(["Matchframe Highlights", "Casters"]);
    expect([e.program.mode, e.program.operatorScene]).toEqual(["MANUAL", "Casters"]);
    await o.call("SetStudioModeEnabled", { studioModeEnabled: false });
    await e.obs.refresh();
    await theyShow("Game");
  }, 30000);

  it("Stream Deck: highlights_play, replay_skip and replay_hold on the highlight on air, highlights_stop, the tally", async () => {
    const deck = e.secrets.issue("replay", "Deck 2").token;
    const viewer = e.secrets.issue("viewer", "Viewer").token;
    const act = (id: string, body: unknown = {}, token = deck) => api(`/api/v1/devices/actions/${id}`, body, "POST", token);
    const list = (await api("/api/v1/devices/actions", undefined, "GET", deck)).json as unknown as { id: string; allowed: boolean }[];
    expect(list.filter((a) => a.id.startsWith("highlights_")).map((a) => [a.id, a.allowed])).toEqual([
      ["highlights_play", true],
      ["highlights_stop", true],
      ["highlights_halftime", true],
    ]);
    expect((await act("highlights_play", {}, viewer)).status).toBe(403);
    e.highlightsAir.setSettings({ count: 3 });
    o.changes.length = 0;
    const started = await act("highlights_play");
    expect(started.status, started.json.message).toBe(200);
    await waitFor(() => o.changes.length === 1);
    let tally = (await api("/api/v1/devices/tally", undefined, "GET", deck)).json as { highlights: Record<string, unknown>; replay: Record<string, unknown> };
    expect(tally.highlights).toMatchObject({ running: true, held: false, onAir: "ACE bravo", position: { n: 1, of: 3 }, noHalftime: true });
    expect(tally.replay).toMatchObject({ running: true, onAir: "ACE bravo" });
    await sleep(300);
    expect((await act("replay_skip")).status).toBe(200);
    await waitFor(() => o.changes.length === 2);
    const held = await act("replay_hold");
    expect(held.json).toMatchObject({ result: { held: true }, tally: { highlights: { held: true, onAir: "3K charlie" } } });
    expect((await act("replay_hold", { held: false })).json.result).toMatchObject({ held: false });
    const stopped = await act("highlights_stop");
    expect(stopped.status).toBe(200);
    await waitFor(() => !running());
    await settle();
    expect([e.program.mode, o.program]).toEqual(["LIVE", "Game"]);
    tally = (await api("/api/v1/devices/tally", undefined, "GET", deck)).json as typeof tally;
    expect(tally.highlights).toMatchObject({ running: false, onAir: null, ready: true });
    expect((await act("highlights_stop")).json).toMatchObject({ error: "no_highlights" });
  }, 30000);

  it("the previous map and the last half: what plays, chosen in the panel", async () => {
    await api("/api/v1/highlights/air", { what: "previous", count: "all" }, "PUT");
    const plan = ((await api("/api/v1/highlights/air", undefined, "GET")).json.status as { plan: { mapName: string; clips: { label: string }[] } }).plan;
    expect([plan.mapName, plan.clips.map((c) => c.label)]).toEqual(["de_mirage", ["3K kilo", "2K lima"]]);
    o.changes.length = 0;
    const seen = await playThrough();
    expect(seen.lines).toEqual(["Highlight 1 of 2: 3K kilo", "Highlight 2 of 2: 2K lima"]);
    // The previous map's clips on the replay graphic too.
    expect(seen.graphic.filter(Boolean)).toEqual(["pm-kilo", "pm-lima"]);
    await api("/api/v1/highlights/air", { what: "half", count: 5 }, "PUT");
    const half = ((await api("/api/v1/highlights/air", undefined, "GET")).json.status as { plan: { rounds: { from: number; to: number }; clips: { label: string; roundNumber: number }[] } }).plan;
    // The half of the last round this map has (its halves: MR12, overtime halves of 3).
    const last = e.highlights.lastRound(e.highlights.current()!)!;
    expect(half.rounds.from).toBeLessThanOrEqual(last);
    expect(half.rounds.to).toBeGreaterThanOrEqual(last);
    expect(half.clips.every((c) => c.roundNumber >= half.rounds.from && c.roundNumber <= half.rounds.to)).toBe(true);
    expect(Object.keys(labels)).toContain("hl-golf");
  }, 30000);

  it("start by themselves when a map ends, from the live scene, before the studio scene, which comes after them", async () => {
    e.highlightsAir.setSettings({ what: "map", count: 2, autoMapEnd: true });
    e.obsAuto.setSettings({ mapEnd: true });
    await feed("live", 30);
    o.changes.length = 0;
    await feed("over", 30, { mapPhase: "gameover", phase: "gameover" });
    await waitFor(() => running(), 3000);
    await waitFor(() => !running());
    await waitFor(() => e.program.mode === "STUDIO", 3000);
    expect(o.changes.map((c) => c.scene)).toEqual(["Matchframe Highlights", "Matchframe Highlights B", "Game", "Desk"]);
    expect(e.highlightsAir.status().auto).toMatchObject({ trigger: "map end", started: true });
    e.obsAuto.setSettings({ mapEnd: false });
  }, 30000);
});

/** Highlights on air with vMix as the replay mixer (stand-in-vmix.ts): its own Highlights in and out, the fade between, the live audio, back to the input before. */
describe("Highlights on air (vMix)", () => {
  let e: Engine;
  let servers: Awaited<ReturnType<typeof startServers>>;
  let gsiPort: number;
  let apiPort: number;
  let ts = 1_700_600_000;
  const v = new StandInVmix();
  const roster = syntheticRoster();
  const data = mkdtempSync(join(tmpdir(), "mf-hl-vmix-data-"));
  keptIndex(data);

  const feed = async (roundPhase: "live" | "freezetime", round: number) => {
    const payload = buildSyntheticGsiPayload({ mapName: "de_dust2", round: round - 1, players: roster, observed: roster[0]!.steamId, roundPhase, phase: roundPhase, phaseEndsIn: roundPhase === "live" ? 115 : 15, token: e.secrets.gsiToken, timestamp: ts++ });
    expect((await fetch(`http://127.0.0.1:${gsiPort}/gsi`, { method: "POST", body: JSON.stringify(payload) })).status).toBe(200);
    await sleep(300);
  };
  const api = async (path: string, body?: unknown, method = "POST") => {
    const r = await fetch(`http://127.0.0.1:${apiPort}${path}`, { method, headers: { authorization: `Bearer ${e.secrets.operatorToken}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> & { message?: string } };
  };

  beforeAll(async () => {
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    v.clipMs = DURATION;
    await v.start();
    const ports = { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
    gsiPort = ports.gsi;
    apiPort = ports.api;
    e = new Engine(loadConfig({ dataDir: data, gsiPort: ports.gsi, apiPort: ports.api, overlayPort: ports.overlay, host: "127.0.0.1", captainUiDir: null, hudRendererDir: null, mapPackDir: null, workersDir: null, pythonPath: null, sampleHudsDirs: [], cloudEnforcement: "off" }));
    await e.init();
    servers = await startServers(e);
    e.autoReplay.setSettings({ enabled: false, mixer: "vmix", vmixUrl: v.url, vmixTransition: "Fade", vmixTransitionOut: "CutDirect", between: "fade", fadeMs: 500, duckVmixInputs: ["game-key"], duckTo: -20, duckRampMs: 100 });
    await e.autoReplay.checkVmix();
  });

  afterAll(async () => {
    v.close();
    await servers?.close();
    await e?.shutdown();
  });

  it("plays the clips as vMix inputs with Highlights in, fades between them, and goes back to the input before with Highlights out; the live audio down and back; refused while a round is live", async () => {
    await feed("live", 9);
    expect((await api("/api/v1/highlights/air/play")).json.message).toBe("A round is live: highlights start between rounds, or after the map.");
    await feed("freezetime", 16);
    const view = await api("/api/v1/highlights/air", { count: 3, vmixIn: "Stinger1" }, "PUT");
    expect(view.json.setup).toMatchObject({ mixer: "vmix" });
    const lines: string[] = [];
    const watch = setInterval(() => {
      const d = e.highlightsAir.status().detail;
      if (/^Highlight \d/.test(d) && lines.at(-1) !== d) lines.push(d);
    }, 30);
    try {
      const r = await api("/api/v1/highlights/air/play");
      expect(r.status, r.json.message).toBe(200);
      await waitFor(() => e.autoReplay.runningKind() === null);
    } finally {
      clearInterval(watch);
    }
    expect(lines).toEqual(["Highlight 1 of 3: ACE bravo", "Highlight 2 of 3: 3K charlie", "Highlight 3 of 3: 3K golf"]);
    // Highlights in: Stinger 1 (chosen); between: a 0.5 s fade; Highlights out: as Replay out (CutDirect) to the input before.
    expect(v.calls.filter((c) => /^(AddInput|Stinger1|Fade|CutDirect) /.test(c)).map((c) => c.replace(/ k\d+/, " clip"))).toEqual(["AddInput Video", "Stinger1 clip", "AddInput Video", "Fade clip 500", "AddInput Video", "Fade clip 500", "CutDirect live"]);
    expect(v.active).toBe(1);
    // The live audio: down to 20 dB less, and back to 80.
    expect(v.audioLog.filter((a) => a.title === "Game audio").map((a) => Math.round(a.volume ?? -1))).toEqual([45, 80, 80]);
    expect(e.highlightsAir.status().last).toMatchObject({ played: 3, stopped: "ended", backTo: null });
  }, 30000);
});
