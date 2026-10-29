import { z } from "zod";
import { EvidenceType, Provenance, Side, SteamId64, Vec3 } from "./common.ts";
import { ObservedGrenadeType } from "./capabilities.ts";

/** Clock stamps carried by every state snapshot and event (spec §6.5). */
export const TimeStamp = z.object({
  /** Monotonic ingest time on the receiving process (performance.now based), ms. */
  receivedAtMonotonicMs: z.number(),
  /** Source-reported observation time, if any (GSI provider.timestamp is 1 s resolution). */
  sourceObservedAtMs: z.number().nullable(),
  /** Canonical match time in ms, if a mapping is known. */
  matchTimeMs: z.number().nullable(),
  /** Uncertainty of matchTimeMs, ms. Null if no mapping. */
  timeUncertaintyMs: z.number().nullable(),
});
export type TimeStamp = z.infer<typeof TimeStamp>;

export const MapPhase = z.enum(["warmup", "live", "intermission", "gameover", "unknown"]);
export type MapPhase = z.infer<typeof MapPhase>;

export const RoundPhase = z.enum(["freezetime", "live", "over", "unknown"]);
export type RoundPhase = z.infer<typeof RoundPhase>;

/** Fine-grained phase from phase countdowns, when supplied. */
export const GamePhase = z.enum([
  "warmup",
  "freezetime",
  "live",
  "bomb",
  "defuse",
  "over",
  "timeout_t",
  "timeout_ct",
  "paused",
  "halftime",
  "gameover",
  "unknown",
]);
export type GamePhase = z.infer<typeof GamePhase>;

export const LifeState = z.enum(["alive", "dead", "disconnected", "unknown"]);
export type LifeState = z.infer<typeof LifeState>;

export const WeaponState = z.object({
  slotKey: z.string(),
  name: z.string(),
  type: z.string().nullable(),
  state: z.enum(["active", "holstered", "reloading", "unknown"]),
  ammoClip: z.number().nullable(),
  ammoClipMax: z.number().nullable(),
  ammoReserve: z.number().nullable(),
});
export type WeaponState = z.infer<typeof WeaponState>;

export const PlayerMatchStats = z.object({
  kills: z.number().nullable(),
  assists: z.number().nullable(),
  deaths: z.number().nullable(),
  mvps: z.number().nullable(),
  score: z.number().nullable(),
});
export type PlayerMatchStats = z.infer<typeof PlayerMatchStats>;

export const PlayerState = z.object({
  steamId: SteamId64,
  /** Internal player ID when the steamId is mapped to a roster identity. */
  playerId: z.string().nullable(),
  name: z.string(),
  /** CS2's observer_slot as the game data gives it (CS2 counts from 0). */
  observerSlot: z.number().int().nullable(),
  /**
   * The spectator number key that shows this player, and the number broadcasts show for them: 1–9,
   * then 0 for the tenth (see observerKeys in @matchframe/cs2-state).
   */
  observerKey: z.number().int().min(0).max(9).nullable().default(null),
  /**
   * A coach listed with the team (named as one, more than five on the team with this one never
   * alive in freeze time, a coach in the team's roster, or marked by the operator): left out of the
   * HUDs' teams and scoreboards and never spectated.
   */
  coach: z.boolean().default(false),
  side: Side.nullable(),
  teamId: z.string().nullable(),
  lifeState: LifeState,
  health: z.number().nullable(),
  armor: z.number().nullable(),
  helmet: z.boolean().nullable(),
  defuseKit: z.boolean().nullable(),
  /** 0..1 normalized flash intensity (source 0..255). Null when not supplied. */
  flashed: z.number().min(0).max(1).nullable(),
  smoked: z.number().min(0).max(1).nullable(),
  burning: z.number().min(0).max(1).nullable(),
  money: z.number().nullable(),
  equipValue: z.number().nullable(),
  roundKills: z.number().nullable(),
  roundKillsHeadshot: z.number().nullable(),
  roundDamage: z.number().nullable(),
  matchStats: PlayerMatchStats,
  weapons: z.array(WeaponState),
  activeWeapon: WeaponState.nullable(),
  /** World position. Null when unknown — never (0,0,0) as a placeholder. */
  position: Vec3.nullable(),
  /** Unit forward/view vector, null when unknown. */
  forward: Vec3.nullable(),
  positionObservedAtMonotonicMs: z.number().nullable(),
  lastSeenMonotonicMs: z.number(),
  /** Field-level provenance of the most important derived fields. */
  provenance: z.record(z.string(), Provenance).default({}),
});
export type PlayerState = z.infer<typeof PlayerState>;

export const TeamState = z.object({
  side: Side,
  teamId: z.string().nullable(),
  name: z.string().nullable(),
  score: z.number().nullable(),
  consecutiveRoundLosses: z.number().nullable(),
  timeoutsRemaining: z.number().nullable(),
  matchesWonThisSeries: z.number().nullable(),
});
export type TeamState = z.infer<typeof TeamState>;

export const BombStateKind = z.enum([
  "carried",
  "dropped",
  "planting",
  "planted",
  "defusing",
  "defused",
  "exploded",
  "unknown",
]);
export type BombStateKind = z.infer<typeof BombStateKind>;

export const BombState = z.object({
  state: BombStateKind,
  position: Vec3.nullable(),
  carrierSteamId: SteamId64.nullable(),
  /** Remaining seconds reported by the source at observation time. */
  countdownSec: z.number().nullable(),
  countdownObservedAtMonotonicMs: z.number().nullable(),
  site: z.enum(["A", "B"]).nullable(),
  evidence: EvidenceType,
});
export type BombState = z.infer<typeof BombState>;

export const RoundWinReason = z.enum([
  "ct_win_elimination",
  "t_win_elimination",
  "ct_win_defuse",
  "t_win_bomb",
  "ct_win_time",
  "ct_win_rescue",
  "t_win_time",
  "unknown",
]);
export type RoundWinReason = z.infer<typeof RoundWinReason>;

export const RoundResult = z.object({
  roundNumber: z.number().int(),
  attemptId: z.string(),
  winnerSide: Side.nullable(),
  winnerTeamId: z.string().nullable(),
  reason: RoundWinReason,
  evidence: EvidenceType,
});
export type RoundResult = z.infer<typeof RoundResult>;

export const UtilityPhase = z.enum(["flight", "active", "expired", "lost", "unknown"]);
export type UtilityPhase = z.infer<typeof UtilityPhase>;

export const UtilitySample = z.object({
  monotonicMs: z.number(),
  matchTimeMs: z.number().nullable(),
  position: Vec3,
  velocity: Vec3.nullable(),
});
export type UtilitySample = z.infer<typeof UtilitySample>;

export const UtilityEffectKind = z.enum(["he_burst", "flash_burst", "smoke_volume", "fire_area", "decoy_active"]);
export type UtilityEffectKind = z.infer<typeof UtilityEffectKind>;

export const UtilityEffect = z.object({
  kind: UtilityEffectKind,
  /** Measured or estimated points describing the extent (e.g. GSI flame positions). */
  extentPoints: z.array(Vec3),
  centroid: Vec3.nullable(),
  radiusUnits: z.number().nullable(),
  extentEvidence: EvidenceType,
  estimatedExpiryMonotonicMs: z.number().nullable(),
  expiryEvidence: EvidenceType,
  expiryUncertaintyMs: z.number().nullable(),
});
export type UtilityEffect = z.infer<typeof UtilityEffect>;

export const UtilityPrediction = z.object({
  activationPosition: Vec3,
  activationInMs: z.number(),
  positionUncertaintyUnits: z.number(),
  timeUncertaintyMs: z.number(),
  predictorVersion: z.string(),
  computedAtMonotonicMs: z.number(),
  tier: z.enum(["A", "B", "C", "D"]),
});
export type UtilityPrediction = z.infer<typeof UtilityPrediction>;

export const AffectedPlayer = z.object({
  steamId: SteamId64,
  effect: z.enum(["flashed", "damaged", "burning", "in_smoke", "possibly_affected"]),
  value: z.number().nullable(),
  evidence: EvidenceType,
  attributionConfidence: z.number().min(0).max(1),
});
export type AffectedPlayer = z.infer<typeof AffectedPlayer>;

export const UtilityCleanupReason = z.enum([
  "expired",
  "source_removed",
  "epoch_reset",
  "map_change",
  "stale_timeout",
  "round_end",
]);

/** Normalized utility item (spec §13.3). Predictions are never silently promoted to confirmations. */
export const UtilityItem = z.object({
  utilityId: z.string(),
  sessionId: z.string(),
  epoch: z.number().int(),
  sourceId: z.string(),
  sourceEntityId: z.string(),
  type: ObservedGrenadeType,
  typeConfidence: z.number().min(0).max(1),
  typeEvidence: z.string(),
  throwerSteamId: SteamId64.nullable(),
  throwerSide: Side.nullable(),
  ownerConfidence: z.number().min(0).max(1),
  firstObservedMonotonicMs: z.number(),
  lastObservedMonotonicMs: z.number(),
  firstMatchTimeMs: z.number().nullable(),
  lastMatchTimeMs: z.number().nullable(),
  samples: z.array(UtilitySample),
  bounces: z.array(z.object({ monotonicMs: z.number(), position: Vec3, evidence: EvidenceType })),
  phase: UtilityPhase,
  predicted: UtilityPrediction.nullable(),
  confirmedActivation: z
    .object({
      position: Vec3,
      monotonicMs: z.number(),
      matchTimeMs: z.number().nullable(),
      evidenceRef: z.string(),
      evidence: EvidenceType,
    })
    .nullable(),
  effect: UtilityEffect.nullable(),
  affectedPlayers: z.array(AffectedPlayer),
  regions: z.array(z.string()),
  level: z.string().nullable(),
  clusterId: z.string().nullable(),
  linkedUtilityIds: z.array(z.string()),
  cleanupReason: UtilityCleanupReason.nullable(),
  visibilityGaps: z.array(z.object({ fromMonotonicMs: z.number(), toMonotonicMs: z.number() })),
});
export type UtilityItem = z.infer<typeof UtilityItem>;

export const CameraMode = z.enum(["in_eye", "chase", "roaming", "static_camera", "camera_path", "unknown"]);
export type CameraMode = z.infer<typeof CameraMode>;

export const ObserverState = z.object({
  /** SteamID currently spectated according to source feedback (GSI `player` in observer mode). */
  observedSteamId: SteamId64.nullable(),
  observedSlot: z.number().int().nullable(),
  cameraMode: CameraMode,
  confirmedAtMonotonicMs: z.number().nullable(),
  /** The spectating client (provider) SteamID. */
  providerSteamId: SteamId64.nullable(),
  evidence: EvidenceType,
});
export type ObserverState = z.infer<typeof ObserverState>;

export const SourceHealth = z.object({
  sourceId: z.string(),
  connected: z.boolean(),
  lastPacketMonotonicMs: z.number().nullable(),
  packetsReceived: z.number(),
  packetsRejected: z.number(),
  sequenceGaps: z.number(),
  meanIntervalMs: z.number().nullable(),
  stale: z.boolean(),
  gameBuild: z.string().nullable(),
});
export type SourceHealth = z.infer<typeof SourceHealth>;

export const MatchState = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string(),
  epoch: z.number().int(),
  sequence: z.number().int(),
  time: TimeStamp,
  mapName: z.string().nullable(),
  mapPhase: MapPhase,
  roundNumber: z.number().int().nullable(),
  roundAttemptId: z.string().nullable(),
  roundPhase: RoundPhase,
  gamePhase: GamePhase,
  phaseEndsInSec: z.number().nullable(),
  phaseObservedAtMonotonicMs: z.number().nullable(),
  paused: z.boolean(),
  teams: z.object({ CT: TeamState, T: TeamState }),
  players: z.array(PlayerState),
  bomb: BombState.nullable(),
  utility: z.array(UtilityItem),
  roundHistory: z.array(RoundResult),
  observer: ObserverState,
  sources: z.array(SourceHealth),
  simulated: z.boolean(),
});
export type MatchState = z.infer<typeof MatchState>;
