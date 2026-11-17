import type { MatchState } from "@matchframe/contracts";
import { detectKnifeRound, firstRound } from "./knife-round.ts";

/**
 * When a map's intro starts by itself (ADR-079), read from the game data as it comes in. One choice
 * ("Start the intro"):
 *
 * - **Manual only:** never by itself.
 * - **When the map loads:** the warmup of a map the game data has just changed to (the observer's
 *   CS2 loading it, or joining the server in its warmup). A server without a warmup: the freeze time
 *   of the map's first round instead. Open while that warmup (or freeze time) lasts.
 * - **Knife round start:** the freeze time of a knife round (knife-round.ts). A map without one gets
 *   no intro by itself.
 * - **Pistol round start:** the freeze time of the map's first round at 0–0 that isn't a knife round
 *   (after the knife round, when there is one).
 * - **Both pistol rounds:** that, and the freeze time of the second half's first round (13 in MR12:
 *   the active match's regulation rounds / 2 + 1).
 * - **When the match goes live:** the freeze time of the first round after the warmup, whatever it is
 *   (a knife round or the pistol round): the first round 1 at 0–0 the map has.
 *
 * Every moment is in a warmup or a freeze time, never in a live round, and is open only while that
 * lasts: an intro that couldn't start in it doesn't start later. In round 1 the loadouts are read
 * only once the freeze time is LOADOUT_SETTLE_MS old (by the game data's own arrival times), as the
 * first update of a round can still carry the weapons of before.
 */

export const INTRO_TRIGGERS = ["manual", "map_load", "knife", "pistol", "pistols", "match_live"] as const;
export type IntroTrigger = (typeof INTRO_TRIGGERS)[number];

/** As the console says them. */
export const TRIGGER_LABEL: Record<IntroTrigger, string> = {
  manual: "Manual only",
  map_load: "When the map loads",
  knife: "Knife round start",
  pistol: "Pistol round start",
  pistols: "Both pistol rounds",
  match_live: "When the match goes live",
};

/** As the status line says them: "Next intro: Mirage, at pistol round start". */
export const TRIGGER_AT: Record<IntroTrigger, string> = {
  manual: "when you press Play map intro",
  map_load: "when the map loads",
  knife: "at knife round start",
  pistol: "at pistol round start",
  pistols: "at both pistol rounds",
  match_live: "when the match goes live",
};

export type MomentKind = "map_load" | "knife" | "pistol" | "pistol2" | "match_live";

/** As the status says where an intro played. */
export const MOMENT_AT: Record<MomentKind, string> = { map_load: "when the map loaded", knife: "at knife round start", pistol: "at pistol round start", pistol2: "at the second half's pistol round", match_live: "when the match went live" };

/** A moment the chosen trigger has open now. */
export interface IntroMoment {
  kind: MomentKind;
  /** The map, as the game data names it, normalised (de_mirage). */
  map: string;
  /**
   * Which of the map's plays it is (once each per map per match): "first" for the map's start (every
   * trigger's moment but the second half's pistol round), "pistol2" for the second half's first round.
   */
  slot: "first" | "pistol2";
  round: number | null;
  /** This moment, once: the map, the kind and the warmup or freeze time it is in. */
  id: string;
  /** What the knife detector said, in round 1. */
  knife: string | null;
}

/** A map name as the game data gives it ("de_mirage", "workshop/123456/de_mirage", "DE_Mirage"): its last part, in lower case. */
export function normalMap(name: string | null | undefined): string | null {
  const n = (name ?? "").trim().split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return n || null;
}

/** The first round of the second half: 13 in MR12 (24 rounds of regulation), 16 in MR15. */
export const secondHalfStart = (regulation: number): number => Math.floor(regulation / 2) + 1;

/** Round 1's loadouts are trusted once its freeze time is this old (by the game data's arrival times; it comes at least every second). */
export const LOADOUT_SETTLE_MS = 1200;

/** Where a map starts: its warmup, or (a server without one) the freeze time of its first round. */
type StartPhase = "warmup" | "first-freeze";
const startPhase = (s: MatchState): StartPhase | null => (s.mapPhase === "warmup" ? "warmup" : firstRound(s) && s.roundPhase === "freezetime" ? "first-freeze" : null);

export class IntroTriggerWatch {
  /** The map of the last state with one, and of the state before (a change between two maps). */
  private map: string | null = null;
  /** A map whose start was seen (its first state with a known phase was its warmup, or its first freeze time), and which. */
  private loaded: { map: string; phase: StartPhase } | null = null;
  /** The map's first state with a known phase is still to come. */
  private firstOfMap = false;
  /** The freeze time the game data is in: which, and when its first state arrived (the game data's clock). */
  private freeze: { key: string; since: number } | null = null;

  /**
   * One new game state, in order. Returns the change of map it shows (from the last map seen, null at
   * the first; never to "no map": the main menu or a lost connection isn't a change).
   */
  see(s: MatchState): { from: string | null; to: string } | null {
    const m = normalMap(s.mapName);
    let changed: { from: string | null; to: string } | null = null;
    if (m && m !== this.map) {
      changed = { from: this.map, to: m };
      this.map = m;
      this.loaded = null;
      this.firstOfMap = true;
    }
    if (m && this.firstOfMap && s.mapPhase !== "unknown") {
      this.firstOfMap = false;
      const phase = startPhase(s);
      this.loaded = phase ? { map: m, phase } : null;
    }
    // The start seen is over (the warmup ended): its moment closes.
    if (this.loaded && m && s.mapPhase !== "unknown" && (this.loaded.map !== m || startPhase(s) !== this.loaded.phase)) this.loaded = null;
    if (m && s.mapPhase === "live" && s.roundPhase === "freezetime") {
      const key = `${m}|${s.epoch}|${s.roundNumber}|${s.roundAttemptId}`;
      if (this.freeze?.key !== key) this.freeze = { key, since: s.time.receivedAtMonotonicMs };
    } else this.freeze = null;
    return changed;
  }

  /** The moment `trigger` has open in the state last seen, or null. `regulation`: the match's regulation rounds (24 for MR12). */
  moment(s: MatchState, trigger: IntroTrigger, regulation: number): IntroMoment | null {
    const m = normalMap(s.mapName);
    if (!m || m !== this.map || trigger === "manual") return null;
    const at = (kind: MomentKind, slot: IntroMoment["slot"], id: string, knife: string | null = null): IntroMoment => ({ kind, map: m, slot, round: s.roundNumber, id: `${m}|${kind}|${id}`, knife });
    if (trigger === "map_load") return this.loaded?.map === m ? at("map_load", "first", this.loaded.phase) : null;
    const freeze = this.freeze;
    const first = freeze !== null && firstRound(s) && s.roundPhase === "freezetime";
    if (trigger === "match_live") return first ? at("match_live", "first", freeze.key) : null;
    const settled = first && s.time.receivedAtMonotonicMs - freeze.since >= LOADOUT_SETTLE_MS;
    if (trigger === "knife") {
      if (!settled) return null;
      const k = detectKnifeRound(s);
      return k.verdict === "knife" ? at("knife", "first", freeze!.key, k.reason) : null;
    }
    // Pistol round start, both pistol rounds: round 1 unless it's a knife round (no loadouts in the game data: taken as the pistol round).
    if (first) {
      if (!settled) return null;
      const k = detectKnifeRound(s);
      return k.verdict === "knife" ? null : at("pistol", "first", freeze.key, k.reason);
    }
    if (trigger === "pistols" && freeze !== null && s.roundNumber === secondHalfStart(regulation)) return at("pistol2", "pistol2", freeze.key);
    return null;
  }
}
