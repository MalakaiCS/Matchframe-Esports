import type { CameraPath, CameraRecord, MatchState, ReasonCode, ScoreComponents, ShotClass, SourceCapabilities, Vec3 } from "@matchframe/contracts";
import { projectCountdown } from "@matchframe/cs2-state";
import type { Pin, ScoredCandidate } from "./candidates.ts";
import { utilityOf } from "./candidates.ts";
import type { DirectorConfig } from "./config.ts";
import type { InteractionFeatures } from "./features/interactions.ts";
import type { MatchMoment } from "./features/moments.ts";
import type { RoundContext } from "./features/significance.ts";
import type { CameraMatch } from "@matchframe/map-runtime";
import type { TeamShot, TeamShotLook } from "./framing.ts";
import { teamCameraId } from "./framing.ts";
import type { ShotKey } from "./shots.ts";
import { cameraShot, pathShot } from "./shots.ts";
import type { UtilityDirectorMap } from "./utility/opportunities.ts";

export interface CinematicInput {
  state: MatchState;
  now: number;
  cfg: DirectorConfig;
  currentShot: ShotKey | null;
  interactions: InteractionFeatures;
  round: RoundContext;
  capabilities: SourceCapabilities | null;
  pin: Pin | null;
  oneSide: MatchState["players"][number]["side"] | null;
  cinematicsAllowed: { allowed: boolean; reason: ReasonCode | null };
  map?: UtilityDirectorMap | undefined;
  /** When the current shot started (monotonic ms). */
  currentShotSinceMs?: number | null | undefined;
  /** Cinematic shots already played this round (none plays twice in a round). */
  shownThisRound?: ReadonlySet<ShotKey> | undefined;
  /** Rounds since a shot last played (1: last round), null if not lately: recent ones give way to others. */
  roundsSinceShown?: ((shot: ShotKey) => number | null) | undefined;
  /** Clear line between two points in the map's free-space grid, when the map has one. */
  sight?: ((a: Vec3, b: Vec3) => boolean) | undefined;
  /** How long the round has been live (ms), or null outside a live round. */
  liveForMs?: number | null | undefined;
  /**
   * A tactical or technical pause in this freeze time (from when it began until the round goes live):
   * the side whose spawn to hold on (the team that called the timeout; null for a technical pause),
   * and when it began (monotonic ms).
   */
  pause?: { side: "T" | "CT" | null; since: number } | null | undefined;
  /**
   * A shot of one team from where its players stand (the map's free-space grid frames it), gliding
   * slowly round them, or still; null when no spot frames them. Absent without a grid.
   */
  teamShot?: ((side: "T" | "CT", still: boolean, look?: TeamShotLook) => TeamShot | null) | undefined;
  /** How long the round has been over (ms), or null while it isn't. */
  overForMs?: number | null | undefined;
  /** Where the match stands: pistol round, match point, half time, map end, the last round's winner. */
  moment?: MatchMoment | null | undefined;
}

/** Freeze time shorter than this is not worth an establishing shot. */
const ESTABLISHING_MIN_LEFT_SEC = 3;
/** Freeze time is shared between shots of at most this long (a long freeze time gets more of them)... */
const ESTABLISHING_SHOT_MAX_SEC = 12;
/** ...and at least this long. */
const ESTABLISHING_SHOT_MIN_SEC = 4;
/** The last shot of a freeze time is planned past its end: the cut to first person comes when the round goes live. */
const ESTABLISHING_OVERRUN_MS = 1500;
/** The shot a pause (tactical or technical timeout) is held on lasts until the round goes live, up to this. */
export const PAUSE_HOLD_MS = 180_000;
/** The winners' shot starts this long after the round ends (the last kill stays on air first). */
const WINNER_DELAY_MS = 2000;
/** A team whose players have less than this on average (money and equipment) is on an eco. */
const ECO_VALUE = 2500;
/** Team-shot looks, in turn from round to round (with variety on). */
const LOOKS: readonly TeamShotLook[] = ["eye", "high", "side", "eye", "low"];
/** A camera or path that played 1, 2 or 3 rounds ago scores this much lower (variety across rounds). */
const RECENT_PENALTY = [0, 0.18, 0.1, 0.05];
const recentPenalty = (input: CinematicInput, key: ShotKey): number => {
  const r = input.roundsSinceShown?.(key);
  return r == null ? 0 : (RECENT_PENALTY[r] ?? 0);
};
/** Freeze-time shots from the map's cameras turn slowly: degrees a second, and at most this far in a shot. */
const PAN_DEG_PER_SEC = 3;
const PAN_MAX_DEG = 30;
/** An establishing shot must show at least this many players (fewer when fewer are alive). */
const ESTABLISHING_MIN_PLAYERS = 2;
/** A player this far from a camera (units) is too small in the shot to count. */
const ESTABLISHING_VIEW_RANGE = 2600;
/** Fights shown from a static camera: at least this many players, both sides, likely contact. */
const FIGHT_MIN_PLAYERS = 3;
const FIGHT_MIN_ACTION = 0.55;
/** Bomb shots: defuse in progress, or the last seconds of the bomb timer. */
const BOMB_CRITICAL_SEC = 10;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

function cameraControlUsable(caps: SourceCapabilities | null): boolean {
  const s = caps?.staticCameraControl.support;
  return s === "supported" || s === "partial";
}

function pathControlUsable(caps: SourceCapabilities | null): boolean {
  const s = caps?.cameraPathControl.support;
  return s === "supported" || s === "partial";
}

/** Path length in milliseconds (its last keyframe). */
export const pathDurationMs = (p: CameraPath): number => p.keyframes[p.keyframes.length - 1]!.tMs;

interface Trigger {
  shotClass: Extract<ShotClass, "establishing" | "bomb_resolution" | "static_tactical">;
  match: CameraMatch;
  value: number;
  reasons: ReasonCode[];
  significance: number;
  narrative: number;
  imminence: number;
  readiness: number;
}

/**
 * Cinematic shots that are not about utility (Observer & Cinematics and Full Action Observer): an
 * establishing shot during freeze time (a camera path flying around a site, or a static camera),
 * the bomb at plant/defuse resolution, and an overview of a fight with several players from both
 * sides. Cameras and paths come only from the map pack: operator-validated ones and the built-in
 * ones placed from map data (see MapRuntime.builtInCameras), with the matching action class and
 * phase. Nade cameras are the utility candidates in candidates.ts.
 */
export function cinematicCandidates(input: CinematicInput): ScoredCandidate[] {
  const { state, map, cfg } = input;
  if (!map || map.mapName !== state.mapName) return [];
  const m = input.moment;
  // Half time and the end of the map: slow shots of the map and the teams, the winners first.
  if (m && cfg.cinematic.bigMoments && (m.halfTime || m.mapEnd)) return establishingCandidates(input, new Set(), m.mapEnd ? "map_end" : "half_time");
  const phase = state.roundPhase === "freezetime" ? "freezetime" : state.roundPhase === "live" ? "live" : state.roundPhase === "over" ? "over" : null;
  if (!phase) return [];
  const inPhase = (cam: CameraRecord) => cam.allowedPhases.includes(phase);
  const triggers: Trigger[] = [];
  // First person from the start of a live round: no fight overview in its first seconds.
  const earlyLive = phase === "live" && input.liveForMs != null && input.liveForMs < cfg.cinematic.liveStartPovMs;

  const r = input.round;
  if (phase === "live" && r.bombPlanted && r.bombPosition) {
    const defusing = r.bombState === "defusing";
    const critical = r.bombRemainingSec !== null && r.bombRemainingSec < BOMB_CRITICAL_SEC;
    if (defusing || critical) {
      for (const match of map.camerasCovering(r.bombPosition, { actionClass: "bomb" }).filter((m) => inPhase(m.camera))) {
        triggers.push({
          shotClass: "bomb_resolution",
          match,
          value: defusing ? 0.85 : 0.7,
          reasons: [defusing ? "BOMB_DEFUSE_PRESSURE" : "BOMB_CRITICAL"],
          significance: 1,
          narrative: 0.5,
          imminence: 1,
          readiness: 0.5,
        });
      }
    }
  }

  if (phase === "live" && !earlyLive) {
    for (const c of input.interactions.clusters) {
      if (c.members.length < FIGHT_MIN_PLAYERS || c.tCount < 1 || c.ctCount < 1 || c.actionValue < FIGHT_MIN_ACTION) continue;
      const value = clamp01(c.actionValue * Math.min(1, c.members.length / 4));
      for (const match of map.camerasCovering(c.centroid, { actionClass: "tactical" }).filter((m) => inPhase(m.camera))) {
        triggers.push({ shotClass: "static_tactical", match, value, reasons: ["CONTACT_LIKELY_SOON", "MAIN_STORY"], significance: 0.4, narrative: 0.5, imminence: clamp01(c.maxContact["2"] ?? c.actionValue), readiness: 0.5 });
      }
    }
  }

  const out: ScoredCandidate[] = [];
  const seen = new Set<string>();

  if (phase === "freezetime") out.push(...establishingCandidates(input, seen));
  if (phase === "over") out.push(...winnerCandidates(input, seen));
  for (const t of triggers.sort((a, b) => b.value - a.value)) {
    const cam = t.match.camera;
    const key = cameraShot(cam.id);
    if (seen.has(key)) continue;
    seen.add(key);
    const isCurrent = input.currentShot === key;
    const reasons: ReasonCode[] = [...t.reasons];
    let valid = true;
    let invalidReason: string | null = null;
    if (!input.cinematicsAllowed.allowed && !isCurrent) {
      valid = false;
      invalidReason = "cinematics not allowed";
      if (input.cinematicsAllowed.reason) reasons.push(input.cinematicsAllowed.reason);
    }
    if (!cameraControlUsable(input.capabilities)) {
      valid = false;
      invalidReason = "static camera control not verified for this environment";
      reasons.push("CAMERA_UNVERIFIED");
    }
    if (t.value < cfg.cinematic.minValue) {
      valid = false;
      invalidReason = "below the cinematic threshold";
    }
    if (input.oneSide || (input.pin && input.pin.kind !== "cluster")) {
      valid = false;
      invalidReason = "pinned/one-side profile active";
    }
    if (valid) reasons.push("CINEMATIC_ELIGIBLE");
    const components: ScoreComponents = {
      actionCoverage: clamp01(t.value - (isCurrent || t.shotClass === "bomb_resolution" ? 0 : recentPenalty(input, key))),
      imminence: t.imminence,
      readiness: t.readiness,
      significance: t.significance,
      narrative: t.narrative,
      framing: clamp01(1 - 0.5 * t.match.centrality),
      continuity: isCurrent ? 1 : 0,
      mainStory: 0,
      switchCost: isCurrent ? 0 : cfg.baseSwitchCost + 0.02,
      stalenessPenalty: 0,
      cinematicOpportunityCost: t.shotClass === "static_tactical" ? 0.05 : 0.03,
    };
    out.push({
      candidateId: `cand:${key}:${t.shotClass}`,
      shotClass: t.shotClass,
      shotKey: key,
      targetSteamId: null,
      cameraId: cam.id,
      clusterId: null,
      regionIds: cam.targetRegionIds,
      components,
      utility: valid ? utilityOf(components, cfg.weights) : -1,
      reasonCodes: [...new Set(reasons)],
      valid,
      invalidReason,
      evidenceType: "estimated",
      opportunity: null,
      plannedDurationMs: Math.min(cam.normalDurationMs, cam.maxDurationMs, cfg.cinematic.maxDurationMs),
      urgent: false,
    });
  }
  return out;
}

/**
 * Freeze-time establishing shots: the teams where they stand, for the whole freeze time. First the
 * team shots: each team framed from where its players stand (see frameTeam), the camera gliding
 * slowly round them; one team, then the other (the Ts first in even rounds). Then, or when a team
 * can't be framed, the map's spawn cameras, scored by how many alive players they show (standing in
 * the regions they are aimed at, or in clear view within range in the free-space grid). Shots showing
 * fewer than two players are left out, a shot already played this round is never played again, and
 * a team not yet shown this freeze time is preferred. The time left is shared between shots of
 * 4–12 s, each moving slowly, and the last one runs until the round goes live. Each may follow the
 * one before directly. Camera paths only with `freezeTimePaths`.
 *
 * In a pause (tactical or technical timeout) the camera cuts to a still shot of one team (the team
 * that called it) and stays there until the round goes live.
 */
function establishingCandidates(input: CinematicInput, seen: Set<string>, mode: "freeze" | "half_time" | "map_end" = "freeze"): ScoredCandidate[] {
  const { state, map, cfg } = input;
  if (!map) return [];
  const interval = mode !== "freeze";
  const left = projectCountdown({ countdownSec: state.phaseEndsInSec, observedAtMonotonicMs: state.phaseObservedAtMonotonicMs, nowMonotonicMs: input.now, running: !state.paused }).remainingSec;
  const shown = input.shownThisRound ?? new Set<ShotKey>();
  const playedEstablishing = [...shown].filter((k) => !k.startsWith("pov:")).length;
  const alive = state.players.filter((p) => p.lifeState === "alive" && p.position && p.side);
  const need = Math.min(ESTABLISHING_MIN_PLAYERS, Math.max(1, alive.length));
  const regionsOf = new Map(alive.map((p) => [p.steamId, map.regionsAt(p.position!)]));
  /** The players a shot from `from`, aimed at `regions`, shows. */
  const inView = (from: Vec3, regions: readonly string[]) =>
    alive.filter((p) => {
      if (regionsOf.get(p.steamId)!.some((r) => regions.includes(r))) return true;
      const eye = { x: p.position!.x, y: p.position!.y, z: p.position!.z + 64 };
      return !!input.sight && Math.hypot(eye.x - from.x, eye.y - from.y) < ESTABLISHING_VIEW_RANGE && input.sight(from, eye);
    });
  // The next shot's length: the time left shared out, the last one running until the round goes live.
  const shotsLeft = left === null ? 2 : Math.max(1, Math.ceil(left / ESTABLISHING_SHOT_MAX_SEC));
  const nextMs = Math.min(
    cfg.cinematic.establishingMaxMs,
    left === null ? 8000 : shotsLeft === 1 ? left * 1000 + ESTABLISHING_OVERRUN_MS : Math.max(ESTABLISHING_SHOT_MIN_SEC * 1000, (left * 1000) / shotsLeft),
  );
  const options: EstablishingOption[] = [];
  const plan = freezePlan(input, mode);
  const firstSide = plan.sides[0] ?? ((state.roundNumber ?? 0) % 2 === 0 ? "T" : "CT");
  // One longer shot of one team: most of the freeze time.
  const longMs = left === null ? 10_000 : Math.min(cfg.cinematic.establishingMaxMs, Math.max(nextMs, left * 1000 * 0.7));
  // Team shots first (still ones in a pause).
  plan.sides.forEach((side, i) => {
    const look = input.pause || interval || !cfg.cinematic.variety ? "eye" : LOOKS[((state.roundNumber ?? 0) + 2 * i) % LOOKS.length]!;
    const shot = input.teamShot?.(side, !!input.pause, look);
    if (!shot) return;
    const ids = new Set(shot.steamIds);
    const key = cameraShot(teamCameraId(side, !!input.pause, interval ? "break" : null));
    options.push({ key, shotClass: "establishing", camera: null, path: null, team: { side, shot }, regionIds: [], durationMs: plan.longSide === side ? longMs : nextMs, players: alive.filter((p) => ids.has(p.steamId)) });
  });
  for (const m of map.camerasWith?.({ actionClass: "establishing", phase: "freezetime" }) ?? []) {
    const cam = m.camera;
    options.push({ key: cameraShot(cam.id), shotClass: "establishing", camera: cam, path: null, regionIds: cam.targetRegionIds, durationMs: nextMs, players: inView(cam.position, cam.targetRegionIds) });
  }
  if (cfg.cinematic.freezeTimePaths && !input.pause) {
    for (const path of map.pathsFor?.() ?? []) {
      const mid = path.keyframes[Math.floor(path.keyframes.length / 2)]!;
      options.push({ key: pathShot(path.id), shotClass: "camera_path", camera: null, path, regionIds: path.targetRegionIds, durationMs: Math.min(pathDurationMs(path), nextMs), players: inView(mid.position, path.targetRegionIds) });
    }
  }
  if (input.pause) return pauseCandidates(input, options, need, seen);
  // The side of the spawn each shot already played this round showed (the other spawn comes next).
  const shownSides = new Set<string>();
  for (const o of options) if (shown.has(o.key)) for (const p of o.players) shownSides.add(p.side!);
  // Turning one way, then the other (starting the other way round each round).
  const panSign = (playedEstablishing + (state.roundNumber ?? 0)) % 2 === 0 ? 1 : -1;
  const out: ScoredCandidate[] = [];
  for (const o of options) {
    const isCurrent = input.currentShot === o.key;
    if (seen.has(o.key) || (shown.has(o.key) && !isCurrent) || o.players.length < need) continue;
    // A new shot needs the time to play it, and fits the freeze time's quota.
    if (!isCurrent && (playedEstablishing >= (interval ? 12 : cfg.cinematic.establishingPerRound) || (left !== null && left < ESTABLISHING_MIN_LEFT_SEC))) continue;
    seen.add(o.key);
    const sides = new Set(o.players.map((p) => p.side!));
    const fresh = [...sides].some((x) => !shownSides.has(x));
    const reasons: ReasonCode[] = ["ESTABLISHING", ...plan.reasons];
    let valid = true;
    let invalidReason: string | null = null;
    if (!input.cinematicsAllowed.allowed && !isCurrent && !(interval && input.cinematicsAllowed.reason === "CINEMATIC_BUDGET_EXHAUSTED")) {
      valid = false;
      invalidReason = "cinematics not allowed";
      if (input.cinematicsAllowed.reason) reasons.push(input.cinematicsAllowed.reason);
    }
    if (!(o.path ? pathControlUsable(input.capabilities) : cameraControlUsable(input.capabilities))) {
      valid = false;
      invalidReason = o.path ? "camera path control not verified for this environment" : "static camera control not verified for this environment";
      reasons.push("CAMERA_UNVERIFIED");
    }
    if (input.oneSide || (input.pin && input.pin.kind !== "cluster")) {
      valid = false;
      invalidReason = "pinned/one-side profile active";
    }
    if (valid) reasons.push("CINEMATIC_ELIGIBLE");
    // More players in the shot, a team not shown yet, and a path (when they are on) over a still
    // camera; a team shot tells the story better than the map's cameras (the team whose turn it is first).
    // The map's cameras and paths that played in the last rounds give way to others (team shots are
    // framed afresh from where the players stand, so they never repeat).
    const coverage = clamp01(0.45 + 0.08 * o.players.length + (fresh ? 0.12 : 0) + (o.path ? 0.04 : 0) - (o.team || isCurrent ? 0 : recentPenalty(input, o.key)));
    const components: ScoreComponents = {
      actionCoverage: coverage,
      imminence: 0.5,
      readiness: 0.5,
      significance: 0.5,
      // A pistol round opens wide: the map's camera first (when one shows the players), then the teams.
      narrative: o.team ? (o.team.side === firstSide ? 0.95 : 0.94) : plan.opener && playedEstablishing === 0 ? 0.97 : 0.7,
      framing: 1,
      continuity: isCurrent ? 1 : 0,
      mainStory: 0,
      switchCost: isCurrent ? 0 : cfg.baseSwitchCost + 0.02,
      stalenessPenalty: 0,
      cinematicOpportunityCost: 0.03,
    };
    out.push({
      candidateId: `cand:${o.key}:${o.shotClass}`,
      shotClass: o.shotClass,
      shotKey: o.key,
      targetSteamId: null,
      cameraId: o.camera?.id ?? (o.team ? teamCameraId(o.team.side, !!input.pause, interval ? "break" : null) : null),
      clusterId: null,
      regionIds: o.regionIds,
      components,
      utility: valid ? utilityOf(components, cfg.weights) : -1,
      reasonCodes: reasons,
      valid,
      invalidReason,
      evidenceType: "estimated",
      opportunity: null,
      plannedDurationMs: o.durationMs,
      urgent: false,
      chain: true,
      panDegPerSec: o.camera ? panSign * Math.min(PAN_DEG_PER_SEC, PAN_MAX_DEG / (o.durationMs / 1000)) : 0,
      ...(o.team ? { framing: { from: o.team.shot.from, to: o.team.shot.to, focus: o.team.shot.focus } } : {}),
    });
  }
  return out;
}

/**
 * Which team shots a freeze time (or half time, the map's end) has, in order: a pistol round opens
 * with the map's camera; the team on match point comes first and longer; with variety on, a team on
 * an eco gets no team shot and every third round has one longer shot of one team. Half time: the
 * team ahead first; the map's end: the winners first.
 */
function freezePlan(input: CinematicInput, mode: "freeze" | "half_time" | "map_end"): { sides: ("T" | "CT")[]; longSide: "T" | "CT" | null; opener: boolean; reasons: ReasonCode[] } {
  const { state, cfg } = input;
  const m = cfg.cinematic.bigMoments ? input.moment : null;
  const other = (s: "T" | "CT") => (s === "T" ? "CT" : "T");
  const turn: "T" | "CT" = (state.roundNumber ?? 0) % 2 === 0 ? "T" : "CT";
  const both = (first: "T" | "CT") => [first, other(first)];
  if (mode !== "freeze") {
    const t = state.teams.T.score ?? 0;
    const ct = state.teams.CT.score ?? 0;
    const lead = mode === "map_end" && input.moment?.lastWinner ? input.moment.lastWinner : t === ct ? turn : t > ct ? "T" : "CT";
    return { sides: both(lead), longSide: null, opener: false, reasons: [mode === "map_end" ? "MAP_END" : "HALF_TIME"] };
  }
  if (input.pause) return { sides: both(turn), longSide: null, opener: false, reasons: [] };
  if (m?.matchPoint.length === 1) return { sides: both(m.matchPoint[0]!), longSide: m.matchPoint[0]!, opener: false, reasons: ["MATCH_POINT"] };
  if (m?.matchPoint.length === 2) return { sides: both(turn), longSide: null, opener: false, reasons: ["MATCH_POINT"] };
  if (m?.pistol) return { sides: both(turn), longSide: null, opener: true, reasons: ["PISTOL_ROUND"] };
  if (!cfg.cinematic.variety) return { sides: both(turn), longSide: null, opener: false, reasons: [] };
  const value = (side: "T" | "CT") => {
    const team = state.players.filter((p) => p.side === side && !p.coach);
    const known = team.filter((p) => p.money !== null || p.equipValue !== null);
    return known.length ? known.reduce((s, p) => s + (p.money ?? 0) + (p.equipValue ?? 0), 0) / known.length : null;
  };
  const eco = (["T", "CT"] as const).filter((s) => {
    const v = value(s);
    return v !== null && v < ECO_VALUE;
  });
  if (eco.length === 1) return { sides: [other(eco[0]!)], longSide: null, opener: false, reasons: [] };
  if ((state.roundNumber ?? 0) % 3 === 0) return { sides: [turn], longSide: turn, opener: false, reasons: [] };
  return { sides: both(turn), longSide: null, opener: false, reasons: [] };
}

/**
 * After the round: the winners, framed where they stand and gliding slowly, from 2 s after the round
 * ends (the last kill stays on air first) until the next freeze time. Every round, big rounds only
 * (pistol rounds, the end of a half, match point, the map), or never (`winnerShots`).
 */
function winnerCandidates(input: CinematicInput, seen: Set<string>): ScoredCandidate[] {
  const { cfg, state } = input;
  const m = input.moment;
  const mode = cfg.cinematic.winnerShots;
  if (!m?.lastWinner || mode === "off" || (mode === "big_rounds" && !m.lastRoundBig) || !input.teamShot) return [];
  const id = teamCameraId(m.lastWinner, false, "win");
  const key = cameraShot(id);
  const isCurrent = input.currentShot === key;
  if (seen.has(key) || (!isCurrent && ((input.overForMs ?? 0) < WINNER_DELAY_MS || input.shownThisRound?.has(key)))) return [];
  const shot = input.teamShot(m.lastWinner, false, "eye");
  if (!shot) return [];
  seen.add(key);
  const left = projectCountdown({ countdownSec: state.phaseEndsInSec, observedAtMonotonicMs: state.phaseObservedAtMonotonicMs, nowMonotonicMs: input.now, running: !state.paused }).remainingSec;
  const durationMs = Math.max(2500, Math.min(8000, left === null ? 4000 : left * 1000 + 500));
  const reasons: ReasonCode[] = ["ROUND_WINNERS"];
  let valid = true;
  let invalidReason: string | null = null;
  // The round's cinematic budget is for the live round; a disabled or clutch-only director still says no.
  if (!input.cinematicsAllowed.allowed && !isCurrent && input.cinematicsAllowed.reason !== "CINEMATIC_BUDGET_EXHAUSTED" && input.cinematicsAllowed.reason !== "CLUTCH") {
    valid = false;
    invalidReason = "cinematics not allowed";
    if (input.cinematicsAllowed.reason) reasons.push(input.cinematicsAllowed.reason);
  }
  if (!cameraControlUsable(input.capabilities)) {
    valid = false;
    invalidReason = "static camera control not verified for this environment";
    reasons.push("CAMERA_UNVERIFIED");
  }
  if (input.oneSide || (input.pin && input.pin.kind !== "cluster")) {
    valid = false;
    invalidReason = "pinned/one-side profile active";
  }
  if (valid) reasons.push("CINEMATIC_ELIGIBLE");
  const components: ScoreComponents = {
    actionCoverage: 0.8,
    imminence: 0.3,
    readiness: 0.5,
    significance: m.lastRoundBig ? 0.9 : 0.6,
    narrative: 0.9,
    framing: 1,
    continuity: isCurrent ? 1 : 0,
    mainStory: 0,
    switchCost: isCurrent ? 0 : cfg.baseSwitchCost + 0.02,
    stalenessPenalty: 0,
    cinematicOpportunityCost: 0.03,
  };
  return [
    {
      candidateId: `cand:${key}:establishing`,
      shotClass: "establishing",
      shotKey: key,
      targetSteamId: null,
      cameraId: id,
      clusterId: null,
      regionIds: [],
      components,
      utility: valid ? utilityOf(components, cfg.weights) : -1,
      reasonCodes: reasons,
      valid,
      invalidReason,
      evidenceType: "estimated",
      opportunity: null,
      plannedDurationMs: durationMs,
      urgent: false,
      framing: { from: shot.from, to: shot.to, focus: shot.focus },
    },
  ];
}

interface EstablishingOption {
  key: ShotKey;
  shotClass: "establishing" | "camera_path";
  camera: CameraRecord | null;
  path: CameraPath | null;
  /** A team shot. */
  team?: { side: "T" | "CT"; shot: TeamShot };
  regionIds: string[];
  durationMs: number;
  players: MatchState["players"];
}

/**
 * In a pause: a still shot of the team that called it (for a technical pause, the team the camera
 * already shows, else the Ts), held until the round goes live: their team shot, or else a spawn
 * camera showing them. A shot that was on air before the pause gives way to it at once; the pause
 * shot may be one already played this round.
 */
function pauseCandidates(input: CinematicInput, options: EstablishingOption[], need: number, seen: Set<string>): ScoredCandidate[] {
  const { cfg, pause } = input;
  const cams = options.filter((o) => (o.camera || o.team) && o.players.length >= need);
  const current = cams.find((o) => o.key === input.currentShot);
  const majority = (o: EstablishingOption) => o.team?.side ?? (o.players.filter((p) => p.side === "CT").length > o.players.length / 2 ? "CT" : "T");
  const side = pause!.side ?? (current ? majority(current) : "T");
  // The team shot of that side first.
  const ofSide = cams.filter((o) => majority(o) === side).sort((a, b) => Number(!!b.team) - Number(!!a.team));
  // The pause shot on air: started after the pause began.
  const holding = !!current && majority(current) === side && input.currentShotSinceMs != null && input.currentShotSinceMs >= pause!.since;
  const pick = holding ? [current] : ofSide.filter((o) => o.key !== input.currentShot).concat(ofSide.filter((o) => o.key === input.currentShot)).slice(0, 1);
  const out: ScoredCandidate[] = [];
  for (const o of pick) {
    if (seen.has(o.key)) continue;
    seen.add(o.key);
    const isCurrent = input.currentShot === o.key;
    const valid = cameraControlUsable(input.capabilities) && !input.oneSide && !(input.pin && input.pin.kind !== "cluster");
    const components: ScoreComponents = {
      actionCoverage: 0.9,
      imminence: 0.5,
      readiness: 0.5,
      significance: 0.5,
      narrative: 0.8,
      framing: 1,
      continuity: isCurrent ? 1 : 0,
      mainStory: 0,
      switchCost: isCurrent ? 0 : cfg.baseSwitchCost,
      stalenessPenalty: 0,
      cinematicOpportunityCost: 0,
    };
    out.push({
      candidateId: `cand:${o.key}:pause`,
      shotClass: "establishing",
      shotKey: o.key,
      targetSteamId: null,
      cameraId: o.camera?.id ?? teamCameraId(o.team!.side, true),
      clusterId: null,
      regionIds: o.regionIds,
      components,
      utility: valid ? utilityOf(components, cfg.weights) + 0.5 : -1,
      reasonCodes: valid ? ["PAUSE", "CINEMATIC_ELIGIBLE"] : ["PAUSE", "CAMERA_UNVERIFIED"],
      valid,
      invalidReason: valid ? null : "static camera control not verified, or pinned/one-side profile active",
      evidenceType: "estimated",
      opportunity: null,
      plannedDurationMs: PAUSE_HOLD_MS,
      // A shot from before the pause gives way at once.
      urgent: !holding,
      chain: true,
      panDegPerSec: 0,
      ...(o.team ? { framing: { from: o.team.shot.from, to: o.team.shot.from, focus: o.team.shot.focus } } : {}),
    });
  }
  return out;
}
