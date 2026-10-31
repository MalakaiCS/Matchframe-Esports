import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Writable } from "node:stream";
import type { Encoder } from "./ffmpeg.ts";
import { encoderArgs } from "./ffmpeg.ts";

/**
 * Records an NDI source (the replay PC's screen) into one-second H.264 segments with ffmpeg. Runs in
 * the replay feed's own process (feed-worker.ts), so the frames (about 250 MB a second at 1080p60)
 * never touch the engine. Each frame is piped to ffmpeg as it arrives and stamped with the time it
 * arrived (`-use_wallclock_as_timestamps`), less the moment ffmpeg was started (`-itsoffset`, the
 * stamps then kept as they are with `-copyts`), so the segments' times (list.csv) count real time
 * from that moment, the session's t0: the engine cuts clips by the time a kill happened
 * (replay/feed.ts). (They used to count from ffmpeg's stamp of the first frame, which it reads some
 * 30–60 ms after it is written while still starting: clips were cut that much early. ADR-062.)
 *
 * The source's sound (the replay PC's game) is recorded with it (AAC, 48 kHz stereo): NDI's audio
 * frames, received with the video (the binding's `data()`), are piped to ffmpeg's second input
 * (pipe:3) as 32-bit float PCM, laid on the same clock as the picture (AudioClock: sample 0 is t0,
 * and a frame ends when it arrived; a gap is filled with silence, so the sound stays with the
 * picture). A source
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
}
/** An NDI audio frame as received with Float32Interleaved: `samples` × `channels` floats, unscaled (1.0 = full scale). */
export interface NdiAudioFrame {
  type: "audio";
  sampleRate: number;
  channels: number;
  samples: number;
  data: Buffer;
  /** When the sender sent it (100 ns since 1970, the sender's clock), and its timecode (100 ns): either tells a gap from a delay here. */
  timestamp?: bigint;
  timecode?: bigint;
}
export interface NdiReceiver {
  video(timeoutMs?: number): Promise<NdiVideoFrame | { type: "timeout" }>;
  /** The next frame of any kind (video, audio, metadata, an event); bindings without it are recorded without sound. */
  data?(options: { audioFormat?: number }, timeoutMs?: number): Promise<(NdiVideoFrame & { type: "video" }) | NdiAudioFrame | { type: string }>;
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

export type FeedEvent =
  | { type: "session"; id: string; dir: string; t0: number; width: number; height: number; fps: number; encoder: Encoder; audio: boolean; audioNote: string | null }
  | { type: "stats"; frames: number; dropped: number; fps: number; receiving: boolean }
  | { type: "error"; message: string }
  | { type: "stopped" };

/** Each wait for a frame (ms); after this long without one, the source counts as not sending. */
const FRAME_WAIT_MS = 1000;
/**
 * The segments' times count from this long before ffmpeg was started (the session's t0), so no
 * stream starts before 0: ffmpeg would move them all (the AAC encoder's first frame starts 21 ms
 * before its sound).
 */
const LEAD_MS = 100;
/** The recording's sound: 48 kHz stereo, 32-bit float to ffmpeg. */
export const AUDIO_RATE = 48000;
/** Sound more than this far from the picture (by the earliest arrivals of AUDIO_WINDOW_MS) is moved back in time with it. */
const AUDIO_SLACK_MS = 60;
const AUDIO_WINDOW_MS = 3000;
/** A jump in the sender's timestamps longer than this is a gap (filled with silence). */
const AUDIO_GAP_MS = 20;
/** Without sound for this long (a source without audio), silence keeps the recording's sound up to this much behind real time. */
const AUDIO_FILL_AFTER_MS = 300;
const AUDIO_FILL_BEHIND_MS = 150;

/** An NDI audio frame (Float32Interleaved, any channels and rate) as 48 kHz stereo, interleaved (linear interpolation when the rate differs). */
export function toStereo48k(f: Pick<NdiAudioFrame, "sampleRate" | "channels" | "samples" | "data">): Float32Array {
  const ch = Math.max(1, f.channels);
  const n = Math.min(f.samples, Math.floor(f.data.length / 4 / ch));
  const src = new Float32Array(f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + n * ch * 4));
  const right = ch > 1 ? 1 : 0;
  if (f.sampleRate === AUDIO_RATE || f.sampleRate <= 0) {
    const out = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) [out[2 * i], out[2 * i + 1]] = [src[i * ch]!, src[i * ch + right]!];
    return out;
  }
  const m = Math.max(0, Math.round((n * AUDIO_RATE) / f.sampleRate));
  const out = new Float32Array(m * 2);
  for (let j = 0; j < m; j++) {
    const x = (j * f.sampleRate) / AUDIO_RATE;
    const i = Math.min(n - 1, Math.floor(x));
    const k = Math.min(n - 1, i + 1);
    const t = x - i;
    out[2 * j] = src[i * ch]! * (1 - t) + src[k * ch]! * t;
    out[2 * j + 1] = src[i * ch + right]! * (1 - t) + src[k * ch + right]! * t;
  }
  return out;
}

/**
 * Lays the sound on the picture's clock: sample 0 is `t0` (wall ms). Frames follow one another as
 * the sender sent them (by its own timestamps: a jump there is a real gap, filled with silence; an
 * overlap is cut), so a moment this process was busy, which brings frames late and then all at
 * once, changes nothing. Where they sit against the picture comes from when they arrive: the
 * earliest arrivals of the last few seconds (late ones say nothing) set it, and the sound is moved
 * (silence added, or samples cut) when it is more than AUDIO_SLACK_MS off. The first frame, and the
 * first after silence filled in for a source without sound, go where their arrival puts them.
 */
export class AudioClock {
  /** Samples (per channel) written since t0. */
  written = 0;
  /** The sender's time at the end of the last frame (ms), when frames carry it. */
  private sentEnd: number | null = null;
  private lastArrival = -Infinity;
  /** Place each frame by its arrival (the first one, and the first after filled silence). */
  private resync = true;
  /** How late each frame arrived against where it was put (samples), the last few seconds. */
  private lates: { at: number; late: number }[] = [];
  /** Samples still to cut from the next frames (the sound ran ahead of the picture). */
  private debt = 0;

  constructor(private readonly t0: number) {}

  private pos(at: number): number {
    return Math.round(((at - this.t0) * AUDIO_RATE) / 1000);
  }

  /** What to write for a frame (stereo interleaved) that arrived at `at` (wall ms), sent at `sentMs` by the sender's clock (its start), when known. */
  frame(pcm: Float32Array, at: number, sentMs: number | null = null): Buffer[] {
    const n = pcm.length / 2;
    const out: Buffer[] = [];
    let drop = 0;
    const tolerance = (AUDIO_GAP_MS * AUDIO_RATE) / 1000;
    if (this.resync) {
      // Where its arrival puts it.
      const start = this.pos(at) - n;
      if (start > this.written) out.push(this.pad(start - this.written));
      else drop = this.written - start;
    } else if (sentMs !== null && this.sentEnd !== null) {
      // A gap (or an overlap) in what the sender sent.
      const gap = Math.round(((sentMs - this.sentEnd) * AUDIO_RATE) / 1000);
      if (gap > tolerance) out.push(this.pad(gap));
      else if (gap < -tolerance) drop = -gap;
    }
    drop = Math.min(n, drop);
    const owed = Math.min(n - drop, this.debt);
    drop += owed;
    this.debt -= owed;
    if (drop < n) out.push(Buffer.from(pcm.buffer, pcm.byteOffset + drop * 8, (n - drop) * 8));
    this.written += n - drop;
    this.resync = false;
    this.lastArrival = at;
    this.sentEnd = sentMs !== null ? sentMs + (n * 1000) / AUDIO_RATE : null;
    // Against the picture: the earliest arrivals of the last seconds.
    this.lates.push({ at, late: this.pos(at) - this.written });
    while (this.lates.length && this.lates[0]!.at < at - AUDIO_WINDOW_MS) this.lates.shift();
    const slack = (AUDIO_SLACK_MS * AUDIO_RATE) / 1000;
    if (this.lates.length >= 4 && at - this.lates[0]!.at >= AUDIO_WINDOW_MS / 2) {
      const min = Math.min(...this.lates.map((x) => x.late));
      if (min > slack) {
        // Behind the picture: silence moves it on.
        out.push(this.pad(min));
        for (const x of this.lates) x.late -= min;
      } else if (min < -slack && this.debt === 0) {
        // Ahead of the picture: cut from the next frames.
        this.debt = -min;
        for (const x of this.lates) x.late -= min;
      }
    }
    return out;
  }

  /** Silence when no sound has come for a while (a source without audio): up to a moment behind `now`. */
  fill(now: number): Buffer | null {
    if (now - this.lastArrival < AUDIO_FILL_AFTER_MS || this.pos(now) - this.written < (AUDIO_FILL_AFTER_MS * AUDIO_RATE) / 1000) return null;
    const b = this.until(now - AUDIO_FILL_BEHIND_MS);
    if (b) this.resync = true;
    return b;
  }

  /** Silence up to `at` (the start, before any sound came). */
  until(at: number): Buffer | null {
    const to = this.pos(at);
    if (to <= this.written) return null;
    return this.pad(to - this.written);
  }

  private pad(samples: number): Buffer {
    const k = Math.max(0, Math.round(samples));
    this.written += k;
    return silence(k);
  }
}

const silence = (samples: number) => Buffer.alloc(Math.max(0, Math.round(samples)) * 8);

export class FeedRecording {
  private stopped = false;
  private ff: ChildProcess | null = null;
  private format: string | null = null;
  private stderr = "";
  private frames = 0;
  private dropped = 0;
  private arrivals: number[] = [];
  private session: { id: string; dir: string; started: boolean; width: number; height: number; fps: number; audio: boolean; audioT0: number } | null = null;
  /** The sound on the picture's clock (null: this session records no sound). */
  private clock: AudioClock | null = null;
  /** Why the recording has no sound (ffmpeg couldn't open its second input, the binding has no audio), or null. */
  private audioOff: string | null = null;
  private lastVideo = 0;

  constructor(
    private readonly ndi: NdiModule,
    private readonly o: FeedOptions,
    private readonly emit: (e: FeedEvent) => void,
  ) {}

  async run(): Promise<void> {
    const rx = await this.ndi.receive({ source: this.o.source, colorFormat: this.ndi.COLOR_FORMAT_UYVY_BGRA, name: "Matchframe replay feed" });
    // Video and sound with one call (the binding's data()), else the picture only.
    const both = typeof rx.data === "function";
    if (!both) this.audioOff = "the NDI binding receives no sound";
    const audioFormat = this.ndi.AUDIO_FORMAT_FLOAT_32_INTERLEAVED ?? 1;
    let lastStats = Date.now();
    try {
      while (!this.stopped) {
        let f: Awaited<ReturnType<NonNullable<NdiReceiver["data"]>>> | NdiVideoFrame | { type: "timeout" } | null = null;
        try {
          f = both ? await rx.data!({ audioFormat }, FRAME_WAIT_MS) : await rx.video(FRAME_WAIT_MS);
        } catch {
          f = null;
        }
        if (f && "data" in f && (!("type" in f) || f.type === "video")) {
          this.lastVideo = Date.now();
          this.onFrame(f as NdiVideoFrame);
        } else if (f && "type" in f && f.type === "audio") this.onAudio(f as NdiAudioFrame);
        this.fillSilence();
        const receiving = Date.now() - this.lastVideo < FRAME_WAIT_MS;
        const now = Date.now();
        if (now - lastStats >= 1000) {
          lastStats = now;
          this.arrivals = this.arrivals.filter((t) => now - t < 2000);
          this.emit({ type: "stats", frames: this.frames, dropped: this.dropped, fps: this.arrivals.length / 2, receiving });
        }
      }
    } finally {
      rx.destroy();
      this.closeFfmpeg();
      this.emit({ type: "stopped" });
    }
  }

  stop(): void {
    this.stopped = true;
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

  private onFrame(f: NdiVideoFrame): void {
    const pf = this.pixelFormat(f.fourCC);
    if (!pf) {
      if (this.format !== `unsupported:${f.fourCC}`) this.emit({ type: "error", message: `the NDI source sends a picture format the feed can't record (FourCC ${f.fourCC})` });
      this.format = `unsupported:${f.fourCC}`;
      return;
    }
    const rate = f.frameRateN > 0 && f.frameRateD > 0 ? `${f.frameRateN}/${f.frameRateD}` : "60/1";
    const key = `${f.xres}x${f.yres}:${pf.pix}:${rate}`;
    if (key !== this.format || !this.ff) {
      this.closeFfmpeg();
      this.format = key;
      this.startFfmpeg(f.xres, f.yres, pf.pix, rate);
    }
    const stdin = this.ff?.stdin;
    if (!stdin || stdin.destroyed) return;
    // The encoder is behind: drop this frame rather than queue it (ffmpeg repeats the last one, the time stays right).
    if (stdin.writableNeedDrain) {
      this.dropped++;
      return;
    }
    const row = f.xres * pf.bpp;
    let data = f.data;
    if (f.lineStrideBytes !== row) {
      data = Buffer.alloc(row * f.yres);
      for (let y = 0; y < f.yres; y++) f.data.copy(data, y * row, y * f.lineStrideBytes, y * f.lineStrideBytes + row);
    }
    const s = this.session!;
    if (!s.started) {
      s.started = true;
      // The sound from when ffmpeg started (its offset), silent until sound comes.
      if (s.audio) {
        this.clock = new AudioClock(s.audioT0);
        const b = this.clock.until(Date.now());
        if (b) this.writeAudio([b]);
      }
      this.emit({ type: "session", id: s.id, dir: s.dir, t0: s.audioT0 - LEAD_MS, width: s.width, height: s.height, fps: s.fps, encoder: this.o.encoder, audio: s.audio, audioNote: s.audio ? null : this.audioOff });
    }
    stdin.write(data);
    this.frames++;
    this.arrivals.push(Date.now());
  }

  /** A sound frame: laid on the picture's clock and piped to ffmpeg (before the first picture there is no recording yet). */
  private onAudio(f: NdiAudioFrame): void {
    if (!this.clock || !this.ff) return;
    const sent = f.timestamp ?? f.timecode;
    this.writeAudio(this.clock.frame(toStereo48k(f), Date.now(), typeof sent === "bigint" ? Number(sent / 10_000n) : null));
  }

  /** No sound for a while (the source sends none): silence, so the recording's sound keeps up with its picture. */
  private fillSilence(): void {
    const b = this.clock && this.ff ? this.clock.fill(Date.now()) : null;
    if (b) this.writeAudio([b]);
  }

  private writeAudio(parts: Buffer[]): void {
    const pipe = this.ff?.stdio[3] as Writable | null | undefined;
    if (!pipe || pipe.destroyed) return;
    // (A few hundred kB a second: never dropped, ffmpeg reads it on its own thread.)
    for (const b of parts) if (b.length) pipe.write(b);
  }

  private startFfmpeg(width: number, height: number, pix: string, rate: string): void {
    const id = `s${Date.now().toString(36)}`;
    const dir = join(this.o.dir, id);
    mkdirSync(dir, { recursive: true });
    const [n, d] = rate.split("/").map(Number) as [number, number];
    const fps = n / d;
    const audio = this.audioOff === null;
    // t0: the segments' times, and the sound's samples, count from here.
    const audioT0 = Date.now();
    this.session = { id, dir, started: false, width, height, fps, audio, audioT0 };
    this.clock = null;
    this.stderr = "";
    const args = [
      "-hide_banner", "-v", "error",
      "-f", "rawvideo", "-pix_fmt", pix, "-video_size", `${width}x${height}`, "-framerate", rate, "-use_wallclock_as_timestamps", "1", "-itsoffset", `-${((audioT0 - LEAD_MS) / 1000).toFixed(3)}`, "-thread_queue_size", "64", "-i", "pipe:0",
      ...(audio ? ["-itsoffset", (LEAD_MS / 1000).toFixed(3), "-f", "f32le", "-ar", String(AUDIO_RATE), "-ac", "2", "-thread_queue_size", "1024", "-i", "pipe:3", "-map", "0:v", "-map", "1:a"] : ["-an"]),
      "-copyts",
      "-fps_mode", "cfr", "-r", rate, ...encoderArgs(this.o.encoder, fps, this.o.bitrateMbps), "-pix_fmt", "yuv420p",
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
      this.ff = null;
      this.format = null;
      this.clock = null;
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

  private closeFfmpeg(): void {
    const ff = this.ff;
    this.ff = null;
    this.clock = null;
    if (!ff) return;
    ff.stdin?.end();
    (ff.stdio[3] as Writable | null)?.end();
    // ffmpeg writes its last segment when its input ends; it is killed if it doesn't stop.
    setTimeout(() => ff.kill(), 5000).unref?.();
  }
}
