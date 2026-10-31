import { describe, expect, it } from "vitest";
import type { MatchState } from "@matchframe/contracts";
import type { ReplayPlay } from "@matchframe/replay-agent";
import type { Engine } from "../src/app.ts";
import { AutoReplay } from "../src/replay/auto.ts";
import { clipScore, CUT_MS, fitReplay, MIN_LEAD_MS, NO_FACTS, nextReplay, planBreak, replayWallMs, SWITCH_MS } from "../src/replay/rank.ts";

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

  it("chooses a break's replays as nextReplay would, then puts them in round order (or keeps them best first)", () => {
    // Ranked the other way round from when they happened in the round.
    const c = [
      { id: "early", score: 10, playMs: 4000, leadMs: 2500, at: 1000 },
      { id: "middle", score: 20, playMs: 4000, leadMs: 2500, at: 5000 },
      { id: "late", score: 30, playMs: 4000, leadMs: 2500, at: 9000 },
      { id: "unknown", score: 25, playMs: 4000, leadMs: null, at: null },
    ];
    expect(planBreak(c, 30_000, 100, 3).map((p) => p.id)).toEqual(["middle", "late", "unknown"]);
    expect(planBreak(c, 30_000, 100, 4).map((p) => p.id)).toEqual(["early", "middle", "late", "unknown"]);
    expect(planBreak(c, 30_000, 100, 3, "best").map((p) => p.id)).toEqual(["late", "unknown", "middle"]);
    // One cut in and out for the break, a switch between two clips: three 4 s clips take 12 s + 600 + 2 × 400 ms.
    const three = 3 * 4000 + CUT_MS + 2 * SWITCH_MS;
    expect(planBreak(c, three, 100, 3).map((p) => [p.id, p.playMs])).toEqual([
      ["middle", 4000],
      ["late", 4000],
      ["unknown", 4000],
    ]);
    // 0.5 s less: the last chosen has its lead-up shortened to the 2 s it can go down to.
    expect(planBreak(c, three - 500, 100, 3)).toEqual([
      { id: "middle", playMs: 3500, leadMs: MIN_LEAD_MS },
      { id: "late", playMs: 4000, leadMs: 2500 },
      { id: "unknown", playMs: 4000, leadMs: null },
    ]);
    // 1 s less: no third clip fits, even shortened.
    expect(planBreak(c, three - 1000, 100, 3).map((p) => p.id)).toEqual(["late", "unknown"]);
    // In slow motion (50 %) each takes twice as long: one fits in the same time.
    expect(planBreak(c, three, 50, 3).map((p) => p.id)).toEqual(["late"]);
    expect(planBreak(c, 1000, 100, 3)).toEqual([]);
    expect(fitReplay({ playMs: 4000, leadMs: 2500 }, 4000 + SWITCH_MS, 100, SWITCH_MS)).toBe(4000);
    expect(fitReplay({ playMs: 4000, leadMs: 2500 }, 3500 + SWITCH_MS, 100, SWITCH_MS)).toBe(3500);
    expect(fitReplay({ playMs: 4000, leadMs: 2500 }, 3500 + SWITCH_MS, 100, SWITCH_MS + 1)).toBeNull();
  });
});

/** The automatic replays' clock, on its own: a stand-in engine with settings and a monotonic clock. */
function breakClock(settings: Record<string, unknown> = {}) {
  let now = 1_000_000;
  const stored = new Map<string, unknown>([["replay.auto", settings]]);
  const e = { settings: { get: (k: string, d: unknown) => stored.get(k) ?? d, set: (k: string, v: unknown) => stored.set(k, v) }, now: () => now } as unknown as Engine;
  const a = new AutoReplay(e) as unknown as { cutBackAt(s: MatchState, wentLive: number | null): number; learnRoundTime(s: MatchState): void; getStatus(): unknown };
  const state = (p: Partial<MatchState>): MatchState => ({ roundPhase: "over", gamePhase: "over", phaseEndsInSec: 7, phaseObservedAtMonotonicMs: now, bomb: null, ...p }) as MatchState;
  return {
    /** How long from now until the cut back to live must start (ms). */
    left: (p: Partial<MatchState>, wentLive: number | null = null) => a.cutBackAt(state(p), wentLive) - now,
    learn: (p: Partial<MatchState>) => a.learnRoundTime(state(p)),
    set: (patch: Record<string, unknown>) => stored.set("replay.auto", { ...(stored.get("replay.auto") as object), ...patch }),
    tick: (ms: number) => (now += ms),
    now: () => now,
  };
}

describe("when a break's replays must end", () => {
  it("by 1:50 on the next round's clock: before it is live, freeze time's end plus the round time (1:55) less 1:50; live, by its clock", () => {
    const c = breakClock();
    // Round over, 7 s of it left, then 15 s of freeze time assumed, then 5 s of the next round, less the quarter second the cut back starts early.
    expect(c.left({ roundPhase: "over", gamePhase: "over", phaseEndsInSec: 7 })).toBe(7000 + 15000 + 5000 - 250);
    expect(c.left({ roundPhase: "freezetime", gamePhase: "freezetime", phaseEndsInSec: 12 })).toBe(12000 + 5000 - 250);
    expect(c.left({ roundPhase: "freezetime", gamePhase: "timeout_ct", phaseEndsInSec: 30 })).toBe(30000 + 5000 - 250);
    expect(c.left({ roundPhase: "live", gamePhase: "live", phaseEndsInSec: 113 })).toBe(3000 - 250);
    expect(c.left({ roundPhase: "live", gamePhase: "live", phaseEndsInSec: 109 })).toBe(-1000 - 250);
    // No round clock in the game data: from when the round went live.
    expect(c.left({ roundPhase: "live", gamePhase: "live", phaseEndsInSec: null, phaseObservedAtMonotonicMs: null }, c.now() - 1000)).toBe(5000 - 1000 - 250);
    // The bomb planted or being defused (the clock is gone), or the next round already over: now.
    expect(c.left({ roundPhase: "live", gamePhase: "bomb", phaseEndsInSec: 40 })).toBe(0);
    expect(c.left({ roundPhase: "live", gamePhase: "defuse", phaseEndsInSec: 30 })).toBe(0);
    expect(c.left({ roundPhase: "live", gamePhase: "live", phaseEndsInSec: null, bomb: { state: "planted" } as MatchState["bomb"] })).toBe(0);
    expect(c.left({ roundPhase: "over", gamePhase: "over", phaseEndsInSec: 7 }, c.now() - 3000)).toBe(0);
    // Another time on the clock.
    c.set({ cutBackClockSec: 100 });
    expect(c.left({ roundPhase: "live", gamePhase: "live", phaseEndsInSec: 113 })).toBe(13000 - 250);
  });

  it("learns the round time from the clock when a round goes live", () => {
    const c = breakClock();
    // A live reading not straight after freeze time (the engine started mid-round) teaches nothing.
    c.learn({ roundPhase: "live", gamePhase: "live", phaseEndsInSec: 80 });
    expect(c.left({ roundPhase: "freezetime", gamePhase: "freezetime", phaseEndsInSec: 10 })).toBe(10000 + 5000 - 250);
    // 1:40 rounds: the clock reads 1:50 before the round starts, so the cut back is before it.
    c.learn({ roundPhase: "freezetime", gamePhase: "freezetime", phaseEndsInSec: 1 });
    c.learn({ roundPhase: "live", gamePhase: "live", phaseEndsInSec: 99.8 });
    expect(c.left({ roundPhase: "freezetime", gamePhase: "freezetime", phaseEndsInSec: 10 })).toBe(10000 - 10000 - 250);
  });

  it("before the round starts (the old setting): shortly before freeze time ends, and now once it is live", () => {
    const c = breakClock({ cutBack: "before_round" });
    expect(c.left({ roundPhase: "over", gamePhase: "over", phaseEndsInSec: 7 })).toBe(7000 + 15000 - 1500);
    expect(c.left({ roundPhase: "freezetime", gamePhase: "freezetime", phaseEndsInSec: 12 })).toBe(12000 - 1500);
    expect(c.left({ roundPhase: "live", gamePhase: "live", phaseEndsInSec: 114 })).toBe(0);
  });

  it("gives the planner the longer time: four 6 s clips fit by 1:50, three before the round starts", () => {
    const clips = [1, 2, 3, 4].map((n) => ({ id: `c${n}`, score: n, playMs: 6000, leadMs: 4000, at: n }));
    const clock = breakClock().left({ roundPhase: "over", gamePhase: "over", phaseEndsInSec: 7 });
    const before = breakClock({ cutBack: "before_round" }).left({ roundPhase: "over", gamePhase: "over", phaseEndsInSec: 7 });
    expect(planBreak(clips, clock, 100, 4).map((p) => [p.id, p.playMs])).toEqual([
      ["c1", 6000],
      ["c2", 6000],
      ["c3", 6000],
      ["c4", 6000],
    ]);
    expect(planBreak(clips, before, 100, 4).map((p) => p.id)).toEqual(["c2", "c3", "c4"]);
  });
});
