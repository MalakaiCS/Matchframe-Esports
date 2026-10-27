import type { CameraRecord, MatchState, ReasonCode, ScoreComponents, ShotClass, SourceCapabilities } from "@matchframe/contracts";
import { projectCountdown } from "@matchframe/cs2-state";
import type { Pin, ScoredCandidate } from "./candidates.ts";
import { utilityOf } from "./candidates.ts";
import type { DirectorConfig } from "./config.ts";
import type { InteractionFeatures } from "./features/interactions.ts";
import type { RoundContext } from "./features/significance.ts";
import type { CameraMatch } from "@matchframe/map-runtime";
import type { ShotKey } from "./shots.ts";
import { cameraShot } from "./shots.ts";
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
}

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
 * Cinematic static-camera shots that are not about utility (Observer & Cinematics and Full Action
 * Observer): an establishing shot during freeze time, the bomb at plant/defuse resolution, and an
 * overview of a fight with several players from both sides. Cameras come only from the map pack
 * (operator-captured, validated, with the matching action class and phase). Nade cameras are the
 * utility candidates in candidates.ts.
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
