import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { dirname, extname, join } from "node:path";
import { promisify } from "node:util";
import { HttpError, writeBodyToFile } from "../http/router.ts";
import type { Logger } from "../logger.ts";
import { mapDisplayName } from "../live/projection.ts";

const run = promisify(execFile);

/**
 * Map intros' videos (ADR-079): one per map of the pool, and a default for maps without one, in the
 * data folder's `map-intros/`. Each upload is checked before it is kept: read with ffprobe (beside the
 * program's ffmpeg, or on the PATH; else with ffmpeg itself, which the program has for the replay
 * feed), an MP4 or MOV with a video codec OBS and vMix play, between 0.5 s and 2 minutes, its start
 * and end decoded, and a preview frame taken from its middle. A file that fails is refused with why.
 *
 * Files are named per upload (`de_mirage-<time>.mp4`), so a replacement never writes over a file OBS
 * still has open (Windows keeps it locked); the old one is removed then, or later (sweep) if it was
 * still in use. What is kept is listed in the engine's settings (`mapIntro.files`): the program's own
 * settings, which account sync never shares; the videos are too large for it anyway.
 */

/** The maps with a slot (the program's map pool), in the order the panel lists them. */
export const MAP_INTRO_MAPS = ["de_ancient", "de_anubis", "de_dust2", "de_inferno", "de_mirage", "de_nuke", "de_overpass", "de_train", "de_vertigo", "de_cache"] as const;
export const MAP_INTRO_SLOTS = [...MAP_INTRO_MAPS, "default"] as const;
export type MapIntroSlot = (typeof MAP_INTRO_SLOTS)[number];

export const isIntroSlot = (s: string): s is MapIntroSlot => (MAP_INTRO_SLOTS as readonly string[]).includes(s);
export const slotLabel = (slot: MapIntroSlot): string => (slot === "default" ? "Default" : (mapDisplayName(slot) ?? slot));

/** An upload is refused above this (streamed to disk, never held in memory). */
export const INTRO_MAX_BYTES = 1024 * 1024 * 1024;
export const INTRO_MIN_MS = 500;
export const INTRO_MAX_MS = 120_000;

/** Video codecs OBS's Media Source and vMix play from an MP4 or MOV, as people say them. */
export const INTRO_VIDEO_CODECS: Record<string, string> = {
  h264: "H.264",
  hevc: "H.265 (HEVC)",
  prores: "Apple ProRes",
  dnxhd: "DNxHD / DNxHR",
  qtrle: "QuickTime Animation",
  png: "PNG",
  vp9: "VP9",
  av1: "AV1",
  mpeg4: "MPEG-4",
};

/** What ffprobe (or ffmpeg) says about a file. */
export interface ProbedVideo {
  by: "ffprobe" | "ffmpeg";
  /** The container as ffmpeg names it: "mov,mp4,m4a,3gp,3g2,mj2" for MP4 and MOV alike. */
  container: string | null;
  durationMs: number | null;
  video: { codec: string; width: number | null; height: number | null; fps: number | null; pixFmt: string | null } | null;
  audio: { codec: string; channels: number | null; sampleRate: number | null } | null;
  /** The file couldn't be read at all: the first line of what ffprobe or ffmpeg said. */
  error: string | null;
}

/** A kept intro. */
export interface StoredIntro {
  slot: MapIntroSlot;
  /** The video's and the preview frame's names in the map-intros folder. */
  file: string;
  preview: string | null;
  /** As uploaded. */
  originalName: string;
  bytes: number;
  durationMs: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string;
  audioCodec: string | null;
  pixFmt: string | null;
  uploadedAt: string;
  /** Worth knowing, but no reason to refuse it ("No sound", "vMix may not play VP9"). */
  notes: string[];
}

const FILES_KEY = "mapIntro.files";
/** An upload's part file older than this is an abandoned one (sweep). */
const PART_STALE_MS = 3_600_000;

const fps = (rate: unknown): number | null => {
  const m = /^(\d+)(?:\/(\d+))?$/.exec(String(rate ?? ""));
  if (!m) return null;
  const v = Number(m[1]) / Number(m[2] ?? 1);
  return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null;
};
const int = (v: unknown): number | null => (v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));
/** ffmpeg's or ffprobe's lines, without their "[mov,mp4,… @ 0x…]" and file name prefixes. */
const ffLines = (s: string) =>
  s
    .split(/\r?\n/)
    .map((l) =>
      l
        .trim()
        .replace(/^(\[[^\]]*\]\s*)+/, "")
        .replace(/^.*?\.(mp4|m4v|mov|part|mkv|webm|avi):\s*/i, ""),
    )
    .filter((l) => l && !/At least one output file must be specified/.test(l));
const firstLine = (s: string) => ffLines(s)[0] ?? "";
/** What went wrong opening a file: the summary line ffmpeg ends with ("Invalid data found when processing input"). */
const lastLine = (s: string) => ffLines(s).at(-1)?.replace(/^Error opening input:\s*/, "") ?? "";

interface FfprobeJson {
  format?: { format_name?: string; duration?: string };
  streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string; pix_fmt?: string; channels?: number; sample_rate?: string; disposition?: { attached_pic?: number } }[];
}

/** ffprobe's JSON (format and streams): a cover picture in an MP4 (attached_pic) isn't its video. */
export function parseFfprobe(j: FfprobeJson): ProbedVideo {
  const streams = j.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === "audio");
  const d = Number(j.format?.duration);
  return {
    by: "ffprobe",
    container: j.format?.format_name ?? null,
    durationMs: Number.isFinite(d) && d > 0 ? Math.round(d * 1000) : null,
    video: v?.codec_name ? { codec: v.codec_name, width: int(v.width), height: int(v.height), fps: fps(v.avg_frame_rate) ?? fps(v.r_frame_rate), pixFmt: v.pix_fmt ?? null } : null,
    audio: a?.codec_name ? { codec: a.codec_name, channels: int(a.channels), sampleRate: int(a.sample_rate) } : null,
    error: null,
  };
}

/** What `ffmpeg -i` prints about its input (ffprobe isn't always beside the program's ffmpeg). */
export function parseFfmpegInfo(text: string): ProbedVideo {
  const container = /Input #0, (.+?), from '/.exec(text)?.[1] ?? null;
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  const videoLine = text.split(/\r?\n/).find((l) => /Stream #\d+:\d+.*?: Video: /.test(l) && !/attached pic/.test(l)) ?? null;
  const audioLine = text.split(/\r?\n/).find((l) => /Stream #\d+:\d+.*?: Audio: /.test(l)) ?? null;
  const vCodec = videoLine ? /: Video: (\w+)/.exec(videoLine)?.[1] : undefined;
  const aCodec = audioLine ? /: Audio: (\w+)/.exec(audioLine)?.[1] : undefined;
  const size = videoLine ? /, (\d{2,5})x(\d{2,5})[\s,[]/.exec(`${videoLine} `) : null;
  const rate = videoLine ? (/, ([\d.]+) fps/.exec(videoLine) ?? /, ([\d.]+) tbr/.exec(videoLine)) : null;
  // "Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1920x1080 …": the pixel format follows the codec's part.
  const pix = videoLine ? /: Video: [^,]+, ([a-z0-9]+)/.exec(videoLine)?.[1] : undefined;
  const hz = audioLine ? /, (\d+) Hz/.exec(audioLine)?.[1] : undefined;
  const layout = audioLine ? /Hz, ([^,]+)/.exec(audioLine)?.[1]?.trim() : undefined;
  const channels = layout === "mono" ? 1 : layout === "stereo" ? 2 : layout?.startsWith("5.1") ? 6 : layout?.startsWith("7.1") ? 8 : null;
  const durationMs = d ? Math.round((Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3])) * 1000) : null;
  return {
    by: "ffmpeg",
    container,
    durationMs: durationMs && durationMs > 0 ? durationMs : null,
    video: vCodec ? { codec: vCodec, width: size ? Number(size[1]) : null, height: size ? Number(size[2]) : null, fps: rate ? Number(rate[1]) : null, pixFmt: pix ?? null } : null,
    audio: aCodec ? { codec: aCodec, channels, sampleRate: hz ? Number(hz) : null } : null,
    error: container !== null ? null : lastLine(text) || "not a video ffmpeg can read",
  };
}

/** The tools to read a file with: ffmpeg (needed), and ffprobe when there is one. */
export interface ProbeTools {
  ffmpeg: string;
  ffprobe: string | null;
}

/** Reads a file with ffprobe, or with ffmpeg when there is no ffprobe. */
export async function probeVideo(file: string, tools: ProbeTools): Promise<ProbedVideo> {
  if (tools.ffprobe) {
    try {
      const { stdout } = await run(tools.ffprobe, ["-v", "error", "-show_entries", "format=format_name,duration:stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,pix_fmt,channels,sample_rate:stream_disposition=attached_pic", "-of", "json", file], { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
      return parseFfprobe(JSON.parse(stdout) as FfprobeJson);
    } catch (err) {
      const e = err as { code?: unknown; stderr?: string };
      // Not there after all: ffmpeg reads it. Any other failure: ffprobe couldn't read the file.
      if (e.code !== "ENOENT") return { by: "ffprobe", container: null, durationMs: null, video: null, audio: null, error: lastLine(e.stderr ?? "") || (err instanceof Error ? err.message : String(err)) };
    }
  }
  // Without an output ffmpeg describes its input and exits with an error.
  const text = await run(tools.ffmpeg, ["-hide_banner", "-nostdin", "-i", file], { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }).then(
    (r) => r.stderr,
    (err: { stderr?: string }) => err.stderr ?? "",
  );
  return parseFfmpegInfo(text);
}

/** m:ss, or s.s under a minute. */
export const fmtLength = (ms: number): string => (ms < 60_000 ? `${(Math.round(ms / 100) / 10).toFixed(1)} s` : `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}`);

/** Whether a probed file can be an intro: why not, or the notes worth showing with it. */
export function checkIntro(p: ProbedVideo): { ok: false; reason: string } | { ok: true; notes: string[] } {
  if (p.error || !p.container) return { ok: false, reason: `${p.by === "ffprobe" ? "ffprobe" : "ffmpeg"} can't read it as a video (${p.error ?? "unknown format"}): the file may be damaged, or not a video.` };
  const formats = p.container.split(",");
  if (!formats.includes("mov") && !formats.includes("mp4")) return { ok: false, reason: `It isn't an MP4 or MOV file (it reads as ${p.container}): export the intro as MP4 or MOV.` };
  if (!p.video) return { ok: false, reason: "There is no video in the file." };
  const codec = INTRO_VIDEO_CODECS[p.video.codec];
  if (!codec) return { ok: false, reason: `Its video is ${p.video.codec}, which OBS and vMix may not play: export it as H.264 in an MP4, or ProRes 4444 in a MOV for a see-through intro.` };
  if (p.durationMs === null) return { ok: false, reason: "Its length can't be read: the file may be damaged or incomplete." };
  if (p.durationMs < INTRO_MIN_MS) return { ok: false, reason: `It is only ${fmtLength(p.durationMs)} long: an intro must be at least ${fmtLength(INTRO_MIN_MS)}.` };
  if (p.durationMs > INTRO_MAX_MS) return { ok: false, reason: `It is ${fmtLength(p.durationMs)} long: an intro can be at most 2 minutes.` };
  const notes: string[] = [];
  if (!p.audio) notes.push("No sound.");
  if (p.video.codec === "vp9" || p.video.codec === "av1") notes.push(`vMix may not play ${codec}: H.264 is the safest.`);
  if (p.video.codec === "hevc" || p.video.codec === "av1") notes.push(`${codec} is decoded by the graphics card where it can: check it plays smoothly in OBS.`);
  if (p.video.width && p.video.height && (p.video.width < 1280 || p.video.height < 720)) notes.push(`${p.video.width}×${p.video.height}: smaller than 1280×720, it will look soft on a 1080p stream.`);
  if (/^(yuva|rgba|argb|bgra|abgr|gbrap)/.test(p.video.pixFmt ?? "")) notes.push("See-through (it has an alpha channel): what is under it in the map intro scene shows through.");
  return { ok: true, notes };
}

/**
 * Decodes the file's start (2 s, the sound too) and, when longer, its last 1.5 s with ffmpeg, which
 * stops at the first error (-xerror), counting the video frames it gets (framecrc): null when both
 * decode with frames, else why. A file cut off mid-way (its end has no frames), or with damaged
 * frames, is caught here.
 */
export async function decodeCheck(file: string, ffmpeg: string, durationMs: number): Promise<string | null> {
  const decode = async (args: string[], what: string) =>
    run(ffmpeg, ["-hide_banner", "-nostdin", "-v", "error", "-xerror", ...args, "-f", "framecrc", "-"], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }).then(
      (r) => {
        if (r.stderr.trim()) return firstLine(r.stderr);
        // framecrc: one line per frame, "stream index, dts, pts, duration, size, crc" (the video is stream 0 of the output).
        const frames = r.stdout.split(/\r?\n/).filter((l) => /^0,/.test(l.trim())).length;
        return frames > 0 ? null : `no picture at its ${what}`;
      },
      (err: { stderr?: string; message?: string }) => firstLine(err.stderr ?? "") || err.message || "ffmpeg failed",
    );
  const start = await decode(["-i", file, "-t", "2", "-map", "0:v:0", "-map", "0:a:0?"], "start");
  if (start) return start;
  return durationMs > 2000 ? decode(["-sseof", "-1.5", "-i", file, "-map", "0:v:0"], "end") : null;
}

/** A frame of the file at `atMs`, 480 px wide, as a JPEG. */
export async function previewFrame(file: string, ffmpeg: string, atMs: number, out: string): Promise<boolean> {
  await run(ffmpeg, ["-hide_banner", "-nostdin", "-v", "error", "-y", "-ss", (Math.max(0, atMs) / 1000).toFixed(3), "-i", file, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", out], { timeout: 30_000 }).catch(() => undefined);
  return existsSync(out) && statSync(out).size > 0;
}

export class MapIntroStore {
  constructor(
    private readonly d: {
      dir: string;
      settings: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void };
      /** ffmpeg (null: not installed) and ffprobe (null: none). */
      tools: () => Promise<{ ffmpeg: string | null; ffprobe: string | null }>;
      logger: Pick<Logger, "info" | "warn">;
    },
  ) {}

  get dir(): string {
    return this.d.dir;
  }

  /** The intros kept, by slot (an entry whose file is gone isn't listed). */
  list(): Partial<Record<MapIntroSlot, StoredIntro>> {
    const raw = this.d.settings.get<Record<string, StoredIntro>>(FILES_KEY, {});
    const out: Partial<Record<MapIntroSlot, StoredIntro>> = {};
    for (const [slot, it] of Object.entries(raw ?? {})) if (isIntroSlot(slot) && it && typeof it.file === "string" && existsSync(this.path(it.file))) out[slot] = it;
    return out;
  }

  get(slot: MapIntroSlot): StoredIntro | null {
    return this.list()[slot] ?? null;
  }

  /** A file of the folder by its name. */
  path(name: string): string {
    return join(this.d.dir, name);
  }

  /** The slot of a map (de_mirage → de_mirage), or null for a map without one. */
  slotOf(map: string | null): MapIntroSlot | null {
    return map && map !== "default" && isIntroSlot(map) ? map : null;
  }

  /** The intro a map plays: its own, else the default; null when neither is kept. */
  forMap(map: string | null): { slot: MapIntroSlot; intro: StoredIntro; isDefault: boolean } | null {
    const all = this.list();
    const own = this.slotOf(map);
    if (own && all[own]) return { slot: own, intro: all[own], isDefault: false };
    return all.default ? { slot: "default", intro: all.default, isDefault: true } : null;
  }

  /**
   * Keeps an upload for `slot` (Add or Replace): streamed to a part file, checked (checkIntro,
   * decodeCheck, a preview frame), then kept under a new name and listed, the slot's old files removed.
   * Refused (422) with why when it can't be an intro, 409 without ffmpeg.
   */
  async save(slot: MapIntroSlot, body: IncomingMessage, originalName: string): Promise<StoredIntro> {
    mkdirSync(this.d.dir, { recursive: true });
    const tag = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
    const part = this.path(`.upload-${tag}.part`);
    const shot = this.path(`.upload-${tag}.jpg`);
    const bytes = await writeBodyToFile(body, part, INTRO_MAX_BYTES);
    const drop = () => {
      rmSync(part, { force: true });
      rmSync(shot, { force: true });
    };
    try {
      if (bytes === 0) throw new HttpError(400, "The file is empty.", "bad_size");
      const { ffmpeg, ffprobe } = await this.d.tools();
      if (!ffmpeg) throw new HttpError(409, "ffmpeg is needed to check the video: download it under Replays & Production → Replay feed (NDI), or install it.", "ffmpeg_missing");
      const probed = await probeVideo(part, { ffmpeg, ffprobe });
      const check = checkIntro(probed);
      if (!check.ok) throw new HttpError(422, check.reason, "bad_video");
      const durationMs = probed.durationMs!;
      const broken = await decodeCheck(part, ffmpeg, durationMs);
      if (broken) throw new HttpError(422, `ffmpeg can't play it through (${broken}): the file is damaged or incomplete. Export it again.`, "bad_video");
      if (!(await previewFrame(part, ffmpeg, durationMs / 2, shot))) throw new HttpError(422, "No picture could be taken from it: the file is damaged or incomplete. Export it again.", "bad_video");
      // (OBS and vMix read MP4 and MOV alike, whatever the name says.)
      const ext = /^\.(mp4|m4v|mov)$/i.test(extname(originalName)) ? extname(originalName).toLowerCase() : ".mp4";
      const file = `${slot}-${tag}${ext}`;
      const preview = `${slot}-${tag}.jpg`;
      renameSync(part, this.path(file));
      renameSync(shot, this.path(preview));
      const v = probed.video!;
      const intro: StoredIntro = { slot, file, preview, originalName: originalName.slice(0, 200) || file, bytes, durationMs, width: v.width, height: v.height, fps: v.fps, videoCodec: v.codec, audioCodec: probed.audio?.codec ?? null, pixFmt: v.pixFmt, uploadedAt: new Date().toISOString(), notes: check.notes };
      const before = this.d.settings.get<Record<string, StoredIntro>>(FILES_KEY, {}) ?? {};
      const old = before[slot];
      this.d.settings.set(FILES_KEY, { ...before, [slot]: intro });
      if (old) this.removeFiles(old);
      this.d.logger.info("map intro kept", { slot, file, bytes, durationMs, codec: v.codec, by: probed.by });
      return intro;
    } catch (err) {
      drop();
      throw err;
    }
  }

  /** Removes a slot's intro (Remove); false when it had none. */
  remove(slot: MapIntroSlot): boolean {
    const before = this.d.settings.get<Record<string, StoredIntro>>(FILES_KEY, {}) ?? {};
    const old = before[slot];
    if (!old) return false;
    const { [slot]: _gone, ...rest } = before;
    this.d.settings.set(FILES_KEY, rest);
    this.removeFiles(old);
    return true;
  }

  private removeFiles(it: StoredIntro): void {
    for (const name of [it.file, it.preview]) {
      if (!name) continue;
      try {
        rmSync(this.path(name), { force: true });
      } catch (err) {
        // Still open (OBS has it on Windows): removed by the next sweep.
        this.d.logger.warn("map intro: an old file couldn't be removed yet", { name, error: String(err) });
      }
    }
  }

  /** Removes files of the folder no intro lists (replaced ones that were still open, abandoned uploads). */
  sweep(): void {
    if (!existsSync(this.d.dir)) return;
    const kept = new Set(Object.values(this.d.settings.get<Record<string, StoredIntro>>(FILES_KEY, {}) ?? {}).flatMap((it) => [it.file, it.preview].filter(Boolean)));
    for (const name of readdirSync(this.d.dir)) {
      if (kept.has(name)) continue;
      const p = this.path(name);
      try {
        if (name.startsWith(".upload-") && Date.now() - statSync(p).mtimeMs < PART_STALE_MS) continue;
        if (!/^(de_\w+|default)-[a-z0-9]+\.(mp4|m4v|mov|jpg)$/.test(name) && !name.startsWith(".upload-")) continue;
        rmSync(p, { force: true });
      } catch {
        // In use: next time.
      }
    }
  }
}

/** Where ffprobe would be beside an ffmpeg: its folder, or the PATH when ffmpeg is found there (probeVideo falls back to ffmpeg when it isn't). */
export function ffprobeBeside(ffmpeg: string | null, platform: NodeJS.Platform = process.platform): string {
  if (!ffmpeg || ffmpeg === "ffmpeg" || !/[\\/]/.test(ffmpeg)) return "ffprobe";
  return join(dirname(ffmpeg), platform === "win32" ? "ffprobe.exe" : "ffprobe");
}
