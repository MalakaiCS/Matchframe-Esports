import { describe, expect, it } from "vitest";
import type { OwnershipState } from "@matchframe/contracts";
import type { SyntheticPlayer } from "@matchframe/cs2-state";
import { Director } from "../src/index.ts";
import { CT, facingTo, player, Sim, T } from "./helpers.ts";

const armed: OwnershipState = { owner: "director", generation: 2, holder: "director", acquiredAtMonotonicMs: 0, leaseExpiresAtMonotonicMs: null, manualSticky: false, emergencyStopped: false };
const ctl = { ownership: armed, adapterAvailable: true, inputFresh: true, pendingCommand: false };

/** Everyone spread out: nothing imminent by distance and facing. */
function quiet(extra: Partial<Record<string, Partial<SyntheticPlayer>>> = {}): SyntheticPlayer[] {
  const spots: [string, "T" | "CT", number, number][] = [
    [T(1), "T", -3000, -3000],
    [T(2), "T", -3000, 0],
    [T(3), "T", -3000, 3000],
    [T(4), "T", 0, -3000],
    [T(5), "T", 0, 3000],
    [CT(6), "CT", 3000, -3000],
    [CT(7), "CT", 3000, 0],
    [CT(8), "CT", 3000, 3000],
    [CT(9), "CT", 6000, -3000],
    [CT(0), "CT", 6000, 3000],
  ];
  return spots.map(([id, side, x, y], i) => player(id, side, (i + 1) % 10, { x, y, z: 0 }, { x: side === "T" ? -1 : 1, y: 0, z: 0 }, extra[id] ?? {}));
}

describe("learned imminence (the demo-trained POV model)", () => {
  it("blends the model's probability into imminence and leaves other players on the baseline", () => {
    const sim = new Sim();
    const director = new Director();
    director.setMode("automatic");
    const base = director.evaluate(sim.push(quiet(), { observed: T(2) }), sim.now, ctl);
    const baseOf = (id: string) => base.candidates.find((c) => c.targetSteamId === id)!.components.imminence;

    director.setLearnedImminence({ predict: () => new Map([[T(4), 0.9], [CT(7), 0.1]]), weight: 0.5, ref: 0.5 });
    expect(director.learnedImminenceOn).toBe(true);
    const out = director.evaluate(sim.push(quiet(), { observed: T(2) }), sim.now, ctl);
    const of = (id: string) => out.candidates.find((c) => c.targetSteamId === id)!.components.imminence;
    // 0.5 · baseline + 0.5 · min(1, p / 0.5)
    expect(of(T(4))).toBeCloseTo(0.5 * baseOf(T(4)) + 0.5, 3);
    expect(of(CT(7))).toBeCloseTo(0.5 * baseOf(CT(7)) + 0.5 * 0.2, 3);
    expect(of(T(1))).toBeCloseTo(baseOf(T(1)), 6);
    // The best alternative to the shot on air is now the player the model expects a kill from.
    const alternatives = out.candidates.filter((c) => c.valid && c.shotClass === "pov" && c.targetSteamId !== T(2)).sort((a, b) => b.utility - a.utility);
    expect(alternatives[0]!.targetSteamId).toBe(T(4));
  });

  it("a model that throws never stops the director", () => {
    const sim = new Sim();
    const director = new Director();
    director.setMode("automatic");
    director.setLearnedImminence({
      predict: () => {
        throw new Error("broken model");
      },
      weight: 0.5,
      ref: 0.5,
    });
    const out = director.evaluate(sim.push(quiet(), { observed: T(2) }), sim.now, ctl);
    expect(out.candidates.length).toBeGreaterThan(0);
    director.setLearnedImminence(null);
    expect(director.learnedImminenceOn).toBe(false);
  });
});

describe("multi-frag awareness", () => {
  /** T1 just got a kill with CT7 900 units away; `duel` puts T4 and CT9 face to face (a fight coming). */
  function afterKill(observed: string, duel: boolean) {
    const sim = new Sim();
    const director = new Director();
    director.setMode("automatic");
    const layout = (kills: number) => {
      const ps = quiet({ [T(1)]: { roundKills: kills } });
      const at = (id: string, x: number, y: number, face?: { x: number; y: number }) => {
        const p = ps.find((q) => q.steamId === id)!;
        p.position = { x, y, z: 0 };
        if (face) p.forward = facingTo(p.position, { ...face, z: 0 });
      };
      at(T(1), 0, 0, { x: -100, y: 0 });
      at(CT(7), 900, 0, { x: 2000, y: 0 });
      if (duel) {
        at(T(4), 4000, 4000, { x: 4250, y: 4000 });
        at(CT(9), 4250, 4000, { x: 4000, y: 4000 });
      }
      return ps;
    };
    director.evaluate(sim.push(layout(0), { observed }), sim.now, ctl);
    const out = director.evaluate(sim.push(layout(1), { observed }), sim.now, ctl);
    return { out, t1: out.candidates.find((c) => c.targetSteamId === T(1))! };
  }

  it("marks the player who just got a kill near enemies when the shot on air is quiet", () => {
    const { t1 } = afterKill(T(2), false);
    expect(t1.reasonCodes).toContain("MULTI_FRAG_CHANCE");
  });

  it("does not pull the camera away from a POV that is about to fight", () => {
    const { out, t1 } = afterKill(T(4), true);
    expect(out.interactions.byPlayer.get(T(4))!.imminence).toBeGreaterThanOrEqual(0.5);
    expect(t1.reasonCodes).not.toContain("MULTI_FRAG_CHANCE");
  });

  it("stays on the player who just got a kill when they are on air", () => {
    const { t1 } = afterKill(T(1), true);
    expect(t1.reasonCodes).toContain("MULTI_FRAG_CHANCE");
  });
});
