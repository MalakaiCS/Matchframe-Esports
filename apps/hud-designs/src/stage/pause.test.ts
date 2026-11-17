import { describe, expect, it } from "vitest";
import { pauseSeconds } from "./util.ts";

const base = { receivedAt: 1000, now: 4000, startedAt: 1000 };

describe("Stage HUD: the pause timer", () => {
  it("counts CS2's pause countdown down when it runs", () => {
    expect(pauseSeconds({ ...base, phase: "paused", sec: 287, running: true, falling: false })).toEqual({ kind: "countdown", sec: 284 });
  });

  it("uses the countdown once it has been seen going down between updates", () => {
    expect(pauseSeconds({ ...base, phase: "paused", sec: 120, running: false, falling: true })).toEqual({ kind: "countdown", sec: 120 });
  });

  it("times the pause from its start when the game gives no countdown (a frozen clock, none, or a paused flag in freeze time)", () => {
    expect(pauseSeconds({ ...base, phase: "paused", sec: 14, running: false, falling: false })).toEqual({ kind: "elapsed", sec: 3 });
    expect(pauseSeconds({ ...base, phase: "paused", sec: null, running: false, falling: false })).toEqual({ kind: "elapsed", sec: 3 });
    expect(pauseSeconds({ ...base, phase: "freezetime", sec: 14, running: true, falling: false, now: 65_500 })).toEqual({ kind: "elapsed", sec: 64 });
  });
});
