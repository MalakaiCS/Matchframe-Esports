import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ClipMedia } from "./provider.ts";

const run = promisify(execFile);

/** Reads actual clip facts with ffprobe; nothing is assumed about duration, fps or audio. */
export async function probeMedia(path: string, ffprobe = "ffprobe"): Promise<ClipMedia> {
  try {
    const { stdout } = await run(ffprobe, ["-v", "error", "-show_entries", "format=duration:stream=codec_type,avg_frame_rate,time_base,start_pts,width,height", "-of", "json", path], { timeout: 10000 });
    const j = JSON.parse(stdout) as {
      format?: { duration?: string };
      streams?: { codec_type?: string; avg_frame_rate?: string; time_base?: string; start_pts?: number; width?: number; height?: number }[];
    };
    const video = j.streams?.find((s) => s.codec_type === "video");
    const fr = video?.avg_frame_rate?.split("/").map(Number);
    return {
      path,
      durationMs: j.format?.duration ? Math.round(Number(j.format.duration) * 1000) : null,
      frameRate: fr && fr.length === 2 && fr[1] ? fr[0]! / fr[1]! : null,
      timebase: video?.time_base ?? null,
      startPts: video?.start_pts ?? null,
      hasAudio: j.streams ? j.streams.some((s) => s.codec_type === "audio") : null,
      width: video?.width ?? null,
      height: video?.height ?? null,
    };
  } catch {
    return { path, durationMs: null, frameRate: null, timebase: null, startPts: null, hasAudio: null, width: null, height: null };
  }
}

/** Lossless trim (stream copy) of a clip to [startMs, startMs + durationMs). */
export async function trimClip(input: string, output: string, startMs: number, durationMs: number, ffmpeg = "ffmpeg"): Promise<void> {
  await run(ffmpeg, ["-y", "-v", "error", "-ss", (startMs / 1000).toFixed(3), "-i", input, "-t", (durationMs / 1000).toFixed(3), "-c", "copy", output], { timeout: 60000 });
}
