import { z } from "zod";

/**
 * Loose schema for raw CS2 Game State Integration payloads.
 *
 * Field names follow the publicly documented GSI format. They have NOT yet been confirmed
 * against a captured payload from the target build in this repository's test environment;
 * the capability sampler records what actually arrives. Unknown fields are preserved.
 * Numbers that GSI sends as strings (countdowns, grenade lifetimes) are coerced.
 */
const numeric = z.preprocess((v) => {
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  }
  return v;
}, z.number());

const optNum = numeric.optional();

export const GsiWeapon = z.looseObject({
  name: z.string().optional(),
  paintkit: z.string().optional(),
  type: z.string().optional(),
  state: z.string().optional(),
  ammo_clip: optNum,
  ammo_clip_max: optNum,
  ammo_reserve: optNum,
});

export const GsiPlayerState = z.looseObject({
  health: optNum,
  armor: optNum,
  helmet: z.boolean().optional(),
  defusekit: z.boolean().optional(),
  flashed: optNum,
  smoked: optNum,
  burning: optNum,
  money: optNum,
  round_kills: optNum,
  round_killhs: optNum,
  round_totaldmg: optNum,
  equip_value: optNum,
});

export const GsiMatchStats = z.looseObject({
  kills: optNum,
  assists: optNum,
  deaths: optNum,
  mvps: optNum,
  score: optNum,
});

export const GsiPlayer = z.looseObject({
  steamid: z.string().optional(),
  name: z.string().optional(),
  clan: z.string().optional(),
  observer_slot: optNum,
  team: z.string().optional(),
  activity: z.string().optional(),
  spectarget: z.string().optional(),
  state: GsiPlayerState.optional(),
  match_stats: GsiMatchStats.optional(),
  weapons: z.record(z.string(), GsiWeapon).optional(),
  position: z.string().optional(),
  forward: z.string().optional(),
});

export const GsiTeam = z.looseObject({
  score: optNum,
  name: z.string().optional(),
  flag: z.string().optional(),
  consecutive_round_losses: optNum,
  timeouts_remaining: optNum,
  matches_won_this_series: optNum,
});

export const GsiGrenade = z.looseObject({
  owner: z.union([z.string(), z.number()]).optional(),
  position: z.string().optional(),
  velocity: z.string().optional(),
  lifetime: optNum,
  type: z.string().optional(),
  effecttime: optNum,
  flames: z.record(z.string(), z.string()).optional(),
});

export const GsiPayload = z.looseObject({
  provider: z
    .looseObject({
      name: z.string().optional(),
      appid: optNum,
      version: optNum,
      steamid: z.string().optional(),
      timestamp: optNum,
    })
    .optional(),
  map: z
    .looseObject({
      mode: z.string().optional(),
      name: z.string().optional(),
      phase: z.string().optional(),
      round: optNum,
      team_ct: GsiTeam.optional(),
      team_t: GsiTeam.optional(),
      num_matches_to_win_series: optNum,
      round_wins: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  round: z
    .looseObject({
      phase: z.string().optional(),
      bomb: z.string().optional(),
      win_team: z.string().optional(),
    })
    .optional(),
  player: GsiPlayer.optional(),
  allplayers: z.record(z.string(), GsiPlayer).optional(),
  phase_countdowns: z
    .looseObject({
      phase: z.string().optional(),
      phase_ends_in: optNum,
    })
    .optional(),
  bomb: z
    .looseObject({
      state: z.string().optional(),
      position: z.string().optional(),
      player: z.union([z.string(), z.number()]).optional(),
      countdown: optNum,
    })
    .optional(),
  grenades: z.record(z.string(), GsiGrenade).optional(),
  previously: z.unknown().optional(),
  added: z.unknown().optional(),
  auth: z.looseObject({ token: z.string().optional() }).optional(),
});
export type GsiPayload = z.infer<typeof GsiPayload>;
export type GsiPlayer = z.infer<typeof GsiPlayer>;
export type GsiGrenade = z.infer<typeof GsiGrenade>;
export type GsiTeamRaw = z.infer<typeof GsiTeam>;

/** Maximum accepted request body. Real payloads with allplayers + grenades are a few tens of KB. */
export const GSI_MAX_BODY_BYTES = 512 * 1024;
