import { describe, expect, it } from "vitest";
import type { Match, MatchState } from "@matchframe/contracts";
import { SideTeams } from "../src/live/side-teams.ts";

const match = { id: "m1", teamAId: "lite", teamBId: "nl", format: { bestOf: 3, regulationRounds: 24, overtimeEnabled: true, overtimeRounds: 6 } } as unknown as Match;
const TEAMS: Record<string, { name: string; shortName: string }> = { lite: { name: "LITE Esports", shortName: "LITE" }, nl: { name: "Northern Lights", shortName: "NL" } };

/** Five players a side; `rostered` gives some of them a team id (their SteamID64 is on a roster). */
function state(o: { round?: number; ctNames?: string | null; tNames?: string | null; ctIds?: (string | null)[]; tIds?: (string | null)[]; swapPlayers?: boolean; teamIds?: { CT?: string | null; T?: string | null } } = {}): MatchState {
  const a = ["a1", "a2", "a3", "a4", "a5"];
  const b = ["b1", "b2", "b3", "b4", "b5"];
  const [ct, t] = o.swapPlayers ? [b, a] : [a, b];
  const players = [
    ...ct.map((steamId, i) => ({ steamId, side: "CT", coach: false, teamId: o.ctIds?.[i] ?? null })),
    ...t.map((steamId, i) => ({ steamId, side: "T", coach: false, teamId: o.tIds?.[i] ?? null })),
  ];
  return {
    mapName: "de_mirage",
    roundNumber: o.round ?? 1,
    players,
    teams: { CT: { name: o.ctNames ?? null, teamId: o.teamIds?.CT ?? null }, T: { name: o.tNames ?? null, teamId: o.teamIds?.T ?? null } },
  } as unknown as MatchState;
}

const make = (startingCt: string | null = null) => new SideTeams({ team: (id) => TEAMS[id] ?? null, startingCt: () => startingCt });

describe("the active match's teams on the game's sides", () => {
  it("keeps the game data's own identification, and fills the other side with the other team", () => {
    expect(make().resolve(state({ teamIds: { CT: "lite", T: "nl" } }), match)).toEqual({ CT: "lite", T: "nl", how: "roster" });
    expect(make().resolve(state({ teamIds: { T: "lite" } }), match)).toEqual({ CT: "nl", T: "lite", how: "roster" });
  });

  it("matches CS2's team names to a team's name or short name", () => {
    expect(make().resolve(state({ tNames: "LITE" }), match)).toEqual({ CT: "nl", T: "lite", how: "names" });
    expect(make().resolve(state({ ctNames: "northern lights" }), match)).toEqual({ CT: "nl", T: "lite", how: "names" });
  });

  it("uses a few rostered players when they agree, but not when both sides point to the same team", () => {
    expect(make().resolve(state({ tIds: ["nl", null, null] }), match)).toEqual({ CT: "lite", T: "nl", how: "players" });
    expect(make().resolve(state({ ctIds: ["lite"], tIds: ["lite"] }), match).how).toBe("assumed");
  });

  it("takes the starting side from the veto, then follows the players across halftime", () => {
    const s = make("nl");
    expect(s.resolve(state({ round: 3 }), match)).toEqual({ CT: "nl", T: "lite", how: "veto" });
    // Second half: the same players are now T, and NL stays with them.
    expect(s.resolve(state({ round: 13, swapPlayers: true }), match)).toEqual({ CT: "lite", T: "nl", how: "veto" });
  });

  it("assumes Team 1 on CT without anything else to go on; Swap teams flips it and keeps following the players", () => {
    const s = make();
    expect(s.resolve(state(), match)).toEqual({ CT: "lite", T: "nl", how: "assumed" });
    s.swap();
    expect(s.resolve(state(), match)).toEqual({ CT: "nl", T: "lite", how: "swapped" });
    expect(s.resolve(state({ round: 13, swapPlayers: true }), match)).toEqual({ CT: "lite", T: "nl", how: "swapped" });
    s.swap();
    expect(s.resolve(state({ round: 14, swapPlayers: true }), match)).toEqual({ CT: "nl", T: "lite", how: "assumed" });
  });

  it("Swap teams also flips teams recognised from the game data, is kept per match and map, and survives a restart", () => {
    const saved: (string | null)[] = [];
    let stored: string | null = null;
    const s = new SideTeams({ team: (id) => TEAMS[id] ?? null, startingCt: () => null, loadSwap: () => stored, saveSwap: (k) => (saved.push(k), (stored = k)) });
    expect(s.swap()).toBe(false);
    expect(s.resolve(state({ teamIds: { CT: "lite", T: "nl" } }), match)).toEqual({ CT: "lite", T: "nl", how: "roster" });
    expect(s.swap()).toBe(true);
    expect(saved).toEqual(["m1|de_mirage"]);
    expect(s.resolve(state({ teamIds: { CT: "lite", T: "nl" } }), match)).toEqual({ CT: "nl", T: "lite", how: "swapped" });
    // Another map: the swap was for de_mirage only.
    expect(s.resolve({ ...state({ teamIds: { CT: "lite", T: "nl" } }), mapName: "de_nuke" } as MatchState, match).how).toBe("roster");
    // A restart reads it back.
    const again = new SideTeams({ team: (id) => TEAMS[id] ?? null, startingCt: () => null, loadSwap: () => stored });
    expect(again.resolve(state({ teamIds: { CT: "lite", T: "nl" } }), match).how).toBe("swapped");
    again.clearSwap();
    expect(again.resolve(state({ teamIds: { CT: "lite", T: "nl" } }), match).how).toBe("roster");
  });

  it("fills a state copy for the HUDs, and leaves the state alone without an active match or players", () => {
    const s = make();
    const st = state();
    const out = s.apply(st, match);
    expect([out.teams.CT.teamId, out.teams.T.teamId]).toEqual(["lite", "nl"]);
    expect(st.teams.CT.teamId).toBeNull();
    expect(s.apply(st, null)).toBe(st);
    expect(s.status()).toEqual({ CT: null, T: null, how: null });
  });
});
