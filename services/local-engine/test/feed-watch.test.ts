import { afterEach, describe, expect, it, vi } from "vitest";
import { FEED_GAP_MS, FeedWatch, LOOP_STALL_MS } from "../src/live/feed-watch.ts";

afterEach(() => vi.useRealTimers());

describe("watching CS2's game data and the engine's event loop", () => {
  it("records a pause in the game data with the round and phase it stopped in", () => {
    let phase = "freezetime";
    const issues: string[] = [];
    const w = new FeedWatch({ now: () => 0, round: () => ({ round: 6, phase }), onIssue: (k, ms, r, p) => issues.push(`${k} ${ms} r${r} ${p}`) });
    for (let t = 0; t <= 1000; t += 30) w.notePacket(t);
    phase = "live";
    w.notePacket(1020);
    // Eight seconds of nothing after the round went live.
    w.notePacket(9320);
    w.notePacket(9350);
    const s = w.summary();
    expect(s.packets).toBe(37);
    expect(s.gaps).toHaveLength(1);
    expect(s.longestGap).toMatchObject({ gapMs: 8300, round: 6, phase: "live" });
    expect(issues).toEqual(["gap 8300 r6 live"]);
    w.notePacket(9350 + FEED_GAP_MS - 1);
    expect(w.summary().gaps).toHaveLength(1);
  });

  it("records the event loop stalling", () => {
    vi.useFakeTimers();
    let now = 0;
    const w = new FeedWatch({ now: () => now, round: () => ({ round: 3, phase: "live" }) });
    w.start();
    for (let i = 0; i < 10; i++) {
      now += 50;
      vi.advanceTimersByTime(50);
    }
    expect(w.summary().loopStalls).toEqual([]);
    // The loop busy for 600 ms: the next tick comes that late.
    now += 600;
    vi.advanceTimersByTime(50);
    w.stop();
    const s = w.summary();
    expect(s.loopStalls).toHaveLength(1);
    expect(s.longestLoopStall!.ms).toBeGreaterThanOrEqual(LOOP_STALL_MS);
    expect(s.longestLoopStall).toMatchObject({ round: 3, phase: "live" });
  });
});
