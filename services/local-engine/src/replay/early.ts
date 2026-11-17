import type { MatchState, PlayerState, Vec3 } from "@matchframe/contracts";
import type { SpatialContext } from "@matchframe/director-policy";
import { computePair, DEFAULT_DIRECTOR_CONFIG, StateHistory } from "@matchframe/director-policy";
import type { MapRuntime } from "@matchframe/map-runtime";
import { walkGraphFor } from "@matchframe/map-runtime";

/**
 * Early replays (ADR-083): whether a live round is already decided, so its break's replays may start
 * a few seconds before it ends. Two cases, as the owner put them:
 *
 * 1. **The bomb is planted** and no CT can make a defuse: every alive CT's walk to the bomb (the map's
 *    walking graph, at knife speed) plus the defuse (5 s with a kit, 10 s without) is longer than the
 *    fuse left plus a margin. No CT alive counts too. A CT who could still get there in time keeps it
 *    open, seen or not (a ninja defuse). The round ends with the explosion.
 * 2. **No bomb planted** and no T can plant: the bomb carrier's walk to the nearest bombsite plus the
 *    plant (3.2 s) is longer than the round time left plus a margin; a dropped bomb, the nearest T's
 *    walk to it and on to a site; no T can reach it at all. The round ends on time.
 *
 * Either way, no duel may be on or about to start: a CT and a T within a short walk of each other,
 * seeing each other or about to (the director's sightline test), or one closing in on the other while
 * there is still time to reach them. The decision must hold HOLD_MS before replays start.
 */

/** Walking speed with the knife out (units a second). */
export const KNIFE_SPEED = 250;
/** A defuse with a kit, and without one (seconds). */
export const DEFUSE_KIT_SEC = 5;
export const DEFUSE_SEC = 10;
/** A plant (seconds). */
export const PLANT_SEC = 3.2;
/** A defuse or plant that would only just miss still counts as possible (seconds). */
export const MARGIN_SEC = 1;
/** A CT and a T this close on foot are in a duel, or about to be (units). */
export const DUEL_WALK = 800;
/** Closing in on an opponent at this speed or more (units a second, over the last second): hunting. */
export const HUNT_SPEED = 120;
/** The decision must hold this long before early replays start. */
export const HOLD_MS = 1500;
/** Nothing starts early with more than this left on the round's deciding timer (the fuse, or the round clock): the owner's hard rule. */
export const EARLY_CEILING_SEC = 10;
/** With less than this left, the replays wait for the round's end. */
export const MIN_EARLY_MS = 3000;
/** The decision is worked out from this long before the earliest start (the hold, and a closing speed to measure). */
export const LOOK_AHEAD_MS = 6000;
/** Game data older than this says nothing. */
const STALE_MS = 3000;
/** Walks are searched at least this far, so the words can say how far the nearest player is. */
const SHOW_WALK = 3000;
/** Sightlines are tested this far apart (as the director does). */
const SIGHT_RANGE = 3000;
/** A reading is worked out at most this often (the walking searches); between, the last one stands. */
const READ_EVERY_MS = 250;
/** Closing speeds from walks this far apart in time (ms), at least MIN apart. */
const CLOSING_WINDOW_MS = 1000;
const CLOSING_MIN_MS = 400;

/** What keeps the round open: a defuse or a plant still possible, a duel (on or about to start), or the game data. */
export type OpenWhy = "defuse" | "plant" | "duel" | "data";

/** The round as read now. */
export interface RoundRead {
  /** 1: the bomb is planted (it ends with the explosion); 2: it isn't (it ends on time). */
  kind: "bomb" | "time";
  /** The round's expected end (monotonic ms): the bomb's explosion, or the round clock's 0:00. */
  endsAt: number;
  decided: boolean;
  /** Decided without a break since (monotonic ms), or null. */
  since: number | null;
  /** In words, with the numbers: "no CT can defuse (fuse 0:08; nearest CT 1,900 u, no kit)", "a CT can still defuse (…)". */
  words: string;
  /** What keeps it open (null when decided). */
  open: OpenWhy | null;
  /** The numbers behind it, for the log. */
  facts: Record<string, string | number | boolean | null>;
}

/** Short words for what reopened a round: "Back to live: a CT can still defuse." */
export const OPEN_WORDS: Record<OpenWhy | "kill", string> = {
  defuse: "a CT can still defuse",
  plant: "a T can still plant",
  duel: "a duel is on or about to start",
  data: "the game data says too little",
  kill: "a kill",
};

/**
 * Whether early replays may start now, given the round as read: decided for HOLD_MS, its expected end
 * at most `maxSec` away (never more than EARLY_CEILING_SEC, whatever is set) and at least MIN_EARLY_MS.
 * `inMs`: how long until they may (null: not decided, or too late).
 */
export function earlyGate(r: RoundRead | null, now: number, maxSec: number): { go: boolean; inMs: number | null; tooLate: boolean } {
  if (!r?.decided || r.since === null) return { go: false, inMs: null, tooLate: false };
  const left = r.endsAt - now;
  if (left < MIN_EARLY_MS) return { go: false, inMs: null, tooLate: true };
  const window = Math.min(maxSec, EARLY_CEILING_SEC) * 1000;
  const inMs = Math.max(HOLD_MS - (now - r.since), left - window, 0);
  return { go: inMs <= 0, inMs, tooLate: false };
}

/** A round clock time as CS2 shows it (8.4 → 0:08). */
const clockOf = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
/** Units in words, to the nearest hundred (1,900 u); beyond the search: "over 3,000 u". */
const units = (d: number, max: number) => (Number.isFinite(d) ? `${(Math.round(d / 100) * 100).toLocaleString("en-US")} u` : `over ${(Math.floor(max / 100) * 100).toLocaleString("en-US")} u`);
const round1 = (x: number) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
const straight = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Where a bombsite's cells are, as walking goals (two heights per cell: the floor is somewhere in it). */
const siteGoalCache = new WeakMap<MapRuntime, Vec3[]>();
export function siteGoals(map: MapRuntime): Vec3[] {
  const cached = siteGoalCache.get(map);
  if (cached) return cached;
  const out: Vec3[] = [];
  for (const b of map.pack.bombsites) {
    for (const shape of map.region(b.regionId)?.shapes ?? []) {
      if (shape.kind === "cells") {
        for (const [ix, iy, iz] of shape.cells) {
          const x = (ix + 0.5) * shape.cellSize;
          const y = (iy + 0.5) * shape.cellSize;
          out.push({ x, y, z: iz * shape.zCellSize + 16 }, { x, y, z: iz * shape.zCellSize + Math.min(96, shape.zCellSize - 16) });
        }
      } else {
        for (const [x, y] of shape.points) out.push({ x, y, z: shape.zMin + 16 });
        const n = shape.points.length || 1;
        out.push({ x: shape.points.reduce((s, p) => s + p[0], 0) / n, y: shape.points.reduce((s, p) => s + p[1], 0) / n, z: shape.zMin + 16 });
      }
    }
  }
  siteGoalCache.set(map, out);
  return out;
}

/**
 * Reads a live round, reading after reading (the engine's 200 ms tick): the decision, how long it has
 * held, and the kills (a player alive at the last reading and not now).
 */
export class RoundDecider {
  private readonly history = new StateHistory(1500);
  /** Each CT–T pair's walking distance over the last second or so (hunting). */
  private readonly walks = new Map<string, { t: number; d: number }[]>();
  private key: string | null = null;
  private since: number | null = null;
  private alive: Set<string> | null = null;
  private last: { at: number; read: Omit<RoundRead, "since"> | null } | null = null;
  /** The bomb's explosion as the plant's own countdown said (a defuse's countdown replaces it in the game data). */
  private plantEndsAt: number | null = null;
  /** The last kill seen (a player alive at one reading and dead at the next): when, and who. */
  lastKill: { at: number; victims: string[] } | null = null;

  reset(): void {
    this.key = null;
    this.since = null;
    this.alive = null;
    this.last = null;
    this.plantEndsAt = null;
    this.lastKill = null;
    this.walks.clear();
  }

  /**
   * The round as read now, or null when there is nothing to decide (not live, its end further than
   * `lookAheadMs` or unknown, the bomb gone off or defused, no T alive before a plant).
   */
  read(s: MatchState, now: number, map: MapRuntime | undefined, lookAheadMs: number): RoundRead | null {
    if (s.roundPhase !== "live") {
      this.reset();
      return null;
    }
    const key = s.roundAttemptId ?? String(s.roundNumber);
    if (key !== this.key) {
      this.reset();
      this.key = key;
    }
    this.history.push(s);
    const alive = new Set(s.players.filter((p) => p.side && !p.coach && p.lifeState === "alive").map((p) => p.steamId));
    const gone = this.alive ? [...this.alive].filter((id) => !alive.has(id)) : [];
    if (gone.length) {
      this.lastKill = { at: now, victims: gone.map((id) => s.players.find((p) => p.steamId === id)?.name ?? id) };
      // A kill: the decision holds again from now.
      if (this.since !== null) this.since = now;
      this.last = null;
    }
    this.alive = alive;
    if (!this.last || now - this.last.at >= READ_EVERY_MS) this.last = { at: now, read: this.evaluate(s, now, map, lookAheadMs) };
    const r = this.last.read;
    if (!r?.decided) this.since = null;
    else this.since ??= now;
    return r ? { ...r, since: this.since } : null;
  }

  private evaluate(s: MatchState, now: number, map: MapRuntime | undefined, lookAheadMs: number): Omit<RoundRead, "since"> | null {
    const bomb = s.bomb;
    if (bomb?.state === "exploded" || bomb?.state === "defused") return null;
    const planted = bomb?.state === "planted" || bomb?.state === "defusing" || s.gamePhase === "bomb" || s.gamePhase === "defuse";
    let endsAt: number | null = null;
    if (planted) {
      if (bomb?.state === "planted" && bomb.countdownSec !== null && bomb.countdownObservedAtMonotonicMs !== null) this.plantEndsAt = bomb.countdownObservedAtMonotonicMs + bomb.countdownSec * 1000;
      else if (s.gamePhase === "bomb" && s.phaseEndsInSec !== null && s.phaseObservedAtMonotonicMs !== null) this.plantEndsAt = s.phaseObservedAtMonotonicMs + s.phaseEndsInSec * 1000;
      endsAt = this.plantEndsAt;
    } else if (s.gamePhase === "live" && s.phaseEndsInSec !== null && s.phaseObservedAtMonotonicMs !== null) {
      endsAt = s.phaseObservedAtMonotonicMs + s.phaseEndsInSec * 1000;
    }
    if (endsAt === null) return null;
    const leftMs = endsAt - now;
    if (leftMs <= 0 || leftMs > lookAheadMs) return null;
    const kind = planted ? "bomb" : "time";
    const left = leftMs / 1000;
    const players = s.players.filter((p) => p.side && !p.coach && p.lifeState === "alive");
    const cts = players.filter((p) => p.side === "CT");
    const ts = players.filter((p) => p.side === "T");
    const base = { kind, endsAt } as const;
    const open = (why: OpenWhy, words: string, facts: RoundRead["facts"] = {}) => ({ ...base, decided: false, words, open: why, facts: { left: round1(left), ...facts } });
    const decided = (words: string, facts: RoundRead["facts"] = {}) => ({ ...base, decided: true, words, open: null, facts: { left: round1(left), ...facts } });
    if (!planted && !ts.length) return null;
    if (s.paused) return open("data", "the match is paused");
    if (now - s.time.receivedAtMonotonicMs > STALE_MS) return open("data", "no fresh game data");

    if (planted) {
      const fuse = `fuse ${clockOf(left)}`;
      if (!cts.length) return decided(`no CT alive to defuse (${fuse})`, { cts: 0 });
      if (bomb?.state === "defusing" || s.gamePhase === "defuse") return open("defuse", `a CT is defusing (${fuse})`);
      if (!map?.grid) return open("data", "this map has no free-space grid");
      if (!bomb?.position) return open("data", "where the bomb is isn't known");
      if (cts.some((p) => !p.position)) return open("data", "where every CT is isn't known");
      const bound = Math.max(SHOW_WALK, (left + MARGIN_SEC - DEFUSE_KIT_SEC) * KNIFE_SPEED + 50);
      const walks = walkGraphFor(map.grid).distancesTo(bomb.position, cts.map((p) => p.position!), bound);
      const reads = cts.map((p, i) => {
        // Off the walking graph: the straight line, which is never longer than the walk.
        const walk = walks[i] ?? straight(p.position!, bomb.position!);
        // A kit not in the game data: counted as a kit (the faster defuse).
        const kit = p.defuseKit !== false;
        const need = walk / KNIFE_SPEED + (kit ? DEFUSE_KIT_SEC : DEFUSE_SEC);
        return { p, walk, kit, need };
      });
      reads.sort((a, b) => a.need - b.need);
      const best = reads[0]!;
      const facts = { fuse: round1(left), ct: best.p.name, walk: Number.isFinite(best.walk) ? Math.round(best.walk) : null, kit: best.kit, needSec: round1(best.need), marginSec: MARGIN_SEC };
      if (best.need <= left + MARGIN_SEC) return open("defuse", `a CT can still defuse (${best.p.name}: ${units(best.walk, bound)} from the bomb, ${best.kit ? "kit" : "no kit"}; ${fuse})`, facts);
      const duel = this.duel(ts, cts, now, map, leftMs);
      if (duel) return open("duel", duel.words, { ...facts, ...duel.facts });
      const nearest = [...reads].sort((a, b) => a.walk - b.walk)[0]!;
      return decided(`no CT can defuse (${fuse}; nearest CT ${units(nearest.walk, bound)}, ${nearest.kit ? "kit" : "no kit"})`, { ...facts, nearestCt: nearest.p.name, nearestWalk: Number.isFinite(nearest.walk) ? Math.round(nearest.walk) : null });
    }

    // No bomb planted: can any T plant before the round clock runs out?
    const time = `${clockOf(left)} left`;
    if (bomb?.state === "planting") return open("plant", `a T is planting (${time})`);
    if (!map?.grid) return open("data", "this map has no free-space grid");
    const goals = siteGoals(map);
    if (!goals.length) return open("data", "this map has no bombsites");
    if (!bomb || bomb.state === "unknown") return open("data", "where the bomb is isn't known");
    const walk = walkGraphFor(map.grid);
    const bound = Math.max(SHOW_WALK, (left + MARGIN_SEC - PLANT_SEC) * KNIFE_SPEED + 50);
    const nearestSite = (p: Vec3) => walk.distancesToNearest(goals, [p], bound)[0] ?? Math.min(...goals.map((g) => Math.hypot(g.x - p.x, g.y - p.y)));
    let need: number;
    let words: string;
    let facts: RoundRead["facts"];
    if (bomb.state === "carried") {
      const c = ts.find((p) => p.steamId === bomb.carrierSteamId);
      if (!c?.position) return open("data", "where the bomb carrier is isn't known");
      const d = nearestSite(c.position);
      need = d / KNIFE_SPEED + PLANT_SEC;
      words = `bomb carrier ${c.name} ${units(d, bound)} from the nearest site`;
      facts = { carrier: c.name, toSite: Number.isFinite(d) ? Math.round(d) : null };
    } else if (bomb.state === "dropped") {
      if (!bomb.position) return open("data", "where the dropped bomb is isn't known");
      const withPos = ts.filter((p) => p.position);
      if (withPos.length < ts.length) return open("data", "where every T is isn't known");
      const toBomb = walk.distancesTo(bomb.position, withPos.map((p) => p.position!), bound).map((d, i) => d ?? straight(withPos[i]!.position!, bomb.position!));
      const k = toBomb.indexOf(Math.min(...toBomb));
      const fromBomb = nearestSite(bomb.position);
      const d = (toBomb[k] ?? Infinity) + fromBomb;
      need = d / KNIFE_SPEED + PLANT_SEC;
      words = Number.isFinite(d) ? `the dropped bomb: nearest T ${withPos[k]!.name} ${units(toBomb[k]!, bound)} from it, ${units(fromBomb, bound)} from a site` : "no T can reach the dropped bomb";
      facts = { nearestT: withPos[k]?.name ?? null, toBomb: Number.isFinite(toBomb[k] ?? Infinity) ? Math.round(toBomb[k]!) : null, bombToSite: Number.isFinite(fromBomb) ? Math.round(fromBomb) : null };
    } else return open("data", `the bomb is ${bomb.state}`);
    facts = { ...facts, roundLeft: round1(left), needSec: round1(need), marginSec: MARGIN_SEC };
    if (need <= left + MARGIN_SEC) return open("plant", `a T can still plant (${words}; ${time})`, facts);
    const duel = this.duel(ts, cts, now, map, leftMs);
    if (duel) return open("duel", duel.words, { ...facts, ...duel.facts });
    return decided(`no T can plant (${time}; ${words})`, facts);
  }

  /**
   * A duel on or about to start: a CT and a T within DUEL_WALK on foot, seeing each other or about to
   * (the director's sightline test from the map's grid and their speeds), or closing in on each other
   * at HUNT_SPEED or more while there is still time to meet before the round ends. Null: none.
   */
  private duel(ts: PlayerState[], cts: PlayerState[], now: number, map: MapRuntime, leftMs: number): { words: string; facts: RoundRead["facts"] } | null {
    const grid = map.grid!;
    const walk = walkGraphFor(grid);
    const spatial: SpatialContext = { levelAt: (p) => map.levelAt(p), regionsAt: (p) => map.regionsAt(p), hasVisibilityGeometry: true, lineOfSight: (a, b) => grid.lineOfSight(a, b) };
    // How far apart two players can be and still meet before the end, walking at each other.
    const reach = DUEL_WALK + (leftMs / 1000) * KNIFE_SPEED;
    const located = (list: PlayerState[]) => list.filter((p) => p.position);
    const tsAt = located(ts);
    let found: { words: string; facts: RoundRead["facts"] } | null = null;
    for (const ct of located(cts)) {
      const near = tsAt.filter((t) => straight(t.position!, ct.position!) <= reach);
      const walks = near.length ? walk.distancesTo(ct.position!, near.map((t) => t.position!), reach) : [];
      for (const t of tsAt) {
        const line = straight(t.position!, ct.position!);
        const i = near.indexOf(t);
        const d = i < 0 ? Infinity : (walks[i] ?? line);
        // Keep each pair's walk (for its closing speed), even once a duel is found.
        const hist = this.walks.get(`${t.steamId}:${ct.steamId}`) ?? [];
        if (Number.isFinite(d)) hist.push({ t: now, d });
        while (hist.length > 1 && now - hist[0]!.t > CLOSING_WINDOW_MS * 1.5) hist.shift();
        this.walks.set(`${t.steamId}:${ct.steamId}`, hist);
        if (found) continue;
        const pairFacts = { t: t.name, ct: ct.name, walk: Number.isFinite(d) ? Math.round(d) : null };
        if (d <= DUEL_WALK) {
          found = { words: `a duel: ${t.name} and ${ct.name} are ${units(d, reach)} apart on foot`, facts: pairFacts };
          continue;
        }
        if (Math.hypot(t.position!.x - ct.position!.x, t.position!.y - ct.position!.y) <= SIGHT_RANGE) {
          const sight = computePair(t, ct, now, DEFAULT_DIRECTOR_CONFIG, spatial, this.history).sight;
          if (sight?.now) {
            found = { words: `a duel: ${t.name} and ${ct.name} can see each other (${units(line, reach)})`, facts: { ...pairFacts, sight: "now" } };
            continue;
          }
          if (sight?.soonSec !== null && sight?.soonSec !== undefined) {
            found = { words: `a duel is about to start: ${t.name} and ${ct.name} may see each other in ${sight.soonSec.toFixed(1)} s`, facts: { ...pairFacts, sight: sight.soonSec } };
            continue;
          }
        }
        if (!Number.isFinite(d)) continue;
        const ref = hist.find((x) => now - x.t <= CLOSING_WINDOW_MS) ?? hist[0];
        const dt = ref ? now - ref.t : 0;
        const closing = ref && dt >= CLOSING_MIN_MS ? ((ref.d - d) * 1000) / dt : null;
        if (closing !== null && closing >= HUNT_SPEED && (d - DUEL_WALK) / KNIFE_SPEED <= leftMs / 1000) {
          found = { words: `a duel is about to start: ${t.name} and ${ct.name} are closing in on each other (${units(d, reach)} on foot, ${Math.round(closing)} u/s)`, facts: { ...pairFacts, closing: Math.round(closing) } };
        }
      }
    }
    return found;
  }
}
