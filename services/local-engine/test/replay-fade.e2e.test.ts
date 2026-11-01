import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClipRecord, ReplayPlay } from "@matchframe/replay-agent";
import { buildSyntheticGsiPayload, syntheticRoster } from "../../../packages/cs2-state/src/testing/gsi-builder.ts";
import { Engine } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { startServers } from "../src/servers.ts";
import { StandInObs } from "./stand-in-obs.ts";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

const waitFor = async (fn: () => boolean, ms = 15000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

/**
 * A break's replays fading from one to the next, with a stand-in OBS at the obs-websocket level
 * (stand-in-obs.ts): the user's own replay scene (a backdrop, the media source "replay" scaled and
 * cropped, a score bug on top, a filter and a volume on the media source, OBS's defaults for a new
 * Media Source) gets a twin, kept the same, and the break's clips alternate between the two (playback
 * "scenes": the way a break plays without a rendered file), the next loaded just in time off air and
 * playing hidden toward its part, the program fading over one fade length before the end; with a
 * Windows OBS's ways (a hidden source's pause let go, a clip wedged after a restart, a clip that stops).
 * The transitions in, out, between and to the other scenes are the ones chosen, and OBS's own is put
 * back after each.
 */
describe("Replay break: fading from one clip to the next through the replay scene's twin", () => {
  let e: Engine;
  let o: StandInObs;
  let servers: Awaited<ReturnType<typeof startServers>>;
  let gsiPort: number;
  let apiPort: number;
  let ts = 1_700_100_000;
  const roster = syntheticRoster();
  const dir = mkdtempSync(join(tmpdir(), "mf-fade-"));
  const files = ["a", "b", "c", "d"].map((n) => join(dir, `clip-${n}.mp4`));
  /** Each file plays 3 s in the stand-in OBS; a clip's part is its last 1.2 s. */
  const DURATION = 3000;
  const PLAY = 1200;

  const feed = async (roundPhase: "live" | "over" | "freezetime", round: number, phaseEndsIn?: number) => {
    const payload = buildSyntheticGsiPayload({ mapName: "de_dust2", round, players: roster, observed: roster[0]!.steamId, roundPhase, phase: roundPhase, phaseEndsIn: phaseEndsIn ?? (roundPhase === "live" ? 115 : 7), token: e.secrets.gsiToken, timestamp: ts++ });
    expect((await fetch(`http://127.0.0.1:${gsiPort}/gsi`, { method: "POST", body: JSON.stringify(payload) })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
  };
  const api = async (path: string, body?: unknown, method = "POST") => {
    const r = await fetch(`http://127.0.0.1:${apiPort}${path}`, { method, headers: { authorization: `Bearer ${e.secrets.operatorToken}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };
  const clip = (round: number, path: string): ClipRecord => ({ clipId: `c${Math.random()}`, providerId: "replay-pc", sourceId: "replay-pc", angle: "recorded_angle", matchTimeFromMs: null, matchTimeToMs: null, timeUncertaintyMs: null, epoch: null, roundNumber: round, media: { path, durationMs: DURATION, frameRate: 60, timebase: null, startPts: null, hasAudio: false, width: 1920, height: 1080 }, createdAt: new Date().toISOString() });
  const add = (round: number, label: string, kills: number, path: string) => {
    const play: ReplayPlay = { kind: "missed", killer: { steamId: `k-${label}`, name: label }, victims: [`v-${label}`], kills, weapon: "ak47", headshot: false };
    return e.replays.addExternal(label, play.kind, round, clip(round, path), { playMs: PLAY, leadMs: 600, play });
  };
  const done = () => e.autoReplay.getStatus().detail.startsWith("Replays for this break are done");
  const settle = () => new Promise((r) => setTimeout(r, 700));

  beforeAll(async () => {
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    for (const f of files) writeFileSync(f, Buffer.alloc(64));
    const ports = { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
    gsiPort = ports.gsi;
    apiPort = ports.api;
    e = new Engine(loadConfig({ dataDir: mkdtempSync(join(tmpdir(), "mf-fade-data-")), gsiPort: ports.gsi, apiPort: ports.api, overlayPort: ports.overlay, host: "127.0.0.1", captainUiDir: null, hudRendererDir: null, mapPackDir: null, workersDir: null, pythonPath: null, sampleHudsDirs: [], cloudEnforcement: "off" }));
    await e.init();
    servers = await startServers(e);
    o = await StandInObs.attach(e, (obs) => {
      obs.addScene("Game");
      obs.addInput("Game", "Game capture", "color_source_v3");
      obs.addScene("Desk");
      obs.addScene("Break");
      // The user's replay scene, made by hand: OBS's defaults for the Media Source.
      obs.addScene("My Replay");
      obs.addInput("My Replay", "Backdrop", "color_source_v3", { color: 0xff303030 });
      obs.addInput("My Replay", "replay", "ffmpeg_source", { is_local_file: true, hw_decode: true }, { positionX: 160, positionY: 90, scaleX: 0.75, scaleY: 0.75, cropLeft: 8 });
      obs.addInput("My Replay", "Score bug", "browser_source", { url: "http://127.0.0.1/bug" }, { positionX: 40, positionY: 40, boundsType: "OBS_BOUNDS_SCALE_INNER", boundsWidth: 400, boundsHeight: 80 });
      obs.inputs.get("replay")!.filters.push({ name: "Grade", kind: "color_filter_v2", enabled: true, settings: { saturation: 0.2 } });
      obs.inputs.get("replay")!.audio.volumeMul = 0.5;
      obs.program = "Game";
      obs.defaultDurationMs = DURATION;
    });
    const scenes = { LIVE: "Game", REPLAY: "My Replay", STUDIO: "Desk", BREAK: "Break" };
    e.settings.set("program.scenes", scenes);
    e.program.setScenes(scenes);
    e.settings.set("replay.mediaInput", "replay");
    e.autoReplay.setSettings({ enabled: true, startDelayMs: 0, perBreak: 3, order: "best", ownBigPlays: false, between: "fade", fadeMs: 400, playback: "scenes" });
  });

  afterAll(async () => {
    await servers?.close();
    await e?.shutdown();
  });

  it("builds the twin off air: the same sources shared, with their transforms, in the same order; a media source of its own with the same settings, filters and audio", async () => {
    expect(await e.replayTwin.sync()).toEqual({ scene: "My Replay B", input: "replay B" });
    const shape = (scene: string) => o.scenes.get(scene)!.map((i) => [i.source, i.enabled, i.transform.positionX, i.transform.scaleX, i.transform.cropLeft, i.transform.boundsType, i.transform.boundsWidth]);
    expect(shape("My Replay B")).toEqual(shape("My Replay").map((r) => (r[0] === "replay" ? ["replay B", ...r.slice(1)] : r)));
    // Both play hidden, keep their place when shown and hold their last frame.
    expect(o.inputs.get("replay")!.settings).toMatchObject({ restart_on_activate: false, clear_on_media_end: false, hw_decode: true });
    expect(o.inputs.get("replay")!.settings.close_when_inactive).not.toBe(true);
    expect(o.inputs.get("replay B")!.settings).toMatchObject({ restart_on_activate: false, close_when_inactive: false, clear_on_media_end: false, looping: false, hw_decode: true });
    expect(o.inputs.get("replay B")!.filters).toEqual(o.inputs.get("replay")!.filters);
    expect(o.inputs.get("replay B")!.audio.volumeMul).toBe(0.5);
    expect(e.program.replayScenes).toEqual(["My Replay", "My Replay B"]);
    expect(e.replayTwin.getStatus()).toMatchObject({ scene: "My Replay B", input: "replay B", ready: true });

    // Nothing changed: nothing is touched.
    const ids = o.scenes.get("My Replay B")!.map((i) => i.id);
    await e.replayTwin.sync();
    expect(o.scenes.get("My Replay B")!.map((i) => i.id)).toEqual(ids);

    // The user moves the score bug, adds a logo under it, hides the backdrop and changes the filter: the twin follows.
    const user = o.scenes.get("My Replay")!;
    user.find((i) => i.source === "Score bug")!.transform.positionX = 900;
    user[0]!.enabled = false;
    o.addInput("My Replay", "Logo", "image_source", {}, { positionX: 10 });
    await o.call("SetSceneItemIndex", { sceneName: "My Replay", sceneItemId: user.find((i) => i.source === "Logo")!.id, sceneItemIndex: 2 });
    o.inputs.get("replay")!.filters[0]!.settings = { saturation: -0.5 };
    await e.replayTwin.sync();
    expect(shape("My Replay B")).toEqual(shape("My Replay").map((r) => (r[0] === "replay" ? ["replay B", ...r.slice(1)] : r)));
    expect(o.scenes.get("My Replay B")!.map((i) => i.source)).toEqual(["Backdrop", "replay B", "Logo", "Score bug"]);
    expect(o.inputs.get("replay B")!.filters[0]!.settings).toEqual({ saturation: -0.5 });
    user[0]!.enabled = true;
  });

  it("plays a break's clips alternately in the two scenes, the next one loaded just in time and playing hidden toward its part, and fades over one fade length before the end", async () => {
    e.obsAuto.setSettings({ replayIn: "Matchframe Replay Stinger", replayOut: "", otherScenes: "" });
    await feed("live", 4);
    const round = e.session.state()!.roundNumber!;
    add(round, "triple", 3, files[0]!);
    add(round, "double", 2, files[1]!);
    add(round, "single", 1, files[2]!);
    o.changes.length = 0;
    o.mediaLog.length = 0;
    const history = e.program.history.length;
    await feed("over", 4);
    await waitFor(done);
    await settle();
    expect(e.autoReplay.getStatus().detail).toBe("Replays for this break are done (3 played).");
    // Replay in (the stinger), a fade to the twin, a fade back, and OBS's own transition back to live.
    expect(o.changes.map((c) => [c.scene, c.transition, c.durationMs])).toEqual([
      ["My Replay", "Matchframe Replay Stinger", 600],
      ["My Replay B", "Fade", 400],
      ["My Replay", "Fade", 400],
      ["Game", "Fade", 300],
    ]);
    // Each fade starts about one fade length before the clip on air ends, with the next one at the start of its part.
    for (const [k, from, to] of [
      [1, "replay", "replay B"],
      [2, "replay B", "replay"],
    ] as const) {
      const m = o.changes[k]!.media;
      expect(m[from]!.cursorMs, `${from} at the fade`).toBeGreaterThanOrEqual(DURATION - 400 - 150);
      expect(m[from]!.cursorMs, `${from} at the fade`).toBeLessThanOrEqual(DURATION - 400 + 80);
      expect(m[from]!.state).toBe("PLAYING");
      expect(m[to]!.cursorMs, `${to} at the fade`).toBeGreaterThanOrEqual(DURATION - PLAY);
      expect(m[to]!.cursorMs, `${to} at the fade`).toBeLessThanOrEqual(DURATION - PLAY + 80);
      expect(m[to]!.state).toBe("PLAYING");
    }
    // Never paused off air (a Windows OBS lets that go): each loaded, then skipped so it reaches its part as it shows.
    expect(o.mediaLog.filter((l) => !l.includes("seek"))).toEqual(["replay load clip-a.mp4", "replay B load clip-b.mp4", "replay load clip-c.mp4"]);
    const seeks = o.mediaLog.filter((l) => l.includes("seek")).map((l) => [l.replace(/ seek .*/, ""), Number(l.replace(/^.* seek /, ""))] as const);
    // The first: at its part, then back by the stinger's cut point (300 ms) as it goes on air, so it is at its part when the scene shows.
    expect(seeks[0]).toEqual(["replay", DURATION - PLAY]);
    expect(seeks[1]![0]).toBe("replay");
    expect(seeks[1]![1]).toBeGreaterThanOrEqual(DURATION - PLAY - 300);
    expect(seeks[1]![1]).toBeLessThanOrEqual(DURATION - PLAY - 150);
    // The next ones: loaded at most about half a second before their fade (as soon as their scene is off air, when that is later), and skipped to where they reach their part at it.
    expect(seeks.slice(2).map(([input]) => input)).toEqual(["replay B", "replay"]);
    for (const [, at] of seeks.slice(2)) {
      expect(at).toBeGreaterThanOrEqual(DURATION - PLAY - 900);
      expect(at).toBeLessThan(DURATION - PLAY);
    }
    // One cut in and one out for the program: the clips switch scenes without leaving REPLAY_PLAYING.
    expect(e.program.history.slice(history).map((t) => t.to)).toEqual(["REPLAY_PREPARED", "REPLAY_PLAYING", "LIVE"]);
    expect(e.program.mode).toBe("LIVE");
    expect(e.replays.list().filter((i) => i.roundNumber === round).map((i) => i.state)).toEqual(["played", "played", "played"]);
    // OBS's own transition and duration are back.
    expect([o.current, o.durationMs]).toEqual(["Fade", 300]);
    // Once the transition back is over, both replay sources are emptied: the next break can't open on this one's last frame.
    await waitFor(() => o.inputs.get("replay")!.settings.local_file === "" && o.inputs.get("replay B")!.settings.local_file === "", 8000);
  });

  /** A clip of `durationMs` whose last `playMs` play (its lead-up 600 ms of them). */
  const addLong = (round: number, label: string, kills: number, path: string, durationMs: number, playMs: number) => {
    o.durations.set(path, durationMs);
    const play: ReplayPlay = { kind: "missed", killer: { steamId: `k-${label}`, name: label }, victims: [`v-${label}`], kills, weapon: "ak47", headshot: false };
    const c = clip(round, path);
    return e.replays.addExternal(label, play.kind, round, { ...c, media: { ...c.media, durationMs } }, { playMs, leadMs: 600, play });
  };
  const logsSince = (n: number) => e.logger.recent.slice(n).map((l) => l.msg);

  it("a Windows OBS that won't hold a clip paused off air, and wedges one paused or skipped right after a restart (0.10.12): every clip still plays from its part, none stuck", async () => {
    // As the owner's OBS did: the clip waiting off air ran on to its end, the restart and pause that put it back left it at 24 ms,
    // play didn't start it on air, and 1.5 s later the break faded to the next clip: "pausing and not playing then transitioning".
    o.hiddenPause = "ignored";
    o.wedgeAfterRestartPause = true;
    const long = join(dir, "clip-long.mp4");
    writeFileSync(long, Buffer.alloc(64));
    try {
      await feed("live", 32);
      const round = e.session.state()!.roundNumber!;
      // The first plays 4 s: the second, waiting off air from its part, would reach its end long before its fade.
      addLong(round, "first", 3, long, 5000, 4000);
      add(round, "second", 2, files[1]!);
      add(round, "third", 1, files[2]!);
      o.changes.length = 0;
      o.mediaLog.length = 0;
      const logs = e.logger.recent.length;
      await feed("over", 32);
      await waitFor(done, 20000);
      await settle();
      expect(o.changes.map((c) => c.scene)).toEqual(["My Replay", "My Replay B", "My Replay", "Game"]);
      // The second comes in at its part, playing, and plays on to its own fade (not stuck near 0).
      const atFade = o.changes[1]!.media["replay B"]!;
      expect(atFade.state).toBe("PLAYING");
      expect(atFade.cursorMs).toBeGreaterThanOrEqual(DURATION - PLAY);
      expect(atFade.cursorMs).toBeLessThanOrEqual(DURATION - PLAY + 80);
      const atNext = o.changes[2]!.media["replay B"]!;
      expect(atNext.cursorMs, "the second clip at the fade to the third").toBeGreaterThanOrEqual(DURATION - 400 - 150);
      expect(o.changes[2]!.media.replay!.cursorMs).toBeGreaterThanOrEqual(DURATION - PLAY);
      expect(o.changes[2]!.media.replay!.cursorMs).toBeLessThanOrEqual(DURATION - PLAY + 80);
      // Never restarted or paused off air; nothing stuck.
      expect(o.mediaLog.filter((l) => / (restart|pause)$/.test(l))).toEqual([]);
      expect(logsSince(logs).filter((m) => /stopped playing|ran on|didn't play/.test(m))).toEqual([]);
      expect(e.autoReplay.getStatus().detail).toBe("Replays for this break are done (3 played).");
    } finally {
      o.hiddenPause = "holds";
      o.wedgeAfterRestartPause = false;
    }
  }, 30000);

  it("a clip that doesn't move as it goes on air: play sent again, then loaded again at its part; one that stops on air: the same, then given up and the next one in at its part", async () => {
    // Stuck as it reaches its part (where it shows), until it is loaded again.
    await feed("live", 34);
    let round = e.session.state()!.roundNumber!;
    add(round, "first", 2, files[0]!);
    add(round, "second", 1, files[1]!);
    o.stalls.set("replay B", { atMs: DURATION - PLAY, clearsOn: "load" });
    o.changes.length = 0;
    o.mediaLog.length = 0;
    let logs = e.logger.recent.length;
    await feed("over", 34);
    await waitFor(done);
    await settle();
    expect(o.changes.map((c) => c.scene)).toEqual(["My Replay", "My Replay B", "Game"]);
    expect(o.mediaLog.filter((l) => l.startsWith("replay B") && !l.includes("seek"))).toEqual(["replay B load clip-b.mp4", "replay B play", "replay B load clip-b.mp4"]);
    expect(o.mediaLog.filter((l) => l.startsWith("replay B seek")).at(-1)).toBe(`replay B seek ${DURATION - PLAY}`);
    expect(logsSince(logs)).toEqual(expect.arrayContaining(["automatic replays: OBS didn't play the clip on air; play sent again", "automatic replays: OBS still didn't play the clip; loading it again"]));
    // It played on to its end once loaded again.
    expect(o.changes[2]!.media["replay B"]!.cursorMs).toBeGreaterThan(DURATION - 300);
    expect(e.autoReplay.getStatus().detail).toBe("Replays for this break are done (2 played).");

    // Stops on air: play takes it on.
    await feed("live", 35);
    round = e.session.state()!.roundNumber!;
    add(round, "first", 2, files[0]!);
    add(round, "second", 1, files[1]!);
    o.stalls.set("replay", { atMs: 2200, clearsOn: "play" });
    o.changes.length = 0;
    o.mediaLog.length = 0;
    logs = e.logger.recent.length;
    await feed("over", 35);
    await waitFor(done);
    await settle();
    expect(o.changes.map((c) => c.scene)).toEqual(["My Replay", "My Replay B", "Game"]);
    expect(o.mediaLog.filter((l) => l === "replay play")).toEqual(["replay play"]);
    expect(logsSince(logs)).toContain("automatic replays: OBS stopped playing the clip; play sent again");
    expect(o.changes[1]!.media.replay!.cursorMs).toBeGreaterThanOrEqual(DURATION - 400 - 150);

    // Never moves again: played again, loaded again where it was, then given up; the next one comes in.
    await feed("live", 36);
    round = e.session.state()!.roundNumber!;
    add(round, "first", 2, files[0]!);
    add(round, "second", 1, files[1]!);
    o.stalls.set("replay", { atMs: 2200, clearsOn: "never" });
    o.changes.length = 0;
    o.mediaLog.length = 0;
    logs = e.logger.recent.length;
    try {
      await feed("over", 36);
      await waitFor(done, 20000);
      await settle();
    } finally {
      o.stalls.delete("replay");
    }
    expect(o.changes.map((c) => c.scene)).toEqual(["My Replay", "My Replay B", "Game"]);
    expect(o.mediaLog.filter((l) => /^replay (load|play|pause|restart)/.test(l))).toEqual(["replay load clip-a.mp4", "replay play", "replay load clip-a.mp4"]);
    // Loaded again where it had stopped.
    const again = Number(o.mediaLog.filter((l) => l.startsWith("replay seek")).at(-1)!.replace("replay seek ", ""));
    expect(again).toBeGreaterThanOrEqual(2200);
    expect(again).toBeLessThan(2300);
    // (Given up by its own time, or after another 1.5 s still; the next one, which ran on off air meanwhile, loaded again at its part.)
    expect(logsSince(logs)).toEqual(expect.arrayContaining(["automatic replays: OBS stopped playing the clip; play sent again", "automatic replays: OBS still doesn't play the clip; loading it again where it was"]));
    expect(o.changes[1]!.media["replay B"]!.cursorMs).toBeGreaterThanOrEqual(DURATION - PLAY);
    expect(e.autoReplay.getStatus().detail).toBe("Replays for this break are done (2 played).");
  }, 40000);

  it("cuts between clips when chosen: the next one as the one on air ends", async () => {
    e.autoReplay.setSettings({ between: "cut", perBreak: 2 });
    e.obsAuto.setSettings({ replayIn: "", replayOut: null });
    await feed("live", 6);
    const round = e.session.state()!.roundNumber!;
    add(round, "first", 2, files[0]!);
    add(round, "second", 1, files[1]!);
    o.changes.length = 0;
    await feed("over", 6);
    await waitFor(done);
    await settle();
    expect(o.changes.map((c) => [c.scene, c.transition])).toEqual([
      ["My Replay", "Fade"],
      ["My Replay B", "Cut"],
      ["Game", "Fade"],
    ]);
    expect(o.changes[1]!.media.replay!.cursorMs).toBeGreaterThanOrEqual(DURATION - 120);
    expect([o.current, o.durationMs]).toEqual(["Fade", 300]);
    e.autoReplay.setSettings({ between: "fade", perBreak: 3 });
  });

  it("leaves the program alone when the operator puts another scene on in OBS during the break", async () => {
    await feed("live", 8);
    const round = e.session.state()!.roundNumber!;
    add(round, "one", 2, files[0]!);
    add(round, "two", 1, files[1]!);
    o.changes.length = 0;
    await feed("over", 8);
    await waitFor(() => o.changes.length === 1);
    await new Promise((r) => setTimeout(r, 300));
    // In OBS, by hand.
    await o.call("SetCurrentProgramScene", { sceneName: "Desk" });
    await waitFor(() => e.obs.state.programScene === "Desk");
    await new Promise((r) => setTimeout(r, 2500));
    expect(o.changes.map((c) => c.scene)).toEqual(["My Replay", "Desk"]);
    expect(e.replays.list().filter((i) => i.roundNumber === round).map((i) => i.state)).toEqual(["played", "prepared"]);
    // The program follows OBS to the operator's scene (replay-controls.e2e.test.ts has the rest).
    expect([e.program.mode, e.program.operatorScene]).toEqual(["MANUAL", "Desk"]);
    expect(e.autoReplay.getStatus()).toMatchObject({ state: "waiting", detail: "OBS shows “Desk” (your scene): replays wait until you're back on the live scene." });
    // (The rest of the break doesn't play when the program is back to live.)
    e.autoReplay.stop();
    await e.program.request("LIVE", "operator", "op");
    await settle();
  });

  it("goes to and from the break and studio scenes with the Other scenes transition, by the automation or the operator's buttons; a replay played by hand returns live with Replay out", async () => {
    e.obsAuto.setSettings({ otherScenes: "Matchframe Replay Stinger", replayIn: "Fade", replayOut: "Cut" });
    o.changes.length = 0;
    expect((await api("/api/v1/program/cues", { mode: "STUDIO" })).status).toBe(200);
    await settle();
    expect((await api("/api/v1/program/return-live")).status).toBe(200);
    await settle();
    // A tactical timeout: the OBS automation.
    await feed("freezetime", 9);
    const timeout = buildSyntheticGsiPayload({ mapName: "de_dust2", round: 9, players: roster, observed: roster[0]!.steamId, roundPhase: "freezetime", phase: "timeout_ct", phaseEndsIn: 30, token: e.secrets.gsiToken, timestamp: ts++ });
    await fetch(`http://127.0.0.1:${gsiPort}/gsi`, { method: "POST", body: JSON.stringify(timeout) });
    await waitFor(() => e.program.mode === "BREAK");
    await settle();
    await feed("freezetime", 9, 10);
    await waitFor(() => e.program.mode === "LIVE");
    await settle();
    // By hand: approve, play, and Return live.
    const it = add(9, "by hand", 1, files[3]!);
    e.replays.approve(it.id);
    e.autoReplay.setSettings({ enabled: false });
    expect((await api(`/api/v1/replays/${it.id}/play`)).status).toBe(200);
    await settle();
    expect((await api("/api/v1/program/return-live")).status).toBe(200);
    await settle();
    expect(o.changes.map((c) => [c.scene, c.transition])).toEqual([
      ["Desk", "Matchframe Replay Stinger"],
      ["Game", "Matchframe Replay Stinger"],
      ["Break", "Matchframe Replay Stinger"],
      ["Game", "Matchframe Replay Stinger"],
      ["My Replay", "Fade"],
      ["Game", "Cut"],
    ]);
    // OBS's own transition back after each.
    expect([o.current, o.durationMs]).toEqual(["Fade", 300]);
    e.autoReplay.setSettings({ enabled: true });
    e.obsAuto.setSettings({ otherScenes: "", replayIn: "", replayOut: null });
  });

  it("works with OBS's Studio Mode on: the program changes without the preview, the operator's preview is put back after Swap Scenes, and the Transition button counts as taking over", async () => {
    await o.call("SetStudioModeEnabled", { studioModeEnabled: true });
    await o.call("SetCurrentPreviewScene", { sceneName: "Desk" });
    await waitFor(() => e.obs.state.studioMode === true && e.obs.state.previewScene === "Desk");
    const previews: string[] = [];
    const seen = (ev: { sceneName: string }) => previews.push(ev.sceneName);
    o.on("CurrentPreviewSceneChanged", seen);
    try {
      await feed("live", 12);
      let round = e.session.state()!.roundNumber!;
      add(round, "triple", 3, files[0]!);
      add(round, "double", 2, files[1]!);
      add(round, "single", 1, files[2]!);
      o.changes.length = 0;
      await feed("over", 12);
      await waitFor(done);
      await settle();
      expect(o.changes.map((c) => c.scene)).toEqual(["My Replay", "My Replay B", "My Replay", "Game"]);
      expect(e.replays.list().filter((i) => i.roundNumber === round).map((i) => i.state)).toEqual(["played", "played", "played"]);
      // OBS swapped each scene the program left into preview; each time the operator's went back.
      expect(previews.filter((p) => p !== "Desk")).toEqual(["Game", "My Replay", "My Replay B", "My Replay"]);
      expect(o.preview).toBe("Desk");
      expect(e.program.mode).toBe("LIVE");

      // The next break: the operator puts the twin in preview and presses Transition during the first clip.
      await feed("live", 13);
      round = e.session.state()!.roundNumber!;
      add(round, "one", 2, files[0]!);
      add(round, "two", 1, files[1]!);
      o.changes.length = 0;
      await feed("over", 13);
      await waitFor(() => o.changes.length === 1);
      await waitFor(() => o.preview === "Desk");
      await o.call("SetCurrentPreviewScene", { sceneName: "My Replay B" });
      o.transitionButton();
      await new Promise((r) => setTimeout(r, 2500));
      // A replay scene, but not Matchframe's change: nothing more from the break, no cut back; the program follows OBS to it.
      expect(o.changes.map((c) => c.scene)).toEqual(["My Replay", "My Replay B"]);
      expect(e.replays.list().filter((i) => i.roundNumber === round).map((i) => i.state)).toEqual(["played", "prepared"]);
      expect(e.autoReplay.getStatus().detail).toBe("OBS shows “My Replay B” (your scene): replays wait until you're back on the live scene.");
    } finally {
      o.off("CurrentPreviewSceneChanged", seen);
      try {
        e.autoReplay.stop();
      } catch {
        // Nothing left of the break.
      }
      await e.program.request("LIVE", "operator", "op");
      await o.call("SetStudioModeEnabled", { studioModeEnabled: false });
      await settle();
    }
  });

  it("plays in the replay scene's one source, as before, when it can't have a twin", async () => {
    e.settings.set("replay.mediaInput", "replay");
    // The replay media source isn't in the replay scene (in a group, say).
    const items = o.scenes.get("My Replay")!;
    const media = items.splice(items.findIndex((i) => i.source === "replay"), 1)[0]!;
    o.addScene("Group");
    o.scenes.get("Group")!.push(media);
    await feed("live", 10);
    const round = e.session.state()!.roundNumber!;
    add(round, "one", 2, files[0]!);
    add(round, "two", 1, files[1]!);
    o.changes.length = 0;
    o.mediaLog.length = 0;
    await feed("over", 10);
    await waitFor(done);
    await settle();
    expect(e.replayTwin.getStatus()).toMatchObject({ ready: false, detail: expect.stringMatching(/has no media source “replay”/) });
    expect(o.changes.map((c) => c.scene)).toEqual(["My Replay", "Game"]);
    expect(o.mediaLog.filter((l) => l.includes("load"))).toEqual(["replay load clip-a.mp4", "replay load clip-b.mp4"]);
    expect(e.program.replayScenes).toEqual(["My Replay", "My Replay B"]);
  });
});
