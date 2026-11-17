import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MatchState } from "@matchframe/contracts";
import { Database } from "../src/db/database.ts";
import { DemoJobRepo, SettingsRepo } from "../src/db/store.ts";
import type { WorkerRunner } from "../src/demos/library.ts";
import { DemoLibrary } from "../src/demos/library.ts";
import { TrainingService } from "../src/demos/training.ts";
import type { LiveSession } from "../src/live/session.ts";
import { buildHudState, type HudContext } from "../src/live/projection.ts";
import { TeamSideTracker } from "../src/live/team-sides.ts";
import { Logger } from "../src/logger.ts";
import { heapCapFromEnv, isLoopbackAddress, LOW_SPEC_FPS, LOW_SPEC_KEY, LowSpecMode, OBS_FPS_BEFORE_KEY, ObsFrameCap, type ObsForFrameCap } from "../src/low-spec.ts";
import { encoderArgs, renderArgs } from "../src/replay/ffmpeg.ts";

function settingsRepo() {
  const db = new Database(":memory:");
  db.migrate();
  return { db, settings: new SettingsRepo(db) };
}

/** A clock the test moves. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const ctx = (lowSpec: boolean | undefined): HudContext => ({
  outputId: "o",
  variant: "live",
  presetId: null,
  timeline: { profile: "live", delayMs: 0 },
  match: null,
  mapInstances: [],
  teams: new Map(),
  playersBySteam: new Map(),
  event: null,
  assetUrl: () => null,
  map: undefined,
  killfeed: { mode: "exact", entries: [] },
  sponsors: {},
  cues: [],
  replay: { active: false, label: null, clip: null },
  annotations: [],
  veto: null,
  standings: null,
  bracket: null,
  settings: {},
  radarUtility: true,
  allowUnverifiedRadar: false,
  art: { defaultPlayers: { ct: [], t: [] }, maps: {}, icons: { dead: null } },
  ...(lowSpec === undefined ? {} : { lowSpec }),
});

const liveState = {
  schemaVersion: 1,
  sessionId: "s",
  epoch: 1,
  sequence: 10,
  time: { receivedAtMonotonicMs: 1000, sourceObservedAtMs: null, matchTimeMs: null, timeUncertaintyMs: null },
  mapName: "de_mirage",
  mapPhase: "live",
  roundNumber: 3,
  roundAttemptId: null,
  roundPhase: "live",
  gamePhase: "live",
  phaseEndsInSec: 60,
  phaseObservedAtMonotonicMs: 1000,
  paused: false,
  teams: {
    CT: { side: "CT", teamId: null, name: null, score: 1, consecutiveRoundLosses: 0, timeoutsRemaining: 3, matchesWonThisSeries: null },
    T: { side: "T", teamId: null, name: null, score: 1, consecutiveRoundLosses: 0, timeoutsRemaining: 3, matchesWonThisSeries: null },
  },
  players: [],
  bomb: null,
  utility: [],
  roundHistory: [],
  observer: { observedSteamId: null, observedSlot: null, cameraMode: "unknown", confirmedAtMonotonicMs: null, providerSteamId: null, evidence: "unknown" },
  sources: [],
  simulated: false,
} as unknown as MatchState;

describe("HudState.lowSpec", () => {
  it("is true in the state of every output while low-spec mode is on, with and without game data", () => {
    const sides = new TeamSideTracker();
    expect(buildHudState(null, ctx(true), sides, 2000).lowSpec).toBe(true);
    expect(buildHudState(liveState, ctx(true), sides, 2000).lowSpec).toBe(true);
  });

  it("is false while it is off (and when the context doesn't say)", () => {
    const sides = new TeamSideTracker();
    expect(buildHudState(null, ctx(false), sides, 2000).lowSpec).toBe(false);
    expect(buildHudState(liveState, ctx(false), sides, 2000).lowSpec).toBe(false);
    expect(buildHudState(liveState, ctx(undefined), sides, 2000).lowSpec).toBe(false);
  });
});

describe("LowSpecMode", () => {
  it("is off by default; on gives a 30 fps cap, is saved, and tells its listeners once per change", () => {
    const { settings } = settingsRepo();
    const mode = new LowSpecMode({ settings, roundLive: () => false });
    expect(mode.on).toBe(false);
    expect(mode.frameCap()).toBeNull();
    const seen: boolean[] = [];
    mode.onChange((on) => seen.push(on));
    expect(mode.set(true)).toBe(true);
    expect(mode.set(true)).toBe(false);
    expect(mode.frameCap()).toBe(LOW_SPEC_FPS);
    expect(settings.get(LOW_SPEC_KEY, null)).toBe(true);
    // A new engine (restart) reads it back.
    expect(new LowSpecMode({ settings, roundLive: () => false }).on).toBe(true);
    mode.set(false);
    expect(seen).toEqual([true, false]);
    expect(mode.frameCap()).toBeNull();
  });

  it("suggests itself once: two stutters from desktop or OBS outputs in a minute while CS2 sends game data from this computer", () => {
    const { settings } = settingsRepo();
    const c = clock();
    const mode = new LowSpecMode({ settings, roundLive: () => false, now: c.now });
    const stutter = { fps: 31, worstMs: 300, frameCap: null };
    // CS2 on another computer: no suggestion.
    mode.noteGameData(false);
    mode.noteOutputPerf("obs", stutter);
    mode.noteOutputPerf("obs", stutter);
    expect(mode.suggestion()).toBeNull();
    // CS2 here, but previews don't count and smooth outputs don't count.
    mode.noteGameData(true);
    expect(mode.cs2OnThisComputer()).toBe(true);
    mode.noteOutputPerf("preview", stutter);
    mode.noteOutputPerf("desktop", { fps: 60, worstMs: 20, frameCap: null });
    c.advance(61_000);
    mode.noteGameData(true);
    mode.noteOutputPerf("desktop", stutter);
    expect(mode.suggestion()).toBeNull();
    mode.noteOutputPerf("desktop", stutter);
    expect(mode.suggestion()?.reason).toMatch(/desktop HUD stuttered while CS2 runs on this computer \(31 fps, longest pause 300 ms\)/);
    expect(mode.status().suggestion).not.toBeNull();
    // Dismissed: never again, also after a restart.
    mode.dismissSuggestion();
    expect(mode.suggestion()).toBeNull();
    mode.noteOutputPerf("desktop", stutter);
    mode.noteOutputPerf("desktop", stutter);
    expect(mode.suggestion()).toBeNull();
    expect(new LowSpecMode({ settings, roundLive: () => false, now: c.now }).suggestion()).toBeNull();
  });

  it("drops the suggestion once it is turned on, and doesn't bring it back when turned off", () => {
    const { settings } = settingsRepo();
    const mode = new LowSpecMode({ settings, roundLive: () => false });
    mode.noteGameData(true);
    mode.noteOutputPerf("obs", { fps: 20, worstMs: 60, frameCap: null });
    mode.noteOutputPerf("obs", { fps: 20, worstMs: 60, frameCap: null });
    expect(mode.suggestion()).not.toBeNull();
    mode.set(true);
    expect(mode.suggestion()).toBeNull();
    mode.set(false);
    mode.noteOutputPerf("obs", { fps: 20, worstMs: 60, frameCap: null });
    mode.noteOutputPerf("obs", { fps: 20, worstMs: 60, frameCap: null });
    expect(mode.suggestion()).toBeNull();
  });

  it("game data from a loopback address is this computer", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("192.168.1.20")).toBe(false);
    expect(isLoopbackAddress("::ffff:10.0.0.2")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });

  it("reports the memory cap the program started the engine with", () => {
    expect(heapCapFromEnv({ MATCHFRAME_ENGINE_HEAP_CAP_MB: "1024" })).toBe(1024);
    expect(heapCapFromEnv({})).toBeNull();
    expect(heapCapFromEnv({ MATCHFRAME_ENGINE_HEAP_CAP_MB: "lots" })).toBeNull();
    const { settings } = settingsRepo();
    const st = new LowSpecMode({ settings, roundLive: () => false, heapCapMb: 768 }).status();
    expect(st.engine.heapCapMb).toBe(768);
    expect(st.engine.heapLimitMb).toBeGreaterThan(0);
  });
});

describe("heavy background work while a round is live (low-spec mode)", () => {
  it("defers only while low-spec mode is on and a round is live", () => {
    const { settings } = settingsRepo();
    let live = true;
    const mode = new LowSpecMode({ settings, roundLive: () => live });
    expect(mode.deferHeavy()).toBe(false);
    mode.set(true);
    expect(mode.deferHeavy()).toBe(true);
    live = false;
    expect(mode.deferHeavy()).toBe(false);
  });

  it("whenHeavyAllowed waits for the round to end, says so once, and gives up when cancelled", async () => {
    const { settings } = settingsRepo();
    let live = true;
    const mode = new LowSpecMode({ settings, roundLive: () => live });
    mode.set(true);
    let waits = 0;
    let sleeps = 0;
    const sleep = async () => {
      sleeps++;
      if (sleeps === 3) live = false;
    };
    expect(await mode.whenHeavyAllowed({ onWait: () => waits++, sleep })).toBe(true);
    expect(waits).toBe(1);
    expect(sleeps).toBe(3);
    live = true;
    let cancelled = false;
    const p = mode.whenHeavyAllowed({ cancelled: () => cancelled, sleep: async () => void (cancelled = true) });
    expect(await p).toBe(false);
  });

  it("the Demo Library hashes and processes no demo while deferred, and catches up after the round", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mf-lowspec-lib-"));
    const { db, settings } = settingsRepo();
    const repo = new DemoJobRepo(db);
    const calls: string[] = [];
    const worker: WorkerRunner = {
      available: () => true,
      run: async (args) => {
        calls.push(args[0]!);
        if (args[0] === "extract") {
          const ds = join(dir, "datasets", `d${calls.length}`);
          mkdirSync(ds, { recursive: true });
          return { status: "committed", dataset: ds, map: "de_inferno", build: "1", output_bytes: 1 };
        }
        return { verdict: "usable" };
      },
    };
    // "Pause during live" off: only low-spec mode holds the work.
    const lib = new DemoLibrary(repo, settings, worker, new Logger("error", null), dir, () => false);
    const ingest = join(dir, "ingest");
    mkdirSync(ingest, { recursive: true });
    lib.setConfig({ ingestRoots: [ingest], datasetRoot: join(dir, "datasets"), minFreeBytes: 0, watch: false, pauseDuringLive: false });
    let deferred = true;
    lib.deferHeavy = () => deferred;
    writeFileSync(join(ingest, "a.dem"), "demo-a");
    lib.importPaths([join(ingest, "a.dem")]);
    for (let i = 0; i < 5; i++) await lib.processQueue();
    expect(repo.list(undefined, 10).map((j) => j.state)).toEqual(["DISCOVERED"]);
    expect(calls).toEqual([]);
    deferred = false;
    for (let i = 0; i < 20 && repo.list(undefined, 10)[0]!.state !== "COMMITTED"; i++) {
      await lib.processQueue();
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(repo.list(undefined, 10)[0]!.state).toBe("COMMITTED");
    expect(calls).toEqual(["extract", "validate"]);
  });

  it("a training run's steps wait while a round is live, then run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mf-lowspec-train-"));
    const { db, settings } = settingsRepo();
    let live = true;
    const mode = new LowSpecMode({ settings, roundLive: () => live });
    mode.set(true);
    const calls: string[] = [];
    const workers: WorkerRunner = {
      available: () => true,
      run: async (args) => {
        calls.push(args[0]!);
        if (args[0] === "audit-split") return { passed: true };
        if (args[0] === "train") return { model_id: "m1", model_dir: join(dir, "m1") };
        return {};
      },
    };
    const training = new TrainingService({ workers, dataDir: dir, demoJobs: new DemoJobRepo(db), settings, session: {} as LiveSession, logger: new Logger("error", null), lowSpec: { whenHeavyAllowed: (o) => mode.whenHeavyAllowed({ ...o, pollMs: 5 }) } });
    const run = training.start("pov_2s", [join(dir, "ds1")]);
    await new Promise((r) => setTimeout(r, 60));
    expect(calls).toEqual([]);
    expect(run.progress).toEqual({ message: "Waiting for the live round to end (low-spec mode)" });
    live = false;
    await training.wait(run, 5000);
    expect(run.state).toBe("completed");
    expect(calls).toEqual(["build-features", "freeze-dataset", "audit-split", "train", "evaluate", "export-model"]);
  });
});

describe("lighter ffmpeg presets in low-spec mode", () => {
  const preset = (args: string[]) => args[args.indexOf("-preset") + 1];
  it("the replay feed's encoders use their fastest preset; the bitrate stays", () => {
    expect(preset(encoderArgs("libx264", 60, 20))).toBe("veryfast");
    expect(preset(encoderArgs("libx264", 60, 20, true))).toBe("ultrafast");
    expect(preset(encoderArgs("h264_nvenc", 60, 20, true))).toBe("p1");
    expect(preset(encoderArgs("h264_nvenc", 60, 20))).toBe("p4");
    expect(encoderArgs("h264_amf", 60, 20, true)).toEqual(expect.arrayContaining(["-quality", "speed"]));
    expect(encoderArgs("h264_amf", 60, 20)).not.toContain("-quality");
    for (const enc of ["libx264", "h264_nvenc", "h264_qsv", "h264_amf"] as const) expect(encoderArgs(enc, 60, 20, true)).toContain("20M");
  });

  it("rendered breaks too", () => {
    expect(preset(renderArgs("h264_nvenc", 60, true))).toBe("p1");
    expect(preset(renderArgs("h264_qsv", 60, true))).toBe("veryfast");
    expect(preset(renderArgs("h264_qsv", 60))).toBe("faster");
    expect(preset(renderArgs("libx264", 60, true))).toBe("ultrafast");
  });
});

/** A stand-in OBS: inputs with their settings (OBS leaves defaults out). */
function standInObs(inputs: { name: string; kind: string; settings?: Record<string, unknown> }[]) {
  const settings = new Map(inputs.map((i) => [i.name, { ...(i.settings ?? {}) }]));
  const handlers: Record<string, (() => void)[]> = {};
  const writes: { name: string; settings: Record<string, unknown> }[] = [];
  const obs: ObsForFrameCap & { emit(ev: string): void } = {
    state: { connected: true, inputs: inputs.map(({ name, kind }) => ({ name, kind })) },
    inputSettings: async (name) => ({ kind: obs.state.inputs.find((i) => i.name === name)?.kind ?? "", settings: { ...settings.get(name) } }),
    setInputSettings: async (name, s) => {
      writes.push({ name, settings: s });
      Object.assign(settings.get(name)!, s);
    },
    on: (ev, fn) => (handlers[ev] ??= []).push(fn),
    emit: (ev) => handlers[ev]?.forEach((fn) => fn()),
  };
  return { obs, settings, writes };
}

describe("OBS browser sources MatchFrame made (low-spec mode)", () => {
  const names = ["MatchFrame HUD", "Matchframe HUD", "MatchFrame Replay Graphic"];

  it("draw at 30 fps while it is on, and get their own frame rate back when it is off; other sources are left alone", async () => {
    const { settings } = settingsRepo();
    const mode = new LowSpecMode({ settings, roundLive: () => false });
    const { obs, settings: obsSettings, writes } = standInObs([
      { name: "MatchFrame HUD", kind: "browser_source", settings: { url: "http://127.0.0.1:37212/hud/x/live" } },
      { name: "MatchFrame Replay Graphic", kind: "browser_source", settings: { fps_custom: true, fps: 60 } },
      { name: "My own HUD", kind: "browser_source", settings: {} },
      { name: "Matchframe HUD", kind: "image_source", settings: {} },
    ]);
    const cap = new ObsFrameCap({ obs, settings, names: () => names, frameCap: () => mode.frameCap() });
    await cap.apply();
    expect(writes).toEqual([]);
    mode.set(true);
    await cap.apply();
    expect(obsSettings.get("MatchFrame HUD")).toMatchObject({ fps_custom: true, fps: 30 });
    expect(obsSettings.get("MatchFrame Replay Graphic")).toMatchObject({ fps_custom: true, fps: 30 });
    expect(obsSettings.get("My own HUD")).toEqual({});
    expect(cap.status()).toEqual({ connected: true, sources: ["MatchFrame HUD", "MatchFrame Replay Graphic"], error: null });
    expect(settings.get(OBS_FPS_BEFORE_KEY, {})).toEqual({ "MatchFrame HUD": { custom: false, fps: 30 }, "MatchFrame Replay Graphic": { custom: true, fps: 60 } });
    // Applying again changes nothing.
    const n = writes.length;
    await cap.apply();
    expect(writes.length).toBe(n);
    mode.set(false);
    await cap.apply();
    expect(obsSettings.get("MatchFrame HUD")).toMatchObject({ fps_custom: false, fps: 30 });
    expect(obsSettings.get("MatchFrame Replay Graphic")).toMatchObject({ fps_custom: true, fps: 60 });
    expect(settings.get(OBS_FPS_BEFORE_KEY, { x: 1 })).toEqual({});
  });

  it("applies when OBS connects and when a MatchFrame source appears", async () => {
    const { settings } = settingsRepo();
    const { obs, settings: obsSettings } = standInObs([{ name: "MatchFrame HUD", kind: "browser_source" }]);
    const cap = new ObsFrameCap({ obs, settings, names: () => names, frameCap: () => 30 });
    cap.attach();
    obs.emit("connected");
    await cap.apply();
    expect(obsSettings.get("MatchFrame HUD")).toMatchObject({ fps_custom: true, fps: 30 });
    // Provisioned later: the state event with the new source applies the cap to it.
    obs.state.inputs.push({ name: "MatchFrame Replay Graphic", kind: "browser_source" });
    obsSettings.set("MatchFrame Replay Graphic", {});
    obs.emit("state");
    await cap.apply();
    expect(obsSettings.get("MatchFrame Replay Graphic")).toMatchObject({ fps_custom: true, fps: 30 });
  });
});
