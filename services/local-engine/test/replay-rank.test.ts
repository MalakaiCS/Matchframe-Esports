import { describe, expect, it } from "vitest";
import type { ReplayPlay } from "@matchframe/replay-agent";
import { clipScore, CUT_MS, MIN_LEAD_MS, NO_FACTS, nextReplay, replayWallMs } from "../src/replay/rank.ts";

const play = (p: Partial<ReplayPlay>): ReplayPlay => ({ kind: "shown", killer: { steamId: "1", name: "haze" }, victims: ["kite"], kills: 1, weapon: "ak47", headshot: false, ...p });

describe("ranking a round's clips", () => {
  it("scores more kills, a clutch, kills not seen live, and special weapons higher, with the reasons", () => {
    const single = clipScore(play({}), NO_FACTS).score;
    expect(clipScore(play({ kills: 2, victims: ["a", "b"] }), NO_FACTS).score).toBeGreaterThan(2 * single);
    expect(clipScore(play({ kind: "missed" }), NO_FACTS)).toEqual({ score: single + 8, reasons: ["not seen live"] });
    expect(clipScore(play({ weapon: "weapon_knife_karambit" }), NO_FACTS).reasons).toEqual(["knife"]);
    const ace = clipScore(play({ kills: 5, kind: "missed", weapon: "awp", headshot: true }), { opening: true, closing: true, clutchVersus: null, spanMs: 2000 });
    expect(ace.reasons).toEqual(["ace", "not seen live", "AWP", "headshot", "opening kill", "won the round", "fast"]);
    const clutch = clipScore(play({ kind: "big_play", kills: 3, victims: ["a", "b", "c"] }), { ...NO_FACTS, clutchVersus: 3 });
    expect(clutch.reasons).toContain("won 1v3");
    // A won 1v3 beats a plain 4K shown live.
    expect(clutch.score).toBeGreaterThan(clipScore(play({ kills: 4 }), NO_FACTS).score);
  });

  it("picks the best clip that fits the time left, shortening its lead-up when that makes it fit", () => {
    const c = [
      { id: "low", score: 10, playMs: 5000, leadMs: 4000 },
      { id: "best", score: 50, playMs: 9000, leadMs: 5000 },
      { id: "mid", score: 30, playMs: 6000, leadMs: null },
    ];
    expect(nextReplay(c, 20_000, 100)).toEqual({ id: "best", playMs: 9000 });
    // 7 s left: the best fits with its lead-up cut to 3 s (it can go down to 2 s).
    expect(nextReplay(c, 7000, 100)).toEqual({ id: "best", playMs: 7000 - CUT_MS });
    // Too little for the best even at its shortest lead-up (9000 - (5000 - 2000) = 6000): the next best that fits.
    expect(nextReplay(c, 6000 + CUT_MS - 1, 100)).toEqual({ id: "low", playMs: 5000 });
    // Slow motion takes longer: at 50 % nothing fits in 5 s except a shortened low (5000 - 2000 = 3000 ms → 6.6 s): none.
    expect(nextReplay(c, 5000, 50)).toBeNull();
    expect(replayWallMs(3000, 50)).toBe(6000 + CUT_MS);
    expect(MIN_LEAD_MS).toBe(2000);
  });
});
