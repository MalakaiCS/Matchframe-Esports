import { describe, expect, it } from "vitest";
import type { CameraRecord, OwnershipState } from "@matchframe/contracts";
import { MapRuntime, syntheticMapPack } from "@matchframe/map-runtime";
import type { SyntheticGrenade, SyntheticPlayer } from "@matchframe/cs2-state";
import { DEFAULT_DIRECTOR_CONFIG, Director } from "../src/index.ts";
import type { ControlStatus } from "../src/index.ts";
import { capsWithCameraControl, CT, player, Sim, T } from "./helpers.ts";

const armed: OwnershipState = { owner: "director", generation: 2, holder: "director", acquiredAtMonotonicMs: 0, leaseExpiresAtMonotonicMs: null, manualSticky: false, emergencyStopped: false };
const control: ControlStatus = { ownership: armed, adapterAvailable: true, inputFresh: true, pendingCommand: false };
const MAP = "de_inferno";

/** SYNTHETIC cameras added to the synthetic pack: one on Bombsite B for the bomb, one establishing shot for freeze time. */
function pack() {
  const p = syntheticMapPack({ withValidatedCamera: true, mapName: MAP });
  const base = p.cameras[0]!;
  const extra: CameraRecord[] = [
    { ...base, id: "synthetic-site-b-bomb", displayName: "SYNTHETIC B site", targetRegionIds: ["site_b"], coverage: { center: { x: 1800, y: 0, z: 0 }, radiusUnits: 800, zMin: -200, zMax: 300, levelId: "ground" }, actionClasses: ["bomb"], allowedPhases: ["live"] },
    { ...base, id: "synthetic-establishing", displayName: "SYNTHETIC establishing", targetRegionIds: ["mid"], coverage: { center: { x: 0, y: 2000, z: 0 }, radiusUnits: 900, zMin: -200, zMax: 300, levelId: "ground" }, actionClasses: ["establishing"], allowedPhases: ["freezetime"] },
  ];
  p.cameras.push(...extra);
  return p;
}

function setup(mode: Parameters<Director["setObserverMode"]>[0]) {
  const sim = new Sim(MAP);
  const director = new Director({ newId: (() => { let i = 0; return () => `d${i++}`; })() });
  director.setObserverMode(mode);
  director.setMap(new MapRuntime(pack()));
  director.setCapabilities(capsWithCameraControl("supported"));
  return { sim, director };
}

function bananaStack(): SyntheticPlayer[] {
  return [
    player(T(1), "T", 1, { x: -600, y: 0, z: 0 }),
    player(T(2), "T", 2, { x: -500, y: 100, z: 0 }),
    player(T(3), "T", 3, { x: -700, y: -100, z: 0 }),
    player(T(4), "T", 4, { x: -2500, y: -2500, z: 0 }),
    player(T(5), "T", 5, { x: -2600, y: -2400, z: 0 }),
    player(CT(6), "CT", 6, { x: 1800, y: 3200, z: 0 }),
    player(CT(7), "CT", 7, { x: 1900, y: 3300, z: 0 }),
    player(CT(8), "CT", 8, { x: 2000, y: 3100, z: 0 }),
    player(CT(9), "CT", 9, { x: 2100, y: 3400, z: 0 }),
    player(CT(0), "CT", 0, { x: 2200, y: 3000, z: 0 }),
  ];
}
/** Freeze time: three Ts waiting in mid, where the establishing camera and the path look. */
function midWait(): SyntheticPlayer[] {
  return bananaStack().map((p, i) => (i < 3 ? { ...p, position: { x: -150 + i * 150, y: 1950 + i * 40, z: 0 } } : p));
}
const incomingHe: SyntheticGrenade = { id: "500", type: "frag", owner: CT(6), position: { x: -650, y: -250, z: 120 }, velocity: { x: 80, y: 250, z: 40 }, lifetime: 0.6 };

/** Closed loop: the simulated observer follows executed intents; static cameras are confirmed at once. */
function run(sim: Sim, director: Director, steps: { players: SyntheticPlayer[]; grenades?: SyntheticGrenade[]; roundPhase?: "freezetime" | "live" | "over"; phase?: string; phaseEndsIn?: number; bomb?: { state: string; position?: { x: number; y: number; z: number }; countdown?: number } }[]) {
  let observed: string | null = steps[0]!.players[0]!.steamId;
  const outs = [];
  for (const s of steps) {
    const out = director.evaluate(sim.push(s.players, { mapName: MAP, observed, grenades: s.grenades ?? [], ...(s.roundPhase ? { roundPhase: s.roundPhase } : {}), ...(s.phase ? { phase: s.phase } : {}), ...(s.phaseEndsIn !== undefined ? { phaseEndsIn: s.phaseEndsIn } : {}), ...(s.bomb ? { bomb: s.bomb } : {}) }), sim.now, control);
    if (out.intent?.kind === "select_player") observed = out.intent.targetSteamId;
    if (out.intent?.kind === "activate_static_camera") {
      observed = null;
      director.cinematicStarted(`camera:${out.intent.cameraId}`, sim.now, out.intent.plannedDurationMs ?? 2000, out.intent.opportunityId, out.intent.shotClass !== "establishing");
    }
    outs.push(out);
  }
  return outs;
}

const settled = (players: SyntheticPlayer[], extra: { grenades?: SyntheticGrenade[] } = {}) => [...Array.from({ length: 30 }, () => ({ players })), { players, ...extra }];

describe("Observer modes: what the auto director may do on its own", () => {
  it("Off only recommends: no intents, even for an obvious cut", () => {
    const { sim, director } = setup("off");
    expect(director.currentMode).toBe("advisory");
    const outs = run(sim, director, settled(bananaStack(), { grenades: [incomingHe] }));
    expect(outs.every((o) => o.intent === null)).toBe(true);
  });

  it("Observer and Observer & Cinematics never use a nade camera; they show the utility from a POV", () => {
    for (const mode of ["observer", "observer_cinematics"] as const) {
      const { sim, director } = setup(mode);
      const out = run(sim, director, settled(bananaStack(), { grenades: [incomingHe] })).at(-1)!;
      const nadeCam = out.candidates.find((c) => c.shotClass === "static_utility");
      expect(nadeCam?.valid, mode).toBe(false);
      expect(nadeCam?.reasonCodes, mode).toContain("OBSERVER_MODE_EXCLUDES");
      expect(out.intent?.kind, mode).not.toBe("activate_static_camera");
      // The utility still raises the affected players' POVs (shown "as if no camera covered it").
      expect(out.candidates.some((c) => c.shotClass === "pov" && c.reasonCodes.includes("UTILITY_NO_CAMERA")), mode).toBe(true);
    }
  });

  it("Full Action Observer cuts to the nade camera for consequential utility", () => {
    const { sim, director } = setup("full_action");
    const out = run(sim, director, settled(bananaStack(), { grenades: [incomingHe] })).at(-1)!;
    expect(out.intent).toMatchObject({ kind: "activate_static_camera", shotClass: "static_utility", cameraId: "synthetic-bottom-banana-wide" });
  });

  it("Observer & Cinematics takes an establishing shot in freeze time without using the round's cinematic budget; Observer does not", () => {
    const freeze = (n: number) => Array.from({ length: n }, () => ({ players: midWait(), roundPhase: "freezetime" as const, phase: "freezetime", phaseEndsIn: 15 }));
    const cine = setup("observer_cinematics");
    const outs = run(cine.sim, cine.director, freeze(30));
    const cut = outs.find((o) => o.intent?.kind === "activate_static_camera");
    expect(cut?.intent).toMatchObject({ shotClass: "establishing", cameraId: "synthetic-establishing" });
    expect(cine.director.shotPlanner.cinematicBudgetLeft()).toBe(cine.director.config.cinematic.perRoundBudget);

    const obs = setup("observer");
    const obsOuts = run(obs.sim, obs.director, freeze(30));
    expect(obsOuts.some((o) => o.intent?.kind === "activate_static_camera")).toBe(false);
    expect(obsOuts.at(-1)!.candidates.some((c) => c.shotClass === "establishing")).toBe(false);
  });

  it("no establishing shot when freeze time is about to end", () => {
    const { sim, director } = setup("observer_cinematics");
    const outs = run(sim, director, Array.from({ length: 30 }, () => ({ players: midWait(), roundPhase: "freezetime" as const, phase: "freezetime", phaseEndsIn: 2 })));
    expect(outs.at(-1)!.candidates.some((c) => c.shotClass === "establishing")).toBe(false);
  });

  it("Observer & Cinematics offers the bomb camera during a defuse; the Observer mode does not", () => {
    const players = [player(CT(6), "CT", 6, { x: 1790, y: 10, z: 0 }), player(CT(7), "CT", 7, { x: 1500, y: 300, z: 0 }), player(T(1), "T", 1, { x: -2500, y: -2500, z: 0 })];
    const bomb = { state: "defusing", position: { x: 1800, y: 0, z: 0 }, countdown: 20 };
    const steps = Array.from({ length: 20 }, () => ({ players, bomb }));
    const cine = setup("observer_cinematics");
    const bombCam = run(cine.sim, cine.director, steps).at(-1)!.candidates.find((c) => c.shotClass === "bomb_resolution");
    expect(bombCam).toMatchObject({ cameraId: "synthetic-site-b-bomb", valid: true });
    expect(bombCam?.reasonCodes).toContain("BOMB_DEFUSE_PRESSURE");

    const obs = setup("observer");
    expect(run(obs.sim, obs.director, steps).at(-1)!.candidates.some((c) => c.shotClass === "bomb_resolution")).toBe(false);
  });

  it("Observer & Cinematics flies a built-in camera path in freeze time when freeze-time paths are on, it fits and path control is confirmed", () => {
    const withPath = () => {
      const p = pack();
      p.paths.push({ id: "nav-synthetic-mid-orbit", displayName: "Mid orbit", mapName: MAP, mapRevision: p.mapRevision, keyframes: [{ tMs: 0, position: { x: -400, y: 1600, z: 150 }, pitch: 15, yaw: 45 }, { tMs: 6000, position: { x: 400, y: 1600, z: 150 }, pitch: 15, yaw: 135 }], maxDurationMs: 7000, maxSpeedUnitsPerSec: 300, collisionValidated: false, validation: "unvalidated", targetRegionIds: ["mid"], source: "derived_navmesh" });
      return new MapRuntime(p);
    };
    const freeze = (left: number) => Array.from({ length: 30 }, () => ({ players: midWait(), roundPhase: "freezetime" as const, phase: "freezetime", phaseEndsIn: left }));
    const caps = (path: "supported" | "unverified") => {
      const c = capsWithCameraControl("supported");
      c.cameraPathControl = { ...c.cameraPathControl, support: path };
      return c;
    };

    // Off by default: paths are streamed from Matchframe, less smooth than a camera turning in the game.
    const def = setup("observer_cinematics");
    def.director.setMap(withPath());
    def.director.setCapabilities(caps("supported"));
    expect(run(def.sim, def.director, freeze(15)).at(-1)!.candidates.some((c) => c.shotClass === "camera_path")).toBe(false);

    const on = (s: ReturnType<typeof setup>) => s.director.setConfig({ cinematic: { ...DEFAULT_DIRECTOR_CONFIG.cinematic, freezeTimePaths: true } });
    const ok = setup("observer_cinematics");
    on(ok);
    ok.director.setMap(withPath());
    ok.director.setCapabilities(caps("supported"));
    const cut = run(ok.sim, ok.director, freeze(15)).find((o) => o.intent && o.intent.kind !== "select_player");
    expect(cut?.intent).toMatchObject({ kind: "play_camera_path", shotClass: "camera_path", pathId: "nav-synthetic-mid-orbit", plannedDurationMs: 6000 });

    // Not enough freeze time left.
    const late = setup("observer_cinematics");
    on(late);
    late.director.setMap(withPath());
    late.director.setCapabilities(caps("supported"));
    expect(run(late.sim, late.director, freeze(2.5)).at(-1)!.candidates.some((c) => c.shotClass === "camera_path")).toBe(false);

    // Path control not confirmed yet: offered, but not valid.
    const unverified = setup("observer_cinematics");
    on(unverified);
    unverified.director.setMap(withPath());
    unverified.director.setCapabilities(caps("unverified"));
    const cand = run(unverified.sim, unverified.director, freeze(15)).at(-1)!.candidates.find((c) => c.shotClass === "camera_path");
    expect(cand).toMatchObject({ valid: false });
    expect(cand?.reasonCodes).toContain("CAMERA_UNVERIFIED");

    // Built-in cameras switched off: no path.
    const off = setup("observer_cinematics");
    on(off);
    const rt = withPath();
    rt.builtInCameras = false;
    off.director.setMap(rt);
    off.director.setCapabilities(caps("supported"));
    expect(run(off.sim, off.director, freeze(15)).at(-1)!.candidates.some((c) => c.shotClass === "camera_path")).toBe(false);
  });

  it("cinematics stay subject to the camera-control capability", () => {
    const { sim, director } = setup("observer_cinematics");
    director.setCapabilities(capsWithCameraControl("unverified"));
    const outs = run(sim, director, Array.from({ length: 30 }, () => ({ players: midWait(), roundPhase: "freezetime" as const, phase: "freezetime", phaseEndsIn: 15 })));
    const est = outs.at(-1)!.candidates.find((c) => c.shotClass === "establishing");
    expect(est?.valid).toBe(false);
    expect(est?.reasonCodes).toContain("CAMERA_UNVERIFIED");
    expect(outs.some((o) => o.intent?.kind === "activate_static_camera")).toBe(false);
  });
});
