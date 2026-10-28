import type { CameraPath, CameraRecord, MatchState, ReasonCode, ScoreComponents, ShotClass, SourceCapabilities, Vec3 } from "@matchframe/contracts";
import { projectCountdown } from "@matchframe/cs2-state";
import type { Pin, ScoredCandidate } from "./candidates.ts";
import { utilityOf } from "./candidates.ts";
import type { DirectorConfig } from "./config.ts";
import type { InteractionFeatures } from "./features/interactions.ts";
import type { RoundContext } from "./features/significance.ts";
import type { CameraMatch } from "@matchframe/map-runtime";
import type { TeamShot } from "./framing.ts";
import { teamCameraId } from "./framing.ts";
import type { ShotKey } from "./shots.ts";
import { cameraShot, followShot, pathShot } from "./shots.ts";
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
  /**
   * Players a follow camera could fly behind right now (the map has a free-space grid and follow
   * cams are on): moving, with their speed (units/s) and whether they are alone (no teammate near).
   */
  followable?: { steamId: string; speed: number; alone: boolean }[] | undefined;
  /** When the current shot started (monotonic ms). */
  currentShotSinceMs?: number | null | undefined;
  /** Cinematic shots already played this round (none plays twice in a round). */
  shownThisRound?: ReadonlySet<ShotKey> | undefined;
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
  teamShot?: ((side: "T" | "CT", still: boolean) => TeamShot | null) | undefined;
}

/** Follow cam: a player running (units/s) with no fight expected within 2 s. */
const FOLLOW_MIN_SPEED = 160;
const FOLLOW_MAX_CONTACT = 0.2;
const FOLLOW_MS = 4500;
/** After a player view held this long with nothing happening, a follow cam brings some movement. */
const FOLLOW_VARIETY_AFTER_MS = 5000;
const FOLLOW_VARIETY_BONUS = 0.2;

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
  const phase = state.roundPhase === "freezetime" ? "freezetime" : state.roundPhase === "live" ? "live" : state.roundPhase === "over" ? "over" : null;
  if (!phase) return [];
  const inPhase = (cam: CameraRecord) => cam.allowedPhases.includes(phase);
  const triggers: Trigger[] = [];
  // First person from the start of a live round: no fight overview or follow cam in its first seconds.
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
  if (phase === "live" && !earlyLive) out.push(...followCandidates(input));
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
      actionCoverage: t.value,
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
function establishingCandidates(input: CinematicInput, seen: Set<string>): ScoredCandidate[] {
  const { state, map, cfg } = input;
  if (!map) return [];
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
  // Team shots first (still ones in a pause).
  const firstSide = (state.roundNumber ?? 0) % 2 === 0 ? "T" : "CT";
  for (const side of firstSide === "T" ? (["T", "CT"] as const) : (["CT", "T"] as const)) {
    const shot = input.teamShot?.(side, !!input.pause);
    if (!shot) continue;
    const ids = new Set(shot.steamIds);
    options.push({ key: cameraShot(teamCameraId(side, !!input.pause)), shotClass: "establishing", camera: null, path: null, team: { side, shot }, regionIds: [], durationMs: nextMs, players: alive.filter((p) => ids.has(p.steamId)) });
  }
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
  // Turning one way, then the other.
  const panSign = playedEstablishing % 2 === 0 ? 1 : -1;
  const out: ScoredCandidate[] = [];
  for (const o of options) {
    const isCurrent = input.currentShot === o.key;
    if (seen.has(o.key) || (shown.has(o.key) && !isCurrent) || o.players.length < need) continue;
    // A new shot needs the time to play it, and fits the freeze time's quota.
    if (!isCurrent && (playedEstablishing >= cfg.cinematic.establishingPerRound || (left !== null && left < ESTABLISHING_MIN_LEFT_SEC))) continue;
    seen.add(o.key);
    const sides = new Set(o.players.map((p) => p.side!));
    const fresh = [...sides].some((x) => !shownSides.has(x));
    const reasons: ReasonCode[] = ["ESTABLISHING"];
    let valid = true;
    let invalidReason: string | null = null;
    if (!input.cinematicsAllowed.allowed && !isCurrent) {
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
    const coverage = clamp01(0.45 + 0.08 * o.players.length + (fresh ? 0.12 : 0) + (o.path ? 0.04 : 0));
    const components: ScoreComponents = {
      actionCoverage: coverage,
      imminence: 0.5,
      readiness: 0.5,
      significance: 0.5,
      narrative: o.team ? (o.team.side === firstSide ? 0.95 : 0.94) : 0.7,
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
      cameraId: o.camera?.id ?? (o.team ? teamCameraId(o.team.side, !!input.pause) : null),
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

/**
 * Follow cam candidates: a free camera behind and above a player who is running somewhere with no
 * fight expected soon (a lurk, a rotation, the bomb carrier walking onto a site). They only win in
 * quiet moments, and are interrupted like any cinematic when a fight starts.
 */
function followCandidates(input: CinematicInput): ScoredCandidate[] {
  const out: ScoredCandidate[] = [];
  const { state, cfg } = input;
  for (const f of input.followable ?? []) {
    const p = state.players.find((x) => x.steamId === f.steamId);
    if (!p || p.lifeState !== "alive" || f.speed < FOLLOW_MIN_SPEED) continue;
    const contact = input.interactions.byPlayer.get(p.steamId)?.contact["2"] ?? 0;
    if (contact > FOLLOW_MAX_CONTACT) continue;
    if (input.oneSide && p.side !== input.oneSide) continue;
    if (input.pin && !(input.pin.kind === "player" && input.pin.steamId === p.steamId)) continue;
    const key = followShot(p.steamId);
    const isCurrent = input.currentShot === key;
    const reasons: ReasonCode[] = ["FOLLOW_CAM"];
    let valid = true;
    let invalidReason: string | null = null;
    if (!input.cinematicsAllowed.allowed && !isCurrent) {
      valid = false;
      invalidReason = "cinematics not allowed";
      if (input.cinematicsAllowed.reason) reasons.push(input.cinematicsAllowed.reason);
    }
    if (!pathControlUsable(input.capabilities)) {
      valid = false;
      invalidReason = "camera path control not verified for this environment";
      reasons.push("CAMERA_UNVERIFIED");
    }
    const carrier = input.round.carrierSteamId === p.steamId;
    if (carrier) reasons.push("BOMB_PLANT_PRESSURE");
    const fromPov = input.currentShot === `pov:${p.steamId}`;
    const heldPov = input.currentShot?.startsWith("pov:") && input.currentShotSinceMs != null && input.now - input.currentShotSinceMs >= FOLLOW_VARIETY_AFTER_MS;
    const components: ScoreComponents = {
      actionCoverage: 0.3,
      imminence: 0.15,
      readiness: 0.6,
      significance: carrier ? 0.55 : f.alone ? 0.4 : 0.25,
      narrative: f.alone || carrier ? 0.6 : 0.35,
      framing: 0.9,
      // From this player's own POV the follow cam is a natural transition.
      continuity: isCurrent ? 1 : fromPov ? 0.4 : 0,
      mainStory: 0,
      switchCost: isCurrent ? 0 : cfg.baseSwitchCost + 0.04,
      stalenessPenalty: 0,
      cinematicOpportunityCost: 0.05,
    };
    out.push({
      candidateId: `cand:${key}:follow_cam`,
      shotClass: "follow_cam",
      shotKey: key,
      targetSteamId: p.steamId,
      cameraId: null,
      clusterId: null,
      regionIds: [],
      components,
      utility: valid ? utilityOf(components, cfg.weights) + (heldPov ? FOLLOW_VARIETY_BONUS : 0) : -1,
      reasonCodes: reasons,
      valid,
      invalidReason,
      evidenceType: "estimated",
      opportunity: null,
      plannedDurationMs: FOLLOW_MS,
      urgent: false,
    });
  }
  return out;
}
