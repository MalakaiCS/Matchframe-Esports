import { describe, expect, it } from "vitest";
import type { MatchState } from "@matchframe/contracts";
import { chaseMoment } from "../src/index.ts";
import { CT, player, Sim, T } from "./helpers.ts";

const bombAt = { x: 500, y: 500, z: 0 };
function state(observed: string, patch: Partial<MatchState> = {}): MatchState {
  const sim = new Sim();
  const s = sim.push([player(T(1), "T", 1, { x: 480, y: 500, z: 0 }), player(T(2), "T", 2, { x: 0, y: 0, z: 0 }), player(CT(1), "CT", 6, { x: 520, y: 510, z: 0 }), player(CT(2), "CT", 7, { x: 2000, y: 0, z: 0 })], { observed });
  return { ...s, ...patch };
}
const bomb = (st: "planting" | "defusing" | "planted", carrier: string | null) => ({ state: st, position: bombAt, carrierSteamId: carrier, countdownSec: null, countdownObservedAtMonotonicMs: null, site: "A" as const, evidence: "measured" as const });

describe("chaseMoment", () => {
  it("is the planter while the bomb is being planted, nobody else", () => {
    expect(chaseMoment(state(T(1), { bomb: bomb("planting", T(1)) }))).toBe("BOMB_PLANT");
    expect(chaseMoment(state(T(2), { bomb: bomb("planting", T(1)) }))).toBeNull();
  });

  it("is the defuser while the bomb is being defused: the reported player, or a CT on the bomb", () => {
    expect(chaseMoment(state(CT(1), { bomb: bomb("defusing", CT(1)) }))).toBe("BOMB_DEFUSE");
    expect(chaseMoment(state(CT(1), { bomb: bomb("defusing", null) }))).toBe("BOMB_DEFUSE");
    expect(chaseMoment(state(CT(2), { bomb: bomb("defusing", null) }))).toBeNull();
    expect(chaseMoment(state(T(1), { bomb: bomb("defusing", null) }))).toBeNull();
  });

  it("is an alive player of the team that won the round that just ended", () => {
    const s = state(CT(1));
    const won = { roundPhase: "over" as const, roundHistory: [{ roundNumber: s.roundNumber!, attemptId: "a", winnerSide: "CT" as const, winnerTeamId: null, reason: "ct_win_elimination" as const, evidence: "measured" as const }] };
    expect(chaseMoment({ ...s, ...won })).toBe("ROUND_WON");
    expect(chaseMoment({ ...state(T(1)), ...won })).toBeNull();
    // An old round's result doesn't count.
    expect(chaseMoment({ ...s, ...won, roundHistory: [{ ...won.roundHistory[0]!, roundNumber: s.roundNumber! - 3 }] })).toBeNull();
    // Not while the round is still live.
    expect(chaseMoment({ ...s, ...won, roundPhase: "live" })).toBeNull();
  });

  it("is nothing for a dead player, in a gunfight or with nobody spectated", () => {
    const s = state(T(1), { bomb: bomb("planting", T(1)) });
    expect(chaseMoment({ ...s, players: s.players.map((p) => (p.steamId === T(1) ? { ...p, lifeState: "dead" as const } : p)) })).toBeNull();
    expect(chaseMoment(state(T(1), { bomb: bomb("planted", null) }))).toBeNull();
    expect(chaseMoment({ ...s, observer: { ...s.observer, observedSteamId: null } })).toBeNull();
  });
});

describe("chaseMoment in a clutch", () => {
  const clutch = (distance: number) => {
    const sim = new Sim();
    const s = sim.push([player(T(1), "T", 1, { x: 0, y: 0, z: 0 }), player(T(2), "T", 2, { x: 50, y: 0, z: 0 }, null, { health: 0 }), player(CT(1), "CT", 6, { x: distance, y: 0, z: 0 }), player(CT(2), "CT", 7, { x: distance + 300, y: 0, z: 0 })], { observed: T(1) });
    return s;
  };

  it("shows the last player alive from behind while no opponent is near, with a margin so it doesn't flicker", () => {
    expect(chaseMoment(clutch(2500))).toBe("CLUTCH_LEADUP");
    expect(chaseMoment(clutch(1600))).toBeNull();
    // Already behind them: stays until an opponent is closer still.
    expect(chaseMoment(clutch(1600), { chasing: true })).toBe("CLUTCH_LEADUP");
    expect(chaseMoment(clutch(1200), { chasing: true })).toBeNull();
  });

  it("is not a clutch while a teammate lives, or after the round", () => {
    const s = clutch(2500);
    const withMate = { ...s, players: s.players.map((p) => (p.steamId === T(2) ? { ...p, lifeState: "alive" as const, health: 100 } : p)) };
    expect(chaseMoment(withMate)).toBeNull();
    expect(chaseMoment({ ...s, roundPhase: "over" })).toBeNull();
  });
});
