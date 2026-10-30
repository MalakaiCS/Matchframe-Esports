import type { ReplayPlay } from "@matchframe/replay-agent";

/**
 * Which of a round's clips are worth replaying: each clip gets a score from what it shows, and the
 * replay break plays the best ones that fit, best first (replay/auto.ts). The score is plain sums
 * so the reasons can be shown next to it.
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
/** The cut to the replay and back, per clip (wall time). */
export const CUT_MS = 600;

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
}

/**
 * The next replay of a break: the best-scoring candidate that fits in `availableMs`, its lead-up
 * shortened (down to MIN_LEAD_MS) when that makes it fit. Null when none fits.
 */
export function nextReplay(candidates: readonly PlanCandidate[], availableMs: number, speedPercent: number): { id: string; playMs: number } | null {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  for (const c of sorted) {
    if (replayWallMs(c.playMs, speedPercent) <= availableMs) return { id: c.id, playMs: c.playMs };
    if (c.leadMs === null || c.leadMs <= MIN_LEAD_MS) continue;
    const shortest = c.playMs - (c.leadMs - MIN_LEAD_MS);
    const fits = Math.floor(((availableMs - CUT_MS) * speedPercent) / 100);
    if (fits >= shortest) return { id: c.id, playMs: Math.min(c.playMs, fits) };
  }
  return null;
}
