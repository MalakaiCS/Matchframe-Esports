import { describe, expect, it } from "vitest";
import type { OwnershipState } from "@matchframe/contracts";
import { MapRuntime, syntheticMapPack } from "@matchframe/map-runtime";
import type { SyntheticPlayer } from "@matchframe/cs2-state";
import { Director } from "../src/index.ts";
import { capsWithCameraControl, CT, facingTo, player, Sim, T } from "./helpers.ts";

const armed: OwnershipState = { owner: "director", generation: 2, holder: "director", acquiredAtMonotonicMs: 0, leaseExpiresAtMonotonicMs: null, manualSticky: false, emergencyStopped: false };
const ctl = { ownership: armed, adapterAvailable: true, inputFresh: true, pendingCommand: false };

/** 1v3: T1 alone (far from the action), three CTs in a tight fight-ready group near a duel. */
function oneVsThree(): SyntheticPlayer[] {
  const c1 = { x: 1500, y: 1500, z: 0 };
  const c2 = { x: 1600, y: 1550, z: 0 };
  return [
    player(T(1), "T", 1, { x: -1500, y: -1500, z: 0 }),
    player(T(2), "T", 2, { x: 1400, y: 1400, z: 0 }, null, { health: 0 }),
    player(T(3), "T", 3, { x: -2000, y: 0, z: 0 }, null, { health: 0 }),
    player(T(4), "T", 4, { x: 0, y: -2000, z: 0 }, null, { health: 0 }),
    player(T(5), "T", 5, { x: 2000, y: 0, z: 0 }, null, { health: 0 }),
    player(CT(6), "CT", 6, c1, facingTo(c1, c2)),
    player(CT(7), "CT", 7, c2, facingTo(c2, c1)),
    player(CT(8), "CT", 8, { x: 1550, y: 1450, z: 0 }),
    player(CT(9), "CT", 9, { x: 3000, y: -3000, z: 0 }, null, { health: 0 }),
    player(CT(0), "CT", 0, { x: 3100, y: -3100, z: 0 }, null, { health: 0 }),
  ];
}

function run(clutchMode: boolean) {
  const sim = new Sim("de_inferno");
  const director = new Director({ newId: (() => { let i = 0; return () => `d${i++}`; })() });
  director.setMode("automatic");
  director.setMap(new MapRuntime(syntheticMapPack({ withValidatedCamera: true, mapName: "de_inferno" })));
  director.setCapabilities(capsWithCameraControl("supported"));
  director.controls.clutchMode = clutchMode;
  let observed = CT(6);
  let last = null as ReturnType<Director["evaluate"]> | null;
  for (let i = 0; i < 40; i++) {
    last = director.evaluate(sim.push(oneVsThree(), { mapName: "de_inferno", observed }), sim.now, ctl);
    if (last.intent?.kind === "select_player") observed = last.intent.targetSteamId!;
  }
  return { observed, last: last! };
}

describe("clutch mode", () => {
  it("cuts to the last player alive on their side and stays there", () => {
    const r = run(true);
    expect(r.observed).toBe(T(1));
    const clutcher = r.last.candidates.find((c) => c.targetSteamId === T(1))!;
    expect(clutcher.reasonCodes).toContain("CLUTCH");
    // No cutaway to a camera mid-clutch.
    for (const c of r.last.candidates.filter((x) => x.shotClass !== "pov")) {
      expect(c.valid).toBe(false);
      expect(c.reasonCodes).toContain("CLUTCH");
    }
  });

  it("without clutch mode the director is free to stay on the busier CTs", () => {
    const r = run(false);
    const clutcher = r.last.candidates.find((c) => c.targetSteamId === T(1))!;
    const best = Math.max(...r.last.candidates.filter((c) => c.valid).map((c) => c.utility));
    expect(clutcher.utility).toBeLessThan(best + 1e-9);
    expect(run(true).last.candidates.find((c) => c.targetSteamId === T(1))!.utility).toBeGreaterThan(clutcher.utility + 0.4);
  });
});
