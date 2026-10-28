import { describe, expect, it } from "vitest";
import type { Vec3 } from "@matchframe/contracts";
import { computePair, DEFAULT_DIRECTOR_CONFIG, StateHistory } from "../src/index.ts";
import { CT, player, Sim, T } from "./helpers.ts";

/** T walks along +x towards a corner at x = 200 at 250 units/s; CT waits at x = 900 behind it. */
function corner(steps: number) {
  const sim = new Sim();
  const history = new StateHistory();
  let state = null as ReturnType<Sim["push"]> | null;
  for (let i = 0; i <= steps; i++) {
    const tx = -200 + i * 25;
    state = sim.push([player(T(1), "T", 1, { x: tx, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }), player(CT(1), "CT", 6, { x: 900, y: 0, z: 0 }, { x: -1, y: 0, z: 0 })], { dtMs: 100 });
    history.push(state);
  }
  return { state: state!, sim, history };
}
const pair = (state: ReturnType<Sim["push"]>, now: number, history: StateHistory, los: ((a: Vec3, b: Vec3) => boolean) | null) => {
  const t = state.players.find((p) => p.steamId === T(1))!;
  const ct = state.players.find((p) => p.steamId === CT(1))!;
  const spatial = { levelAt: () => null, regionsAt: () => [], ...(los ? { hasVisibilityGeometry: true, lineOfSight: los } : {}) };
  return computePair(t, ct, now, DEFAULT_DIRECTOR_CONFIG, spatial, history);
};

describe("sightlines from the map's geometry", () => {
  it("predicts the fight as a sightline is about to open, before the players see each other", () => {
    const { state, sim, history } = corner(4); // T at x = -100, moving +x
    // The corner opens once the T's eye passes x = 200.
    const p = pair(state, sim.now, history, (a) => a.x >= 200);
    expect(p.sight).toEqual({ now: false, soonSec: 1.2 });
    expect(p.contact["2"]).toBeGreaterThanOrEqual(0.8);
    const walled = pair(state, sim.now, history, () => false);
    expect(walled.sight).toEqual({ now: false, soonSec: null });
    expect(p.contact["2"]!).toBeGreaterThan(walled.contact["2"]! + 0.2);
    expect(walled.contact["0.5"]).toBeLessThan(0.25);
  });

  it("treats players in each other's sight, looking at each other, as fighting now", () => {
    const { state, sim, history } = corner(4);
    const p = pair(state, sim.now, history, () => true);
    expect(p.sight).toEqual({ now: true, soonSec: null });
    expect(p.contact["0.5"]).toBeGreaterThan(0.7);
  });

  it("keeps the old estimate without geometry", () => {
    const { state, sim, history } = corner(4);
    expect(pair(state, sim.now, history, null).sight).toBeNull();
  });
});
