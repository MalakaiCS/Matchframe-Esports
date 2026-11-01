import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { AUDIO_RATE, AudioClock, FrameSlots, RollingMedian, toStereo, VideoClock, type FrameTiming } from "./feed-clock.ts";
import type { Encoder } from "./ffmpeg.ts";
import { encoderArgs } from "./ffmpeg.ts";

export { AUDIO_RATE, AudioClock, toStereo } from "./feed-clock.ts";

/**
 * Records an NDI source (the replay PC's screen) into one-second H.264 segments with ffmpeg. Runs in
 * the replay feed's own process (feed-worker.ts), so the frames (about 250 MB a second at 1080p60)
 * never touch the engine.
 *
 * **The picture at a constant rate** (feed-clock.ts, ADR-064): each frame is timed by the sender's own
 * clock (its NDI timecode or timestamp, whichever runs steadier), laid on this computer's clock by an
 * offset that moves only when the two drift apart by more than a frame and a half, and goes in the
 * slot of the recording nearest that time: slot k is t0 + k frames. This process writes every slot
 * itself, as raw frames on ffmpeg's stdin at the source's rate: a slot nothing came for repeats the
 * frame before; a frame for a slot already filled is skipped. When it arrived here (late, or in a
 * burst after a busy moment) changes nothing. ffmpeg stamps the frames by their count (its input
 * starts `k0` frames after t0, `-itsoffset`, the stamps kept with `-copyts`), so the segments' times
 * (list.csv) count real time from t0, and the engine cuts clips by the time a kill happened
 * (replay/feed.ts). Up to BACKLOG_MS of frames may queue for ffmpeg; past that a frame isn't recorded (its
 * slot repeats the one before when ffmpeg catches up), and it counts as the encoder's.
 *
 * **The sound** (the replay PC's game) is recorded with it (AAC, 48 kHz stereo): NDI's audio frames,
 * received with the video (the binding's `data()`), are piped to ffmpeg's second input (pipe:3) as
 * 32-bit float PCM, written as received and laid along the picture by the sender's timestamps, where
 * the recording shows the picture stamped at the same moment (AudioClock: silence only for a real
 * dropout, drift moved back by a slight resample). A source
 * without sound is recorded with silence. If ffmpeg can't open the second pipe, the recording goes on
 * without sound and says why.
 */

/** The part of the NDI binding (grandi) the feed uses. */
export interface NdiSource {
  name: string;
  urlAddress?: string;
}
export interface NdiVideoFrame {
  xres: number;
  yres: number;
  frameRateN: number;
  frameRateD: number;
  fourCC: number;
  lineStrideBytes: number;
  data: Buffer;
  /** When the sender sent it (100 ns since 1970, the sender's clock), and its timecode (100 ns; NDI makes one at a steady rate from the sender's clock unless the sender gives its own). */
  timestamp?: bigint;
  timecode?: bigint;
}
/** An NDI audio frame as received with Float32Interleaved: `samples` × `channels` floats, unscaled (1.0 = full scale). */
export interface NdiAudioFrame {
  type: "audio";
  sampleRate: number;
  channels: number;
  samples: number;
  data: Buffer;
  /** When the sender sent it (100 ns since 1970, the sender's clock: about when its last sample was captured), and its timecode (100 ns). */
  timestamp?: bigint;
  timecode?: bigint;
}
export interface NdiReceiver {
  video(timeoutMs?: number): Promise<NdiVideoFrame | { type: "timeout" }>;
  /** The next frame of any kind (video, audio, metadata, an event); bindings without it are recorded without sound. */
  data?(options: { audioFormat?: number }, timeoutMs?: number): Promise<(NdiVideoFrame & { type: "video" }) | NdiAudioFrame | { type: string }>;
  /** NDI's own count of frames received and dropped on this computer (NDIlib_recv_get_performance), when the binding has it. */
  performance?(): { total: { videoFrames: number; audioFrames: number }; dropped: { videoFrames: number; audioFrames: number } };
  /** Frames waiting in NDI's queue (NDIlib_recv_get_queue), when the binding has it. */
  queue?(): { videoFrames: number; audioFrames: number };
  destroy(): boolean;
}
export interface NdiFinder {
  sources(): NdiSource[];
  wait(timeoutMs?: number): Promise<boolean>;
  destroy(): boolean;
}
export interface NdiModule {
  version(): string;
  find(params?: { showLocalSources?: boolean }): Promise<NdiFinder>;
  receive(params: { source: NdiSource; colorFormat?: number; name?: string }): Promise<NdiReceiver>;
  COLOR_FORMAT_UYVY_BGRA: number;
  FOURCC_UYVY: number;
  FOURCC_BGRA: number;
  FOURCC_BGRX: number;
  FOURCC_RGBA: number;
  FOURCC_RGBX: number;
  /** grandi's AudioFormat.Float32Interleaved (1). */
  AUDIO_FORMAT_FLOAT_32_INTERLEAVED?: number;
}

export interface FeedOptions {
  source: NdiSource;
  /** Sessions are folders in here, one per ffmpeg run (a new picture size or rate starts a new one). */
  dir: string;
  ffmpeg: string;
  encoder: Encoder;
  bitrateMbps: number;
}

/** What the recording has seen and done since it started: the Replay feed panel and the support file show it, so they tell where frames are lost. */
export interface FeedDiagnostics {
  /** The rate the source declares (frames a second). */
  sourceFps: number | null;
  /** Video frames received from NDI. */
  received: number;
  /** NDI's own count on this computer: video frames received, and video and audio frames it dropped before the feed took them; null when the binding doesn't tell. */
  ndi: { videoFrames: number; videoDropped: number; audioDropped: number } | null;
  /** Frames written to the recording (one a slot, at the source's rate), slots that repeat the frame before (nothing came for them: a gap in what arrived), and frames skipped (they came for a slot already filled). */
  written: number;
  repeated: number;
  skipped: number;
  /** Frames not recorded because ffmpeg wasn't taking them (its encoder behind), and those lost while it started (each session's first second or so). */
  encoderDropped: number;
  startDropped: number;
  /** The most frames that were queued for ffmpeg. */
  backlogMax: number;
  /** What times the frames (the sender's timecode or timestamp, or their arrival), and how often the sender's clock was laid again on this computer's. */
  timing: FrameTiming | null;
  reanchored: number;
  /** The sound: dropouts filled with silence and their length (ms), moves back to the picture by resampling and by a crossfaded join, and where it sits against the picture (ms, + late). */
  audio: { dropouts: number; paddedMs: number; corrections: number; joins: number; offsetMs: number | null } | null;
}

export type FeedEvent =
  | { type: "session"; id: string; dir: string; t0: number; width: number; height: number; fps: number; encoder: Encoder; audio: boolean; audioNote: string | null }
  | { type: "stats"; frames: number; dropped: number; fps: number; receiving: boolean; diag?: FeedDiagnostics }
  | { type: "error"; message: string }
  | { type: "stopped" };

/** After this long without a frame, the source counts as not sending. */
const FRAME_WAIT_MS = 1000;
/** Each wait for a frame (ms): the loop also holds the picture and fills silence between frames. */
const POLL_MS = 100;
/**
 * The segments' times count from this long before ffmpeg was started (the session's t0), so no
 * stream starts before 0: ffmpeg would move them all (the AAC encoder's first frame starts 21 ms
 * before its sound).
 */
const LEAD_MS = 100;
/** No picture for this long, and none waiting in NDI: the last frame is held (its slots repeat it) up to this long before now. */
const QUIET_MS = 250;
/** No picture for this long: the session ends (ffmpeg finishes it); the next frame starts a new one. */
const HOLD_MAX_MS = 3000;
/** Frames may queue for ffmpeg up to this long of them (15 at 60 fps, about 62 MB at 1080p): a burst after a busy moment fits; more are dropped, as its encoder is behind. */
const BACKLOG_MS = 250;
/** The recording this far behind the picture (ffmpeg not keeping up at all): the session starts again. */
const LAG_MAX_MS = 2000;

const ms = (t: bigint | undefined): number | null => (typeof t === "bigint" ? Number(t) / 10_000 : null);

interface Session {
  id: string;
  dir: string;
  started: boolean;
  width: number;
  height: number;
  fps: number;
  frameMs: number;
  /** Bytes of each frame written (its rows as NDI gives them). */
  frameBytes: number;
  audio: boolean;
  t0: number;
  audioT0: number;
  slots: FrameSlots;
  /** ffmpeg is running (its first segment is there and it took what queued while it started): before, frames it doesn't take are lost to its start, not its encoder. */
  flowing: boolean;
  /** When its first segment was seen. */
  segAt: number | null;
}

export class FeedRecording {
  private stopped = false;
  private ff: ChildProcess | null = null;
  private format: string | null = null;
  private stderr = "";
  private arrivals: number[] = [];
  private session: Session | null = null;
  private rx: NdiReceiver | null = null;
  /** The picture's clock (one per picture format: a new one may be a restarted sender). */
  private video: VideoClock | null = null;
  /** How much later the recording shows a frame than its timestamp says (ms), the last 2 s: the sound is laid by it, so it goes with the picture as shown. */
  private shownLag = new RollingMedian(120);
  /** The sound on the picture's clock (null: this session records no sound). */
  private clock: AudioClock | null = null;
  /** Why the recording has no sound (ffmpeg couldn't open its second input, the binding has no audio), or null. */
  private audioOff: string | null = null;
  private lastVideo = 0;
  private lastAudio = 0;
  /** The last frame written (its slots repeat it), and slots placed but not written yet (ffmpeg behind): repeats of it. */
  private last: Buffer | null = null;
  private owed = 0;
  private sourceFps: number | null = null;
  private counts = { received: 0, written: 0, repeated: 0, skipped: 0, encoderDropped: 0, startDropped: 0, backlogMax: 0, reanchored: 0 };
  /** The sound's counts of sessions that ended. */
  private audioDone = { dropouts: 0, paddedMs: 0, corrections: 0, joins: 0 };

  constructor(
    private readonly ndi: NdiModule,
    private readonly o: FeedOptions,
    private readonly emit: (e: FeedEvent) => void,
  ) {}

  async run(): Promise<void> {
    const rx = await this.ndi.receive({ source: this.o.source, colorFormat: this.ndi.COLOR_FORMAT_UYVY_BGRA, name: "Matchframe replay feed" });
    this.rx = rx;
    // Video and sound with one call (the binding's data()), else the picture only.
    const both = typeof rx.data === "function";
    if (!both) this.audioOff = "the NDI binding receives no sound";
    const audioFormat = this.ndi.AUDIO_FORMAT_FLOAT_32_INTERLEAVED ?? 1;
    let lastStats = Date.now();
    try {
      while (!this.stopped) {
        let f: Awaited<ReturnType<NonNullable<NdiReceiver["data"]>>> | NdiVideoFrame | { type: "timeout" } | null = null;
        try {
          f = both ? await rx.data!({ audioFormat }, POLL_MS) : await rx.video(POLL_MS);
        } catch {
          f = null;
        }
        const at = Date.now();
        if (f && "data" in f && (!("type" in f) || f.type === "video")) {
          this.lastVideo = at;
          this.onFrame(f as NdiVideoFrame, at);
        } else if (f && "type" in f && f.type === "audio") this.onAudio(f as NdiAudioFrame, at);
        this.tick(at);
        if (at - lastStats >= 1000) {
          lastStats = at;
          this.arrivals = this.arrivals.filter((t) => at - t < 2000);
          this.emit({ type: "stats", frames: this.counts.written, dropped: this.counts.encoderDropped, fps: this.arrivals.length / 2, receiving: at - this.lastVideo < FRAME_WAIT_MS, diag: this.diagnostics() });
        }
      }
    } finally {
      rx.destroy();
      this.rx = null;
      this.closeFfmpeg();
      this.emit({ type: "stopped" });
    }
  }

  stop(): void {
    this.stopped = true;
  }

  /** What the recording has seen and done since it started. */
  diagnostics(): FeedDiagnostics {
    let perf: ReturnType<NonNullable<NdiReceiver["performance"]>> | null;
    try {
      perf = this.rx?.performance?.() ?? null;
    } catch {
      perf = null;
    }
    const c = this.counts;
    const a = this.clock;
    const done = this.audioDone;
    return {
      sourceFps: this.sourceFps,
      received: c.received,
      ndi: perf ? { videoFrames: perf.total.videoFrames, videoDropped: perf.dropped.videoFrames, audioDropped: perf.dropped.audioFrames } : null,
      written: c.written,
      repeated: c.repeated,
      skipped: c.skipped,
      encoderDropped: c.encoderDropped,
      startDropped: c.startDropped,
      backlogMax: c.backlogMax,
      timing: this.video?.timing ?? null,
      reanchored: c.reanchored + (this.video?.reanchored ?? 0),
      audio: this.audioOff === null ? { dropouts: done.dropouts + (a?.dropouts ?? 0), paddedMs: Math.round(done.paddedMs + (a?.paddedMs ?? 0)), corrections: done.corrections + (a?.corrections ?? 0), joins: done.joins + (a?.joins ?? 0), offsetMs: a?.offsetMs ?? null } : null,
    };
  }

  private pixelFormat(fourCC: number): { pix: string; bpp: number } | null {
    const n = this.ndi;
    if (fourCC === n.FOURCC_UYVY) return { pix: "uyvy422", bpp: 2 };
    if (fourCC === n.FOURCC_BGRA) return { pix: "bgra", bpp: 4 };
    if (fourCC === n.FOURCC_BGRX) return { pix: "bgr0", bpp: 4 };
    if (fourCC === n.FOURCC_RGBA) return { pix: "rgba", bpp: 4 };
    if (fourCC === n.FOURCC_RGBX) return { pix: "rgb0", bpp: 4 };
    return null;
  }

  private onFrame(f: NdiVideoFrame, at: number): void {
    const pf = this.pixelFormat(f.fourCC);
    if (!pf) {
      if (this.format !== `unsupported:${f.fourCC}`) this.emit({ type: "error", message: `the NDI source sends a picture format the feed can't record (FourCC ${f.fourCC})` });
      this.format = `unsupported:${f.fourCC}`;
      return;
    }
    this.counts.received++;
    this.arrivals.push(at);
    const [n, d] = f.frameRateN > 0 && f.frameRateD > 0 ? [f.frameRateN, f.frameRateD] : [60, 1];
    const rate = `${n}/${d}`;
    this.sourceFps = n / d;
    const key = `${f.xres}x${f.yres}:${pf.pix}:${rate}:${f.lineStrideBytes}`;
    if (key !== this.format) {
      this.counts.reanchored += this.video?.reanchored ?? 0;
      this.video = new VideoClock((1000 * d) / n);
      this.shownLag = new RollingMedian(120);
    }
    const ts = ms(f.timestamp);
    const t = this.video!.place(at, ts, ms(f.timecode));
    if (key !== this.format || !this.ff) {
      this.closeFfmpeg();
      this.format = key;
      this.startFfmpeg(f, pf, rate, t);
    }
    const stdin = this.ff?.stdin;
    const s = this.session!;
    if (!stdin || stdin.destroyed) return;
    if (!s.started) {
      s.started = true;
      // The sound from when ffmpeg started (its offset), silent until sound comes.
      if (s.audio) {
        this.clock = new AudioClock(s.audioT0);
        const b = this.clock.until(Date.now());
        if (b) this.writeAudio([b]);
      }
      this.emit({ type: "session", id: s.id, dir: s.dir, t0: s.t0, width: s.width, height: s.height, fps: s.fps, encoder: this.o.encoder, audio: s.audio, audioNote: s.audio ? null : this.audioOff });
    }
    const gap = s.slots.place(t);
    if (gap === null) {
      this.counts.skipped++;
      return;
    }
    this.owed += gap;
    this.counts.repeated += gap;
    const byTs = ts !== null ? this.video!.wallOfTimestamp(ts) : null;
    if (byTs !== null) this.shownLag.push(s.t0 + (s.slots.next - 1) * s.frameMs - byTs);
    this.pump(this.rows(f, pf.bpp, s));
  }

  /** The frame's bytes as ffmpeg reads them: as NDI gives them (a stride wider than the picture is cropped by ffmpeg), copied row by row only for a stride ffmpeg can't crop. */
  private rows(f: NdiVideoFrame, bpp: number, s: Session): Buffer {
    const row = f.xres * bpp;
    if (f.lineStrideBytes === row || f.lineStrideBytes % bpp === 0) return f.data.length === s.frameBytes ? f.data : f.data.subarray(0, s.frameBytes);
    const data = Buffer.alloc(row * f.yres);
    for (let y = 0; y < f.yres; y++) f.data.copy(data, y * row, y * f.lineStrideBytes, y * f.lineStrideBytes + row);
    return data;
  }

  /** Writes the slots owed (repeats of the last frame) and then `next`, while ffmpeg's queue has room; a frame that doesn't fit isn't recorded (its slot repeats the last frame later). */
  private pump(next: Buffer | null): void {
    const s = this.session;
    const stdin = this.ff?.stdin;
    if (!s || !stdin || stdin.destroyed) return;
    const room = () => stdin.writableLength < Math.ceil(BACKLOG_MS / s.frameMs) * s.frameBytes;
    while (this.owed > 0 && this.last && room()) {
      this.write(this.last);
      this.owed--;
    }
    if (next) {
      if (this.owed === 0 && room()) {
        this.write(next);
        this.last = next;
      } else {
        if (s.flowing) this.counts.encoderDropped++;
        else this.counts.startDropped++;
        this.owed++;
      }
    }
    if (s.flowing && this.owed * s.frameMs > LAG_MAX_MS) {
      this.emit({ type: "error", message: `ffmpeg (${this.o.encoder}) can't keep up with the picture: the recording starts again` });
      this.closeFfmpeg();
    }
  }

  private write(b: Buffer): void {
    const s = this.session!;
    const stdin = this.ff!.stdin!;
    stdin.write(b);
    this.counts.written++;
    this.counts.backlogMax = Math.max(this.counts.backlogMax, Math.round(stdin.writableLength / s.frameBytes));
  }

  /** Between frames: the picture held through a short pause (its slots repeat the last frame), the session ended after a long one, and silence for a source without sound. */
  private tick(now: number): void {
    const s = this.session;
    // ffmpeg running: its first segment there, and the slots owed while it started written and taken (or 2 s on: it is slow, not starting).
    if (s && !s.flowing && this.ff) {
      if (s.segAt === null && existsSync(join(s.dir, "seg_000000.ts"))) s.segAt = now;
      if (s.segAt !== null && ((this.owed === 0 && (this.ff.stdin?.writableLength ?? 0) <= s.frameBytes) || now - s.segAt > 2000)) s.flowing = true;
    }
    if (s?.started && this.ff) {
      const quiet = now - this.lastVideo >= QUIET_MS && !this.waiting("videoFrames");
      if (quiet && now - this.lastVideo > HOLD_MAX_MS) this.closeFfmpeg();
      else {
        if (quiet) {
          const due = s.slots.hold(now - QUIET_MS);
          this.owed += due;
          this.counts.repeated += due;
        }
        this.pump(null);
      }
    }
    if (this.clock && this.ff && now - this.lastAudio >= QUIET_MS) {
      const b = this.clock.fill(now, this.waiting("audioFrames"));
      if (b) this.writeAudio([b]);
    }
  }

  /** Frames of that kind wait in NDI's queue (this process was busy): nothing is filled in for them. */
  private waiting(kind: "videoFrames" | "audioFrames"): boolean {
    try {
      return (this.rx?.queue?.()[kind] ?? 0) > 0;
    } catch {
      return false;
    }
  }

  /** A sound frame: laid by its timestamp where the recording shows the picture of that moment, and piped to ffmpeg (before the first picture there is no recording yet). */
  private onAudio(f: NdiAudioFrame, at: number): void {
    if (!this.clock || !this.ff) return;
    this.lastAudio = at;
    const ts = ms(f.timestamp);
    const byTs = ts !== null ? (this.video?.wallOfTimestamp(ts) ?? null) : null;
    const end = byTs !== null ? byTs + (this.shownLag.value ?? 0) : null;
    this.writeAudio(this.clock.frame(toStereo(f), f.sampleRate > 0 ? f.sampleRate : AUDIO_RATE, at, end));
  }

  private writeAudio(parts: Buffer[]): void {
    const pipe = this.ff?.stdio[3] as Writable | null | undefined;
    if (!pipe || pipe.destroyed) return;
    // (A few hundred kB a second: never dropped, ffmpeg reads it on its own thread.)
    for (const b of parts) if (b.length) pipe.write(b);
  }

  private startFfmpeg(f: NdiVideoFrame, pf: { pix: string; bpp: number }, rate: string, first: number): void {
    const id = `s${Date.now().toString(36)}`;
    const dir = join(this.o.dir, id);
    mkdirSync(dir, { recursive: true });
    const [n, d] = rate.split("/").map(Number) as [number, number];
    const fps = n / d;
    const frameMs = (1000 * d) / n;
    const audio = this.audioOff === null;
    // t0: the segments' times count from here; the first frame is slot k0, about LEAD_MS later, and the sound's sample 0 is LEAD_MS after t0.
    const k0 = Math.max(1, Math.round(LEAD_MS / frameMs));
    const t0 = first - k0 * frameMs;
    const width = f.xres;
    const height = f.yres;
    // A stride wider than the picture: ffmpeg reads the whole rows and crops them (no copy here).
    const wide = f.lineStrideBytes !== width * pf.bpp && f.lineStrideBytes % pf.bpp === 0;
    const inWidth = wide ? f.lineStrideBytes / pf.bpp : width;
    this.session = { id, dir, started: false, width, height, fps, frameMs, frameBytes: inWidth * pf.bpp * height, audio, t0, audioT0: t0 + LEAD_MS, slots: new FrameSlots(t0, frameMs, k0), flowing: false, segAt: null };
    this.clock = null;
    this.last = null;
    this.owed = 0;
    this.stderr = "";
    const args = [
      "-hide_banner", "-v", "error",
      "-f", "rawvideo", "-pix_fmt", pf.pix, "-video_size", `${inWidth}x${height}`, "-framerate", rate, "-itsoffset", ((k0 * frameMs) / 1000).toFixed(6), "-thread_queue_size", "64", "-i", "pipe:0",
      ...(audio ? ["-itsoffset", (LEAD_MS / 1000).toFixed(3), "-f", "f32le", "-ar", String(AUDIO_RATE), "-ac", "2", "-thread_queue_size", "1024", "-i", "pipe:3", "-map", "0:v", "-map", "1:a"] : ["-an"]),
      "-copyts",
      ...(wide ? ["-vf", `crop=${width}:${height}:0:0`] : []),
      // The frames come at a constant rate already (this process wrote each slot): ffmpeg adds or drops none.
      "-fps_mode", "passthrough", ...encoderArgs(this.o.encoder, fps, this.o.bitrateMbps), "-pix_fmt", "yuv420p",
      ...(audio ? ["-c:a", "aac", "-b:a", "160k", "-ar", String(AUDIO_RATE), "-ac", "2"] : []),
      "-f", "segment", "-segment_time", "1", "-segment_format", "mpegts", "-segment_list", join(dir, "list.csv"), "-segment_list_type", "csv", "-segment_list_flags", "+live", join(dir, "seg_%06d.ts"),
    ];
    const startedAt = Date.now();
    const ff = spawn(this.o.ffmpeg, args, { stdio: audio ? ["pipe", "ignore", "pipe", "pipe"] : ["pipe", "ignore", "pipe"], windowsHide: true });
    this.ff = ff;
    ff.stdin!.on("error", () => undefined);
    (ff.stdio[3] as Writable | null)?.on("error", () => undefined);
    ff.stderr!.on("data", (b: Buffer) => {
      this.stderr = (this.stderr + b.toString()).slice(-2000);
    });
    ff.on("exit", (code) => {
      if (this.ff !== ff) return;
      this.endSession();
      this.format = null;
      const message = this.stderr.trim().split("\n").slice(-2).join(" ") || "no message";
      // ffmpeg couldn't read the sound's pipe: the recording goes on without sound (it starts again with the next frame).
      if (audio && !this.stopped && Date.now() - startedAt < 10_000 && /pipe:3|bad file descriptor|invalid argument/i.test(this.stderr)) {
        this.audioOff = `ffmpeg couldn't read the sound (${message})`;
        this.emit({ type: "error", message: `Recording without sound: ${this.audioOff}` });
        return;
      }
      if (!this.stopped) this.emit({ type: "error", message: `ffmpeg stopped (${code ?? "killed"}): ${message}` });
    });
  }

  /** The session's ffmpeg is done with: its sound's counts kept, nothing owed. */
  private endSession(): ChildProcess | null {
    const ff = this.ff;
    this.ff = null;
    const a = this.clock;
    if (a) {
      this.audioDone.dropouts += a.dropouts;
      this.audioDone.paddedMs += a.paddedMs;
      this.audioDone.corrections += a.corrections;
      this.audioDone.joins += a.joins;
    }
    this.clock = null;
    this.last = null;
    this.owed = 0;
    return ff;
  }

  private closeFfmpeg(): void {
    const ff = this.endSession();
    if (!ff) return;
    ff.stdin?.end();
    (ff.stdio[3] as Writable | null)?.end();
    // ffmpeg writes its last segment when its input ends; it is killed if it doesn't stop.
    setTimeout(() => ff.kill(), 5000).unref?.();
  }
}
