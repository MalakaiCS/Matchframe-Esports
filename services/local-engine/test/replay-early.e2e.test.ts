import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Vec3 } from "@matchframe/contracts";
import { MapPack } from "@matchframe/contracts";
import { VisibilityGrid } from "@matchframe/map-runtime";
import type { ClipRecord, ReplayPlay } from "@matchframe/replay-agent";
import type { SyntheticPlayer } from "../../../packages/cs2-state/src/testing/gsi-builder.ts";
import { buildSyntheticGsiPayload } from "../../../packages/cs2-state/src/testing/gsi-builder.ts";
import { Engine } from "../src/app.ts";
import { breakLayout, type RenderJob, type RenderRequest } from "../src/replay/render.ts";
import { loadConfig } from "../src/config.ts";
import { startServers } from "../src/servers.ts";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

const waitFor = async (fn: () => boolean, ms = 20000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const root = join(import.meta.dirname, "..", "..", "..");
const A_BOMB: Vec3 = { x: -386, y: -1667, z: -168 };
const B_SITE: Vec3 = { x: -1829, y: 493, z: -168 };
const CT_SPAWN: Vec3 = { x: -1650, y: -1950, z: -295 };
const T_SPAWN: Vec3 = { x: 1230, y: -300, z: -167 };
/** 892 u on foot from the A bomb: with a kit, a defuse within reach of 9 s on the fuse. */
const NINJA: Vec3 = { x: -686, y: -967, z: -200 };

/**
 * Early replays (ADR-083) end to end on Mirage (its map pack, free-space grid and walking graph): CS2's
 * game data posted to the engine's GSI port as a game would send it (the fuse running down in real
 * time), the stand-in OBS of the replay break tests (one replay source), and a stand-in vMix.
 */
describe("Early replays: a decided round's break starts before the round ends", () => {
  let e: Engine;
  let servers: Awaited<ReturnType<typeof startServers>>;
  let gsiPort: number;
  let ts = 1_700_000_000;
  const played: string[] = [];
  const scenes: string[] = [];
  /** Stand-in OBS: a loaded clip plays for this long (unless paused), then it has ended. */
  let clipMs = 2500;
  let loaded = "";
  let elapsed = 0;
  let playingSince: number | null = null;
  let cursor = { at: 0, played: 0 };
  const playedMs = () => elapsed + (playingSince === null ? 0 : Date.now() - playingSince);
  const dir = mkdtempSync(join(tmpdir(), "mf-early-"));
  const file = join(dir, "clip.mp4");

  /** The game now: CS2 sends it every 200 ms (the fuse or the round clock running down in real time). */
  const game: { round: number; phase: "live" | "over"; players: SyntheticPlayer[]; plantEndsAt: number | null; roundEndsAt: number; exploded: boolean } = { round: 0, phase: "live", players: [], plantEndsAt: null, roundEndsAt: 0, exploded: false };
  let feeder: ReturnType<typeof setInterval> | null = null;
  const post = async () => {
    const left = (at: number) => Math.max(0, (at - Date.now()) / 1000);
    const planted = game.plantEndsAt !== null;
    const bomb = game.exploded ? { state: "exploded", position: A_BOMB } : planted ? { state: "planted", position: A_BOMB, countdown: left(game.plantEndsAt!) } : { state: "carried", player: game.players[0]!.steamId, position: game.players[0]!.position! };
    const phase = game.phase === "over" ? "over" : planted ? "bomb" : "live";
    const payload = buildSyntheticGsiPayload({ mapName: "de_mirage", round: game.round, players: game.players, observed: game.players[0]!.steamId, roundPhase: game.phase, phase, phaseEndsIn: game.phase === "over" ? 7 : planted ? left(game.plantEndsAt!) : left(game.roundEndsAt), bomb, ...(planted ? { roundBomb: game.exploded ? ("exploded" as const) : ("planted" as const) } : {}), token: e.secrets.gsiToken, timestamp: ts++ });
    await fetch(`http://127.0.0.1:${gsiPort}/gsi`, { method: "POST", body: JSON.stringify(payload) }).catch(() => undefined);
  };
  const T = (i: number) => `7656119800000000${i}`;
  const CT = (i: number) => `7656119800000001${i}`;
  const pl = (steamId: string, side: "T" | "CT", position: Vec3, extra: Partial<SyntheticPlayer> = {}): SyntheticPlayer => ({ steamId, name: `${side}${steamId.slice(-1)}`, slot: Number(steamId.slice(-1)), side, position, forward: { x: 1, y: 0, z: 0 }, weapons: [{ name: side === "T" ? "weapon_ak47" : "weapon_m4a1", type: "Rifle", state: "active" }], ...extra });
  const dead = (p: SyntheticPlayer): SyntheticPlayer => ({ ...p, health: 0 });
  /** The Ts on the planted bomb at A and one CT alive at `ct`; the rest dead. */
  const afterPlant = (ct: Vec3, kit: boolean): SyntheticPlayer[] => [
    pl(T(1), "T", A_BOMB),
    pl(T(2), "T", { x: A_BOMB.x + 60, y: A_BOMB.y + 40, z: A_BOMB.z }),
    dead(pl(T(3), "T", T_SPAWN)),
    dead(pl(T(4), "T", T_SPAWN)),
    dead(pl(T(5), "T", T_SPAWN)),
    pl(CT(6), "CT", ct, { defuseKit: kit }),
    dead(pl(CT(7), "CT", CT_SPAWN)),
    dead(pl(CT(8), "CT", CT_SPAWN)),
    dead(pl(CT(9), "CT", CT_SPAWN)),
    dead(pl(CT(0), "CT", CT_SPAWN)),
  ];
  /** A round goes live; returns its number (the game's round count plus one). */
  const startRound = async (count: number, players: SyntheticPlayer[]) => {
    Object.assign(game, { round: count, phase: "live", players, plantEndsAt: null, roundEndsAt: Date.now() + 60_000, exploded: false });
    await post();
    await sleep(300);
    return e.session.state()!.roundNumber!;
  };
  const plant = (fuseSec: number) => void (game.plantEndsAt = Date.now() + fuseSec * 1000);
  const endRound = () => Object.assign(game, { phase: "over", exploded: true });
  const clip = (round: number): ClipRecord => ({ clipId: `c${Math.random()}`, providerId: "replay-pc", sourceId: "replay-pc", angle: "recorded_angle", matchTimeFromMs: null, matchTimeToMs: null, timeUncertaintyMs: null, epoch: null, roundNumber: round, media: { path: file, durationMs: 9000, frameRate: 60, timebase: null, startPts: null, hasAudio: false, width: 1920, height: 1080 }, createdAt: new Date().toISOString() });
  let killer = 0;
  const add = (round: number, label: string) => {
    const play: ReplayPlay = { kind: "missed", killer: { steamId: `k${++killer}`, name: `killer${killer}` }, victims: [label], kills: 1, weapon: "ak47", headshot: false };
    return e.replays.addExternal(label, play.kind, round, clip(round), { playMs: 2000, leadMs: 1000, play });
  };
  const audit = (action: string) => e.audit.recent(200).filter((a) => a.action === action);
  const fresh = () => {
    played.length = 0;
    scenes.length = 0;
  };

  beforeAll(async () => {
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    writeFileSync(file, Buffer.alloc(1024));
    const ports = { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
    gsiPort = ports.gsi;
    e = new Engine(loadConfig({ dataDir: mkdtempSync(join(tmpdir(), "mf-early-data-")), gsiPort: ports.gsi, apiPort: ports.api, overlayPort: ports.overlay, host: "127.0.0.1", captainUiDir: null, hudRendererDir: null, mapPackDir: null, workersDir: null, pythonPath: null, sampleHudsDirs: [], cloudEnforcement: "off" }));
    await e.init();
    servers = await startServers(e);
    // Mirage: its map pack (bombsites) and its free-space grid (walking, sightlines).
    e.maps.setGrid(VisibilityGrid.parse(readFileSync(join(root, "assets", "map-packs", "de_mirage.grid")), (b) => inflateSync(b)));
    e.registerBasePack(MapPack.parse(JSON.parse(readFileSync(join(root, "assets", "map-packs", "de_mirage.json"), "utf8"))));
    Object.assign(e.obs.state, { connected: true });
    e.obs.setProgram = async (scene: string) => {
      scenes.push(scene);
      return { confirmed: true, programScene: scene };
    };
    e.obs.setMediaFile = async (_input: string, path: string) => {
      loaded = path;
      elapsed = 0;
      playingSince = Date.now();
      cursor = { at: 0, played: 0 };
    };
    e.obs.mediaAction = async (_input: string, action: "play" | "pause" | "stop" | "restart") => {
      if (action === "pause" && playingSince !== null) {
        elapsed += Date.now() - playingSince;
        playingSince = null;
      }
      if (action === "play" && playingSince === null) playingSince = Date.now();
      if (action === "restart") [elapsed, playingSince, cursor] = [0, Date.now(), { at: 0, played: 0 }];
    };
    e.obs.setMediaCursor = async (_input: string, ms: number) => {
      cursor = { at: ms, played: playedMs() };
    };
    e.obs.mediaStatus = async () => {
      const state = !loaded ? "NONE" : playingSince === null ? "PAUSED" : playedMs() < clipMs ? "PLAYING" : "ENDED";
      return { state: `OBS_MEDIA_STATE_${state}`, durationMs: 9000, cursorMs: Math.min(9000, cursor.at + playedMs() - cursor.played) };
    };
    e.settings.set("program.scenes", { LIVE: "Game", REPLAY: "Replay", STUDIO: null, BREAK: null });
    e.program.setScenes({ LIVE: "Game", REPLAY: "Replay", STUDIO: null, BREAK: null });
    e.settings.set("replay.mediaInput", "Replay Clip");
    const markPlaying = e.replays.markPlaying.bind(e.replays);
    e.replays.markPlaying = (id: string) => {
      played.push(e.replays.get(id)!.label);
      return markPlaying(id);
    };
    game.players = afterPlant(B_SITE, false);
    feeder = setInterval(() => void post(), 200);
  });

  afterAll(async () => {
    if (feeder) clearInterval(feeder);
    await servers?.close();
    await e?.shutdown();
  });

  it("starts the replays at most the set seconds before the explosion, with the clips that are ready; a late clip joins; the round ends and the break goes on", async () => {
    e.autoReplay.setSettings({ enabled: true, startDelayMs: 0, perBreak: 3, order: "round", playback: "scenes", early: true, earlyMaxSec: 5, earlyBackToLive: true });
    clipMs = 2500;
    // The one CT alive is at B without a kit: 3,106 u from the bomb, 22 s to defuse.
    const round = await startRound(4, afterPlant(B_SITE, false));
    add(round, "opening kill");
    add(round, "second kill");
    fresh();
    const history = e.program.history.length;
    plant(8);
    // Decided at once; the replays start with 5 s on the fuse (the setting), not before.
    await waitFor(() => e.program.mode === "REPLAY_PLAYING", 8000);
    const fuseLeft = game.plantEndsAt! - Date.now();
    expect(e.session.state()!.roundPhase).toBe("live");
    expect(fuseLeft).toBeLessThanOrEqual(5000);
    expect(fuseLeft).toBeGreaterThan(4300);
    const started = audit("replay.auto_early")[0]!.detail as Record<string, unknown>;
    expect(started).toMatchObject({ round, kind: "bomb", maxSec: 5 });
    // (Walks are searched 3,000 u at least: the CT at B is further.)
    expect(started.words).toBe("no CT can defuse (fuse 0:05; nearest CT over 3,000 u, no kit)");
    expect(started.endsInMs as number).toBeLessThanOrEqual(5000);
    expect(e.autoReplay.getStatus().early).toMatchObject({ state: "on_air" });
    // The replay PC's clip of the round's last kill comes in after the replays started: it joins them.
    await sleep(800);
    add(round, "late kill");
    expect(e.autoReplay.getStatus().ranked.find((r) => r.label === "late kill")!.state).toBe("waiting");
    // The bomb goes off: the round is over, and the break simply goes on.
    await waitFor(() => Date.now() >= game.plantEndsAt!);
    endRound();
    await waitFor(() => e.autoReplay.getStatus().detail.startsWith("Replays for this break are done"), 15000);
    expect(played).toEqual(["opening kill", "second kill", "late kill"]);
    // One cut to the replays and one back, the round ending in between.
    expect(scenes).toEqual(["Replay", "Game"]);
    expect(e.program.history.slice(history).map((t) => t.to)).toEqual(["REPLAY_PREPARED", "REPLAY_PLAYING", "LIVE"]);
    expect(e.autoReplay.getStatus().detail).toBe("Replays for this break are done (3 played).");
    // No second break for the round.
    await sleep(800);
    expect(scenes).toEqual(["Replay", "Game"]);
  }, 30000);

  it("goes straight back to live when a CT walks back within reach of a defuse; the round's break comes when it ends", async () => {
    e.autoReplay.setSettings({ earlyMaxSec: 10, perBreak: 3 });
    clipMs = 3000;
    // The CT at B has a kit: 3,106 u (12.4 s) and 5 s to defuse, more than the fuse.
    const round = await startRound(6, afterPlant(B_SITE, true));
    add(round, "first");
    add(round, "second");
    fresh();
    plant(11.5);
    await waitFor(() => e.program.mode === "REPLAY_PLAYING", 8000);
    // Never with more than 10 s on the fuse (the hard ceiling).
    expect(game.plantEndsAt! - Date.now()).toBeLessThanOrEqual(10_000);
    expect(played).toEqual(["first"]);
    // The CT turns up 892 u from the bomb, kit in hand: a ninja defuse is still on.
    game.players = afterPlant(NINJA, true);
    await waitFor(() => e.program.mode === "LIVE", 3000);
    expect(e.session.state()!.roundPhase).toBe("live");
    expect(scenes).toEqual(["Replay", "Game"]);
    await waitFor(() => e.autoReplay.getStatus().early?.state === "back");
    expect(e.autoReplay.getStatus().early).toEqual({ state: "back", detail: "Back to live: a CT can still defuse." });
    const back = audit("replay.auto_early_back")[0]!.detail as Record<string, unknown>;
    expect(back).toMatchObject({ round, why: "defuse", played: 1 });
    expect(back.words).toMatch(/^a CT can still defuse \(CT6: 900 u from the bomb, kit; fuse 0:0\d\)$/);
    expect(played).toEqual(["first"]);
    // The round ends (the CT didn't make it): the break after it plays the clip left, as a break does.
    game.players = afterPlant(NINJA, true);
    await waitFor(() => Date.now() >= game.plantEndsAt!, 12000);
    endRound();
    await waitFor(() => e.autoReplay.getStatus().detail.startsWith("Replays for this break are done"), 15000);
    expect(played).toEqual(["first", "second"]);
    expect(scenes).toEqual(["Replay", "Game", "Replay", "Game"]);
  }, 40000);

  it("rendered: the ready clips as one file, and a clip that came in late after it, through the scenes, without going back to live in between", async () => {
    // ffmpeg as found on the owner's PC; a stand-in renderer (the file's layout as render.ts makes it).
    e.ffmpeg.locate = async () => "ffmpeg";
    e.ffmpeg.pickEncoder = async () => "h264_nvenc";
    const requests: RenderRequest[] = [];
    e.autoReplay.renderer = (req): RenderJob => {
      requests.push(req);
      const layout = breakLayout(req.clips.map((c) => c.durationMs), req.fadeMs, req.audioFadeMs);
      writeFileSync(req.outFile, Buffer.alloc(64));
      return { done: Promise.resolve({ file: req.outFile, layout, ms: 50, width: 1920, height: 1072, fps: 29.97, encoder: req.encoder, bytes: 64 }), progress: () => 1, cancel: () => undefined };
    };
    e.autoReplay.setSettings({ playback: "rendered", earlyMaxSec: 8, slowMotion: "off", multiAngle: "off" });
    clipMs = 9000;
    const round = await startRound(10, afterPlant(B_SITE, false));
    add(round, "ready");
    fresh();
    plant(9.5);
    await waitFor(() => e.program.mode === "REPLAY_PLAYING", 8000);
    expect(game.plantEndsAt! - Date.now()).toBeLessThanOrEqual(8000);
    add(round, "came late");
    await waitFor(() => played.includes("came late"), 8000);
    await waitFor(() => e.program.mode === "LIVE", 8000);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.clips).toHaveLength(1);
    expect(e.autoReplay.getStatus().render).toMatchObject({ kind: "break", clips: 1, rendered: true });
    expect(played).toEqual(["ready", "came late"]);
    // One cut in and one out: the late clip came straight after the file.
    expect(scenes).toEqual(["Replay", "Game"]);
    endRound();
    await sleep(600);
    e.autoReplay.setSettings({ playback: "scenes" });
  }, 30000);

  it("vMix behaves the same: replays start early, and a kill sends the program straight back to the live input", async () => {
    const inputs: { key: string; number: number; type: string; title: string; state: string; position: number; duration: number; started: number | null }[] = [{ key: "live-key", number: 1, type: "Capture", title: "CS2", state: "Running", position: 0, duration: 0, started: null }];
    let active = 1;
    const calls: string[] = [];
    const server = createHttpServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://vmix");
      const now = Date.now();
      for (const i of inputs) if (i.started !== null && i.state === "Running" && i.duration) {
        i.position = Math.min(i.duration, i.position + (now - i.started));
        i.started = now;
        if (i.position >= i.duration) i.state = "Completed";
      }
      const fn = url.searchParams.get("Function");
      if (fn) {
        const input = inputs.find((i) => i.key === url.searchParams.get("Input"));
        const value = url.searchParams.get("Value") ?? "";
        calls.push(`${fn}${input ? ` ${input.key === "live-key" ? "live" : input.key}` : ""}`);
        if (fn === "AddInput") inputs.push({ key: `k${inputs.length + 1}`, number: inputs.length + 1, type: "Video", title: value.split(/[\\/]/).pop()!, state: "Paused", position: 0, duration: 9000, started: null });
        if (fn === "SetPosition" && input) input.position = Number(value);
        if (fn === "Play" && input) Object.assign(input, { state: "Running", started: now });
        if ((fn === "CutDirect" || fn === "Fade") && input) active = input.number;
        if (fn === "RemoveInput" && input) inputs.splice(inputs.indexOf(input), 1);
        res.end("Function completed successfully.");
        return;
      }
      const xml = inputs.map((i) => `<input key="${i.key}" number="${i.number}" type="${i.type}" title="${i.title}" state="${i.state}" position="${Math.round(i.position)}" duration="${i.duration}">${i.title}</input>`).join("");
      res.writeHead(200, { "content-type": "text/xml" }).end(`<vmix><version>27.0.0.49</version><inputs>${xml}</inputs><active>${active}</active><preview>1</preview></vmix>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      e.autoReplay.setSettings({ mixer: "vmix", vmixUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, vmixTransition: "CutDirect", vmixTransitionOut: null, earlyMaxSec: 8 });
      await e.autoReplay.checkVmix();
      const round = await startRound(8, afterPlant(B_SITE, false));
      add(round, "vmix one");
      add(round, "vmix two");
      fresh();
      plant(10);
      await waitFor(() => calls.includes("CutDirect k2"), 8000);
      expect(e.session.state()!.roundPhase).toBe("live");
      expect(game.plantEndsAt! - Date.now()).toBeLessThanOrEqual(8000);
      // A T on the bomb goes down: the round wasn't decided after all.
      game.players = [dead(afterPlant(B_SITE, false)[0]!), ...afterPlant(B_SITE, false).slice(1)];
      await waitFor(() => calls.includes("CutDirect live"), 3000);
      expect(e.session.state()!.roundPhase).toBe("live");
      expect(active).toBe(1);
      await waitFor(() => e.autoReplay.getStatus().early?.state === "back");
      expect(e.autoReplay.getStatus().early!.detail).toBe("Back to live: a kill.");
      expect(audit("replay.auto_early_back")[0]!.detail).toMatchObject({ round, why: "kill" });
      expect(played).toEqual(["vmix one"]);
      // OBS's program wasn't touched.
      expect(scenes).toEqual([]);
    } finally {
      endRound();
      await sleep(500);
      e.autoReplay.setSettings({ enabled: false, mixer: "obs" });
      server.close();
    }
  }, 30000);
});
