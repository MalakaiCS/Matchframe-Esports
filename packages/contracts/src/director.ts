import { z } from "zod";
import { EvidenceType } from "./common.ts";

export const DirectorMode = z.enum([
  "off",
  "advisory",
  "assisted",
  "automatic",
  "shadow",
  "demo_review",
  "delayed_lookahead",
]);
export type DirectorMode = z.infer<typeof DirectorMode>;

/** Control health is separate from the editorial operating mode (spec §9.1). */
export const ControlHealth = z.enum(["armed", "degraded", "paused", "manual_owned", "disarmed", "emergency_stopped"]);
export type ControlHealth = z.infer<typeof ControlHealth>;

export const ShotClass = z.enum([
  "hold",
  "pov",
  "third_person",
  "static_tactical",
  "static_utility",
  "camera_path",
  "bomb_resolution",
  "establishing",
  /** A free camera flying behind and above a moving player (follow cam). */
  "follow_cam",
]);
export type ShotClass = z.infer<typeof ShotClass>;

/** pov_cut: observing (spectated player). cinematic: static camera shots of fights, the bomb and establishing shots. utility_camera: nade cameras. */
export const ActionClass = z.enum(["pov_cut", "cinematic", "utility_camera", "replay_suggestion", "mixer_cue"]);
export type ActionClass = z.infer<typeof ActionClass>;

/**
 * The Observer (auto director) as the operator chooses it. off: never moves the camera (shot
 * suggestions only). observer: player POV cuts. observer_cinematics: POV cuts and cinematic static
 * cameras. full_action: POV cuts, cinematics and nade cameras (a plan feature).
 */
export const ObserverMode = z.enum(["off", "observer", "observer_cinematics", "full_action"]);
export type ObserverMode = z.infer<typeof ObserverMode>;

/** What each Observer mode may do on its own. */
export const OBSERVER_MODE_ACTIONS: Record<ObserverMode, readonly ActionClass[]> = {
  off: [],
  observer: ["pov_cut"],
  observer_cinematics: ["pov_cut", "cinematic"],
  full_action: ["pov_cut", "cinematic", "utility_camera"],
};

/** The action class a shot belongs to (static utility cameras are nade cameras; other static shots are cinematics). */
export function actionClassOfShot(shotClass: ShotClass): ActionClass {
  if (shotClass === "pov" || shotClass === "third_person" || shotClass === "hold") return "pov_cut";
  return shotClass === "static_utility" ? "utility_camera" : "cinematic";
}

export const REASON_CODES = [
  "CURRENT_SHOT_VALID",
  "CURRENT_SHOT_LOW_ACTION",
  "CURRENT_SHOT_INVALID",
  "CURRENT_POV_DEAD",
  "MIN_SHOT_DURATION",
  "ADVANTAGE_BELOW_THRESHOLD",
  "ADVANTAGE_NOT_PERSISTENT",
  "CONTACT_LIKELY_SOON",
  "CONTACT_IMMINENT",
  "CT_PUSH_BEFORE_T_EXECUTE",
  "T_GROUP_DEVELOPING",
  "EXECUTE_DEVELOPING",
  "CROSSFIRE_SETUP",
  "TRADE_OPPORTUNITY",
  "POST_EVENT_HOLD",
  "SECOND_CONTACT_LIKELY",
  "BOMB_PLANT_PRESSURE",
  "BOMB_DEFUSE_PRESSURE",
  "BOMB_CRITICAL",
  "CLUTCH",
  "RETAKE",
  "PLAYER_FLASHED",
  "PLAYER_RELOADING",
  "PLAYER_READY",
  "ISOLATED_AGGRESSOR",
  "UTILITY_INCOMING",
  "UTILITY_CLUSTER_TARGET",
  "UTILITY_VOLLEY",
  "UTILITY_LOW_VALUE",
  "UTILITY_NO_CAMERA",
  "CINEMATIC_BUDGET_EXHAUSTED",
  "CINEMATIC_DISABLED",
  "CINEMATIC_ELIGIBLE",
  "CINEMATIC_INTERRUPTED",
  "OBSERVER_MODE_EXCLUDES",
  "CAMERA_UNVERIFIED",
  "COOLDOWN_ACTIVE",
  "STALE_DATA",
  "LOW_CONFIDENCE",
  "MANUAL_OWNERSHIP",
  "EMERGENCY_STOP",
  "PINNED",
  "HOLD_REQUESTED",
  "WALL_SEPARATED",
  "DISTANCE_CLOSING",
  "MAIN_STORY",
  "ESTABLISHING",
  "NO_VALID_CANDIDATE",
  "MAIN_OBSERVER_ON_IT",
  "FOLLOW_CAM",
] as const;
export const ReasonCode = z.enum(REASON_CODES);
export type ReasonCode = z.infer<typeof ReasonCode>;

export const ScoreComponents = z.object({
  actionCoverage: z.number(),
  imminence: z.number(),
  readiness: z.number(),
  significance: z.number(),
  narrative: z.number(),
  framing: z.number(),
  continuity: z.number(),
  mainStory: z.number(),
  switchCost: z.number(),
  stalenessPenalty: z.number(),
  cinematicOpportunityCost: z.number(),
});
export type ScoreComponents = z.infer<typeof ScoreComponents>;

export const ShotCandidate = z.object({
  candidateId: z.string(),
  shotClass: ShotClass,
  /** Target expressed as shot key: "pov:<steamId>", "camera:<cameraId>", "path:<pathId>", "hold". */
  shotKey: z.string(),
  targetSteamId: z.string().nullable(),
  cameraId: z.string().nullable(),
  clusterId: z.string().nullable(),
  regionIds: z.array(z.string()),
  components: ScoreComponents,
  utility: z.number(),
  reasonCodes: z.array(ReasonCode),
  valid: z.boolean(),
  invalidReason: z.string().nullable(),
  evidenceType: EvidenceType,
});
export type ShotCandidate = z.infer<typeof ShotCandidate>;

export const DirectorDecision = z.object({
  decisionId: z.string(),
  sessionId: z.string(),
  epoch: z.number().int(),
  basedOnSequence: z.number().int(),
  decidedAtMonotonicMs: z.number(),
  mode: DirectorMode,
  controlHealth: ControlHealth,
  currentShot: z.string().nullable(),
  desiredShot: z.string().nullable(),
  action: z.enum(["hold", "cut", "recommend", "none"]),
  reasonCodes: z.array(ReasonCode),
  supportingFeatures: z.record(z.string(), z.number().nullable()),
  confidence: z.number().min(0).max(1),
  evidenceType: EvidenceType,
  policyVersion: z.string(),
  modelVersion: z.string().nullable(),
  expiresInMs: z.number(),
  topCandidates: z.array(ShotCandidate),
  effectiveWeights: z.record(z.string(), z.number()),
});
export type DirectorDecision = z.infer<typeof DirectorDecision>;
