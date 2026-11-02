import { execFile, fork } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import type { SettingsRepo } from "../db/store.ts";
import type { Logger } from "../logger.ts";
import type { FeedDiagnostics, NdiSource } from "./feed-core.ts";
import type { WorkerReply, WorkerRequest } from "./feed-worker.ts";
import type { Encoder, FfmpegStatus, FfmpegTool } from "./ffmpeg.ts";
import { ENCODERS } from "./ffmpeg.ts";

const run = promisify(execFile);

/**
 * The replay feed on the main PC: the replay PC's whole screen comes in
 * over NDI (vMix Desktop Capture, OBS's NDI output or NDI Screen Capture on the replay PC), and this
 * computer records it all the time into one-second segments, keeping the last few minutes. The
 * replay PC only tells this computer when it filmed a kill (POST /api/v1/replays/mark), and the clip
 * is cut here from the recording: the replay PC needs no OBS. The NDI binding and the frames live
 * in the feed's own process (feed-worker.ts); ffmpeg comes from replay/ffmpeg.ts. The source's sound
 * (the replay PC's game, when its NDI sender sends it) is recorded too, and the clips carry it.
 */

export const FeedSettings = z.object({
  enabled: z.boolean().default(false),
  /** The replay PC's NDI source, as NDI lists it ("REPLAY-PC (vMix Desktop Capture)"). */
  source: z.object({ name: z.string().min(1).max(200), urlAddress: z.string().max(200).optional() }).nullable().default(null),
  /** How long the picture takes to arrive over NDI (ms): clips are cut this much later. */
  latencyMs: z.number().int().min(0).max(2000).default(100),
  /** The recording kept (seconds). */
  keepSeconds: z.number().int().min(60).max(900).default(240),
  encoder: z.enum(["auto", ...ENCODERS]).default("auto"),
  bitrateMbps: z.number().int().min(4).max(60).default(20),
});
export type FeedSettings = z.infer<typeof FeedSettings>;
export const FeedPatch = z.object({
  enabled: z.boolean().optional(),
  source: FeedSettings.shape.source.unwrap().optional(),
  latencyMs: FeedSettings.shape.latencyMs.unwrap().optional(),
  keepSeconds: FeedSettings.shape.keepSeconds.unwrap().optional(),
  encoder: FeedSettings.shape.encoder.unwrap().optional(),
  bitrateMbps: FeedSettings.shape.bitrateMbps.unwrap().optional(),
});

export interface FeedStatus {
  enabled: boolean;
  state: "off" | "starting" | "waiting" | "recording" | "error";
  detail: string;
  source: NdiSource | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  /** Frames a second arriving now, and frames not recorded because the encoder fell behind. */
  receivingFps: number;
  dropped: number;
  /** The encoder this recording uses (ffmpeg's name), while it records. */
  encoder: Encoder | null;
  /** What the recording has seen and done since it started (the support file carries it). */
  diagnostics: FeedDiagnostics | null;
  /** Where frames are being lost (the last 10 s), each with what to do; empty when none are. */
  losses: FeedLoss[];
  /** How much of the recording is kept now (seconds). */
  bufferedSec: number;
  ndi: { available: boolean | null; version: string | null; error: string | null };
  ffmpeg: FfmpegStatus;
  clips: number;
  /** The recording's sound: recorded (with silence where the source sends none), or why not. */
  audio: { recording: boolean; detail: string } | null;
}

/** Frames lost, and where: not arriving from the replay PC, this computer's encoder behind, or gaps in what arrived (repeated frames). */
export interface FeedLoss {
  where: "arriving" | "encoder" | "gaps";
  /** Frames lost (or repeated) in the last `seconds`. */
  frames: number;
  seconds: number;
  text: string;
  hint: string;
}

/** ffmpeg's encoders in words. */
const ENCODER_NAMES: Record<Encoder, string> = { h264_nvenc: "NVIDIA NVENC", h264_qsv: "Intel Quick Sync", h264_amf: "AMD AMF", libx264: "x264 on the CPU" };

/** Losses are judged over this long. */
const LOSS_WINDOW_MS = 10_000;

/** Where frames were lost between two of the recording's counts (`a` earlier), in plain words with a hint each. */
export function feedLosses(a: { at: number; d: FeedDiagnostics }, b: { at: number; d: FeedDiagnostics }, encoder: Encoder | null, auto: boolean): FeedLoss[] {
  const seconds = Math.round((b.at - a.at) / 1000);
  if (seconds < 3) return [];
  const out: FeedLoss[] = [];
  const received = b.d.received - a.d.received;
  const fps = received / ((b.at - a.at) / 1000);
  const ndi = b.d.ndi && a.d.ndi ? Math.max(0, b.d.ndi.videoDropped - a.d.ndi.videoDropped) : 0;
  const src = b.d.sourceFps;
  const short = src ? Math.max(0, Math.round(src * ((b.at - a.at) / 1000) - received)) : 0;
  if ((src && fps < src * 0.95) || ndi > 0) {
    const what = src && fps < src * 0.95 ? `${Math.round(fps)} of ${Math.round(src)} frames a second arrive` : `${Math.round(fps)} frames a second arrive`;
    out.push({ where: "arriving", frames: short + ndi, seconds, text: `Not arriving from the replay PC: ${what}${ndi ? `, and NDI dropped ${ndi}` : ""}.`, hint: "Use a wired gigabit network between the two PCs, and cap CS2's frame rate on the replay PC (fps_max) so its NDI sender keeps up." });
  }
  const enc = b.d.encoderDropped - a.d.encoderDropped;
  if (enc > 0) {
    const name = encoder ? ENCODER_NAMES[encoder] : "ffmpeg";
    const hint =
      encoder === "libx264"
        ? auto
          ? "x264 encodes on the CPU (no graphics card encoder works here): close what you can on this PC, or lower the bitrate."
          : "x264 encodes on the CPU: choose your graphics card's encoder (NVIDIA, Intel or AMD) under Encoder."
        : `Close other programs using ${name} or the CPU on this PC, or lower the bitrate.`;
    out.push({ where: "encoder", frames: enc, seconds, text: `This computer's encoder (${name}) is behind: ${enc} frames not recorded.`, hint });
  }
  // Repeats the encoder caused are its own; the rest fill gaps in what arrived.
  const gaps = Math.max(0, b.d.repeated - a.d.repeated - enc);
  const written = b.d.written - a.d.written;
  if (gaps > Math.max(3, written / 100)) {
    out.push({ where: "gaps", frames: gaps, seconds, text: `${gaps} frames repeated to fill gaps in what arrived.`, hint: "The replay PC's NDI sender isn't sending steadily: cap CS2's frame rate there so its screen capture keeps up, and use a wired network." });
  }
  return out;
}

/** The engine's end of the feed process. */
export interface FeedWorker {
  send(req: WorkerRequest): void;
  onMessage(fn: (r: WorkerReply) => void): void;
  onExit(fn: (code: number | null) => void): void;
  kill(): void;
}

/** The feed process: feed-worker.mjs next to the bundled engine, or feed-worker.ts in development. */
export function forkFeedWorker(): FeedWorker {
  const here = dirname(fileURLToPath(import.meta.url));
  const mjs = join(here, "feed-worker.mjs");
  const entry = existsSync(mjs) ? mjs : join(here, "feed-worker.ts");
  const child = fork(entry, [], { execArgv: entry.endsWith(".ts") ? process.execArgv : [], env: { ...process.env, MATCHFRAME_FEED_WORKER: "1" }, stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced" });
  return {
    send: (req) => void (child.connected ? child.send(req) : undefined),
    onMessage: (fn) => void child.on("message", (m) => fn(m as WorkerReply)),
    onExit: (fn) => void child.on("exit", (code) => fn(code)),
    kill: () => void child.kill(),
  };
}

interface Segment {
  file: string;
  /** Wall time (ms since 1970) the segment starts and ends. */
  start: number;
  end: number;
}

interface Session {
  id: string;
  dir: string;
  /** What list.csv's times (seconds) count from, wall ms: when its ffmpeg was started. */
  t0: number;
  width: number;
  height: number;
  fps: number;
  segments: Segment[];
  /** Segments ending at or before this (wall ms) were pruned. */
  prunedUntil: number;
  /** It records the source's sound too. */
  audio: boolean;
  audioNote: string | null;
  encoder: Encoder;
  /** Where its recording skipped ahead (ffmpeg behind): from `at` (its time, ms from t0) on, it is `total` ms behind the wall clock. */
  skips: { at: number; total: number }[];
}

/** The segment holding the end of a clip is listed once the next one begins: wait this long for it. */
const CUT_WAIT_MS = 3500;
/** The feed counts as recording while its last segment ended this recently. */
const LIVE_MS = 4000;
const RESTART_MS = 3000;

export class ReplayFeed {
  private worker: FeedWorker | null = null;
  private sessions = new Map<string, Session>();
  private current: string | null = null;
  private state: FeedStatus["state"] = "off";
  private detail = "The replay feed is off.";
  private stats = { fps: 0, dropped: 0, receiving: false };
  /** The recording's counts as they came, the last few seconds (for where frames are lost). */
  private counts: { at: number; d: FeedDiagnostics }[] = [];
  private ndi: FeedStatus["ndi"] = { available: null, version: null, error: null };
  private timer: ReturnType<typeof setInterval> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private findSeq = 0;
  private finds = new Map<number, (r: Extract<WorkerReply, { type: "sources" }>) => void>();
  private clips = 0;
  private generation = 0;

  constructor(
    private readonly deps: {
      settings: SettingsRepo;
      logger: Pick<Logger, "info" | "warn">;
      dataDir: string;
      ffmpeg: FfmpegTool;
      spawnWorker?: () => FeedWorker;
      /** Where the recording goes (the engine's replay storage); the data folder's replay-feed when not given. */
      dir?: () => string;
    },
  ) {}

  private get dir(): string {
    return this.deps.dir?.() ?? join(this.deps.dataDir, "replay-feed");
  }

  settings(): FeedSettings {
    const r = FeedSettings.safeParse(this.deps.settings.get("replay.feed", {}));
    return r.success ? r.data : FeedSettings.parse({});
  }

  setSettings(patch: Partial<FeedSettings>): FeedSettings {
    const given = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const next = FeedSettings.parse({ ...this.settings(), ...given });
    this.deps.settings.set("replay.feed", next);
    void this.restart();
    return next;
  }

  start(): void {
    this.timer = setInterval(() => this.housekeep(), 500);
    this.timer.unref?.();
    void this.restart();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.timer = null;
    this.restartTimer = null;
    this.worker?.send({ type: "stop" });
    this.worker?.kill();
    this.worker = null;
  }

  /** (Re)starts recording with the current settings, or stops it. */
  async restart(): Promise<void> {
    const gen = ++this.generation;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.worker?.send({ type: "stop" });
    this.current = null;
    this.counts = [];
    const st = this.settings();
    if (!st.enabled) return this.set("off", "The replay feed is off.");
    if (!st.source) return this.set("error", "Choose the replay PC's NDI source.");
    const ffmpeg = await this.deps.ffmpeg.locate();
    if (gen !== this.generation) return;
    if (!ffmpeg) return this.set("error", this.deps.ffmpeg.status().canDownload ? "The replay feed needs ffmpeg: press Download ffmpeg." : "The replay feed needs ffmpeg: install it with this system's package manager.");
    let encoder: Encoder;
    try {
      encoder = await this.deps.ffmpeg.pickEncoder(st.encoder);
    } catch (err) {
      return this.set("error", `ffmpeg can't encode here: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (gen !== this.generation) return;
    // Recordings of an earlier run are of no use (clips are cut from this run's).
    rmSync(this.dir, { recursive: true, force: true });
    this.sessions.clear();
    mkdirSync(this.dir, { recursive: true });
    this.ensureWorker().send({ type: "record", options: { source: st.source, dir: this.dir, ffmpeg, encoder, bitrateMbps: st.bitrateMbps } });
    this.set("starting", `Connecting to ${st.source.name}…`);
  }

  private set(state: FeedStatus["state"], detail: string): void {
    this.state = state;
    this.detail = detail;
  }

  private ensureWorker(): FeedWorker {
    if (this.worker) return this.worker;
    const w = (this.deps.spawnWorker ?? forkFeedWorker)();
    this.worker = w;
    w.onMessage((r) => this.onReply(r));
    w.onExit((code) => {
      if (this.worker !== w) return;
      this.worker = null;
      for (const done of this.finds.values()) done({ type: "sources", id: -1, sources: [], error: "the feed process stopped" });
      this.finds.clear();
      if (this.settings().enabled && this.state !== "off") {
        this.set("error", `The feed process stopped (${code ?? "killed"}); starting it again.`);
        this.restartTimer = setTimeout(() => void this.restart(), RESTART_MS);
        this.restartTimer.unref?.();
      }
    });
    w.send({ type: "version" });
    return w;
  }

  private onReply(r: WorkerReply): void {
    const source = this.settings().source?.name ?? "the NDI source";
    if (r.type === "version") {
      this.ndi = { available: r.ndi !== null, version: r.ndi, error: r.error };
    } else if (r.type === "sources") {
      this.finds.get(r.id)?.(r);
      this.finds.delete(r.id);
    } else if (r.type === "session") {
      this.sessions.set(r.id, { id: r.id, dir: r.dir, t0: r.t0, width: r.width, height: r.height, fps: r.fps, segments: [], prunedUntil: -Infinity, audio: r.audio === true, audioNote: r.audioNote ?? null, encoder: r.encoder, skips: [] });
      this.current = r.id;
      this.set("recording", `Recording ${source} (${r.width}×${r.height}, ${Math.round(r.fps)} fps, ${r.encoder}${r.audio ? ", with sound" : ""}).`);
      this.deps.logger.info("replay feed: recording", { source, width: r.width, height: r.height, fps: r.fps, encoder: r.encoder, audio: r.audio, audioNote: r.audioNote });
    } else if (r.type === "stats") {
      this.stats = { fps: r.fps, dropped: r.dropped, receiving: r.receiving };
      if (r.diag) {
        const at = Date.now();
        // A new count from zero: the recording started again.
        if (this.counts.length && r.diag.received < this.counts[this.counts.length - 1]!.d.received) this.counts = [];
        this.counts.push({ at, d: r.diag });
        while (this.counts.length > 1 && this.counts[1]!.at <= at - LOSS_WINDOW_MS) this.counts.shift();
      }
      if (!r.receiving && this.state !== "error") this.set("waiting", `No picture from ${source}: is its NDI sender running on the replay PC?`);
      else if (r.receiving && this.state === "waiting" && this.current) this.set("recording", `Recording ${source}.`);
    } else if (r.type === "skip") {
      // ffmpeg fell behind and the recording skipped ahead (rather than starting again): its later times are that much later on the clock.
      const s = this.sessions.get(r.id);
      if (s) {
        s.skips.push({ at: r.atMs, total: r.totalMs });
        if (s.skips.length > 2000) s.skips.splice(0, s.skips.length - 2000);
      }
      this.deps.logger.info("replay feed: the encoder fell behind; the recording skipped ahead", { skippedMs: r.totalMs });
    } else if (r.type === "error") {
      this.deps.logger.warn("replay feed: problem", { message: r.message });
      this.set("error", r.message);
    } else if (r.type === "stopped") {
      if (this.state === "recording" || this.state === "waiting") this.set("starting", "Restarting the recording…");
    }
  }

  /** Reads each session's segment list and drops segments older than the kept recording. */
  private housekeep(): void {
    const keepFrom = Date.now() - this.settings().keepSeconds * 1000;
    for (const s of this.sessions.values()) {
      this.readList(s);
      while (s.segments.length && s.segments[0]!.end < keepFrom) {
        const old = s.segments.shift()!;
        s.prunedUntil = Math.max(s.prunedUntil, old.end);
        try {
          unlinkSync(join(s.dir, old.file));
        } catch {
          // Already gone.
        }
      }
      if (s.id !== this.current && !s.segments.length) {
        rmSync(s.dir, { recursive: true, force: true });
        this.sessions.delete(s.id);
      }
    }
  }

  private readList(s: Session): void {
    let text: string;
    try {
      text = readFileSync(join(s.dir, "list.csv"), "utf8");
    } catch {
      return;
    }
    const known = new Set(s.segments.map((x) => x.file));
    for (const line of text.split("\n")) {
      const [file, a, b] = line.trim().split(",");
      if (!file || known.has(file) || a === undefined || b === undefined) continue;
      const start = wallOf(s, Number(a) * 1000);
      const end = wallOf(s, Number(b) * 1000);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= s.prunedUntil) continue;
      s.segments.push({ file, start, end });
    }
  }

  /** Recording now (the latest segment is recent). */
  recording(): boolean {
    const s = this.current ? this.sessions.get(this.current) : undefined;
    const last = s?.segments[s.segments.length - 1];
    return (this.state === "recording" || this.state === "waiting") && !!last && last.end > Date.now() - LIVE_MS;
  }

  status(): FeedStatus {
    const st = this.settings();
    const s = this.current ? this.sessions.get(this.current) : undefined;
    const segs = s?.segments ?? [];
    return {
      enabled: st.enabled,
      state: this.state,
      detail: this.detail,
      source: st.source,
      width: s?.width ?? null,
      height: s?.height ?? null,
      fps: s?.fps ?? null,
      receivingFps: this.stats.fps,
      dropped: this.stats.dropped,
      encoder: s?.encoder ?? null,
      diagnostics: this.counts[this.counts.length - 1]?.d ?? null,
      losses: this.losses(s?.encoder ?? null),
      bufferedSec: segs.length ? Math.round((segs[segs.length - 1]!.end - segs[0]!.start) / 100) / 10 : 0,
      ndi: this.ndi,
      ffmpeg: this.deps.ffmpeg.status(),
      clips: this.clips,
      audio: s ? (s.audio ? { recording: true, detail: "The replay PC's sound is recorded (silence when its NDI sender sends none): clips carry it." } : { recording: false, detail: `Recording without sound: ${s.audioNote ?? "not available"}.` }) : null,
    };
  }

  /** Where frames are being lost now, while recording. */
  private losses(encoder: Encoder | null): FeedLoss[] {
    const a = this.counts[0];
    const b = this.counts[this.counts.length - 1];
    if (!a || !b || this.state !== "recording") return [];
    return feedLosses(a, b, encoder, this.settings().encoder === "auto");
  }

  /** NDI sources on the network (asks the feed process; NDI finds them within a second or two). */
  async sources(timeoutMs = 2500): Promise<{ sources: NdiSource[]; error: string | null }> {
    const id = ++this.findSeq;
    const w = this.ensureWorker();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.finds.delete(id);
        resolve({ sources: [], error: "the feed process didn't answer" });
      }, timeoutMs + 4000);
      this.finds.set(id, (r) => {
        clearTimeout(timer);
        resolve({ sources: r.sources, error: r.error });
      });
      w.send({ type: "find", id, timeoutMs });
    });
  }

  /**
   * Cuts the recording from `from` to `to` (wall ms) into `outFile` (MP4, no re-encoding). The clip
   * starts at the second (keyframe) at or before `from`, or the recording's start; `startWall` says
   * where. Waits for the segment holding `to` to be written.
   */
  async cut(from: number, to: number, outFile: string): Promise<{ startWall: number; durationMs: number; width: number; height: number; fps: number; hasAudio: boolean }> {
    const ffmpeg = await this.deps.ffmpeg.locate();
    if (!ffmpeg) throw new Error("ffmpeg isn't installed");
    const deadline = Date.now() + CUT_WAIT_MS;
    let pick = this.pick(from, to);
    while ((!pick || pick.segs[pick.segs.length - 1]!.end < to) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
      for (const s of this.sessions.values()) this.readList(s);
      pick = this.pick(from, to);
    }
    if (!pick) throw new Error("the recording has no picture for that moment (was the replay PC's NDI picture coming in?)");
    const { session, segs } = pick;
    const startWall = segs[0]!.start;
    const parts = segs.map((g) => readFileSync(join(session.dir, g.file)));
    const ts = `${outFile}.ts`;
    writeFileSync(ts, Buffer.concat(parts));
    // (Less what the recording skipped meanwhile, if ffmpeg fell behind: the clip's own length.)
    const durationMs = Math.max(500, Math.min(to, segs[segs.length - 1]!.end) - startWall - (skippedBy(session, Math.min(to, segs[segs.length - 1]!.end)) - skippedBy(session, startWall)));
    try {
      await run(ffmpeg, ["-y", "-v", "error", "-i", ts, "-t", (durationMs / 1000).toFixed(3), "-c", "copy", "-movflags", "+faststart", outFile], { timeout: 30_000, windowsHide: true });
    } finally {
      rmSync(ts, { force: true });
    }
    this.clips++;
    return { startWall, durationMs, width: session.width, height: session.height, fps: session.fps, hasAudio: session.audio };
  }

  /** The session holding `to` (or the latest before it), and its segments from `from` to `to`. */
  private pick(from: number, to: number): { session: Session; segs: Segment[] } | null {
    let best: { session: Session; segs: Segment[] } | null = null;
    for (const session of this.sessions.values()) {
      const segs = session.segments.filter((g) => g.end > from && g.start < to);
      if (!segs.length) continue;
      if (!best || segs[segs.length - 1]!.end > best.segs[best.segs.length - 1]!.end) best = { session, segs };
    }
    return best;
  }

  /** Removes clips cut from the feed beyond the newest `keep` in `dir`. */
  static pruneClips(dir: string, keep: number): void {
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith("feed-") && f.endsWith(".mp4")) : [];
    for (const old of files.sort().reverse().slice(keep)) rmSync(join(dir, old), { force: true });
  }
}

/** Where a session's recording time (ms from its t0) is on the wall clock: later by what it had skipped by then (ffmpeg behind). */
function wallOf(s: Session, recMs: number): number {
  let total = 0;
  for (const k of s.skips) {
    if (k.at > recMs) break;
    total = k.total;
  }
  return s.t0 + recMs + total;
}

/** What a session's recording had skipped (ms) by a wall time. */
function skippedBy(s: Session, wall: number): number {
  let total = 0;
  for (const k of s.skips) {
    if (s.t0 + k.at + k.total > wall) break;
    total = k.total;
  }
  return total;
}
