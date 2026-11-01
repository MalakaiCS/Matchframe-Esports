import { describe, expect, it } from "vitest";
import { msToSample, Resampler, toMono, VoiceBuffer } from "../src/comms/buffer.ts";
import { PluginClock } from "../src/comms/clock.ts";
import { BLOCK, CommsMixer, type MixSource } from "../src/comms/mixer.ts";
import { amplitudeAt, tone } from "./helpers/fake-ts3-plugin.ts";

/** Team Comms' timeline pieces (ADR-065): one person's sparse buffer, the plugin's clock, the mixer's gates. */

const read = (b: VoiceBuffer, from: number, n: number) => {
  const out = new Float32Array(n);
  b.readInto(from, out);
  return out;
};

describe("VoiceBuffer: one person's voice on the timeline", () => {
  it("keeps a sentence sample for sample through timestamp jitter, and starts a new chunk after a pause", () => {
    const b = new VoiceBuffer();
    const t = tone(500, 1000);
    // 7.5 ms blocks (TeamSpeak's, as measured) stamped with up to ±4 ms of jitter.
    const jitter = [0, 3, -4, 2, -1, 4, -3, 1];
    for (let i = 0; i < 133; i++) b.write(100_000 + i * 360 + jitter[i % jitter.length]! * 48, t.subarray(i * 360, (i + 1) * 360), 1, 48000, 0);
    const out = read(b, 100_000, 133 * 360);
    for (let i = 0; i < out.length; i += 997) expect(out[i]).toBeCloseTo(t[i]! / 32768, 6);
    expect(b.stats()).toMatchObject({ reanchors: 0, late: 0, written: 133 * 360 });
    // Three seconds later: a new sentence at its own time, silence between (nothing stored for it).
    const at = 100_000 + 133 * 360 + 3 * 48000;
    b.write(at, tone(500, 100), 1, 48000, 0);
    expect(b.stats().bytes).toBe((133 * 360 + 4800) * 2);
    expect(read(b, at - 4800, 4800).every((v) => v === 0)).toBe(true);
    expect(amplitudeAt(read(b, at, 4800), 500)).toBeCloseTo(0.25, 2);
  });

  it("a clock that jumps back more than 200 ms cuts what it overlaps and lays the block at its own time", () => {
    const b = new VoiceBuffer();
    b.write(0, new Int16Array(48_000).fill(1000), 1, 48000, -Infinity);
    b.write(48_000 - 24_000, new Int16Array(4800).fill(-1000), 1, 48000, -Infinity);
    expect(b.stats().reanchors).toBe(1);
    const out = read(b, 23_990, 30);
    expect(out[0]).toBeCloseTo(1000 / 32768, 6);
    expect(out[20]).toBeCloseTo(-1000 / 32768, 6);
    expect(b.stats().last).toBe(24_000 + 4800);
  });

  it("drops what arrives after the outputs played its time, and counts it", () => {
    const b = new VoiceBuffer();
    b.write(10_000, new Int16Array(960).fill(5), 1, 48000, 10_480);
    expect(b.stats()).toMatchObject({ late: 480, samples: 480, first: 10_480 });
    expect(b.write(20_000, new Int16Array(480), 1, 48000, 30_000)).toBeNull();
  });

  it("converts 44.1 kHz and 16 kHz blocks to 48 kHz without a break, and stereo to mono", () => {
    for (const rate of [44_100, 16_000]) {
      const b = new VoiceBuffer();
      const src = tone(440, 1000, rate);
      const per = rate / 100;
      for (let i = 0; i < 100; i++) b.write(msToSample(1000 + i * 10), src.subarray(i * per, (i + 1) * per), 1, rate, 0);
      const out = read(b, msToSample(1000), 48_000);
      expect(Math.abs(b.stats().samples - 48_000)).toBeLessThanOrEqual(4);
      expect(amplitudeAt(out.subarray(2000, 46_000), 440)).toBeCloseTo(0.25, 2);
      // No dropout at the block joins: every 10 ms of the second has the tone.
      for (let i = 1; i < 99; i++) expect(amplitudeAt(out.subarray(i * 480, i * 480 + 480), 440)).toBeGreaterThan(0.2);
    }
    expect(Array.from(toMono(Int16Array.from([100, 300, -50, 50]), 2))).toEqual([200, 0]);
    expect(new Resampler(48_000).process(Int16Array.from([1, 2, 3]))).toEqual(Int16Array.from([1, 2, 3]));
  });

  it("trims before a point and drops its oldest chunk for the memory cap", () => {
    const b = new VoiceBuffer();
    for (let i = 0; i < 10; i++) b.write(i * 48_000, new Int16Array(480).fill(1), 1, 48000, 0);
    expect(b.trim(3 * 48_000 + 480)).toBe(4 * 960);
    expect(b.stats().chunks).toBe(6);
    expect(b.dropOldest()).toEqual({ end: 4 * 48_000 + 480, bytes: 960 });
    expect(b.firstStart).toBe(5 * 48_000);
  });
});

describe("PluginClock: the plugin's monotonic clock on the engine's", () => {
  it("takes the shortest round trip's estimate, slews small moves and measures drift", () => {
    const c = new PluginClock();
    // A plugin clock 7 000 000 ms ahead, running 50 ppm fast; round trips of 0.2 ms, some of 30 ms (busy moments).
    const plugin = (engineMs: number) => (engineMs * (1 + 50e-6) + 7_000_000) * 1000;
    for (let t = 0; t < 120_000; t += 1000) {
      const rtt = t % 7000 === 0 ? 30 : 0.2;
      c.onPong(t, t + rtt, plugin(t + rtt / 2));
    }
    const s = c.status();
    expect(s.source).toBe("ping");
    expect(s.steps).toBe(0);
    expect(s.rttMs).toBeCloseTo(0.2, 5);
    expect(s.driftPpm!).toBeGreaterThan(45);
    expect(s.driftPpm!).toBeLessThan(55);
    // Placement error now: under a millisecond.
    expect(Math.abs(c.toEngineMs(plugin(120_000)) - 120_000)).toBeLessThan(1);
  });

  it("before any ping, the audio bounds the offset; the first ping replaces it at once; a big jump is taken at once", () => {
    const c = new PluginClock();
    c.onAudio(5_000_000_000 + 100_000, 100);
    c.onAudio(5_000_000_000 + 110_000, 112);
    expect(c.status().source).toBe("audio");
    expect(c.toEngineMs(5_000_000_000 + 110_000)).toBeCloseTo(110, 6);
    c.onPong(200, 200.2, (5_000_000 + 200.1) * 1000);
    expect(c.status()).toMatchObject({ source: "ping", steps: 0 });
    expect(c.toEngineMs((5_000_000 + 300) * 1000)).toBeCloseTo(300, 3);
    // The computer slept, or the plugin's process restarted: a second's jump.
    c.onPong(1300, 1300.2, (5_000_000 + 2300.1) * 1000);
    expect(c.status().steps).toBe(1);
    expect(c.toEngineMs((5_000_000 + 2400) * 1000)).toBeCloseTo(1400, 3);
  });
});

describe("CommsMixer: gates after the buffers", () => {
  const src = (key: string, teamId: string, freq: number, include: Partial<MixSource["include"]> = {}): MixSource => {
    const buffer = new VoiceBuffer();
    buffer.write(0, tone(freq, 2000), 1, 48000, 0);
    return { key, teamId, buffer, levelDb: 0, include: { public: false, recording: false, preview: false, ...include } };
  };

  it("switching the public listen-in from one team to the other goes through silence, never both at once", () => {
    const m = new CommsMixer();
    const a = src("a", "A", 500, { public: true });
    const b = src("b", "B", 900, { public: true });
    m.setPublicTeam("A");
    const blocks = [];
    for (let i = 0; i < 40; i++) {
      if (i === 20) m.setPublicTeam("B");
      blocks.push(m.render(i * BLOCK, i * BLOCK, [a, b], () => true).out.public);
    }
    for (let i = 0; i < 40; i++) {
      const hasA = amplitudeAt(blocks[i]!, 500) > 0.01;
      const hasB = amplitudeAt(blocks[i]!, 900) > 0.01;
      expect(hasA && hasB).toBe(false);
    }
    // A closes over 40 ms (4 blocks), then B opens.
    expect(amplitudeAt(blocks[19]!, 500)).toBeCloseTo(0.25, 2);
    expect(amplitudeAt(blocks[25]!, 500)).toBeLessThan(0.001);
    expect(amplitudeAt(blocks[30]!, 900)).toBeCloseTo(0.25, 2);
  });

  it("is silent at start and when a team isn't ready, and the recording ignores the public gate", () => {
    const m = new CommsMixer();
    const a = src("a", "A", 500, { public: true, recording: true });
    const b0 = m.render(0, 0, [a], () => true);
    expect(b0.out.public.every((v) => v === 0)).toBe(true);
    expect(b0.public.team).toBeNull();
    m.setRecordingTeam("A");
    for (let i = 1; i < 5; i++) m.render(i * BLOCK, i * BLOCK, [a], () => true);
    expect(amplitudeAt(m.render(5 * BLOCK, 5 * BLOCK, [a], () => true).out.recording, 500)).toBeCloseTo(0.25, 2);
    // Not ready at the playhead: nothing is read, so silence at once (never other audio in its place).
    expect(m.render(6 * BLOCK, 6 * BLOCK, [a], () => false).out.recording.every((v) => v === 0)).toBe(true);
  });
});
