import type {
  GamePhase,
  LifeState,
  MapPhase,
  PlayerMatchStats,
  RoundPhase,
  Side,
  Vec3,
  WeaponState,
} from "@matchframe/contracts";
import { parseVec3 } from "../vec.ts";
import type { GsiPayload, GsiPlayer, GsiTeamRaw } from "./schema.ts";
import { GsiPayload as GsiPayloadSchema } from "./schema.ts";

export interface ObservedPlayer {
  steamId: string;
  name: string;
  observerSlot: number | null;
  side: Side | null;
  lifeState: LifeState;
  health: number | null;
  armor: number | null;
  helmet: boolean | null;
  defuseKit: boolean | null;
  flashed: number | null;
  smoked: number | null;
  burning: number | null;
  money: number | null;
  equipValue: number | null;
  roundKills: number | null;
  roundKillsHeadshot: number | null;
  roundDamage: number | null;
  matchStats: PlayerMatchStats;
  /** null = weapons component absent; [] = present and empty. */
  weapons: WeaponState[] | null;
  activeWeapon: WeaponState | null;
  position: Vec3 | null;
  forward: Vec3 | null;
  presence: { state: boolean; position: boolean; forward: boolean; weapons: boolean; stats: boolean };
}

/** Source-agnostic utility observation; GSI and parser/server adapters both produce these. */
export interface UtilityObservation {
  sourceEntityId: string;
  /** Raw type string from the source (e.g. GSI "frag", "firebomb", "inferno"). */
  rawType: string;
  ownerSteamId: string | null;
  position: Vec3 | null;
  velocity: Vec3 | null;
  lifetimeSec: number | null;
  effectTimeSec: number | null;
  /** Fire patch positions for fire effects; null when not supplied. */
  flames: Vec3[] | null;
}

export interface GsiObservation {
  sourceId: string;
  receivedAtMonotonicMs: number;
  payloadHash: string;
  providerSteamId: string | null;
  providerTimestampSec: number | null;
  gameVersion: number | null;
  components: {
    provider: boolean;
    map: boolean;
    round: boolean;
    player: boolean;
    allplayers: boolean;
    phaseCountdowns: boolean;
    bomb: boolean;
    grenades: boolean;
  };
  map: {
    name: string | null;
    mode: string | null;
    phase: MapPhase;
    round: number | null;
    ct: TeamObservation | null;
    t: TeamObservation | null;
    roundWins: Record<string, string> | null;
    matchesToWinSeries: number | null;
  } | null;
  round: { phase: RoundPhase; bomb: string | null; winTeam: Side | null } | null;
  /** The `player` block: in observer mode this is the currently spectated player. */
  observed: (ObservedPlayer & { activity: string | null; spectarget: string | null }) | null;
  /** null = allplayers absent; empty map = present but no players. */
  players: Map<string, ObservedPlayer> | null;
  phase: { phase: GamePhase; endsInSec: number | null } | null;
  bomb: { state: string | null; position: Vec3 | null; carrierSteamId: string | null; countdownSec: number | null } | null;
  /** null = grenades component absent; [] = present with no grenades (full snapshot semantics). */
  grenades: UtilityObservation[] | null;
  unknownComponents: string[];
}

export interface TeamObservation {
  score: number | null;
  name: string | null;
  flag: string | null;
  consecutiveRoundLosses: number | null;
  timeoutsRemaining: number | null;
  matchesWonThisSeries: number | null;
}

const KNOWN_COMPONENTS = new Set([
  "provider",
  "map",
  "round",
  "player",
  "allplayers",
  "phase_countdowns",
  "bomb",
  "grenades",
  "previously",
  "added",
  "auth",
]);

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function mapSide(team: unknown): Side | null {
  if (team === "CT") return "CT";
  if (team === "T") return "T";
  return null;
}

function mapPhase(p: unknown): MapPhase {
  switch (p) {
    case "warmup":
    case "live":
    case "intermission":
    case "gameover":
      return p;
    default:
      return "unknown";
  }
}

function roundPhase(p: unknown): RoundPhase {
  switch (p) {
    case "freezetime":
    case "live":
    case "over":
      return p;
    default:
      return "unknown";
  }
}

function gamePhase(p: unknown): GamePhase {
  switch (p) {
    case "warmup":
    case "freezetime":
    case "live":
    case "bomb":
    case "defuse":
    case "over":
    case "timeout_t":
    case "timeout_ct":
    case "paused":
    case "gameover":
      return p;
    default:
      return "unknown";
  }
}

function weaponState(s: unknown): WeaponState["state"] {
  if (s === "active" || s === "holstered" || s === "reloading") return s;
  return "unknown";
}

function normalizePlayer(steamId: string, p: GsiPlayer): ObservedPlayer {
  const st = p.state;
  const health = num(st?.health);
  let lifeState: LifeState = "unknown";
  if (health !== null) lifeState = health > 0 ? "alive" : "dead";
  let weapons: WeaponState[] | null = null;
  let activeWeapon: WeaponState | null = null;
  if (p.weapons) {
    weapons = Object.entries(p.weapons).map(([slotKey, w]) => ({
      slotKey,
      name: w.name ?? "unknown",
      type: str(w.type),
      state: weaponState(w.state),
      ammoClip: num(w.ammo_clip),
      ammoClipMax: num(w.ammo_clip_max),
      ammoReserve: num(w.ammo_reserve),
    }));
    activeWeapon = weapons.find((w) => w.state === "active" || w.state === "reloading") ?? null;
  }
  const flashedRaw = num(st?.flashed);
  const smokedRaw = num(st?.smoked);
  const burningRaw = num(st?.burning);
  return {
    steamId,
    name: p.name ?? steamId,
    observerSlot: num(p.observer_slot),
    side: mapSide(p.team),
    lifeState,
    health,
    armor: num(st?.armor),
    helmet: typeof st?.helmet === "boolean" ? st.helmet : null,
    defuseKit: typeof st?.defusekit === "boolean" ? st.defusekit : null,
    flashed: flashedRaw === null ? null : Math.min(1, Math.max(0, flashedRaw / 255)),
    smoked: smokedRaw === null ? null : Math.min(1, Math.max(0, smokedRaw / 255)),
    burning: burningRaw === null ? null : Math.min(1, Math.max(0, burningRaw / 255)),
    money: num(st?.money),
    equipValue: num(st?.equip_value),
    roundKills: num(st?.round_kills),
    roundKillsHeadshot: num(st?.round_killhs),
    roundDamage: num(st?.round_totaldmg),
    matchStats: {
      kills: num(p.match_stats?.kills),
      assists: num(p.match_stats?.assists),
      deaths: num(p.match_stats?.deaths),
      mvps: num(p.match_stats?.mvps),
      score: num(p.match_stats?.score),
    },
    weapons,
    activeWeapon,
    position: parseVec3(p.position),
    forward: parseVec3(p.forward),
    presence: {
      state: st !== undefined,
      position: p.position !== undefined,
      forward: p.forward !== undefined,
      weapons: p.weapons !== undefined,
      stats: p.match_stats !== undefined,
    },
  };
}

function team(t: GsiTeamRaw | undefined): TeamObservation | null {
  if (!t) return null;
  return {
    score: num(t.score),
    name: str(t.name),
    flag: str(t.flag),
    consecutiveRoundLosses: num(t.consecutive_round_losses),
    timeoutsRemaining: num(t.timeouts_remaining),
    matchesWonThisSeries: num(t.matches_won_this_series),
  };
}

export type ParseResult =
  | { ok: true; payload: GsiPayload }
  | { ok: false; error: string };

/** Validates structure. Authentication is checked separately by the ingest server. */
export function parseGsiPayload(raw: unknown): ParseResult {
  const r = GsiPayloadSchema.safeParse(raw);
  if (!r.success) return { ok: false, error: r.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  return { ok: true, payload: r.data };
}

/** Removes the auth token so it can never be persisted or broadcast. */
export function stripAuth(payload: GsiPayload): GsiPayload {
  if (!("auth" in payload)) return payload;
  const { auth: _auth, ...rest } = payload;
  return rest as GsiPayload;
}

export function normalizeGsi(
  payload: GsiPayload,
  meta: { sourceId: string; receivedAtMonotonicMs: number; payloadHash: string },
): GsiObservation {
  const unknownComponents = Object.keys(payload).filter((k) => !KNOWN_COMPONENTS.has(k));
  const m = payload.map;
  const players = payload.allplayers
    ? new Map(Object.entries(payload.allplayers).map(([sid, p]) => [sid, normalizePlayer(sid, p)]))
    : null;
  const observedRaw = payload.player;
  const observed =
    observedRaw && observedRaw.steamid
      ? {
          ...normalizePlayer(observedRaw.steamid, observedRaw),
          activity: str(observedRaw.activity),
          spectarget: str(observedRaw.spectarget),
        }
      : null;
  const grenades: UtilityObservation[] | null = payload.grenades
    ? Object.entries(payload.grenades).map(([id, g]) => ({
        sourceEntityId: id,
        rawType: g.type ?? "unknown",
        ownerSteamId: g.owner === undefined ? null : String(g.owner),
        position: parseVec3(g.position),
        velocity: parseVec3(g.velocity),
        lifetimeSec: num(g.lifetime),
        effectTimeSec: num(g.effecttime),
        flames: g.flames ? Object.values(g.flames).map(parseVec3).filter((v): v is Vec3 => v !== null) : null,
      }))
    : null;

  return {
    sourceId: meta.sourceId,
    receivedAtMonotonicMs: meta.receivedAtMonotonicMs,
    payloadHash: meta.payloadHash,
    providerSteamId: str(payload.provider?.steamid),
    providerTimestampSec: num(payload.provider?.timestamp),
    gameVersion: num(payload.provider?.version),
    components: {
      provider: payload.provider !== undefined,
      map: m !== undefined,
      round: payload.round !== undefined,
      player: payload.player !== undefined,
      allplayers: payload.allplayers !== undefined,
      phaseCountdowns: payload.phase_countdowns !== undefined,
      bomb: payload.bomb !== undefined,
      grenades: payload.grenades !== undefined,
    },
    map: m
      ? {
          name: str(m.name),
          mode: str(m.mode),
          phase: mapPhase(m.phase),
          round: num(m.round),
          ct: team(m.team_ct),
          t: team(m.team_t),
          roundWins: m.round_wins ?? null,
          matchesToWinSeries: num(m.num_matches_to_win_series),
        }
      : null,
    round: payload.round
      ? {
          phase: roundPhase(payload.round.phase),
          bomb: str(payload.round.bomb),
          winTeam: mapSide(payload.round.win_team),
        }
      : null,
    observed,
    players,
    phase: payload.phase_countdowns
      ? { phase: gamePhase(payload.phase_countdowns.phase), endsInSec: num(payload.phase_countdowns.phase_ends_in) }
      : null,
    bomb: payload.bomb
      ? {
          state: str(payload.bomb.state),
          position: parseVec3(payload.bomb.position),
          carrierSteamId: payload.bomb.player === undefined ? null : String(payload.bomb.player),
          countdownSec: num(payload.bomb.countdown),
        }
      : null,
    grenades,
    unknownComponents,
  };
}
