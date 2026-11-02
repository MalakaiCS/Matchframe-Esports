import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { SettingsRepo } from "../db/store.ts";
import type { Logger } from "../logger.ts";
import { MAX_DELAY_SEC, TRANSPORT_FLOOR_MS, type TeamComms } from "./service.ts";
import { BLOCK } from "./mixer.ts";
import type { StripSettings } from "./strip.ts";

/**
 * The recording's timing test (ADR-069; phase 4 left it for phase 5): MatchFrame puts a short beep
 * into the recording comms and lights every card of the speaker strip on the same 10 ms block, five
 * times a second apart, while the dedicated recording records. In the finished file (ffmpeg, as the
 * replays use it) it finds each beep's start in the sound and each flash's first frame in the strip's
 * area of the picture, and from their difference suggests:
 *
 * - **the strip's timing offset**, so the strip lights with the comms (both left the engine on the
 *   same block: what is left is the two paths in OBS, browser source and DistroAV);
 * - **the delay's fine ms**, when the delay is the one the marks suggested: those marks took off the
 *   comms' send latency to OBS but not what DistroAV and OBS add on the way in. That extra is the beep's
 *   lateness against the strip flash, taking the browser source to show the gameplay's frame (both
 *   are pictures in OBS, captured the same way).
 *
 * The beep goes into the recording output only (never public, never the preview), after the
 * recording's comms level; nothing in the mixes or the activity sees it.
 */

export const BEEP_HZ = 3150;
export const BEEP_MS = 200;
export const BEEP_EVERY_MS = 1000;
export const BEEPS = 5;
/** The beep's level in the recording output, and its ramps in and out (samples: 1 ms, no click). */
export const BEEP_AMP = 0.25;
export const BEEP_RAMP_SAMPLES = 48;
const LEAD_MS = 500;
const KEY = "comms.timingTest";
/** At most this much of a file is read when the test's place in it isn't known (s). */
const MAX_SCAN_SEC = 900;

export interface Interval {
  start: number;
  end: number;
}

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where the strip's cards are on the 1920×1080 canvas (the strip page's own layout). */
export function stripRegion(s: Pick<StripSettings, "anchor" | "offsetX" | "offsetY" | "cardPx" | "gapPx" | "labels">, cards: number): Region {
  const n = Math.max(1, cards);
  const w = n * s.cardPx + (n - 1) * s.gapPx;
  const h = Math.round(s.cardPx * 0.99) + (s.labels ? 30 : 0);
  const [v, hz] = s.anchor.split("-") as ["top" | "bottom", "left" | "center" | "right"];
  const x = hz === "left" ? s.offsetX : hz === "right" ? 1920 + s.offsetX - w : (1920 - w) / 2 + s.offsetX;
  const y = v === "top" ? s.offsetY : 1080 - s.offsetY - h;
  return { x, y, w, h };
}

/** Amplitude of `freq` in x[from, from+n) (Goertzel; a sine of amplitude A reads A). */
function tone(x: Int16Array, from: number, n: number, freq: number, rate: number): number {
  const k = 2 * Math.cos((2 * Math.PI * freq) / rate);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const s0 = x[from + i]! / 32768 + k * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return (2 * Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - k * s1 * s2))) / n;
}

/** Each beep's start (ms in the file): where the tone first reaches half of that beep's level. */
export function beepOnsets(pcm: Int16Array, rate: number, freq = BEEP_HZ): { onsets: number[]; peak: number } {
  const win = Math.round(rate * 0.005);
  const hop = Math.max(1, Math.round(rate * 0.001));
  const amps: number[] = [];
  for (let i = 0; i + win <= pcm.length; i += hop) amps.push(tone(pcm, i, win, freq, rate));
  const peak = amps.reduce((m, a) => Math.max(m, a), 0);
  const onsets: number[] = [];
  if (peak < 0.01) return { onsets, peak };
  const gate = peak * 0.3;
  const quietHops = Math.round(300 / (hop / (rate / 1000)));
  let quiet = quietHops;
  for (let j = 0; j < amps.length; j++) {
    if (amps[j]! < gate) {
      quiet++;
      continue;
    }
    if (quiet >= quietHops) {
      // This beep's own level (its next 100 ms), then back to where it first reached half of it.
      let local = 0;
      for (let m = j; m < Math.min(amps.length, j + 100); m++) local = Math.max(local, amps[m]!);
      let o = j;
      while (o > 0 && amps[o - 1]! >= local * 0.5) o--;
      while (o < j && amps[o]! < local * 0.5) o++;
      // The window's centre is where its level is half the tone's when the tone starts there.
      onsets.push(((o * hop + win / 2) / rate) * 1000);
    }
    quiet = 0;
  }
  return { onsets, peak };
}

/** Each flash's first frame (ms in the file): the strip area's active-colour count rising well above its idle level. */
export function flashOnsets(frames: { t: number; n: number }[]): number[] {
  if (frames.length < 3) return [];
  const sorted = frames.map((f) => f.n).sort((a, b) => a - b);
  const base = sorted[Math.floor(sorted.length * 0.2)]!;
  const top = sorted[sorted.length - 1]!;
  if (top - base < 8) return [];
  const gate = base + (top - base) * 0.3;
  const out: number[] = [];
  let lastLit = -Infinity;
  let lit = false;
  for (const f of frames) {
    if (f.n >= gate) {
      if (!lit && f.t - lastLit > 300) out.push(f.t);
      lit = true;
      lastLit = f.t;
    } else lit = false;
  }
  return out;
}

const hex = (c: string): [number, number, number] => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];

/** Pixels of a raw RGB frame nearer the active colour than the idle one, and close to it. */
export function activePixels(rgb: Buffer, active: string, idle: string): number {
  const [ar, ag, ab] = hex(active);
  const [ir, ig, ib] = hex(idle);
  let n = 0;
  for (let i = 0; i + 2 < rgb.length; i += 3) {
    const r = rgb[i]!;
    const g = rgb[i + 1]!;
    const b = rgb[i + 2]!;
    const da = (r - ar) ** 2 + (g - ag) ** 2 + (b - ab) ** 2;
    const di = (r - ir) ** 2 + (g - ig) ** 2 + (b - ib) ** 2;
    if (da < 90 ** 2 && da * 3 < di) n++;
  }
  return n;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((res, rej) => {
    const c = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const out: Buffer[] = [];
    let err = "";
    const timer = setTimeout(() => c.kill(), timeoutMs);
    c.stdout.on("data", (d: Buffer) => out.push(d));
    c.stderr.on("data", (d: Buffer) => {
      err += d.toString();
      if (err.length > 4_000_000) err = err.slice(-2_000_000);
    });
    c.on("error", (e) => {
      clearTimeout(timer);
      rej(e);
    });
    c.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) res({ stdout: Buffer.concat(out), stderr: err });
      else rej(new Error(`ffmpeg stopped (exit ${code}): ${err.trim().split("\n").slice(-3).join(" ")}`));
    });
  });
}

export interface FileAnalysis {
  file: string;
  width: number;
  height: number;
  frameMs: number;
  scannedFromSec: number;
  beeps: number[];
  flashes: number[];
  /** flash − beep (ms), per beep matched to a flash. */
  diffsMs: number[];
}

/** Finds the beeps (sound) and the strip's flashes (picture) in a recording file with ffmpeg. */
export async function analyseFile(ffmpeg: string, file: string, o: { region: Region; active: string; idle: string; fromSec?: number; durationSec?: number }): Promise<FileAnalysis> {
  const from = Math.max(0, o.fromSec ?? 0);
  const dur = o.durationSec ?? MAX_SCAN_SEC;
  const window = from > 0 ? ["-ss", from.toFixed(3)] : [];
  // The picture's size first (the canvas may not be 1920×1080).
  const probe = await run(ffmpeg, ["-hide_banner", "-i", file, "-map", "0:v:0", "-frames:v", "1", "-f", "null", "-"], 60_000).catch((e: Error) => ({ stdout: Buffer.alloc(0), stderr: e.message }));
  const size = /Video:.*?,\s(\d{2,5})x(\d{2,5})/.exec(probe.stderr);
  if (!size) throw new Error("No picture found in the file (is it a video recording?).");
  const width = Number(size[1]);
  const height = Number(size[2]);
  const sx = width / 1920;
  const sy = height / 1080;
  const margin = 4;
  const rx = Math.max(0, Math.floor(o.region.x * sx) - margin);
  const ry = Math.max(0, Math.floor(o.region.y * sy) - margin);
  const rw = Math.min(width - rx, Math.ceil(o.region.w * sx) + 2 * margin);
  const rh = Math.min(height - ry, Math.ceil(o.region.h * sy) + 2 * margin);
  if (rw < 4 || rh < 4) throw new Error("The strip's place is outside the picture (check the strip's position settings).");
  const factor = Math.max(1, Math.ceil(rw / 480));
  const ow = Math.max(2, Math.floor(rw / factor / 2) * 2);
  const oh = Math.max(2, Math.floor(rh / factor / 2) * 2);
  // One raw frame per decoded frame (never duplicated or dropped to a frame rate), each with its time.
  const vargs = (sync: string[]) => ["-hide_banner", ...window, "-t", String(dur), "-i", file, "-map", "0:v:0", "-vf", `crop=${rw}:${rh}:${rx}:${ry},scale=${ow}:${oh}:flags=neighbor,format=rgb24,showinfo`, ...sync, "-f", "rawvideo", "-"];
  const video = await run(ffmpeg, vargs(["-fps_mode", "passthrough"]), 600_000).catch(() => run(ffmpeg, vargs(["-vsync", "passthrough"]), 600_000));
  const times = [...video.stderr.matchAll(/pts_time:\s*([0-9.]+)/g)].map((m) => Number(m[1]) * 1000);
  const fsize = ow * oh * 3;
  const count = Math.min(times.length, Math.floor(video.stdout.length / fsize));
  const frames: { t: number; n: number }[] = [];
  for (let k = 0; k < count; k++) frames.push({ t: times[k]!, n: activePixels(video.stdout.subarray(k * fsize, (k + 1) * fsize), o.active, o.idle) });
  const gaps = frames.slice(1).map((f, i) => f.t - frames[i]!.t).sort((a, b) => a - b);
  const frameMs = gaps.length ? gaps[Math.floor(gaps.length / 2)]! : 0;
  // The sound from its first decoded frame, whose time (on the same timeline as the picture's frames:
  // an AAC track starts with its encoder's priming, at a negative time) places every sample.
  const audio = await run(ffmpeg, ["-hide_banner", ...window, "-t", String(dur), "-i", file, "-map", "0:a:0", "-af", "ashowinfo,aresample=16000", "-ac", "1", "-f", "s16le", "-"], 600_000);
  const audioStart = Number(/pts_time:\s*(-?[0-9.]+)/.exec(audio.stderr)?.[1] ?? 0) * 1000;
  const pcm = new Int16Array(audio.stdout.buffer, audio.stdout.byteOffset, Math.floor(audio.stdout.length / 2));
  const beeps = beepOnsets(Int16Array.from(pcm), 16000).onsets.map((t) => t + audioStart);
  const flashes = flashOnsets(frames);
  const diffsMs: number[] = [];
  for (const b of beeps) {
    let best: number | null = null;
    for (const f of flashes) if (Math.abs(f - b) <= 700 && (best === null || Math.abs(f - b) < Math.abs(best - b))) best = f;
    if (best !== null) diffsMs.push(best - b);
  }
  return { file, width, height, frameMs, scannedFromSec: from, beeps: beeps.map((x) => x + from * 1000), flashes: flashes.map((x) => x + from * 1000), diffsMs };
}

export interface TimingTestRun {
  /** The first beep's output time on the engine's timeline (ms) and wall time (ms since 1970). */
  firstBeepMs: number;
  firstBeepWall: number;
  beeps: number;
  everyMs: number;
  /** The recording's start (wall ms) and file then, if it was recording. */
  recordingStartWall: number | null;
  file: string | null;
  cards: number;
  strip: Pick<StripSettings, "anchor" | "offsetX" | "offsetY" | "cardPx" | "gapPx" | "labels" | "activeColor" | "idleColor" | "timingOffsetMs">;
  startedAt: string;
}

export interface TimingTestResult {
  file: string;
  analysedAt: string;
  beeps: number;
  flashes: number;
  pairs: number;
  /** flash − beep in the file (ms): median and spread. */
  medianMs: number;
  spreadMs: number;
  frameMs: number;
  suggestion: { stripOffsetMs: number; fineMs: number | null; delaySec: number | null; note: string };
  applied: boolean;
}

export class TimingTestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TimingTestError";
  }
}

export interface TimingTestDeps {
  comms: TeamComms;
  settings: SettingsRepo;
  logger: Pick<Logger, "info" | "warn">;
  now: () => number;
  wallNow?: () => number;
  /** The recording output: beeps added there (CommsOutputs.setBeeps). */
  setBeeps: (beeps: Interval[]) => void;
  /** The strip: every card lit on these blocks (SpeakerStrip.setForced). */
  setFlashes: (flashes: Interval[]) => void;
  strip: () => StripSettings;
  stripCards: () => number;
  setStripOffset: (ms: number) => void;
  recording: () => { state: string; startedAt: string | null; folder: string; file: { path: string } | null; last: { path: string | null } | null };
  /** The NDI output runs (the beep reaches OBS). */
  ndiRunning: () => boolean;
  ffmpeg: () => Promise<string | null>;
  /** The delay the marks' suggestion set last (null: none, or changed since). */
  calibratedDelayMs: () => number | null;
}

export class CommsTimingTest {
  private analysing = false;

  constructor(private readonly d: TimingTestDeps) {}

  private wall(): number {
    return this.d.wallNow ? this.d.wallNow() : Date.now();
  }

  private saved(): { run: TimingTestRun | null; result: TimingTestResult | null } {
    return this.d.settings.get<{ run: TimingTestRun | null; result: TimingTestResult | null }>(KEY, { run: null, result: null });
  }

  private save(v: { run: TimingTestRun | null; result: TimingTestResult | null }): void {
    this.d.settings.set(KEY, v);
  }

  /** Beeps and flashes from half a second from now, while the dedicated recording records. */
  start(): ReturnType<CommsTimingTest["status"]> {
    if (!this.d.comms.enabled) throw new TimingTestError(409, "comms_off", "Team Comms is off.");
    const rec = this.d.recording();
    if (rec.state !== "recording") throw new TimingTestError(409, "not_recording", "Start the dedicated recording first: the test is found in its file.");
    if (!this.d.ndiRunning()) throw new TimingTestError(409, "no_output", "The recording comms (NDI) aren't being sent: the beep wouldn't reach the recording.");
    const cards = this.d.stripCards();
    if (cards < 1) throw new TimingTestError(409, "no_cards", "The speaker strip shows nobody: include at least one person of the recording team in the recording (the test lights their cards).");
    const now = this.d.now();
    const firstSample = Math.ceil(((now + LEAD_MS) * 48) / BLOCK) * BLOCK;
    const beeps: Interval[] = [];
    for (let k = 0; k < BEEPS; k++) {
      const start = firstSample + k * BEEP_EVERY_MS * 48;
      beeps.push({ start, end: start + BEEP_MS * 48 });
    }
    this.d.setBeeps(beeps);
    this.d.setFlashes(beeps);
    const s = this.d.strip();
    const firstBeepMs = firstSample / 48;
    const r: TimingTestRun = {
      firstBeepMs,
      firstBeepWall: this.wall() + (firstBeepMs - now),
      beeps: BEEPS,
      everyMs: BEEP_EVERY_MS,
      recordingStartWall: rec.startedAt ? Date.parse(rec.startedAt) : null,
      file: rec.file?.path ?? null,
      cards,
      strip: { anchor: s.anchor, offsetX: s.offsetX, offsetY: s.offsetY, cardPx: s.cardPx, gapPx: s.gapPx, labels: s.labels, activeColor: s.activeColor, idleColor: s.idleColor, timingOffsetMs: s.timingOffsetMs },
      startedAt: new Date(this.wall()).toISOString(),
    };
    this.save({ run: r, result: null });
    this.d.logger.info("team comms timing test: beeps scheduled", { beeps: BEEPS, cards });
    return this.status();
  }

  /** A file the analysis may read: the recording's (now or last) or one in its folder. */
  private fileFor(given?: string): string {
    const rec = this.d.recording();
    const candidates = [rec.file?.path, rec.last?.path, this.saved().run?.file].filter((x): x is string => !!x);
    if (given) {
      const full = resolve(given);
      const folder = resolve(rec.folder);
      if (!candidates.map((c) => resolve(c)).includes(full) && !full.startsWith(folder + sep)) throw new TimingTestError(400, "bad_file", `Only a file of the dedicated recording (in ${rec.folder}) can be analysed.`);
      if (!existsSync(full) || !statSync(full).isFile()) throw new TimingTestError(404, "no_file", `No file ${full}.`);
      return full;
    }
    const f = candidates.find((c) => existsSync(c));
    if (!f) throw new TimingTestError(409, "no_file", "No recording file yet: stop the recording (or name its file).");
    return f;
  }

  /** Finds the test in the recording file and suggests the strip's offset and the fine ms. */
  async analyse(given?: string): Promise<TimingTestResult> {
    const st = this.saved();
    const run = st.run;
    if (!run) throw new TimingTestError(409, "no_test", "Run the timing test during a recording first.");
    if (this.analysing) throw new TimingTestError(409, "busy", "Already analysing.");
    const file = this.fileFor(given);
    const ffmpeg = await this.d.ffmpeg();
    if (!ffmpeg) throw new TimingTestError(409, "ffmpeg_missing", "ffmpeg isn't installed (Replays → Replay feed → Download ffmpeg).");
    this.analysing = true;
    try {
      // Where the test is in the file (roughly: the file starts about when Source Record started): a minute around it.
      const approx = run.recordingStartWall !== null ? (run.firstBeepWall - run.recordingStartWall) / 1000 : null;
      const from = approx !== null && approx > 20 ? approx - 15 : 0;
      const duration = approx !== null ? Math.max(30, (approx - from) + (run.beeps * run.everyMs) / 1000 + 20) : MAX_SCAN_SEC;
      const a = await analyseFile(ffmpeg, file, { region: stripRegion(run.strip, run.cards), active: run.strip.activeColor, idle: run.strip.idleColor, fromSec: from, durationSec: duration });
      if (a.diffsMs.length < 2) throw new TimingTestError(422, "not_found", `The test wasn't found in ${file}: ${a.beeps.length} beep(s) in the sound, ${a.flashes.length} flash(es) of the strip in the picture. Was the file recording during the test, with the strip and the recording comms in it?`);
      const xs = [...a.diffsMs].sort((p, q) => p - q);
      const mid = xs.length >> 1;
      const median = Math.round(xs.length % 2 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2);
      // flash − beep = D: the strip shows D after the comms. Strip offset: less D. The comms' extra path
      // in OBS: X = (offset then) − D, taken off the delay when it is the marks' suggestion.
      const stripOffsetMs = Math.max(-1000, Math.min(2000, run.strip.timingOffsetMs - median));
      const extra = run.strip.timingOffsetMs - median;
      const cfg = this.d.comms.settings();
      const current = cfg.delaySec * 1000 + cfg.fineMs;
      const calibrated = this.d.calibratedDelayMs();
      let fineMs: number | null = null;
      let delaySec: number | null = null;
      let note: string;
      if (calibrated !== null && calibrated === current) {
        const next = Math.max(TRANSPORT_FLOOR_MS, Math.min(MAX_DELAY_SEC * 1000 + 999, current - extra));
        delaySec = Math.min(MAX_DELAY_SEC, Math.floor(next / 1000));
        fineMs = next - delaySec * 1000;
        note = `The comms reach the recording ${extra} ms after the picture path (DistroAV and OBS): the delay from the marks becomes ${(next / 1000).toFixed(3)} s, and the strip's offset ${stripOffsetMs} ms so it lights with the comms.`;
      } else note = `The strip's offset ${stripOffsetMs} ms lights it with the comms. The delay was set by hand after the marks: check the comms against the gameplay in this file by eye and adjust the fine ms.`;
      const result: TimingTestResult = { file, analysedAt: new Date(this.wall()).toISOString(), beeps: a.beeps.length, flashes: a.flashes.length, pairs: a.diffsMs.length, medianMs: median, spreadMs: Math.round(xs[xs.length - 1]! - xs[0]!), frameMs: Math.round(a.frameMs * 10) / 10, suggestion: { stripOffsetMs, fineMs, delaySec, note }, applied: false };
      this.save({ run, result });
      this.d.logger.info("team comms timing test: analysed", { pairs: result.pairs, medianMs: median, spreadMs: result.spreadMs });
      return result;
    } finally {
      this.analysing = false;
    }
  }

  /** Applies the suggestion: the strip's timing offset, and the delay when it was suggested. */
  async apply(): Promise<TimingTestResult> {
    const st = this.saved();
    if (!st.result) throw new TimingTestError(409, "no_result", "Analyse a recording first.");
    this.d.setStripOffset(st.result.suggestion.stripOffsetMs);
    if (st.result.suggestion.delaySec !== null && st.result.suggestion.fineMs !== null) await this.d.comms.updateSettings({ delaySec: st.result.suggestion.delaySec, fineMs: st.result.suggestion.fineMs });
    const result = { ...st.result, applied: true };
    this.save({ run: st.run, result });
    return result;
  }

  status() {
    const st = this.saved();
    const now = this.d.now();
    const run = st.run;
    const endMs = run ? run.firstBeepMs + (run.beeps - 1) * run.everyMs + BEEP_MS : 0;
    return {
      running: run && now < endMs ? { startsInMs: Math.max(0, Math.round(run.firstBeepMs - now)), endsInMs: Math.round(endMs - now), beeps: run.beeps } : null,
      lastRun: run ? { startedAt: run.startedAt, beeps: run.beeps, cards: run.cards, file: run.file } : null,
      result: st.result,
      analysing: this.analysing,
      beep: { hz: BEEP_HZ, ms: BEEP_MS, everyMs: BEEP_EVERY_MS, count: BEEPS },
    };
  }
}
