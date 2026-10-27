import type { Side, Vec3 } from "@matchframe/contracts";

/**
 * SYNTHETIC GSI payload builder for tests and the visibly-labelled simulation mode.
 * Output follows the publicly documented GSI field layout; it is not a captured real payload
 * and must never be presented as evidence of real-game behaviour.
 */
export interface SyntheticPlayer {
  steamId: string;
  name: string;
  slot: number;
  side: Side;
  health?: number;
  armor?: number;
  helmet?: boolean;
  defuseKit?: boolean;
  flashed?: number;
  money?: number;
  equipValue?: number;
  roundKills?: number;
  roundKillsHs?: number;
  roundDamage?: number;
  kills?: number;
  assists?: number;
  deaths?: number;
  mvps?: number;
  score?: number;
  position?: Vec3 | null;
  forward?: Vec3 | null;
  weapons?: { name: string; type?: string; state?: "active" | "holstered" | "reloading"; ammoClip?: number; ammoClipMax?: number; ammoReserve?: number }[];
}

export interface SyntheticGrenade {
  id: string;
  type: string;
  owner: string;
  position: Vec3;
  velocity?: Vec3;
  lifetime?: number;
  effecttime?: number;
  flames?: Vec3[];
}

export interface SyntheticPayloadSpec {
  providerSteamId?: string;
  version?: number;
  timestamp?: number;
  mapName?: string;
  mapPhase?: "warmup" | "live" | "intermission" | "gameover";
  /** 0-based count of rounds played (GSI map.round). */
  round?: number;
  scoreCT?: number;
  scoreT?: number;
  ctName?: string;
  tName?: string;
  roundWins?: Record<string, string>;
  roundPhase?: "freezetime" | "live" | "over";
  roundBomb?: "planted" | "exploded" | "defused";
  winTeam?: Side;
  phase?: string;
  phaseEndsIn?: number;
  players?: SyntheticPlayer[];
  /** SteamID of the spectated player; omit for free camera. */
  observed?: string | null;
  bomb?: { state: string; position?: Vec3; player?: string; countdown?: number };
  grenades?: SyntheticGrenade[] | null;
  token?: string;
  omitAllPlayers?: boolean;
}

const v = (p: Vec3) => `${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`;

function playerBlock(p: SyntheticPlayer): Record<string, unknown> {
  const weapons: Record<string, unknown> = {};
  (p.weapons ?? []).forEach((w, i) => {
    weapons[`weapon_${i}`] = {
      name: w.name,
      paintkit: "default",
      ...(w.type ? { type: w.type } : {}),
      state: w.state ?? "holstered",
      ...(w.ammoClip !== undefined ? { ammo_clip: w.ammoClip } : {}),
      ...(w.ammoClipMax !== undefined ? { ammo_clip_max: w.ammoClipMax } : {}),
      ...(w.ammoReserve !== undefined ? { ammo_reserve: w.ammoReserve } : {}),
    };
  });
  return {
    steamid: p.steamId,
    name: p.name,
    observer_slot: p.slot,
    team: p.side,
    state: {
      health: p.health ?? 100,
      armor: p.armor ?? 100,
      helmet: p.helmet ?? true,
      ...(p.defuseKit !== undefined ? { defusekit: p.defuseKit } : {}),
      flashed: p.flashed ?? 0,
      smoked: 0,
      burning: 0,
      money: p.money ?? 800,
      round_kills: p.roundKills ?? 0,
      round_killhs: p.roundKillsHs ?? 0,
      round_totaldmg: p.roundDamage ?? 0,
      equip_value: p.equipValue ?? 1000,
    },
    match_stats: {
      kills: p.kills ?? 0,
      assists: p.assists ?? 0,
      deaths: p.deaths ?? 0,
      mvps: p.mvps ?? 0,
      score: p.score ?? 0,
    },
    weapons,
    ...(p.position ? { position: v(p.position) } : {}),
    ...(p.forward ? { forward: v(p.forward) } : {}),
  };
}

export function buildSyntheticGsiPayload(spec: SyntheticPayloadSpec): Record<string, unknown> {
  const players = spec.players ?? [];
  const payload: Record<string, unknown> = {
    provider: {
      name: "Counter-Strike: Global Offensive",
      appid: 730,
      version: spec.version ?? 14000,
      steamid: spec.providerSteamId ?? "76561190000000000",
      timestamp: spec.timestamp ?? 1_700_000_000,
    },
    map: {
      mode: "competitive",
      name: spec.mapName ?? "de_inferno",
      phase: spec.mapPhase ?? "live",
      round: spec.round ?? 0,
      team_ct: { score: spec.scoreCT ?? 0, consecutive_round_losses: 0, timeouts_remaining: 4, matches_won_this_series: 0, ...(spec.ctName ? { name: spec.ctName } : {}) },
      team_t: { score: spec.scoreT ?? 0, consecutive_round_losses: 0, timeouts_remaining: 4, matches_won_this_series: 0, ...(spec.tName ? { name: spec.tName } : {}) },
      num_matches_to_win_series: 0,
      ...(spec.roundWins ? { round_wins: spec.roundWins } : {}),
    },
    round: {
      phase: spec.roundPhase ?? "live",
      ...(spec.roundBomb ? { bomb: spec.roundBomb } : {}),
      ...(spec.winTeam ? { win_team: spec.winTeam } : {}),
    },
  };
  if (spec.phase) payload.phase_countdowns = { phase: spec.phase, phase_ends_in: String(spec.phaseEndsIn ?? 0) };
  if (!spec.omitAllPlayers) payload.allplayers = Object.fromEntries(players.map((p) => [p.steamId, playerBlock(p)]));
  const observed = spec.observed === undefined ? players[0]?.steamId : spec.observed;
  const obsPlayer = observed ? players.find((p) => p.steamId === observed) : undefined;
  payload.player = obsPlayer
    ? playerBlock(obsPlayer)
    : { steamid: spec.providerSteamId ?? "76561190000000000", name: "observer", activity: "playing" };
  if (spec.bomb) {
    payload.bomb = {
      state: spec.bomb.state,
      ...(spec.bomb.position ? { position: v(spec.bomb.position) } : {}),
      ...(spec.bomb.player ? { player: spec.bomb.player } : {}),
      ...(spec.bomb.countdown !== undefined ? { countdown: String(spec.bomb.countdown) } : {}),
    };
  }
  if (spec.grenades !== null && spec.grenades !== undefined) {
    payload.grenades = Object.fromEntries(
      spec.grenades.map((g) => [
        g.id,
        {
          owner: g.owner,
          position: v(g.position),
          ...(g.velocity ? { velocity: v(g.velocity) } : {}),
          lifetime: String(g.lifetime ?? 0),
          type: g.type,
          ...(g.effecttime !== undefined ? { effecttime: String(g.effecttime) } : {}),
          ...(g.flames ? { flames: Object.fromEntries(g.flames.map((f, i) => [`flame_${i}`, v(f)])) } : {}),
        },
      ]),
    );
  }
  if (spec.token) payload.auth = { token: spec.token };
  return payload;
}

/** Ten-player synthetic roster used by tests and the simulation scenarios. */
export function syntheticRoster(): SyntheticPlayer[] {
  const t: SyntheticPlayer[] = [1, 2, 3, 4, 5].map((i) => ({
    steamId: `7656119800000000${i}`,
    name: `T-Player-${i}`,
    slot: i,
    side: "T",
    weapons: [{ name: "weapon_ak47", type: "Rifle", state: "active", ammoClip: 30, ammoClipMax: 30, ammoReserve: 90 }],
  }));
  const ct: SyntheticPlayer[] = [6, 7, 8, 9, 0].map((i) => ({
    steamId: `7656119800000001${i}`,
    name: `CT-Player-${i}`,
    slot: i,
    side: "CT",
    weapons: [{ name: "weapon_m4a1", type: "Rifle", state: "active", ammoClip: 25, ammoClipMax: 25, ammoReserve: 75 }],
  }));
  return [...t, ...ct];
}
