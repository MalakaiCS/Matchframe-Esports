import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database } from "../src/db/database.ts";
import { SettingsRepo } from "../src/db/store.ts";
import { ReplayFeed } from "../src/replay/feed.ts";
import { FfmpegTool } from "../src/replay/ffmpeg.ts";
import { COUNTER_ROWS, fakeNdi, type FakeNdiOptions, inProcessFeedWorker, lumaAt, lumaSteps, TONE_LEVEL, toneOnAt } from "./helpers/fake-ndi.ts";

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

/**
 * ffmpeg behind for a moment (0.10.12's support file: "can't keep up with the picture: the recording
 * starts again" six times in 25 minutes, each a gap): frames are dropped instead, the recording skips
 * ahead, and the times clips are cut by still hold. Only an ffmpeg that takes nothing for seconds
 * starts the recording again.
 */
describe.skipIf(!hasFfmpeg)("replay feed: an encoder that falls behind for a moment", () => {
  /** A real ffmpeg behind a pipe that stops reading for `stallMs` once, `atMs` after it starts (or for good). */
  const stalling = (atMs: number, stallMs: number | "forever") => {
    const dir = mkdtempSync(join(tmpdir(), "mf-stall-ffmpeg-"));
    const wrapper = join(dir, "ffmpeg");
    writeFileSync(
      wrapper,
      `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const out = process.argv[process.argv.length - 1];
${stallMs === "forever" ? `require("node:fs").writeFileSync(out.replace("%06d", "000000"), "");` : ""}
const ff = ${stallMs === "forever" ? "null" : `spawn("ffmpeg", process.argv.slice(2), { stdio: process.argv.includes("pipe:3") ? ["pipe", "ignore", "inherit", 3] : ["pipe", "ignore", "inherit"] })`};
const start = Date.now();
let stalled = false;
process.stdin.on("data", (b) => {
  if (ff && !ff.stdin.write(b)) { process.stdin.pause(); ff.stdin.once("drain", () => { if (!stalledNow()) process.stdin.resume(); }); }
  if (!stalled && Date.now() - start > ${atMs}) {
    stalled = true;
    process.stdin.pause();
    ${stallMs === "forever" ? "" : `setTimeout(() => process.stdin.resume(), ${stallMs});`}
  }
});
const stalledNow = () => stalled && ${stallMs === "forever" ? "true" : `Date.now() - start < ${atMs + stallMs}`};
process.stdin.on("end", () => ff ? ff.stdin.end() : process.exit(0));
if (ff) ff.on("exit", (c) => process.exit(c ?? 0));
else setInterval(() => undefined, 1000);
`,
    );
    chmodSync(wrapper, 0o755);
    return wrapper;
  };

  it("drops frames and skips ahead rather than starting again, and clips are still cut on time", async () => {
    const warned: string[] = [];
    const { feed, data } = feedOf({ fps: 60, audio: false, counter: true }, stalling(3000, 3000), warned);
    try {
      await waitFor(() => feed.recording());
      // ffmpeg takes nothing for 3 s, then catches up (the recording used to start again then: a gap in it).
      await new Promise((r) => setTimeout(r, 9000));
      const d = feed.status().diagnostics!;
      expect(warned.filter((m) => /starts again|stopped/.test(m))).toEqual([]);
      expect(d.restarts).toBe(0);
      expect(d.encoderDropped).toBeGreaterThan(40);
      expect(d.skippedMs).toBeGreaterThan(500);
      expect(d.skippedMs).toBeLessThan(3000);
      expect(feed.status().state).toBe("recording");
      // The brightness below the counter of a clip's first frame, or of one `fromEnd` seconds before its end.
      const lumaOf = (file: string, fromEnd: number | null) => execFileSync("ffmpeg", ["-v", "error", ...(fromEnd === null ? [] : ["-sseof", `-${fromEnd}`]), "-i", file, "-vf", "crop=320:100:0:60,scale=2:2:flags=area", "-pix_fmt", "yuv420p", "-frames:v", "1", "-f", "rawvideo", "pipe:"])[0]!;
      // A clip across the moment ffmpeg fell behind: it ends on its moment (to 0.2 s; it would be 1 s off had the skip not been counted),
      // and is its own length, the time skipped not in it. (Its start may be in the second or so the picture froze then.)
      const to = Date.now() - 1500;
      const across = join(data, "across.mp4");
      const a = await feed.cut(to - 6000, to, across);
      expect(lumaSteps(lumaOf(across, 0.1), lumaAt(to - 100))).toBeLessThanOrEqual(2);
      const len = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", across]).toString()) * 1000;
      expect(Math.abs(len - a.durationMs)).toBeLessThan(150);
      expect(a.durationMs).toBeLessThan(to - a.startWall - 600);
      // A clip after it: its first and last frames those of its moments.
      const after = join(data, "after.mp4");
      const b = await feed.cut(to - 1200, to, after);
      expect(lumaSteps(lumaOf(after, null), lumaAt(b.startWall))).toBeLessThanOrEqual(2);
      expect(lumaSteps(lumaOf(after, 0.1), lumaAt(to - 100))).toBeLessThanOrEqual(2);
    } finally {
      feed.stop();
    }
  }, 40000);

  it("starts the recording again when ffmpeg takes nothing for several seconds", async () => {
    const warned: string[] = [];
    const { feed } = feedOf({ fps: 60, audio: false }, stalling(1500, "forever"), warned);
    try {
      await waitFor(() => feed.status().state === "recording");
      await waitFor(() => (feed.status().diagnostics?.restarts ?? 0) >= 1, 15000);
      expect(warned).toContain("ffmpeg (libx264) took no picture for 5 s: the recording starts again");
    } finally {
      feed.stop();
    }
  }, 30000);
});

/** A feed recording a stand-in NDI source with real ffmpeg (or `ffmpeg`), from a fresh data folder; `warned` gets its warnings. */
function feedOf(opts: FakeNdiOptions, ffmpeg?: string, warned: string[] = []) {
  const data = mkdtempSync(join(tmpdir(), "mf-feed-busy-"));
  const db = new Database(":memory:");
  db.migrate();
  const log = { info: () => undefined, warn: (_msg: string, d?: Record<string, unknown>) => void warned.push(String(d?.message ?? _msg)) };
  const tool = new FfmpegTool({ dataDir: data, logger: log });
  if (ffmpeg) Object.assign(tool, { locate: async () => ffmpeg, pickEncoder: async () => "libx264" });
  const feed = new ReplayFeed({ settings: new SettingsRepo(db), logger: log, dataDir: data, ffmpeg: tool, spawnWorker: () => inProcessFeedWorker(fakeNdi(opts)) });
  feed.start();
  feed.setSettings({ enabled: true, encoder: "libx264", latencyMs: 0, source: { name: "REPLAY-PC (vMix Desktop Capture)" } });
  return { feed, data };
}

/** The frame numbers a clip shows, frame by frame (the stand-in's counter: 16 blocks along the top). */
function frameNumbers(file: string): number[] {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-fps_mode", "passthrough", "-vf", `crop=320:${COUNTER_ROWS}:0:0,scale=16:1:flags=area`, "-pix_fmt", "gray", "-f", "rawvideo", "pipe:"], { maxBuffer: 64 * 1024 * 1024 });
  const out: number[] = [];
  for (let f = 0; f + 16 <= raw.length; f += 16) {
    let n = 0;
    for (let bit = 0; bit < 16; bit++) if (raw[f + bit]! > 125) n |= 1 << bit;
    out.push(n);
  }
  return out;
}

/** Breaks in a clip's 1 kHz tone (its left side): 5 ms stretches where its level falls or its phase jumps (silence put in, samples cut, a click). */
function toneBreaks(file: string): { breaks: number; minLevel: number } {
  const pcm = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-map", "0:a", "-af", "pan=mono|c0=c0", "-ar", "48000", "-f", "f32le", "pipe:"], { maxBuffer: 64 * 1024 * 1024 });
  const x = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4);
  const w = (2 * Math.PI * 1000) / 48000;
  let breaks = 0;
  let minLevel = Infinity;
  let last: number | null = null;
  let lastBreak = -Infinity;
  // 5 ms windows (five periods), from 50 ms in to 50 ms before the end (the AAC encoder's edges).
  for (let s = 2400; s + 240 <= x.length - 2400; s += 120) {
    let i = 0;
    let q = 0;
    for (let k = s; k < s + 240; k++) {
      i += x[k]! * Math.cos(w * k);
      q += x[k]! * Math.sin(w * k);
    }
    const level = (2 * Math.hypot(i, q)) / 240;
    const phase = Math.atan2(q, i);
    let jump = last === null ? 0 : Math.abs(phase - last);
    if (jump > Math.PI) jump = 2 * Math.PI - jump;
    last = phase;
    minLevel = Math.min(minLevel, level);
    if (level < TONE_LEVEL * 0.8 || jump > 0.3) {
      if (s - lastBreak > 960) breaks++;
      lastBreak = s;
    }
  }
  return { breaks, minLevel };
}

/**
 * A busy screen capture on a busy computer, as NDI Screen Capture at 1080p60 with its sound on the
 * owner's two PCs (here 320×180): 60 fps whose timestamps jitter by up to 4 ms, sound in 10 ms frames
 * stamped up to 25 ms late, every frame arriving up to 15 ms late, and this computer busy for 150 ms
 * every 1.3 s (what came meanwhile arrives at once). Timed by arrival, this recorded repeated and
 * skipped frames (judder), and the sound had silence put in and samples cut (crackle).
 */
describe.skipIf(!hasFfmpeg)("replay feed from a busy 60 fps screen capture", () => {
  it("records every frame once at a constant 60 fps and the sound without a break, and cuts on time", async () => {
    const { feed, data } = feedOf({ fps: 60, counter: true, tone: "continuous", audioFrame: 480, jitterMs: 4, audioJitterMs: 25, arrivalJitterMs: 15, stalls: { everyMs: 1300, ms: 150 } });
    try {
      await waitFor(() => feed.recording());
      await new Promise((r) => setTimeout(r, 6000));
      const to = Date.now() - 1200;
      const from = to - 3000;
      const out = join(data, "busy.mp4");
      const cut = await feed.cut(from, to, out);
      expect(cut).toMatchObject({ fps: 60, hasAudio: true });
      // The picture: each frame the source sent, once, in order.
      const shown = frameNumbers(out);
      expect(shown.length).toBeGreaterThan(170);
      const steps = shown.slice(1).map((n, k) => n - shown[k]!);
      expect(steps.filter((d) => d !== 1)).toEqual([]);
      const pts = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "frame=pts_time", "-of", "csv=p=0", out]).toString().trim().split("\n").map(Number);
      const gaps = pts.slice(1).map((t, k) => Math.round((t - pts[k]!) * 1e4) / 1e4);
      expect(new Set(gaps)).toEqual(new Set([0.0167]));
      // The cut: its first and last frames are those of its moments (to 0.2 s), read from the brightness under the counter.
      const lumaBelow = (fromEnd: number | null) => execFileSync("ffmpeg", ["-v", "error", ...(fromEnd === null ? [] : ["-sseof", `-${fromEnd}`]), "-i", out, "-vf", "crop=320:100:0:60,scale=2:2:flags=area", "-pix_fmt", "yuv420p", "-frames:v", "1", "-f", "rawvideo", "pipe:"])[0]!;
      expect(lumaSteps(lumaBelow(null), lumaAt(cut.startWall))).toBeLessThanOrEqual(2);
      expect(lumaSteps(lumaBelow(0.1), lumaAt(to - 100))).toBeLessThanOrEqual(2);
      // The sound: the tone unbroken, at its level.
      const tone = toneBreaks(out);
      expect(tone.breaks).toBe(0);
      expect(tone.minLevel).toBeGreaterThan(TONE_LEVEL * 0.8);
      const d = feed.status().diagnostics!;
      expect(d).toMatchObject({ sourceFps: 60, timing: "timecode", skipped: 0, encoderDropped: 0, audio: { dropouts: 0, joins: 0 } });
      expect(d.repeated).toBe(0);
      expect(feed.status().losses).toEqual([]);
    } finally {
      feed.stop();
    }
  }, 40000);

  it("says where frames are lost: a source sending fewer than it declares, and NDI dropping some", async () => {
    const { feed } = feedOf({ fps: 60, sendFps: 50, ndiDropEvery: 25 });
    try {
      await waitFor(() => feed.recording());
      await new Promise((r) => setTimeout(r, 4500));
      const st = feed.status();
      expect(st.encoder).toBe("libx264");
      expect(st.diagnostics!.ndi!.videoDropped).toBeGreaterThan(0);
      const where = st.losses.map((l) => l.where);
      expect(where).toContain("arriving");
      expect(st.losses.find((l) => l.where === "arriving")!.text).toMatch(/^Not arriving from the replay PC: 4\d of 60 frames a second arrive, and NDI dropped \d+\.$/);
      expect(where).toContain("gaps");
      expect(where).not.toContain("encoder");
    } finally {
      feed.stop();
    }
  }, 30000);

  it("says when this computer's encoder is behind (an ffmpeg that reads too slowly), and which encoder", async () => {
    // A stand-in for ffmpeg that starts its first segment and then takes about 40 of the 60 frames a second.
    const dir = mkdtempSync(join(tmpdir(), "mf-slow-ffmpeg-"));
    const slow = join(dir, "ffmpeg");
    writeFileSync(slow, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.argv[process.argv.length - 1].replace("%06d", "000000"), "");\nlet got = 0;\nconst start = Date.now();\nprocess.stdin.on("data", (b) => { got += b.length; const ahead = got / (320 * 180 * 2 * 40) * 1000 - (Date.now() - start); if (ahead > 0) { process.stdin.pause(); setTimeout(() => process.stdin.resume(), ahead); } });\n`);
    chmodSync(slow, 0o755);
    const { feed } = feedOf({ fps: 60, audio: false }, slow);
    try {
      await waitFor(() => feed.status().state === "recording");
      await new Promise((r) => setTimeout(r, 5000));
      const st = feed.status();
      expect(st.diagnostics!.encoderDropped).toBeGreaterThan(20);
      const enc = st.losses.find((l) => l.where === "encoder")!;
      expect(enc.text).toMatch(/^This computer's encoder \(x264 on the CPU\) is behind: \d+ frames not recorded\.$/);
      expect(enc.hint).toMatch(/choose your graphics card's encoder/);
    } finally {
      feed.stop();
    }
  }, 30000);
});
