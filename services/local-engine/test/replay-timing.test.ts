import { describe, expect, it } from "vitest";
import { DelayEstimator, killKey } from "../src/replay/timing.ts";

/** CS2's live round clock at wall time t (ms): 115 s counting down from t = 0. */
const clock = (t: number) => Math.round((115 - t / 1000) * 10) / 10;
const reading = (at: number, endsInSec: number, round = 7, phase = "live") => ({ at, map: "de_mirage", round, phase, endsInSec });

/** The main PC's clock every 250 ms (a poll), this computer's every 100 ms, `delayMs` behind (negative: ahead). */
function run(est: DelayEstimator, from: number, to: number, delayMs: number) {
  for (let t = from; t <= to; t += 50) {
    if (t % 250 === 0) est.noteMain(reading(t, clock(t)));
    if (t % 100 === 0 && t - delayMs >= 0) est.noteOwn(reading(t, clock(t - delayMs)));
  }
}

describe("How far the replay PC's game is behind the main PC's", () => {
  it("finds 7 s behind from the two round clocks", () => {
    const est = new DelayEstimator();
    run(est, 0, 20_000, 7000);
    const e = est.estimate(20_000)!;
    expect(Math.abs(e.delayMs - 7000)).toBeLessThanOrEqual(120);
    expect(e.readings).toBeGreaterThan(50);
  });

  it("finds the same time, and a computer ahead of the main PC", () => {
    const same = new DelayEstimator();
    run(same, 0, 10_000, 0);
    expect(Math.abs(same.estimate(10_000)!.delayMs)).toBeLessThanOrEqual(120);
    const ahead = new DelayEstimator();
    run(ahead, 0, 20_000, -4000);
    expect(Math.abs(ahead.estimate(20_000)!.delayMs + 4000)).toBeLessThanOrEqual(120);
  });

  it("gives no answer from a paused clock, or from another round", () => {
    const est = new DelayEstimator();
    for (let t = 0; t < 10_000; t += 100) {
      est.noteMain(reading(t, 80));
      est.noteOwn(reading(t, 80));
    }
    expect(est.estimate(10_000)).toBeNull();
    const other = new DelayEstimator();
    for (let t = 0; t < 10_000; t += 100) {
      other.noteMain(reading(t, clock(t), 7));
      other.noteOwn(reading(t, clock(t), 8));
    }
    expect(other.estimate(10_000)).toBeNull();
  });

  it("measures again at once after this computer's game jumps back (a rewind) and forward", () => {
    const est = new DelayEstimator();
    run(est, 0, 10_000, 0);
    expect(Math.abs(est.estimate(10_000)!.delayMs)).toBeLessThanOrEqual(120);
    // CS2 goes back 6 s at t = 10 s: this computer's clock reads 6 s more than the main PC's from then on.
    for (let t = 10_050; t <= 11_500; t += 50) {
      if (t % 250 === 0) est.noteMain(reading(t, clock(t)));
      if (t % 100 === 0) est.noteOwn(reading(t, clock(t - 6000)));
    }
    expect(Math.abs(est.estimate(11_500)!.delayMs - 6000)).toBeLessThanOrEqual(150);
    // And forward to live again at t = 14 s.
    for (let t = 11_550; t <= 15_500; t += 50) {
      if (t % 250 === 0) est.noteMain(reading(t, clock(t)));
      if (t % 100 === 0) est.noteOwn(reading(t, clock(t < 14_000 ? t - 6000 : t)));
    }
    expect(Math.abs(est.estimate(15_500)!.delayMs)).toBeLessThanOrEqual(150);
  });

  it("knows the new delay at once after going back, before the main PC's matching readings arrive", () => {
    // Linked at t = 10 s, at the same time as the main PC; the main PC's readings start then.
    const est = new DelayEstimator();
    run(est, 10_000, 12_000, 0);
    expect(Math.abs(est.estimate(12_000)!.delayMs)).toBeLessThanOrEqual(120);
    // CS2 goes back 7 s at 12 s: this computer's clock now reads what the main PC showed at 5 s, before it was linked.
    for (let t = 12_050; t <= 13_000; t += 50) {
      if (t % 250 === 0) est.noteMain(reading(t, clock(t)));
      if (t % 100 === 0) est.noteOwn(reading(t, clock(t - 7000)));
    }
    const e = est.estimate(13_000)!;
    expect(Math.abs(e.delayMs - 7000)).toBeLessThanOrEqual(150);
    expect(e.readings).toBe(0);
    // Once the clocks can be matched again (from 17 s), the measured value takes over.
    for (let t = 13_050; t <= 20_000; t += 50) {
      if (t % 250 === 0) est.noteMain(reading(t, clock(t)));
      if (t % 100 === 0) est.noteOwn(reading(t, clock(t - 7000)));
    }
    const m = est.estimate(20_000)!;
    expect(Math.abs(m.delayMs - 7000)).toBeLessThanOrEqual(120);
    expect(m.readings).toBeGreaterThan(5);
  });

  it("uses kills seen on both computers when the clock can't be matched", () => {
    const est = new DelayEstimator();
    for (const [i, t] of [1000, 4000, 9000].entries()) {
      est.noteMainKill(killKey(7, `k${i}`, `v${i}`), t);
      est.noteOwnKill(killKey(7, `k${i}`, `v${i}`), t + 7050);
    }
    expect(est.estimate(17_000)!.delayMs).toBe(7050);
  });

  it("gives no answer while the readings disagree", () => {
    const est = new DelayEstimator();
    for (const [i, d] of [1000, 6000, 2000, 9000, 4000].entries()) {
      est.noteMainKill(killKey(7, `k${i}`, `v${i}`), 1000 * i);
      est.noteOwnKill(killKey(7, `k${i}`, `v${i}`), 1000 * i + d);
    }
    expect(est.estimate(12_000)).toBeNull();
  });
});
