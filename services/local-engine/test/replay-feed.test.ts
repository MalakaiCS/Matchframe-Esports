import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database } from "../src/db/database.ts";
import { SettingsRepo } from "../src/db/store.ts";
import { ReplayFeed } from "../src/replay/feed.ts";
import { FfmpegTool } from "../src/replay/ffmpeg.ts";
import { inProcessFeedWorker, lumaAt, lumaSteps } from "./helpers/fake-ndi.ts";

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-hide_banner", "-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** The brightness (Y, as sent) of a clip's first frame, or of a frame `fromEndS` seconds before its end. */
function luma(file: string, fromEndS: number | null = null): number {
  const seek = fromEndS === null ? [] : ["-sseof", `-${fromEndS}`];
  return execFileSync("ffmpeg", ["-v", "error", ...seek, "-i", file, "-vf", "scale=2:2", "-pix_fmt", "yuv420p", "-frames:v", "1", "-f", "rawvideo", "pipe:"])[0]!;
}

const waitFor = async (fn: () => boolean, ms = 15000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

/**
 * The replay feed with a stand-in NDI source (real ffmpeg, libx264): it records one-second
 * segments stamped with real time and cuts a clip for any moment of the last minutes. The source's
 * brightness tells when each frame was sent, so the cuts are checked to the picture.
 */
describe.skipIf(!hasFfmpeg)("replay feed: recording the replay PC's screen and cutting clips", () => {
  let feed: ReplayFeed;
  const data = mkdtempSync(join(tmpdir(), "mf-feed-"));

  beforeAll(() => {
    const db = new Database(":memory:");
    db.migrate();
    const settings = new SettingsRepo(db);
    const log = { info: () => undefined, warn: () => undefined };
    feed = new ReplayFeed({ settings, logger: log, dataDir: data, ffmpeg: new FfmpegTool({ dataDir: data, logger: log }), spawnWorker: () => inProcessFeedWorker() });
    feed.start();
  });

  afterAll(() => feed.stop());

  it("asks for the source, then records it once chosen", async () => {
    expect(feed.status().state).toBe("off");
    const found = await feed.sources(500);
    expect(found).toEqual({ sources: [{ name: "REPLAY-PC (vMix Desktop Capture)" }], error: null });
    feed.setSettings({ enabled: true, encoder: "libx264", latencyMs: 0 });
    await waitFor(() => feed.status().state === "error");
    expect(feed.status().detail).toMatch(/NDI source/);
    feed.setSettings({ source: found.sources[0]! });
    await waitFor(() => feed.recording());
    const st = feed.status();
    expect(st).toMatchObject({ state: "recording", width: 320, height: 180, fps: 30, ndi: { available: true, version: "NDI SDK (stand-in)" }, ffmpeg: { source: "path", encoder: "libx264" } });
  }, 30000);

  it("cuts a clip from a moment a few seconds back: the picture of that moment, to the tenth of a second", async () => {
    await new Promise((r) => setTimeout(r, 6000));
    const to = Date.now() - 1500;
    const from = to - 3000;
    const out = join(data, "clip.mp4");
    const cut = await feed.cut(from, to, out);
    // It starts on the second (keyframe) at or before `from`, and ends at `to`.
    expect(cut.startWall).toBeLessThanOrEqual(from);
    expect(from - cut.startWall).toBeLessThan(1100);
    expect(Math.abs(cut.durationMs - (to - cut.startWall))).toBeLessThan(50);
    expect(cut).toMatchObject({ width: 320, height: 180, fps: 30 });
    expect(lumaSteps(luma(out), lumaAt(cut.startWall))).toBeLessThanOrEqual(2);
    expect(lumaSteps(luma(out, 0.1), lumaAt(to - 100))).toBeLessThanOrEqual(2);
    expect(feed.status().bufferedSec).toBeGreaterThan(5);
  }, 30000);

  it("waits for the segment holding the end of the clip when it is still being written", async () => {
    const to = Date.now() + 400;
    const out = join(data, "fresh.mp4");
    const cut = await feed.cut(to - 2000, to, out);
    expect(Math.abs(cut.durationMs - (to - cut.startWall))).toBeLessThan(50);
    expect(lumaSteps(luma(out, 0.1), lumaAt(to - 100))).toBeLessThanOrEqual(2);
  }, 30000);
});
