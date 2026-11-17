import { describe, expect, it } from "vitest";
import type { HudPhase } from "@matchframe/hud-sdk";
import { MVP_CLOCK, mvpClock, mvpUp, type MvpClock } from "./util.ts";

type Step = { phase: HudPhase; sec: number | null; round?: number; paused?: boolean };

/** Feeds the updates in order and says, after each, whether the MVP card is up (setting: `live` s). */
function run(steps: Step[], live = 8, start: MvpClock = MVP_CLOCK): boolean[] {
  let c = start;
  return steps.map((s) => {
    const m = { phase: s.phase, phaseEndsInSec: s.sec, roundNumber: s.round ?? 18, paused: s.paused ?? false };
    c = mvpClock(c, m);
    return mvpUp(c, m, s.sec, live);
  });
}

const over: Step = { phase: "over", sec: 6, round: 17 };

describe("Stage HUD: when the round MVP card is up", () => {
  it("comes in exactly 5 s into freeze time (the freeze length from its first countdown)", () => {
    expect(run([over, { phase: "freezetime", sec: 15 }, { phase: "freezetime", sec: 10.01 }, { phase: "freezetime", sec: 10 }, { phase: "freezetime", sec: 2 }])).toEqual([false, false, false, true, true]);
    // A 20 s freeze time: in at 15 s left.
    expect(run([over, { phase: "freezetime", sec: 20 }, { phase: "freezetime", sec: 15.2 }, { phase: "freezetime", sec: 15 }])).toEqual([false, false, false, true]);
  });

  it("is never up at the round's end, in warm-up or in a pause", () => {
    expect(run([over, { phase: "over", sec: 1, round: 17 }])).toEqual([false, false]);
    expect(run([{ phase: "warmup", sec: 40 }])).toEqual([false]);
    expect(run([over, { phase: "freezetime", sec: 15 }, { phase: "freezetime", sec: 8, paused: true }, { phase: "paused", sec: 8 }])).toEqual([false, false, false, false]);
  });

  it("stays into the live round and goes at the setting's seconds", () => {
    const into = [over, { phase: "freezetime", sec: 15 }, { phase: "freezetime", sec: 1 }] as Step[];
    expect(run([...into, { phase: "live", sec: 115 }, { phase: "live", sec: 107.1 }, { phase: "live", sec: 107 }, { phase: "live", sec: 90 }])).toEqual([false, false, true, true, true, false, false]);
    expect(run([...into, { phase: "live", sec: 115 }, { phase: "live", sec: 110.1 }, { phase: "live", sec: 110 }], 5)).toEqual([false, false, true, true, true, false]);
    expect(run([...into, { phase: "live", sec: 115 }, { phase: "live", sec: 105.1 }, { phase: "live", sec: 105 }], 10)).toEqual([false, false, true, true, true, false]);
    // Never during the plant.
    expect(run([...into, { phase: "bomb", sec: 40 }])).toEqual([false, false, true, false]);
  });

  it("shows straight away on a page opened more than 5 s into freeze time (CS2's 15 s assumed), not before", () => {
    expect(run([{ phase: "freezetime", sec: 8 }])).toEqual([true]);
    expect(run([{ phase: "freezetime", sec: 12 }, { phase: "freezetime", sec: 10 }])).toEqual([false, true]);
    // A page opened late in a round does not bring the card back.
    expect(run([{ phase: "live", sec: 60 }])).toEqual([false]);
  });

  it("hides during a timeout in freeze time and comes back once past the 5 s mark", () => {
    // Called before the 5 s mark: back at 12 s left, in at 10 s left.
    expect(run([over, { phase: "freezetime", sec: 15 }, { phase: "freezetime", sec: 12 }, { phase: "timeout_t", sec: 30 }, { phase: "timeout_t", sec: 1 }, { phase: "freezetime", sec: 12 }, { phase: "freezetime", sec: 10 }])).toEqual([false, false, false, false, false, false, true]);
    // Called after it: up again as soon as the timeout ends.
    expect(run([over, { phase: "freezetime", sec: 15 }, { phase: "freezetime", sec: 8 }, { phase: "timeout_ct", sec: 30 }, { phase: "freezetime", sec: 8 }])).toEqual([false, false, true, false, true]);
  });
});
