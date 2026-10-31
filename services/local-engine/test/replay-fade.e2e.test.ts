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
 * Media Source) gets a twin, kept the same, and the break's clips alternate between the two, the next
 * waiting paused at its part while one plays, the program fading over one fade length before the end.
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
    e.autoReplay.setSettings({ enabled: true, startDelayMs: 0, perBreak: 3, order: "best", ownBigPlays: false, between: "fade", fadeMs: 400 });
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

  it("plays a break's clips alternately in the two scenes, the next one waiting paused at its part, and fades over one fade length before the end", async () => {
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
      expect(m[from]!.cursorMs, `${from} at the fade`).toBeLessThanOrEqual(DURATION - 400 + 60);
      expect(m[from]!.state).toBe("PLAYING");
      expect(m[to]!.cursorMs, `${to} at the fade`).toBeGreaterThanOrEqual(DURATION - PLAY);
      expect(m[to]!.cursorMs, `${to} at the fade`).toBeLessThanOrEqual(DURATION - PLAY + 80);
    }
    // Loaded off air, held at its part, played as it goes on air; the next one loaded only once the fade from its scene is over.
    expect(o.mediaLog.filter((l) => !l.includes("seek"))).toEqual([
      "replay load clip-a.mp4",
      "replay pause",
      "replay play",
      "replay B load clip-b.mp4",
      "replay B pause",
      "replay B play",
      "replay load clip-c.mp4",
      "replay pause",
      "replay play",
    ]);
    expect(o.mediaLog.filter((l) => l.includes("seek"))).toEqual(["replay seek 1800", "replay B seek 1800", "replay seek 1800"]);
    // The first clip plays from the stinger's cut point (300 ms), when the replay scene shows.
    // One cut in and one out for the program: the clips switch scenes without leaving REPLAY_PLAYING.
    expect(e.program.history.slice(history).map((t) => t.to)).toEqual(["REPLAY_PREPARED", "REPLAY_PLAYING", "LIVE"]);
    expect(e.program.mode).toBe("LIVE");
    expect(e.replays.list().filter((i) => i.roundNumber === round).map((i) => i.state)).toEqual(["played", "played", "played"]);
    // OBS's own transition and duration are back.
    expect([o.current, o.durationMs]).toEqual(["Fade", 300]);
  });

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
    expect(e.autoReplay.getStatus().detail).toMatch(/isn't live/);
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
      // A replay scene, but not Matchframe's change: nothing more from the break, no cut back.
      expect(o.changes.map((c) => c.scene)).toEqual(["My Replay", "My Replay B"]);
      expect(e.replays.list().filter((i) => i.roundNumber === round).map((i) => i.state)).toEqual(["played", "prepared"]);
      expect(e.autoReplay.getStatus().detail).toMatch(/isn't live/);
    } finally {
      o.off("CurrentPreviewSceneChanged", seen);
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
