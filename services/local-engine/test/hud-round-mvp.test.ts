import { describe, expect, it } from "vitest";
import type { MatchState, PlayerState } from "@matchframe/contracts";
import { buildHudState, type HudContext } from "../src/live/projection.ts";
import { RoundMvpTracker } from "../src/live/round-mvp.ts";
import { TeamSideTracker } from "../src/live/team-sides.ts";

/** A player as the reconciler keeps it, with the round's stats that matter here. */
function player(i: number, side: "CT" | "T", over: { kills?: number; damage?: number; health?: number; mvps?: number } = {}): PlayerState {
  return {
    steamId: `7656119800000010${i}`,
    playerId: null,
    name: `p${i}`,
    observerSlot: i,
    observerKey: i,
    coach: false,
    side,
    teamId: side === "CT" ? "team-a" : "team-b",
    lifeState: (over.health ?? 100) > 0 ? "alive" : "dead",
    health: over.health ?? 100,
    armor: 80,
    helmet: true,
    defuseKit: null,
    flashed: 0,
    smoked: 0,
    burning: 0,
    money: 3000,
    equipValue: 4000,
    roundKills: over.kills ?? 0,
    roundKillsHeadshot: 0,
    roundDamage: over.damage ?? 0,
    matchStats: { kills: 10, assists: 2, deaths: 8, mvps: over.mvps ?? 1, score: 20 },
    weapons: [],
    activeWeapon: null,
    position: null,
    forward: null,
    positionObservedAtMonotonicMs: null,
    lastSeenMonotonicMs: 0,
    provenance: {},
  };
}

function state(roundNumber: number, roundPhase: MatchState["roundPhase"], players: PlayerState[], ended: number[] = []): MatchState {
  return {
    schemaVersion: 1,
    sessionId: "s",
    epoch: 1,
    sequence: 10,
    time: { receivedAtMonotonicMs: 1000, sourceObservedAtMs: null, matchTimeMs: null, timeUncertaintyMs: null },
    mapName: "de_mirage",
    mapPhase: "live",
    roundNumber,
    roundAttemptId: null,
    roundPhase,
    gamePhase: roundPhase === "freezetime" ? "freezetime" : roundPhase === "over" ? "over" : "live",
    phaseEndsInSec: 20,
    phaseObservedAtMonotonicMs: 1000,
    paused: false,
    teams: {
      CT: { side: "CT", teamId: "team-a", name: null, score: 3, consecutiveRoundLosses: 0, timeoutsRemaining: 3, matchesWonThisSeries: null },
      T: { side: "T", teamId: "team-b", name: null, score: 1, consecutiveRoundLosses: 2, timeoutsRemaining: 3, matchesWonThisSeries: null },
    },
    players,
    bomb: null,
    utility: [],
    roundHistory: ended.map((n) => ({ roundNumber: n, attemptId: `e1.r${n}.hist`, winnerSide: "CT", winnerTeamId: null, reason: "ct_win_elimination", evidence: "measured" })),
    observer: { observedSteamId: null, observedSlot: null, cameraMode: "unknown", confirmedAtMonotonicMs: null, providerSteamId: null, evidence: "unknown" },
    sources: [],
    simulated: false,
  } as MatchState;
}

describe("round MVP kept from the round's end", () => {
  const ct = (over: Parameters<typeof player>[2] = {}) => [player(1, "CT", over), player(2, "CT"), player(3, "CT", { kills: 1, damage: 120 })];
  const t = [player(6, "T", { kills: 2, damage: 210 }), player(7, "T", { health: 0 })];

  it("takes CS2's own round MVP when a player's MVP count goes up at the round's end", () => {
    const m = new RoundMvpTracker();
    m.noteState(state(5, "live", [...ct({ kills: 1, damage: 90 }), ...t]));
    // The round's end: player 1's MVP star (2 kills was the round's winner) and final stats.
    const end = state(6, "over", [...ct({ kills: 2, damage: 180, health: 37, mvps: 2 }), ...t], [5]);
    m.noteState(end);
    m.roundEnded(5, "CT", end);
    // The next round's freeze time resets round stats: the kept round is unchanged.
    m.noteState(state(6, "freezetime", [...ct(), ...t]));
    expect(m.lastRound(5)).toEqual({ roundNumber: 5, winnerSide: "CT", mvp: { steamId: "76561198000000101", kills: 2, damage: 180, health: 37, armor: 80, helmet: true } });
  });

  it("without an MVP star, the winning side's player with the most kills, then damage", () => {
    const m = new RoundMvpTracker();
    m.noteState(state(9, "live", [...ct(), ...t]));
    // The update that ends the round already shows the next freeze time (stats reset): the last live update stands.
    m.noteState(state(9, "live", [player(1, "CT", { kills: 1, damage: 100 }), player(3, "CT", { kills: 1, damage: 140 }), ...t]));
    m.roundEnded(9, "CT", state(10, "freezetime", [...ct(), ...t]));
    expect(m.lastRound(9)?.mvp).toMatchObject({ steamId: "76561198000000103", kills: 1, damage: 140 });
    // A round reported without being seen live (joining a match under way) is not kept.
    m.roundEnded(4, "T", state(10, "freezetime", [...ct(), ...t]));
    expect(m.lastRound(4)).toBeNull();
  });

  it("is projected for the last round on the output's own timeline, with each team's coach", () => {
    const m = new RoundMvpTracker();
    m.noteState(state(5, "live", [...ct(), ...t]));
    const end = state(6, "over", [...ct({ kills: 3, damage: 300, mvps: 2 }), ...t], [5]);
    m.roundEnded(5, "CT", end);
    const coaches: Record<string, { name: string; avatarUrl: string | null }> = { "team-a": { name: "Coach A", avatarUrl: "/assets/coach-a" } };
    const ctx = {
      outputId: "o",
      variant: "live",
      presetId: null,
      timeline: { profile: "delayed", delayMs: 5000 },
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
      coachOf: (id: string) => coaches[id] ?? null,
      lastRound: (n: number) => m.lastRound(n),
    } as HudContext;
    // A delayed timeline still in round 5: no round MVP yet.
    const before = buildHudState(state(5, "live", [...ct(), ...t], [4]), ctx, new TeamSideTracker(), 2000);
    expect(before.lastRound).toBeNull();
    // Its timeline reaches round 5's end: the MVP kept at the live end.
    const after = buildHudState(state(6, "freezetime", [...ct(), ...t], [4, 5]), ctx, new TeamSideTracker(), 2000);
    expect(after.lastRound).toMatchObject({ roundNumber: 5, winnerSide: "CT", mvp: { steamId: "76561198000000101", kills: 3, damage: 300 } });
    // Coaches: from the roster, never a player of the team.
    expect(after.left.coach).toEqual({ name: "Coach A", avatarUrl: "/assets/coach-a" });
    expect(after.right.coach).toBeNull();
    expect(after.left.players.map((p) => p.name)).not.toContain("Coach A");
  });
});
