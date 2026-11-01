import { spawn, type ChildProcess } from "node:child_process";
import { renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Encoder } from "./ffmpeg.ts";
import { renderArgs } from "./ffmpeg.ts";
import { filterOption, probeClip, reelFormat, reelGraph, type ProbedClip, type ReelInput } from "./reel.ts";

/**
 * Rendered breaks (ADR-067): a break's chosen clips (or Test replays' samples, or highlights on air)
 * joined by ffmpeg into one file, played in the replay scene's one media source. Each clip is cut to
 * its part (its lead-up and the play), normalised to one size, frame rate and sound (the highlight
 * reel's graph, replay/reel.ts) and joined to the next with a crossfade of picture and sound (xfade and
 * acrossfade; a cut joins them plainly). The sound fades in at the start and out at the end.
 *
 * The file opens on the first clip's first frame held for LEAD_MS and ends on the last clip's last
 * frame held for TAIL_MS, in silence: the clips start as Replay in shows the scene (a Stinger's cut
 * point) whatever its length, and Replay out covers the end. A keyframe starts each clip (where the
 * fade into it begins), so a seek to it (Skip) is exact. The file's layout (where each clip starts)
 * comes from the clips' lengths alone, so the replay graphic follows the media source's cursor.
 */

/** The first frame held before the first clip (ms): a Stinger's cut point up to this long still opens on the clip's first frame. */
export const LEAD_MS = 1200;
/** The last frame held after the last clip (ms), in silence: under Replay out. */
export const TAIL_MS = 1000;

/** Where each part of a rendered break is in its file (ms). */
export interface BreakLayout {
  /** The first frame held, before the first clip. */
  leadMs: number;
  /** The clips, from the first one's start to the last one's end. */
  contentMs: number;
  /** The last frame held after them. */
  tailMs: number;
  /** The whole file. */
  totalMs: number;
  /** The fade from one clip to the next (0: a cut). */
  fadeMs: number;
  /** The sound's fade in at the start and out at the end. */
  audioFadeMs: number;
  /** Where each clip starts in the file: where the fade into it begins (the first: at leadMs). */
  starts: number[];
}

/**
 * The layout of a file of clips `durations` (ms) long: a fade of `fadeMs` between each two (at most a
 * third of the shorter one; none for one clip), the sound faded in and out over `audioFadeMs` (at most
 * a quarter of the whole).
 */
export function breakLayout(durations: readonly number[], fadeMs: number, audioFadeMs: number, leadMs = LEAD_MS, tailMs = TAIL_MS): BreakLayout {
  const fade = durations.length > 1 ? Math.max(0, Math.min(fadeMs, 2000, ...durations.map((d) => Math.floor(d / 3)))) : 0;
  const starts: number[] = [];
  let at = leadMs;
  for (const d of durations) {
    starts.push(at);
    at += d - fade;
  }
  const contentMs = Math.max(0, at + fade - leadMs);
  return { leadMs, contentMs, tailMs, totalMs: leadMs + contentMs + tailMs, fadeMs: fade, audioFadeMs: Math.max(0, Math.min(audioFadeMs, Math.floor(contentMs / 4))), starts };
}

/** One clip of a rendered break: its file, and its part (how long, and where it starts: null, the file's end part). */
export interface RenderClip {
  file: string;
  startMs: number | null;
  durationMs: number;
}

export interface RenderRequest {
  ffmpeg: string;
  /** ffmpeg's version (for how a long filter graph is passed). */
  version: string | null;
  encoder: Encoder;
  clips: RenderClip[];
  fadeMs: number;
  audioFadeMs: number;
  /** The MP4 to write (it appears once complete). */
  outFile: string;
}

export interface RenderedBreak {
  file: string;
  layout: BreakLayout;
  /** How long the render took (ms). */
  ms: number;
  width: number;
  height: number;
  fps: number;
  encoder: Encoder;
  bytes: number;
}

/** A render under way: done once the file is written (rejects when it fails or is cancelled). */
export interface RenderJob {
  readonly done: Promise<RenderedBreak>;
  /** How far it is (0–1). */
  progress(): number;
  cancel(): void;
}

/** What renders a break (render.ts's ffmpeg; tests put a stand-in in its place). */
export type BreakRenderer = (req: RenderRequest) => RenderJob;

const sec = (ms: number) => (Math.max(0, ms) / 1000).toFixed(3);

/**
 * The size and frame rate of a rendered break: the clips' own when they all have the same (the replay
 * PC's clips: 1920×1072 at 29.97 fps, played as they are), else the highlight reel's (1920×1080 or the
 * largest, the highest frame rate up to 60).
 */
export function breakFormat(probed: readonly Pick<ProbedClip, "width" | "height" | "fps">[]): { width: number; height: number; fps: number } {
  const first = probed[0];
  const same = !!first?.width && !!first.height && !!first.fps && probed.every((p) => p.width === first.width && p.height === first.height && p.fps === first.fps);
  if (same && first.width! % 2 === 0 && first.height! % 2 === 0 && first.fps! <= 60) return { width: first.width!, height: first.height!, fps: first.fps! };
  const f = reelFormat([...probed]);
  const top = Math.max(0, ...probed.map((p) => p.fps ?? 0));
  return { ...f, fps: top > 0 ? Math.min(60, top) : f.fps };
}

/**
 * ffmpeg's arguments for a rendered break: the reel's graph, then the first frame held before and the
 * last after (tpad), the sound faded in and out and laid after the held first frame (silence before it),
 * padded with silence to the end; keyframes at each clip's start.
 */
export function renderCommand(req: RenderRequest, inputs: ReelInput[], format: { width: number; height: number; fps: number }, layout: BreakLayout, filterFile: string): { args: string[]; filter: string } {
  const graph = reelGraph(inputs, { ...format, fadeMs: layout.fadeMs });
  const L = sec(layout.leadMs);
  const a = layout.audioFadeMs > 0 ? `afade=t=in:st=0:d=${sec(layout.audioFadeMs)},afade=t=out:st=${sec(layout.contentMs - layout.audioFadeMs)}:d=${sec(layout.audioFadeMs)},` : "";
  const filter = [
    graph.filter,
    `[vout]tpad=start_duration=${L}:start_mode=clone:stop_duration=${sec(layout.tailMs)}:stop_mode=clone,trim=duration=${sec(layout.totalMs)},setpts=PTS-STARTPTS[vfin]`,
    // (Silence joined before the sound: adelay after acrossfade leaves it where it was.)
    `anullsrc=r=48000:cl=stereo,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,atrim=duration=${L}[alead]`,
    `[aout]${a}anull[aclips]`,
    `[alead][aclips]concat=n=2:v=0:a=1,apad,atrim=duration=${sec(layout.totalMs)},asetpts=PTS-STARTPTS[afin]`,
  ].join(";\n");
  const args = [
    "-hide_banner",
    "-nostdin",
    "-y",
    ...graph.args,
    ...filterOption(req.version, filterFile, filter),
    "-map",
    "[vfin]",
    "-map",
    "[afin]",
    ...renderArgs(req.encoder, format.fps),
    // A keyframe at each clip's start (Skip lands there), and every 100 ms of the first frame held (the skip as Replay in shows the scene lands where it is sent: OBS goes to the keyframe before).
    "-force_key_frames",
    [...Array.from({ length: Math.floor(layout.leadMs / 100) }, (_, k) => k * 100), ...layout.starts].map((s) => sec(s)).join(","),
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(format.fps),
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
    "-f",
    "mp4",
  ];
  return { args, filter };
}

/** Renders a break with ffmpeg (in the background; cancel kills it). */
export const renderBreak: BreakRenderer = (req) => {
  let child: ChildProcess | null = null;
  let cancelled = false;
  let progress = 0;
  const started = Date.now();
  const partial = `${req.outFile}.part`;
  const filterFile = `${req.outFile}.filter.txt`;
  const done = (async (): Promise<RenderedBreak> => {
    try {
      const probed = await Promise.all(req.clips.map((c) => probeClip(req.ffmpeg, c.file)));
      if (cancelled) throw new Error("cancelled");
      const bad = probed.findIndex((p) => !p.durationMs || !p.width);
      if (bad >= 0) throw new Error(`ffmpeg can't read clip ${bad + 1} (${req.clips[bad]!.file})`);
      // A part never runs past its file's end.
      const clips = req.clips.map((c, i) => {
        const d = probed[i]!.durationMs!;
        const startMs = Math.max(0, Math.min(c.startMs ?? d - c.durationMs, d - 500));
        return { ...c, startMs, durationMs: Math.max(500, Math.min(c.durationMs, d - startMs)) };
      });
      const layout = breakLayout(
        clips.map((c) => c.durationMs),
        req.fadeMs,
        req.audioFadeMs,
      );
      const format = breakFormat(probed);
      const inputs: ReelInput[] = clips.map((c, i) => ({ file: c.file, startMs: c.startMs, durationMs: c.durationMs, hasAudio: probed[i]!.hasAudio, graphic: null }));
      const cmd = renderCommand(req, inputs, format, layout, filterFile);
      writeFileSync(filterFile, cmd.filter);
      const args = [...cmd.args, partial];
      await new Promise<void>((resolve, reject) => {
        const c = spawn(req.ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        child = c;
        let err = "";
        let buf = "";
        c.stdout!.on("data", (d: Buffer) => {
          buf += d.toString();
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const l of lines) {
            const m = /^out_time_(?:us|ms)=(\d+)/.exec(l.trim());
            if (m) progress = Math.min(0.99, Number(m[1]) / 1000 / layout.totalMs);
          }
        });
        c.stderr!.on("data", (d: Buffer) => {
          err = (err + d.toString()).slice(-4000);
        });
        c.on("error", reject);
        c.on("close", (code) => {
          if (cancelled) return reject(new Error("cancelled"));
          if (code === 0) return resolve();
          const why = err.trim().split("\n").filter((l) => l.trim()).slice(-3).join(" ");
          reject(new Error(`ffmpeg stopped (exit ${code}): ${why || "no message"}`));
        });
        if (cancelled) c.kill();
      });
      renameSync(partial, req.outFile);
      progress = 1;
      return { file: req.outFile, layout, ms: Date.now() - started, ...format, encoder: req.encoder, bytes: statSync(req.outFile).size };
    } finally {
      rmSync(partial, { force: true });
      rmSync(filterFile, { force: true });
    }
  })();
  return {
    done,
    progress: () => progress,
    cancel: () => {
      cancelled = true;
      (child as ChildProcess | null)?.kill();
    },
  };
};
