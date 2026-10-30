import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { unzipSync } from "fflate";
import type { Logger } from "../logger.ts";

const run = promisify(execFile);

/**
 * ffmpeg for the replay feed (replay/feed.ts): it encodes the replay PC's NDI picture into short
 * segments and cuts clips from them. It isn't shipped with the program: on Windows the program
 * downloads one fixed build when asked (gyan.dev's essentials build, with the NVIDIA, Intel and AMD
 * hardware encoders), checks its SHA-256 and keeps ffmpeg.exe in the data folder. An ffmpeg on the
 * PATH is used when there is no download (Linux, or one installed by hand).
 */
export const FFMPEG_DOWNLOAD = {
  version: "7.1 (gyan.dev essentials build)",
  url: "https://github.com/GyanD/codexffmpeg/releases/download/7.1/ffmpeg-7.1-essentials_build.zip",
  sha256: "fa7d4d7e795db0e2503f49f105f46ed5852386f0cfdd819899be3b65ebde24fc",
  bytes: 92_100_272,
  root: "ffmpeg-7.1-essentials_build",
} as const;

/** H.264 encoders tried in this order ("auto"): the GPU's own first, the CPU's last. */
export const ENCODERS = ["h264_nvenc", "h264_qsv", "h264_amf", "libx264"] as const;
export type Encoder = (typeof ENCODERS)[number];

export interface FfmpegStatus {
  /** Where ffmpeg is: downloaded by the program, on the PATH, or not found. */
  source: "downloaded" | "path" | "missing";
  path: string | null;
  version: string | null;
  /** The encoder the feed uses (the first that works on this computer), once tested. */
  encoder: Encoder | null;
  /** A download is running: how far (0–1). */
  downloading: number | null;
  error: string | null;
  canDownload: boolean;
}

/** ffmpeg's arguments for one encoder at `fps` (a keyframe every second, so clips cut on the second). */
export function encoderArgs(encoder: Encoder, fps: number, bitrateMbps: number): string[] {
  const gop = String(Math.max(1, Math.round(fps)));
  const b = `${bitrateMbps}M`;
  const keys = ["-g", gop, "-bf", "0", "-force_key_frames", "expr:gte(t,n_forced*1)"];
  switch (encoder) {
    case "h264_nvenc":
      return ["-c:v", "h264_nvenc", "-preset", "p4", "-tune", "ll", "-rc", "cbr", "-b:v", b, "-maxrate", b, "-bufsize", `${bitrateMbps * 2}M`, "-forced-idr", "1", ...keys];
    case "h264_qsv":
      return ["-c:v", "h264_qsv", "-preset", "veryfast", "-b:v", b, "-maxrate", b, ...keys];
    case "h264_amf":
      return ["-c:v", "h264_amf", "-usage", "lowlatency", "-rc", "cbr", "-b:v", b, ...keys];
    case "libx264":
      return ["-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-crf", "20", "-maxrate", b, "-bufsize", `${bitrateMbps * 2}M`, "-keyint_min", gop, "-sc_threshold", "0", ...keys];
  }
}

export class FfmpegTool {
  private found: { source: "downloaded" | "path"; path: string; version: string } | null = null;
  private checked = false;
  private encoder: Encoder | null = null;
  private downloading: number | null = null;
  private error: string | null = null;

  constructor(
    private readonly deps: {
      dataDir: string;
      logger: Pick<Logger, "info" | "warn">;
      platform?: NodeJS.Platform;
      /** Fetch (stand-in in tests). */
      fetch?: typeof fetch;
    },
  ) {}

  private get dir(): string {
    return join(this.deps.dataDir, "tools", "ffmpeg");
  }

  private get downloadedPath(): string {
    return join(this.dir, (this.deps.platform ?? process.platform) === "win32" ? "ffmpeg.exe" : "ffmpeg");
  }

  /** Finds ffmpeg (the download first, then the PATH) and reads its version. */
  async locate(force = false): Promise<string | null> {
    if (this.checked && !force) return this.found?.path ?? null;
    this.checked = true;
    this.found = null;
    for (const [source, path] of [["downloaded", this.downloadedPath], ["path", "ffmpeg"]] as const) {
      if (source === "downloaded" && !existsSync(path)) continue;
      try {
        const { stdout } = await run(path, ["-hide_banner", "-version"], { timeout: 10_000 });
        this.found = { source, path, version: /ffmpeg version (\S+)/.exec(stdout)?.[1] ?? "unknown" };
        break;
      } catch {
        // Not there, or not runnable: try the next.
      }
    }
    return this.found?.path ?? null;
  }

  /** The encoder to use: `wanted`, or with "auto" the first that encodes a test picture on this computer. */
  async pickEncoder(wanted: Encoder | "auto"): Promise<Encoder> {
    const ffmpeg = await this.locate();
    if (!ffmpeg) throw new Error("ffmpeg isn't installed");
    if (wanted !== "auto") return (this.encoder = wanted);
    if (this.encoder) return this.encoder;
    for (const enc of ENCODERS) {
      try {
        await run(ffmpeg, ["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=640x360:r=30", "-frames:v", "5", ...encoderArgs(enc, 30, 4), "-pix_fmt", "yuv420p", "-f", "null", "-"], { timeout: 20_000 });
        this.encoder = enc;
        this.deps.logger.info("replay feed: encoder picked", { encoder: enc });
        return enc;
      } catch {
        // This computer has no such encoder (or GPU): try the next.
      }
    }
    throw new Error("none of ffmpeg's H.264 encoders work on this computer");
  }

  status(): FfmpegStatus {
    return {
      source: this.found?.source ?? "missing",
      path: this.found?.path ?? null,
      version: this.found?.version ?? null,
      encoder: this.encoder,
      downloading: this.downloading,
      error: this.error,
      canDownload: (this.deps.platform ?? process.platform) === "win32",
    };
  }

  /** Downloads the fixed Windows build, checks it, and keeps ffmpeg.exe (and its licence). */
  async download(): Promise<FfmpegStatus> {
    if ((this.deps.platform ?? process.platform) !== "win32") throw new Error("the download is for Windows; install ffmpeg with this system's package manager");
    if (this.downloading !== null) return this.status();
    this.downloading = 0;
    this.error = null;
    try {
      const res = await (this.deps.fetch ?? fetch)(FFMPEG_DOWNLOAD.url, { signal: AbortSignal.timeout(15 * 60_000) });
      if (!res.ok || !res.body) throw new Error(`the download answered ${res.status}`);
      const chunks: Uint8Array[] = [];
      let got = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        if (got > FFMPEG_DOWNLOAD.bytes * 1.1) throw new Error("the download is larger than expected");
        this.downloading = Math.min(0.99, got / FFMPEG_DOWNLOAD.bytes);
      }
      const zip = Buffer.concat(chunks);
      const sha = createHash("sha256").update(zip).digest("hex");
      if (sha !== FFMPEG_DOWNLOAD.sha256) throw new Error("the download's checksum doesn't match (corrupt or changed): not used");
      const want = new Set([`${FFMPEG_DOWNLOAD.root}/bin/ffmpeg.exe`, `${FFMPEG_DOWNLOAD.root}/LICENSE`]);
      const files = unzipSync(zip, { filter: (f) => want.has(f.name) });
      const exe = files[`${FFMPEG_DOWNLOAD.root}/bin/ffmpeg.exe`];
      if (!exe) throw new Error("ffmpeg.exe is missing from the download");
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(`${this.downloadedPath}.part`, exe);
      renameSync(`${this.downloadedPath}.part`, this.downloadedPath);
      const licence = files[`${FFMPEG_DOWNLOAD.root}/LICENSE`];
      if (licence) writeFileSync(join(this.dir, "LICENSE.txt"), licence);
      this.deps.logger.info("replay feed: ffmpeg downloaded", { version: FFMPEG_DOWNLOAD.version });
      await this.locate(true);
      this.encoder = null;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.deps.logger.warn("replay feed: ffmpeg download failed", { error: this.error });
    } finally {
      this.downloading = null;
    }
    return this.status();
  }
}
