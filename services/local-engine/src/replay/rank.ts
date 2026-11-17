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
/** From one replay of a break to the next, wall time (planned as a gap; a fade between them overlaps the two instead). */
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
  /**
   * Slow motion around its kills makes it this much longer (wall ms; ADR-081). The lead-up before the
   * first kill isn't slowed, so shortening it leaves this as it is.
   */
  extraMs?: number;
  /** Its own speed (percent; the whole clip slowed), instead of the break's. */
  speedPercent?: number;
  /**
   * The moment's extra angles (ADR-081): played straight after it, each this long on air (wall ms, its
   * slow motion counted) with a switch before it. They take the time the break's clips leave, never a
   * clip's place, unless `anglesFirst`.
   */
  angles?: { id: string; wallMs: number }[];
  /** The operator starred it: its extra angles are part of it (chosen with it when they fit, before other clips). */
  anglesFirst?: boolean;
}

/** Wall time of `playMs` of a candidate: at its speed (or the break's), with its slow motion. */
export const clipWallMs = (c: Pick<PlanCandidate, "extraMs" | "speedPercent">, playMs: number, speedPercent: number): number => (playMs * 100) / (c.speedPercent ?? speedPercent) + (c.extraMs ?? 0);

/** Wall time of a moment's extra angles after it (each with its switch). */
const anglesWallMs = (c: Pick<PlanCandidate, "angles">): number => (c.angles ?? []).reduce((n, a) => n + a.wallMs + SWITCH_MS, 0);

/**
 * How much of a clip fits in `availableMs` with `overheadMs` of cuts: all of it, or its lead-up
 * shortened (down to MIN_LEAD_MS) when that makes it fit. Null when it doesn't fit.
 */
export function fitReplay(c: Pick<PlanCandidate, "playMs" | "leadMs" | "extraMs" | "speedPercent">, availableMs: number, speedPercent: number, overheadMs = CUT_MS): number | null {
  const speed = c.speedPercent ?? speedPercent;
  const extra = c.extraMs ?? 0;
  if ((c.playMs * 100) / speed + extra + overheadMs <= availableMs) return c.playMs;
  if (c.leadMs === null || c.leadMs <= MIN_LEAD_MS) return null;
  const shortest = c.playMs - (c.leadMs - MIN_LEAD_MS);
  const fits = Math.floor(((availableMs - overheadMs - extra) * speed) / 100);
  return fits >= shortest ? Math.min(c.playMs, fits) : null;
}

/** A candidate (a starred one with its extra angles when they fit with it), else alone: how much of it to show, and which angles follow it. */
function fitMoment(c: PlanCandidate, availableMs: number, speedPercent: number, overheadMs: number): { playMs: number; angles: string[] } | null {
  if (c.angles?.length && c.anglesFirst) {
    const playMs = fitReplay(c, availableMs - anglesWallMs(c), speedPercent, overheadMs);
    if (playMs !== null) return { playMs, angles: c.angles.map((a) => a.id) };
  }
  const playMs = fitReplay(c, availableMs, speedPercent, overheadMs);
  return playMs === null ? null : { playMs, angles: [] };
}

/** Wall time a chosen moment takes: the clip, its cuts, and the extra angles that follow it. */
const momentWallMs = (c: PlanCandidate, fit: { playMs: number; angles: string[] }, speedPercent: number, overheadMs: number): number =>
  clipWallMs(c, fit.playMs, speedPercent) + overheadMs + (c.angles ?? []).filter((a) => fit.angles.includes(a.id)).reduce((n, a) => n + a.wallMs + SWITCH_MS, 0);

/**
 * The next replay of a break: the best-scoring candidate that fits in `availableMs`, its lead-up
 * shortened (down to MIN_LEAD_MS) when that makes it fit (a starred one with its extra angles when
 * they fit too). Null when none fits.
 */
export function nextReplay(candidates: readonly PlanCandidate[], availableMs: number, speedPercent: number, overheadMs = CUT_MS): { id: string; playMs: number; angles: string[] } | null {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  for (const c of sorted) {
    const fit = fitMoment(c, availableMs, speedPercent, overheadMs);
    if (fit) return { id: c.id, ...fit };
  }
  return null;
}

/** A chosen replay of a break: how much to show, what is left of its lead-up, and the extra angles that follow it. */
export interface PlannedReplay {
  id: string;
  playMs: number;
  leadMs: number | null;
  angles: string[];
}

/**
 * A break's replays, played back to back: the best candidates that fit together in `availableMs`
 * (one cut to the replay and back, SWITCH_MS from one clip to the next), up to `max`, chosen as
 * nextReplay chooses. Then in round order (earliest play first, an unknown time last) or best first.
 * A clip the operator pinned (`pinned`) is chosen first and plays first, if it fits. A moment's extra
 * angles follow it (they don't count towards `max`): with the time the chosen clips leave, best moment
 * first (a starred moment's are chosen with it).
 */
export function planBreak(candidates: readonly PlanCandidate[], availableMs: number, speedPercent: number, max: number, order: "round" | "best" = "round", pinned: string | null = null): PlannedReplay[] {
  const chosen: { c: PlanCandidate; playMs: number; angles: string[] }[] = [];
  let left = availableMs;
  let rest = [...candidates];
  const pin = pinned ? rest.find((x) => x.id === pinned) : undefined;
  const pinFit = pin ? fitMoment(pin, left, speedPercent, CUT_MS) : null;
  if (pin && pinFit) {
    chosen.push({ c: pin, ...pinFit });
    left -= momentWallMs(pin, pinFit, speedPercent, CUT_MS);
    rest = rest.filter((x) => x !== pin);
  }
  while (chosen.length < max) {
    const overhead = chosen.length ? SWITCH_MS : CUT_MS;
    const pick = nextReplay(rest, left, speedPercent, overhead);
    if (!pick) break;
    const c = rest.find((x) => x.id === pick.id)!;
    chosen.push({ c, playMs: pick.playMs, angles: pick.angles });
    left -= momentWallMs(c, pick, speedPercent, overhead);
    rest = rest.filter((x) => x !== c);
  }
  // The extra angles of the chosen moments, in the time left (best moment first).
  for (const m of [...chosen].sort((a, b) => b.c.score - a.c.score)) {
    for (const a of m.c.angles ?? []) {
      if (m.angles.includes(a.id) || a.wallMs + SWITCH_MS > left) continue;
      m.angles.push(a.id);
      left -= a.wallMs + SWITCH_MS;
    }
  }
  const at = (x: { c: PlanCandidate }) => (x.c === pin ? Number.MIN_SAFE_INTEGER : (x.c.at ?? Number.MAX_SAFE_INTEGER));
  if (order === "round") chosen.sort((a, b) => at(a) - at(b));
  // A shortened clip keeps what is left of its lead-up (it may be shortened again to fit later).
  return chosen.map(({ c, playMs, angles }) => ({ id: c.id, playMs, leadMs: c.leadMs === null ? null : c.leadMs - (c.playMs - playMs), angles }));
}
