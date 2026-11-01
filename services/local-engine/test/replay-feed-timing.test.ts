import { describe, expect, it } from "vitest";
import { AUDIO_RATE, AudioClock, FrameSlots, Resampler, toStereo, VideoClock } from "../src/replay/feed-clock.ts";
import type { FeedDiagnostics } from "../src/replay/feed-core.ts";
import { feedLosses } from "../src/replay/feed.ts";

/** A seeded random number in [0, 1). */
function rng(seed: number): () => number {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

const FRAME = 1000 / 60;

/**
 * A 60 fps sender like NDI Screen Capture on a busy replay PC, received by a busy main PC: each
 * frame's timestamp is when it was submitted (up to `jitter` ms either side of when it was due), its
 * timecode steps evenly (NDI makes it so); it arrives 3–18 ms later, and every 1.3 s this computer is
 * busy for 150 ms, after which what came meanwhile arrives at once.
 */
function busySender(seconds: number, o: { jitter?: number; timecode?: boolean; seed?: number } = {}) {
  const r = rng(o.seed ?? 1);
  const T0 = 1_700_000_000_000;
  const frames: { i: number; ts: number; tc: number | null; at: number }[] = [];
  let prev = 0;
  for (let i = 0; i < seconds * 60; i++) {
    const due = T0 + i * FRAME;
    const ts = due + (r() * 2 - 1) * (o.jitter ?? 4);
    let at = Math.max(prev, ts + 3 + r() * 15);
    const busy = Math.floor((at - T0) / 1300) * 1300 + T0;
    if (at - T0 > 1300 && at < busy + 150) at = busy + 150;
    prev = at;
    frames.push({ i, ts, tc: o.timecode === false ? null : due, at });
  }
  return frames;
}

/** The frames through the clock and the slots: which frame each slot of the recording shows. */
function record(frames: { i: number; ts: number | null; tc: number | null; at: number }[]) {
  const clock = new VideoClock(FRAME);
  let slots: FrameSlots | null = null;
  const shown: number[] = [];
  let skipped = 0;
  for (const f of frames) {
    const t = clock.place(f.at, f.ts, f.tc);
    slots ??= new FrameSlots(t - 6 * FRAME, FRAME, 6);
    const gap = slots.place(t);
    if (gap === null) {
      skipped++;
      continue;
    }
    for (let k = 0; k < gap; k++) shown.push(shown[shown.length - 1]!);
    shown.push(f.i);
  }
  const repeated = shown.filter((x, k) => k > 0 && x === shown[k - 1]).length;
  return { clock, shown, repeated, skipped };
}

describe("replay feed's picture: timed by the sender, written at a constant rate", () => {
  it("puts every frame of a jittery 60 fps sender in its own slot, however late or bunched it arrives", () => {
    const frames = busySender(20);
    const { clock, shown, repeated, skipped } = record(frames);
    expect(clock.timing).toBe("timecode");
    expect(repeated).toBe(0);
    expect(skipped).toBe(0);
    expect(shown).toEqual(frames.map((f) => f.i));
    expect(clock.reanchored).toBe(0);
    // Timed by when they arrived (the old way), the same frames judder: repeats and skips.
    const byArrival = record(frames.map((f) => ({ ...f, ts: null, tc: null })));
    expect(byArrival.clock.timing).toBe("arrival");
    expect(byArrival.repeated).toBeGreaterThan(50);
    expect(byArrival.skipped).toBeGreaterThan(50);
  });

  it("uses the timestamps when there is no steady timecode: their jitter within a frame changes nothing", () => {
    const { clock, repeated, skipped } = record(busySender(20, { timecode: false, jitter: 5 }));
    expect(clock.timing).toBe("timestamp");
    expect(repeated + skipped).toBe(0);
  });

  it("repeats the frame before for frames the sender never sent, and skips a frame that comes for a filled slot", () => {
    const frames = busySender(5).filter((f) => f.i < 100 || f.i > 102);
    const dup = { ...frames[200]!, at: frames[200]!.at + 1 };
    frames.splice(201, 0, dup);
    const { shown, repeated, skipped } = record(frames);
    expect(repeated).toBe(3);
    expect(skipped).toBe(1);
    expect(shown.slice(98, 105)).toEqual([98, 99, 99, 99, 99, 103, 104]);
  });

  it("follows clocks that drift apart by moving the offset rarely, a frame or two at a time", () => {
    // The sender's clock runs 100 ppm slow against this computer's for 10 minutes: 60 ms, 3.6 frames.
    const r = rng(3);
    const T0 = 5_000;
    const frames = Array.from({ length: 600 * 60 }, (_, i) => ({ i, ts: i * FRAME, tc: i * FRAME, at: T0 + i * FRAME * 1.0001 + 3 + r() * 5 }));
    const { clock, repeated, skipped } = record(frames);
    expect(clock.reanchored).toBeGreaterThanOrEqual(1);
    expect(clock.reanchored).toBeLessThanOrEqual(3);
    expect(repeated).toBeGreaterThanOrEqual(3);
    expect(repeated).toBeLessThanOrEqual(5);
    expect(skipped).toBe(0);
  });

  it("lays a sender whose clock jumped (restarted) again at once", () => {
    const frames = busySender(6).map((f) => (f.i >= 180 ? { ...f, ts: f.ts - 3_600_000, tc: f.tc! - 3_600_000 } : f));
    const { clock, shown, repeated, skipped } = record(frames);
    expect(clock.reanchored).toBe(1);
    expect(repeated + skipped).toBeLessThanOrEqual(2);
    expect(shown.length).toBeGreaterThanOrEqual(359);
  });

  it("holds the last frame through a pause: the slots up to the time repeat it", () => {
    const slots = new FrameSlots(0, FRAME, 6);
    expect(slots.hold(500)).toBe(0);
    slots.place(6 * FRAME);
    expect(slots.hold(6 * FRAME + 5)).toBe(0);
    expect(slots.hold(10 * FRAME + 1)).toBe(4);
    expect(slots.next).toBe(11);
    // The picture back: it goes on in its own slot.
    expect(slots.place(11 * FRAME + 2)).toBe(0);
  });
});

/** A 1 kHz sine at 0.5, from sample `from`, interleaved stereo. */
const sine = (from: number, n: number, hz = 1000) => {
  const x = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) x[2 * i] = x[2 * i + 1] = 0.5 * Math.sin((2 * Math.PI * hz * (from + i)) / AUDIO_RATE);
  return x;
};
const left = (bufs: Buffer[]) => {
  const all = Buffer.concat(bufs);
  const f = new Float32Array(all.buffer, all.byteOffset, all.length / 4);
  return Float32Array.from({ length: f.length / 2 }, (_, i) => f[2 * i]!);
};
/** The largest step between two samples of the left side (a 1 kHz sine at 0.5 steps at most 0.065). */
const maxStep = (x: Float32Array, from = 1, to = x.length) => {
  let m = 0;
  for (let i = Math.max(1, from); i < to; i++) m = Math.max(m, Math.abs(x[i]! - x[i - 1]!));
  return m;
};

describe("replay feed's sound: written as received, laid along the picture", () => {
  it("takes any channels as stereo at their rate, a stereo frame's own floats", () => {
    const f = (channels: number, samples: number) => {
      const data = Buffer.alloc(samples * channels * 4);
      for (let i = 0; i < samples; i++) for (let c = 0; c < channels; c++) data.writeFloatLE(c === 0 ? i / samples : -i / samples, (i * channels + c) * 4);
      return { channels, samples, data };
    };
    const st = f(2, 480);
    const stereo = toStereo(st);
    expect(stereo.length).toBe(960);
    expect(stereo.buffer).toBe(st.data.buffer);
    expect([stereo[2], stereo[3]]).toEqual([Math.fround(1 / 480), Math.fround(-1 / 480)]);
    const mono = toStereo(f(1, 100));
    expect(mono[10]).toBe(mono[11]);
    expect(toStereo(f(8, 100)).length).toBe(200);
  });

  it("resamples across frames: 48 kHz untouched, 44.1 kHz to 48 kHz without a break, and the sound moved by playing it 0.3 % faster", () => {
    const same = new Resampler(0.003);
    const a = sine(0, 480);
    const b = sine(480, 480);
    expect(same.process(a, 48000)).toEqual(a);
    expect(same.process(b, 48000)).toEqual(b);

    const cd = new Resampler(0.003);
    const out: number[] = [];
    for (let k = 0; k < 100; k++) {
      const x = new Float32Array(2 * 441);
      for (let i = 0; i < 441; i++) x[2 * i] = x[2 * i + 1] = 0.5 * Math.sin((2 * Math.PI * 1000 * (k * 441 + i)) / 44100);
      out.push(...cd.process(x, 44100).filter((_, i) => i % 2 === 0));
    }
    expect(Math.abs(out.length - 48000)).toBeLessThanOrEqual(1);
    expect(maxStep(Float32Array.from(out))).toBeLessThan(0.07);

    // 480 samples late: dropped over the next frames by running faster, exactly 480, the sine unbroken.
    const move = new Resampler(0.003);
    move.shift = 480;
    const moved: number[] = [];
    let n = 0;
    for (let k = 0; k < 400; k++) {
      moved.push(...move.process(sine(k * 480, 480), 48000).filter((_, i) => i % 2 === 0));
      n += 480;
    }
    expect(move.shift).toBe(0);
    expect(moved.length).toBe(n - 480);
    expect(maxStep(Float32Array.from(moved))).toBeLessThan(0.07);
  });

  /** A sender's sound: frames of 480 samples (10 ms), each stamped when submitted, just after its last sample, up to `late` ms later. */
  function sound(seconds: number, o: { late?: number; seed?: number; clock?: number; pauseAt?: number; pauseMs?: number } = {}) {
    const r = rng(o.seed ?? 7);
    const frames: { pcm: Float32Array; end: number; at: number }[] = [];
    let prev = 0;
    let shift = 0;
    for (let j = 0; j < seconds * 100; j++) {
      if (o.pauseAt !== undefined && j === o.pauseAt) shift = o.pauseMs ?? 0;
      const end = 100 + ((j + 1) * 10) / (o.clock ?? 1) + shift;
      // Now and then a frame submitted 40 ms late (the capture was busy), else up to `late`.
      const ts = end + (r() < 0.03 ? 40 : r() * (o.late ?? 25));
      let at = Math.max(prev, ts + 2 + r() * 10);
      const busy = Math.floor(at / 1300) * 1300;
      if (at > 1300 && at < busy + 150) at = busy + 150;
      prev = at;
      frames.push({ pcm: sine(j * 480, 480), end: ts, at });
    }
    return frames;
  }

  it("puts in no silence and cuts nothing for timestamps that jitter and arrivals that bunch: the samples as sent", () => {
    const c = new AudioClock(0);
    const out: Buffer[] = [];
    const frames = sound(20);
    for (const f of frames) out.push(...c.frame(f.pcm, 48000, f.at, f.end));
    const x = left(out);
    // After the silence before the first frame: every sample sent, in order, nothing between.
    const first = x.findIndex((v) => v !== 0) - 1;
    const sent = Float32Array.from(frames.flatMap((f) => Array.from(f.pcm.filter((_, i) => i % 2 === 0))));
    const fade = 96;
    expect(Array.from(x.subarray(first + fade, first + sent.length - 96))).toEqual(Array.from(sent.subarray(fade, sent.length - 96)));
    expect([c.dropouts, c.corrections, c.joins]).toEqual([0, 0, 0]);
    expect(Math.abs(c.offsetMs!)).toBeLessThanOrEqual(30);
    // The rule it replaces (a jump of more than 20 ms in the sender's timestamps was silence, an overlap a cut) breaks these frames up.
    let breaks = 0;
    for (let k = 1; k < frames.length; k++) if (Math.abs(frames[k]!.end - 10 - frames[k - 1]!.end) > 20) breaks++;
    expect(breaks).toBeGreaterThan(20);
  });

  it("fills a real dropout (the sender sent nothing for 300 ms) with as much silence, faded out and in", () => {
    const c = new AudioClock(0);
    const out: Buffer[] = [];
    for (const f of sound(4, { pauseAt: 150, pauseMs: 300, late: 5 })) out.push(...c.frame(f.pcm, 48000, f.at, f.end));
    expect(c.dropouts).toBe(1);
    expect(c.paddedMs).toBeGreaterThan(290);
    expect(c.paddedMs).toBeLessThan(310);
    const x = left(out);
    let run = 0;
    let longest = 0;
    const first = x.findIndex((v) => v !== 0);
    for (let i = first; i < x.length; i++) {
      run = x[i] === 0 ? run + 1 : 0;
      longest = Math.max(longest, run);
    }
    expect(longest / 48).toBeGreaterThan(290);
    expect(longest / 48).toBeLessThan(312);
    expect(maxStep(x, first + 1)).toBeLessThan(0.07);
  });

  it("moves a drifting sender's sound back to the picture by a slight resample, never a cut or a silence", () => {
    // The sender's sound runs 0.1 % fast against its timestamps for 60 s: 60 ms.
    const c = new AudioClock(0);
    const out: Buffer[] = [];
    let worst = 0;
    for (const f of sound(60, { clock: 1.001, late: 10 })) {
      out.push(...c.frame(f.pcm, 48000, f.at, f.end));
      if (c.offsetMs !== null) worst = Math.max(worst, Math.abs(c.offsetMs));
    }
    expect(c.corrections).toBeGreaterThanOrEqual(1);
    expect([c.dropouts, c.joins]).toEqual([0, 0]);
    expect(worst).toBeLessThanOrEqual(40);
    const x = left(out);
    expect(maxStep(x, x.findIndex((v) => v !== 0) + 1)).toBeLessThan(0.07);
  });

  it("mends a sender whose clock jumped back a second with a crossfaded join", () => {
    const c = new AudioClock(0);
    const out: Buffer[] = [];
    const frames = sound(8, { late: 5 }).map((f, j) => (j >= 300 ? { ...f, end: f.end - 1000 } : f));
    for (const f of frames) out.push(...c.frame(f.pcm, 48000, f.at, f.end));
    expect(c.joins).toBe(1);
    expect(c.dropouts).toBe(0);
    // Back in place (to within what the resample then takes back): the second left out once, at one crossfade.
    expect(Math.abs(c.offsetMs!)).toBeLessThanOrEqual(60);
    const x = left(out);
    // The crossfade between two phases of the sine: no step much beyond the sine's own.
    expect(maxStep(x, x.findIndex((v) => v !== 0) + 1)).toBeLessThan(0.15);
  });

  it("skips with the picture when the recording skipped ahead (ffmpeg behind): that much sound left out at one crossfaded join, then in place", () => {
    const c = new AudioClock(0);
    const out: Buffer[] = [];
    const frames = sound(6, { late: 5 });
    for (const [j, f] of frames.entries()) {
      // 2 s in, the picture's slots of 600 ms are let go.
      if (j === 200) c.skip(600);
      out.push(...c.frame(f.pcm, 48000, f.at, f.end));
    }
    expect(c.dropouts).toBe(0);
    // Laid where the picture is: 600 ms fewer samples than without the skip (to within the resample's last steps), and in place afterwards.
    const plain = new AudioClock(0);
    for (const f of frames) plain.frame(f.pcm, 48000, f.at, f.end);
    expect(Math.abs(plain.written - c.written - 600 * 48)).toBeLessThan(48 * 40);
    expect(Math.abs(c.offsetMs ?? 0)).toBeLessThanOrEqual(40);
    const x = left(out);
    expect(maxStep(x, x.findIndex((v) => v !== 0) + 1)).toBeLessThan(0.15);
  });

  it("lays the first frame by its sender time, or its arrival, and fills silence for a source without sound, not while sound waits in NDI", () => {
    const c = new AudioClock(0);
    // 480 samples ending at 100 ms by the sender: 4800 − 480 samples of silence first.
    c.frame(sine(0, 480), 48000, 130, 100);
    expect(c.written).toBe(4800);
    const plain = new AudioClock(0);
    plain.frame(sine(0, 480), 48000, 100, null);
    expect(plain.written).toBe(4800);

    const quiet = new AudioClock(0);
    expect(quiet.fill(200)).toBeNull();
    expect(quiet.fill(1000, true)).toBeNull();
    const b = quiet.fill(1000)!;
    expect(b.length + 96 * 8).toBe(850 * 48 * 8);
    expect(quiet.written).toBe(850 * 48);
  });
});

describe("replay feed: where frames are lost, in plain words", () => {
  const d = (o: Partial<FeedDiagnostics>): FeedDiagnostics => ({ sourceFps: 60, received: 0, ndi: { videoFrames: 0, videoDropped: 0, audioDropped: 0 }, written: 0, repeated: 0, skipped: 0, encoderDropped: 0, startDropped: 0, skippedMs: 0, restarts: 0, backlogMax: 0, timing: "timecode", reanchored: 0, audio: null, ...o });
  const at = (t: number, o: Partial<FeedDiagnostics>) => ({ at: t, d: d(o) });

  it("nothing lost: nothing said", () => {
    expect(feedLosses(at(0, {}), at(10_000, { received: 600, written: 600, ndi: { videoFrames: 600, videoDropped: 0, audioDropped: 0 } }), "h264_nvenc", true)).toEqual([]);
  });

  it("frames not arriving from the replay PC, NDI's drops, the encoder behind and gaps in what arrived, each with its hint", () => {
    const losses = feedLosses(at(0, {}), at(10_000, { received: 520, written: 600, repeated: 80, encoderDropped: 30, ndi: { videoFrames: 532, videoDropped: 12, audioDropped: 0 } }), "libx264", false);
    expect(losses.map((l) => l.where)).toEqual(["arriving", "encoder", "gaps"]);
    expect(losses[0]).toMatchObject({ frames: 92, seconds: 10, text: "Not arriving from the replay PC: 52 of 60 frames a second arrive, and NDI dropped 12." });
    expect(losses[0]!.hint).toMatch(/wired gigabit network.*cap CS2's frame rate on the replay PC/);
    expect(losses[1]).toMatchObject({ frames: 30, text: "This computer's encoder (x264 on the CPU) is behind: 30 frames not recorded." });
    expect(losses[1]!.hint).toMatch(/choose your graphics card's encoder/);
    expect(losses[2]).toMatchObject({ frames: 50, text: "50 frames repeated to fill gaps in what arrived." });
  });

  it("the encoder's hint says what fits: x264 picked because no graphics card encoder works, or a graphics card's encoder", () => {
    const behind = (enc: "libx264" | "h264_nvenc", auto: boolean) => feedLosses(at(0, {}), at(10_000, { received: 600, written: 600, repeated: 9, encoderDropped: 9 }), enc, auto);
    expect(behind("libx264", true)[0]!.hint).toMatch(/no graphics card encoder works here/);
    expect(behind("h264_nvenc", false)[0]).toMatchObject({ where: "encoder", text: "This computer's encoder (NVIDIA NVENC) is behind: 9 frames not recorded." });
    expect(behind("h264_nvenc", false)).toHaveLength(1);
  });
});
