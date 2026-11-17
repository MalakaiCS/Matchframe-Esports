import { describe, expect, it } from "vitest";
import type { MatchState } from "@matchframe/contracts";
import type { ReplayPlay } from "@matchframe/replay-agent";
import type { Engine } from "../src/app.ts";
import { AutoReplay } from "../src/replay/auto.ts";
import { clipScore, clipWallMs, CUT_MS, fitReplay, MIN_LEAD_MS, NO_FACTS, nextReplay, planBreak, replayWallMs, SWITCH_MS } from "../src/replay/rank.ts";
import { parseVmixXml, vmixVolumeAfter } from "../src/replay/vmix.ts";

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
    expect(nextReplay(c, 20_000, 100)).toEqual({ id: "best", playMs: 9000, angles: [] });
    // 7 s left: the best fits with its lead-up cut to 3 s (it can go down to 2 s).
    expect(nextReplay(c, 7000, 100)).toEqual({ id: "best", playMs: 7000 - CUT_MS, angles: [] });
    // Too little for the best even at its shortest lead-up (9000 - (5000 - 2000) = 6000): the next best that fits.
    expect(nextReplay(c, 6000 + CUT_MS - 1, 100)).toEqual({ id: "low", playMs: 5000, angles: [] });
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
      { id: "middle", playMs: 3500, leadMs: MIN_LEAD_MS, angles: [] },
      { id: "late", playMs: 4000, leadMs: 2500, angles: [] },
      { id: "unknown", playMs: 4000, leadMs: null, angles: [] },
    ]);
    // 1 s less: no third clip fits, even shortened.
    expect(planBreak(c, three - 1000, 100, 3).map((p) => p.id)).toEqual(["late", "unknown"]);
    // In slow motion (50 %) each takes twice as long: one fits in the same time.
    expect(planBreak(c, three, 50, 3).map((p) => p.id)).toEqual(["late"]);
    expect(planBreak(c, 1000, 100, 3)).toEqual([]);
    // The operator's pin: chosen first and played first, if it fits (here the worst, in round order and best first); one that doesn't fit isn't.
    expect(planBreak(c, 30_000, 100, 3, "round", "early").map((p) => p.id)).toEqual(["early", "late", "unknown"]);
    expect(planBreak(c, 30_000, 100, 3, "best", "middle").map((p) => p.id)).toEqual(["middle", "late", "unknown"]);
    expect(planBreak([...c, { id: "long", score: 1, playMs: 40_000, leadMs: null, at: 0 }], 30_000, 100, 2, "round", "long").map((p) => p.id)).toEqual(["late", "unknown"]);
    expect(fitReplay({ playMs: 4000, leadMs: 2500 }, 4000 + SWITCH_MS, 100, SWITCH_MS)).toBe(4000);
    expect(fitReplay({ playMs: 4000, leadMs: 2500 }, 3500 + SWITCH_MS, 100, SWITCH_MS)).toBe(3500);
    expect(fitReplay({ playMs: 4000, leadMs: 2500 }, 3500 + SWITCH_MS, 100, SWITCH_MS + 1)).toBeNull();
  });

  it("counts slow motion (ADR-081): a slowed clip is longer by its slowed windows, the whole clip at its own speed; a lead-up shortened to fit isn't slowed", () => {
    // 1.3 s more for a kill slowed to 50 %: four 4 s clips fit in 20 s, not with every one slowed.
    const c = ["a", "b", "c", "d"].map((id, k) => ({ id, score: 40 - k, playMs: 4000, leadMs: 2500, at: k }));
    const plain = 4 * 4000 + CUT_MS + 3 * SWITCH_MS;
    expect(planBreak(c, plain, 100, 4)).toHaveLength(4);
    const slowed = c.map((x) => ({ ...x, extraMs: 1300 }));
    expect(planBreak(slowed, plain + 4 * 1300, 100, 4)).toHaveLength(4);
    // 0.5 s short: the last one has its lead-up shortened (its slow motion stays); 1 s short: only three fit.
    expect(planBreak(slowed, plain + 4 * 1300 - 500, 100, 4).map((p) => p.playMs)).toEqual([4000, 4000, 4000, 3500]);
    expect(planBreak(slowed, plain + 4 * 1300 - 1000, 100, 4)).toHaveLength(3);
    expect(fitReplay({ playMs: 4000, leadMs: 2500, extraMs: 1300 }, 5300 + CUT_MS, 100)).toBe(4000);
    expect(fitReplay({ playMs: 4000, leadMs: 2500, extraMs: 1300 }, 4800 + CUT_MS, 100)).toBe(3500);
    expect(fitReplay({ playMs: 4000, leadMs: 2500, extraMs: 1300 }, 4700 + CUT_MS, 100)).toBeNull();
    // The whole clip slowed: its own speed; the others at the break's.
    expect(clipWallMs({ speedPercent: 50 }, 4000, 100)).toBe(8000);
    expect(clipWallMs({ extraMs: 2600 }, 4000, 100)).toBe(6600);
    expect(planBreak([{ ...c[0]!, speedPercent: 50 }, c[1]!], 8000 + 4000 + CUT_MS + SWITCH_MS, 100, 2)).toHaveLength(2);
    expect(planBreak([{ ...c[0]!, speedPercent: 50 }, c[1]!], 8000 + 4000 + CUT_MS + SWITCH_MS - 1100, 100, 2).map((p) => p.id)).toEqual(["a"]);
  });

  it("plays a moment's extra angles straight after it in the time the break's clips leave; a starred moment's are chosen with it (ADR-081)", () => {
    const top = { id: "top", score: 60, playMs: 5000, leadMs: 3000, at: 2, angles: [{ id: "top-victim", wallMs: 5300 }] };
    const other = { id: "other", score: 20, playMs: 4000, leadMs: 2500, at: 1 };
    const all = 5000 + 5300 + SWITCH_MS + CUT_MS + 4000 + SWITCH_MS;
    expect(planBreak([top, other], all, 100, 4)).toEqual([
      { id: "other", playMs: 4000, leadMs: 2500, angles: [] },
      { id: "top", playMs: 5000, leadMs: 3000, angles: ["top-victim"] },
    ]);
    // Short of time: the angle goes, never another clip (nor the top kill's lead-up).
    const short = planBreak([top, other], all - 2000, 100, 4);
    expect(short.map((p) => [p.id, p.playMs, p.angles])).toEqual([
      ["other", 4000, []],
      ["top", 5000, []],
    ]);
    // Starred by the operator: its angle is part of it, chosen before the other clip.
    expect(planBreak([{ ...top, anglesFirst: true }, other], all - 2000, 100, 4).map((p) => [p.id, p.angles])).toEqual([["top", ["top-victim"]]]);
    // The angles don't count as one of the break's replays.
    expect(planBreak([top, other], all, 100, 1)).toEqual([{ id: "top", playMs: 5000, leadMs: 3000, angles: ["top-victim"] }]);
    // Pinned, with its angle.
    expect(planBreak([other, top], all, 100, 4, "round", "top")[0]).toMatchObject({ id: "top", angles: ["top-victim"] });
    // Two moments with angles and time for one: the better moment's.
    const second = { id: "second", score: 40, playMs: 4000, leadMs: 2500, at: 3, angles: [{ id: "second-free", wallMs: 5300 }] };
    const both = planBreak([top, second], 5000 + 4000 + CUT_MS + SWITCH_MS + 5300 + SWITCH_MS, 100, 4);
    expect(both.map((p) => [p.id, p.angles])).toEqual([
      ["top", ["top-victim"]],
      ["second", []],
    ]);
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

describe("vMix's audio", () => {
  it("reads each input's fader and mute, and moves a fader by decibels on vMix's fourth-power curve", () => {
    const st = parseVmixXml(`<vmix><version>27</version><inputs><input key="g" number="1" type="Capture" title="Game" state="Running" position="0" duration="0" volume="80" muted="False">Game</input><input key="m" number="2" type="Audio" title="Mic" state="Running" position="0" duration="0" volume="100" muted="True">Mic</input><input key="t" number="3" type="GT" title="Title" state="Running" position="0" duration="0">Title</input></inputs><active>1</active></vmix>`);
    expect(st.inputs.map((i) => [i.key, i.volume, i.muted])).toEqual([
      ["g", 80, false],
      ["m", 100, true],
      ["t", null, null],
    ]);
    // −20 dB is a tenth of the amplitude: (v / 100)^4 a tenth as much.
    expect(vmixVolumeAfter(100, -20)).toBeCloseTo(56.234, 3);
    expect((vmixVolumeAfter(80, -20) / 80) ** 4).toBeCloseTo(0.1, 6);
    expect(vmixVolumeAfter(100, -6)).toBeCloseTo(84.14, 2);
    expect(vmixVolumeAfter(90, 20)).toBe(100);
  });
});

describe("slow motion settings (ADR-081)", () => {
  const replays = (stored: Record<string, unknown>) => {
    const map = new Map<string, unknown>([["replay.auto", stored]]);
    const e = { settings: { get: (k: string, d: unknown) => map.get(k) ?? d, set: (k: string, v: unknown) => map.set(k, v) }, now: () => 0 } as unknown as Engine;
    return { a: new AutoReplay(e), stored: () => map.get("replay.auto") as Record<string, unknown> };
  };

  it("slows around each kill at 50 % by default, muted, blended; multi-angle for the top kill from the player who died's view", () => {
    expect(replays({}).a.settings()).toMatchObject({ slowMotion: "kill", slowSpeed: 50, slowSmooth: false, slowAudio: "mute", multiAngle: "top", angleViews: "victim" });
  });

  it("reads the old speed (before 0.13) as Whole clip slow motion, and takes it from the old API", () => {
    expect(replays({ speedPercent: 75 }).a.settings()).toMatchObject({ slowMotion: "whole", slowSpeed: 50 });
    expect(replays({ speedPercent: 50 }).a.settings()).toMatchObject({ slowMotion: "whole", slowSpeed: 50 });
    expect(replays({ speedPercent: 30 }).a.settings()).toMatchObject({ slowMotion: "whole", slowSpeed: 33 });
    expect(replays({ speedPercent: 100 }).a.settings().slowMotion).toBe("kill");
    // Once the new setting is saved, it wins.
    expect(replays({ speedPercent: 50, slowMotion: "off" }).a.settings().slowMotion).toBe("off");
    const { a, stored } = replays({});
    expect(a.setSettings({ speedPercent: 50 })).toMatchObject({ slowMotion: "whole", slowSpeed: 50 });
    expect(stored().speedPercent).toBeUndefined();
    expect(a.setSettings({ speedPercent: 100 }).slowMotion).toBe("off");
    // Real time again doesn't turn off slow motion at the kills.
    a.setSettings({ slowMotion: "kill" });
    expect(a.setSettings({ speedPercent: 100 }).slowMotion).toBe("kill");
  });
});
