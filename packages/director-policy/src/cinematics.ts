import type { CameraPath, CameraRecord, MatchState, ReasonCode, ScoreComponents, ShotClass, SourceCapabilities } from "@matchframe/contracts";
import { projectCountdown } from "@matchframe/cs2-state";
import type { Pin, ScoredCandidate } from "./candidates.ts";
import { utilityOf } from "./candidates.ts";
import type { DirectorConfig } from "./config.ts";
import type { InteractionFeatures } from "./features/interactions.ts";
import type { RoundContext } from "./features/significance.ts";
import type { CameraMatch } from "@matchframe/map-runtime";
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

  if (phase === "freezetime" && map.camerasWith) {
    const left = projectCountdown({ countdownSec: state.phaseEndsInSec, observedAtMonotonicMs: state.phaseObservedAtMonotonicMs, nowMonotonicMs: input.now, running: !state.paused }).remainingSec;
    if (left === null || left > ESTABLISHING_MIN_LEFT_SEC) {
      for (const match of map.camerasWith({ actionClass: "establishing", phase: "freezetime" })) {
        // Freeze time has no action to follow from a POV (buying, waiting): the establishing shot is the story.
        triggers.push({ shotClass: "establishing", match, value: 0.7, reasons: ["ESTABLISHING"], significance: 0.5, narrative: 0.6, imminence: 0.5, readiness: 0.5 });
      }
    }
  }

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

  if (phase === "live") {
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

  // Freeze time: one camera path per round, taking turns through the map's paths, when it fits.
  if (phase === "freezetime" && map.pathsFor) {
    const paths = map.pathsFor();
    const left = projectCountdown({ countdownSec: state.phaseEndsInSec, observedAtMonotonicMs: state.phaseObservedAtMonotonicMs, nowMonotonicMs: input.now, running: !state.paused }).remainingSec;
    const path = paths.length ? paths[Math.abs(state.roundNumber ?? 0) % paths.length]! : null;
    const dur = path ? pathDurationMs(path) : 0;
    if (path && (left === null || left * 1000 > dur + 1500)) {
      const key = pathShot(path.id);
      const isCurrent = input.currentShot === key;
      const reasons: ReasonCode[] = ["ESTABLISHING"];
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
      if (input.oneSide || (input.pin && input.pin.kind !== "cluster")) {
        valid = false;
        invalidReason = "pinned/one-side profile active";
      }
      if (valid) reasons.push("CINEMATIC_ELIGIBLE");
      const components: ScoreComponents = {
        actionCoverage: 0.75,
        imminence: 0.5,
        readiness: 0.5,
        significance: 0.5,
        narrative: 0.7,
        framing: 1,
        continuity: isCurrent ? 1 : 0,
        mainStory: 0,
        switchCost: isCurrent ? 0 : cfg.baseSwitchCost + 0.02,
        stalenessPenalty: 0,
        cinematicOpportunityCost: 0.03,
      };
      seen.add(key);
      out.push({
        candidateId: `cand:${key}:camera_path`,
        shotClass: "camera_path",
        shotKey: key,
        targetSteamId: null,
        cameraId: null,
        clusterId: null,
        regionIds: path.targetRegionIds,
        components,
        utility: valid ? utilityOf(components, cfg.weights) : -1,
        reasonCodes: reasons,
        valid,
        invalidReason,
        evidenceType: "estimated",
        opportunity: null,
        plannedDurationMs: dur,
        urgent: false,
      });
    }
  }
  if (phase === "live") out.push(...followCandidates(input));
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
