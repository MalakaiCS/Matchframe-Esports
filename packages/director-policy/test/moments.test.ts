import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { OwnershipState } from "@matchframe/contracts";
import { MapPack } from "@matchframe/contracts";
import type { SyntheticPayloadSpec, SyntheticPlayer } from "@matchframe/cs2-state";
import { MapRuntime, VisibilityGrid } from "@matchframe/map-runtime";
import type { ControlStatus, DirectorConfig } from "../src/index.ts";
import { cameraShot, Director, matchMoment, pathShot, ShotPlanner, DEFAULT_DIRECTOR_CONFIG } from "../src/index.ts";
import { capsWithCameraControl, CT, player, Sim, T } from "./helpers.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const armed: OwnershipState = { owner: "director", generation: 2, holder: "director", acquiredAtMonotonicMs: 0, leaseExpiresAtMonotonicMs: null, manualSticky: false, emergencyStopped: false };
const control: ControlStatus = { ownership: armed, adapterAvailable: true, inputFresh: true, pendingCommand: false };
const T_SPAWN = { x: 1230, y: -300, z: -167 };
const CT_SPAWN = { x: -1650, y: -1950, z: -295 };
const around = (c: { x: number; y: number; z: number }, i: number) => ({ x: c.x + (i % 3) * 50, y: c.y + Math.floor(i / 3) * 50, z: c.z });

function players(money: { T?: number; CT?: number } = {}): SyntheticPlayer[] {
  const rich = (side: "T" | "CT") => ({ money: money[side] ?? 4000, equipValue: money[side] === undefined ? 4000 : 0 });
  return [1, 2, 3, 4, 5]
    .map((n, i) => player(T(n), "T", n, around(T_SPAWN, i), { x: -1, y: 0, z: 0 }, rich("T")))
    .concat([6, 7, 8, 9, 0].map((n, i) => player(CT(n), "CT", n, around(CT_SPAWN, i), { x: 1, y: 0, z: 0 }, rich("CT"))));
}

interface Shot {
  at: number;
  id: string;
  durationMs: number | null;
  reasons: string[];
}

/** Mirage with its free-space grid; plays `ms` of one phase and records the cinematic shots. */
function play(opts: { spec: Partial<SyntheticPayloadSpec>; roundPhase: "freezetime" | "over"; phase?: string; ms?: number; money?: { T?: number; CT?: number }; config?: Partial<DirectorConfig["cinematic"]> }) {
  const rt = new MapRuntime(MapPack.parse(JSON.parse(readFileSync(join(root, "assets", "map-packs", "de_mirage.json"), "utf8"))));
  rt.grid = VisibilityGrid.parse(readFileSync(join(root, "assets", "map-packs", "de_mirage.grid")), (b) => inflateSync(b));
  const sim = new Sim("de_mirage", rt);
  const director = new Director({ config: { cinematic: { ...DEFAULT_DIRECTOR_CONFIG.cinematic, ...opts.config } }, newId: (() => { let i = 0; return () => `d${i++}`; })() });
  director.setMode("automatic");
  director.setObserverMode("observer_cinematics");
  director.setMap(rt);
  director.setCapabilities(capsWithCameraControl("supported"));
  let observed: string | null = T(1);
  const shots: Shot[] = [];
  const total = opts.ms ?? 18000;
  for (let t = 0; t < total; t += 100) {
    const state = sim.push(players(opts.money), { mapName: "de_mirage", observed, roundPhase: opts.roundPhase, phase: opts.phase ?? opts.roundPhase, phaseEndsIn: (total - t) / 1000, spec: opts.spec });
    const out = director.evaluate(state, sim.now, control);
    const i = out.intent;
    if (i?.kind === "select_player") observed = i.targetSteamId;
    else if (i?.kind === "activate_static_camera" || i?.kind === "play_camera_path") {
      const key = i.kind === "activate_static_camera" ? cameraShot(i.cameraId!) : pathShot(i.pathId!);
      shots.push({ at: t, id: i.cameraId ?? i.pathId!, durationMs: i.plannedDurationMs, reasons: out.candidates.find((c) => c.shotKey === key)?.reasonCodes ?? [] });
      observed = null;
      director.cinematicStarted(key, sim.now, i.plannedDurationMs ?? 3000, null, false, i.shotClass);
    }
  }
  return shots;
}

const isTeam = (id: string) => id.startsWith("team-");

describe("match moments", () => {
  const state = (spec: Partial<SyntheticPayloadSpec>, roundPhase: "freezetime" | "live" | "over" = "freezetime", phase?: string) => new Sim("de_mirage").push(players(), { mapName: "de_mirage", roundPhase, phase: phase ?? roundPhase, spec });
  const mm = (s: ReturnType<typeof state>) => matchMoment(s, { regulationRounds: 24, overtimeRounds: 6 });

  it("knows the pistol rounds, match point (also in overtime) and the breaks", () => {
    expect(mm(state({ round: 0 })).pistol).toBe(true);
    expect(mm(state({ round: 12, scoreT: 7, scoreCT: 5 })).pistol).toBe(true);
    expect(mm(state({ round: 5, scoreT: 3, scoreCT: 2 })).pistol).toBe(false);
    expect(mm(state({ round: 20, scoreT: 12, scoreCT: 8 })).matchPoint).toEqual(["T"]);
    expect(mm(state({ round: 24, scoreT: 12, scoreCT: 12 })).matchPoint).toEqual([]); // overtime starts
    expect(mm(state({ round: 29, scoreT: 15, scoreCT: 14 })).matchPoint).toEqual(["T"]);
    expect(mm(state({ round: 12, scoreT: 7, scoreCT: 5, mapPhase: "intermission" }, "over")).halfTime).toBe(true);
    expect(mm(state({ round: 21, scoreT: 13, scoreCT: 8, mapPhase: "gameover", winTeam: "T" }, "over")).mapEnd).toBe(true);
  });

  it("knows who won the round that just ended, and whether it was a big one", () => {
    const won = (spec: Partial<SyntheticPayloadSpec>) => mm(state({ ...spec, winTeam: "T", roundWins: { [String(spec.round)]: "t_win_elimination" } }, "over"));
    expect(won({ round: 1, scoreT: 1, scoreCT: 0 })).toMatchObject({ lastWinner: "T", lastRoundBig: true }); // pistol
    expect(won({ round: 6, scoreT: 4, scoreCT: 2 })).toMatchObject({ lastWinner: "T", lastRoundBig: false });
    expect(won({ round: 18, scoreT: 12, scoreCT: 6 })).toMatchObject({ lastWinner: "T", lastRoundBig: true }); // now on match point
  });
});

describe("freeze times that differ from round to round", () => {
  it("opens a pistol round wide with the map's camera, then the teams", () => {
    const shots = play({ spec: { round: 0 }, roundPhase: "freezetime" });
    expect(shots.length).toBeGreaterThanOrEqual(2);
    expect(isTeam(shots[0]!.id), JSON.stringify(shots)).toBe(false);
    expect(shots[0]!.reasons).toContain("PISTOL_ROUND");
    expect(shots.slice(1).some((s) => isTeam(s.id))).toBe(true);
  });

  it("shows the team on match point first, and longer", () => {
    const shots = play({ spec: { round: 19, scoreT: 7, scoreCT: 12 }, roundPhase: "freezetime" });
    expect(shots[0]!.id, JSON.stringify(shots)).toBe("team-CT");
    expect(shots[0]!.reasons).toContain("MATCH_POINT");
    expect(shots[0]!.durationMs!).toBeGreaterThan(18000 * 0.55);
  });

  it("gives a team on an eco no team shot", () => {
    const shots = play({ spec: { round: 4, scoreT: 2, scoreCT: 2 }, roundPhase: "freezetime", money: { CT: 400 } });
    expect(shots.map((s) => s.id), JSON.stringify(shots)).toContain("team-T");
    expect(shots.map((s) => s.id)).not.toContain("team-CT");
  });

  it("every third round has one longer shot of one team; with variety off, both teams again", () => {
    const one = play({ spec: { round: 5, scoreT: 3, scoreCT: 2 }, roundPhase: "freezetime" });
    expect(one.filter((s) => isTeam(s.id)), JSON.stringify(one)).toHaveLength(1);
    expect(one[0]!.durationMs!).toBeGreaterThan(18000 * 0.55);
    const both = play({ spec: { round: 5, scoreT: 3, scoreCT: 2 }, roundPhase: "freezetime", config: { variety: false } });
    expect(both.filter((s) => isTeam(s.id)).map((s) => s.id).sort()).toEqual(["team-CT", "team-T"]);
  });

  it("remembers the cameras of the last rounds so the next ones give way to others", () => {
    const p = new ShotPlanner(DEFAULT_DIRECTOR_CONFIG);
    p.setRound("r1");
    p.cinematicStarted(cameraShot("cam-a"), 0, 4000, null, false, 14000);
    p.setRound("r2");
    expect(p.roundsSinceShown(cameraShot("cam-a"))).toBe(1);
    expect(p.roundsSinceShown(cameraShot("cam-b"))).toBeNull();
    for (const r of ["r3", "r4", "r5", "r6"]) p.setRound(r);
    expect(p.roundsSinceShown(cameraShot("cam-a"))).toBeNull(); // forgotten after four rounds
  });
});

describe("big moments after the round", () => {
  const over = { round: 7, scoreT: 5, scoreCT: 2, winTeam: "T" as const, roundWins: { "7": "t_win_elimination" } };

  it("shows the winners where they stand, 2 s after the round ends", () => {
    const shots = play({ spec: over, roundPhase: "over", ms: 7000 });
    const win = shots.find((s) => s.id === "team-T-win");
    expect(win, JSON.stringify(shots)).toBeDefined();
    expect(win!.at).toBeGreaterThanOrEqual(2000);
    expect(win!.reasons).toContain("ROUND_WINNERS");
  });

  it("only after big rounds when set so, and never when off", () => {
    expect(play({ spec: over, roundPhase: "over", ms: 7000, config: { winnerShots: "big_rounds" } }).some((s) => s.id === "team-T-win")).toBe(false);
    expect(play({ spec: { ...over, round: 1, scoreT: 1, scoreCT: 0, roundWins: { "1": "t_win_elimination" } }, roundPhase: "over", ms: 7000, config: { winnerShots: "big_rounds" } }).some((s) => s.id === "team-T-win")).toBe(true);
    expect(play({ spec: over, roundPhase: "over", ms: 7000, config: { winnerShots: "off" } }).some((s) => s.id === "team-T-win")).toBe(false);
  });

  it("fills half time with slow shots of the map and the teams, the team ahead first", () => {
    const shots = play({ spec: { round: 12, scoreT: 5, scoreCT: 7, mapPhase: "intermission" }, roundPhase: "over", ms: 15000 });
    expect(shots.length, JSON.stringify(shots)).toBeGreaterThanOrEqual(2);
    expect(shots.every((s) => s.reasons.includes("HALF_TIME"))).toBe(true);
    expect(shots.find((s) => isTeam(s.id))!.id).toBe("team-CT-break");
  });
});
