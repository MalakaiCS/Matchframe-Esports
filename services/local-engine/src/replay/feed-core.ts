import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Encoder } from "./ffmpeg.ts";
import { encoderArgs } from "./ffmpeg.ts";

/**
 * Records an NDI source (the replay PC's screen) into one-second H.264 segments with ffmpeg. Runs in
 * the replay feed's own process (feed-worker.ts), so the frames (about 250 MB a second at 1080p60)
 * never touch the engine. Each frame is piped to ffmpeg as it arrives and stamped with the time it
 * arrived (`-use_wallclock_as_timestamps`), so the segments' times (list.csv, from the session's
 * first frame) are real time: the engine cuts clips by the time a kill happened (replay/feed.ts).
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
export interface NdiReceiver {
  video(timeoutMs?: number): Promise<NdiVideoFrame | { type: "timeout" }>;
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
  | { type: "session"; id: string; dir: string; t0: number; width: number; height: number; fps: number; encoder: Encoder }
  | { type: "stats"; frames: number; dropped: number; fps: number; receiving: boolean }
  | { type: "error"; message: string }
  | { type: "stopped" };

/** Each wait for a frame (ms); after this long without one, the source counts as not sending. */
const FRAME_WAIT_MS = 1000;

export class FeedRecording {
  private stopped = false;
  private ff: ChildProcess | null = null;
  private format: string | null = null;
  private stderr = "";
  private frames = 0;
  private dropped = 0;
  private arrivals: number[] = [];
  private session: { id: string; dir: string; t0: number | null; width: number; height: number; fps: number } | null = null;

  constructor(
    private readonly ndi: NdiModule,
    private readonly o: FeedOptions,
    private readonly emit: (e: FeedEvent) => void,
  ) {}

  async run(): Promise<void> {
    const rx = await this.ndi.receive({ source: this.o.source, colorFormat: this.ndi.COLOR_FORMAT_UYVY_BGRA, name: "Matchframe replay feed" });
    let lastStats = Date.now();
    try {
      while (!this.stopped) {
        let f: NdiVideoFrame | { type: "timeout" } | null = null;
        try {
          f = await rx.video(FRAME_WAIT_MS);
        } catch {
          f = null;
        }
        const frame = f && "data" in f ? f : null;
        const receiving = !!frame;
        if (frame) this.onFrame(frame);
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
    if (s.t0 === null) {
      s.t0 = Date.now();
      this.emit({ type: "session", id: s.id, dir: s.dir, t0: s.t0, width: s.width, height: s.height, fps: s.fps, encoder: this.o.encoder });
    }
    stdin.write(data);
    this.frames++;
    this.arrivals.push(Date.now());
  }

  private startFfmpeg(width: number, height: number, pix: string, rate: string): void {
    const id = `s${Date.now().toString(36)}`;
    const dir = join(this.o.dir, id);
    mkdirSync(dir, { recursive: true });
    const [n, d] = rate.split("/").map(Number) as [number, number];
    const fps = n / d;
    this.session = { id, dir, t0: null, width, height, fps };
    this.stderr = "";
    const args = [
      "-hide_banner", "-v", "error",
      "-f", "rawvideo", "-pix_fmt", pix, "-video_size", `${width}x${height}`, "-framerate", rate, "-use_wallclock_as_timestamps", "1", "-thread_queue_size", "64", "-i", "pipe:0",
      "-an", "-fps_mode", "cfr", "-r", rate, ...encoderArgs(this.o.encoder, fps, this.o.bitrateMbps), "-pix_fmt", "yuv420p",
      "-f", "segment", "-segment_time", "1", "-segment_format", "mpegts", "-segment_list", join(dir, "list.csv"), "-segment_list_type", "csv", "-segment_list_flags", "+live", join(dir, "seg_%06d.ts"),
    ];
    const ff = spawn(this.o.ffmpeg, args, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    this.ff = ff;
    ff.stdin.on("error", () => undefined);
    ff.stderr.on("data", (b: Buffer) => {
      this.stderr = (this.stderr + b.toString()).slice(-2000);
    });
    ff.on("exit", (code) => {
      if (this.ff !== ff) return;
      this.ff = null;
      this.format = null;
      if (!this.stopped) this.emit({ type: "error", message: `ffmpeg stopped (${code ?? "killed"}): ${this.stderr.trim().split("\n").slice(-2).join(" ") || "no message"}` });
    });
  }

  private closeFfmpeg(): void {
    const ff = this.ff;
    this.ff = null;
    if (!ff) return;
    ff.stdin?.end();
    // ffmpeg writes its last segment when its input ends; it is killed if it doesn't stop.
    setTimeout(() => ff.kill(), 5000).unref?.();
  }
}
