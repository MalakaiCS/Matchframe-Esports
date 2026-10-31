import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Engine } from "../app.ts";
import { HttpError } from "../http/router.ts";
import { encoderArgs } from "./ffmpeg.ts";
import type { ReelChoice } from "./highlights.ts";

const run = promisify(execFile);

/**
 * Highlight reels (ADR-061): a map's best clips as one MP4 for social media. The clips are
 * normalised to one size (1920×1080, or the largest clip's), one frame rate, yuv420p H.264 (CRF 18)
 * and 48 kHz stereo AAC (silence where a clip has no sound), joined with crossfades (xfade and
 * acrossfade), and each clip's lower third (a PNG drawn by the console) can be laid over it with a
 * fade in and out. One ffmpeg run, in the background, with progress, and it can be stopped.
 */

/** A clip as ffmpeg reads it. */
export interface ReelInput {
  file: string;
  /** Where the part starts in the file, and how long it is (ms). */
  startMs: number;
  durationMs: number;
  hasAudio: boolean;
  /** A 1920×1080 PNG laid over the part (transparent around the graphic), or null. */
  graphic: string | null;
}

export interface ReelOutput {
  width: number;
  height: number;
  fps: number;
  fadeMs: number;
}

/** What ffmpeg reports about a file (`ffmpeg -i`; ffprobe isn't always there). */
export interface ProbedClip {
  durationMs: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasAudio: boolean;
}

export async function probeClip(ffmpeg: string, file: string): Promise<ProbedClip> {
  // Without an output ffmpeg exits with an error after describing the input.
  const out = await run(ffmpeg, ["-hide_banner", "-i", file], { timeout: 20_000 }).then(
    (r) => r.stderr,
    (err: { stderr?: string }) => err.stderr ?? "",
  );
  return parseProbe(out);
}

export function parseProbe(text: string): ProbedClip {
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  const video = /Stream #\d+:\d+[^\n]*?: Video: [^\n]*/.exec(text)?.[0] ?? "";
  const size = /, (\d{2,5})x(\d{2,5})[\s,[]/.exec(video);
  const fps = /, ([\d.]+) fps/.exec(video) ?? /, ([\d.]+) tbr/.exec(video);
  return {
    durationMs: d ? Math.round((Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3])) * 1000) : null,
    width: size ? Number(size[1]) : null,
    height: size ? Number(size[2]) : null,
    fps: fps ? Number(fps[1]) : null,
    hasAudio: /Stream #\d+:\d+[^\n]*?: Audio: /.test(text),
  };
}

/** The reel's size and frame rate: 1920×1080 or the largest clip's size; the highest frame rate (at most 60). */
export function reelFormat(clips: Pick<ProbedClip, "width" | "height" | "fps">[]): { width: number; height: number; fps: number } {
  let width = 1920;
  let height = 1080;
  for (const c of clips) if (c.width && c.height && c.width * c.height > width * height) [width, height] = [c.width, c.height];
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const top = Math.max(0, ...clips.map((c) => c.fps ?? 0));
  const fps = top > 0 ? Math.min(60, Math.round(top)) : 60;
  return { width: even(width), height: even(height), fps };
}

const sec = (ms: number) => (Math.max(0, ms) / 1000).toFixed(3);

/** The lower third's fade in and out (s), and when it shows: after the crossfade in, until before the one out. */
const GRAPHIC_FADE = 0.35;

/**
 * ffmpeg's inputs and filter graph for a reel. Each clip's part is read with -ss/-t, scaled into the
 * frame (letterboxed when its shape differs), set to one frame rate and padded or cut to exactly its
 * length (so the crossfade offsets hold); its sound resampled to 48 kHz stereo, or silence, and cut
 * to the same length. Then xfade and acrossfade between each two (concat without a fade).
 */
export function reelGraph(inputs: ReelInput[], out: ReelOutput): { args: string[]; filter: string; totalMs: number } {
  const { width: W, height: H, fps: F } = out;
  const fade = inputs.length > 1 ? out.fadeMs / 1000 : 0;
  const args: string[] = [];
  const parts: string[] = [];
  let n = 0;
  inputs.forEach((c, i) => {
    const D = c.durationMs / 1000;
    const vi = n++;
    args.push("-ss", sec(c.startMs), "-t", sec(c.durationMs + 500), "-i", c.file);
    const shape = `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${F},format=yuv420p`;
    const exact = `tpad=stop_mode=clone:stop_duration=1,trim=duration=${D.toFixed(3)},setpts=PTS-STARTPTS`;
    if (c.graphic) {
      const gi = n++;
      args.push("-loop", "1", "-framerate", String(F), "-t", D.toFixed(3), "-i", c.graphic);
      const inAt = Math.min(fade + 0.3, Math.max(0, D / 4));
      const outAt = Math.max(inAt + GRAPHIC_FADE, D - fade - 0.3 - GRAPHIC_FADE);
      parts.push(`[${vi}:v]setpts=PTS-STARTPTS,${shape},${exact}[c${i}]`);
      parts.push(`[${gi}:v]format=rgba,scale=${W}:${H},fade=t=in:st=${inAt.toFixed(3)}:d=${GRAPHIC_FADE}:alpha=1,fade=t=out:st=${outAt.toFixed(3)}:d=${GRAPHIC_FADE}:alpha=1[g${i}]`);
      parts.push(`[c${i}][g${i}]overlay=0:0:shortest=1,format=yuv420p[v${i}]`);
    } else {
      parts.push(`[${vi}:v]setpts=PTS-STARTPTS,${shape},${exact}[v${i}]`);
    }
    const audio = c.hasAudio ? `[${vi}:a]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS,` : "anullsrc=channel_layout=stereo:sample_rate=48000,aformat=sample_fmts=fltp,";
    parts.push(`${audio}apad,atrim=duration=${D.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
  });
  if (inputs.length === 1) {
    parts.push("[v0]null[vout]", "[a0]anull[aout]");
  } else if (fade === 0) {
    parts.push(`${inputs.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${inputs.length}:v=1:a=1[vout][aout]`);
  } else {
    let offset = 0;
    let v = "v0";
    let a = "a0";
    for (let i = 1; i < inputs.length; i++) {
      offset += inputs[i - 1]!.durationMs / 1000 - fade;
      const last = i === inputs.length - 1;
      const vo = last ? "vout" : `x${i}`;
      const ao = last ? "aout" : `y${i}`;
      parts.push(`[${v}][v${i}]xfade=transition=fade:duration=${fade.toFixed(3)}:offset=${offset.toFixed(3)}[${vo}]`);
      parts.push(`[${a}][a${i}]acrossfade=d=${fade.toFixed(3)}:c1=tri:c2=tri[${ao}]`);
      v = vo;
      a = ao;
    }
  }
  const totalMs = inputs.reduce((s, c) => s + c.durationMs, 0) - Math.round(fade * 1000) * Math.max(0, inputs.length - 1);
  return { args, filter: parts.join(";\n"), totalMs };
}

export interface ReelJob {
  id: string;
  mapKey: string;
  title: string;
  state: "running" | "done" | "failed" | "cancelled";
  /** What it does now ("Reading the clips", "Encoding"). */
  step: string;
  progress: number;
  clips: number;
  durationMs: number;
  /** The finished file, and the folder it is in. */
  file: string | null;
  folder: string;
  bytes: number | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface ReelRequest extends ReelChoice {
  /** The planned clips, in order (from the plan). */
  clipIds: string[];
  /** Lower thirds to burn in (PNG, base64), by clip id. */
  graphics?: Record<string, string>;
}

const KEEP_JOBS = 10;

/** File names: letters, digits and a few signs. */
const safeName = (s: string) =>
  s
    .replace(/[<>:"/\\|?*]/g, " ")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

export class HighlightReels {
  private jobs: ReelJob[] = [];
  private running: { job: ReelJob; child: ChildProcess | null; cancelled: boolean } | null = null;

  constructor(private readonly e: Engine) {}

  /** Where reels go: the desktop program's Videos folder, else the data folder's exports/highlights. */
  folder(): string {
    return this.e.cfg.videosDir ? join(this.e.cfg.videosDir, "Matchframe Highlights") : join(this.e.cfg.dataDir, "exports", "highlights");
  }

  list(): ReelJob[] {
    return [...this.jobs].reverse();
  }

  get(id: string): ReelJob | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  /** Starts a reel in the background (one at a time). */
  async start(req: ReelRequest): Promise<ReelJob> {
    if (this.running) throw new HttpError(409, "a highlight reel is being made: wait for it or stop it", "busy");
    const ffmpeg = await this.e.ffmpeg.locate();
    if (!ffmpeg) throw new HttpError(409, this.e.ffmpeg.status().canDownload ? "ffmpeg isn't installed: download it first" : "ffmpeg isn't installed: install it with this system's package manager", "ffmpeg_missing");
    const plan = this.e.highlights.plan(req);
    if (!plan) throw new HttpError(404, "no clips kept for that map", "no_map");
    const byId = new Map(plan.clips.map((c) => [c.id, c]));
    const ids = req.clipIds.filter((id) => byId.has(id));
    if (ids.length === 0) throw new HttpError(409, "none of those clips is kept any more: plan the reel again", "no_clips");
    const kept = new Map(this.e.highlights.map(plan.mapKey)!.clips.map((c) => [c.id, c]));
    const job: ReelJob = {
      id: `reel_${Date.now().toString(36)}`,
      mapKey: plan.mapKey,
      title: [plan.displayName, plan.title].filter(Boolean).join(" · "),
      state: "running",
      step: "Reading the clips",
      progress: 0,
      clips: ids.length,
      durationMs: 0,
      file: null,
      folder: this.folder(),
      bytes: null,
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    this.jobs.push(job);
    if (this.jobs.length > KEEP_JOBS) this.jobs.shift();
    const slot = { job, child: null as ChildProcess | null, cancelled: false };
    this.running = slot;
    mkdirSync(this.e.highlights.dir, { recursive: true });
    const work = mkdtempSync(join(this.e.highlights.dir, "reel-"));
    void (async () => {
      try {
        const inputs: ReelInput[] = [];
        const probed: ProbedClip[] = [];
        for (const [i, id] of ids.entries()) {
          if (slot.cancelled) throw new Error("cancelled");
          const c = kept.get(id)!;
          const file = this.e.highlights.filePath(c);
          const p = await probeClip(ffmpeg, file);
          probed.push(p);
          const part = this.e.highlights.part(c, p.durationMs);
          const png = req.graphics?.[id];
          let graphic: string | null = null;
          if (png) {
            graphic = join(work, `g${i}.png`);
            writeFileSync(graphic, Buffer.from(png.replace(/^data:image\/png;base64,/, ""), "base64"));
          }
          inputs.push({ file, startMs: part.startMs, durationMs: part.durationMs, hasAudio: p.hasAudio, graphic });
          job.progress = ((i + 1) / ids.length) * 0.03;
        }
        const fmt = reelFormat(probed);
        const fadeMs = inputs.length > 1 ? Math.max(0, Math.min(req.fadeMs, 2000, ...inputs.map((c) => Math.floor(c.durationMs / 3)))) : 0;
        const graph = reelGraph(inputs, { ...fmt, fadeMs });
        job.durationMs = graph.totalMs;
        mkdirSync(job.folder, { recursive: true });
        // This computer's date and time in the name: "Mirage · A vs B - 2026-10-31 2114.mp4".
        const d = new Date();
        const two = (n: number) => String(n).padStart(2, "0");
        const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}${two(d.getMinutes())}`;
        let name = safeName(`${job.title || "Highlights"} - ${stamp}`) || "Highlights";
        for (let k = 2; existsSync(join(job.folder, `${name}.mp4`)); k++) name = `${safeName(`${job.title} - ${stamp}`)} (${k})`;
        const target = join(job.folder, `${name}.mp4`);
        const partial = join(work, "reel.mp4");
        const filterFile = join(work, "filter.txt");
        writeFileSync(filterFile, graph.filter);
        const video = (await this.hasX264(ffmpeg)) ? ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-profile:v", "high"] : encoderArgs(await this.e.ffmpeg.pickEncoder("auto"), fmt.fps, 16);
        const args = [
          "-hide_banner",
          "-nostdin",
          "-y",
          ...graph.args,
          ...filterOption(this.e.ffmpeg.status().version, filterFile, graph.filter),
          "-map",
          "[vout]",
          "-map",
          "[aout]",
          ...video,
          "-pix_fmt",
          "yuv420p",
          "-r",
          String(fmt.fps),
          "-c:a",
          "aac",
          "-b:a",
          "192k",
          "-ar",
          "48000",
          "-ac",
          "2",
          "-movflags",
          "+faststart",
          "-progress",
          "pipe:1",
          "-nostats",
          partial,
        ];
        if (slot.cancelled) throw new Error("cancelled");
        job.step = `Encoding ${fmt.width}×${fmt.height} at ${fmt.fps} fps`;
        await this.encode(ffmpeg, args, slot, graph.totalMs);
        renameSync(partial, target);
        Object.assign(job, { state: "done", step: "Done", progress: 1, file: target, bytes: statSync(target).size, finishedAt: new Date().toISOString() });
        this.e.audit.record("system", "highlights.reel", job.id, { file: target, clips: ids.length, durationMs: graph.totalMs });
        this.e.logger.info("highlight reel made", { file: target, clips: ids.length, durationMs: graph.totalMs });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        Object.assign(job, slot.cancelled ? { state: "cancelled", step: "Stopped" } : { state: "failed", step: "Failed", error: msg }, { finishedAt: new Date().toISOString() });
        if (!slot.cancelled) this.e.logger.warn("highlight reel failed", { error: msg });
      } finally {
        rmSync(work, { recursive: true, force: true });
        this.running = null;
      }
    })();
    return job;
  }

  /** Stops the reel being made (its file isn't kept). */
  cancel(id: string): ReelJob {
    const job = this.get(id);
    if (!job) throw new HttpError(404, "no such highlight reel", "not_found");
    if (this.running?.job === job) {
      this.running.cancelled = true;
      this.running.child?.kill();
      job.step = "Stopping";
    }
    return job;
  }

  dispose(): void {
    if (!this.running) return;
    this.running.cancelled = true;
    this.running.child?.kill();
  }

  private x264: boolean | null = null;

  private async hasX264(ffmpeg: string): Promise<boolean> {
    if (this.x264 === null) this.x264 = await run(ffmpeg, ["-hide_banner", "-encoders"], { timeout: 10_000 }).then((r) => / libx264 /.test(r.stdout), () => false);
    return this.x264;
  }

  private encode(ffmpeg: string, args: string[], slot: { job: ReelJob; child: ChildProcess | null; cancelled: boolean }, totalMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      slot.child = child;
      let err = "";
      let buf = "";
      child.stdout.on("data", (d: Buffer) => {
        buf += d.toString();
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const l of lines) {
          const m = /^out_time_(?:us|ms)=(\d+)/.exec(l.trim());
          if (m && totalMs > 0) slot.job.progress = Math.min(0.99, 0.03 + 0.96 * (Number(m[1]) / 1000 / totalMs));
        }
      });
      child.stderr.on("data", (d: Buffer) => {
        err = (err + d.toString()).slice(-4000);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (slot.cancelled) return reject(new Error("cancelled"));
        if (code === 0) return resolve();
        const why = err.trim().split("\n").filter((l) => !/^\s*$/.test(l)).slice(-3).join(" ");
        reject(new Error(`ffmpeg stopped (exit ${code}): ${why || "no message"}`));
      });
    });
  }
}

/**
 * The filter graph: on the command line when short; else from a file, by the option this ffmpeg
 * knows (`-/filter_complex` since 7, `-filter_complex_script` before).
 */
export function filterOption(version: string | null, file: string, filter: string): string[] {
  if (filter.length < 6000) return ["-filter_complex", filter];
  const major = Number(/^n?(\d+)\./.exec(version ?? "")?.[1]);
  const modern = Number.isFinite(major) ? major >= 7 : /^N-/.test(version ?? "");
  return modern ? ["-/filter_complex", file] : ["-filter_complex_script", file];
}
