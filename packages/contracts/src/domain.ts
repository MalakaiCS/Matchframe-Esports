import { z } from "zod";
import { Side, SteamId64 } from "./common.ts";

export const Team = z.object({
  id: z.string(),
  name: z.string().min(1).max(80),
  shortName: z.string().min(1).max(12),
  logoAssetId: z.string().nullable().default(null),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().default(null),
  secondaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().default(null),
  region: z.string().max(40).nullable().default(null),
  countryCode: z.string().length(2).nullable().default(null),
  sponsorMetadata: z.record(z.string(), z.string()).default({}),
  archived: z.boolean().default(false),
});
export type Team = z.infer<typeof Team>;

export const Player = z.object({
  id: z.string(),
  displayName: z.string().min(1).max(64),
  realName: z.string().max(120).nullable().default(null),
  steamId: SteamId64.nullable().default(null),
  countryCode: z.string().length(2).nullable().default(null),
  avatarAssetId: z.string().nullable().default(null),
  aliases: z.array(z.string()).default([]),
  /** Consent/visibility fields kept out of live controls. */
  photoVisible: z.boolean().default(true),
  cameraConsent: z.boolean().default(false),
  cameraSourceId: z.string().nullable().default(null),
  archived: z.boolean().default(false),
});
export type Player = z.infer<typeof Player>;

/** Roster membership with validity range — history is preserved across transfers. */
export const RosterMembership = z.object({
  id: z.string(),
  teamId: z.string(),
  playerId: z.string(),
  role: z.enum(["player", "substitute", "coach", "stand_in"]).default("player"),
  validFrom: z.string(),
  validTo: z.string().nullable().default(null),
});
export type RosterMembership = z.infer<typeof RosterMembership>;

export const MatchFormat = z.object({
  bestOf: z.number().int().min(1).max(9),
  /** Regulation rounds (e.g. 24 for MR12). */
  regulationRounds: z.number().int().min(2).max(60),
  overtimeEnabled: z.boolean(),
  overtimeRounds: z.number().int().min(2).max(20),
  /** Allow a regulation tie (e.g. some group formats). */
  allowTie: z.boolean().default(false),
});
export type MatchFormat = z.infer<typeof MatchFormat>;

export const MapInstanceStatus = z.enum(["upcoming", "live", "completed", "forfeited", "abandoned"]);

export const MapInstance = z.object({
  id: z.string(),
  matchId: z.string(),
  order: z.number().int().min(1),
  mapName: z.string(),
  pickedByTeamId: z.string().nullable(),
  isDecider: z.boolean().default(false),
  startingCtTeamId: z.string().nullable(),
  status: MapInstanceStatus,
  scoreA: z.number().int().min(0).default(0),
  scoreB: z.number().int().min(0).default(0),
  winnerTeamId: z.string().nullable().default(null),
  mapRevision: z.string().nullable().default(null),
});
export type MapInstance = z.infer<typeof MapInstance>;

export const Match = z.object({
  id: z.string(),
  eventId: z.string().nullable(),
  stageId: z.string().nullable().default(null),
  teamAId: z.string(),
  teamBId: z.string(),
  format: MatchFormat,
  status: z.enum(["scheduled", "veto", "live", "completed", "cancelled"]),
  scheduledAt: z.string().nullable().default(null),
  /** Series score derived from completed maps; never auto-advanced by tied/unfinished maps. */
  seriesScoreA: z.number().int().min(0).default(0),
  seriesScoreB: z.number().int().min(0).default(0),
  mapPool: z.array(z.string()).default([]),
  vetoSequenceId: z.string().nullable().default(null),
  title: z.string().nullable().default(null),
});
export type Match = z.infer<typeof Match>;

export const EventRecord = z.object({
  id: z.string(),
  name: z.string().min(1).max(120),
  timeZone: z.string().default("UTC"),
  startsOn: z.string().nullable().default(null),
  endsOn: z.string().nullable().default(null),
  brandPrimary: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#2f7cf6"),
  brandSecondary: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#ffffff"),
  logoAssetId: z.string().nullable().default(null),
  mapPool: z.array(z.string()).default([]),
});
export type EventRecord = z.infer<typeof EventRecord>;

export const StatCorrection = z.object({
  id: z.string(),
  matchId: z.string(),
  mapInstanceId: z.string().nullable(),
  steamId: SteamId64.nullable(),
  field: z.string(),
  sourceValue: z.number().nullable(),
  correctedValue: z.number().nullable(),
  effectiveFromRound: z.number().int().nullable(),
  reason: z.string(),
  operator: z.string(),
  createdAt: z.string(),
});
export type StatCorrection = z.infer<typeof StatCorrection>;

export const VetoActionKind = z.enum(["ban", "pick", "decider", "side_choice"]);
export const VetoStep = z.object({
  order: z.number().int().min(1),
  kind: VetoActionKind,
  /** "A" | "B" for team turns, null for automatic decider. */
  actor: z.enum(["A", "B"]).nullable(),
});
export type VetoStep = z.infer<typeof VetoStep>;

export const VetoDecision = z.object({
  id: z.string(),
  matchId: z.string(),
  stepOrder: z.number().int(),
  kind: VetoActionKind,
  teamId: z.string().nullable(),
  mapName: z.string().nullable(),
  side: Side.nullable(),
  decidedBy: z.string(),
  decidedAt: z.string(),
  revisionOf: z.string().nullable().default(null),
});
export type VetoDecision = z.infer<typeof VetoDecision>;

export const SponsorPlacementZone = z.enum([
  "top_bar",
  "bottom_left",
  "bottom_right",
  "scoreboard_slot",
  "break_fullscreen",
  "result_banner",
]);

export const Sponsor = z.object({
  id: z.string(),
  name: z.string(),
  assetIds: z.array(z.string()),
  placements: z.array(SponsorPlacementZone),
  displaySeconds: z.number().positive().default(10),
  weight: z.number().positive().default(1),
  active: z.boolean().default(true),
});
export type Sponsor = z.infer<typeof Sponsor>;

export const RundownCue = z.object({
  id: z.string(),
  order: z.number().int(),
  title: z.string(),
  kind: z.enum(["intro", "caster_card", "match_preview", "veto", "live_match", "break", "highlights", "results", "closing", "custom"]),
  durationSec: z.number().nonnegative().nullable().default(null),
  hudVariant: z.string().nullable().default(null),
  obsScene: z.string().nullable().default(null),
  notes: z.string().default(""),
  automation: z.enum(["manual", "auto_next"]).default("manual"),
  ready: z.boolean().default(false),
});
export type RundownCue = z.infer<typeof RundownCue>;

/** Event stage (group, Swiss or single-elimination bracket). Standings are derived, never stored. */
export const StageKind = z.enum(["round_robin", "swiss", "single_elimination"]);
export type StageKind = z.infer<typeof StageKind>;

export const StageTiebreaker = z.enum(["head_to_head", "map_difference", "round_difference", "maps_won", "opponent_wins"]);
export type StageTiebreaker = z.infer<typeof StageTiebreaker>;

export const BracketSource = z.object({ nodeId: z.string(), outcome: z.enum(["winner", "loser"]) });

export const BracketNode = z.object({
  id: z.string().min(1).max(40),
  round: z.number().int().min(1).max(12),
  slot: z.number().int().min(1).max(256),
  label: z.string().max(40).nullable().default(null),
  matchId: z.string().nullable().default(null),
  /** Where each side comes from when the match is not created yet (or to verify it). */
  teamAFrom: BracketSource.nullable().default(null),
  teamBFrom: BracketSource.nullable().default(null),
});
export type BracketNode = z.infer<typeof BracketNode>;

export const EventStage = z.object({
  id: z.string(),
  eventId: z.string(),
  name: z.string().min(1).max(80),
  kind: StageKind,
  order: z.number().int().min(1).default(1),
  teamIds: z.array(z.string()).default([]),
  points: z.object({ win: z.number().default(3), tie: z.number().default(1), loss: z.number().default(0) }).default({ win: 3, tie: 1, loss: 0 }),
  tiebreakers: z.array(StageTiebreaker).default(["head_to_head", "map_difference", "round_difference"]),
  /** Top N rows are marked as advancing (display only). */
  advancing: z.number().int().min(0).default(0),
  bracket: z.array(BracketNode).default([]),
});
export type EventStage = z.infer<typeof EventStage>;
