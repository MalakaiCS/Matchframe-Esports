import { describe, expect, it } from "vitest";
import { scoreboardPhase } from "./util.ts";

describe("Stage HUD: the scoreboard only in timeouts and pauses", () => {
  it("keeps the player cards in freeze time, half time, warm-up and a round", () => {
    for (const phase of ["freezetime", "halftime", "warmup", "live", "bomb", "defuse", "over"] as const) expect(scoreboardPhase(phase)).toBe(false);
  });

  it("shows the scoreboard in a tactical timeout of either side and in a pause", () => {
    expect(scoreboardPhase("timeout_ct")).toBe(true);
    expect(scoreboardPhase("timeout_t")).toBe(true);
    expect(scoreboardPhase("paused")).toBe(true);
  });

  it("shows it when the match is flagged paused, whatever the phase", () => {
    expect(scoreboardPhase("freezetime", true)).toBe(true);
    expect(scoreboardPhase("live", true)).toBe(true);
    expect(scoreboardPhase("freezetime", false)).toBe(false);
  });
});
