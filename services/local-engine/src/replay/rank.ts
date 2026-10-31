import type { ReplayPlay } from "@matchframe/replay-agent";

/**
 * Which of a round's clips are worth replaying: each clip gets a score from what it shows, and the
 * replay break plays the best ones that fit, back to back, in round order or best first
 * (replay/auto.ts). The score is plain sums so the reasons can be shown next to it.
 */

/** Points for the number of kills in a clip (a 2K is worth more than two single kills). */
const KILL_POINTS = [0, 10, 24, 42, 64, 90] as const;
/** A won clutch: base, and per opponent. */
const CLUTCH_BASE = 40;
const CLUTCH_PER = 10;
/** Viewers didn't see it live, or saw it only from the player who died. */
const MISSED = 8;
const OTHER_ANGLE = 5;
const KNIFE = 20;
const DEAGLE = 4;
const SNIPER = 3;
const HEADSHOT = 3;
const OPENING = 4;
const CLOSING = 5;
/** Kills this close together (first to last) make a fast multi-kill. */
const FAST_SPAN_MS = 2500;
const FAST = 6;

/** A clip's lead-up (before the first kill) is never shortened below this to fit a break. */
export const MIN_LEAD_MS = 2000;
/** The cut to the replay and back, once a break (wall time). */
export const CUT_MS = 600;
/** From one replay of a break to the next (the next clip loading), wall time. */
export const SWITCH_MS = 400;

/** What the main PC knows about a clip's kills from the round as a whole. */
export interface RankFacts {
  /** The clip has the round's first kill. */
  opening: boolean;
  /** The clip has the round's last kill, by the side that won the round. */
  closing: boolean;
  /** A won clutch: how many opponents were left (2 or more); null otherwise. */
  clutchVersus: number | null;
  /** First to last kill (ms), when the times are known. */
  spanMs: number | null;
}

export const NO_FACTS: RankFacts = { opening: false, closing: false, clutchVersus: null, spanMs: null };

export function clipScore(play: ReplayPlay, facts: RankFacts): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const kills = Math.max(0, Math.min(5, play.kills));
  score += KILL_POINTS[kills] ?? 0;
  if (kills >= 2) reasons.push(kills === 5 ? "ace" : `${kills}K`);
  if (facts.clutchVersus !== null && facts.clutchVersus >= 2) {
    score += CLUTCH_BASE + CLUTCH_PER * facts.clutchVersus;
    reasons.push(`won 1v${facts.clutchVersus}`);
  }
  if (play.kind === "missed") {
    score += MISSED;
    reasons.push("not seen live");
  } else if (play.kind === "other_angle") {
    score += OTHER_ANGLE;
    reasons.push("another angle");
  }
  const weapon = (play.weapon ?? "").replace(/^weapon_/, "").toLowerCase();
  if (/knife|bayonet|karambit|dagger|taser/.test(weapon)) {
    score += KNIFE;
    reasons.push(weapon === "taser" ? "zeus" : "knife");
  } else if (weapon === "deagle" || weapon === "revolver") {
    score += DEAGLE;
    reasons.push(weapon === "deagle" ? "Deagle" : "R8");
  } else if (weapon === "awp" || weapon === "ssg08") {
    score += SNIPER;
    reasons.push(weapon === "awp" ? "AWP" : "Scout");
  }
  if (play.headshot) {
    score += HEADSHOT;
    reasons.push("headshot");
  }
  if (facts.opening) {
    score += OPENING;
    reasons.push("opening kill");
  }
  if (facts.closing) {
    score += CLOSING;
    reasons.push("won the round");
  }
  if (kills >= 2 && facts.spanMs !== null && facts.spanMs <= FAST_SPAN_MS) {
    score += FAST;
    reasons.push("fast");
  }
  return { score, reasons };
}

/** Wall time a replay of `playMs` takes at `speedPercent`, with its cuts. */
export const replayWallMs = (playMs: number, speedPercent: number): number => (playMs * 100) / speedPercent + CUT_MS;

export interface PlanCandidate {
  id: string;
  score: number;
  /** How much of the clip to show, and how much of that is before the first kill (null: unknown, never shortened). */
  playMs: number;
  leadMs: number | null;
  /** When its play happened in the round (any clock, the same for every candidate), for round order. */
  at?: number | null;
}

/**
 * How much of a clip fits in `availableMs` with `overheadMs` of cuts: all of it, or its lead-up
 * shortened (down to MIN_LEAD_MS) when that makes it fit. Null when it doesn't fit.
 */
export function fitReplay(c: Pick<PlanCandidate, "playMs" | "leadMs">, availableMs: number, speedPercent: number, overheadMs = CUT_MS): number | null {
  if ((c.playMs * 100) / speedPercent + overheadMs <= availableMs) return c.playMs;
  if (c.leadMs === null || c.leadMs <= MIN_LEAD_MS) return null;
  const shortest = c.playMs - (c.leadMs - MIN_LEAD_MS);
  const fits = Math.floor(((availableMs - overheadMs) * speedPercent) / 100);
  return fits >= shortest ? Math.min(c.playMs, fits) : null;
}

/**
 * The next replay of a break: the best-scoring candidate that fits in `availableMs`, its lead-up
 * shortened (down to MIN_LEAD_MS) when that makes it fit. Null when none fits.
 */
export function nextReplay(candidates: readonly PlanCandidate[], availableMs: number, speedPercent: number, overheadMs = CUT_MS): { id: string; playMs: number } | null {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  for (const c of sorted) {
    const playMs = fitReplay(c, availableMs, speedPercent, overheadMs);
    if (playMs !== null) return { id: c.id, playMs };
  }
  return null;
}

/**
 * A break's replays, played back to back: the best candidates that fit together in `availableMs`
 * (one cut to the replay and back, SWITCH_MS from one clip to the next), up to `max`, chosen as
 * nextReplay chooses. Then in round order (earliest play first, an unknown time last) or best first.
 */
export function planBreak(candidates: readonly PlanCandidate[], availableMs: number, speedPercent: number, max: number, order: "round" | "best" = "round"): { id: string; playMs: number; leadMs: number | null }[] {
  const chosen: { c: PlanCandidate; playMs: number }[] = [];
  let left = availableMs;
  let rest = [...candidates];
  while (chosen.length < max) {
    const overhead = chosen.length ? SWITCH_MS : CUT_MS;
    const pick = nextReplay(rest, left, speedPercent, overhead);
    if (!pick) break;
    const c = rest.find((x) => x.id === pick.id)!;
    chosen.push({ c, playMs: pick.playMs });
    left -= (pick.playMs * 100) / speedPercent + overhead;
    rest = rest.filter((x) => x !== c);
  }
  const at = (x: { c: PlanCandidate }) => x.c.at ?? Number.MAX_SAFE_INTEGER;
  if (order === "round") chosen.sort((a, b) => at(a) - at(b));
  // A shortened clip keeps what is left of its lead-up (it may be shortened again to fit later).
  return chosen.map(({ c, playMs }) => ({ id: c.id, playMs, leadMs: c.leadMs === null ? null : c.leadMs - (c.playMs - playMs) }));
}
