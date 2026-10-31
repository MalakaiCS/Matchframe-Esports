import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReplayPlay } from "@matchframe/replay-agent";
import { Engine } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { transitionUse } from "../src/live/obs-auto.ts";
import { ProgramArbiter, sceneMapOf } from "../src/production/program.ts";
import { halfOf, halfRounds, isHalfStart } from "../src/replay/graphic.ts";
import { isHalftime } from "../src/replay/highlights-air.ts";
import type { KeptClip, KeptKill, KeptMap } from "../src/replay/highlights.ts";

describe("Halves and halftime (MR12, overtime halves of 3 rounds)", () => {
  it("knows each round's half, its rounds, and the first round of each half after the first", () => {
    expect([1, 12, 13, 24, 25, 27, 28, 30, 31].map((r) => halfOf(r))).toEqual(["r1", "r1", "r2", "r2", "ot0", "ot0", "ot1", "ot1", "ot2"]);
    expect(halfRounds(5)).toEqual({ from: 1, to: 12 });
    expect(halfRounds(12)).toEqual({ from: 1, to: 12 });
    expect(halfRounds(16)).toEqual({ from: 13, to: 24 });
    expect(halfRounds(26)).toEqual({ from: 25, to: 27 });
    expect(halfRounds(28)).toEqual({ from: 28, to: 30 });
    expect(halfRounds(8, 16)).toEqual({ from: 1, to: 8 });
    expect([1, 2, 12, 13, 14, 24, 25, 26, 28, 31].filter((r) => isHalfStart(r))).toEqual([13, 25, 28, 31]);
  });

  it("halftime: the game's halftime phase, and around the first round of the second half or an overtime half; not the map's end, warmup or a live round", () => {
    const at = (p: Partial<Parameters<typeof isHalftime>[0]>) => isHalftime({ mapPhase: "live", gamePhase: "freezetime", roundPhase: "freezetime", roundNumber: 5, ...p });
    expect(at({ mapPhase: "intermission", gamePhase: "halftime", roundPhase: "over", roundNumber: 13 })).toBe(true);
    expect(at({ gamePhase: "halftime" })).toBe(true);
    // The freeze time before the second half's first round, and an overtime half's.
    expect(at({ roundNumber: 13 })).toBe(true);
    expect(at({ roundNumber: 25 })).toBe(true);
    expect(at({ roundNumber: 28 })).toBe(true);
    // The end of the first half's last round: the game's round number has moved on to 13.
    expect(at({ gamePhase: "over", roundPhase: "over", roundNumber: 13 })).toBe(true);
    // Other rounds, a live round, the map's end, warmup.
    expect(at({ roundNumber: 5 })).toBe(false);
    expect(at({ roundNumber: 14 })).toBe(false);
    expect(at({ roundNumber: 1 })).toBe(false);
    expect(at({ roundNumber: 13, roundPhase: "live", gamePhase: "live" })).toBe(false);
    expect(at({ mapPhase: "gameover", gamePhase: "gameover", roundPhase: "over", roundNumber: 25 })).toBe(false);
    expect(at({ mapPhase: "warmup", gamePhase: "warmup", roundNumber: 13 })).toBe(false);
    // MR8 (16 rounds of regulation): its second half starts at round 9.
    expect(isHalftime({ mapPhase: "live", gamePhase: "freezetime", roundPhase: "freezetime", roundNumber: 9 }, 16)).toBe(true);
  });
});

describe("The program arbiter with highlights on air: a mode, and where it goes back to", () => {
  const port = () => {
    const shown: string[] = [];
    const moves: string[] = [];
    let current: string | null = "Game";
    return {
      shown,
      moves,
      port: {
        connected: () => true,
        setProgram: async (scene: string, m: { from: string; to: string }) => {
          shown.push(scene);
          moves.push(`${m.from}>${m.to}`);
          current = scene;
          return true;
        },
        shown: () => current,
      },
    };
  };
  const SCENES = { LIVE: "Game", REPLAY: "Replay", STUDIO: "Desk", BREAK: "Break", HIGHLIGHTS: "Highlights" };

  it("goes on air from the live scene and back to it; the clip on air changes without a mixer action", async () => {
    const m = port();
    const p = new ProgramArbiter(m.port, SCENES);
    await p.request("HIGHLIGHTS", "operator", "highlights", { replayItemId: "a" });
    expect([p.mode, p.activeReplay, p.highlightsReturn?.mode, p.highlightsReturn?.scene]).toEqual(["HIGHLIGHTS", "a", "LIVE", "Game"]);
    await p.request("HIGHLIGHTS", "operator", "highlights", { replayItemId: "b" });
    expect(p.activeReplay).toBe("b");
    expect(m.shown).toEqual(["Highlights"]);
    expect(await p.returnFromHighlights("operator", "highlights", { live: false, exists: () => true })).toMatchObject({ from: "HIGHLIGHTS", to: "LIVE" });
    expect([p.mode, p.activeReplay, p.highlightsReturn]).toEqual(["LIVE", null, null]);
    expect(m.moves).toEqual(["LIVE>HIGHLIGHTS", "HIGHLIGHTS>LIVE"]);
  });

  it("from the operator's own scene (MANUAL, followed): back to it, theirs again; to live when a round is live or it is gone", async () => {
    const m = port();
    const p = new ProgramArbiter(m.port, SCENES);
    p.followMixerScene("Analysis");
    await p.request("HIGHLIGHTS", "operator", "highlights", { replayItemId: "a" });
    expect(p.highlightsReturn).toEqual({ mode: "MANUAL", scene: "Analysis", owner: { kind: "operator", holder: "OBS: Analysis" } });
    // Someone else's request can't take it back.
    expect(await p.returnFromHighlights("operator", "auto-replay", { live: false, exists: () => true })).toBeNull();
    await p.returnFromHighlights("operator", "highlights", { live: false, exists: () => true });
    expect([p.mode, p.operatorScene, p.owner]).toEqual(["MANUAL", "Analysis", { kind: "operator", holder: "OBS: Analysis" }]);
    expect(m.shown.at(-1)).toBe("Analysis");
    expect(m.moves.at(-1)).toBe("HIGHLIGHTS>MANUAL");
    // A round went live meanwhile: the live scene.
    await p.request("HIGHLIGHTS", "operator", "highlights", { replayItemId: "a" });
    await p.returnFromHighlights("operator", "highlights", { live: true, exists: () => true });
    expect([p.mode, m.shown.at(-1)]).toEqual(["LIVE", "Game"]);
    // The scene is gone: the live scene.
    p.followMixerScene("Analysis");
    await p.request("HIGHLIGHTS", "operator", "highlights", { replayItemId: "a" });
    await p.returnFromHighlights("operator", "highlights", { live: false, exists: (s) => s !== "Analysis" });
    expect([p.mode, m.shown.at(-1)]).toEqual(["LIVE", "Game"]);
  });

  it("from the studio scene the OBS automation chose: back to it with its owner; from MANUAL without a followed scene, back to what OBS showed", async () => {
    const m = port();
    const p = new ProgramArbiter(m.port, SCENES);
    await p.request("STUDIO", "automation", "obs-automation");
    await p.request("HIGHLIGHTS", "operator", "highlights", { replayItemId: "a" });
    await p.returnFromHighlights("operator", "highlights", { live: false, exists: () => true });
    expect([p.mode, p.owner, m.shown.at(-1)]).toEqual(["STUDIO", { kind: "automation", holder: "obs-automation" }, "Desk"]);
    await p.request("MANUAL", "operator", "op");
    await p.request("HIGHLIGHTS", "operator", "highlights", { replayItemId: "a" });
    expect(p.highlightsReturn).toMatchObject({ mode: "MANUAL", scene: "Desk" });
    await p.returnFromHighlights("operator", "highlights", { live: false, exists: () => true });
    expect([p.mode, p.owner, m.shown.at(-1)]).toEqual(["MANUAL", { kind: "operator", holder: "op" }, "Desk"]);
  });

  it("highlights never start over a replay; the twins count as their scenes; old scene maps get HIGHLIGHTS", async () => {
    const m = port();
    const p = new ProgramArbiter(m.port, { LIVE: "Game", REPLAY: "Replay" });
    expect(p.sceneMap).toEqual({ LIVE: "Game", REPLAY: "Replay", STUDIO: null, BREAK: null, HIGHLIGHTS: null });
    await expect(p.request("HIGHLIGHTS", "operator", "highlights")).rejects.toThrow(/no mixer scene is mapped for HIGHLIGHTS/);
    p.setScenes(SCENES);
    await p.request("REPLAY_PREPARED", "automation", "auto-replay", { replayItemId: "r" });
    await p.request("REPLAY_PLAYING", "automation", "auto-replay", { replayItemId: "r" });
    await expect(p.request("HIGHLIGHTS", "operator", "highlights")).rejects.toThrow(/not allowed/);
    p.setTwin("HIGHLIGHTS", "Highlights B", "Highlights");
    p.setReplayTwin("Replay B", "Replay");
    expect(p.highlightsScenes).toEqual(["Highlights", "Highlights B"]);
    expect(p.replayScenes).toEqual(["Replay", "Replay B"]);
    // The highlights scene is the replay scene: the replay scene's twin serves both.
    p.setScenes({ ...SCENES, HIGHLIGHTS: "Replay" });
    expect(p.highlightsScenes).toEqual(["Replay", "Replay B"]);
    expect(sceneMapOf({ LIVE: "Game", HIGHLIGHTS: "" })).toEqual({ LIVE: "Game", REPLAY: null, STUDIO: null, BREAK: null, HIGHLIGHTS: null });
  });

  it("Highlights in and Highlights out are their own uses of a transition", () => {
    expect(transitionUse({ from: "LIVE", to: "HIGHLIGHTS" })).toBe("highlights-in");
    expect(transitionUse({ from: "MANUAL", to: "HIGHLIGHTS" })).toBe("highlights-in");
    expect(transitionUse({ from: "STUDIO", to: "HIGHLIGHTS" })).toBe("highlights-in");
    expect(transitionUse({ from: "HIGHLIGHTS", to: "MANUAL" })).toBe("highlights-out");
    expect(transitionUse({ from: "HIGHLIGHTS", to: "STUDIO" })).toBe("highlights-out");
    expect(transitionUse({ from: "HIGHLIGHTS", to: "HIGHLIGHTS" })).toBe("none");
    expect(transitionUse({ from: "LIVE", to: "REPLAY_PLAYING" })).toBe("in");
  });
});

/**
 * What Play plays: kept clips (replay/highlights.ts) of this map, its last half or the previous map;
 * the best N by the replay ranking, or every played clip, with unplayed ones when asked; the same
 * kills once; in round order, then by when their play happened.
 */
describe("Highlights on air: the clips chosen", () => {
  let e: Engine;
  const data = mkdtempSync(join(tmpdir(), "mf-hl-choice-"));
  const root = join(data, "kept");
  const T0 = Date.parse("2026-10-31T10:00:00Z");

  const play = (killer: string, victims: string[], kills = victims.length, weapon = "ak47", headshot = false): ReplayPlay => ({ kind: "shown", killer: { steamId: killer, name: killer }, victims, kills, weapon, headshot });
  const clip = (map: string, id: string, round: number | null, p: ReplayPlay, opts: Partial<KeptClip> = {}): KeptClip => {
    const file = `${map}/${id}.mp4`;
    mkdirSync(join(root, map), { recursive: true });
    writeFileSync(join(root, file), Buffer.alloc(16));
    return { id, label: `${p.kills}K ${p.killer?.name}`, reason: p.kind, roundNumber: round, createdAt: new Date(T0 + (round ?? 99) * 120_000).toISOString(), origin: "replay_pc", play: p, played: true, file, root, bytes: 16, playMs: 5000, leadMs: 2000, trim: null, media: { durationMs: 9000, width: 1920, height: 1080, frameRate: 60, hasAudio: true }, team: null, side: null, killAt: T0 + (round ?? 99) * 120_000, ...opts };
  };
  const kill = (round: number, killer: string, victim: string, atSec: number): KeptKill => ({ round, killer, side: "T", victim, at: T0 + round * 120_000 + atSec * 1000 });

  beforeAll(() => {
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    const winners: Record<string, "CT" | "T"> = Object.fromEntries(Array.from({ length: 16 }, (_, k) => [String(k + 1), k % 2 ? "CT" : "T"]));
    const dust: KeptMap = {
      key: "m2",
      mapName: "de_dust2",
      matchId: null,
      title: "Northern Lights vs Red Harbour",
      startedAt: new Date(T0).toISOString(),
      winners,
      kills: [kill(3, "alpha", "v1", 10), kill(3, "bravo", "v2", 5), kill(7, "charlie", "v3", 20), kill(14, "delta", "v4", 30), kill(14, "echo", "v5", 12)],
      clips: [
        clip("m2", "c-r3-alpha", 3, play("alpha", ["v1"])),
        clip("m2", "c-r3-bravo", 3, play("bravo", ["v2", "v6", "v7"])),
        clip("m2", "c-r5-ace", 5, play("foxtrot", ["a", "b", "c", "d", "e"])),
        clip("m2", "c-r5-ace-dup", 5, play("foxtrot", ["a"], 1), { origin: "main" }),
        clip("m2", "c-r7-charlie", 7, play("charlie", ["v3", "v8"])),
        clip("m2", "c-r9-knife", 9, play("golf", ["v9"], 1, "knife")),
        clip("m2", "c-r10-unplayed-4k", 10, play("hotel", ["w", "x", "y", "z"]), { played: false }),
        clip("m2", "c-r14-delta", 14, play("delta", ["v4", "q"])),
        clip("m2", "c-r14-echo", 14, play("echo", ["v5"], 1, "awp", true)),
        clip("m2", "c-r16-india", 16, play("india", ["v10"])),
        clip("m2", "c-none", null, play("juliet", ["v11", "v12"])),
      ],
    };
    const mirage: KeptMap = { key: "m1", mapName: "de_mirage", matchId: null, title: null, startedAt: new Date(T0 - 3_600_000).toISOString(), winners: {}, kills: [], clips: [clip("m1", "p-r2", 2, play("kilo", ["a", "b"])), clip("m1", "p-r9", 9, play("lima", ["c"]))] };
    mkdirSync(join(data, "highlights"), { recursive: true });
    writeFileSync(join(data, "highlights", "index.json"), JSON.stringify({ version: 1, maps: [mirage, dust] }));
    e = new Engine(loadConfig({ dataDir: data, gsiPort: 47391, apiPort: 47392, overlayPort: 47393, host: "127.0.0.1", captainUiDir: null, hudRendererDir: null, mapPackDir: null, workersDir: null, pythonPath: null, sampleHudsDirs: [], cloudEnforcement: "off" }));
  });

  afterAll(async () => {
    await e?.shutdown();
  });

  const ids = () => e.highlightsAir.plan()!.clips.map((c) => c.id);

  it("this map, the best 5 played (by default), in round order, then by when each play happened", () => {
    expect(e.highlightsAir.settings()).toMatchObject({ what: "map", count: 5, unplayed: false, noHalftime: true, autoHalftime: false, autoMapEnd: false });
    // The ace, the 3K, two 2Ks and the knife kill are the best five; the duplicate of the ace's first kill isn't one.
    expect(ids()).toEqual(["c-r3-bravo", "c-r5-ace", "c-r7-charlie", "c-r9-knife", "c-r14-delta"]);
    const plan = e.highlightsAir.plan()!;
    expect(plan).toMatchObject({ mapKey: "m2", mapName: "de_dust2", what: "map", rounds: null });
    // The part replays show (playMs), and the running time less the fades between (automatic replays' 0.5 s).
    expect(plan.clips.every((c) => c.playMs === 5000)).toBe(true);
    expect(plan.totalMs).toBe(5 * 5000 - 4 * 500);
    // In a round by when the play happened: bravo's kill came first in round 3.
    e.highlightsAir.setSettings({ count: 15 });
    expect(ids().slice(0, 2)).toEqual(["c-r3-bravo", "c-r3-alpha"]);
  });

  it("every played clip, or the best N with unplayed ones too; a clip with no round last", () => {
    e.highlightsAir.setSettings({ count: "all", unplayed: true });
    expect(ids()).toEqual(["c-r3-bravo", "c-r3-alpha", "c-r5-ace", "c-r7-charlie", "c-r9-knife", "c-r14-echo", "c-r14-delta", "c-r16-india", "c-none"]);
    e.highlightsAir.setSettings({ count: 8, unplayed: true });
    expect(ids()).toContain("c-r10-unplayed-4k");
    expect(ids()).toHaveLength(8);
    e.highlightsAir.setSettings({ count: 8, unplayed: false });
    expect(ids()).not.toContain("c-r10-unplayed-4k");
  });

  it("the last half of this map: its halves (MR12), from the last round it has", () => {
    e.highlightsAir.setSettings({ what: "half", count: "all", unplayed: false });
    const plan = e.highlightsAir.plan()!;
    expect(plan.rounds).toEqual({ from: 13, to: 24 });
    expect(plan.clips.map((c) => c.id)).toEqual(["c-r14-echo", "c-r14-delta", "c-r16-india"]);
  });

  it("the previous map", () => {
    e.highlightsAir.setSettings({ what: "previous", count: 5 });
    const plan = e.highlightsAir.plan()!;
    expect([plan.mapKey, plan.mapName, plan.clips.map((c) => c.id)]).toEqual(["m1", "de_mirage", ["p-r2", "p-r9"]]);
  });

  it("plays each as a replay list item of its own (not added to the list): its kept file, the part replays show, its play", () => {
    const kept = e.highlights.find("c-r5-ace")!;
    const it = e.highlights.asItem(kept.clip);
    expect(it).toMatchObject({ id: "c-r5-ace", state: "prepared", roundNumber: 5, playMs: 5000, leadMs: 2000, play: { killer: { steamId: "foxtrot" }, kills: 5 } });
    expect(it.clip!.media.path).toBe(join(root, "m2", "c-r5-ace.mp4"));
    expect(e.replays.get("c-r5-ace")).toBeUndefined();
  });
});
