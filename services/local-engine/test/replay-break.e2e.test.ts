import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClipRecord, ReplayPlay } from "@matchframe/replay-agent";
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
 * The main PC's replay break with a round's worth of clips: the best ones play, best first, up to
 * the clips per break; a clip with the same kills as a better one doesn't; the first replay waits
 * while the replay PC still has kills of the round to send.
 */
describe("Replay break: the best clips of the round, best first", () => {
  let e: Engine;
  let servers: Awaited<ReturnType<typeof startServers>>;
  let gsiPort: number;
  let ts = 1_700_000_000;
  const played: string[] = [];
  let reads = 0;
  const roster = syntheticRoster();
  const file = join(mkdtempSync(join(tmpdir(), "mf-break-")), "clip.mp4");

  const feed = async (roundPhase: "live" | "over", round: number) => {
    const payload = buildSyntheticGsiPayload({ mapName: "de_dust2", round, players: roster, observed: roster[0]!.steamId, roundPhase, phase: roundPhase, phaseEndsIn: roundPhase === "live" ? 60 : 7, token: e.secrets.gsiToken, timestamp: ts++ });
    expect((await fetch(`http://127.0.0.1:${gsiPort}/gsi`, { method: "POST", body: JSON.stringify(payload) })).status).toBe(200);
    // The automatic replays look at the game every 200 ms.
    await new Promise((r) => setTimeout(r, 300));
  };
  const clip = (round: number): ClipRecord => ({ clipId: `c${Math.random()}`, providerId: "replay-pc", sourceId: "replay-pc", angle: "recorded_angle", matchTimeFromMs: null, matchTimeToMs: null, timeUncertaintyMs: null, epoch: null, roundNumber: round, media: { path: file, durationMs: 9000, frameRate: 60, timebase: null, startPts: null, hasAudio: false, width: 1920, height: 1080 }, createdAt: new Date().toISOString() });
  const add = (round: number, label: string, p: Partial<ReplayPlay>, origin: "replay_pc" | "main" = "replay_pc") => {
    const play: ReplayPlay = { kind: "shown", killer: { steamId: "k1", name: "haze" }, victims: [label], kills: 1, weapon: "ak47", headshot: false, ...p };
    const it = origin === "replay_pc" ? e.replays.addExternal(label, play.kind, round, clip(round), { playMs: 4000, leadMs: 2500, play }) : e.replays.bookmark(label, play.kind, round, { playMs: 4000, play });
    if (origin === "main") Object.assign(it, { state: "prepared", clip: clip(round) });
    return it;
  };

  beforeAll(async () => {
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    writeFileSync(file, Buffer.alloc(1024));
    const ports = { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
    gsiPort = ports.gsi;
    e = new Engine(loadConfig({ dataDir: mkdtempSync(join(tmpdir(), "mf-break-data-")), gsiPort: ports.gsi, apiPort: ports.api, overlayPort: ports.overlay, host: "127.0.0.1", captainUiDir: null, hudRendererDir: null, mapPackDir: null, workersDir: null, pythonPath: null, sampleHudsDirs: [], cloudEnforcement: "off" }));
    await e.init();
    servers = await startServers(e);
    // Stand-in OBS: each clip "plays" for three status reads.
    Object.assign(e.obs.state, { connected: true });
    e.obs.setProgram = async (scene: string) => ({ confirmed: true, programScene: scene });
    e.obs.setMediaFile = async () => {
      reads = 0;
    };
    e.obs.mediaAction = async () => undefined;
    e.obs.setMediaCursor = async () => undefined;
    e.obs.mediaStatus = async () => ({ state: ++reads <= 3 ? "OBS_MEDIA_STATE_PLAYING" : "OBS_MEDIA_STATE_ENDED", durationMs: 9000, cursorMs: 0 });
    e.settings.set("program.scenes", { LIVE: "Game", REPLAY: "Replay", STUDIO: null, BREAK: null });
    e.program.setScenes({ LIVE: "Game", REPLAY: "Replay", STUDIO: null, BREAK: null });
    e.settings.set("replay.mediaInput", "Replay Clip");
    const markPlaying = e.replays.markPlaying.bind(e.replays);
    e.replays.markPlaying = (id: string) => {
      played.push(e.replays.get(id)!.label);
      return markPlaying(id);
    };
  });

  afterAll(async () => {
    await servers?.close();
    await e?.shutdown();
  });

  it("plays the best three of six, best first, and not a clip with the same kills as a better one", async () => {
    e.autoReplay.setSettings({ enabled: true, startDelayMs: 0, perBreak: 3 });
    await feed("live", 7);
    const round = e.session.state()!.roundNumber!;
    add(round, "single shown", {});
    add(round, "single missed", { kind: "missed", killer: { steamId: "k2", name: "kite" } });
    add(round, "3K missed", { kind: "missed", kills: 3, victims: ["a", "b", "c"], killer: { steamId: "k3", name: "saber" } });
    add(round, "knife", { weapon: "knife", killer: { steamId: "k4", name: "nova" } });
    // This computer's own 3K of the same kills: the replay PC's (missed live) is better.
    add(round, "3K own", { kind: "big_play", kills: 3, victims: ["a", "b", "c"], killer: { steamId: "k3", name: "saber" } }, "main");
    add(round, "other angle", { kind: "other_angle", killer: { steamId: "k5", name: "flux" } });
    await feed("over", 7);
    await waitFor(() => played.length >= 3 && e.autoReplay.getStatus().state !== "playing");
    await new Promise((r) => setTimeout(r, 600));
    expect(played).toEqual(["3K missed", "knife", "single missed"]);
    const st = e.autoReplay.getStatus();
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

  it("plays them through vMix: the clip as an input, from the part to show, cut to and back, then removed", async () => {
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
        calls.push(`${fn}${input ? ` ${input.key === "live-key" ? "live" : "replay"}` : ""}${fn === "AddInput" ? ` ${value.split("|")[0]}` : fn === "SetPosition" ? ` ${value}` : ""}`);
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
      played.length = 0;
      e.autoReplay.setSettings({ mixer: "vmix", vmixUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, perBreak: 1 });
      await e.autoReplay.checkVmix();
      expect(e.autoReplay.getStatus().vmix).toEqual({ connected: true, version: "27.0.0.49", error: null });
      await feed("live", 9);
      const round = e.session.state()!.roundNumber!;
      add(round, "vmix 2K", { kind: "missed", kills: 2, victims: ["p", "q"], killer: { steamId: "k8", name: "ozzy" } });
      await feed("over", 9);
      await waitFor(() => calls.includes("CutDirect live"));
      await waitFor(() => calls.includes("RemoveInput replay"));
      // The clip is 9 s long in vMix and its last 4 s are the play: it starts at 5 s.
      expect(calls).toEqual(["AddInput Video", "SetPosition replay 5000", "Play replay", "CutDirect replay", "CutDirect live", "RemoveInput replay"]);
      expect(played).toEqual(["vmix 2K"]);
      expect(active).toBe(1);
    } finally {
      e.autoReplay.setSettings({ mixer: "obs", perBreak: 3 });
      server.close();
    }
  }, 30000);

  it("waits for the replay PC's last kills of the round before the first replay", async () => {
    played.length = 0;
    await feed("live", 8);
    const round = e.session.state()!.roundNumber!;
    add(round, "early single", { killer: { steamId: "k6", name: "zeal" } });
    // The replay PC is still filming a kill of this round.
    e.onAir.notePeer([round]);
    const keep = setInterval(() => e.onAir.notePeer([round]), 200);
    await feed("over", 8);
    await new Promise((r) => setTimeout(r, 1200));
    expect(played).toEqual([]);
    expect(e.autoReplay.getStatus().detail).toMatch(/replay PC's last kills/);
    // Its 2K arrives, and it has nothing more to send.
    add(round, "late 2K", { kind: "missed", kills: 2, victims: ["x", "y"], killer: { steamId: "k7", name: "rain" } });
    clearInterval(keep);
    e.onAir.notePeer([]);
    await waitFor(() => played.length >= 1);
    expect(played[0]).toBe("late 2K");
  });
});
