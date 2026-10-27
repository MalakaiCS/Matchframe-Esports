import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { OwnershipState } from "@matchframe/contracts";
import { MapPack } from "@matchframe/contracts";
import { MapRuntime } from "@matchframe/map-runtime";
import type { SyntheticGrenade, SyntheticPlayer } from "@matchframe/cs2-state";
import { Director } from "../src/index.ts";
import type { ControlStatus } from "../src/index.ts";
import { capsWithCameraControl, CT, player, Sim, T } from "./helpers.ts";

/**
 * Scenario logic on the demo-derived Inferno map pack (assets/map-packs/de_inferno.json, built by
 * `build-map-pack` from a real 2023 demo). Player movement and grenades are still synthetic GSI;
 * this checks region association and the scenario rule on real geometry, not live broadcast.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const inferno = new MapRuntime(MapPack.parse(JSON.parse(readFileSync(join(root, "assets", "map-packs", "de_inferno.json"), "utf8"))));
const armed: OwnershipState = { owner: "director", generation: 2, holder: "director", acquiredAtMonotonicMs: 0, leaseExpiresAtMonotonicMs: null, manualSticky: false, emergencyStopped: false };
const control: ControlStatus = { ownership: armed, adapterAvailable: true, inputFresh: true, pendingCommand: false };

/** Cell centres taken from the derived bottom_banana region (64-unit cells, z cell 0). */
const cell = (ix: number, iy: number) => ({ x: ix * 64 + 32, y: iy * 64 + 32, z: 40 });

function stack(): SyntheticPlayer[] {
  return [
    player(T(1), "T", 1, cell(1, 16)),
    player(T(2), "T", 2, cell(2, 17)),
    player(T(3), "T", 3, cell(2, 19)),
    player(T(4), "T", 4, { x: -1500, y: -400, z: 40 }),
    player(T(5), "T", 5, { x: -1600, y: -300, z: 40 }),
    player(CT(6), "CT", 6, { x: 2000, y: 2400, z: 150 }),
    player(CT(7), "CT", 7, { x: 2100, y: 2500, z: 150 }),
    player(CT(8), "CT", 8, { x: 2200, y: 600, z: 150 }),
    player(CT(9), "CT", 9, { x: 2300, y: 700, z: 150 }),
    player(CT(0), "CT", 0, { x: 2400, y: 800, z: 150 }),
  ];
}

function setup() {
  const sim = new Sim("de_inferno", inferno);
  const director = new Director({ newId: (() => { let i = 0; return () => `d${i++}`; })() });
  director.setMode("automatic");
  director.setMap(inferno);
  director.setCapabilities(capsWithCameraControl("supported"));
  return { sim, director };
}

function settle(sim: Sim, director: Director, players: SyntheticPlayer[]) {
  for (let i = 0; i < 30; i++) director.evaluate(sim.push(players, { mapName: "de_inferno", observed: players[0]!.steamId }), sim.now, control);
}

/** HE thrown from Top Banana down onto the stack; detonates ~1 s later (1.6 s fuse, 0.6 s elapsed). */
const he = (type = "frag"): SyntheticGrenade => ({ id: "700", type, owner: CT(6), position: { x: 160, y: 1000, z: 140 }, velocity: { x: 0, y: 120, z: 60 }, lifetime: 0.6 });

describe("Inferno Bottom Banana on demo-derived geometry", () => {
  it("places the stack in the derived bottom_banana region (inside the parent Banana place)", () => {
    for (const p of stack().slice(0, 3)) {
      const regions = inferno.regionsAt(p.position!);
      expect(regions).toContain("bottom_banana");
      expect(regions).toContain("banana");
      expect(regions).not.toContain("top_banana");
    }
    expect(inferno.region("bottom_banana")?.tags).toContain("requires_operator_validation");
  });

  it("A22 (geometry level): consequential utility into the stack raises the Bottom Banana opportunity", () => {
    const { sim, director } = setup();
    const players = stack();
    settle(sim, director, players);
    const out = director.evaluate(sim.push(players, { mapName: "de_inferno", grenades: [he()], observed: T(1) }), sim.now, control);
    const opp = out.opportunities.find((o) => o.scenarioId === "inferno-bottom-banana");
    expect(opp).toBeDefined();
    expect(opp!.regionIds).toContain("bottom_banana");
    expect(opp!.affected.filter((a) => a.side === "T").length).toBeGreaterThanOrEqual(3);
    expect(opp!.timeToEffectMs).toBeLessThanOrEqual(2500);
  });

  it("A61/A25: with built-in cameras off the real pack has no validated camera, so no cinematic is planned and a POV fallback is used", () => {
    inferno.builtInCameras = false;
    try {
      const { sim, director } = setup();
      const players = stack();
      settle(sim, director, players);
      const out = director.evaluate(sim.push(players, { mapName: "de_inferno", grenades: [he()], observed: T(1) }), sim.now, control);
      const opp = out.opportunities.find((o) => o.scenarioId === "inferno-bottom-banana")!;
      expect(opp.camera).toBeNull();
      expect(opp.cameraIssue).toBeTruthy();
      expect(out.candidates.some((c) => c.shotClass === "static_utility" && c.valid)).toBe(false);
      expect(out.intent?.kind).not.toBe("activate_static_camera");
    } finally {
      inferno.builtInCameras = true;
    }
  });

  it("with built-in cameras on, the scenario may use one of the pack's built-in cameras (placed from map data), never an unvalidated operator pose", () => {
    const { sim, director } = setup();
    const players = stack();
    settle(sim, director, players);
    const out = director.evaluate(sim.push(players, { mapName: "de_inferno", grenades: [he()], observed: T(1) }), sim.now, control);
    const opp = out.opportunities.find((o) => o.scenarioId === "inferno-bottom-banana")!;
    if (opp.camera) expect(opp.camera.camera.capturedFrom).toBe("derived_navmesh");
  });

  it("A23 (geometry level): the T stack alone, or a smoke/decoy into it, raises no scenario", () => {
    for (const grenades of [[], [he("smoke")], [he("decoy")]]) {
      const { sim, director } = setup();
      const players = stack();
      settle(sim, director, players);
      const out = director.evaluate(sim.push(players, { mapName: "de_inferno", grenades, observed: T(1) }), sim.now, control);
      expect(out.opportunities.some((o) => o.scenarioId === "inferno-bottom-banana")).toBe(false);
    }
  });
});
