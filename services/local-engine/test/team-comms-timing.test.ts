import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ObsManager } from "@matchframe/obs-adapter";
import { BLOCK } from "../src/comms/mixer.ts";
import { CommsPublic } from "../src/comms/public.ts";
import { SpeakerStrip, StripSettings, type StripPictures } from "../src/comms/strip.ts";
import { analyseFile, BEEP_EVERY_MS, BEEP_HZ, BEEP_MS, BEEPS, beepOnsets, CommsTimingTest, flashOnsets, stripRegion, type TimingTestDeps } from "../src/comms/timing-test.ts";
import { Logger } from "../src/logger.ts";
import { Rig, TEAM_A } from "./helpers/comms-rig.ts";
import { FakeNdiWorker } from "./helpers/fake-ndi-worker.ts";
import { amplitudeAt } from "./helpers/fake-ts3-plugin.ts";

/**
 * The recording's timing test (ADR-069): a beep in the recording output and every strip card lit on
 * the same blocks (fixture: simulated clock, real bridge, stand-in plugin and NDI process), and its
 * analysis in a recording file (a file generated here with ffmpeg: a strip whose frame turns green and
 * beeps at known times), down to the suggested strip offset and fine ms. Not OBS: on the owner's PC
 * the file is Source Record's.
 */

const quiet = new Logger("error", null);
const LATENCY = 60;
const rigs: Rig[] = [];
const closers: (() => void)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) c();
  for (const r of rigs.splice(0)) await r.stop();
});

const ffmpegOk = (() => {
  try {
    execFileSync("ffmpeg", ["-hide_banner", "-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const run = promisify(execFile);

describe("the recording's timing test", () => {
  it("beeps in the recording output only (never public, preview or the mixes) and lights every strip card on exactly the beep's blocks", async () => {
    const r = new Rig();
    rigs.push(r);
    await r.start({ fineMs: 300 });
    await r.openTabs();
    for (const p of r.a.slice(0, 3)) r.set(p, { includeRecording: true, includeBroadcast: true });
    r.set(r.a[0]!, { preview: true });
    r.comms.setRecordingTeam(TEAM_A);
    const worker = new FakeNdiWorker();
    const pub = new CommsPublic({ comms: r.comms, settings: r.settings, logger: quiet, obs: new ObsManager(), now: () => r.sim, overlayPort: () => 1, liveScene: () => null, replayDuck: () => null, spawnNdiWorker: () => worker });
    closers.push(() => pub.stop());
    pub.sync();
    const cfg = StripSettings.parse({ timingOffsetMs: 40 });
    const pictures: StripPictures = { player: () => null, rosterOrder: () => [], defaultPicture: () => null, assetUrl: () => null };
    const strip = new SpeakerStrip({ comms: r.comms, settings: r.settings, config: () => cfg, pictures, overlayPort: () => 1, sendLatencyMs: () => LATENCY, commsAudible: () => true, now: () => r.sim, realtime: false });
    closers.push(() => strip.close());
    const preview: Float32Array[] = [];
    pub.outputs.preview.push = ((orig) => (x: Float32Array, s: number) => {
      preview.push(Float32Array.from(x));
      orig(x, s);
    })(pub.outputs.preview.push.bind(pub.outputs.preview));
    await r.run(500);
    pub.controller.listenIn(TEAM_A);
    const deps: TimingTestDeps = {
      comms: r.comms,
      settings: r.settings,
      logger: quiet,
      now: () => r.sim,
      setBeeps: (b) => pub.outputs.setBeeps(b),
      setFlashes: (f) => strip.setForced(f),
      strip: () => cfg,
      stripCards: () => strip.status().cards.length,
      setStripOffset: () => undefined,
      recording: () => ({ state: "recording", startedAt: new Date().toISOString(), folder: r.dir, file: null, last: null }),
      ndiRunning: () => pub.outputs.status().ndi.state === "running",
      ffmpeg: async () => null,
      calibratedDelayMs: () => null,
    };
    const tt = new CommsTimingTest(deps);
    // Refused without a recording or without anyone on the strip.
    expect(() => new CommsTimingTest({ ...deps, recording: () => ({ state: "idle", startedAt: null, folder: r.dir, file: null, last: null }) }).start()).toThrow(/Start the dedicated recording first/);
    expect(() => new CommsTimingTest({ ...deps, stripCards: () => 0 }).start()).toThrow(/include at least one person/);
    const st = tt.start();
    expect(st.running).toMatchObject({ beeps: BEEPS });
    const first = r.sim + st.running!.startsInMs;
    expect((first * 48) % BLOCK).toBe(0);
    // Two of them talk throughout (the recording and public carry them; the beep only the recording).
    await r.run(BEEPS * BEEP_EVERY_MS + 1500, () => r.a.slice(0, 2));
    const rec = new Map(worker.blocks.map((b) => [b.start, b.rec]));
    const pubOut = new Map(worker.blocks.map((b) => [b.start, b.pub]));
    for (let k = 0; k < BEEPS; k++) {
      const a = (first + k * BEEP_EVERY_MS) * 48;
      for (let s = a - 2 * BLOCK; s < a + BEEP_MS * 48 + 2 * BLOCK; s += BLOCK) {
        const inBeep = s >= a && s < a + BEEP_MS * 48;
        const amp = amplitudeAt(rec.get(s)!, BEEP_HZ);
        if (inBeep) expect(amp).toBeGreaterThan(0.2);
        else expect(amp).toBeLessThan(0.02);
        expect(amplitudeAt(pubOut.get(s)!, BEEP_HZ)).toBeLessThan(0.002);
        expect(amplitudeAt(r.out.recording.get(s)!, BEEP_HZ)).toBeLessThan(0.002);
      }
    }
    expect(preview.every((x) => amplitudeAt(x, BEEP_HZ) < 0.002)).toBe(true);
    // The public carries the voices (it is open), never the beep.
    expect(amplitudeAt(pubOut.get((first + 100) * 48)!, r.a[0]!.freq)).toBeGreaterThan(0.05);
    // The strip: all three cards from each beep's first block to its last, on the beep's own time.
    strip.flushUntil(r.sim + 10_000);
    const speaking = strip.log.filter((l) => l.msg.type === "strip-speaking").map((l) => ({ atMs: l.dueMs - LATENCY - cfg.timingOffsetMs, n: (l.msg as { speaking: string[] }).speaking.length }));
    for (let k = 0; k < BEEPS; k++) {
      const a = first + k * BEEP_EVERY_MS;
      const on = speaking.find((m) => m.atMs === a);
      expect(on?.n).toBe(3);
      // Lit through the beep; after it, back to who speaks (the two talking: never the third).
      const after = speaking.filter((m) => m.atMs > a && m.atMs <= a + BEEP_MS + 20);
      expect(after.map((m) => m.atMs)).toEqual([a + BEEP_MS]);
      expect(after[0]!.n).toBe(2);
    }
  });

  it("finds the beeps and the strip's flashes in the sound and picture with their own detectors", () => {
    // 16 kHz, a beep at 1.000 s and 2.500 s over a little noise.
    const rate = 16000;
    const pcm = new Int16Array(rate * 4);
    for (let i = 0; i < pcm.length; i++) {
      const t = i / rate;
      const on = (t >= 1 && t < 1.2) || (t >= 2.5 && t < 2.7);
      pcm[i] = Math.round((on ? 0.25 * Math.sin(2 * Math.PI * BEEP_HZ * t) : 0) * 32767 + (Math.random() - 0.5) * 300);
    }
    const b = beepOnsets(pcm, rate);
    expect(b.onsets).toHaveLength(2);
    expect(Math.abs(b.onsets[0]! - 1000)).toBeLessThan(2);
    expect(Math.abs(b.onsets[1]! - 2500)).toBeLessThan(2);
    const frames = Array.from({ length: 120 }, (_, k) => ({ t: (k * 1000) / 30, n: (k >= 33 && k < 39) || (k >= 78 && k < 84) ? 400 : 3 }));
    expect(flashOnsets(frames)).toEqual([1100, 2600]);
    // The strip's place: five cards bottom-centre by default.
    expect(stripRegion(StripSettings.parse({}), 5)).toEqual({ x: (1920 - (5 * 132 + 4 * 8)) / 2, y: 1080 - 40 - 131, w: 5 * 132 + 4 * 8, h: 131 });
    expect(stripRegion(StripSettings.parse({ anchor: "top-left", offsetX: 20, offsetY: 30 }), 2)).toMatchObject({ x: 20, y: 30 });
  });

  it.skipIf(!ffmpegOk)("in a recording file (made here with ffmpeg: the strip turning green 120 ms after each beep): finds every beep and flash, suggests the strip offset and the fine ms, and applies them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mf-timing-"));
    const file = join(dir, "MatchFrame Comms NL 2026-11-01 12-00-00.mkv");
    // 640×360 at 30 fps: two cards bottom-centre (the default layout for two, scaled by 1/3), grey frames,
    // green frames at 1, 2, 3, 4, 5 s for 200 ms; beeps 120 ms earlier (the comms arrive first).
    const region = stripRegion(StripSettings.parse({}), 2);
    const sx = 640 / 1920;
    const card = (i: number, color: string, enable = "") => `drawbox=x=${Math.round((region.x + i * 140) * sx)}:y=${Math.round(region.y * sx)}:w=${Math.round(132 * sx)}:h=${Math.round(131 * sx)}:color=${color}:t=4${enable}`;
    const flashes = [1, 2, 3, 4, 5];
    // (A frame's t is n/30 in floating point: frame 30 is 0.99999…; the window starts just before.)
    const lit = `:enable='${flashes.map((t) => `between(t,${(t - 0.005).toFixed(3)},${(t + 0.195).toFixed(3)})`).join("+")}'`;
    const beeps = flashes.map((t) => t - 0.12);
    const tone = `0.25*sin(2*PI*${BEEP_HZ}*t)*(${beeps.map((t) => `between(t,${t.toFixed(3)},${(t + 0.2).toFixed(3)})`).join("+")})`;
    await run("ffmpeg", ["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "color=c=0x203040:s=640x360:r=30:d=7", "-f", "lavfi", "-i", `aevalsrc='${tone}':s=48000:d=7`, "-vf", [card(0, "0x808086"), card(1, "0x808086"), card(0, "0x20FF00", lit), card(1, "0x20FF00", lit)].join(","), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", file], { timeout: 60_000 });
    const a = await analyseFile("ffmpeg", file, { region, active: "#20FF00", idle: "#808086" });
    expect(a).toMatchObject({ width: 640, height: 360 });
    expect(a.beeps).toHaveLength(5);
    expect(a.flashes).toHaveLength(5);
    expect(a.diffsMs).toHaveLength(5);
    // On the file's own timeline (the AAC track's priming puts both 21 ms later here): one second apart, in step.
    for (let k = 1; k < 5; k++) expect(Math.abs(a.beeps[k]! - a.beeps[k - 1]! - 1000)).toBeLessThan(2);
    for (let k = 1; k < 5; k++) expect(Math.abs(a.flashes[k]! - a.flashes[k - 1]! - 1000)).toBeLessThan(2);
    for (const [k, t] of beeps.entries()) expect(Math.abs(a.beeps[k]! - t * 1000)).toBeLessThan(25);
    // flash − beep: 120 ms (the beep's 1 ms ramp and the frame's own time: within a few ms).
    for (const d of a.diffsMs) expect(Math.abs(d - 120)).toBeLessThanOrEqual(3);
    expect(a.frameMs).toBeCloseTo(1000 / 30, 0);

    // Through the test itself: the run's settings, the file analysed, the suggestion, applied.
    const r = new Rig();
    rigs.push(r);
    await r.start({ delaySec: 90, fineMs: 0 });
    const applied: number[] = [];
    const tt = new CommsTimingTest({
      comms: r.comms,
      settings: r.settings,
      logger: quiet,
      now: () => r.sim,
      setBeeps: () => undefined,
      setFlashes: () => undefined,
      strip: () => StripSettings.parse({ timingOffsetMs: 50 }),
      stripCards: () => 2,
      setStripOffset: (ms) => applied.push(ms),
      recording: () => ({ state: "recording", startedAt: null, folder: dir, file: { path: file }, last: null }),
      ndiRunning: () => true,
      ffmpeg: async () => "ffmpeg",
      // The delay in use is the one the marks set.
      calibratedDelayMs: () => 90_000,
    });
    tt.start();
    await expect(tt.analyse(join(tmpdir(), "elsewhere.mkv"))).rejects.toThrow(/Only a file of the dedicated recording/);
    const res = await tt.analyse();
    expect(res).toMatchObject({ file, beeps: 5, flashes: 5, pairs: 5 });
    expect(Math.abs(res.medianMs - 120)).toBeLessThanOrEqual(3);
    // Strip: 50 − D; the comms' extra path X = 50 − D (≈ −70: here the picture is late, not the sound) off the delay.
    expect(res.suggestion.stripOffsetMs).toBe(50 - res.medianMs);
    expect(res.suggestion.delaySec! * 1000 + res.suggestion.fineMs!).toBe(90_000 - (50 - res.medianMs));
    const done = await tt.apply();
    expect(done.applied).toBe(true);
    expect(applied).toEqual([50 - res.medianMs]);
    expect(r.comms.settings().delaySec * 1000 + r.comms.settings().fineMs).toBe(90_000 - (50 - res.medianMs));
    // A delay set by hand since the marks: only the strip is suggested.
    const byHand = new CommsTimingTest({ ...(tt as unknown as { d: TimingTestDeps }).d, calibratedDelayMs: () => null });
    const res2 = await byHand.analyse();
    expect(res2.suggestion).toMatchObject({ fineMs: null, delaySec: null });
    expect(res2.suggestion.note).toMatch(/set by hand/);
  }, 120_000);
});
