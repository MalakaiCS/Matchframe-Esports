/**
 * Public HUD state (schema version 1). This is the ONLY data a browser-source HUD receives.
 * It is a presentation projection for the output's timeline: no director predictions, candidate
 * scores, operator telemetry, lookahead data or secrets are ever included.
 */
export const HUD_SCHEMA_VERSION = 1;

export type HudSide = "CT" | "T";
export type HudPhase =
  | "warmup"
  | "freezetime"
  | "live"
  | "bomb"
  | "defuse"
  | "over"
  | "halftime"
  | "paused"
  | "timeout_ct"
  | "timeout_t"
  | "gameover"
  | "unknown";

export interface HudWeapon {
  name: string;
  displayName: string;
  kind: "primary" | "secondary" | "knife" | "grenade" | "bomb" | "taser" | "other";
  active: boolean;
  ammoClip: number | null;
  ammoClipMax: number | null;
  ammoReserve: number | null;
}

export interface HudPlayer {
  steamId: string;
  playerId: string | null;
  name: string;
  slot: number | null;
  side: HudSide | null;
  alive: boolean | null;
  health: number | null;
  armor: number | null;
  helmet: boolean | null;
  defuseKit: boolean | null;
  money: number | null;
  equipValue: number | null;
  flashed: number | null;
  primary: HudWeapon | null;
  secondary: HudWeapon | null;
  grenades: HudWeapon[];
  hasBomb: boolean;
  activeWeapon: HudWeapon | null;
  roundKills: number | null;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  /** Only present when validated damage totals exist; otherwise null (never estimated). */
  adr: number | null;
  observed: boolean;
  avatarUrl: string | null;
  countryCode: string | null;
}

export interface HudTeam {
  key: string;
  teamId: string | null;
  name: string;
  shortName: string;
  logoUrl: string | null;
  color: string | null;
  side: HudSide | null;
  score: number | null;
  seriesWins: number;
  timeoutsRemaining: number | null;
  /** Loss bonus only when the source reports consecutive losses. */
  consecutiveRoundLosses: number | null;
  players: HudPlayer[];
}

export interface HudKillfeedEntry {
  id: string;
  /** "exact": source-reported kill event. "elimination": a player died (killer unknown). "probable": estimated pairing. */
  kind: "exact" | "elimination" | "probable";
  killer: { steamId: string; name: string; side: HudSide | null } | null;
  victim: { steamId: string; name: string; side: HudSide | null };
  weapon: string | null;
  headshot: boolean | null;
  atMs: number;
}

export interface HudRadarMarker {
  id: string;
  u: number;
  v: number;
  side: HudSide | null;
  alive: boolean;
  observed: boolean;
  levelId: string | null;
  label: string | null;
  yawDeg: number | null;
}

export interface HudRadar {
  available: boolean;
  reason: string | null;
  mapName: string | null;
  /**
   * "schematic": Matchframe outline generated from map-pack geometry sampled from real positions,
   * using the same world transform as the markers. "image": a game radar image with a verified
   * calibration. "none": no trustworthy transform — markers are not drawn.
   */
  mode: "schematic" | "image" | "none";
  calibrationVerified: boolean;
  /** URL of the outline (schematic) or radar image, served by the overlay server. */
  backgroundUrl: string | null;
  players: HudRadarMarker[];
  bomb: { u: number; v: number; state: string } | null;
  utility: { id: string; type: string; u: number; v: number; phase: string; side: HudSide | null; evidence: string; radius: number | null }[];
}

export interface HudSeriesMap {
  mapName: string;
  displayName: string;
  status: "upcoming" | "live" | "completed" | "forfeited" | "abandoned";
  scoreLeft: number;
  scoreRight: number;
  pickedBy: "left" | "right" | "decider" | null;
  winner: "left" | "right" | null;
}

export interface HudState {
  schemaVersion: 1;
  outputId: string;
  variant: string;
  presetId: string | null;
  /** True for the labelled simulation source: HUDs must show a SIMULATION badge. */
  simulated: boolean;
  timeline: { profile: "live" | "delayed"; delayMs: number };
  dataAgeMs: number | null;
  stale: boolean;
  match: {
    mapName: string | null;
    mapDisplayName: string | null;
    roundNumber: number | null;
    phase: HudPhase;
    phaseEndsInSec: number | null;
    /** Whether the phase clock may advance locally between updates. */
    clockRunning: boolean;
    paused: boolean;
    regulationRounds: number | null;
  };
  left: HudTeam;
  right: HudTeam;
  observed: HudPlayer | null;
  bomb: { state: string; site: "A" | "B" | null; remainingSec: number | null; clockRunning: boolean } | null;
  roundHistory: { roundNumber: number; winner: "left" | "right" | null; reason: string }[];
  killfeed: { mode: "exact" | "degraded"; entries: HudKillfeedEntry[] };
  radar: HudRadar;
  series: { bestOf: number | null; maps: HudSeriesMap[]; left: number; right: number };
  event: { name: string | null; logoUrl: string | null; primary: string; secondary: string };
  sponsors: Record<string, { sponsorId: string; name: string; assetUrl: string | null; untilMs: number } | null>;
  cues: { id: string; kind: string; title: string; subtitle: string | null; data: Record<string, unknown> }[];
  replay: { active: boolean; label: string | null };
  annotations: { id: string; kind: "pencil" | "arrow"; points: [number, number][]; color: string; expiresAtMs: number | null }[];
  veto: { steps: { order: number; kind: string; team: "left" | "right" | null; mapName: string | null; side: HudSide | null; locked: boolean }[]; currentStep: number | null } | null;
  /** Stage table for studio/break screens (derived from completed results; ties shown as shared positions). */
  standings: HudStandings | null;
  bracket: HudBracket | null;
  settings: Record<string, unknown>;
}

export interface HudStageTeam {
  name: string;
  shortName: string;
  logoUrl: string | null;
}

export interface HudStandings {
  stageName: string;
  rows: { position: number; tied: boolean; advancing: boolean; team: HudStageTeam | null; played: number; wins: number; ties: number; losses: number; points: number; mapDifference: number; roundDifference: number }[];
}

export interface HudBracketSide {
  team: HudStageTeam | null;
  placeholder: string | null;
  score: number | null;
  winner: boolean;
}

export interface HudBracket {
  stageName: string;
  nodes: { id: string; round: number; slot: number; label: string; status: string; a: HudBracketSide; b: HudBracketSide }[];
}

export interface HudMessage {
  topic: "hud.snapshot" | "hud.config" | "hud.annotation" | "hud.cue";
  sequence: number;
  sentAt: number;
  payload: HudState | Record<string, unknown>;
}
