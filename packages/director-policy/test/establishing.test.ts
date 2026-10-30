import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { OwnershipState } from "@matchframe/contracts";
import { MapPack } from "@matchframe/contracts";
import type { SyntheticPlayer } from "@matchframe/cs2-state";
import { MapRuntime, VisibilityGrid } from "@matchframe/map-runtime";
import { cameraShot, Director, pathShot } from "../src/index.ts";
import type { ControlStatus } from "../src/index.ts";
import { capsWithCameraControl, CT, player, Sim, T } from "./helpers.ts";

/**
 * Freeze time and the start of a live round on the built-in Mirage cameras and paths: establishing
 * shots of the spawns where the players are, each played in full and never twice, then first person
 * from the start of the live round.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const pack = () => MapPack.parse(JSON.parse(readFileSync(join(root, "assets", "map-packs", "de_mirage.json"), "utf8")));
const armed: OwnershipState = { owner: "director", generation: 2, holder: "director", acquiredAtMonotonicMs: 0, leaseExpiresAtMonotonicMs: null, manualSticky: false, emergencyStopped: false };
const control: ControlStatus = { ownership: armed, adapterAvailable: true, inputFresh: true, pendingCommand: false };

const T_SPAWN = { x: 1230, y: -300, z: -167 };
const CT_SPAWN = { x: -1650, y: -1950, z: -295 };
const MID = { x: -500, y: -700, z: -160 };
const around = (c: { x: number; y: number; z: number }, i: number) => ({ x: c.x + (i % 3) * 50, y: c.y + Math.floor(i / 3) * 50, z: c.z });

function players(ctAt: { x: number; y: number; z: number }): SyntheticPlayer[] {
  return [1, 2, 3, 4, 5].map((n, i) => player(T(n), "T", n, around(T_SPAWN, i))).concat([6, 7, 8, 9, 0].map((n, i) => player(CT(n), "CT", n, around(ctAt, i))));
}

interface Shot {
  at: number;
  kind: string;
  id: string | null;
  regions: string[];
  durationMs: number | null;
  pan: number;
  /** A team shot's glide. */
  move: { from: { x: number; y: number; z: number }; to: { x: number; y: number; z: number } } | null;
}

/**
 * Plays 18 s of freeze time then `liveMs` of live round; the "camera" does what the director says.
 * `pause`: a timeout from `at` ms into freeze time, `ms` long (freeze time is longer by as much).
 */
/**
 * `keepsPlayer`: as CS2 does under the free camera and HLAE's view, the game data goes on naming the
 * player it showed before a cinematic (otherwise it shows the free camera).
 */
function play(opts: { ctAt: { x: number; y: number; z: number }; liveMs: number; neverConfirmed?: boolean; pause?: { at: number; ms: number; phase: "timeout_t" | "timeout_ct" | "paused" }; grid?: boolean; paths?: boolean; keepsPlayer?: boolean }) {
  const rt = new MapRuntime(pack());
  // With Mirage's free-space grid: team shots.
  if (opts.grid) rt.grid = VisibilityGrid.parse(readFileSync(join(root, "assets", "map-packs", "de_mirage.grid")), (b) => inflateSync(b));
  const sim = new Sim("de_mirage", rt);
  const director = new Director({ newId: (() => { let i = 0; return () => `d${i++}`; })() });
  director.setMode("automatic");
  director.setObserverMode("observer_cinematics");
  director.setMap(rt);
  // Camera paths on (the engine does this while the HLAE camera is connected).
  if (opts.paths) director.setConfig({ cinematic: { ...director.config.cinematic, freezeTimePaths: true } });
  const caps = capsWithCameraControl("supported");
  caps.cameraPathControl = { ...caps.cameraPathControl, support: "supported" };
  director.setCapabilities(caps);
  let observed: string | null = T(1);
  const shots: Shot[] = [];
  const t0 = sim.now;
  const pauseMs = opts.pause?.ms ?? 0;
  const freezeMs = 18000 + pauseMs;
  for (let t = 0; t < freezeMs + opts.liveMs; t += 100) {
    const live = t >= freezeMs;
    const p = opts.pause;
    const paused = !!p && t >= p.at && t < p.at + p.ms;
    // The freeze time's clock stops during the pause; the pause has its own.
    const left = paused ? (p!.at + p!.ms - t) / 1000 : (freezeMs - t - (p && t < p.at ? 0 : 0)) / 1000;
    const state = sim.push(players(opts.ctAt), { mapName: "de_mirage", observed, roundPhase: live ? "live" : "freezetime", phase: live ? "live" : paused ? p!.phase : "freezetime", phaseEndsIn: live ? 115 - (t - freezeMs) / 1000 : left });
    const out = director.evaluate(state, sim.now, control);
    const i = out.intent;
    if (!i) continue;
    if (i.kind === "select_player") {
      observed = i.targetSteamId;
      shots.push({ at: sim.now - t0, kind: "pov", id: i.targetSteamId, regions: [], durationMs: null, pan: 0, move: null });
    } else if (i.kind === "activate_static_camera" || i.kind === "play_camera_path") {
      const key = i.kind === "activate_static_camera" ? cameraShot(i.cameraId!) : pathShot(i.pathId!);
      const regions = i.move ? [] : i.kind === "activate_static_camera" ? rt.pack.cameras.find((c) => c.id === i.cameraId)!.targetRegionIds : rt.pack.paths.find((p) => p.id === i.pathId)!.targetRegionIds;
      shots.push({ at: sim.now - t0, kind: i.kind, id: i.cameraId ?? i.pathId ?? null, regions, durationMs: i.plannedDurationMs, pan: i.panDegPerSec ?? 0, move: i.move ?? null });
      // Confirmed at once, like a camera the console's getpos confirms; or never confirmed (the camera stays on the player).
      if (opts.neverConfirmed) director.cinematicFailed(key);
      else {
        if (!opts.keepsPlayer) observed = null;
        director.cinematicStarted(key, sim.now, i.plannedDurationMs ?? 3000, null, false, i.shotClass);
      }
    }
  }
  return { shots, freezeMs };
}

describe("freeze-time establishing shots and the start of the round", () => {
  it("shows the spawns where the players are, each in full and once, then first person when the round goes live", () => {
    const { shots, freezeMs } = play({ ctAt: CT_SPAWN, liveMs: 12000 });
    const cine = shots.filter((s) => s.kind !== "pov");
    // Two shots in freeze time: one of each spawn, the first straight away.
    expect(cine).toHaveLength(2);
    // (The director starts here on a player view, held its minimum 2 s.)
    expect(cine[0]!.at).toBeLessThan(3000);
    expect(cine.every((s) => s.at < freezeMs)).toBe(true);
    const spawns = cine.map((s) => (s.regions.includes("t_spawn") ? "t" : s.regions.includes("ct_spawn") ? "ct" : "other"));
    expect(new Set(spawns)).toEqual(new Set(["t", "ct"]));
    expect(new Set(cine.map((s) => s.id)).size).toBe(2);
    // Each runs its full length (5–6 s), not cut after 3 s: the next shot comes only after it.
    for (const c of cine) {
      const next = shots.find((s) => s.at > c.at);
      expect(c.durationMs).toBeGreaterThanOrEqual(5000);
      if (next && next.at < freezeMs) expect(next.at - c.at).toBeGreaterThanOrEqual(c.durationMs! - 200);
    }
    // Live: first person, no camera, for the round's first seconds.
    expect(shots.filter((s) => s.at >= freezeMs && s.kind !== "pov")).toHaveLength(0);
  });

  it("with camera paths on, flies the paths built from demos round the spawns, each once", () => {
    const { shots, freezeMs } = play({ ctAt: CT_SPAWN, liveMs: 2000, paths: true });
    const cine = shots.filter((s) => s.kind !== "pov" && s.at < freezeMs);
    const paths = cine.filter((s) => s.kind === "play_camera_path");
    expect(paths.length, JSON.stringify(cine)).toBeGreaterThanOrEqual(1);
    expect(paths.some((s) => s.id!.startsWith("demo-mirage-")), JSON.stringify(paths)).toBe(true);
    for (const s of cine) expect(s.regions.some((r) => r === "t_spawn" || r === "ct_spawn"), JSON.stringify(s)).toBe(true);
    expect(new Set(cine.map((s) => s.id)).size).toBe(cine.length);
    expect(shots.find((s) => s.at >= freezeMs)?.kind).toBe("pov");
  });

  it("fills the freeze time: shot after shot with no player view between, each turning slowly, the last until the round goes live", () => {
    const { shots, freezeMs } = play({ ctAt: CT_SPAWN, liveMs: 3000 });
    const first = shots.findIndex((s) => s.kind !== "pov");
    const inFreeze = shots.slice(first).filter((s) => s.at < freezeMs);
    // From the first shot to the end of freeze time: only cameras, never a player.
    expect(inFreeze.every((s) => s.kind === "activate_static_camera"), JSON.stringify(inFreeze)).toBe(true);
    for (const [i, s] of inFreeze.entries()) {
      const end = s.at + s.durationMs!;
      const next = inFreeze[i + 1];
      // Each one ends when the next starts; the last runs past the end of freeze time.
      if (next) expect(Math.abs(next.at - end)).toBeLessThanOrEqual(300);
      else expect(end).toBeGreaterThanOrEqual(freezeMs);
      // Turning slowly, one way then the other: at most 30° over the shot.
      expect(Math.abs(s.pan)).toBeGreaterThan(0);
      expect(Math.abs(s.pan) * (s.durationMs! / 1000)).toBeLessThanOrEqual(30.01);
      if (i > 0) expect(Math.sign(s.pan)).toBe(-Math.sign(inFreeze[i - 1]!.pan));
    }
    // Then first person straight away.
    const afterLive = shots.filter((s) => s.at >= freezeMs);
    expect(afterLive[0]?.kind).toBe("pov");
    expect(afterLive[0]!.at - freezeMs).toBeLessThan(400);
  });

  it("in a tactical timeout, cuts to a still shot of the spawn of the team that called it and holds it until the round goes live", () => {
    for (const [phase, spawn] of [["timeout_ct", "ct_spawn"], ["timeout_t", "t_spawn"]] as const) {
      const { shots, freezeMs } = play({ ctAt: CT_SPAWN, liveMs: 2000, pause: { at: 6000, ms: 30000, phase } });
      const pauseShot = shots.find((s) => s.at >= 6000 && s.kind !== "pov");
      expect(pauseShot, JSON.stringify(shots)).toBeTruthy();
      // At once (the shot on air when the pause began gives way), still, of that team's spawn.
      expect(pauseShot!.at - 6000).toBeLessThan(400);
      expect(pauseShot!.kind).toBe("activate_static_camera");
      expect(pauseShot!.pan).toBe(0);
      expect(pauseShot!.regions).toContain(spawn);
      // Nothing else until the round goes live (also after the pause ends, in the rest of freeze time); then first person.
      const after = shots.filter((s) => s.at > pauseShot!.at);
      expect(after[0]?.kind).toBe("pov");
      expect(after[0]!.at).toBeGreaterThanOrEqual(freezeMs);
      expect(after[0]!.at - freezeMs).toBeLessThan(400);
    }
  });

  it("in a technical pause, holds a still shot of a team until the round goes live", () => {
    const { shots, freezeMs } = play({ ctAt: CT_SPAWN, liveMs: 2000, pause: { at: 4000, ms: 60000, phase: "paused" } });
    const pauseShot = shots.find((s) => s.at >= 4000 && s.kind !== "pov")!;
    expect(pauseShot.pan).toBe(0);
    expect(pauseShot.regions.some((r) => r === "t_spawn" || r === "ct_spawn")).toBe(true);
    const after = shots.filter((s) => s.at > pauseShot.at);
    expect(after[0]?.kind).toBe("pov");
    expect(after[0]!.at - freezeMs).toBeLessThan(400);
  });

  it("leaves out a spawn nobody is in", () => {
    const { shots } = play({ ctAt: MID, liveMs: 1000 });
    const cine = shots.filter((s) => s.kind !== "pov");
    expect(cine.length).toBeGreaterThanOrEqual(1);
    expect(cine.every((s) => !s.regions.includes("ct_spawn"))).toBe(true);
    expect(cine.some((s) => s.regions.includes("t_spawn"))).toBe(true);
  });

  it("never sends a shot again that didn't come on air (no restarting the same path over and over)", () => {
    const { shots } = play({ ctAt: CT_SPAWN, liveMs: 1000, neverConfirmed: true });
    const cine = shots.filter((s) => s.kind !== "pov");
    expect(cine.length).toBeGreaterThanOrEqual(1);
    expect(cine.length).toBeLessThanOrEqual(4);
    expect(new Set(cine.map((s) => s.id)).size).toBe(cine.length);
  });

  it("never repeats an action when the same game data is evaluated again (a camera confirmed at once isn't sent twice)", () => {
    const rt = new MapRuntime(pack());
    const sim = new Sim("de_mirage", rt);
    const director = new Director({ newId: (() => { let i = 0; return () => `d${i++}`; })() });
    director.setMode("automatic");
    director.setObserverMode("observer_cinematics");
    director.setMap(rt);
    director.setCapabilities(capsWithCameraControl("supported"));
    let intent = null as ReturnType<Director["evaluate"]>["intent"];
    let state = sim.push(players(CT_SPAWN), { mapName: "de_mirage", observed: T(1), roundPhase: "freezetime", phase: "freezetime", phaseEndsIn: 18 });
    for (let i = 0; i < 40 && !intent; i++) {
      state = sim.push(players(CT_SPAWN), { mapName: "de_mirage", observed: T(1), roundPhase: "freezetime", phase: "freezetime", phaseEndsIn: 18 - i / 10 });
      intent = director.evaluate(state, sim.now, control).intent;
    }
    expect(intent?.kind).toBe("activate_static_camera");
    // The console confirms it at once; the same packet is evaluated again a moment later.
    director.cinematicStarted(cameraShot(intent!.cameraId!), sim.now, intent!.plannedDurationMs ?? 3000, null, false, intent!.shotClass);
    const again = director.evaluate(state, sim.now + 20, control);
    expect(again.intent).toBeNull();
  });

  it("keeps a camera on air when game data from before the cut arrives just after it was confirmed", () => {
    const rt = new MapRuntime(pack());
    const sim = new Sim("de_mirage", rt);
    const director = new Director({ newId: (() => { let i = 0; return () => `d${i++}`; })() });
    director.setMode("automatic");
    director.setObserverMode("observer_cinematics");
    director.setMap(rt);
    director.setCapabilities(capsWithCameraControl("supported"));
    const freeze = (left: number, observed: string | null) => sim.push(players(CT_SPAWN), { mapName: "de_mirage", observed, roundPhase: "freezetime", phase: "freezetime", phaseEndsIn: left });
    let intent = null as ReturnType<Director["evaluate"]>["intent"];
    for (let i = 0; i < 40 && !intent; i++) intent = director.evaluate(freeze(18 - i / 10, T(1)), sim.now, control).intent;
    expect(intent?.kind).toBe("activate_static_camera");
    const shot = cameraShot(intent!.cameraId!);
    director.cinematicStarted(shot, sim.now, intent!.plannedDurationMs ?? 3000, null, false, intent!.shotClass);
    // A packet still showing the player, then the free camera: the camera stays, nothing new is sent.
    const stale = director.evaluate(freeze(15, T(1)), sim.now, control);
    expect(stale.intent).toBeNull();
    expect(director.shotPlanner.shot).toBe(shot);
    for (let i = 0; i < 20; i++) expect(director.evaluate(freeze(14.8 - i / 10, null), sim.now, control).intent).toBeNull();
    expect(director.shotPlanner.activeCinematic?.shotKey).toBe(shot);
  });

  it("cuts from an establishing shot still playing to first person when the round goes live", () => {
    // Freeze time ends while the second shot plays: the cut to a player comes at once.
    const { shots, freezeMs } = play({ ctAt: CT_SPAWN, liveMs: 3000 });
    const afterLive = shots.filter((s) => s.at >= freezeMs);
    const lastCine = shots.filter((s) => s.kind !== "pov").at(-1)!;
    const lastEnd = lastCine.at + lastCine.durationMs!;
    if (lastEnd > freezeMs) {
      expect(afterLive[0]?.kind).toBe("pov");
      expect(afterLive[0]!.at - freezeMs).toBeLessThan(600);
    }
  });
});

describe("team shots (the map's free-space grid frames each team where it stands)", () => {
  it("shows each team once, framed where it stands, gliding, for all of freeze time, then first person", () => {
    const { shots, freezeMs } = play({ ctAt: CT_SPAWN, liveMs: 3000, grid: true });
    const first = shots.findIndex((s) => s.kind !== "pov");
    const inFreeze = shots.slice(first).filter((s) => s.at < freezeMs);
    expect(inFreeze.map((s) => s.id).sort(), JSON.stringify(inFreeze)).toEqual(["team-CT", "team-T"]);
    for (const s of inFreeze) {
      // Gliding: the camera moves (Matchframe sends the poses), and doesn't also turn.
      expect(s.move).not.toBeNull();
      expect(Math.hypot(s.move!.to.x - s.move!.from.x, s.move!.to.y - s.move!.from.y)).toBeGreaterThan(10);
      expect(s.pan).toBe(0);
    }
    // The last runs until the round goes live; then first person.
    expect(inFreeze[1]!.at + inFreeze[1]!.durationMs!).toBeGreaterThanOrEqual(freezeMs);
    expect(shots.find((s) => s.at >= freezeMs)?.kind).toBe("pov");
  });

  it("in a tactical timeout, glides round the team that called it, one way then back, until the round goes live", () => {
    for (const keepsPlayer of [false, true]) {
      const { shots, freezeMs } = play({ ctAt: CT_SPAWN, liveMs: 2000, grid: true, pause: { at: 4000, ms: 50000, phase: "timeout_ct" }, keepsPlayer });
      const inPause = shots.filter((s) => s.at >= 4000 && s.at < freezeMs);
      expect(inPause.map((s) => s.id), JSON.stringify(inPause)).toEqual(["team-CT-still", "team-CT-still-back", "team-CT-still", "team-CT-still-back"]);
      expect(inPause[0]!.at - 4000).toBeLessThan(500);
      for (let i = 0; i < inPause.length; i++) {
        const s = inPause[i]!;
        expect(Math.hypot(s.move!.to.x - s.move!.from.x, s.move!.to.y - s.move!.from.y)).toBeGreaterThan(60); // moving
        expect(s.durationMs).toBe(20000);
        if (i > 0) {
          // Each glide starts where the one before ended, 20 s later.
          expect(s.move!.from).toEqual(inPause[i - 1]!.move!.to);
          expect(s.at - inPause[i - 1]!.at).toBeGreaterThanOrEqual(19800);
          expect(s.at - inPause[i - 1]!.at).toBeLessThan(20400);
        }
      }
      expect(shots.find((s) => s.at >= freezeMs)?.kind).toBe("pov");
    }
  });

  it("holds each team shot its full length while the game data goes on naming the player (CS2 under HLAE), and cuts to first person once", () => {
    const { shots, freezeMs } = play({ ctAt: CT_SPAWN, liveMs: 3000, grid: true, keepsPlayer: true });
    const first = shots.findIndex((s) => s.kind !== "pov");
    const inFreeze = shots.slice(first).filter((s) => s.at < freezeMs);
    // The same two shots as when the game data shows the free camera: nothing sent again.
    expect(inFreeze.map((s) => s.id).sort(), JSON.stringify(inFreeze)).toEqual(["team-CT", "team-T"]);
    expect(inFreeze[1]!.at - inFreeze[0]!.at).toBeGreaterThanOrEqual(inFreeze[0]!.durationMs! - 300);
    // Live: one player selection, not one per game-data packet.
    const live = shots.filter((s) => s.at >= freezeMs);
    expect(live[0]?.kind).toBe("pov");
    expect(live.filter((s) => s.at - live[0]!.at < 1000)).toHaveLength(1);
  });

  it("cuts to the pause shot also from the same team's glide, whichever team is on air", () => {
    for (const at of [6000, 13000]) {
      for (const [phase, side] of [["timeout_t", "T"], ["timeout_ct", "CT"]] as const) {
        const { shots } = play({ ctAt: CT_SPAWN, liveMs: 1000, grid: true, pause: { at, ms: 15000, phase } });
        const hold = shots.find((s) => s.at >= at && s.kind !== "pov");
        expect(hold?.id, `${phase} at ${at}: ${JSON.stringify(shots)}`).toBe(`team-${side}-still`);
        expect(hold!.at - at).toBeLessThan(500);
      }
    }
  });
});
