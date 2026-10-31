import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database } from "../src/db/database.ts";
import { SettingsRepo } from "../src/db/store.ts";
import { ReplayFeed } from "../src/replay/feed.ts";
import { FfmpegTool } from "../src/replay/ffmpeg.ts";
import { AudioClock, toStereo48k } from "../src/replay/feed-core.ts";
import { fakeNdi, inProcessFeedWorker, lumaAt, lumaSteps, TONE_LEVEL, toneOnAt } from "./helpers/fake-ndi.ts";

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-hide_banner", "-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** The brightness (Y, as sent) of a clip's first frame, or of a frame `fromEndS` seconds before its end. */
function luma(file: string, fromEndS: number | null = null): number {
  const seek = fromEndS === null ? [] : ["-sseof", `-${fromEndS}`];
  return execFileSync("ffmpeg", ["-v", "error", ...seek, "-i", file, "-vf", "scale=2:2", "-pix_fmt", "yuv420p", "-frames:v", "1", "-f", "rawvideo", "pipe:"])[0]!;
}

const waitFor = async (fn: () => boolean, ms = 15000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

/**
 * The replay feed with a stand-in NDI source (real ffmpeg, libx264): it records one-second
 * segments stamped with real time and cuts a clip for any moment of the last minutes. The source's
 * brightness tells when each frame was sent, so the cuts are checked to the picture.
 */
describe.skipIf(!hasFfmpeg)("replay feed: recording the replay PC's screen and cutting clips", () => {
  let feed: ReplayFeed;
  const data = mkdtempSync(join(tmpdir(), "mf-feed-"));

  beforeAll(() => {
    const db = new Database(":memory:");
    db.migrate();
    const settings = new SettingsRepo(db);
    const log = { info: () => undefined, warn: () => undefined };
    feed = new ReplayFeed({ settings, logger: log, dataDir: data, ffmpeg: new FfmpegTool({ dataDir: data, logger: log }), spawnWorker: () => inProcessFeedWorker() });
    feed.start();
  });

  afterAll(() => feed.stop());

  it("asks for the source, then records it once chosen", async () => {
    expect(feed.status().state).toBe("off");
    const found = await feed.sources(500);
    expect(found).toEqual({ sources: [{ name: "REPLAY-PC (vMix Desktop Capture)" }], error: null });
    feed.setSettings({ enabled: true, encoder: "libx264", latencyMs: 0 });
    await waitFor(() => feed.status().state === "error");
    expect(feed.status().detail).toMatch(/NDI source/);
    feed.setSettings({ source: found.sources[0]! });
    await waitFor(() => feed.recording());
    const st = feed.status();
    expect(st).toMatchObject({ state: "recording", width: 320, height: 180, fps: 30, ndi: { available: true, version: "NDI SDK (stand-in)" }, ffmpeg: { source: "path", encoder: "libx264" } });
  }, 30000);

  it("cuts a clip from a moment a few seconds back: the picture of that moment, to the tenth of a second", async () => {
    await new Promise((r) => setTimeout(r, 6000));
    const to = Date.now() - 1500;
    const from = to - 3000;
    const out = join(data, "clip.mp4");
    const cut = await feed.cut(from, to, out);
    // It starts on the second (keyframe) at or before `from`, and ends at `to`.
    expect(cut.startWall).toBeLessThanOrEqual(from);
    expect(from - cut.startWall).toBeLessThan(1100);
    expect(Math.abs(cut.durationMs - (to - cut.startWall))).toBeLessThan(50);
    expect(cut).toMatchObject({ width: 320, height: 180, fps: 30 });
    expect(lumaSteps(luma(out), lumaAt(cut.startWall))).toBeLessThanOrEqual(2);
    expect(lumaSteps(luma(out, 0.1), lumaAt(to - 100))).toBeLessThanOrEqual(2);
    expect(feed.status().bufferedSec).toBeGreaterThan(5);
  }, 30000);

  it("records the replay PC's sound: a cut clip has an AAC stream with the source's tone, in time with the picture", async () => {
    await new Promise((r) => setTimeout(r, 1500));
    const to = Date.now() - 1200;
    const from = to - 3000;
    const out = join(data, "sound.mp4");
    const cut = await feed.cut(from, to, out);
    expect(cut.hasAudio).toBe(true);
    expect(feed.status().audio).toMatchObject({ recording: true });
    const streams = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,sample_rate,channels", "-of", "json", out]).toString()) as { streams: { codec_type: string; codec_name: string; sample_rate?: string; channels?: number }[] };
    expect(streams.streams.find((x) => x.codec_type === "audio")).toMatchObject({ codec_name: "aac", sample_rate: "48000", channels: 2 });

    // The picture: its brightness steps every 100 ms of wall time; each step shows on the first frame after it (within a frame, 33 ms;
    // ffmpeg puts the frames on a 30 fps grid, up to half a frame from when they came; this process can bring one late).
    const frames = execFileSync("ffmpeg", ["-v", "error", "-i", out, "-vf", "scale=2:2", "-pix_fmt", "gray", "-f", "rawvideo", "pipe:"], { maxBuffer: 64 * 1024 * 1024 });
    const steps: number[] = [];
    for (let f = 1; f * 4 < frames.length; f++) {
      if (frames[(f - 1) * 4] === frames[f * 4]) continue;
      const shown = cut.startWall + (f * 1000) / 30;
      steps.push(Math.round(shown / 100) * 100 - shown);
    }
    expect(steps.length).toBeGreaterThan(8);
    for (const d of steps) expect(d).toBeGreaterThan(-70);
    for (const d of steps) expect(d).toBeLessThan(60);

    // The sound (its left side), decoded: the tone is on for half a second, off for half a second, by wall time.
    const pcm = execFileSync("ffmpeg", ["-v", "error", "-i", out, "-map", "0:a", "-af", "pan=mono|c0=c0", "-ar", "48000", "-f", "f32le", "pipe:"], { maxBuffer: 64 * 1024 * 1024 });
    const samples = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4);
    const win = 480;
    const rms: number[] = [];
    for (let k = 0; (k + 1) * win <= samples.length; k++) {
      let sum = 0;
      for (let i = k * win; i < (k + 1) * win; i++) sum += samples[i]! ** 2;
      rms.push(Math.sqrt(sum / win));
    }
    // In 10 ms windows (those within 30 ms of a switch left out): how many agree with the source, the sound moved by `shift`.
    const agree = (shift: number) => {
      let n = 0;
      let ok = 0;
      rms.forEach((r, k) => {
        const t = cut.startWall + k * 10 + 5 + shift;
        const phase = ((t % 500) + 500) % 500;
        if (phase < 30 || phase > 470) return;
        n++;
        if (r > TONE_LEVEL / Math.SQRT2 / 2 === toneOnAt(t)) ok++;
      });
      return ok / n;
    };
    expect(rms.length).toBeGreaterThan(250);
    expect(agree(0)).toBeGreaterThan(0.95);
    // With the picture to within 30 ms: no shift of the sound agrees clearly better.
    const best = [-100, -80, -60, -40, -20, 20, 40, 60, 80, 100].filter((sh) => agree(sh) > agree(0) + 0.02);
    expect(best.filter((sh) => Math.abs(sh) > 30)).toEqual([]);
    // At the source's level (a 0.5 sine: 0.35).
    const loud = Math.max(...rms);
    expect(loud).toBeGreaterThan(0.32);
    expect(loud).toBeLessThan(0.38);
  }, 30000);

  it("waits for the segment holding the end of the clip when it is still being written", async () => {
    const to = Date.now() + 400;
    const out = join(data, "fresh.mp4");
    const cut = await feed.cut(to - 2000, to, out);
    expect(Math.abs(cut.durationMs - (to - cut.startWall))).toBeLessThan(50);
    expect(lumaSteps(luma(out, 0.1), lumaAt(to - 100))).toBeLessThanOrEqual(2);
  }, 30000);
});

describe("replay feed's sound on the picture's clock", () => {
  it("takes any channels and rate as 48 kHz stereo", () => {
    const f = (channels: number, sampleRate: number, samples: number) => {
      const data = Buffer.alloc(samples * channels * 4);
      for (let i = 0; i < samples; i++) for (let c = 0; c < channels; c++) data.writeFloatLE(c === 0 ? i / samples : -i / samples, (i * channels + c) * 4);
      return { channels, sampleRate, samples, data };
    };
    const stereo = toStereo48k(f(2, 48000, 480));
    expect(stereo.length).toBe(960);
    expect([stereo[2], stereo[3]]).toEqual([Math.fround(1 / 480), Math.fround(-1 / 480)]);
    // Mono: the one channel on both sides; eight channels: the first two.
    const mono = toStereo48k(f(1, 48000, 100));
    expect(mono[10]).toBe(mono[11]);
    expect(toStereo48k(f(8, 48000, 100)).length).toBe(200);
    // 44.1 kHz: as many samples as the same time at 48 kHz.
    expect(toStereo48k(f(2, 44100, 441)).length).toBe(960);
  });

  it("lays frames one after another as sent, fills a real gap with silence, ignores a moment this process was busy, follows a drifting clock, and fills silence for a source without sound", () => {
    const frame = (n: number) => new Float32Array(n * 2).fill(0.5);
    const bytes = (out: Buffer[]) => out.map((b) => b.length / 8);
    const c = new AudioClock(0);
    // 1600 samples (33.3 ms) ending at 100 ms: placed by its arrival.
    expect(bytes(c.frame(frame(1600), 100, 0))).toEqual([4800 - 1600, 1600]);
    // The next ones arrive late, or all at once after a busy moment: still straight after, as sent.
    expect(bytes(c.frame(frame(1600), 160, 1600 / 48))).toEqual([1600]);
    expect(bytes(c.frame(frame(1600), 400, 3200 / 48))).toEqual([1600]);
    expect(bytes(c.frame(frame(1600), 401, 4800 / 48))).toEqual([1600]);
    expect(c.written).toBe(4800 + 3 * 1600);
    // The sender skipped a second: a second of silence, then the frame.
    expect(bytes(c.frame(frame(1600), 1300, 1000 + 6400 / 48))).toEqual([48000, 1600]);
    // Without the sender's times: one after the other.
    const plain = new AudioClock(0);
    plain.frame(frame(1600), 1600 / 48);
    expect(bytes(plain.frame(frame(1600), 3200 / 48 + 80))).toEqual([1600]);

    // The sender's clock runs 4 % fast: the sound gets ahead of the picture, and is cut back once it is more than 60 ms ahead.
    const fast = new AudioClock(0);
    let sent = 0;
    let at = 1600 / 48;
    let cut = 0;
    for (let k = 0; k < 200; k++) {
      cut += 1600 - bytes(fast.frame(frame(1600), at, sent)).reduce((a, b) => a + b, 0);
      sent += 1600 / 48;
      at += 1600 / 48 / 1.04;
    }
    expect(cut).toBeGreaterThan(0);
    expect(Math.abs(fast.written - Math.round(at * 48))).toBeLessThan(0.07 * 48000 + 1600);

    // No sound at all: silence up to a moment behind now, once nothing has come for a while.
    const quiet = new AudioClock(0);
    expect(quiet.fill(200)).toBeNull();
    expect(quiet.fill(1000)!.length).toBe(850 * 48 * 8);
    expect(quiet.written).toBe(850 * 48);
  });
});

describe.skipIf(!hasFfmpeg)("replay feed from a source without sound", () => {
  it("records silence with the picture, so clips still have a sound track", async () => {
    const data = mkdtempSync(join(tmpdir(), "mf-feed-silent-"));
    const db = new Database(":memory:");
    db.migrate();
    const log = { info: () => undefined, warn: () => undefined };
    const feed = new ReplayFeed({ settings: new SettingsRepo(db), logger: log, dataDir: data, ffmpeg: new FfmpegTool({ dataDir: data, logger: log }), spawnWorker: () => inProcessFeedWorker(fakeNdi({ audio: false })) });
    feed.start();
    try {
      feed.setSettings({ enabled: true, encoder: "libx264", latencyMs: 0, source: { name: "REPLAY-PC (vMix Desktop Capture)" } });
      await waitFor(() => feed.recording());
      await new Promise((r) => setTimeout(r, 4000));
      const to = Date.now() - 1200;
      const out = join(data, "silent.mp4");
      const cut = await feed.cut(to - 2000, to, out);
      expect(cut.hasAudio).toBe(true);
      const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type:stream=duration", "-of", "json", out]).toString()) as { streams: { codec_type: string; duration?: string }[] };
      const audio = probe.streams.find((x) => x.codec_type === "audio");
      const video = probe.streams.find((x) => x.codec_type === "video");
      expect(audio).toBeTruthy();
      // The silence keeps up with the picture.
      expect(Math.abs(Number(audio!.duration) - Number(video!.duration))).toBeLessThan(0.3);
    } finally {
      feed.stop();
    }
  }, 30000);
});
