import type { MatchState, PlayerState } from "@matchframe/contracts";

/**
 * Is this a knife round? (Map intros, ADR-079.) CS2's game data has no "knife round" flag: a knife
 * round is an ordinary round as far as the game is concerned. What the common setups do, and what
 * shows in the game data a spectator's CS2 sends (GSI with `allplayers`):
 *
 * - **MatchZy and get5-style plugins:** after the warmup, a knife config (`mp_ct_default_secondary ""`,
 *   `mp_t_default_secondary ""`, `mp_give_player_c4 0`, `mp_maxmoney 0`, `mp_free_armor 1`) and a
 *   restart. The knife round is the map's round 1 at 0–0 with the map phase "live" (not warmup);
 *   every player spawns with a knife only and no money. After it the winner picks a side, the game
 *   restarts, and the real round 1 (the pistol round) is round 1 at 0–0 again, everyone with a
 *   pistol and the start money.
 * - **Plain `mp_` configs** (an admin's knife.cfg, then live.cfg): the same, the knife round being
 *   whatever round comes after the restart that loaded the knife config: round 1 at 0–0.
 *
 * So a knife round is told by the loadouts: in round 1 at 0–0 (map phase live), every player whose
 * weapons the game data lists has knives only (the bomb aside: a plain config may still hand it
 * out). One gun, grenade or Zeus on anyone and it isn't one. No money on everyone is reported as
 * supporting evidence only (configs differ). What it can't see:
 *
 * - without the players' weapons in the game data (a player's own GSI rather than a spectator's, or
 *   fewer than two players, or one side, listed), it says "unknown";
 * - a plugin that takes the pistols away only when the round starts (not at spawn) looks like a
 *   pistol round in freeze time;
 * - a knife round outside round 1 at 0–0 (in the warmup, or after rounds were played) is not one;
 * - a "knife and Zeus" round counts as not a knife round.
 */

/** How a weapon counts: a knife (any skin, or fists), the bomb (left aside), or anything else (a gun, a grenade, the Zeus). */
export type WeaponKind = "knife" | "bomb" | "armed";

export function weaponKind(w: { name: string; type?: string | null }): WeaponKind {
  const type = (w.type ?? "").toLowerCase().replace(/[\s_-]+/g, "");
  const name = w.name.toLowerCase();
  // Every knife skin is weapon_knife… or weapon_bayonet (CS2's type "Knife"); fists and melee items count as knives too.
  if (type === "knife" || type === "melee" || type === "fists" || /^weapon_(knife|bayonet|fists|melee)/.test(name)) return "knife";
  if (type === "c4" || name === "weapon_c4") return "bomb";
  return "armed";
}

/** What the loadouts say. */
export interface LoadoutEvidence {
  /** knife: everyone read has knives only; guns: someone has something else; unknown: too few loadouts in the game data. */
  verdict: "knife" | "guns" | "unknown";
  /** Players whose weapons were read: on a side, not a coach, not dead, with weapons listed. */
  read: number;
  knifeOnly: number;
  armed: number;
  /** Everyone read has no money (knife configs set `mp_maxmoney 0`): supporting, never decisive. */
  noMoney: boolean;
}

/** Fewer players' weapons than this (or one side's only) and the loadouts say nothing. */
const MIN_READ = 2;

/** The loadouts of the players the game data lists (see the module's comment). */
export function readLoadouts(players: readonly PlayerState[]): LoadoutEvidence {
  const read = players.filter((p) => (p.side === "T" || p.side === "CT") && !p.coach && p.lifeState !== "dead" && p.lifeState !== "disconnected" && p.weapons.length > 0);
  const sides = new Set(read.map((p) => p.side));
  const armed = read.filter((p) => p.weapons.some((w) => weaponKind(w) === "armed")).length;
  const knifeOnly = read.filter((p) => p.weapons.some((w) => weaponKind(w) === "knife") && p.weapons.every((w) => weaponKind(w) !== "armed")).length;
  const noMoney = read.length > 0 && read.every((p) => p.money === 0);
  const verdict = read.length < MIN_READ || sides.size < 2 ? "unknown" : armed > 0 ? "guns" : knifeOnly === read.length ? "knife" : "unknown";
  return { verdict, read: read.length, knifeOnly, armed, noMoney };
}

export type KnifeVerdict = "knife" | "not_knife" | "unknown";

export interface KnifeDetection {
  verdict: KnifeVerdict;
  /** Why, in a few words (the status and the log). */
  reason: string;
  loadouts: LoadoutEvidence | null;
}

/** The map's first round at 0–0, past the warmup: the only place a knife round (or the pistol round) is. */
export function firstRound(s: Pick<MatchState, "mapPhase" | "roundNumber" | "teams">): boolean {
  return s.mapPhase === "live" && s.roundNumber === 1 && (s.teams.CT.score ?? 0) === 0 && (s.teams.T.score ?? 0) === 0;
}

/**
 * Whether the round in the game data now (in its freeze time, or live) is a knife round: "knife",
 * "not_knife", or "unknown" when the game data doesn't list enough loadouts to tell.
 */
export function detectKnifeRound(s: Pick<MatchState, "mapPhase" | "roundNumber" | "roundPhase" | "teams" | "players">): KnifeDetection {
  if (s.mapPhase === "warmup") return { verdict: "not_knife", reason: "warmup", loadouts: null };
  if (!firstRound(s)) return { verdict: "not_knife", reason: "not the map's first round at 0–0", loadouts: null };
  if (s.roundPhase !== "freezetime" && s.roundPhase !== "live") return { verdict: "not_knife", reason: "the round is over", loadouts: null };
  const l = readLoadouts(s.players);
  if (l.verdict === "knife") return { verdict: "knife", reason: `knives only (${l.read} players${l.noMoney ? ", no money" : ""})`, loadouts: l };
  if (l.verdict === "guns") return { verdict: "not_knife", reason: `${l.armed} of ${l.read} players have a gun or grenade`, loadouts: l };
  return { verdict: "unknown", reason: l.read < MIN_READ ? "the players' weapons aren't in the game data" : "only one side's weapons are in the game data", loadouts: l };
}
