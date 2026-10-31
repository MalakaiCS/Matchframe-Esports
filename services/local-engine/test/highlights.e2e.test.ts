import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HudKillfeedEntry } from "@matchframe/hud-sdk";
import type { ClipRecord, QueueItem, ReplayPlay } from "@matchframe/replay-agent";
import { buildSyntheticGsiPayload, syntheticRoster } from "../../../packages/cs2-state/src/testing/gsi-builder.ts";
import { Engine } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { clampFade } from "../src/replay/highlights.ts";
import { filterOption, parseProbe, reelFormat, reelGraph } from "../src/replay/reel.ts";
import { startServers } from "../src/servers.ts";

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-hide_banner", "-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-hide_banner", "-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

const waitFor = async (fn: () => boolean, ms = 120_000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
};

interface Probe {
  streams: { codec_type: string; codec_name: string; width?: number; height?: number; pix_fmt?: string; r_frame_rate?: string; sample_rate?: string; channels?: number }[];
  format: { duration: string };
}
const probe = (file: string): Probe => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate,sample_rate,channels", "-of", "json", file]).toString()) as Probe;

describe("Highlight reel: plan and graph", () => {
  it("reads ffmpeg's description of a file", () => {
    const text = [
      "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'a.mp4':",
      "  Duration: 00:00:03.03, start: 0.000000, bitrate: 3089 kb/s",
      "  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1280x720 [SAR 1:1 DAR 16:9], 3000 kb/s, 29.97 fps, 29.97 tbr, 30k tbn (default)",
      "  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 69 kb/s (default)",
    ].join("\n");
    expect(parseProbe(text)).toEqual({ durationMs: 3030, width: 1280, height: 720, fps: 29.97, hasAudio: true });
    expect(parseProbe("  Duration: 00:01:02.50\n  Stream #0:0: Video: h264, yuv420p, 640x480, 25 tbr")).toEqual({ durationMs: 62500, width: 640, height: 480, fps: 25, hasAudio: false });
  });

  it("picks the size (1920×1080 or the largest clip's) and the frame rate", () => {
    expect(reelFormat([{ width: 1280, height: 720, fps: 30 }, { width: 640, height: 480, fps: 25 }])).toEqual({ width: 1920, height: 1080, fps: 30 });
    expect(reelFormat([{ width: 2560, height: 1440, fps: 59.94 }, { width: 1920, height: 1080, fps: 144 }])).toEqual({ width: 2560, height: 1440, fps: 60 });
    expect(reelFormat([{ width: null, height: null, fps: null }])).toEqual({ width: 1920, height: 1080, fps: 60 });
  });

  it("crossfades each clip into the next at its end, and puts long graphs in a file", () => {
    const g = reelGraph(
      [
        { file: "a.mp4", startMs: 1000, durationMs: 3000, hasAudio: true, graphic: null },
        { file: "b.mp4", startMs: 0, durationMs: 4000, hasAudio: false, graphic: "g.png" },
        { file: "c.mp4", startMs: 0, durationMs: 2500, hasAudio: true, graphic: null },
      ],
      { width: 1920, height: 1080, fps: 60, fadeMs: 500 },
    );
    expect(g.totalMs).toBe(8500);
    expect(g.filter).toContain("xfade=transition=fade:duration=0.500:offset=2.500[x1]");
    expect(g.filter).toContain("xfade=transition=fade:duration=0.500:offset=6.000[vout]");
    expect(g.filter).toContain("acrossfade=d=0.500");
    expect(g.filter).toContain("anullsrc=channel_layout=stereo:sample_rate=48000");
    expect(g.args.slice(0, 6)).toEqual(["-ss", "1.000", "-t", "3.500", "-i", "a.mp4"]);
    expect(clampFade(1500, [3000, 2000])).toBe(666);
    expect(filterOption("7.1", "f.txt", "x".repeat(7000))).toEqual(["-/filter_complex", "f.txt"]);
    expect(filterOption("6.1.1-3ubuntu5", "f.txt", "x".repeat(7000))).toEqual(["-filter_complex_script", "f.txt"]);
    expect(filterOption("6.1", "f.txt", "short")).toEqual(["-filter_complex", "short"]);
  });
});

/**
 * Clips of the replay queue are kept for the map's reel (the queue deletes its files), and the reel
 * is made with the program's ffmpeg: three clips of different sizes, frame rates and sound, in round
 * order, crossfaded, one with its lower third burned in; one H.264/AAC MP4 of the clips' length less
 * the fades. It can be stopped. The current and previous map are kept; over the space allowed,
 * unplayed clips go first.
 */
describe.skipIf(!hasFfmpeg)("Highlight reel with ffmpeg", () => {
  let e: Engine;
  let servers: Awaited<ReturnType<typeof startServers>>;
  let api: string;
  let gsiPort: number;
  let ts = 1_700_000_000;
  const roster = syntheticRoster();
  const [T1, T2, T3] = roster.filter((p) => p.side === "T");
  const dir = mkdtempSync(join(tmpdir(), "mf-reel-"));
  const data = mkdtempSync(join(tmpdir(), "mf-reel-data-"));
  let auth: Record<string, string>;

  const feed = async (map: string, round: number) => {
    const payload = buildSyntheticGsiPayload({ mapName: map, round: round - 1, players: roster, observed: roster[0]!.steamId, roundPhase: "live", phase: "live", phaseEndsIn: 40, token: e.secrets.gsiToken, timestamp: ts++, ctName: "Northern Lights", tName: "Red Harbour" });
    expect((await fetch(`http://127.0.0.1:${gsiPort}/gsi`, { method: "POST", body: JSON.stringify(payload) })).status).toBe(200);
  };
  const make = (name: string, args: string[]) => {
    const f = join(dir, name);
    execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", ...args, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", f]);
    return f;
  };
  const clip = (path: string, round: number, durationMs: number): ClipRecord => ({ clipId: `c${Math.random()}`, providerId: "replay-pc", sourceId: "replay-pc", angle: "recorded_angle", matchTimeFromMs: null, matchTimeToMs: null, timeUncertaintyMs: null, epoch: null, roundNumber: round, media: { path, durationMs, frameRate: null, timebase: null, startPts: null, hasAudio: null, width: null, height: null }, createdAt: new Date().toISOString() });
  const add = (path: string, round: number, durationMs: number, play: ReplayPlay, played = true): QueueItem => {
    const it = e.replays.addExternal(`${play.kills}K ${play.killer?.name}`, play.kind, round, clip(path, round, durationMs), { play });
    if (played) {
      e.replays.approve(it.id);
      e.replays.markPlaying(it.id);
      e.replays.markPlayed(it.id);
    }
    return it;
  };
  const kill = (round: number, killer: typeof T1, victim: string) => {
    const k: HudKillfeedEntry = { id: `k${Math.random()}`, kind: "probable", killer: { steamId: killer!.steamId, name: killer!.name, side: "T" }, victim: { steamId: "v", name: victim, side: "CT" }, weapon: "weapon_ak47", headshot: false, assister: null, attackerBlind: false, atMs: 0 };
    const was = e.session.state()!.roundNumber;
    Object.assign(e.session.state()!, { roundNumber: round });
    e.highlights.noteKill(k);
    Object.assign(e.session.state()!, { roundNumber: was });
  };
  const call = async <T,>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const res = await fetch(`${api}${path}`, { method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as T };
  };
  let a: QueueItem;
  let b: QueueItem;
  let c: QueueItem;
  let originals: string[];

  beforeAll(async () => {
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    const ports = { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
    gsiPort = ports.gsi;
    api = `http://127.0.0.1:${ports.api}`;
    e = new Engine(loadConfig({ dataDir: data, gsiPort: ports.gsi, apiPort: ports.api, overlayPort: ports.overlay, host: "127.0.0.1", captainUiDir: null, hudRendererDir: null, mapPackDir: null, workersDir: null, pythonPath: null, sampleHudsDirs: [], cloudEnforcement: "off" }));
    await e.init();
    servers = await startServers(e);
    auth = { authorization: `Bearer ${e.secrets.operatorToken}`, "content-type": "application/json" };
    await feed("de_mirage", 5);
    // 1280×720 at 30 fps with sound (44.1 kHz), 640×480 at 25 fps with mono sound, 960×540 at 60 fps without.
    const big = make("a.mp4", ["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "2", "-c:a", "aac", "-shortest"]);
    const small = make("b.mp4", ["-f", "lavfi", "-i", "smptebars=size=640x480:rate=25", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000", "-ac", "1", "-t", "3", "-c:a", "aac", "-shortest"]);
    const silent = make("c.mp4", ["-f", "lavfi", "-i", "testsrc=size=960x540:rate=60", "-t", "1.8"]);
    originals = [big, small, silent];
    // Round 3's kills: T2's then T1's. Rounds out of order in the queue.
    kill(3, T2, "CT-Player-6");
    kill(3, T1, "CT-Player-7");
    a = add(big, 3, 2000, { kind: "shown", killer: { steamId: T1!.steamId, name: T1!.name }, victims: ["CT-Player-7"], kills: 1, weapon: "ak47", headshot: true });
    b = add(small, 1, 3000, { kind: "missed", killer: { steamId: T3!.steamId, name: T3!.name }, victims: ["CT-Player-8", "CT-Player-9", "CT-Player-0"], kills: 3, weapon: "awp", headshot: false });
    c = add(silent, 3, 1800, { kind: "other_angle", killer: { steamId: T2!.steamId, name: T2!.name }, victims: ["CT-Player-6"], kills: 1, weapon: "deagle", headshot: true });
    // One that wasn't played.
    add(silent, 4, 1800, { kind: "shown", killer: { steamId: T3!.steamId, name: T3!.name }, victims: ["x"], kills: 1, weapon: "glock", headshot: false }, false);
    e.highlights.tick();
  });

  afterAll(async () => {
    await servers?.close();
    await e?.shutdown();
  });

  it("keeps the queue's clips, even when the queue deletes its files", () => {
    const map = e.highlights.current()!;
    expect(map.mapName).toBe("de_mirage");
    expect(map.clips.map((x) => [x.id, x.played])).toEqual([
      [a.id, true],
      [b.id, true],
      [c.id, true],
      [expect.any(String), false],
    ]);
    for (const f of originals) rmSync(f);
    for (const x of map.clips) expect(existsSync(e.highlights.filePath(x))).toBe(true);
    // The kills seen give the player's side in that round.
    expect(map.clips.find((x) => x.id === a.id)!.side).toBe("T");
  });

  it("plans the played clips in round order, in a round by kill time; the best N may add unplayed ones", async () => {
    const all = await call<{ clips: { id: string; durationMs: number; graphic: { multiKill: string | null; weapon: { displayName: string } | null } }[]; totalMs: number; fadeMs: number }>("POST", "/api/v1/highlights/plan", { count: "all", fadeMs: 500 });
    expect(all.status).toBe(200);
    // Round 1, then round 3: T2's kill came before T1's.
    expect(all.body.clips.map((x) => x.id)).toEqual([b.id, c.id, a.id]);
    expect(all.body.clips[0]!.graphic).toMatchObject({ multiKill: "3K", weapon: { displayName: "AWP" } });
    expect(all.body.totalMs).toBe(3000 + 1800 + 2000 - 2 * 500);
    const best = await call<{ clips: { id: string; played: boolean }[] }>("POST", "/api/v1/highlights/plan", { count: 2, unplayed: true, fadeMs: 500 });
    // The 3K, then the headshot kills (the unplayed Glock kill scores lower).
    expect(best.body.clips.map((x) => x.id)).toEqual([b.id, expect.any(String)]);
    expect(best.body.clips.every((x) => x.played)).toBe(true);
    const four = await call<{ clips: { played: boolean }[] }>("POST", "/api/v1/highlights/plan", { count: 4, unplayed: true, fadeMs: 500 });
    expect(four.body.clips.filter((x) => !x.played)).toHaveLength(1);
  });

  it("makes one MP4: 1920×1080, one frame rate, H.264 yuv420p and AAC 48 kHz stereo, the clips less the fades", async () => {
    const plan = await call<{ clips: { id: string }[] }>("POST", "/api/v1/highlights/plan", { count: "all", fadeMs: 500 });
    // A lower third for the 3K (a red box, as the console's canvas would draw it).
    const png = join(dir, "g.png");
    execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=1920x1080,format=rgba,geq=r=255:g=40:b=40:a='if(between(X,96,796)*between(Y,860,980),230,0)'", "-frames:v", "1", png]);
    const start = await call<{ id: string; state: string; folder: string }>("POST", "/api/v1/highlights/reels", { count: "all", fadeMs: 500, clipIds: plan.body.clips.map((x) => x.id), graphics: { [b.id]: readFileSync(png).toString("base64") } });
    expect(start.status).toBe(200);
    expect(start.body.state).toBe("running");
    expect(start.body.folder).toBe(join(data, "exports", "highlights"));
    // One at a time.
    expect((await call("POST", "/api/v1/highlights/reels", { count: "all", fadeMs: 500, clipIds: [a.id] })).status).toBe(409);
    await waitFor(() => e.reels.get(start.body.id)!.state !== "running");
    const job = e.reels.get(start.body.id)!;
    expect(job).toMatchObject({ state: "done", progress: 1, clips: 3, durationMs: 5800 });
    expect(job.file!.startsWith(join(data, "exports", "highlights"))).toBe(true);
    expect(job.file!.endsWith(".mp4")).toBe(true);
    const p = probe(job.file!);
    expect(Math.abs(Number(p.format.duration) - 5.8)).toBeLessThan(0.1);
    const v = p.streams.find((s) => s.codec_type === "video")!;
    const au = p.streams.find((s) => s.codec_type === "audio")!;
    // The largest clip is 1280×720: 1920×1080; the highest frame rate, 60.
    expect(v).toMatchObject({ codec_name: "h264", width: 1920, height: 1080, pix_fmt: "yuv420p", r_frame_rate: "60/1" });
    expect(au).toMatchObject({ codec_name: "aac", sample_rate: "48000", channels: 2 });
    // The lower third is over the first clip (the 3K, round 1) once it has faded in: red at its place.
    const px = execFileSync("ffmpeg", ["-v", "error", "-ss", "1.4", "-i", job.file!, "-frames:v", "1", "-vf", "crop=2:2:400:920,scale=1:1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:"]);
    expect(px[0]!).toBeGreaterThan(180);
    expect(px[1]!).toBeLessThan(110);
    // Listed for the console, with the folder.
    const list = await call<{ jobs: { id: string; file: string }[]; folder: string }>("GET", "/api/v1/highlights");
    expect(list.body.jobs[0]).toMatchObject({ id: job.id, file: job.file });
  }, 180_000);

  it("stops a reel being made, keeping no file", async () => {
    const before = readdirSync(join(data, "exports", "highlights")).length;
    const plan = await call<{ clips: { id: string }[] }>("POST", "/api/v1/highlights/plan", { count: "all", fadeMs: 0 });
    const start = await call<{ id: string }>("POST", "/api/v1/highlights/reels", { count: "all", fadeMs: 0, clipIds: plan.body.clips.map((x) => x.id) });
    const stop = await call<{ id: string }>("POST", `/api/v1/highlights/reels/${start.body.id}/cancel`);
    expect(stop.status).toBe(200);
    await waitFor(() => e.reels.get(start.body.id)!.state !== "running", 30_000);
    expect(e.reels.get(start.body.id)!.state).toBe("cancelled");
    expect(readdirSync(join(data, "exports", "highlights")).length).toBe(before);
  }, 60_000);

  it("keeps the current and previous map, and over the space allowed drops unplayed clips first", async () => {
    const first = e.highlights.current()!.key;
    await feed("de_nuke", 1);
    e.highlights.tick();
    expect(e.highlights.maps().map((m) => m.mapName)).toEqual(["de_mirage", "de_nuke"]);
    const map = e.highlights.maps()[0]!;
    const bytes = map.clips.reduce((n, x) => n + x.bytes, 0);
    const unplayed = map.clips.find((x) => !x.played)!;
    // Room for all but a little: the unplayed clip goes.
    e.highlights.setSettings({ keepGb: 0.5 });
    expect(e.highlights.map(first)!.clips).toHaveLength(4);
    Object.assign(e.highlights, { settings: () => ({ keepGb: (bytes - 1) / 1024 ** 3 }) });
    e.highlights.prune();
    expect(e.highlights.map(first)!.clips.map((x) => x.id)).not.toContain(unplayed.id);
    expect(e.highlights.map(first)!.clips.every((x) => x.played)).toBe(true);
    expect(existsSync(e.highlights.filePath(unplayed))).toBe(false);
    // A third map: the first one's clips are gone.
    await feed("de_inferno", 1);
    e.highlights.tick();
    expect(e.highlights.maps().map((m) => m.mapName)).toEqual(["de_nuke", "de_inferno"]);
    expect(existsSync(join(data, "highlights", "clips", first))).toBe(false);
    // What is kept survives a restart (the list is on disk).
    e.highlights.save();
    expect(statSync(join(data, "highlights", "index.json")).size).toBeGreaterThan(0);
  });
});
