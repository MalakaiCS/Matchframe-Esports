import { describe, expect, it } from "vitest";
import type { OwnershipState } from "@matchframe/contracts";
import { MapRuntime, syntheticMapPack } from "@matchframe/map-runtime";
import type { SyntheticPlayer } from "@matchframe/cs2-state";
import { Director } from "../src/index.ts";
import { capsWithCameraControl, CT, facingTo, player, Sim, T } from "./helpers.ts";

const armed: OwnershipState = { owner: "director", generation: 2, holder: "director", acquiredAtMonotonicMs: 0, leaseExpiresAtMonotonicMs: null, manualSticky: false, emergencyStopped: false };
const ctl = { ownership: armed, adapterAvailable: true, inputFresh: true, pendingCommand: false };

/** Two duels far apart: T1 vs CT6 and T4 vs CT9, everyone else spread out. */
function twoDuels(): SyntheticPlayer[] {
  const a1 = { x: -600, y: 0, z: 0 };
  const a2 = { x: -350, y: 120, z: 0 };
  const b1 = { x: 2000, y: 2600, z: 0 };
  const b2 = { x: 2250, y: 2700, z: 0 };
  return [
    player(T(1), "T", 1, a1, facingTo(a1, a2)),
    player(T(2), "T", 2, { x: -2500, y: -2500, z: 0 }),
    player(T(3), "T", 3, { x: -2700, y: -2300, z: 0 }),
    player(T(4), "T", 4, b1, facingTo(b1, b2)),
    player(T(5), "T", 5, { x: -2600, y: 900, z: 0 }),
    player(CT(6), "CT", 6, a2, facingTo(a2, a1)),
    player(CT(7), "CT", 7, { x: 3500, y: -800, z: 0 }),
    player(CT(8), "CT", 8, { x: 3600, y: -900, z: 0 }),
    player(CT(9), "CT", 9, b2, facingTo(b2, b1)),
    player(CT(0), "CT", 0, { x: 3400, y: -1000, z: 0 }),
  ];
}

function run(avoid: string[] | null) {
  const sim = new Sim("de_inferno");
  const director = new Director({ newId: (() => { let i = 0; return () => `d${i++}`; })() });
  director.setMode("automatic");
  director.setMap(new MapRuntime(syntheticMapPack({ withValidatedCamera: true, mapName: "de_inferno" })));
  director.setCapabilities(capsWithCameraControl("supported"));
  let observed = T(2);
  let last = null as ReturnType<Director["evaluate"]> | null;
  for (let i = 0; i < 30; i++) {
    if (avoid) director.avoid(avoid, sim.now + 1000);
    last = director.evaluate(sim.push(twoDuels(), { mapName: "de_inferno", observed }), sim.now, ctl);
    if (last.intent?.kind === "select_player") observed = last.intent.targetSteamId!;
  }
  return { observed, last: last! };
}

describe("avoiding the player another observer shows (replay PC)", () => {
  it("films the next-best player, and marks the avoided one", () => {
    const free = run(null);
    expect([T(1), CT(6), T(4), CT(9)]).toContain(free.observed);
    const replay = run([free.observed]);
    expect(replay.observed).not.toBe(free.observed);
    expect([T(1), CT(6), T(4), CT(9)]).toContain(replay.observed);
    const avoided = replay.last.candidates.find((c) => c.targetSteamId === free.observed)!;
    expect(avoided.reasonCodes).toContain("MAIN_OBSERVER_ON_IT");
    expect(avoided.valid).toBe(true);
  });

  it("stops avoiding when the main PC's player is no longer fresh", () => {
    const sim = new Sim("de_inferno");
    const director = new Director();
    director.setMode("automatic");
    director.avoid([T(1)], sim.now - 1);
    const out = director.evaluate(sim.push(twoDuels(), { mapName: "de_inferno", observed: T(2) }), sim.now, ctl);
    expect(out.candidates.find((c) => c.targetSteamId === T(1))!.reasonCodes).not.toContain("MAIN_OBSERVER_ON_IT");
  });
});
