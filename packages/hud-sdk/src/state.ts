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
  /** Damage dealt this round (null when the source doesn't report it). */
  roundDamage: number | null;
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
  /**
   * "exact": source-reported kill event. "elimination": a player died (killer unknown).
   * "probable": paired from game-data counter changes (CS2 game state integration reports no kill
   * events, so this is how every GSI killfeed works); weapon, headshot, assister and blind are then
   * estimates too.
   */
  kind: "exact" | "elimination" | "probable";
  killer: { steamId: string; name: string; side: HudSide | null } | null;
  victim: { steamId: string; name: string; side: HudSide | null };
  /** Weapon id, e.g. "weapon_ak47" or "ak47" (the killer's weapon in hand for "probable"); null when unknown. */
  weapon: string | null;
  headshot: boolean | null;
  /** The player credited with the assist in the same update, when exactly one was. */
  assister: { steamId: string; name: string; side: HudSide | null } | null;
  /** The killer was flashed when the kill happened. */
  attackerBlind: boolean | null;
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
  /** Currently flashed (any amount). */
  flashed: boolean;
  hasBomb: boolean;
}

export interface HudRadar {
  available: boolean;
  reason: string | null;
  mapName: string | null;
  /**
   * "schematic": Matchframe outline generated from map-pack geometry sampled from real positions,
   * using the same world transform as the markers. "image": a radar image with its calibration (the
   * built-in radar for the map, or an operator-calibrated image). "none": no trustworthy transform —
   * markers are not drawn.
   */
  mode: "schematic" | "image" | "none";
  calibrationVerified: boolean;
  /** URL of the outline (schematic) or radar image, served by the overlay server. */
  backgroundUrl: string | null;
  /**
   * Matchframe's clean radar for the map (navy floor, light walls, red bomb sites), drawn in the
   * same image frame as `backgroundUrl`, so the markers' u/v place on either. Null when none.
   */
  cleanUrl: string | null;
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
  replay: {
    /** A replay is on program (the live HUD may step aside). */
    active: boolean;
    label: string | null;
    /**
     * The replay clip on air and what it shows, for a replay graphic (a "REPLAY" tag and a lower
     * third). Draw it only on your `replay` entry point, the page that goes in the replay scene; the
     * live HUD never shows it. Null when no clip is on air or the operator turned the graphic off.
     */
    clip: HudReplayClip | null;
  };
  annotations: { id: string; kind: "pencil" | "arrow"; points: [number, number][]; color: string; expiresAtMs: number | null }[];
  veto: { steps: { order: number; kind: string; team: "left" | "right" | null; mapName: string | null; side: HudSide | null; locked: boolean }[]; currentStep: number | null } | null;
  /** Stage table for studio/break screens (derived from completed results; ties shown as shared positions). */
  standings: HudStandings | null;
  bracket: HudBracket | null;
  settings: Record<string, unknown>;
  /** Pictures the operator added in the HUD Library (HUD images) for every Matchframe HUD. */
  art: HudArt;
}

/** A replay clip on air: who made the play and what it was. */
export interface HudReplayClip {
  /** The replay queue item. Another id is another clip (the next of a break's replays). */
  id: string;
  /** The round the play happened in. */
  roundNumber: number | null;
  /** The clip's label in the replay queue ("3K: name ▸ …", "Clutch 1v3: name"). */
  label: string;
  /** Who made the play; null when not known (a clip bookmarked by hand). */
  player: { steamId: string | null; name: string } | null;
  /** The player's team as the HUD shows it (left or right), with its name, logo and colour; null when not known. */
  team: { key: "left" | "right" | null; name: string; shortName: string; logoUrl: string | null; color: string | null } | null;
  /** The side the player was on in that round (sides swap at half time), not the side now; null when not known. */
  side: HudSide | null;
  /** The weapon ("weapon_ak47") and its name to show ("AK-47"); null when not known. */
  weapon: { name: string; displayName: string } | null;
  headshot: boolean;
  /** Who died, in order. */
  victims: string[];
  /** Kills in the clip; null when not counted (a clutch). */
  kills: number | null;
  /** "2K", "3K", "4K" or "ACE" for two kills or more. */
  multiKill: "2K" | "3K" | "4K" | "ACE" | null;
  /** A won clutch: how many opponents were left (1vN); null otherwise. */
  clutchVersus: number | null;
}

/** HUD images: pictures a HUD shows when it has none of its own for a player, map or mark. Empty when not set. */
export interface HudArt {
  /** For players without their own photo, by the side they play: player n takes picture n (cycling). */
  defaultPlayers: { ct: string[]; t: string[] };
  /** Per map name (e.g. "de_mirage"): a logo and a picture for series and veto tiles. */
  maps: Record<string, { logoUrl: string | null; imageUrl: string | null }>;
  /** Marks replacing a HUD's own: the dead player's icon. */
  icons: { dead: string | null };
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
