import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LEAD_MS, renderBreak, TAIL_MS } from "../src/replay/render.ts";
import { planSlow, SLOW_AFTER_MS, SLOW_BEFORE_MS, SLOW_EASE_MS, slowFactor, slowOutMs, slowWindows, windowMap, windowOutMs, type SlowSpec } from "../src/replay/slowmo.ts";

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-hide_banner", "-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-hide_banner", "-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const spec = (over: Partial<SlowSpec> = {}): SlowSpec => ({ mode: "kill", speedPercent: 50, killsMs: [1500], smooth: false, audio: "mute", ...over });

describe("Slow motion: the windows and the time map", () => {
  it("slows a window around each kill: an ease in, a hold through the kill, an ease out", () => {
    expect(slowWindows(spec(), 3000)).toEqual([{ from: 1500 - SLOW_BEFORE_MS - SLOW_EASE_MS, holdFrom: 1500 - SLOW_BEFORE_MS, holdTo: 1500 + SLOW_AFTER_MS, to: 1500 + SLOW_AFTER_MS + SLOW_EASE_MS }]);
    // Two kills close together are held slow between them; two far apart get a window each.
    expect(slowWindows(spec({ killsMs: [1000, 2200] }), 5000)).toEqual([{ from: 500, holdFrom: 800, holdTo: 3000, to: 3300 }]);
    expect(slowWindows(spec({ killsMs: [1000, 4000] }), 6000)).toHaveLength(2);
    // Cut at the part's ends: a shorter ease there; a kill outside the part slows nothing.
    expect(slowWindows(spec({ killsMs: [100] }), 3000)[0]).toEqual({ from: 0, holdFrom: 0, holdTo: 900, to: 1200 });
    expect(slowWindows(spec({ killsMs: [2900] }), 3000)[0]).toEqual({ from: 2400, holdFrom: 2700, holdTo: 3000, to: 3000 });
    expect(slowWindows(spec({ killsMs: [5000] }), 3000)).toEqual([]);
    expect(slowWindows(spec({ killsMs: [] }), 3000)).toEqual([]);
    // The whole part, no ease.
    expect(slowWindows(spec({ mode: "whole" }), 3000)).toEqual([{ from: 0, holdFrom: 0, holdTo: 3000, to: 3000 }]);
  });

  it("makes the part longer by the hold's extra time and the eases' (each at (1 + K)/2): 1.3 s at 50 %, 2.6 s at 33 % for one kill", () => {
    expect(slowFactor(50)).toBe(2);
    expect(slowFactor(33)).toBe(3);
    expect(slowOutMs(spec(), 3000)).toBeCloseTo(3000 + 1300, 6);
    expect(slowOutMs(spec({ speedPercent: 33 }), 3000)).toBeCloseTo(3000 + 2600, 6);
    expect(slowOutMs(spec({ mode: "whole", speedPercent: 33 }), 3000)).toBe(9000);
    expect(slowOutMs(null, 3000)).toBe(3000);
    expect(slowOutMs(spec({ killsMs: [] }), 3000)).toBe(3000);
  });

  it("eases without a jump: the map is continuous, its speed starts and ends at real speed and holds at the slow speed", () => {
    const w = slowWindows(spec(), 3000)[0]!;
    const local = { from: 0, holdFrom: w.holdFrom - w.from, holdTo: w.holdTo - w.from, to: w.to - w.from };
    const K = 2;
    const map = (x: number) => windowMap(local, K, x);
    expect(map(0)).toBe(0);
    expect(map(local.to)).toBeCloseTo(windowOutMs(local, K), 6);
    // Continuous at the joins, and the speed (source ms per output ms) 1 at the ends and 1/K in the hold.
    const speed = (x: number) => 0.02 / (map(x + 0.01) - map(x - 0.01));
    for (const x of [local.holdFrom, local.holdTo]) expect(map(x + 1e-6) - map(x - 1e-6)).toBeLessThan(1e-3);
    expect(speed(0.02)).toBeCloseTo(1, 2);
    expect(speed(local.to - 0.02)).toBeCloseTo(1, 2);
    expect(speed((local.holdFrom + local.holdTo) / 2)).toBeCloseTo(1 / K, 6);
    // Always forward.
    for (let x = 0.5; x < local.to; x += 7) expect(map(x)).toBeGreaterThan(map(x - 0.5));
  });

  it("plans the pieces on the source's frames, each a whole number of output frames", () => {
    const p = planSlow(spec(), 3000, 30, 30)!;
    expect(p.segments.map((s) => s.kind)).toEqual(["real", "slow", "real"]);
    expect(p.segments.map((s) => s.frames)).toEqual([30, 87, 12]);
    expect(p.outMs).toBeCloseTo((129 * 1000) / 30, 6);
    // Nothing to slow: no plan.
    expect(planSlow(spec({ killsMs: [] }), 3000, 30, 30)).toBeNull();
  });
});

/**
 * Tiny generated clips (64×36, a few seconds) with a 440 Hz tone. The top half's brightness tells the
 * clip's moment (16 + 70 a second); the bottom half is dark on even frames and bright on odd ones, so a
 * frame blended from two of the clip's reads grey there, and one of the clip's own reads dark or bright.
 */
describe.skipIf(!hasFfmpeg)("Slow motion rendered by ffmpeg", () => {
  const dir = mkdtempSync(join(tmpdir(), "mf-slowmo-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const W = 64;
  const H = 36;
  const ramp = (name: string, seconds: number, fps: number) => {
    const file = join(dir, `${name}.mp4`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `nullsrc=s=${W}x${H}:r=${fps}:d=${seconds},geq=lum='if(lt(Y,${H / 2}),16+T*70,if(mod(N,2),235,16))':cb=128:cr=128`, "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${seconds}`, "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-g", String(fps), "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file]);
    return file;
  };
  /** Each frame of a file: the clip's moment it shows (s; to 1/70 s, its brightness's step) and whether it is one of the clip's own frames (not a blend). */
  const readFrames = (file: string): { at: number; own: boolean }[] => {
    const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "yuv420p", "-"], { maxBuffer: 64 * 1024 * 1024 });
    const half = (W * H) / 2;
    const size = (W * H * 3) / 2;
    const out: { at: number; own: boolean }[] = [];
    for (let f = 0; f + size <= raw.length; f += size) {
      let top = 0;
      let bottom = 0;
      // (Rows away from the middle: the encoder blurs the edge between the halves a little.)
      for (let i = 0; i < half - W * 2; i++) top += raw[f + i]!;
      for (let i = half + W * 2; i < half * 2; i++) bottom += raw[f + i]!;
      const b = bottom / (half - W * 2);
      out.push({ at: (top / (half - W * 2) - 16) / 70, own: b < 40 || b > 210 });
    }
    return out;
  };
  const moments = (file: string): number[] => readFrames(file).map((f) => f.at);
  /** The sound between two times (s): its level (RMS of 16-bit samples) and its pitch (zero crossings). */
  const sound = (file: string, from: number, to: number) => {
    const pcm = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-af", `atrim=${from}:${to}`, "-f", "s16le", "-ac", "1", "-ar", "48000", "-"]);
    let sq = 0;
    let crossings = 0;
    const count = pcm.length / 2;
    for (let i = 0; i < count; i++) {
      const v = pcm.readInt16LE(i * 2);
      sq += v * v;
      if (i && v < 0 !== pcm.readInt16LE(i * 2 - 2) < 0) crossings++;
    }
    return { rms: Math.sqrt(sq / Math.max(1, count)), hz: crossings / 2 / (to - from) };
  };
  const duration = (file: string, stream: "v" | "a") => Number(execFileSync("ffprobe", ["-v", "error", "-select_streams", stream, "-show_entries", "stream=duration", "-of", "csv=p=0", file]).toString().trim());

  /** Renders one clip's whole 3 s part with a kill at 1.5 s, slowed as given. */
  const render = async (name: string, slow: SlowSpec, fps = 30) => {
    const src = ramp(`${name}-src`, 3, fps);
    const out = join(dir, `${name}.mp4`);
    const r = await renderBreak({ ffmpeg: "ffmpeg", version: null, encoder: "libx264", clips: [{ file: src, startMs: 0, durationMs: 3000, slow }], fadeMs: 0, audioFadeMs: 0, outFile: out }).done;
    return { out, r };
  };

  /** Where each output frame should be in the clip (s): real speed before and after, the time map in the window. */
  const expected = (slow: SlowSpec, fps: number) => {
    const w = slowWindows(slow, 3000)[0]!;
    const K = slowFactor(slow.speedPercent);
    const local = { from: 0, holdFrom: w.holdFrom - w.from, holdTo: w.holdTo - w.from, to: w.to - w.from };
    const outLen = windowOutMs(local, K);
    // Output ms from the part's start → source ms (inverting the window's map by bisection).
    return (tMs: number) => {
      if (tMs < w.from) return tMs / 1000;
      if (tMs >= w.from + outLen) return (tMs - outLen + (w.to - w.from)) / 1000;
      let lo = 0;
      let hi = local.to;
      for (let k = 0; k < 40; k++) {
        const mid = (lo + hi) / 2;
        if (windowMap(local, K, mid) < tMs - w.from) lo = mid;
        else hi = mid;
      }
      void fps;
      return (w.from + lo) / 1000;
    };
  };

  it("eases down to 50 % around the kill, holds and eases back: every frame at its moment, the real-speed frames after it the clip's own; the sound muted with fades", async () => {
    const slow = spec();
    const { out, r } = await render("kill50", slow);
    const plan = planSlow(slow, 3000, 30, 30)!;
    expect(r.layout.contentMs).toBeCloseTo(plan.outMs, 6);
    expect(r.slowed).toBe(1);
    expect(r.smooth).toBe(false);
    // The file: the first frame held, the slowed part (4.3 s), the last frame held.
    for (const s of ["v", "a"] as const) expect(Math.abs(duration(out, s) - (LEAD_MS + plan.outMs + TAIL_MS) / 1000), s).toBeLessThan(0.05);
    const at = moments(out);
    const lead = Math.round((LEAD_MS / 1000) * 30);
    const want = expected(slow, 30);
    const frames = Math.round((plan.outMs / 1000) * 30);
    let worst = 0;
    for (let i = 0; i < frames; i++) worst = Math.max(worst, Math.abs(at[lead + i]! - want((i * 1000) / 30)));
    // Blended frames sit between two of the clip's: within a frame of the time map.
    expect(worst).toBeLessThan(1 / 30);
    // Before and after the window, real speed on the clip's own frames (none blended), one frame apart; in the hold, blends between them.
    const own = readFrames(out).map((f) => f.own);
    const first = Math.round((plan.segments[0]!.outMs / 1000) * 30);
    const after = Math.round(((plan.segments[0]!.outMs + plan.segments[1]!.outMs) / 1000) * 30);
    for (let i = 0; i < first; i++) expect(own[lead + i], `frame ${i}`).toBe(true);
    for (let i = after; i < frames; i++) expect(own[lead + i], `frame ${i}`).toBe(true);
    for (let i = after; i < frames - 1; i++) expect(Math.abs(at[lead + i + 1]! - at[lead + i]! - 1 / 30)).toBeLessThan(1 / 70 + 0.002);
    expect(own.slice(lead + first, lead + after).filter((o) => !o).length).toBeGreaterThan(20);
    // The sound: the tone before the window, fading out, silent through it, back after it.
    const w0 = (LEAD_MS + plan.segments[0]!.outMs) / 1000;
    const w1 = w0 + plan.segments[1]!.outMs / 1000;
    const before = sound(out, LEAD_MS / 1000 + 0.2, w0 - 0.2);
    expect(before.hz).toBeGreaterThan(420);
    expect(before.hz).toBeLessThan(460);
    expect(sound(out, w0 - 0.06, w0).rms).toBeLessThan(before.rms * 0.7);
    expect(sound(out, w0 + 0.05, w1 - 0.05).rms).toBeLessThan(5);
    expect(sound(out, w1 + 0.15, w1 + 0.35).rms).toBeGreaterThan(before.rms * 0.8);
  }, 60000);

  it("at 33 % the window lasts three times its hold; with the pitch kept, the sound plays slowed through it at the same pitch and the right length", async () => {
    const slow = spec({ speedPercent: 33, audio: "pitch" });
    const { out, r } = await render("kill33", slow);
    const plan = planSlow(slow, 3000, 30, 30)!;
    expect(plan.segments[1]!.outMs).toBeCloseTo(((0.3 + 0.3) * (1 + 3)) / 2 * 1000 + 3 * 1000, -2);
    expect(r.layout.contentMs).toBeCloseTo(plan.outMs, 6);
    for (const s of ["v", "a"] as const) expect(Math.abs(duration(out, s) - (LEAD_MS + plan.outMs + TAIL_MS) / 1000), s).toBeLessThan(0.05);
    const at = moments(out);
    const lead = Math.round((LEAD_MS / 1000) * 30);
    const want = expected(slow, 30);
    const frames = Math.round((plan.outMs / 1000) * 30);
    let worst = 0;
    for (let i = 0; i < frames; i++) worst = Math.max(worst, Math.abs(at[lead + i]! - want((i * 1000) / 30)));
    expect(worst).toBeLessThan(1 / 30);
    const w0 = (LEAD_MS + plan.segments[0]!.outMs) / 1000;
    const w1 = w0 + plan.segments[1]!.outMs / 1000;
    const inside = sound(out, w0 + 0.1, w1 - 0.1);
    expect(inside.rms).toBeGreaterThan(500);
    expect(inside.hz).toBeGreaterThan(420);
    expect(inside.hz).toBeLessThan(460);
  }, 60000);

  it("the whole clip at 50 %: twice as long, every frame at half speed", async () => {
    const slow = spec({ mode: "whole" });
    const { out, r } = await render("whole50", slow);
    expect(r.layout.contentMs).toBeCloseTo(6000, 6);
    const at = moments(out);
    const lead = Math.round((LEAD_MS / 1000) * 30);
    let worst = 0;
    for (let i = 0; i < 180; i++) worst = Math.max(worst, Math.abs(at[lead + i]! - i / 60));
    expect(worst).toBeLessThan(1 / 30);
  }, 60000);

  it("Smooth slow motion interpolates the missing frames (minterpolate) on the same time map", async () => {
    const slow = spec({ smooth: true });
    const { out, r } = await render("smooth", slow);
    expect(r.smooth).toBe(true);
    const plan = planSlow(slow, 3000, 30, 30)!;
    for (const s of ["v", "a"] as const) expect(Math.abs(duration(out, s) - (LEAD_MS + plan.outMs + TAIL_MS) / 1000), s).toBeLessThan(0.05);
    const at = moments(out);
    const lead = Math.round((LEAD_MS / 1000) * 30);
    const want = expected(slow, 30);
    let worst = 0;
    for (let i = 0; i < Math.round((plan.outMs / 1000) * 30); i++) worst = Math.max(worst, Math.abs(at[lead + i]! - want((i * 1000) / 30)));
    expect(worst).toBeLessThan(1 / 30);
  }, 120000);

  it("two clips, one slowed: the layout puts the second where its fade begins after the first's slowed length", async () => {
    const a = ramp("two-a", 3, 30);
    const b = ramp("two-b", 3, 30);
    const out = join(dir, "two.mp4");
    const slow = spec({ killsMs: [1000] });
    const r = await renderBreak({ ffmpeg: "ffmpeg", version: null, encoder: "libx264", clips: [{ file: a, startMs: null, durationMs: 2500, slow }, { file: b, startMs: null, durationMs: 2500 }], fadeMs: 500, audioFadeMs: 300, outFile: out }).done;
    const first = planSlow(slow, 2500, 30, 30)!.outMs;
    expect(r.layout.starts[1]).toBeCloseTo(LEAD_MS + first - 500, 6);
    expect(Math.abs(duration(out, "v") - r.layout.totalMs / 1000)).toBeLessThan(0.05);
    // The part was the file's last 2.5 s: its kill 1 s into the part is 1.5 s into the file.
    const at = moments(out);
    const lead = Math.round((LEAD_MS / 1000) * 30);
    expect(at[lead]!).toBeCloseTo(0.5, 1);
  }, 60000);
});
