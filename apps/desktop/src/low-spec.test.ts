import { describe, expect, it } from "vitest";
import { applyFrameRate, DEFAULT_FRAME_RATE, engineExecArgv, engineHeapCapMb, parsePerformanceMessage } from "./low-spec.ts";

const GB = 1024 * 1024 * 1024;

describe("low-spec mode in the program", () => {
  it("starts the engine with a memory cap only while low-spec mode is on, sized by the computer's memory", () => {
    expect(engineHeapCapMb(16 * GB)).toBe(1024);
    expect(engineHeapCapMb(32 * GB)).toBe(1024);
    expect(engineHeapCapMb(8 * GB)).toBe(768);
    expect(engineExecArgv([], false, 16 * GB)).toEqual({ execArgv: [], heapCapMb: null });
    expect(engineExecArgv([], true, 16 * GB)).toEqual({ execArgv: ["--max-old-space-size=1024"], heapCapMb: 1024 });
    // Development: tsx stays first.
    expect(engineExecArgv(["--import", "tsx"], true, 8 * GB)).toEqual({ execArgv: ["--import", "tsx", "--max-old-space-size=768"], heapCapMb: 768 });
  });

  it("reads the engine's performance message and nothing else", () => {
    expect(parsePerformanceMessage({ type: "performance", lowSpec: true, frameCap: 30 })).toEqual({ lowSpec: true, frameCap: 30 });
    expect(parsePerformanceMessage({ type: "performance", lowSpec: false, frameCap: null })).toEqual({ lowSpec: false, frameCap: null });
    // Off never caps; a nonsense cap is no cap.
    expect(parsePerformanceMessage({ type: "performance", lowSpec: false, frameCap: 30 })).toEqual({ lowSpec: false, frameCap: null });
    expect(parsePerformanceMessage({ type: "performance", lowSpec: true, frameCap: 9999 })).toEqual({ lowSpec: true, frameCap: null });
    expect(parsePerformanceMessage({ type: "ready", operatorToken: "x" })).toBeNull();
    expect(parsePerformanceMessage({ type: "performance", lowSpec: "yes" })).toBeNull();
    expect(parsePerformanceMessage(null)).toBeNull();
  });

  it("sets the desktop HUD windows' frame rate to the cap, and back to 60 without one, skipping closed windows", () => {
    const calls: number[] = [];
    const win = (destroyed = false) => ({ isDestroyed: () => destroyed, setFrameRate: (fps: number) => void calls.push(fps) });
    const throwing = { isDestroyed: () => false, setFrameRate: () => { throw new Error("closing"); } };
    expect(applyFrameRate([win(), win(true), throwing, win()], 30)).toBe(2);
    expect(calls).toEqual([30, 30]);
    expect(applyFrameRate([win()], null)).toBe(1);
    expect(calls.at(-1)).toBe(DEFAULT_FRAME_RATE);
  });
});
