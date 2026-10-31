import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClipRecord, ReplayPlay } from "@matchframe/replay-agent";
import { buildSyntheticGsiPayload, syntheticRoster } from "../../../packages/cs2-state/src/testing/gsi-builder.ts";
import { Engine } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { AutoReplayStatus } from "../src/replay/auto.ts";
import { TEST_CLIPS, testClipsDir } from "../src/replay/test-run.ts";
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
const waitFor = async (fn: () => boolean, ms = 15000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(20);
  }
};

const roster = syntheticRoster();
/** Each file plays 3 s in the stand-in OBS (and vMix); a clip's part is its last 2.5 s. */
const DURATION = 3000;
const PLAY = 2500;
/** The live game audio's volume before the replays (OBS's multiplier), and turned down 20 dB. */
const GAME = 0.8;
const DUCKED = 0.08;

/** An engine with a stand-in OBS (replay scene, its twin, a live scene with game audio and a caster's mic) and the HTTP API. */
async function engineWith(dataDir?: string) {
  process.env.MATCHFRAME_LOG_STDOUT = "0";
  const ports = { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
  const e = new Engine(loadConfig({ dataDir: dataDir ?? mkdtempSync(join(tmpdir(), "mf-ctl-data-")), gsiPort: ports.gsi, apiPort: ports.api, overlayPort: ports.overlay, host: "127.0.0.1", captainUiDir: null, hudRendererDir: null, mapPackDir: null, workersDir: null, pythonPath: null, sampleHudsDirs: [], cloudEnforcement: "off" }));
  await e.init();
  const servers = await startServers(e);
  let ts = 1_700_200_000;
  const feed = async (roundPhase: "live" | "over" | "freezetime", round: number, phaseEndsIn?: number) => {
    const payload = buildSyntheticGsiPayload({ mapName: "de_dust2", round, players: roster, observed: roster[0]!.steamId, roundPhase, phase: roundPhase, phaseEndsIn: phaseEndsIn ?? (roundPhase === "live" ? 115 : 7), token: e.secrets.gsiToken, timestamp: ts++ });
    expect((await fetch(`http://127.0.0.1:${ports.gsi}/gsi`, { method: "POST", body: JSON.stringify(payload) })).status).toBe(200);
    await sleep(300);
  };
  const api = async (path: string, body?: unknown, method = "POST", token = e.secrets.operatorToken) => {
    const r = await fetch(`http://127.0.0.1:${ports.api}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> & { status?: AutoReplayStatus; message?: string } };
  };
  return { e, servers, feed, api };
}

function setUpObs(o: StandInObs): void {
  o.addScene("Game");
  o.addInput("Game", "Game capture", "color_source_v3");
  o.addInput("Game", "Game audio", "wasapi_output_capture");
  o.addInput("Game", "Caster mic", "wasapi_input_capture");
  o.inputs.get("Game audio")!.audio.volumeMul = GAME;
  o.inputs.get("Caster mic")!.audio.volumeMul = 0.9;
  o.addScene("Desk");
  o.addScene("My Replay");
  o.addInput("My Replay", "Backdrop", "color_source_v3");
  o.addInput("My Replay", "replay", "ffmpeg_source", { is_local_file: true });
  o.addInput("My Replay", "Score bug", "browser_source", { url: "http://127.0.0.1/bug" });
  o.program = "Game";
  o.defaultDurationMs = DURATION;
}

/**
 * The operator's controls of a break's replays (Skip, Stop and go live, Hold and Resume, Exclude and
 * Pin; in the console, from a control surface), the live game audio turned down while they play and
 * put back however they end (also after a restart), the replay volume, and Test replays, with a
 * stand-in OBS at the obs-websocket level (stand-in-obs.ts: the twin and its fades) and a stand-in
 * vMix (stand-in-vmix.ts).
 */
describe("Replay controls, sound and Test replays (OBS)", () => {
  let e: Engine;
  let o: StandInObs;
  let servers: Awaited<ReturnType<typeof startServers>>;
  let feed: Awaited<ReturnType<typeof engineWith>>["feed"];
  let api: Awaited<ReturnType<typeof engineWith>>["api"];
  let dataDir: string;
  const dir = mkdtempSync(join(tmpdir(), "mf-ctl-"));
  const files = ["a", "b", "c", "d"].map((n) => join(dir, `clip-${n}.mp4`));
  const clip = (round: number, path: string): ClipRecord => ({ clipId: `c${Math.random()}`, providerId: "replay-pc", sourceId: "replay-pc", angle: "recorded_angle", matchTimeFromMs: null, matchTimeToMs: null, timeUncertaintyMs: null, epoch: null, roundNumber: round, media: { path, durationMs: DURATION, frameRate: 60, timebase: null, startPts: null, hasAudio: true, width: 1920, height: 1080 }, createdAt: new Date().toISOString() });
  const add = (round: number, label: string, kills: number, path: string) => {
    const play: ReplayPlay = { kind: "missed", killer: { steamId: `k-${label}`, name: label }, victims: [`v-${label}`], kills, weapon: "ak47", headshot: false };
    return e.replays.addExternal(label, play.kind, round, clip(round, path), { playMs: PLAY, leadMs: 1000, play });
  };
  const done = () => e.autoReplay.getStatus().detail.startsWith("Replays for this break are done");
  const states = (round: number) => e.replays.list().filter((i) => i.roundNumber === round).map((i) => [i.label, i.state]);
  const loads = () => o.mediaLog.filter((l) => l.includes(" load ")).map((l) => l.replace(/^.* load /, ""));
  /** The live game audio went down (with its ramp) during the break and is back exactly as before, the caster's mic never touched. */
  const expectAudioBack = (since: number) => {
    const game = o.volumeLog.filter((v) => v.input === "Game audio" && v.at >= since);
    expect(Math.min(...game.map((v) => v.mul))).toBeCloseTo(DUCKED, 5);
    expect(o.inputs.get("Game audio")!.audio).toMatchObject({ volumeMul: GAME, muted: false });
    expect(o.volumeLog.some((v) => v.input === "Caster mic")).toBe(false);
    expect(e.settings.get("replay.duck", null)).toBeNull();
  };
  const at = () => Date.now() - (o as unknown as { t0: number }).t0;

  beforeAll(async () => {
    for (const f of files) writeFileSync(f, Buffer.alloc(64));
    dataDir = mkdtempSync(join(tmpdir(), "mf-ctl-data-"));
    ({ e, servers, feed, api } = await engineWith(dataDir));
    o = await StandInObs.attach(e, setUpObs);
    const scenes = { LIVE: "Game", REPLAY: "My Replay", STUDIO: "Desk", BREAK: null };
    e.settings.set("program.scenes", scenes);
    e.program.setScenes(scenes);
    e.settings.set("replay.mediaInput", "replay");
    e.autoReplay.setSettings({ enabled: true, startDelayMs: 0, perBreak: 3, order: "best", ownBigPlays: false, between: "fade", fadeMs: 400, duckInputs: ["Game audio"], duckTo: -20, duckRampMs: 300 });
  });

  afterAll(async () => {
    await servers?.close();
    await e?.shutdown();
  });

  it("lists the mixer's inputs with audio for picking the live game audio, the replay sources marked", async () => {
    await e.replayTwin.sync();
    const r = await api("/api/v1/replays/audio-inputs", undefined, "GET");
    const inputs = r.json.inputs as { id: string; picked: boolean; replay: boolean; volume: number }[];
    expect(inputs.map((i) => i.id).sort()).toEqual(["Caster mic", "Game audio", "Score bug", "replay", "replay B"]);
    expect(inputs.find((i) => i.id === "Game audio")).toMatchObject({ picked: true, replay: false, volume: -1.9 });
    expect(inputs.find((i) => i.id === "replay B")).toMatchObject({ picked: false, replay: true });
  });

  it("Skip: the clip on air ends now and the next fades in as usual; skipping the last goes back to live with Replay out; the live audio goes down and comes back", async () => {
    e.obsAuto.setSettings({ replayIn: "", replayOut: "Cut" });
    await feed("live", 4);
    const round = e.session.state()!.roundNumber!;
    add(round, "triple", 3, files[0]!);
    add(round, "double", 2, files[1]!);
    add(round, "single", 1, files[2]!);
    o.changes.length = 0;
    const since = at();
    await feed("over", 4);
    await waitFor(() => o.changes.length === 1);
    await sleep(600);
    const skippedAt = Date.now();
    const r = await api("/api/v1/replays/auto/skip");
    expect(r.status).toBe(200);
    expect(r.json.status).toMatchObject({ running: true, playing: { label: "triple" }, position: { n: 1, of: 3 } });
    await waitFor(() => o.changes.length === 2);
    expect(Date.now() - skippedAt).toBeLessThan(500);
    // The fade to the next started long before the skipped clip's own (0.4 s before its end), the next at its part.
    expect(o.changes[1]!.media.replay!.cursorMs).toBeLessThan(DURATION - 1200);
    expect(o.changes[1]!.media["replay B"]!.cursorMs).toBeGreaterThanOrEqual(DURATION - PLAY);
    expect(o.changes[1]!.media["replay B"]!.cursorMs).toBeLessThanOrEqual(DURATION - PLAY + 80);
    // The second plays to its fade; the third is skipped: back to live, with Replay out (Cut).
    await waitFor(() => o.changes.length === 3);
    await sleep(300);
    expect((await api("/api/v1/replays/auto/skip")).json.status).toMatchObject({ position: { n: 3, of: 3 } });
    await waitFor(() => o.changes.length === 4);
    expect(o.changes.map((c) => [c.scene, c.transition])).toEqual([
      ["My Replay", "Fade"],
      ["My Replay B", "Fade"],
      ["My Replay", "Fade"],
      ["Game", "Cut"],
    ]);
    await waitFor(done);
    expect(e.autoReplay.getStatus().detail).toBe("Replays for this break are done (3 played, 2 skipped).");
    expect(states(round).map(([, s]) => s)).toEqual(["played", "played", "played"]);
    // The live audio went down as the replays started (with a ramp of several steps) and came back exactly.
    const down = o.volumeLog.filter((v) => v.input === "Game audio" && v.at >= since && v.mul < GAME);
    expect(down.length).toBeGreaterThanOrEqual(4);
    expect(Math.abs(down[0]!.at - o.changes[0]!.at)).toBeLessThan(250);
    await waitFor(() => o.inputs.get("Game audio")!.audio.volumeMul === GAME);
    expectAudioBack(since);
    // Back up as the program went back to live.
    const up = o.volumeLog.filter((v) => v.input === "Game audio" && v.at >= o.changes[3]!.at);
    expect(up[0]!.at - o.changes[3]!.at).toBeLessThan(300);
    expect(e.autoReplay.getStatus().audio).toMatchObject({ state: "idle", lastRestore: { ok: true, detail: "Put back: Game audio." } });
  }, 30000);

  it("Stop and go live: the break's replays end now, back to the live scene with Replay out; the rest stay for playing by hand", async () => {
    await feed("live", 5);
    const round = e.session.state()!.roundNumber!;
    add(round, "triple", 3, files[0]!);
    add(round, "double", 2, files[1]!);
    o.changes.length = 0;
    const since = at();
    await feed("over", 5);
    await waitFor(() => o.changes.length === 1);
    await sleep(500);
    expect((await api("/api/v1/replays/auto/stop")).status).toBe(200);
    await waitFor(() => o.changes.length === 2);
    expect(o.changes.map((c) => [c.scene, c.transition])).toEqual([
      ["My Replay", "Fade"],
      ["Game", "Cut"],
    ]);
    await waitFor(done);
    expect(e.autoReplay.getStatus().detail).toBe("Replays for this break are done (1 played, stopped by the operator).");
    expect(states(round)).toEqual([
      ["triple", "played"],
      ["double", "prepared"],
    ]);
    expect(e.program.mode).toBe("LIVE");
    await waitFor(() => o.inputs.get("Game audio")!.audio.volumeMul === GAME);
    expectAudioBack(since);
    // Nothing playing: nothing to skip, hold or stop.
    expect((await api("/api/v1/replays/auto/skip")).status).toBe(409);
    expect((await api("/api/v1/replays/auto/hold")).status).toBe(409);
  }, 30000);

  it("Hold pauses the clip on air and goes on to nothing until Resume; held again, the next round's clock still cuts back to live by 1:50", async () => {
    e.autoReplay.setSettings({ cutBack: "clock", cutBackClockSec: 110 });
    await feed("live", 7);
    const round = e.session.state()!.roundNumber!;
    add(round, "double", 2, files[0]!);
    add(round, "single", 1, files[1]!);
    o.changes.length = 0;
    o.mediaLog.length = 0;
    const since = at();
    await feed("over", 7);
    await waitFor(() => o.changes.length === 1);
    await sleep(400);
    expect((await api("/api/v1/replays/auto/hold")).json.status).toMatchObject({ held: true, running: true });
    await waitFor(() => o.mediaLog.includes("replay pause") && o.media("replay").state === "PAUSED");
    const heldAt = o.media("replay").cursorMs;
    // Longer than what was left of the clip: still paused where it was, no fade to the next.
    await sleep(2800);
    expect(o.changes).toHaveLength(1);
    expect(o.media("replay")).toMatchObject({ state: "PAUSED", cursorMs: heldAt });
    expect(e.autoReplay.getStatus().detail).toBe("Replay 1 of 2: double");
    const resumed = Date.now();
    expect((await api("/api/v1/replays/auto/hold", { held: false })).json.status).toMatchObject({ held: false });
    await waitFor(() => o.changes.length === 2);
    // It played on from where it was held, to its fade.
    expect(Date.now() - resumed).toBeGreaterThan(DURATION - heldAt - 400 - 400);
    expect(o.changes[1]!.media.replay!.cursorMs).toBeGreaterThan(DURATION - 600);
    // Held during the second clip; the next round goes live and its clock reads 1:51.2: back to live about 1 s later, held or not.
    await sleep(300);
    expect((await api("/api/v1/replays/auto/hold", { held: true })).json.status).toMatchObject({ held: true });
    await feed("live", 8);
    await feed("live", 8, 111.2);
    const clockAt = Date.now();
    await waitFor(() => o.changes.length === 3);
    expect(Date.now() - clockAt).toBeLessThan(1500);
    expect(o.changes[2]!.scene).toBe("Game");
    await waitFor(() => !e.autoReplay.getStatus().running);
    expect(e.autoReplay.getStatus().held).toBe(false);
    expect(states(round).map(([, st]) => st)).toEqual(["played", "played"]);
    await waitFor(() => o.inputs.get("Game audio")!.audio.volumeMul === GAME);
    expectAudioBack(since);
  }, 30000);

  it("Exclude and Pin before the break: the excluded clip never plays, the pinned one plays first", async () => {
    await feed("live", 10);
    const round = e.session.state()!.roundNumber!;
    const best = add(round, "best", 3, files[0]!);
    add(round, "middle", 2, files[1]!);
    const worst = add(round, "worst", 1, files[2]!);
    expect((await api(`/api/v1/replays/auto/clips/${best.id}`, { excluded: true }, "PUT")).status).toBe(200);
    const r = await api(`/api/v1/replays/auto/clips/${worst.id}`, { pinned: true }, "PUT");
    expect(r.json.status!.ranked.map((x) => [x.label, x.state, x.excluded, x.pinned, x.note])).toEqual([
      ["best", "left", true, false, "excluded by the operator"],
      ["middle", "waiting", false, false, null],
      ["worst", "waiting", false, true, null],
    ]);
    o.mediaLog.length = 0;
    await feed("over", 10);
    await waitFor(done);
    expect(loads()).toEqual(["clip-c.mp4", "clip-b.mp4"]);
    expect(states(round)).toEqual([
      ["best", "prepared"],
      ["middle", "played"],
      ["worst", "played"],
    ]);
    // Its break is over: pinning a clip of that round is refused.
    expect((await api(`/api/v1/replays/auto/clips/${best.id}`, { pinned: true }, "PUT")).status).toBe(409);
  }, 30000);

  it("Exclude and Pin during the break: the clip waiting off air is replaced, a clip left out joins next", async () => {
    e.autoReplay.setSettings({ perBreak: 3 });
    await feed("live", 12);
    const round = e.session.state()!.roundNumber!;
    add(round, "one", 4, files[0]!);
    const two = add(round, "two", 3, files[1]!);
    add(round, "three", 2, files[2]!);
    const four = add(round, "four", 1, files[3]!);
    o.mediaLog.length = 0;
    await feed("over", 12);
    // The first on air, the second waiting in the twin.
    await waitFor(() => loads().length === 2);
    expect(e.autoReplay.getStatus().ranked.find((x) => x.label === "four")!.state).toBe("left");
    await api(`/api/v1/replays/auto/clips/${two.id}`, { excluded: true }, "PUT");
    await waitFor(() => loads().length === 3);
    expect(loads()).toEqual(["clip-a.mp4", "clip-b.mp4", "clip-c.mp4"]);
    await api(`/api/v1/replays/auto/clips/${four.id}`, { pinned: true }, "PUT");
    await waitFor(() => loads().length === 4);
    expect(loads().at(-1)).toBe("clip-d.mp4");
    await waitFor(done);
    expect(loads()).toEqual(["clip-a.mp4", "clip-b.mp4", "clip-c.mp4", "clip-d.mp4", "clip-c.mp4"]);
    expect(states(round)).toEqual([
      ["one", "played"],
      ["two", "prepared"],
      ["three", "played"],
      ["four", "played"],
    ]);
    expect(e.autoReplay.getStatus().detail).toBe("Replays for this break are done (3 played).");
  }, 30000);

  it("Control surfaces (Stream Deck, Companion): the same actions with a replay token, and the replays in the tally", async () => {
    const deck = e.secrets.issue("replay", "Deck").token;
    const viewer = e.secrets.issue("viewer", "Viewer").token;
    const act = (id: string, body: unknown = {}, token = deck) => api(`/api/v1/devices/actions/${id}`, body, "POST", token);
    const list = (await api("/api/v1/devices/actions", undefined, "GET", deck)).json as unknown as { id: string; allowed: boolean }[];
    expect(list.filter((a) => a.id.startsWith("replay_")).map((a) => [a.id, a.allowed])).toEqual([
      ["replay_skip", true],
      ["replay_stop", true],
      ["replay_hold", true],
      ["replay_exclude", true],
      ["replay_pin", true],
    ]);
    expect((await act("replay_skip", {}, viewer)).status).toBe(403);
    expect((await act("replay_skip")).json).toMatchObject({ error: "no_replay", message: "No replay is on air." });
    await feed("live", 14);
    const round = e.session.state()!.roundNumber!;
    add(round, "one", 3, files[0]!);
    add(round, "two", 2, files[1]!);
    add(round, "three", 1, files[2]!);
    // The best one excluded by its rank in the round's list, the third pinned.
    expect((await act("replay_exclude", { rank: 1 })).status).toBe(200);
    expect((await act("replay_pin", { rank: 3 })).json.result).toMatchObject({ running: false });
    expect(((await act("replay_exclude", { rank: 9 })).status)).toBe(404);
    o.changes.length = 0;
    await feed("over", 14);
    await waitFor(() => o.changes.length === 1);
    let tally = (await api("/api/v1/devices/tally", undefined, "GET", deck)).json as { replay: Record<string, unknown> };
    expect(tally.replay).toMatchObject({ state: "playing", running: true, held: false, onAir: "three", position: { n: 1, of: 2 } });
    const held = await act("replay_hold");
    expect(held.json).toMatchObject({ action: "replay_hold", result: { held: true }, tally: { replay: { held: true } } });
    await sleep(500);
    expect((await act("replay_hold")).json.result).toMatchObject({ held: false });
    expect((await act("replay_skip")).status).toBe(200);
    await waitFor(() => o.changes.length === 2);
    expect((await act("replay_stop")).status).toBe(200);
    await waitFor(done);
    tally = (await api("/api/v1/devices/tally", undefined, "GET", deck)).json as { replay: Record<string, unknown> };
    expect(tally.replay).toMatchObject({ running: false, held: false, onAir: null });
    expect(states(round)).toEqual([
      ["one", "prepared"],
      ["two", "played"],
      ["three", "played"],
    ]);
  }, 30000);

  it("puts the live audio back on every ending: a clip OBS can't play, the operator taking the program; muted when chosen; a fader moved by hand during the replays stays", async () => {
    // A clip that doesn't play (an error) in the middle.
    await feed("live", 16);
    let round = e.session.state()!.roundNumber!;
    add(round, "one", 3, files[0]!);
    add(round, "broken", 2, join(dir, "broken.mp4"));
    o.broken.add(join(dir, "broken.mp4"));
    let since = at();
    await feed("over", 16);
    await waitFor(done);
    expect(e.autoReplay.getStatus().detail).toMatch(/1 played, 1 didn't play/);
    await waitFor(() => o.inputs.get("Game audio")!.audio.volumeMul === GAME);
    expectAudioBack(since);

    // The operator takes the program in OBS.
    await feed("live", 17);
    round = e.session.state()!.roundNumber!;
    add(round, "one", 3, files[0]!);
    add(round, "two", 2, files[1]!);
    o.changes.length = 0;
    since = at();
    await feed("over", 17);
    await waitFor(() => o.changes.length === 1);
    await sleep(500);
    await o.call("SetCurrentProgramScene", { sceneName: "Desk" });
    await waitFor(() => o.inputs.get("Game audio")!.audio.volumeMul === GAME);
    expectAudioBack(since);
    await e.program.request("LIVE", "operator", "op");
    await sleep(500);

    // Muted (and back), and a fader moved by hand meanwhile left as it was put.
    e.autoReplay.setSettings({ duckTo: "mute", duckInputs: ["Game audio", "Caster mic"] });
    await feed("live", 18);
    round = e.session.state()!.roundNumber!;
    add(round, "one", 3, files[0]!);
    o.changes.length = 0;
    await feed("over", 18);
    await waitFor(() => o.inputs.get("Game audio")!.audio.muted && o.inputs.get("Caster mic")!.audio.muted);
    expect(e.autoReplay.getStatus().audio).toMatchObject({ state: "lowered", lowered: ["Game audio", "Caster mic"] });
    o.inputs.get("Caster mic")!.audio.volumeMul = 0.3;
    await waitFor(done);
    await waitFor(() => !o.inputs.get("Game audio")!.audio.muted);
    expect(o.inputs.get("Game audio")!.audio.volumeMul).toBe(GAME);
    expect(o.inputs.get("Caster mic")!.audio).toMatchObject({ volumeMul: 0.3, muted: true });
    expect(e.autoReplay.getStatus().audio.lastRestore).toMatchObject({ ok: true, detail: "Put back: Game audio. Changed by hand during the replays, left as it is: Caster mic." });
    o.inputs.get("Caster mic")!.audio.muted = false;
    o.inputs.get("Caster mic")!.audio.volumeMul = 0.9;
    o.volumeLog.length = 0;
    e.autoReplay.setSettings({ duckTo: -20, duckInputs: ["Game audio"] });
  }, 40000);

  it("sets the replay volume on both replay media sources, louder or quieter", async () => {
    e.autoReplay.setSettings({ replayVolumeDb: -6 });
    await waitFor(() => Math.abs(o.inputs.get("replay")!.audio.volumeMul - 10 ** (-6 / 20)) < 1e-6 && Math.abs(o.inputs.get("replay B")!.audio.volumeMul - 10 ** (-6 / 20)) < 1e-6);
    e.autoReplay.setSettings({ replayVolumeDb: 6 });
    await waitFor(() => Math.abs(o.inputs.get("replay")!.audio.volumeMul - 10 ** (6 / 20)) < 1e-6 && Math.abs(o.inputs.get("replay B")!.audio.volumeMul - 10 ** (6 / 20)) < 1e-6);
    // Left as set in OBS: not touched any more.
    e.autoReplay.setSettings({ replayVolumeDb: null });
    o.inputs.get("replay")!.audio.volumeMul = 1;
    await e.replayTwin.sync();
    await e.autoReplay.audio.applyReplayVolume();
    expect(o.inputs.get("replay")!.audio.volumeMul).toBe(1);
    expect(o.inputs.get("replay B")!.audio.volumeMul).toBe(1);
  });

  it("Test replays: refuses while a round is live or the program isn't live, then plays the two sample clips through the real chain and reports each step", async () => {
    const samples = testClipsDir()!;
    expect(samples).toBeTruthy();
    for (const c of TEST_CLIPS) o.durations.set(join(samples, c.file), c.durationMs);
    e.obsAuto.setSettings({ replayIn: "Matchframe Replay Stinger", replayOut: "" });
    await feed("live", 20);
    expect((await api("/api/v1/replays/auto/test")).json).toMatchObject({ error: "test_refused", message: expect.stringMatching(/A round is live/) });
    await feed("freezetime", 20, 15);
    await e.program.request("STUDIO", "operator", "op");
    expect((await api("/api/v1/replays/auto/test")).json.message).toMatch(/The program isn't live \(studio\)/);
    await e.program.request("LIVE", "operator", "op");
    await sleep(500);
    o.changes.length = 0;
    const since = at();
    const r = await api("/api/v1/replays/auto/test");
    expect(r.status).toBe(200);
    expect(r.json.status!.test).toMatchObject({ state: "running", mixer: "obs" });
    // The replay graphic finds the clip on air and its play.
    await waitFor(() => e.program.activeReplay !== null);
    const onAir = e.replays.get(e.program.activeReplay!)!;
    expect(onAir).toMatchObject({ reason: "test", roundNumber: null, play: { killer: { name: "Test Player" }, weapon: "ak47", headshot: true } });
    expect(e.autoReplay.getStatus().detail).toMatch(/^Test replay 1 of 2: Test clip 1/);
    expect((await api("/api/v1/replays/auto/test")).json.message).toMatch(/Test replays are playing already/);
    await waitFor(() => e.autoReplay.getStatus().test?.state !== "running", 20000);
    const report = e.autoReplay.getStatus().test!;
    expect(report.steps.map((s) => [s.id, s.state])).toEqual([
      ["ready", "ok"],
      ["in", "ok"],
      ["fade", "ok"],
      ["out", "ok"],
      ["live", "ok"],
      ["audio", "ok"],
    ]);
    expect(report.state).toBe("passed");
    expect(report.steps.find((s) => s.id === "in")!.detail).toBe("Matchframe Replay Stinger to “My Replay”.");
    expect(report.steps.find((s) => s.id === "fade")!.detail).toBe("Fade to “My Replay B”.");
    expect(report.steps.find((s) => s.id === "out")!.detail).toBe("Fade back to “Game”.");
    expect(report.steps.find((s) => s.id === "audio")!.detail).toBe("Turned down: Game audio. Put back exactly as before (-20 dB during the replays).");
    // The same path as a break: Replay in, the fade through the twin, Replay out; the sample clips loaded.
    expect(o.changes.map((c) => [c.scene, c.transition])).toEqual([
      ["My Replay", "Matchframe Replay Stinger"],
      ["My Replay B", "Fade"],
      ["Game", "Fade"],
    ]);
    expect(o.mediaLog.filter((l) => l.includes(" load ")).slice(-2)).toEqual(["replay load test-clip-1.mp4", "replay B load test-clip-2.mp4"]);
    expectAudioBack(since);
    // Gone: never listed, ranked, in a highlight playlist, or recorded as played.
    expect(e.replays.get(onAir.id)).toBeUndefined();
    expect(e.replays.list().some((i) => i.reason === "test")).toBe(false);
    expect(e.replays.playlist().some((i) => i.reason === "test")).toBe(false);
    expect(e.autoReplay.getStatus().ranked.some((x) => x.label.startsWith("Test clip"))).toBe(false);
    expect(e.autoReplay.getStatus().lastPlayed?.label ?? "").not.toMatch(/Test clip/);
    e.obsAuto.setSettings({ replayIn: "", replayOut: null });
  }, 40000);

  it("Test replays: says what failed and how to fix it (a sample clip OBS can't play)", async () => {
    const samples = testClipsDir()!;
    o.broken.add(join(samples, TEST_CLIPS[1]!.file));
    try {
      expect((await api("/api/v1/replays/auto/test")).status).toBe(200);
      await waitFor(() => e.autoReplay.getStatus().test?.state !== "running", 20000);
      const report = e.autoReplay.getStatus().test!;
      expect(report.state).toBe("failed");
      expect(report.steps.find((s) => s.id === "fade")).toMatchObject({ state: "failed", detail: "The sample clip didn't play: OBS did not start the clip (media state OBS_MEDIA_STATE_ERROR).", fix: expect.stringMatching(/Media Source/) });
      expect(report.steps.find((s) => s.id === "in")!.state).toBe("ok");
      expect(report.steps.find((s) => s.id === "live")!.state).toBe("ok");
    } finally {
      o.broken.clear();
    }
  }, 40000);

  it("puts the live audio back after a crash or restart in the middle of a break, once OBS connects", async () => {
    await feed("live", 24);
    const round = e.session.state()!.roundNumber!;
    add(round, "one", 3, files[0]!);
    add(round, "two", 2, files[1]!);
    await feed("over", 24);
    await waitFor(() => Math.abs(o.inputs.get("Game audio")!.audio.volumeMul - DUCKED) < 1e-6);
    expect(e.settings.get("replay.duck", null)).toMatchObject({ mixer: "obs", inputs: [{ id: "Game audio", volume: GAME, muted: false }] });
    // The engine loses OBS (as when it crashes): nothing can be put back.
    await e.obs.disconnect();
    await servers.close();
    await e.shutdown();
    expect(o.inputs.get("Game audio")!.audio.volumeMul).toBeCloseTo(DUCKED, 6);
    // Started again on the same data: once OBS connects, the live audio is back exactly.
    ({ e, servers, feed, api } = await engineWith(dataDir));
    await o.connectTo(e);
    await waitFor(() => o.inputs.get("Game audio")!.audio.volumeMul === GAME);
    expect(o.inputs.get("Game audio")!.audio.muted).toBe(false);
    expect(e.settings.get("replay.duck", null)).toBeNull();
    expect(e.autoReplay.getStatus().audio.lastRestore).toMatchObject({ ok: true });
  }, 40000);
});

describe("Replay controls, sound and Test replays (vMix)", () => {
  let e: Engine;
  let servers: Awaited<ReturnType<typeof startServers>>;
  let feed: Awaited<ReturnType<typeof engineWith>>["feed"];
  let api: Awaited<ReturnType<typeof engineWith>>["api"];
  const v = new StandInVmix();
  const dir = mkdtempSync(join(tmpdir(), "mf-ctl-vmix-"));
  const add = (round: number, label: string, kills: number) => {
    const path = join(dir, `${label}.mp4`);
    writeFileSync(path, Buffer.alloc(64));
    const play: ReplayPlay = { kind: "missed", killer: { steamId: `k-${label}`, name: label }, victims: [`v-${label}`], kills, weapon: "ak47", headshot: false };
    const c: ClipRecord = { clipId: `c${Math.random()}`, providerId: "replay-pc", sourceId: "replay-pc", angle: "recorded_angle", matchTimeFromMs: null, matchTimeToMs: null, timeUncertaintyMs: null, epoch: null, roundNumber: round, media: { path, durationMs: 3000, frameRate: 60, timebase: null, startPts: null, hasAudio: true, width: 1920, height: 1080 }, createdAt: new Date().toISOString() };
    return e.replays.addExternal(label, play.kind, round, c, { playMs: 2500, leadMs: 1000, play });
  };
  const done = () => e.autoReplay.getStatus().detail.startsWith("Replays for this break are done");
  const game = () => v.find("game-key")!;

  beforeAll(async () => {
    v.clipMs = 3000;
    await v.start();
    ({ e, servers, feed, api } = await engineWith());
    e.autoReplay.setSettings({ enabled: true, startDelayMs: 0, perBreak: 3, order: "best", ownBigPlays: false, mixer: "vmix", vmixUrl: v.url, vmixTransition: "Fade", vmixTransitionOut: "CutDirect", between: "fade", fadeMs: 500, duckVmixInputs: ["game-key"], duckTo: -20, duckRampMs: 200, replayVolumeDb: -6 });
    await e.autoReplay.checkVmix();
  });

  afterAll(async () => {
    v.close();
    await servers?.close();
    await e?.shutdown();
  });

  it("lists vMix's inputs with audio for picking the live game audio", async () => {
    const r = await api("/api/v1/replays/audio-inputs", undefined, "GET");
    expect(r.json).toMatchObject({ mixer: "vmix", error: null });
    expect((r.json.inputs as { id: string; name: string; picked: boolean }[]).map((i) => [i.id, i.name, i.picked])).toEqual([
      ["live-key", "CS2", false],
      ["game-key", "Game audio", true],
      ["mic-key", "Caster mic", false],
    ]);
  });

  it("Hold pauses the vMix input on air until Resume, Skip goes on to the next (a fade), the replay volume is set on each input, and the live audio fades down and back", async () => {
    await feed("live", 4);
    const round = e.session.state()!.roundNumber!;
    add(round, "triple", 3);
    add(round, "double", 2);
    v.calls.length = 0;
    v.audioLog.length = 0;
    await feed("over", 4);
    await waitFor(() => v.calls.some((c) => c.startsWith("Fade k")));
    await sleep(400);
    expect((await api("/api/v1/replays/auto/hold")).json.status).toMatchObject({ held: true });
    await waitFor(() => v.calls.some((c) => /^Pause k\d+$/.test(c)));
    const paused = v.calls.find((c) => /^Pause k\d+$/.test(c))!.split(" ")[1]!;
    const pos = v.find(paused)!.position;
    await sleep(2500);
    expect(v.find(paused)).toMatchObject({ state: "Paused", position: pos });
    expect(v.calls.filter((c) => c.startsWith("Fade k"))).toHaveLength(1);
    await api("/api/v1/replays/auto/hold", { held: false });
    await waitFor(() => v.calls.includes(`Play ${paused}`) && v.calls.filter((c) => c === `Play ${paused}`).length === 2);
    // Skip the first: vMix fades to the second (loaded already) at once.
    const skipped = Date.now();
    await api("/api/v1/replays/auto/skip");
    await waitFor(() => v.calls.filter((c) => c.startsWith("Fade k")).length === 2);
    expect(Date.now() - skipped).toBeLessThan(500);
    expect(v.switchedAt[0]).toBeLessThan(3000 - 600);
    await waitFor(done);
    expect(v.calls).toContain("CutDirect live");
    // The replay volume: −6 dB on vMix's fader (100 × 10^(−6/80)).
    expect(v.calls.filter((c) => c.startsWith("SetVolume k"))).toEqual([`SetVolume ${paused} 84.14`, expect.stringMatching(/^SetVolume k\d+ 84\.14$/)]);
    // The live game audio: faded down 20 dB as the replays started (80 → 44.99), back to 80 after; the caster's mic never.
    expect(v.calls.filter((c) => c.includes(" game"))).toEqual(["SetVolumeFade game 44.99,200", "SetVolumeFade game 80,200", "SetVolume game 80"]);
    expect(v.calls.some((c) => c.includes(" mic"))).toBe(false);
    await waitFor(() => game().volume === 80);
    expect(e.settings.get("replay.duck", null)).toBeNull();
  }, 30000);

  it("Stop and go live goes back to the live input with Replay out, and the live audio comes back", async () => {
    await feed("live", 6);
    const round = e.session.state()!.roundNumber!;
    add(round, "triple", 3);
    add(round, "double", 2);
    v.calls.length = 0;
    await feed("over", 6);
    await waitFor(() => v.calls.some((c) => c.startsWith("Fade k")));
    await sleep(300);
    await api("/api/v1/replays/auto/stop");
    await waitFor(done);
    expect(v.calls.filter((c) => /^(Fade|CutDirect)/.test(c))).toEqual([expect.stringMatching(/^Fade k\d+$/), "CutDirect live"]);
    expect(e.autoReplay.getStatus().detail).toBe("Replays for this break are done (1 played, stopped by the operator).");
    await waitFor(() => game().volume === 80);
    expect(e.settings.get("replay.duck", null)).toBeNull();
  }, 30000);

  it("Test replays through vMix: the sample clips added and played as a break's, then the report", async () => {
    await feed("freezetime", 8, 15);
    v.calls.length = 0;
    expect((await api("/api/v1/replays/auto/test")).status).toBe(200);
    await waitFor(() => e.autoReplay.getStatus().test?.state !== "running", 20000);
    const report = e.autoReplay.getStatus().test!;
    expect(report.steps.map((s) => [s.id, s.state])).toEqual([
      ["ready", "ok"],
      ["in", "ok"],
      ["fade", "ok"],
      ["out", "ok"],
      ["live", "ok"],
      ["audio", "ok"],
    ]);
    expect(report.steps.find((s) => s.id === "out")!.detail).toBe("CutDirect back to “CS2”.");
    expect(v.calls.filter((c) => c.startsWith("AddInput"))).toHaveLength(2);
    expect(v.calls.filter((c) => /^(Fade|CutDirect)/.test(c))).toEqual([expect.stringMatching(/^Fade k\d+$/), expect.stringMatching(/^Fade k\d+ 500$/), "CutDirect live"]);
    expect(e.replays.list().some((i) => i.reason === "test")).toBe(false);
  }, 40000);
});
