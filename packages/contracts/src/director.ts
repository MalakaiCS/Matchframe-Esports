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
]);
export type ShotClass = z.infer<typeof ShotClass>;

export const ActionClass = z.enum(["pov_cut", "cinematic", "replay_suggestion", "mixer_cue"]);
export type ActionClass = z.infer<typeof ActionClass>;

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
