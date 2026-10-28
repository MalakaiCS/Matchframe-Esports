import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { OwnershipState } from "@matchframe/contracts";
import { MapPack } from "@matchframe/contracts";
import type { SyntheticPlayer } from "@matchframe/cs2-state";
import { MapRuntime } from "@matchframe/map-runtime";
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
}

/** Plays 18 s of freeze time then `liveMs` of live round; the "camera" does what the director says. */
function play(opts: { ctAt: { x: number; y: number; z: number }; liveMs: number; neverConfirmed?: boolean }) {
  const rt = new MapRuntime(pack());
  const sim = new Sim("de_mirage", rt);
  const director = new Director({ newId: (() => { let i = 0; return () => `d${i++}`; })() });
  director.setMode("automatic");
  director.setObserverMode("observer_cinematics");
  director.setMap(rt);
  const caps = capsWithCameraControl("supported");
  caps.cameraPathControl = { ...caps.cameraPathControl, support: "supported" };
  director.setCapabilities(caps);
  let observed: string | null = T(1);
  const shots: Shot[] = [];
  const t0 = sim.now;
  const freezeMs = 18000;
  for (let t = 0; t < freezeMs + opts.liveMs; t += 100) {
    const live = t >= freezeMs;
    const state = sim.push(players(opts.ctAt), { mapName: "de_mirage", observed, roundPhase: live ? "live" : "freezetime", phase: live ? "live" : "freezetime", phaseEndsIn: live ? 115 - (t - freezeMs) / 1000 : (freezeMs - t) / 1000 });
    const out = director.evaluate(state, sim.now, control);
    const i = out.intent;
    if (!i) continue;
    if (i.kind === "select_player") {
      observed = i.targetSteamId;
      shots.push({ at: sim.now - t0, kind: "pov", id: i.targetSteamId, regions: [], durationMs: null });
    } else if (i.kind === "activate_static_camera" || i.kind === "play_camera_path") {
      const key = i.kind === "activate_static_camera" ? cameraShot(i.cameraId!) : pathShot(i.pathId!);
      const regions = i.kind === "activate_static_camera" ? rt.pack.cameras.find((c) => c.id === i.cameraId)!.targetRegionIds : rt.pack.paths.find((p) => p.id === i.pathId)!.targetRegionIds;
      shots.push({ at: sim.now - t0, kind: i.kind, id: i.cameraId ?? i.pathId ?? null, regions, durationMs: i.plannedDurationMs });
      // Confirmed at once, like a camera the console's getpos confirms; or never confirmed (the camera stays on the player).
      if (opts.neverConfirmed) director.cinematicFailed(key);
      else {
        observed = null;
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
    expect(cine.length).toBeLessThanOrEqual(2);
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
