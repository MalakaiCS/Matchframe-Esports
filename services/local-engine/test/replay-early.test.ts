import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { MatchState, Vec3 } from "@matchframe/contracts";
import { MapPack } from "@matchframe/contracts";
import type { SyntheticPlayer } from "@matchframe/cs2-state";
import { buildSyntheticGsiPayload, MatchStateStore, normalizeGsi, parseGsiPayload } from "@matchframe/cs2-state";
import { MapRuntime, VisibilityGrid } from "@matchframe/map-runtime";
import type { RoundRead } from "../src/replay/early.ts";
import { EARLY_CEILING_SEC, earlyGate, HOLD_MS, RoundDecider } from "../src/replay/early.ts";
import { AutoReplaySettings } from "../src/replay/auto.ts";

/**
 * Early replays (ADR-083): whether a live round is decided, on Mirage with its free-space grid and
 * walking graph (CS2's collision geometry), from game data as CS2 sends it (synthetic payloads through
 * the real reconciler).
 */
const root = join(import.meta.dirname, "..", "..", "..");
const grid = VisibilityGrid.parse(readFileSync(join(root, "assets", "map-packs", "de_mirage.grid")), (b) => inflateSync(b));
const mirage = new MapRuntime(MapPack.parse(JSON.parse(readFileSync(join(root, "assets", "map-packs", "de_mirage.json"), "utf8"))));
mirage.grid = grid;

/** Mirage spots (feet). Walking distances on the map's graph: CT spawn → the A bomb 1,845 u; B site → the A bomb 3,106 u; T spawn → nearest A cell 2,081 u; B apartments exit → B 179 u. */
const A_BOMB: Vec3 = { x: -386, y: -1667, z: -168 };
const B_SITE: Vec3 = { x: -1829, y: 493, z: -168 };
const CT_SPAWN: Vec3 = { x: -1650, y: -1950, z: -295 };
const T_SPAWN: Vec3 = { x: 1230, y: -300, z: -167 };
const APPS_EXIT: Vec3 = { x: -1603, y: 735, z: 4 };
/** 892 u on foot from the A bomb, out of its sight: a ninja's way in. */
const NINJA: Vec3 = { x: -686, y: -967, z: -200 };
/** 794 u on foot from the A bomb. */
const CLOSE: Vec3 = { x: 314, y: -1667, z: -168 };
/** 845 u on foot from the A bomb, in sight of it. */
const IN_SIGHT: Vec3 = { x: 314, y: -1367, z: 80 };
/** 252 u on foot from the B apartments exit. */
const NEAR_APPS: Vec3 = { x: -1803, y: 835, z: 0 };
/** Behind T spawn: 3,174 u on foot from the nearest bombsite cell. */
const T_BACK: Vec3 = { x: 1500, y: 600, z: -167 };

const T = (i: number) => `7656119800000000${i}`;
const CT = (i: number) => `7656119800000001${i}`;
function pl(steamId: string, side: "T" | "CT", position: Vec3, extra: Partial<SyntheticPlayer> = {}): SyntheticPlayer {
  const slot = Number(steamId.slice(-1));
  return { steamId, name: `${side}${slot}`, slot, side, position, forward: { x: 1, y: 0, z: 0 }, weapons: [{ name: side === "T" ? "weapon_ak47" : "weapon_m4a1", type: "Rifle", state: "active" }], ...extra };
}
const dead = (p: SyntheticPlayer): SyntheticPlayer => ({ ...p, health: 0 });

/** Drives the reconciler with synthetic payloads, 100 ms apart by default. */
class Sim {
  readonly store = new MatchStateStore({ sessionId: "early", simulated: true, mapContextFor: () => mirage });
  now = 10_000;
  private ts = 1_700_000_000;
  push(players: SyntheticPlayer[], opts: { bomb?: { state: string; position?: Vec3; player?: string; countdown?: number }; phase: "live" | "bomb"; left: number; dtMs?: number }): MatchState {
    this.now += opts.dtMs ?? 100;
    const raw = buildSyntheticGsiPayload({ mapName: "de_mirage", players, observed: players[0]!.steamId, timestamp: this.ts++, roundPhase: "live", phase: opts.phase, phaseEndsIn: opts.left, round: 5, ...(opts.bomb ? { bomb: opts.bomb } : {}), ...(opts.phase === "bomb" ? { roundBomb: "planted" as const } : {}) });
    const parsed = parseGsiPayload(raw);
    if (!parsed.ok) throw new Error(parsed.error);
    this.store.ingest(normalizeGsi(parsed.payload, { sourceId: "gsi:early", receivedAtMonotonicMs: this.now, payloadHash: JSON.stringify(raw) + this.now }));
    return this.store.snapshot(this.now);
  }
}

/** A planted bomb at A with `fuse` seconds left: reads the round `n` times, 250 ms apart (the fuse running down), and returns the last reading. */
function planted(players: SyntheticPlayer[], fuse: number, opts: { n?: number; d?: RoundDecider; sim?: Sim } = {}): { r: RoundRead | null; now: number; d: RoundDecider; sim: Sim } {
  const d = opts.d ?? new RoundDecider();
  const sim = opts.sim ?? new Sim();
  const n = opts.n ?? 1;
  let r: RoundRead | null = null;
  for (let i = n - 1; i >= 0; i--) {
    const left = fuse + i * 0.25;
    const s = sim.push(players, { phase: "bomb", left, bomb: { state: "planted", position: A_BOMB, countdown: left }, dtMs: 250 });
    r = d.read(s, sim.now, mirage, 16_000);
  }
  return { r, now: sim.now, d, sim };
}

/** No bomb planted, `left` seconds on the round clock, the bomb carried by `carrier` (or dropped where given). */
function noPlant(players: SyntheticPlayer[], left: number, bomb: { state: "carried"; player: string } | { state: "dropped"; position: Vec3 }, n = 1): { r: RoundRead | null; now: number } {
  const d = new RoundDecider();
  const sim = new Sim();
  let r: RoundRead | null = null;
  for (let i = n - 1; i >= 0; i--) {
    const s = sim.push(players, { phase: "live", left: left + i * 0.25, bomb: bomb.state === "carried" ? { state: "carried", player: bomb.player, position: players.find((p) => p.steamId === bomb.player)!.position! } : bomb, dtMs: 250 });
    r = d.read(s, sim.now, mirage, 16_000);
  }
  return { r, now: sim.now };
}

/** Ts holding the planted bomb at A; the rest dead. */
const holders = [pl(T(1), "T", A_BOMB), pl(T(2), "T", { x: A_BOMB.x + 60, y: A_BOMB.y + 40, z: A_BOMB.z }), dead(pl(T(3), "T", T_SPAWN)), dead(pl(T(4), "T", T_SPAWN)), dead(pl(T(5), "T", T_SPAWN))];
const deadCts = [dead(pl(CT(8), "CT", CT_SPAWN)), dead(pl(CT(9), "CT", CT_SPAWN)), dead(pl(CT(0), "CT", CT_SPAWN))];

describe("early replays: case 1, the bomb planted (Mirage)", () => {
  it("is decided when no CT can make a defuse: one at B without a kit, one at CT spawn with a kit, 8 s on the fuse", () => {
    const { r } = planted([...holders, pl(CT(6), "CT", B_SITE, { defuseKit: false }), pl(CT(7), "CT", CT_SPAWN, { defuseKit: true }), ...deadCts], 8, { n: 4 });
    expect(r).toMatchObject({ kind: "bomb", decided: true, open: null });
    // CT spawn with a kit: 1,845 u at 250 u/s (7.4 s) and 5 s of defuse is 12.4 s, more than the 8 s on the fuse and the 1 s margin.
    expect(r!.words).toBe("no CT can defuse (fuse 0:08; nearest CT 1,800 u, kit)");
    expect(r!.facts.ct).toBe("CT7");
    expect(r!.facts.needSec).toBeGreaterThan(12);
    expect(r!.facts.needSec).toBeLessThan(12.8);
  });

  it("is decided with no CT alive", () => {
    const { r } = planted([...holders, dead(pl(CT(6), "CT", B_SITE)), dead(pl(CT(7), "CT", CT_SPAWN)), ...deadCts], 9);
    expect(r).toMatchObject({ decided: true, words: "no CT alive to defuse (fuse 0:09)" });
  });

  it("is open while a CT within reach has a kit: CT spawn with 12 s on the fuse", () => {
    const { r } = planted([...holders, pl(CT(7), "CT", CT_SPAWN, { defuseKit: true }), dead(pl(CT(6), "CT", B_SITE)), ...deadCts], 12);
    // 7.4 s on foot and 5 s of defuse: 12.4 s, within 12 s and the margin.
    expect(r).toMatchObject({ decided: false, open: "defuse" });
    expect(r!.words).toMatch(/^a CT can still defuse \(CT7: 1,800 u from the bomb, kit; fuse 0:12\)$/);
  });

  it("is open for a ninja defuse: a CT out of every T's sight, 892 u away with a kit; decided without the kit", () => {
    const eye = (p: Vec3) => ({ ...p, z: p.z + 64 });
    for (const t of holders.slice(0, 2)) expect(grid.lineOfSight(eye(t.position!), eye(NINJA))).toBe(false);
    const withKit = planted([...holders, pl(CT(6), "CT", NINJA, { defuseKit: true }), dead(pl(CT(7), "CT", CT_SPAWN)), ...deadCts], 8, { n: 3 }).r;
    // 3.6 s on foot and 5 s: 8.6 s, within 8 s and the margin. Seen or not, it isn't decided.
    expect(withKit).toMatchObject({ decided: false, open: "defuse" });
    const noKit = planted([...holders, pl(CT(6), "CT", NINJA, { defuseKit: false }), dead(pl(CT(7), "CT", CT_SPAWN)), ...deadCts], 8, { n: 3 }).r;
    expect(noKit).toMatchObject({ decided: true, words: "no CT can defuse (fuse 0:08; nearest CT 900 u, no kit)" });
  });

  it("counts a CT whose kit isn't in the game data as having one", () => {
    const { r } = planted([...holders, pl(CT(6), "CT", NINJA), dead(pl(CT(7), "CT", CT_SPAWN)), ...deadCts], 8);
    expect(r).toMatchObject({ decided: false, open: "defuse" });
  });

  it("is open while a duel is on or about to start, though no CT can defuse", () => {
    // 794 u on foot from the Ts at the bomb, no kit, 6 s on the fuse.
    const close = planted([...holders, pl(CT(6), "CT", CLOSE, { defuseKit: false }), dead(pl(CT(7), "CT", CT_SPAWN)), ...deadCts], 6).r;
    expect(close).toMatchObject({ decided: false, open: "duel" });
    expect(close!.words).toMatch(/^a duel: T1 and CT6 are 800 u apart on foot$/);
    // 845 u on foot, but in sight of the bomb's Ts.
    const seen = planted([...holders, pl(CT(6), "CT", IN_SIGHT, { defuseKit: false }), dead(pl(CT(7), "CT", CT_SPAWN)), ...deadCts], 6).r;
    expect(seen).toMatchObject({ decided: false, open: "duel" });
    expect(seen!.words).toMatch(/can see each other/);
  });

  it("is open while a CT walks in on the Ts (closing in, still in reach before the explosion)", () => {
    const d = new RoundDecider();
    const sim = new Sim();
    let r: RoundRead | null = null;
    // The CT walks the corridor towards A from about 1,400 u away at 250 u/s, no kit, out of sight.
    for (let i = 0; i <= 16; i++) {
      const at = { x: NINJA.x, y: NINJA.y + (16 - i) * 25 + 100, z: NINJA.z };
      const left = 9 - i * 0.1;
      const s = sim.push([...holders, pl(CT(6), "CT", at, { defuseKit: false }), dead(pl(CT(7), "CT", CT_SPAWN)), ...deadCts], { phase: "bomb", left, bomb: { state: "planted", position: A_BOMB, countdown: left } });
      r = d.read(s, sim.now, mirage, 16_000);
    }
    expect(r).toMatchObject({ decided: false, open: "duel" });
    expect(r!.words).toMatch(/^a duel is about to start: T1 and CT6 are closing in on each other \([\d,]+ u on foot, \d+ u\/s\)$/);
    expect(r!.facts.closing).toBeGreaterThanOrEqual(200);
  });

  it("is open while a CT is defusing, and says nothing once the bomb has gone off", () => {
    const d = new RoundDecider();
    const sim = new Sim();
    const players = [...holders, pl(CT(6), "CT", A_BOMB, { defuseKit: false }), dead(pl(CT(7), "CT", CT_SPAWN)), ...deadCts];
    d.read(sim.push(players, { phase: "bomb", left: 8, bomb: { state: "planted", position: A_BOMB, countdown: 8 }, dtMs: 250 }), sim.now, mirage, 16_000);
    // (While defusing, the game's countdown is the defuse's: the explosion stays where the plant's countdown put it.)
    const r = d.read(sim.push(players, { phase: "bomb", left: 7.75, bomb: { state: "defusing", position: A_BOMB, countdown: 9.9 }, dtMs: 250 }), sim.now, mirage, 16_000);
    expect(r).toMatchObject({ decided: false, open: "defuse", words: "a CT is defusing (fuse 0:07)" });
    expect(r!.endsAt - sim.now).toBe(7750);
    expect(d.read(sim.push(players, { phase: "bomb", left: 0, bomb: { state: "exploded", position: A_BOMB }, dtMs: 250 }), sim.now, mirage, 16_000)).toBeNull();
  });

  it("says nothing while the fuse is further off than it looks ahead", () => {
    const { r } = planted([...holders, pl(CT(6), "CT", B_SITE, { defuseKit: false }), ...deadCts, dead(pl(CT(7), "CT", CT_SPAWN))], 30);
    expect(r).toBeNull();
  });
});

describe("early replays: case 2, no bomb planted (Mirage)", () => {
  const cts = [pl(CT(6), "CT", CT_SPAWN), pl(CT(7), "CT", { x: CT_SPAWN.x + 80, y: CT_SPAWN.y, z: CT_SPAWN.z }), dead(pl(CT(8), "CT", B_SITE)), dead(pl(CT(9), "CT", B_SITE)), dead(pl(CT(0), "CT", B_SITE))];
  const saving = (carrierAt: Vec3) => [pl(T(1), "T", carrierAt), pl(T(2), "T", { x: T_SPAWN.x + 60, y: T_SPAWN.y, z: T_SPAWN.z }), dead(pl(T(3), "T", A_BOMB)), dead(pl(T(4), "T", A_BOMB)), dead(pl(T(5), "T", A_BOMB))];

  it("is decided when the Ts save at T spawn, far from both sites, with 8 s left", () => {
    const { r } = noPlant([...saving(T_SPAWN), ...cts], 8, { state: "carried", player: T(1) }, 4);
    // 2,081 u to the nearest A cell: 8.3 s on foot and 3.2 s to plant, more than 8 s and the margin.
    expect(r).toMatchObject({ kind: "time", decided: true, open: null, words: "no T can plant (0:08 left; bomb carrier T1 2,100 u from the nearest site)" });
  });

  it("is open while the carrier is near a site with time to plant", () => {
    const { r } = noPlant([...saving(APPS_EXIT), ...cts], 8, { state: "carried", player: T(1) });
    expect(r).toMatchObject({ decided: false, open: "plant" });
    expect(r!.words).toMatch(/^a T can still plant \(bomb carrier T1 200 u from the nearest site; 0:08 left\)$/);
  });

  it("is open with the bomb dropped near a T and a site; decided when it lies far from every T and site", () => {
    const near = noPlant([pl(T(1), "T", NEAR_APPS), ...saving(T_SPAWN).slice(1), ...cts], 8, { state: "dropped", position: APPS_EXIT }).r;
    expect(near).toMatchObject({ decided: false, open: "plant" });
    expect(near!.words).toMatch(/the dropped bomb: nearest T T1 300 u from it, 200 u from a site/);
    // Dropped at T spawn, the Ts behind it: 2,081 u from a site whoever picks it up.
    const far = noPlant([pl(T(1), "T", T_BACK), pl(T(2), "T", { ...T_BACK, x: T_BACK.x + 60 }), ...saving(T_SPAWN).slice(2), ...cts], 8, { state: "dropped", position: T_SPAWN }).r;
    expect(far).toMatchObject({ decided: true, open: null });
    expect(far!.words).toMatch(/^no T can plant \(0:08 left; the dropped bomb: nearest T T\d [\d,]+ u from it, 2,100 u from a site\)$/);
    // Where no T can get to it at all: decided on time.
    const unreachable = noPlant([...saving(T_SPAWN), ...cts], 8, { state: "dropped", position: { x: B_SITE.x, y: B_SITE.y - 900, z: -168 } }).r;
    expect(unreachable).toMatchObject({ decided: true, words: "no T can plant (0:08 left; no T can reach the dropped bomb)" });
  });

  it("is open while Ts hunt CTs they can still reach", () => {
    // The carrier saves at T spawn; another T stands 794 u on foot from a CT.
    const players = [pl(T(1), "T", T_SPAWN), pl(T(2), "T", A_BOMB), dead(pl(T(3), "T", A_BOMB)), dead(pl(T(4), "T", A_BOMB)), dead(pl(T(5), "T", A_BOMB)), pl(CT(6), "CT", CLOSE), dead(pl(CT(7), "CT", B_SITE)), dead(pl(CT(8), "CT", B_SITE)), dead(pl(CT(9), "CT", B_SITE)), dead(pl(CT(0), "CT", B_SITE))];
    const { r } = noPlant(players, 8, { state: "carried", player: T(1) });
    expect(r).toMatchObject({ decided: false, open: "duel" });
  });
});

describe("early replays: holding, the window and its hard ceiling", () => {
  const decidedPlayers = [...holders, pl(CT(6), "CT", B_SITE, { defuseKit: false }), dead(pl(CT(7), "CT", CT_SPAWN)), ...deadCts];

  it("holds 1.5 s before replays may start, and starts over after a break", () => {
    const d = new RoundDecider();
    const sim = new Sim();
    const read = (left: number, players = decidedPlayers) => d.read(sim.push(players, { phase: "bomb", left, bomb: { state: "planted", position: A_BOMB, countdown: left }, dtMs: 250 }), sim.now, mirage, 16_000)!;
    const first = read(9.5);
    expect(first.decided).toBe(true);
    expect(first.since).toBe(sim.now);
    // 1.25 s later: not yet; 1.5 s: now.
    let r = first;
    for (const left of [9.25, 9, 8.75, 8.5, 8.25]) r = read(left);
    expect(earlyGate(r, sim.now, 10)).toMatchObject({ go: false, inMs: 250 });
    r = read(8);
    expect(earlyGate(r, sim.now, 10)).toMatchObject({ go: true, inMs: 0 });
    // A CT with a kit at CT spawn and 12 s… here 7.75 s: the CT steps into reach (the ninja spot, with a kit): open; then decided again, held from then.
    const open = read(7.75, [...holders, pl(CT(6), "CT", NINJA, { defuseKit: true }), dead(pl(CT(7), "CT", CT_SPAWN)), ...deadCts]);
    expect(open).toMatchObject({ decided: false, since: null, open: "defuse" });
    const again = read(7.5);
    expect(again.since).toBe(sim.now);
    expect(earlyGate(again, sim.now, 10).go).toBe(false);
  });

  it("a kill holds the decision again from the kill", () => {
    const d = new RoundDecider();
    const sim = new Sim();
    const read = (left: number, players: SyntheticPlayer[]) => d.read(sim.push(players, { phase: "bomb", left, bomb: { state: "planted", position: A_BOMB, countdown: left }, dtMs: 250 }), sim.now, mirage, 16_000)!;
    for (const left of [9.5, 9.25, 9, 8.75, 8.5, 8.25]) read(left, decidedPlayers);
    const r = read(8, [dead(holders[0]!), ...holders.slice(1), pl(CT(6), "CT", B_SITE, { defuseKit: false }), dead(pl(CT(7), "CT", CT_SPAWN)), ...deadCts]);
    expect(d.lastKill).toEqual({ at: sim.now, victims: ["T1"] });
    expect(r.since).toBe(sim.now);
    expect(earlyGate(r, sim.now, 10).go).toBe(false);
  });

  it("waits for the round's end with under 3 s left", () => {
    const { r, now } = planted(decidedPlayers, 2.9, { n: 8 });
    expect(earlyGate(r, now, 10)).toEqual({ go: false, inMs: null, tooLate: true });
  });

  it(`case 1: may start at exactly ${EARLY_CEILING_SEC}.0 s on the fuse, never at 10.5 s, whatever is set`, () => {
    // Held long enough before either moment (the fuse running down from 13 s).
    const at10 = planted(decidedPlayers, 10, { n: 13 });
    expect(at10.r!.endsAt - at10.now).toBe(10_000);
    expect(at10.now - at10.r!.since!).toBeGreaterThanOrEqual(HOLD_MS);
    expect(earlyGate(at10.r, at10.now, 10).go).toBe(true);
    const at105 = planted(decidedPlayers, 10.5, { n: 11 });
    expect(at105.r!.endsAt - at105.now).toBe(10_500);
    expect(earlyGate(at105.r, at105.now, 10)).toMatchObject({ go: false, inMs: 500 });
    // The ceiling holds even if more seconds were asked for; fewer lower the window.
    expect(earlyGate(at105.r, at105.now, 30).go).toBe(false);
    expect(earlyGate(at10.r, at10.now, 30).go).toBe(true);
    expect(earlyGate(at10.r, at10.now, 5)).toMatchObject({ go: false, inMs: 5000 });
  });

  it(`case 2: may start at exactly ${EARLY_CEILING_SEC}.0 s on the round clock, never at 10.5 s`, () => {
    const players = [pl(T(1), "T", T_BACK), pl(T(2), "T", { x: T_SPAWN.x + 60, y: T_SPAWN.y, z: T_SPAWN.z }), dead(pl(T(3), "T", A_BOMB)), dead(pl(T(4), "T", A_BOMB)), dead(pl(T(5), "T", A_BOMB)), pl(CT(6), "CT", CT_SPAWN), dead(pl(CT(7), "CT", B_SITE)), dead(pl(CT(8), "CT", B_SITE)), dead(pl(CT(9), "CT", B_SITE)), dead(pl(CT(0), "CT", B_SITE))];
    // The carrier 3,174 u from a site: 12.7 s on foot and 3.2 s to plant, more than 12 s (the first reading) and the margin.
    const at10 = noPlant(players, 10, { state: "carried", player: T(1) }, 9);
    expect(at10.r).toMatchObject({ kind: "time", decided: true });
    expect(at10.r!.endsAt - at10.now).toBe(10_000);
    expect(earlyGate(at10.r, at10.now, 10).go).toBe(true);
    const at105 = noPlant(players, 10.5, { state: "carried", player: T(1) }, 9);
    expect(at105.r).toMatchObject({ kind: "time", decided: true });
    expect(at105.r!.endsAt - at105.now).toBe(10_500);
    expect(earlyGate(at105.r, at105.now, 10).go).toBe(false);
    expect(earlyGate(at105.r, at105.now, 30).go).toBe(false);
  });

  it("the setting can only lower the window: 5–10 s, 10 by default", () => {
    expect(AutoReplaySettings.parse({}).earlyMaxSec).toBe(10);
    expect(AutoReplaySettings.parse({}).early).toBe(true);
    expect(AutoReplaySettings.parse({}).earlyBackToLive).toBe(true);
    expect(AutoReplaySettings.safeParse({ earlyMaxSec: 11 }).success).toBe(false);
    expect(AutoReplaySettings.safeParse({ earlyMaxSec: 4 }).success).toBe(false);
    expect(AutoReplaySettings.safeParse({ earlyMaxSec: 5 }).success).toBe(true);
  });
});
