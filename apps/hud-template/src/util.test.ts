import { describe, expect, it } from "vitest";
import { demoState } from "./demo.ts";
import { clock, grenadesOf, lossBonus, money, roundLabel, setting, sum, teamName, utilitySummary, weaponId } from "./util.ts";

describe("Pro CS2 HUD helpers", () => {
  const state = demoState();

  it("maps weapon names to icon ids", () => {
    expect(weaponId("weapon_ak47")).toBe("ak47");
    expect(weaponId("smokegrenade")).toBe("smokegrenade");
    expect(weaponId(null)).toBe("");
  });

  it("reads settings with type-checked fallbacks", () => {
    const s = { ...state, settings: { teamNames: "short", panelOpacity: "high", showRadar: false } };
    expect(setting(s, "teamNames", "full")).toBe("short");
    expect(setting(s, "panelOpacity", 0.83)).toBe(0.83);
    expect(setting(s, "showRadar", true)).toBe(false);
    expect(setting(s, "missing", 340)).toBe(340);
    expect(teamName(s, s.left)).toBe("NRL");
    expect(teamName(state, state.left)).toBe("Northern Lights");
  });

  it("counts team utility, with two flashbangs per player when held", () => {
    const g = utilitySummary(state.left.players);
    expect(g.smokes).toBe(4);
    expect(g.inc).toBe(4);
    expect(g.flashes).toBe(7);
    expect(grenadesOf(state.left.players[0]!).filter((x) => weaponId(x.name) === "flashbang")).toHaveLength(2);
  });

  it("shows the loss bonus only when the game reports consecutive losses", () => {
    expect(lossBonus(state.right)).toBe(2400);
    expect(lossBonus({ ...state.right, consecutiveRoundLosses: 7 })).toBe(3400);
    expect(lossBonus({ ...state.right, consecutiveRoundLosses: null })).toBeNull();
  });

  it("formats money, clocks and rounds", () => {
    expect(money(12350)).toBe("$12,350");
    expect(money(null)).toBe("—");
    expect(sum(state.left.players, (p) => p.money)).toBe(state.left.players.reduce((a, p) => a + (p.money ?? 0), 0));
    expect(sum([], (p) => p.money)).toBeNull();
    expect(clock(74.2)).toBe("1:15");
    expect(clock(null)).toBe("–:––");
    expect(roundLabel(state)).toBe("Round 17/24");
    expect(roundLabel({ ...state, match: { ...state.match, roundNumber: 27 } })).toBe("OT 1 (3/6)");
  });
});
