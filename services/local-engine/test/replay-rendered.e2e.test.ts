import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClipRecord, ReplayPlay } from "@matchframe/replay-agent";
import { buildSyntheticGsiPayload, syntheticRoster } from "../../../packages/cs2-state/src/testing/gsi-builder.ts";
import { Engine } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { breakLayout, LEAD_MS, renderBreak, TAIL_MS, type RenderedBreak, type RenderJob, type RenderRequest } from "../src/replay/render.ts";
import { TEST_CLIPS, testClipsDir } from "../src/replay/test-run.ts";
import { startServers } from "../src/servers.ts";
import { StandInObs } from "./stand-in-obs.ts";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn: () => boolean, ms = 15000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(20);
  }
};

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-hide_banner", "-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-hide_banner", "-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("A rendered break's layout", () => {
  it("puts each clip where the fade into it begins, after the first frame held, and the last frame held after them", () => {
    const l = breakLayout([5200, 4000, 6000], 500, 400);
    expect(l).toEqual({ leadMs: LEAD_MS, contentMs: 5200 + 4000 + 6000 - 1000, tailMs: TAIL_MS, totalMs: LEAD_MS + 14200 + TAIL_MS, fadeMs: 500, audioFadeMs: 400, starts: [LEAD_MS, LEAD_MS + 4700, LEAD_MS + 4700 + 3500] });
    // A cut: the clips one after the other.
    expect(breakLayout([3000, 3000], 0, 300).starts).toEqual([LEAD_MS, LEAD_MS + 3000]);
    // One clip: no fade; a fade at most a third of the shorter clip; the sound's fade at most a quarter of the whole.
    expect(breakLayout([3000], 500, 400)).toMatchObject({ fadeMs: 0, contentMs: 3000, starts: [LEAD_MS] });
    expect(breakLayout([900, 3000], 500, 400)).toMatchObject({ fadeMs: 300, contentMs: 3600 });
    expect(breakLayout([800], 500, 1000).audioFadeMs).toBe(200);
  });
});

/**
 * A break played as one rendered file (ADR-067) with a stand-in OBS (stand-in-obs.ts) and a stand-in
 * renderer (the file's layout as render.ts makes it; the stand-in OBS plays it for its length): the
 * replay scene alone, Replay in and out, the status and the replay graphic's clip following the cursor,
 * Skip, Hold, the round clock with the sound faded first, and the way back to the two scenes when the
 * file isn't ready in time or can't be made.
 */
describe("Replay break: one rendered file in the replay scene", () => {
  let e: Engine;
  let o: StandInObs;
  let servers: Awaited<ReturnType<typeof startServers>>;
  let gsiPort: number;
  let apiPort: number;
  let ts = 1_700_300_000;
  const roster = syntheticRoster();
  const dir = mkdtempSync(join(tmpdir(), "mf-rendered-"));
  const files = ["a", "b", "c", "d"].map((n) => join(dir, `clip-${n}.mp4`));
  /** Each clip file plays 3 s; a clip's part is its last 2 s; 0.4 s fades. */
  const DURATION = 3000;
  const PLAY = 2000;
  const FADE = 400;
  /** The stand-in renderer: how long it takes, whether it fails, and what it was asked. */
  const render = { delayMs: 300, fail: null as string | null, requests: [] as RenderRequest[], cancelled: 0 };

  const feed = async (roundPhase: "live" | "over" | "freezetime", round: number, phaseEndsIn?: number) => {
    const payload = buildSyntheticGsiPayload({ mapName: "de_dust2", round, players: roster, observed: roster[0]!.steamId, roundPhase, phase: roundPhase, phaseEndsIn: phaseEndsIn ?? (roundPhase === "live" ? 115 : 7), token: e.secrets.gsiToken, timestamp: ts++ });
    expect((await fetch(`http://127.0.0.1:${gsiPort}/gsi`, { method: "POST", body: JSON.stringify(payload) })).status).toBe(200);
    await sleep(300);
  };
  const api = async (path: string, body?: unknown, method = "POST") => {
    const r = await fetch(`http://127.0.0.1:${apiPort}${path}`, { method, headers: { authorization: `Bearer ${e.secrets.operatorToken}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };
  const clip = (round: number, path: string): ClipRecord => ({ clipId: `c${Math.random()}`, providerId: "replay-pc", sourceId: "replay-pc", angle: "recorded_angle", matchTimeFromMs: null, matchTimeToMs: null, timeUncertaintyMs: null, epoch: null, roundNumber: round, media: { path, durationMs: DURATION, frameRate: 30, timebase: null, startPts: null, hasAudio: true, width: 1920, height: 1072 }, createdAt: new Date().toISOString() });
  const add = (round: number, label: string, kills: number, path: string) => {
    const play: ReplayPlay = { kind: "missed", killer: { steamId: `k-${label}`, name: label }, victims: [`v-${label}`], kills, weapon: "ak47", headshot: false };
    return e.replays.addExternal(label, play.kind, round, clip(round, path), { playMs: PLAY, leadMs: 1000, play });
  };
  const done = () => e.autoReplay.getStatus().detail.startsWith("Replays for this break are done");
  const settle = () => sleep(700);
  const at = () => Date.now() - (o as unknown as { t0: number }).t0;
  /** While the replays play: each status line, with the program's clip and where the file was then. */
  const watch = () => {
    const seen: { detail: string; active: string | null; cursorMs: number | null }[] = [];
    const timer = setInterval(() => {
      const d = e.autoReplay.getStatus().detail;
      if (seen.at(-1)?.detail === d) return;
      const file = o.inputs.get("replay")!.media.file;
      seen.push({ detail: d, active: e.program.activeReplay, cursorMs: file?.endsWith(".mp4") && !file.includes("clip-") ? o.media("replay").cursorMs : null });
    }, 10);
    return { seen, stop: () => clearInterval(timer) };
  };

  beforeAll(async () => {
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    for (const f of files) writeFileSync(f, Buffer.alloc(64));
    const ports = { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
    gsiPort = ports.gsi;
    apiPort = ports.api;
    e = new Engine(loadConfig({ dataDir: mkdtempSync(join(tmpdir(), "mf-rendered-data-")), gsiPort: ports.gsi, apiPort: ports.api, overlayPort: ports.overlay, host: "127.0.0.1", captainUiDir: null, hudRendererDir: null, mapPackDir: null, workersDir: null, pythonPath: null, sampleHudsDirs: [], cloudEnforcement: "off" }));
    await e.init();
    servers = await startServers(e);
    o = await StandInObs.attach(e, (obs) => {
      obs.addScene("Game");
      obs.addInput("Game", "Game capture", "color_source_v3");
      obs.addInput("Game", "Game audio", "wasapi_output_capture");
      obs.inputs.get("Game audio")!.audio.volumeMul = 0.8;
      obs.addScene("My Replay");
      obs.addInput("My Replay", "Backdrop", "color_source_v3");
      obs.addInput("My Replay", "replay", "ffmpeg_source", { is_local_file: true, restart_on_activate: false, close_when_inactive: false, clear_on_media_end: false });
      obs.inputs.get("replay")!.audio.volumeMul = 0.5;
      obs.program = "Game";
      obs.defaultDurationMs = DURATION;
      // As the owner's Windows OBS: a hidden source's pause is let go (the rendered file is never paused off air).
      obs.hiddenPause = "ignored";
    });
    const scenes = { LIVE: "Game", REPLAY: "My Replay", STUDIO: null, BREAK: null };
    e.settings.set("program.scenes", scenes);
    e.program.setScenes(scenes);
    e.settings.set("replay.mediaInput", "replay");
    // ffmpeg as found on the owner's PC (the stand-in renderer doesn't run it).
    e.ffmpeg.locate = async () => "ffmpeg";
    e.ffmpeg.pickEncoder = async () => "h264_nvenc";
    e.autoReplay.renderer = (req): RenderJob => {
      render.requests.push(req);
      const layout = breakLayout(
        req.clips.map((c) => c.durationMs),
        req.fadeMs,
        req.audioFadeMs,
      );
      const started = Date.now();
      let cancelled = false;
      const done = new Promise<RenderedBreak>((resolve, reject) => {
        setTimeout(() => {
          if (cancelled) return reject(new Error("cancelled"));
          if (render.fail) return reject(new Error(render.fail));
          writeFileSync(req.outFile, Buffer.alloc(64));
          o.durations.set(req.outFile, layout.totalMs);
          resolve({ file: req.outFile, layout, ms: Date.now() - started, width: 1920, height: 1072, fps: 29.97, encoder: req.encoder, bytes: 64 });
        }, render.delayMs);
      });
      return {
        done,
        progress: () => Math.min(0.99, (Date.now() - started) / render.delayMs),
        cancel: () => {
          cancelled = true;
          render.cancelled++;
        },
      };
    };
    e.autoReplay.setSettings({ enabled: true, startDelayMs: 0, perBreak: 3, order: "best", ownBigPlays: false, between: "fade", fadeMs: FADE, audioFadeMs: 300, duckInputs: ["Game audio"], duckTo: -20, duckRampMs: 100 });
    expect(e.autoReplay.settings().playback).toBe("rendered");
  });

  afterAll(async () => {
    await servers?.close();
    await e?.shutdown();
  });

  it("plays the break's clips as one file in the replay scene alone: Replay in as it opens, the status and the replay graphic's clip following its cursor, Replay out at its end", async () => {
    e.obsAuto.setSettings({ replayIn: "MatchFrame Replay Stinger", replayOut: "", otherScenes: "" });
    await feed("live", 4);
    const round = e.session.state()!.roundNumber!;
    const ids = [add(round, "triple", 3, files[0]!).id, add(round, "double", 2, files[1]!).id, add(round, "single", 1, files[2]!).id];
    o.changes.length = 0;
    o.mediaLog.length = 0;
    render.requests.length = 0;
    const history = e.program.history.length;
    const w = watch();
    await feed("over", 4);
    await waitFor(done);
    w.stop();
    await settle();
    // One file of the three parts (the end of each file, 2 s), with the fade and the sound's fade.
    expect(render.requests).toHaveLength(1);
    expect(render.requests[0]).toMatchObject({ encoder: "h264_nvenc", fadeMs: FADE, audioFadeMs: 300, clips: files.slice(0, 3).map((file) => ({ file, startMs: null, durationMs: PLAY })) });
    const layout = breakLayout([PLAY, PLAY, PLAY], FADE, 300);
    // The replay scene alone: Replay in, Replay out; no twin.
    expect(o.changes.map((c) => [c.scene, c.transition])).toEqual([
      ["My Replay", "MatchFrame Replay Stinger"],
      ["Game", "Fade"],
    ]);
    expect(o.scenes.has("My Replay B")).toBe(false);
    // Loaded once, never paused; set back to where the clips start as the stinger shows the scene (its cut point, 300 ms).
    const file = render.requests[0]!.outFile;
    expect(o.mediaLog.filter((l) => !l.includes("seek"))).toEqual([`replay load ${file.split(/[\\/]/).pop()}`]);
    const seek = Number(o.mediaLog.find((l) => l.includes("seek"))!.replace(/^.* seek /, ""));
    expect(seek).toBeGreaterThanOrEqual(LEAD_MS - 300);
    expect(seek).toBeLessThanOrEqual(LEAD_MS - 200);
    expect(o.changes[0]!.media.replay!.state).toBe("PLAYING");
    // Out at the clips' end (before the last frame held).
    const out = o.changes[1]!.media.replay!.cursorMs;
    expect(out).toBeGreaterThanOrEqual(layout.leadMs + layout.contentMs - 60);
    expect(out).toBeLessThanOrEqual(layout.leadMs + layout.contentMs + 120);
    // The status and the program's clip (the replay graphic's) change as the cursor reaches each clip's start.
    const lines = w.seen.filter((x) => x.detail.startsWith("Replay "));
    expect(lines.map((x) => x.detail)).toEqual(["Replay 1 of 3: triple", "Replay 2 of 3: double", "Replay 3 of 3: single"]);
    expect(w.seen.find((x) => x.detail.startsWith("Preparing the replays"))).toBeTruthy();
    for (const k of [1, 2]) {
      expect(lines[k]!.active).toBe(ids[k]);
      expect(lines[k]!.cursorMs, `clip ${k + 1}`).toBeGreaterThanOrEqual(layout.starts[k]!);
      expect(lines[k]!.cursorMs, `clip ${k + 1}`).toBeLessThanOrEqual(layout.starts[k]! + 130);
    }
    expect(e.program.history.slice(history).map((t) => t.to)).toEqual(["REPLAY_PREPARED", "REPLAY_PLAYING", "LIVE"]);
    expect(e.replays.list().filter((i) => i.roundNumber === round).map((i) => i.state)).toEqual(["played", "played", "played"]);
    expect(e.autoReplay.getStatus().detail).toBe("Replays for this break are done (3 played).");
    expect(e.autoReplay.getStatus().render).toMatchObject({ kind: "break", clips: 3, rendered: true, encoder: "h264_nvenc" });
    // The live audio down and back exactly; the replay source's own volume untouched.
    expect(o.inputs.get("Game audio")!.audio.volumeMul).toBe(0.8);
    expect(o.volumeLog.filter((v) => v.input === "replay")).toEqual([]);
    // Emptied once the transition back is over, and the file removed.
    await waitFor(() => o.inputs.get("replay")!.settings.local_file === "", 8000);
    await waitFor(() => !existsSync(file), 2000);
  }, 30000);

  it("Skip goes to the next clip's start in the file; Skip on the last goes back to live, its sound faded out, the source's volume back after", async () => {
    e.obsAuto.setSettings({ replayIn: "", replayOut: "Cut" });
    await feed("live", 6);
    const round = e.session.state()!.roundNumber!;
    add(round, "one", 3, files[0]!);
    add(round, "two", 2, files[1]!);
    add(round, "three", 1, files[2]!);
    o.changes.length = 0;
    o.mediaLog.length = 0;
    o.volumeLog.length = 0;
    await feed("over", 6);
    await waitFor(() => e.autoReplay.getStatus().detail === "Replay 1 of 3: one");
    await sleep(400);
    const layout = breakLayout([PLAY, PLAY, PLAY], FADE, 300);
    expect((await api("/api/v1/replays/auto/skip")).status).toBe(200);
    await waitFor(() => e.autoReplay.getStatus().detail === "Replay 2 of 3: two", 1000);
    expect(o.mediaLog.at(-1)).toBe(`replay seek ${layout.starts[1]}`);
    await sleep(300);
    expect((await api("/api/v1/replays/auto/skip")).status).toBe(200);
    await waitFor(() => e.autoReplay.getStatus().detail === "Replay 3 of 3: three", 1000);
    await sleep(300);
    const lastSkip = at();
    expect((await api("/api/v1/replays/auto/skip")).status).toBe(200);
    await waitFor(done);
    expect(o.changes.map((c) => [c.scene, c.transition])).toEqual([
      ["My Replay", "Fade"],
      ["Game", "Cut"],
    ]);
    expect(o.changes[1]!.at - lastSkip).toBeLessThan(400);
    expect(e.autoReplay.getStatus().detail).toBe("Replays for this break are done (3 played, 3 skipped).");
    // The replay source's sound faded down as the program went back, and its volume put back once off air.
    await waitFor(() => o.volumeLog.some((v) => v.input === "replay" && v.mul < 0.01), 1000);
    const replay = o.volumeLog.filter((v) => v.input === "replay");
    expect(replay.length).toBeGreaterThanOrEqual(3);
    expect(replay[0]!.at - o.changes[1]!.at).toBeLessThan(150);
    await waitFor(() => o.inputs.get("replay")!.audio.volumeMul === 0.5, 8000);
  }, 30000);

  it("Hold pauses the file on air until Resume; the round clock cuts back to live, the replays' sound faded out just before", async () => {
    e.autoReplay.setSettings({ cutBack: "clock", cutBackClockSec: 110 });
    e.obsAuto.setSettings({ replayIn: "", replayOut: "Cut" });
    await feed("live", 8);
    const round = e.session.state()!.roundNumber!;
    add(round, "one", 2, files[0]!);
    add(round, "two", 1, files[1]!);
    o.changes.length = 0;
    o.mediaLog.length = 0;
    o.volumeLog.length = 0;
    await feed("over", 8);
    await waitFor(() => e.autoReplay.getStatus().detail === "Replay 1 of 2: one");
    await sleep(300);
    expect((await api("/api/v1/replays/auto/hold", { held: true })).status).toBe(200);
    await waitFor(() => o.media("replay").state === "PAUSED", 1000);
    const heldAt = o.media("replay").cursorMs;
    await sleep(1500);
    expect(o.media("replay")).toMatchObject({ state: "PAUSED", cursorMs: heldAt });
    expect(o.changes).toHaveLength(1);
    expect((await api("/api/v1/replays/auto/hold", { held: false })).status).toBe(200);
    await waitFor(() => o.media("replay").state === "PLAYING" && o.media("replay").cursorMs > heldAt + 100, 1000);
    // The next round goes live and its clock reads 1:51.0: back to live by 1:50 (less 0.25 s), the sound faded out first.
    await feed("live", 9);
    await feed("live", 9, 111);
    await waitFor(() => o.changes.length === 2, 3000);
    expect(o.changes[1]!.scene).toBe("Game");
    await waitFor(() => !e.autoReplay.getStatus().running);
    expect(e.replays.list().filter((i) => i.roundNumber === round).map((i) => i.state)).toEqual(["played", "prepared"]);
    const down = o.volumeLog.filter((v) => v.input === "replay" && v.mul < 0.5);
    expect(down.length).toBeGreaterThanOrEqual(3);
    // The fade began before the cut back, and was all but silent by it.
    expect(down[0]!.at).toBeLessThan(o.changes[1]!.at);
    expect(Math.min(...down.filter((v) => v.at <= o.changes[1]!.at + 50).map((v) => v.mul))).toBeLessThan(0.15);
    await waitFor(() => o.inputs.get("replay")!.audio.volumeMul === 0.5, 8000);
  }, 30000);

  it("plays through the two scenes when the file isn't ready in time or can't be made, and says why", async () => {
    e.obsAuto.setSettings({ replayIn: "", replayOut: null });
    for (const [n, why, expected] of [
      [12, "slow", /^Played through the scenes: making the file took longer than 1 s\.$/],
      [14, "fail", /^Played through the scenes: ffmpeg failed \(Conversion failed!\)\.$/],
    ] as const) {
      e.autoReplay.renderWaitMs = 1000;
      render.delayMs = why === "slow" ? 2500 : 200;
      render.fail = why === "fail" ? "Conversion failed!" : null;
      const cancelled = render.cancelled;
      await feed("live", n);
      const round = e.session.state()!.roundNumber!;
      add(round, "one", 2, files[0]!);
      add(round, "two", 1, files[1]!);
      o.changes.length = 0;
      o.mediaLog.length = 0;
      const logs = e.logger.recent.length;
      try {
        await feed("over", n);
        await waitFor(done);
        await settle();
      } finally {
        render.delayMs = 300;
        render.fail = null;
        e.autoReplay.renderWaitMs = 6000;
      }
      // The clips one by one: the replay scene, its twin, back to live.
      expect(o.changes.map((c) => c.scene)).toEqual(["My Replay", "My Replay B", "Game"]);
      expect(o.mediaLog.filter((l) => l.includes(" load "))).toEqual(["replay load clip-a.mp4", "replay B load clip-b.mp4"]);
      expect(e.autoReplay.getStatus().detail).toBe("Replays for this break are done (2 played).");
      expect(e.autoReplay.getStatus().render).toMatchObject({ rendered: false, clips: 2, detail: expect.stringMatching(expected) });
      expect(e.logger.recent.slice(logs).map((l) => l.msg)).toContain("automatic replays: no rendered file; the clips play through the scenes");
      if (why === "slow") expect(render.cancelled).toBe(cancelled + 1);
    }
  }, 30000);

  it("Stop while the file is made: nothing goes on air", async () => {
    render.delayMs = 1500;
    try {
      await feed("live", 16);
      const round = e.session.state()!.roundNumber!;
      add(round, "one", 2, files[0]!);
      o.changes.length = 0;
      await feed("over", 16);
      await waitFor(() => e.autoReplay.getStatus().detail.startsWith("Preparing the replays"));
      expect(e.autoReplay.getStatus()).toMatchObject({ running: true, preparing: { kind: "break", clips: 1 } });
      expect((await api("/api/v1/replays/auto/stop")).status).toBe(200);
      await waitFor(done);
      await settle();
      expect(o.changes).toEqual([]);
      expect(e.program.mode).toBe("LIVE");
      expect(e.autoReplay.getStatus().detail).toBe("Replays for this break are done (stopped by the operator).");
    } finally {
      render.delayMs = 300;
    }
  }, 20000);

  it("Test replays play their sample clips through the same rendered file, and the report says so", async () => {
    const samples = testClipsDir()!;
    for (const c of TEST_CLIPS) o.durations.set(join(samples, c.file), c.durationMs);
    e.obsAuto.setSettings({ replayIn: "MatchFrame Replay Stinger", replayOut: "" });
    await feed("freezetime", 20, 15);
    o.changes.length = 0;
    expect((await api("/api/v1/replays/auto/test")).status).toBe(200);
    await waitFor(() => e.autoReplay.getStatus().test?.state !== "running", 20000);
    const report = e.autoReplay.getStatus().test!;
    expect(report.steps.map((s) => [s.id, s.state])).toEqual([
      ["ready", "ok"],
      ["in", "ok"],
      ["fade", "ok"],
      ["out", "ok"],
      ["live", "ok"],
      ["audio", "ok"],
    ]);
    expect(report.steps.find((s) => s.id === "ready")!.detail).toBe("“My Replay” with “replay”: the clips play as one rendered file in it.");
    expect(report.steps.find((s) => s.id === "fade")!.detail).toMatch(/^2 clips rendered into one file in \d+\.\d s \(h264_nvenc, 1920×1072\), with a 0\.4 s fade between them\.$/);
    expect(o.changes.map((c) => [c.scene, c.transition])).toEqual([
      ["My Replay", "MatchFrame Replay Stinger"],
      ["Game", "Fade"],
    ]);
    e.obsAuto.setSettings({ replayIn: "", replayOut: null });
  }, 30000);
  it("the support file says which OBS (its version, its websocket's, its platform) and how the last run's file went", async () => {
    const r = await fetch(`http://127.0.0.1:${apiPort}/api/v1/diagnostics/bundle`, { headers: { authorization: `Bearer ${e.secrets.operatorToken}` } });
    const bundle = JSON.parse(await r.text()) as { replays: { obs: Record<string, unknown>; auto: { render: Record<string, unknown> | null } } };
    expect(bundle.replays.obs).toMatchObject({ connected: true, obsVersion: "30.0.2", websocketVersion: "5.3.4", platform: "stand-in" });
    expect(bundle.replays.auto.render).toMatchObject({ kind: "test", rendered: true, clips: 2 });
  });
});

/** The renderer itself with ffmpeg: three clips (one without sound) joined, checked with ffprobe. */
describe.skipIf(!hasFfmpeg)("Rendering a break with ffmpeg", () => {
  it("joins the parts with crossfades into one file of the right length, the sound faded in and out, a keyframe at each clip's start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mf-render-ffmpeg-"));
    const make = (name: string, hue: number, tone: number | null) => {
      const file = join(dir, `${name}.mp4`);
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=320x180:rate=30000/1001:duration=3,hue=h=${hue}`, ...(tone ? ["-f", "lavfi", "-i", `sine=frequency=${tone}:sample_rate=48000:duration=3`] : []), "-c:v", "libx264", "-preset", "ultrafast", "-g", "30", "-pix_fmt", "yuv420p", ...(tone ? ["-c:a", "aac", "-shortest"] : []), file]);
      return file;
    };
    const clips = [make("a", 0, 440), make("b", 120, null), make("c", 240, 660)];
    const out = join(dir, "break.mp4");
    const job = renderBreak({ ffmpeg: "ffmpeg", version: null, encoder: "libx264", clips: [{ file: clips[0]!, startMs: null, durationMs: 2500 }, { file: clips[1]!, startMs: 200, durationMs: 2000 }, { file: clips[2]!, startMs: null, durationMs: 2500 }], fadeMs: 500, audioFadeMs: 400, outFile: out });
    const r = await job.done;
    expect(job.progress()).toBe(1);
    expect(r).toMatchObject({ width: 320, height: 180, encoder: "libx264", layout: { leadMs: LEAD_MS, contentMs: 2500 + 2000 + 2500 - 1000, tailMs: TAIL_MS, fadeMs: 500, audioFadeMs: 400, starts: [LEAD_MS, LEAD_MS + 2000, LEAD_MS + 3500] } });
    expect(Math.abs(r.fps - 29.97)).toBeLessThan(0.01);
    // The length: the clips less the fades, with the first frame held before and the last after (to a frame).
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,duration,width,height", "-of", "json", out]).toString()) as { streams: { codec_type: string; duration: string }[] };
    const total = (LEAD_MS + 6000 + TAIL_MS) / 1000;
    for (const s of probe.streams) expect(Math.abs(Number(s.duration) - total), s.codec_type).toBeLessThan(0.05);
    // A keyframe where each clip starts (the fade into it begins), so Skip lands exactly.
    const keys = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v", "-skip_frame", "nokey", "-show_entries", "frame=pts_time", "-of", "csv=p=0", out]).toString().trim().split("\n").map(Number);
    for (const s of r.layout.starts) expect(keys.some((k) => Math.abs(k - s / 1000) < 0.04), `a keyframe at ${s} ms`).toBe(true);
    // The sound: silent while the first frame is held, fading in, full, fading out, silent under the last frame held.
    const level = (from: number, to: number) => {
      const t = spawnSync("ffmpeg", ["-v", "info", "-i", out, "-af", `atrim=${from}:${to},volumedetect`, "-vn", "-f", "null", "-"]).stderr.toString();
      return Number(/mean_volume: (-?[\d.]+) dB/.exec(t)?.[1] ?? "-100");
    };
    const lead = LEAD_MS / 1000;
    const end = lead + 6;
    expect(level(0, lead - 0.1)).toBeLessThan(-80);
    const fadeIn = level(lead, lead + 0.1);
    const full = level(lead + 0.6, lead + 1.2);
    const fadeOut = level(end - 0.1, end);
    expect(full).toBeGreaterThan(-30);
    expect(fadeIn).toBeLessThan(full - 6);
    expect(fadeOut).toBeLessThan(full - 6);
    expect(level(end + 0.1, end + 0.9)).toBeLessThan(-80);
  }, 60000);
});
