import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HudKillfeedEntry } from "@matchframe/hud-sdk";
import type { ClipRecord, ReplayPlay } from "@matchframe/replay-agent";
import { buildSyntheticGsiPayload, syntheticRoster } from "../../../packages/cs2-state/src/testing/gsi-builder.ts";
import { Engine } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { readArchive } from "../src/hud/packages.ts";
import { GRAPHIC_SOURCE, sideInRound } from "../src/replay/graphic.ts";
import { startServers } from "../src/servers.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

const waitFor = async (fn: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

/**
 * The replay graphic: while a replay clip is on air, HUD state carries who made the play and what it
 * was (the clip on program, the next one of a break's replays, the automatic replays' clip in vMix),
 * with the player's team and the side they had in that round; nothing once the replays end or with
 * the graphic turned off. Each Matchframe HUD's own `replay` page shows it; an LHM HUD gets the
 * built-in one; one click puts it on top of OBS's replay scene.
 */
describe("Replay graphic", () => {
  let e: Engine;
  let servers: Awaited<ReturnType<typeof startServers>>;
  let api: string;
  let overlay: string;
  let gsiPort: number;
  let ts = 1_700_000_000;
  const roster = syntheticRoster();
  const [T1, T2] = roster.filter((p) => p.side === "T");
  const [CT6] = roster.filter((p) => p.side === "CT");
  const dir = mkdtempSync(join(tmpdir(), "mf-graphic-"));
  const file = join(dir, "clip.mp4");
  const scenes: string[] = [];
  let auth: Record<string, string>;

  const feed = async (round: number, phase: "live" | "over" = "live") => {
    const payload = buildSyntheticGsiPayload({ mapName: "de_dust2", round: round - 1, players: roster, observed: roster[0]!.steamId, roundPhase: phase, phase, phaseEndsIn: 40, token: e.secrets.gsiToken, timestamp: ts++, ctName: "Northern Lights", tName: "Red Harbour" });
    expect((await fetch(`http://127.0.0.1:${gsiPort}/gsi`, { method: "POST", body: JSON.stringify(payload) })).status).toBe(200);
  };
  const clip = (round: number): ClipRecord => ({ clipId: `c${Math.random()}`, providerId: "replay-pc", sourceId: "replay-pc", angle: "recorded_angle", matchTimeFromMs: null, matchTimeToMs: null, timeUncertaintyMs: null, epoch: null, roundNumber: round, media: { path: file, durationMs: 6000, frameRate: 60, timebase: null, startPts: null, hasAudio: false, width: 1920, height: 1080 }, createdAt: new Date().toISOString() });
  const add = (round: number, play: ReplayPlay, reason: string = play.kind, label = "clip") => e.replays.addExternal(label, reason, round, clip(round), { playMs: 4000, leadMs: 2000, play });
  const kill = (round: number, killer: typeof T1, victim: string, side: "CT" | "T"): void => {
    const k: HudKillfeedEntry = { id: `k${Math.random()}`, kind: "probable", killer: { steamId: killer!.steamId, name: killer!.name, side }, victim: { steamId: "x", name: victim, side: side === "T" ? "CT" : "T" }, weapon: "weapon_ak47", headshot: true, assister: null, attackerBlind: false, atMs: 0 };
    const at = e.session.state()!.roundNumber;
    Object.assign(e.session.state()!, { roundNumber: round });
    e.highlights.noteKill(k);
    Object.assign(e.session.state()!, { roundNumber: at });
  };
  const onAir = (variant = "replay", hud = "matchframe.vector") => e.hudState(`hud:${hud}`, variant)!.replay;

  beforeAll(async () => {
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    writeFileSync(file, Buffer.alloc(1024));
    // The Vector HUD as the program bundles it (its manifest, a stand-in page), and an LHM-format HUD.
    const vector = join(dir, "vector");
    mkdirSync(vector);
    copyFileSync(join(repo, "apps", "hud-designs", "package-files", "vector", "manifest.json"), join(vector, "manifest.json"));
    copyFileSync(join(repo, "apps", "hud-designs", "package-files", "vector", "thumbnail.webp"), join(vector, "thumbnail.webp"));
    writeFileSync(join(vector, "index.html"), "<!doctype html><title>Vector</title>");
    const renderer = join(dir, "renderer");
    mkdirSync(renderer);
    writeFileSync(join(renderer, "index.html"), "<!doctype html><title>renderer</title>");
    const ports = { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
    gsiPort = ports.gsi;
    api = `http://127.0.0.1:${ports.api}`;
    overlay = `http://127.0.0.1:${ports.overlay}`;
    e = new Engine(loadConfig({ dataDir: mkdtempSync(join(tmpdir(), "mf-graphic-data-")), gsiPort: ports.gsi, apiPort: ports.api, overlayPort: ports.overlay, host: "127.0.0.1", captainUiDir: null, hudRendererDir: renderer, mapPackDir: null, workersDir: null, pythonPath: null, sampleHudsDirs: [vector], cloudEnforcement: "off" }));
    await e.init();
    servers = await startServers(e);
    auth = { authorization: `Bearer ${e.secrets.operatorToken}`, "content-type": "application/json" };
    e.hudLibrary.importFiles(
      readArchive(
        zipSync({
          "KaiHUD/hud.json": strToU8(JSON.stringify({ name: "KaiHUD", version: "1.0.0", author: "someone", game: "cs2" })),
          "KaiHUD/index.html": strToU8("<!doctype html><title>kai</title>"),
        }),
      ),
    );
    Object.assign(e.obs.state, { connected: true, scenes: ["Game", "Matchframe Replay"], inputs: [] });
    e.obs.setProgram = async (scene: string) => {
      scenes.push(scene);
      return { confirmed: true, programScene: scene };
    };
    e.program.setScenes({ LIVE: "Game", REPLAY: "Matchframe Replay", STUDIO: null, BREAK: null });
    await feed(15);
  });

  afterAll(async () => {
    await servers?.close();
    await e?.shutdown();
  });

  it("carries the clip on air: player, team, side in that round, weapon, headshot, victims, 3K, round", async () => {
    // Round 4: the player was on T (the kill seen then), though the teams have swapped since.
    kill(4, T1, "CT-Player-6", "T");
    const it3k = add(4, { kind: "missed", killer: { steamId: T1!.steamId, name: T1!.name }, victims: ["CT-Player-6", "CT-Player-7", "CT-Player-8"], kills: 3, weapon: "ak47", headshot: true }, "missed", "3K: T-Player-1");
    expect(onAir().clip).toBeNull();
    await e.program.request("REPLAY_PREPARED", "operator", "test", { replayItemId: it3k.id });
    // Being prepared (still the live scene on program) isn't on air.
    expect(onAir().clip).toBeNull();
    await e.program.request("REPLAY_PLAYING", "operator", "test", { replayItemId: it3k.id });
    const r = onAir();
    expect(r.active).toBe(true);
    expect(r.clip).toEqual({
      id: it3k.id,
      roundNumber: 4,
      label: "3K: T-Player-1",
      player: { steamId: T1!.steamId, name: T1!.name },
      // CT took the left at the start, and teams keep their place on screen.
      team: { key: "right", name: "Red Harbour", shortName: expect.any(String), logoUrl: null, color: null },
      side: "T",
      weapon: { name: "weapon_ak47", displayName: "AK-47" },
      headshot: true,
      victims: ["CT-Player-6", "CT-Player-7", "CT-Player-8"],
      kills: 3,
      multiKill: "3K",
      clutchVersus: null,
    });
    // Every output gets it in its state; only the replay pages draw it.
    expect(onAir("live").clip?.id).toBe(it3k.id);
    expect(onAir("replay", "matchframe-default").clip?.id).toBe(it3k.id);
  });

  it("follows a break's replays clip by clip, and is gone when they end", async () => {
    // A won clutch: the opponents, not the kills. No kill of it was seen: the side now, moved to that round.
    const clutch = add(14, { kind: "big_play", killer: { steamId: CT6!.steamId, name: CT6!.name }, victims: [], kills: 3, weapon: null, headshot: false }, "clutch", `Clutch 1v3: ${CT6!.name}`);
    await e.program.request("REPLAY_PLAYING", "operator", "test", { replayItemId: clutch.id });
    expect(onAir().clip).toMatchObject({ id: clutch.id, clutchVersus: 3, kills: null, multiKill: null, victims: [], side: "CT", team: { key: "left", name: "Northern Lights" } });
    const ace = add(14, { kind: "shown", killer: { steamId: T2!.steamId, name: T2!.name }, victims: ["a", "b", "c", "d", "e"], kills: 5, weapon: "weapon_awp", headshot: false });
    await e.program.request("REPLAY_PLAYING", "operator", "test", { replayItemId: ace.id });
    expect(onAir().clip).toMatchObject({ id: ace.id, multiKill: "ACE", kills: 5, weapon: { displayName: "AWP" }, side: "T" });
    await e.program.request("LIVE", "operator", "test");
    expect(onAir()).toMatchObject({ active: false, clip: null });
  });

  it("works out the side of an earlier round from the side now", () => {
    expect(sideInRound("CT", 15, 15)).toBe("CT");
    expect(sideInRound("CT", 15, 13)).toBe("CT");
    expect(sideInRound("CT", 15, 12)).toBe("T");
    expect(sideInRound("T", 3, 1, 24)).toBe("T");
    expect(sideInRound("T", 20, 30, 24)).toBeNull();
    // Overtime: halves of three rounds; across them, or from regulation, it isn't known.
    expect(sideInRound("T", 27, 25, 24)).toBe("T");
    expect(sideInRound("T", 28, 30, 24)).toBe("T");
    expect(sideInRound("T", 28, 26, 24)).toBeNull();
    expect(sideInRound("CT", 10, 8, 30)).toBe("CT");
    expect(sideInRound("CT", 16, 8, 30)).toBe("T");
  });

  it("shows automatic replays' clip when they play in vMix, and nothing with the graphic off", async () => {
    const it1 = add(15, { kind: "shown", killer: { steamId: T2!.steamId, name: T2!.name }, victims: ["v"], kills: 1, weapon: "deagle", headshot: true });
    const real = { settings: e.autoReplay.settings.bind(e.autoReplay), getStatus: e.autoReplay.getStatus.bind(e.autoReplay) };
    Object.assign(e.autoReplay, {
      settings: () => ({ ...real.settings(), mixer: "vmix" }),
      getStatus: () => ({ ...real.getStatus(), state: "playing", playing: { id: it1.id, label: it1.label } }),
    });
    try {
      await waitFor(() => onAir().clip?.id === it1.id);
      expect(onAir().clip).toMatchObject({ kills: 1, multiKill: null, headshot: true, weapon: { displayName: "Desert Eagle" } });
      e.replayGraphic.setSettings({ enabled: false });
      expect(onAir().clip).toBeNull();
      e.replayGraphic.setSettings({ enabled: true });
      expect(onAir().clip?.id).toBe(it1.id);
    } finally {
      Object.assign(e.autoReplay, real);
    }
    await waitFor(() => onAir().clip === null);
  });

  it("gives each HUD its replay page: the HUD's own, the built-in one for an LHM HUD", async () => {
    const get = async () => (await (await fetch(`${api}/api/v1/replay-graphic`, { headers: auth })).json()) as { output: { hudId: string; style: string; url: string; forHudId: string }; settings: { hudId: string } };
    const lib = e.hudLibrary.list().huds;
    const vector = lib.find((h) => h.id === "matchframe.vector")!;
    const builtin = lib.find((h) => h.id === "matchframe-default")!;
    const kai = lib.find((h) => h.runtime === "lhm")!;
    expect(vector.variants).toContain("replay");
    expect(vector.urls.replay).toMatch(/\/hud\/matchframe\.vector\/replay\?t=[0-9a-f]+$/);
    // Automatic: the HUD last started (in OBS, or the desktop) — Vector here.
    e.hudLibrary.start("matchframe.vector");
    let g = await get();
    expect(g.output).toMatchObject({ hudId: "matchframe.vector", forHudId: "matchframe.vector", style: "own", url: vector.urls.replay });
    // Its page is the HUD's own entry page on the replay variant.
    const page = await (await fetch(g.output.url.replace(/^http:\/\/127\.0\.0\.1:\d+/, overlay))).text();
    expect(page).toContain("variant=replay");
    expect(page).toContain("/huds/matchframe.vector/index.html");
    // kaiHUD has none: the built-in Broadcast HUD's.
    const put = await fetch(`${api}/api/v1/replay-graphic`, { method: "PUT", headers: auth, body: JSON.stringify({ hudId: kai.id }) });
    g = (await put.json()) as typeof g;
    expect(g.output).toMatchObject({ hudId: "matchframe-default", forHudId: kai.id, style: "builtin", url: builtin.urls.replay });
    expect(g.output.url).toMatch(/\/hud\/matchframe-default\/replay\?t=/);
  });

  it("puts the replay page on top of OBS's replay scene", async () => {
    const calls: unknown[] = [];
    e.obs.provisionBrowserSource = async (opts) => {
      calls.push(opts);
      return { createdScene: false, createdInput: true, updatedUrl: false };
    };
    e.obs.sceneItems = async (sceneName: string) => [
      { sceneName, sourceName: "Matchframe Replay Clip", sceneItemId: 1, enabled: true, inputKind: "ffmpeg_source" },
      { sceneName, sourceName: GRAPHIC_SOURCE, sceneItemId: 2, enabled: true, inputKind: "browser_source" },
    ];
    const res = await fetch(`${api}/api/v1/replay-graphic/obs`, { method: "POST", headers: auth, body: "{}" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scene: string; source: string; created: boolean; onTop: boolean; output: { url: string } };
    expect(body).toMatchObject({ scene: "Matchframe Replay", source: GRAPHIC_SOURCE, created: true, onTop: true });
    expect(calls).toEqual([{ sceneName: "Matchframe Replay", sourceName: GRAPHIC_SOURCE, url: body.output.url, width: 1920, height: 1080 }]);
    // Without a mapped replay scene it says what to do.
    e.program.setScenes({ LIVE: "Game", REPLAY: null, STUDIO: null, BREAK: null });
    const none = await fetch(`${api}/api/v1/replay-graphic/obs`, { method: "POST", headers: auth, body: "{}" });
    expect(none.status).toBe(409);
    expect(((await none.json()) as { code?: string; error?: string }).error).toBeDefined();
    e.program.setScenes({ LIVE: "Game", REPLAY: "Matchframe Replay", STUDIO: null, BREAK: null });
  });
});
