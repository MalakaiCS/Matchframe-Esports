import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClipRecord, ReplayPlay } from "@matchframe/replay-agent";
import type { SyntheticPlayer } from "../../../packages/cs2-state/src/testing/gsi-builder.ts";
import { buildSyntheticGsiPayload, syntheticRoster } from "../../../packages/cs2-state/src/testing/gsi-builder.ts";
import { Engine } from "../src/app.ts";
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

const waitFor = async (fn: () => boolean, ms = 15000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

/**
 * The main PC's replay break with a round's worth of clips: the best ones that fit are chosen, up to
 * the clips per break, and play back to back, in round order (or best first), with one cut to the
 * replay scene and one back to live; a clip with the same kills as a better one doesn't play; the
 * break's replays wait while the replay PC still has kills of the round to send; a clip OBS can't
 * play is skipped; the round going live, or the operator taking the program, stops them.
 */
describe("Replay break: the round's best clips, back to back", () => {
  let e: Engine;
  let servers: Awaited<ReturnType<typeof startServers>>;
  let gsiPort: number;
  let ts = 1_700_000_000;
  const played: string[] = [];
  /** The status line each time a clip started. */
  const details: string[] = [];
  /** OBS program scene changes. */
  const scenes: string[] = [];
  /** Stand-in OBS: a loaded clip plays for this long (unless paused), then it has ended. */
  let clipMs = 300;
  let loaded = "";
  let elapsed = 0;
  let playingSince: number | null = null;
  /** Where the clip is: where it was last put, plus how long it has played since. */
  let cursor = { at: 0, played: 0 };
  const playedMs = () => elapsed + (playingSince === null ? 0 : Date.now() - playingSince);
  const roster = syntheticRoster();
  const [, T2, T3, T4] = roster.filter((p) => p.side === "T");
  const [CT6, CT7, CT8, CT9] = roster.filter((p) => p.side === "CT");
  const dir = mkdtempSync(join(tmpdir(), "mf-break-"));
  const file = join(dir, "clip.mp4");
  /** A clip OBS can't play (it reports an error). */
  const broken = join(dir, "broken.mp4");
  /** Kills so far in the match (the game's counters), and who is dead this round. */
  const kills = new Map<string, number>();
  const dead = new Set<string>();

  const feed = async (roundPhase: "live" | "over", round: number) => {
    const players = roster.map((p) => ({ ...p, kills: kills.get(p.steamId) ?? 0, ...(dead.has(p.steamId) ? { health: 0 } : {}) }));
    const payload = buildSyntheticGsiPayload({ mapName: "de_dust2", round, players, observed: roster[0]!.steamId, roundPhase, phase: roundPhase, phaseEndsIn: roundPhase === "live" ? 60 : 7, token: e.secrets.gsiToken, timestamp: ts++ });
    expect((await fetch(`http://127.0.0.1:${gsiPort}/gsi`, { method: "POST", body: JSON.stringify(payload) })).status).toBe(200);
    // The automatic replays look at the game every 200 ms.
    await new Promise((r) => setTimeout(r, 300));
  };
  const startRound = async (round: number) => {
    dead.clear();
    await feed("live", round);
    return e.session.state()!.roundNumber!;
  };
  /** A kill the main PC sees in its game data. */
  const kill = async (round: number, killer: SyntheticPlayer, victim: SyntheticPlayer) => {
    kills.set(killer.steamId, (kills.get(killer.steamId) ?? 0) + 1);
    dead.add(victim.steamId);
    await feed("live", round);
  };
  const clip = (round: number, path: string): ClipRecord => ({ clipId: `c${Math.random()}`, providerId: "replay-pc", sourceId: "replay-pc", angle: "recorded_angle", matchTimeFromMs: null, matchTimeToMs: null, timeUncertaintyMs: null, epoch: null, roundNumber: round, media: { path, durationMs: 9000, frameRate: 60, timebase: null, startPts: null, hasAudio: false, width: 1920, height: 1080 }, createdAt: new Date().toISOString() });
  const add = (round: number, label: string, p: Partial<ReplayPlay>, origin: "replay_pc" | "main" = "replay_pc", opts: { playMs?: number; path?: string } = {}) => {
    const play: ReplayPlay = { kind: "shown", killer: { steamId: "k1", name: "haze" }, victims: [label], kills: 1, weapon: "ak47", headshot: false, ...p };
    const playMs = opts.playMs ?? 4000;
    const c = clip(round, opts.path ?? file);
    const it = origin === "replay_pc" ? e.replays.addExternal(label, play.kind, round, c, { playMs, leadMs: playMs - 1500, play }) : e.replays.bookmark(label, play.kind, round, { playMs, play });
    if (origin === "main") Object.assign(it, { state: "prepared", clip: c });
    return it;
  };
  const by = (p: SyntheticPlayer) => ({ steamId: p.steamId, name: p.name });
  const breakDone = () => e.autoReplay.getStatus().detail.startsWith("Replays for this break are done");
  const fresh = () => {
    played.length = 0;
    details.length = 0;
    scenes.length = 0;
  };

  beforeAll(async () => {
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    writeFileSync(file, Buffer.alloc(1024));
    writeFileSync(broken, Buffer.alloc(1024));
    const ports = { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
    gsiPort = ports.gsi;
    e = new Engine(loadConfig({ dataDir: mkdtempSync(join(tmpdir(), "mf-break-data-")), gsiPort: ports.gsi, apiPort: ports.api, overlayPort: ports.overlay, host: "127.0.0.1", captainUiDir: null, hudRendererDir: null, mapPackDir: null, workersDir: null, pythonPath: null, sampleHudsDirs: [], cloudEnforcement: "off" }));
    await e.init();
    servers = await startServers(e);
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
      const state = loaded === broken ? "ERROR" : playingSince === null ? "PAUSED" : playedMs() < clipMs ? "PLAYING" : "ENDED";
      return { state: `OBS_MEDIA_STATE_${state}`, durationMs: 9000, cursorMs: Math.min(9000, cursor.at + playedMs() - cursor.played) };
    };
    e.settings.set("program.scenes", { LIVE: "Game", REPLAY: "Replay", STUDIO: null, BREAK: null });
    e.program.setScenes({ LIVE: "Game", REPLAY: "Replay", STUDIO: null, BREAK: null });
    e.settings.set("replay.mediaInput", "Replay Clip");
    const markPlaying = e.replays.markPlaying.bind(e.replays);
    e.replays.markPlaying = (id: string) => {
      played.push(e.replays.get(id)!.label);
      details.push(e.autoReplay.getStatus().detail);
      return markPlaying(id);
    };
  });

  afterAll(async () => {
    await servers?.close();
    await e?.shutdown();
  });

  it("best first: plays the best three of six, best first, back to back, and not a clip with the same kills as a better one", async () => {
    e.autoReplay.setSettings({ enabled: true, startDelayMs: 0, perBreak: 3, order: "best" });
    const round = await startRound(7);
    add(round, "single shown", {});
    add(round, "single missed", { kind: "missed", killer: { steamId: "k2", name: "kite" } });
    add(round, "3K missed", { kind: "missed", kills: 3, victims: ["a", "b", "c"], killer: { steamId: "k3", name: "saber" } });
    add(round, "knife", { weapon: "knife", killer: { steamId: "k4", name: "nova" } });
    // This computer's own 3K of the same kills: the replay PC's (missed live) is better.
    add(round, "3K own", { kind: "big_play", kills: 3, victims: ["a", "b", "c"], killer: { steamId: "k3", name: "saber" } }, "main");
    add(round, "other angle", { kind: "other_angle", killer: { steamId: "k5", name: "flux" } });
    fresh();
    const history = e.program.history.length;
    await feed("over", 7);
    await waitFor(breakDone);
    expect(played).toEqual(["3K missed", "knife", "single missed"]);
    expect(details).toEqual(["Replay 1 of 3: 3K missed", "Replay 2 of 3: knife", "Replay 3 of 3: single missed"]);
    // One cut to the replay scene and one back to live for the three.
    expect(scenes).toEqual(["Replay", "Game"]);
    expect(e.program.history.slice(history).map((t) => t.to)).toEqual(["REPLAY_PREPARED", "REPLAY_PLAYING", "LIVE"]);
    const st = e.autoReplay.getStatus();
    expect(st.detail).toBe("Replays for this break are done (3 played).");
    expect(st.round).toBe(round);
    expect(st.ranked.map((r) => [r.label, r.state])).toEqual([
      ["3K missed", "played"],
      ["3K own", "duplicate"],
      ["knife", "played"],
      ["single missed", "played"],
      ["other angle", "left"],
      ["single shown", "left"],
    ]);
    expect(st.ranked[0]!.reasons).toEqual(["3K", "not seen live"]);
  });

  it("round order: three clips ranked the other way round play from the start of the round to its end, with one cut in and one out", async () => {
    e.autoReplay.setSettings({ order: "round", perBreak: 3 });
    const round = await startRound(10);
    // The main PC sees the round's kills: T2's opening kill, then T3's, then T4's 2K.
    await kill(10, T2!, CT6!);
    await kill(10, T3!, CT7!);
    await kill(10, T4!, CT8!);
    await kill(10, T4!, CT9!);
    // Their clips arrive last first, and rank best first: the 2K, the AWP kill, the opening kill.
    add(round, "2K", { kind: "missed", kills: 2, killer: by(T4!), victims: [CT8!.name, CT9!.name] });
    add(round, "awp", { kind: "missed", weapon: "awp", killer: by(T3!), victims: [CT7!.name] });
    add(round, "opening", { killer: by(T2!), victims: [CT6!.name] });
    fresh();
    const history = e.program.history.length;
    await feed("over", 10);
    await waitFor(breakDone);
    expect(e.autoReplay.getStatus().ranked.map((r) => r.label)).toEqual(["2K", "awp", "opening"]);
    expect(played).toEqual(["opening", "awp", "2K"]);
    expect(details).toEqual(["Replay 1 of 3: opening", "Replay 2 of 3: awp", "Replay 3 of 3: 2K"]);
    expect(scenes).toEqual(["Replay", "Game"]);
    expect(e.program.history.slice(history).map((t) => t.to)).toEqual(["REPLAY_PREPARED", "REPLAY_PLAYING", "LIVE"]);
    expect(e.program.mode).toBe("LIVE");
  });

  it("skips a clip OBS can't play and goes on with the next, still without going live in between", async () => {
    e.autoReplay.setSettings({ order: "best" });
    const round = await startRound(11);
    const a = add(round, "first", { killer: { steamId: "k1", name: "haze" } });
    const b = add(round, "unplayable", { kind: "missed", killer: { steamId: "k2", name: "kite" } }, "replay_pc", { path: broken });
    const c = add(round, "third", { kind: "missed", weapon: "awp", killer: { steamId: "k3", name: "saber" } });
    fresh();
    await feed("over", 11);
    await waitFor(breakDone);
    expect(played).toEqual(["third", "unplayable", "first"]);
    expect([a.state, b.state, c.state]).toEqual(["played", "failed", "played"]);
    expect(scenes).toEqual(["Replay", "Game"]);
    expect(e.autoReplay.getStatus().detail).toBe("Replays for this break are done (2 played, 1 didn't play: OBS did not start the clip (media state OBS_MEDIA_STATE_ERROR)).");
    expect(e.autoReplay.getStatus().ranked.map((r) => r.label)).not.toContain("unplayable");
  });

  it("stops the moment the round goes live and cuts to live", async () => {
    e.autoReplay.setSettings({ order: "round" });
    clipMs = 4000;
    try {
      const round = await startRound(12);
      add(round, "one", { killer: { steamId: "k1", name: "haze" } });
      add(round, "two", { killer: { steamId: "k2", name: "kite" } });
      add(round, "three", { killer: { steamId: "k3", name: "saber" } });
      fresh();
      await feed("over", 12);
      await waitFor(() => played.length === 1);
      expect(scenes).toEqual(["Replay"]);
      await feed("live", 13);
      await waitFor(() => scenes.length === 2);
      expect(scenes).toEqual(["Replay", "Game"]);
      expect(e.program.mode).toBe("LIVE");
      await new Promise((r) => setTimeout(r, 500));
      expect(played).toHaveLength(1);
      // The other two stay for playing by hand.
      expect(e.replays.list().filter((i) => i.roundNumber === round).map((i) => i.state)).toEqual(["played", "prepared", "prepared"]);
    } finally {
      clipMs = 300;
    }
  });

  it("leaves the program alone when the operator takes it during the break's replays", async () => {
    clipMs = 4000;
    try {
      const round = await startRound(14);
      add(round, "one", { killer: { steamId: "k1", name: "haze" } });
      add(round, "two", { killer: { steamId: "k2", name: "kite" } });
      fresh();
      await feed("over", 14);
      await waitFor(() => played.length === 1);
      await e.program.request("MANUAL", "operator", "op");
      await waitFor(() => /isn't live \(manual\)/.test(e.autoReplay.getStatus().detail));
      await new Promise((r) => setTimeout(r, 500));
      expect(played).toHaveLength(1);
      expect(scenes).toEqual(["Replay"]);
      expect(e.program.mode).toBe("MANUAL");
    } finally {
      clipMs = 300;
      await e.program.request("LIVE", "operator", "op");
    }
  });

  it("plays them through vMix: each clip an input from the part to show, the next one added while one plays, one transition in and one back", async () => {
    // A stand-in vMix Web Controller: inputs play in real time.
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
        calls.push(`${fn}${input ? ` ${input.key === "live-key" ? "live" : input.key}` : ""}${fn === "AddInput" ? ` ${value.split("|")[0]}` : fn === "SetPosition" ? ` ${value}` : ""}`);
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
      e.autoReplay.setSettings({ mixer: "vmix", vmixUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, perBreak: 2, vmixTransition: "Fade" });
      await e.autoReplay.checkVmix();
      expect(e.autoReplay.getStatus().vmix).toEqual({ connected: true, version: "27.0.0.49", error: null });
      const round = await startRound(15);
      add(round, "vmix 2K", { kind: "missed", kills: 2, victims: ["p", "q"], killer: { steamId: "k8", name: "ozzy" } }, "replay_pc", { playMs: 2000 });
      add(round, "vmix single", { killer: { steamId: "k9", name: "mik" } }, "replay_pc", { playMs: 2000 });
      fresh();
      await feed("over", 15);
      await waitFor(() => calls.includes("Fade live"));
      await waitFor(() => calls.filter((c) => c.startsWith("RemoveInput")).length === 2);
      // Each clip is 9 s long in vMix and its last 2 s are the play: it starts at 7 s.
      expect(calls).toEqual(["AddInput Video", "SetPosition k2 7000", "Play k2", "Fade k2", "AddInput Video", "SetPosition k3 7000", "Play k3", "CutDirect k3", "Fade live", "RemoveInput k2", "RemoveInput k3"]);
      expect(played).toEqual(["vmix 2K", "vmix single"]);
      expect(details).toEqual(["Replay 1 of 2: vmix 2K", "Replay 2 of 2: vmix single"]);
      expect(active).toBe(1);
      // OBS's program wasn't touched.
      expect(scenes).toEqual([]);
    } finally {
      e.autoReplay.setSettings({ mixer: "obs", perBreak: 3, vmixTransition: "CutDirect" });
      server.close();
    }
  }, 30000);

  it("waits for the replay PC's last kills of the round, then plays them with the rest in round order", async () => {
    e.autoReplay.setSettings({ order: "round", perBreak: 3 });
    fresh();
    const round = await startRound(16);
    add(round, "early single", { killer: { steamId: "k6", name: "zeal" } });
    // The replay PC is still filming a kill of this round.
    e.onAir.notePeer([round]);
    const keep = setInterval(() => e.onAir.notePeer([round]), 200);
    await feed("over", 16);
    await new Promise((r) => setTimeout(r, 1200));
    expect(played).toEqual([]);
    expect(e.autoReplay.getStatus().detail).toMatch(/replay PC's last kills/);
    // Its 2K arrives, and it has nothing more to send. Neither kill was seen here: they go in the order they came in.
    add(round, "late 2K", { kind: "missed", kills: 2, victims: ["x", "y"], killer: { steamId: "k7", name: "rain" } });
    clearInterval(keep);
    e.onAir.notePeer([]);
    await waitFor(breakDone);
    expect(played).toEqual(["early single", "late 2K"]);
    expect(scenes).toEqual(["Replay", "Game"]);
  });
});
