import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { beforeAll, describe, expect, it } from "vitest";
import { HttpError, writeBodyToFile } from "../src/http/router.ts";
import { checkIntro, ffprobeBeside, MapIntroStore, parseFfmpegInfo, parseFfprobe, probeVideo } from "../src/replay/map-intro-store.ts";

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-hide_banner", "-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-hide_banner", "-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const quiet = { info: () => undefined, warn: () => undefined };
const memorySettings = () => {
  const m = new Map<string, unknown>();
  return { get: <T>(k: string, d: T): T => (m.has(k) ? (m.get(k) as T) : d), set: (k: string, v: unknown) => void m.set(k, v), m };
};
/** A file as a request body (the route streams the request itself). */
const body = (file: string) => createReadStream(file) as unknown as IncomingMessage;

describe("Parsing what ffprobe and ffmpeg say", () => {
  it("ffprobe's JSON: an MP4's cover picture isn't its video; frame rates as fractions", () => {
    const p = parseFfprobe({
      format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "8.341000" },
      streams: [
        { codec_type: "video", codec_name: "mjpeg", width: 600, height: 600, disposition: { attached_pic: 1 } },
        { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "60000/1001", pix_fmt: "yuv420p", disposition: { attached_pic: 0 } },
        { codec_type: "audio", codec_name: "aac", channels: 2, sample_rate: "48000" },
      ],
    });
    expect(p).toEqual({ by: "ffprobe", container: "mov,mp4,m4a,3gp,3g2,mj2", durationMs: 8341, video: { codec: "h264", width: 1920, height: 1080, fps: 59.94, pixFmt: "yuv420p" }, audio: { codec: "aac", channels: 2, sampleRate: 48000 }, error: null });
  });

  it("ffmpeg -i: the same facts from its description of the input", () => {
    const text = [
      "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'intro.mov':",
      "  Duration: 00:00:12.48, start: 0.000000, bitrate: 85211 kb/s",
      "  Stream #0:0[0x1]: Video: prores (4444) (ap4h / 0x68347061), yuva444p12le(tv, bt709, progressive), 1920x1080, 84000 kb/s, SAR 1:1 DAR 16:9, 50 fps, 50 tbr, 12800 tbn (default)",
      "  Stream #0:1[0x2]: Audio: pcm_s16le (sowt / 0x74776F73), 48000 Hz, stereo, s16, 1536 kb/s (default)",
      "  Stream #0:2[0x3]: Video: mjpeg (Baseline), yuvj420p(pc), 300x300, 90k tbr, 90k tbn (attached pic)",
      "At least one output file must be specified",
    ].join("\n");
    expect(parseFfmpegInfo(text)).toEqual({ by: "ffmpeg", container: "mov,mp4,m4a,3gp,3g2,mj2", durationMs: 12480, video: { codec: "prores", width: 1920, height: 1080, fps: 50, pixFmt: "yuva444p12le" }, audio: { codec: "pcm_s16le", channels: 2, sampleRate: 48000 }, error: null });
    expect(parseFfmpegInfo("[mov,mp4,m4a,3gp,3g2,mj2 @ 0x55] moov atom not found\n[in#0 @ 0x55] Error opening input: Invalid data found when processing input\nError opening input file x.mp4.")).toMatchObject({ container: null, error: "Error opening input file x.mp4." });
  });

  it("what makes an intro: MP4 or MOV, a codec OBS and vMix play, 0.5 s to 2 minutes; notes that don't refuse it", () => {
    const ok = { by: "ffprobe" as const, container: "mov,mp4,m4a,3gp,3g2,mj2", durationMs: 8000, video: { codec: "h264", width: 1920, height: 1080, fps: 60, pixFmt: "yuv420p" }, audio: { codec: "aac", channels: 2, sampleRate: 48000 }, error: null };
    expect(checkIntro(ok)).toEqual({ ok: true, notes: [] });
    expect(checkIntro({ ...ok, container: "matroska,webm" })).toEqual({ ok: false, reason: "It isn't an MP4 or MOV file (it reads as matroska,webm): export the intro as MP4 or MOV." });
    expect(checkIntro({ ...ok, video: null })).toEqual({ ok: false, reason: "There is no video in the file." });
    expect(checkIntro({ ...ok, video: { ...ok.video, codec: "cinepak" } })).toMatchObject({ ok: false, reason: expect.stringMatching(/^Its video is cinepak, which OBS and vMix may not play: export it as H\.264/) });
    expect(checkIntro({ ...ok, durationMs: null })).toMatchObject({ ok: false, reason: expect.stringMatching(/length can't be read/) });
    expect(checkIntro({ ...ok, durationMs: 300 })).toEqual({ ok: false, reason: "It is only 0.3 s long: an intro must be at least 0.5 s." });
    expect(checkIntro({ ...ok, durationMs: 185_000 })).toEqual({ ok: false, reason: "It is 3:05 long: an intro can be at most 2 minutes." });
    expect(checkIntro({ ...ok, container: null, error: "Invalid data found when processing input" })).toMatchObject({ ok: false, reason: expect.stringMatching(/can't read it as a video \(Invalid data found when processing input\)/) });
    expect(checkIntro({ ...ok, audio: null, video: { ...ok.video, codec: "vp9", pixFmt: "yuva420p" } })).toEqual({ ok: true, notes: ["No sound.", "vMix may not play VP9: H.264 is the safest.", "See-through (it has an alpha channel): what is under it in the map intro scene shows through."] });
  });

  it("ffprobe beside the program's ffmpeg (its folder), or on the PATH", () => {
    expect(ffprobeBeside("ffmpeg")).toBe("ffprobe");
    expect(ffprobeBeside("C:\\Data\\tools\\ffmpeg\\ffmpeg.exe", "win32")).toMatch(/ffprobe\.exe$/);
    expect(ffprobeBeside("/opt/ff/ffmpeg", "linux")).toBe("/opt/ff/ffprobe");
  });
});

describe("A request body streamed to disk", () => {
  it("is written whole, or refused past its limit with the part removed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mf-body-"));
    const ok = join(dir, "ok.bin");
    expect(await writeBodyToFile(Readable.from([Buffer.alloc(300), Buffer.alloc(200)]) as unknown as IncomingMessage, ok, 1000)).toBe(500);
    expect(statSync(ok).size).toBe(500);
    const big = join(dir, "big.bin");
    const err = await writeBodyToFile(Readable.from([Buffer.alloc(600), Buffer.alloc(600)]) as unknown as IncomingMessage, big, 1000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(413);
    expect(existsSync(big)).toBe(false);
  });
});

describe.skipIf(!hasFfmpeg)("Map intro uploads, checked with ffprobe and ffmpeg (tiny generated videos)", () => {
  const src = mkdtempSync(join(tmpdir(), "mf-intro-src-"));
  const dir = join(mkdtempSync(join(tmpdir(), "mf-intro-data-")), "map-intros");
  const settings = memorySettings();
  const store = new MapIntroStore({ dir, settings, tools: async () => ({ ffmpeg: "ffmpeg", ffprobe: "ffprobe" }), logger: quiet });
  const v = (name: string) => join(src, name);
  const ff = (...args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", ...args], { stdio: "ignore" });
  const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof HttpError ? { status: e.status, message: e.message } : { status: 0, message: String(e) }));
  /** The folder holds only the intros listed (nothing left behind by a refused upload). */
  const leftovers = () => readdirSync(dir).filter((n) => !Object.values(store.list()).some((it) => it && (it.file === n || it.preview === n)));

  beforeAll(() => {
    // 2.5 s H.264 + AAC (moov first, so a cut copy still opens), 1 s see-through QuickTime Animation, 0.3 s, Matroska, MPEG-2 in a MOV.
    ff("-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=2.5", "-f", "lavfi", "-i", "sine=frequency=440:duration=2.5", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-movflags", "+faststart", v("mirage.mp4"));
    ff("-f", "lavfi", "-i", "testsrc=size=160x90:rate=10:duration=1", "-c:v", "qtrle", "-pix_fmt", "argb", v("alpha.mov"));
    ff("-f", "lavfi", "-i", "testsrc=size=160x90:rate=30:duration=0.3", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", v("short.mp4"));
    ff("-f", "lavfi", "-i", "testsrc=size=160x90:rate=10:duration=1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-f", "matroska", v("clip.mkv"));
    ff("-f", "lavfi", "-i", "testsrc=size=160x90:rate=10:duration=1", "-c:v", "mpeg2video", v("old.mov"));
    const good = readFileSync(v("mirage.mp4"));
    writeFileSync(v("cut.mp4"), good.subarray(0, Math.floor(good.length * 0.3)));
    writeFileSync(v("junk.mp4"), "this is not a video\n");
    writeFileSync(v("empty.mp4"), "");
  });

  it("keeps an H.264 MP4: its length, codecs and size read by ffprobe, a preview frame, the slot listed", async () => {
    const it = await store.save("de_mirage", body(v("mirage.mp4")), "Mirage intro.mp4");
    expect(it).toMatchObject({ slot: "de_mirage", originalName: "Mirage intro.mp4", durationMs: 2500, width: 320, height: 180, fps: 30, videoCodec: "h264", audioCodec: "aac", pixFmt: "yuv420p", notes: ["320×180: smaller than 1280×720, it will look soft on a 1080p stream."] });
    expect(it.file).toMatch(/^de_mirage-[a-z0-9]+\.mp4$/);
    expect(statSync(store.path(it.file)).size).toBe(statSync(v("mirage.mp4")).size);
    // The preview: a JPEG frame from its middle.
    expect(readFileSync(store.path(it.preview!)).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(store.get("de_mirage")?.file).toBe(it.file);
    expect(store.forMap("de_mirage")).toMatchObject({ slot: "de_mirage", isDefault: false });
    // No intro for Nuke, and no default yet.
    expect(store.forMap("de_nuke")).toBeNull();
    expect(leftovers()).toEqual([]);
  });

  it("keeps a see-through QuickTime Animation MOV as the default intro, which maps without their own play", async () => {
    const it = await store.save("default", body(v("alpha.mov")), "logo sting.mov");
    expect(it).toMatchObject({ slot: "default", durationMs: 1000, videoCodec: "qtrle", audioCodec: null, pixFmt: "argb" });
    expect(it.file).toMatch(/^default-[a-z0-9]+\.mov$/);
    expect(it.notes).toEqual(["No sound.", "160×90: smaller than 1280×720, it will look soft on a 1080p stream.", "See-through (it has an alpha channel): what is under it in the map intro scene shows through."]);
    expect(store.forMap("de_nuke")).toMatchObject({ slot: "default", isDefault: true });
    expect(store.forMap("de_mirage")).toMatchObject({ slot: "de_mirage", isDefault: false });
    expect(store.forMap("workshop_map")).toMatchObject({ slot: "default" });
  });

  it("refuses files that can't be intros, with why, and keeps nothing of them", async () => {
    expect(await refusal(store.save("de_inferno", body(v("short.mp4")), "short.mp4"))).toEqual({ status: 422, message: "It is only 0.3 s long: an intro must be at least 0.5 s." });
    expect(await refusal(store.save("de_inferno", body(v("clip.mkv")), "clip.mkv"))).toEqual({ status: 422, message: "It isn't an MP4 or MOV file (it reads as matroska,webm): export the intro as MP4 or MOV." });
    expect(await refusal(store.save("de_inferno", body(v("old.mov")), "old.mov"))).toMatchObject({ status: 422, message: expect.stringMatching(/^Its video is mpeg2video, which OBS and vMix may not play/) });
    expect(await refusal(store.save("de_inferno", body(v("junk.mp4")), "junk.mp4"))).toMatchObject({ status: 422, message: expect.stringMatching(/^ffprobe can't read it as a video \(.*Invalid data found when processing input\)/) });
    // Cut off: it opens (its index is at the start) and says 2.5 s, but its end has no pictures.
    expect(await refusal(store.save("de_inferno", body(v("cut.mp4")), "cut.mp4"))).toMatchObject({ status: 422, message: expect.stringMatching(/^ffmpeg can't play it through \(.+\): the file is damaged or incomplete\. Export it again\.$/) });
    expect(await refusal(store.save("de_inferno", body(v("empty.mp4")), "empty.mp4"))).toEqual({ status: 400, message: "The file is empty." });
    expect(store.get("de_inferno")).toBeNull();
    expect(leftovers()).toEqual([]);
  });

  it("reads the file with ffmpeg itself when there is no ffprobe (the program's own ffmpeg comes without one)", async () => {
    const viaFfmpeg = await probeVideo(v("mirage.mp4"), { ffmpeg: "ffmpeg", ffprobe: join(src, "no-ffprobe-here") });
    const viaFfprobe = await probeVideo(v("mirage.mp4"), { ffmpeg: "ffmpeg", ffprobe: "ffprobe" });
    expect(viaFfmpeg.by).toBe("ffmpeg");
    expect(viaFfprobe.by).toBe("ffprobe");
    expect({ ...viaFfmpeg, by: null }).toEqual({ ...viaFfprobe, by: null });
    const noProbe = new MapIntroStore({ dir, settings, tools: async () => ({ ffmpeg: "ffmpeg", ffprobe: null }), logger: quiet });
    expect(await refusal(noProbe.save("de_inferno", body(v("clip.mkv")), "clip.mkv"))).toEqual({ status: 422, message: "It isn't an MP4 or MOV file (it reads as matroska,webm): export the intro as MP4 or MOV." });
    // Without ffmpeg at all: nothing can be checked, so nothing is kept.
    const none = new MapIntroStore({ dir, settings, tools: async () => ({ ffmpeg: null, ffprobe: null }), logger: quiet });
    expect(await refusal(none.save("de_inferno", body(v("mirage.mp4")), "m.mp4"))).toMatchObject({ status: 409, message: expect.stringMatching(/^ffmpeg is needed to check the video/) });
    expect(leftovers()).toEqual([]);
  });

  it("Replace: a new file under a new name, the old one removed; Remove: the slot empty, the default plays instead", async () => {
    const before = store.get("de_mirage")!;
    const after = await store.save("de_mirage", body(v("alpha.mov")), "new.mov");
    expect(after.file).not.toBe(before.file);
    expect(existsSync(store.path(before.file))).toBe(false);
    expect(existsSync(store.path(before.preview!))).toBe(false);
    expect(store.get("de_mirage")?.file).toBe(after.file);
    expect(store.remove("de_mirage")).toBe(true);
    expect(store.remove("de_mirage")).toBe(false);
    expect(existsSync(store.path(after.file))).toBe(false);
    expect(store.forMap("de_mirage")).toMatchObject({ slot: "default", isDefault: true });
    expect(leftovers()).toEqual([]);
  });

  it("sweep: files of replaced intros OBS still had open, and abandoned uploads, go; listed ones and fresh uploads stay", () => {
    writeFileSync(store.path("de_nuke-old1.mp4"), "x");
    writeFileSync(store.path("de_nuke-old1.jpg"), "x");
    writeFileSync(store.path(".upload-fresh.part"), "x");
    writeFileSync(store.path(".upload-stale.part"), "x");
    writeFileSync(store.path("notes.txt"), "the operator's own file");
    const hourAgo = (Date.now() - 2 * 3_600_000) / 1000;
    utimesSync(store.path(".upload-stale.part"), hourAgo, hourAgo);
    store.sweep();
    expect(readdirSync(dir).sort()).toEqual([".upload-fresh.part", store.get("default")!.file, store.get("default")!.preview!, "notes.txt"].sort());
  });
});
