import { describe, expect, it } from "vitest";
import type { HudReplayClip } from "@matchframe/hud-sdk";
import { clipColor, clipVictims, isReplayLayer, teamMonogram } from "./replay.ts";

const clip = (over: Partial<HudReplayClip> = {}): HudReplayClip => ({ id: "c", roundNumber: 5, label: "", player: { steamId: "1", name: "nova" }, team: { key: "left", name: "Northern Lights", shortName: "nrl", logoUrl: null, color: null }, side: "T", weapon: null, headshot: false, victims: ["a", "b"], kills: 2, multiKill: "2K", clutchVersus: null, ...over });

describe("replay graphic helpers", () => {
  it("draws only on the replay page: the replay entry point, ?layer=replay or the demo, never the live HUD", () => {
    expect(isReplayLayer("?output=hud:matchframe.vector&variant=replay&t=x")).toBe(true);
    expect(isReplayLayer("?output=hud:matchframe.vector&variant=live&t=x")).toBe(false);
    expect(isReplayLayer("?variant=compact")).toBe(false);
    expect(isReplayLayer("?layer=replay")).toBe(true);
    expect(isReplayLayer("?demo=replay&play=ace")).toBe(true);
    expect(isReplayLayer("")).toBe(false);
  });

  it("colours the player by their team's colour, else the side they had in that round", () => {
    const colors = { ct: "#00f", t: "#f00" };
    expect(clipColor(clip(), colors, "#888")).toBe("#f00");
    expect(clipColor(clip({ side: "CT" }), colors, "#888")).toBe("#00f");
    expect(clipColor(clip({ side: null }), colors, "#888")).toBe("#888");
    expect(clipColor(clip({ team: { key: "left", name: "x", shortName: "x", logoUrl: null, color: "#0a0" } }), colors, "#888")).toBe("#0a0");
  });

  it("says who died, or for a clutch, that the round was won", () => {
    expect(clipVictims(clip())).toBe("a, b");
    expect(clipVictims(clip({ victims: [], clutchVersus: 3 }))).toBe("Won the round");
    expect(clipVictims(clip({ victims: [] }))).toBeNull();
    expect(teamMonogram(clip().team!)).toBe("NRL");
  });
});
