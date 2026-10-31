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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn: () => boolean, ms = 15000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(20);
  }
};

/**
 * The operator switches OBS's scenes themselves (a multiview plugin, by hand, Studio Mode's
 * Transition button): to an analysis scene between rounds, the casters during the replays, the
 * mapped break scene. The program follows OBS to their scene (MANUAL, theirs) and Matchframe
 * changes nothing until OBS shows the live scene again: no replays cut in, no break or studio scene,
 * no cut back at 1:50. Replays wait (a status, not an error), and a break with time left plays what
 * still fits once OBS is back on the live scene. Stand-in OBS at the obs-websocket level.
 */
describe("Switching scenes yourself (multiview): the program follows OBS and Matchframe changes nothing", () => {
  let e: Engine;
  let o: StandInObs;
  let servers: Awaited<ReturnType<typeof startServers>>;
  let gsiPort: number;
  let apiPort: number;
  let ts = 1_700_300_000;
  const roster = syntheticRoster();
  const dir = mkdtempSync(join(tmpdir(), "mf-own-"));
  const files = ["a", "b", "c"].map((n) => join(dir, `clip-${n}.mp4`));
  const DURATION = 3000;

  const feed = async (roundPhase: "live" | "over" | "freezetime", round: number, phaseEndsIn?: number, phase?: string) => {
    const payload = buildSyntheticGsiPayload({ mapName: "de_dust2", round, players: roster, observed: roster[0]!.steamId, roundPhase, phase: phase ?? roundPhase, phaseEndsIn: phaseEndsIn ?? (roundPhase === "live" ? 115 : 7), token: e.secrets.gsiToken, timestamp: ts++ });
    expect((await fetch(`http://127.0.0.1:${gsiPort}/gsi`, { method: "POST", body: JSON.stringify(payload) })).status).toBe(200);
    await sleep(300);
  };
  const api = async (path: string, body?: unknown, method = "POST") => {
    const r = await fetch(`http://127.0.0.1:${apiPort}${path}`, { method, headers: { authorization: `Bearer ${e.secrets.operatorToken}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> & { message?: string } };
  };
  const add = (round: number, label: string, kills: number, path: string) => {
    const play: ReplayPlay = { kind: "missed", killer: { steamId: `k-${label}`, name: label }, victims: [`v-${label}`], kills, weapon: "ak47", headshot: false };
    const c: ClipRecord = { clipId: `c${Math.random()}`, providerId: "replay-pc", sourceId: "replay-pc", angle: "recorded_angle", matchTimeFromMs: null, matchTimeToMs: null, timeUncertaintyMs: null, epoch: null, roundNumber: round, media: { path, durationMs: DURATION, frameRate: 60, timebase: null, startPts: null, hasAudio: true, width: 1920, height: 1080 }, createdAt: new Date().toISOString() };
    return e.replays.addExternal(label, play.kind, round, c, { playMs: 2500, leadMs: 1000, play });
  };
  /** The operator, in OBS (a multiview button, a scene clicked). */
  const theyShow = async (scene: string) => {
    await o.call("SetCurrentProgramScene", { sceneName: scene });
    await waitFor(() => e.obs.state.programScene === scene);
    await sleep(200);
  };
  const states = (round: number) => e.replays.list().filter((i) => i.roundNumber === round).map((i) => i.state);
  const detail = () => e.autoReplay.getStatus().detail;

  beforeAll(async () => {
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    for (const f of files) writeFileSync(f, Buffer.alloc(64));
    const ports = { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
    gsiPort = ports.gsi;
    apiPort = ports.api;
    e = new Engine(loadConfig({ dataDir: mkdtempSync(join(tmpdir(), "mf-own-data-")), gsiPort: ports.gsi, apiPort: ports.api, overlayPort: ports.overlay, host: "127.0.0.1", captainUiDir: null, hudRendererDir: null, mapPackDir: null, workersDir: null, pythonPath: null, sampleHudsDirs: [], cloudEnforcement: "off" }));
    await e.init();
    servers = await startServers(e);
    o = await StandInObs.attach(e, (obs) => {
      obs.addScene("Game");
      obs.addInput("Game", "Game audio", "wasapi_output_capture");
      obs.inputs.get("Game audio")!.audio.volumeMul = 0.8;
      obs.addScene("Analysis");
      obs.addScene("Casters");
      obs.addScene("Break");
      obs.addScene("Desk");
      obs.addScene("My Replay");
      obs.addInput("My Replay", "replay", "ffmpeg_source", { is_local_file: true });
      obs.program = "Game";
      obs.defaultDurationMs = DURATION;
    });
    const scenes = { LIVE: "Game", REPLAY: "My Replay", STUDIO: "Desk", BREAK: "Break" };
    e.settings.set("program.scenes", scenes);
    e.program.setScenes(scenes);
    e.settings.set("replay.mediaInput", "replay");
    e.autoReplay.setSettings({ enabled: true, startDelayMs: 0, perBreak: 3, order: "best", ownBigPlays: false, between: "fade", fadeMs: 400, duckInputs: ["Game audio"], duckTo: -20 });
  });

  afterAll(async () => {
    await servers?.close();
    await e?.shutdown();
  });

  it("follows OBS to the operator's scene between rounds: no replays cut in, replays wait (not an error), no break scene, no Test replays; back to live with OBS", async () => {
    await feed("live", 3);
    const round = e.session.state()!.roundNumber!;
    add(round, "one", 2, files[0]!);
    await theyShow("Analysis");
    expect([e.program.mode, e.program.operatorScene, e.program.owner]).toEqual(["MANUAL", "Analysis", { kind: "operator", holder: "OBS: Analysis" }]);
    o.changes.length = 0;
    await feed("over", 3);
    await sleep(1500);
    // No cut to the replays; a status, not "blocked".
    expect(o.changes).toEqual([]);
    expect(e.autoReplay.getStatus()).toMatchObject({ state: "waiting", detail: "OBS shows “Analysis” (your scene): replays wait until you're back on the live scene." });
    // A tactical timeout: the break scene isn't put on over theirs.
    await feed("freezetime", 4, 30, "timeout_ct");
    await sleep(800);
    expect(o.changes).toEqual([]);
    expect((await api("/api/v1/replays/auto/test")).json.message).toBe("OBS shows “Analysis” (your scene): Test replays wait until you're back on the live scene.");
    // Back on the live scene in OBS: live, as before; the break still has time (freeze time), so its replay plays.
    await feed("freezetime", 4, 10);
    o.changes.length = 0;
    await theyShow("Game");
    await waitFor(() => detail().startsWith("Replays for this break are done"));
    expect(o.changes.map((c) => c.scene)).toEqual(["Game", "My Replay", "Game"]);
    expect(e.program.mode).toBe("LIVE");
    expect(states(round)).toEqual(["played"]);
  }, 30000);

  it("coming back to the live scene during a break with time left: the break's replays play (what still fits)", async () => {
    // (The replays start 2.5 s after the round: they switch before.)
    e.autoReplay.setSettings({ startDelayMs: 2500 });
    await feed("live", 6);
    const round = e.session.state()!.roundNumber!;
    add(round, "two", 2, files[0]!);
    add(round, "one", 1, files[1]!);
    await feed("over", 6);
    // The round ends: straight to their analysis scene before the replays start.
    await theyShow("Analysis");
    await sleep(800);
    expect(e.autoReplay.getStatus().state).toBe("waiting");
    o.changes.length = 0;
    const history = e.program.history.length;
    await theyShow("Game");
    await waitFor(() => e.autoReplay.getStatus().detail.startsWith("Replays for this break are done"));
    expect(o.changes.map((c) => c.scene)).toEqual(["Game", "My Replay", "My Replay B", "Game"]);
    expect(states(round)).toEqual(["played", "played"]);
    // Matchframe's own replay scenes during its break never made the program the operator's.
    expect(e.program.history.slice(history).map((t) => [t.to, t.holder])).toEqual([
      ["LIVE", "OBS changed scene"],
      ["REPLAY_PREPARED", "auto-replay"],
      ["REPLAY_PLAYING", "auto-replay"],
      ["LIVE", "auto-replay"],
    ]);
    e.autoReplay.setSettings({ startDelayMs: 0 });
  }, 30000);

  it("switching to their own scene during the replays: Matchframe stops them, puts the live audio back, and changes nothing after (no cut back at 1:50, Stop, Test replays); the rest plays if they come back in time", async () => {
    await feed("live", 8);
    let round = e.session.state()!.roundNumber!;
    add(round, "three", 3, files[0]!);
    add(round, "two", 2, files[1]!);
    add(round, "one", 1, files[2]!);
    o.changes.length = 0;
    await feed("over", 8);
    await waitFor(() => o.changes.length === 1 && Math.abs(o.inputs.get("Game audio")!.audio.volumeMul - 0.08) < 1e-6);
    await sleep(300);
    // The casters, with a replay in the corner: their scene.
    await theyShow("Casters");
    await waitFor(() => !e.autoReplay.getStatus().running);
    expect(e.program.operatorScene).toBe("Casters");
    await waitFor(() => o.inputs.get("Game audio")!.audio.volumeMul === 0.8);
    expect(states(round)).toEqual(["played", "prepared", "prepared"]);
    // Back in time: the rest of the break plays.
    o.changes.length = 0;
    await theyShow("Game");
    await waitFor(() => detail().startsWith("Replays for this break are done"));
    expect(o.changes.map((c) => c.scene)).toEqual(["Game", "My Replay", "My Replay B", "Game"]);
    expect(states(round)).toEqual(["played", "played", "played"]);

    // Again, and they stay on their scene: the next round's 1:50, Stop and Test replays leave it alone.
    await feed("live", 9);
    round = e.session.state()!.roundNumber!;
    add(round, "two", 2, files[0]!);
    add(round, "one", 1, files[1]!);
    o.changes.length = 0;
    await feed("over", 9);
    await waitFor(() => o.changes.length === 1);
    await sleep(300);
    await theyShow("Casters");
    await waitFor(() => !e.autoReplay.getStatus().running);
    await feed("live", 10);
    await feed("live", 10, 111.2);
    await sleep(1500);
    expect((await api("/api/v1/replays/auto/stop")).status).toBe(409);
    expect((await api("/api/v1/replays/auto/test")).status).toBe(409);
    await sleep(500);
    expect(o.changes.map((c) => c.scene)).toEqual(["My Replay", "Casters"]);
    expect(e.obs.state.programScene).toBe("Casters");
    expect(o.inputs.get("Game audio")!.audio.volumeMul).toBe(0.8);
    // Back to live after the round went live: no replays from that break any more.
    await theyShow("Game");
    await sleep(800);
    expect(o.changes.map((c) => c.scene)).toEqual(["My Replay", "Casters", "Game"]);
    expect(states(round)).toEqual(["played", "prepared"]);
  }, 40000);

  it("the mapped break scene put on by hand is the operator's: not taken back when play resumes; one Matchframe chose is", async () => {
    await feed("freezetime", 11, 15);
    o.changes.length = 0;
    await theyShow("Break");
    expect(e.program.operatorScene).toBe("Break");
    await feed("freezetime", 11, 30, "timeout_t");
    await feed("freezetime", 11, 10);
    await sleep(800);
    expect(o.changes.map((c) => c.scene)).toEqual(["Break"]);
    await theyShow("Game");
    // A timeout: Matchframe puts the break scene on, and takes it back.
    await feed("freezetime", 12, 30, "timeout_ct");
    await waitFor(() => e.obs.state.programScene === "Break");
    expect(e.program.mode).toBe("BREAK");
    await feed("freezetime", 12, 10);
    await waitFor(() => e.obs.state.programScene === "Game");
    expect(e.program.mode).toBe("LIVE");
  });

  it("with OBS's Studio Mode (preview, then the Transition button, as a multiview plugin may): followed the same way", async () => {
    await o.call("SetStudioModeEnabled", { studioModeEnabled: true });
    await waitFor(() => e.obs.state.studioMode === true);
    try {
      await feed("live", 14);
      const round = e.session.state()!.roundNumber!;
      add(round, "one", 2, files[0]!);
      await o.call("SetCurrentPreviewScene", { sceneName: "Analysis" });
      o.transitionButton();
      await waitFor(() => e.obs.state.programScene === "Analysis");
      await sleep(200);
      expect(e.program.operatorScene).toBe("Analysis");
      o.changes.length = 0;
      await feed("over", 14);
      await sleep(1200);
      expect(o.changes).toEqual([]);
      expect(detail()).toBe("OBS shows “Analysis” (your scene): replays wait until you're back on the live scene.");
      await o.call("SetCurrentPreviewScene", { sceneName: "Game" });
      o.transitionButton();
      await waitFor(() => detail().startsWith("Replays for this break are done"));
      expect(o.changes.map((c) => c.scene)).toEqual(["Game", "My Replay", "Game"]);
    } finally {
      await o.call("SetStudioModeEnabled", { studioModeEnabled: false });
    }
  }, 30000);

  it("found on the operator's scene when OBS (re)connects: theirs too", async () => {
    expect(e.program.mode).toBe("LIVE");
    await e.obs.disconnect();
    // Meanwhile, in OBS.
    o.program = "Analysis";
    await o.connectTo(e);
    await waitFor(() => e.program.mode === "MANUAL");
    expect(e.program.operatorScene).toBe("Analysis");
    await theyShow("Game");
    expect(e.program.mode).toBe("LIVE");
  });
});
