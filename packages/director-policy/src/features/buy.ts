import type { MatchState, PlayerState } from "@matchframe/contracts";
import { projectCountdown } from "@matchframe/cs2-state";

/**
 * A team's buy this round: the pistol round; an eco (saving); a force buy (spending what they have
 * without a full buy, so they can't full buy next round if they lose); a half buy (a partial buy that
 * keeps the money for a full buy next round); a full buy; an anti-eco (a real buy against a team on
 * an eco).
 */
export type BuyType = "pistol" | "eco" | "force" | "half" | "full" | "anti_eco";

/** What a HUD shows for each buy type. */
export const BUY_LABELS: Record<BuyType, string> = {
  pistol: "PISTOL ROUND",
  eco: "ECO",
  force: "FORCE BUY",
  half: "HALF BUY",
  full: "FULL BUY",
  anti_eco: "ANTI-ECO",
};

export type WeaponClass = "rifle" | "smg" | "pistol";

/** One team's economy as the game data gives it. */
export interface TeamEconomy {
  side: "T" | "CT";
  /** Per player: money, equipment value, and the best weapon they carry (null: not known). */
  players: { money: number; equipment: number; weapon: WeaponClass | null }[];
  /** CS2's loss count (1 at the start of a half, +1 for a loss up to 5, −1 for a win), when known. */
  losses: number | null;
  /** Whether the team lost the round before, when known. */
  lostLast: boolean | null;
}

/** Where the round stands: its number, and the match's format (MR12 with MR3 overtime by default). */
export interface BuyRound {
  roundNumber: number | null;
  regulationRounds: number;
  overtimeRounds: number;
}

/** A team's buy, with what it was read from. */
export interface TeamBuy {
  side: "T" | "CT";
  type: BuyType;
  label: string;
  /** Read from what they could spend (before they bought), or from what they bought. */
  basis: "resources" | "equipment";
  /** Per player on average: equipment value and money. */
  equipment: number;
  money: number;
  players: number;
  /** Players carrying a rifle (or a sniper rifle), and an SMG, shotgun or machine gun. */
  rifles: number;
  smgs: number;
  /** What each player gets for losing this round (CS2's loss bonus, $1,400–3,400), when known. */
  lossBonus: number | null;
}

/** Both teams' buys this round, and whether they are final. */
export interface BuyStory {
  roundAttemptId: string | null;
  roundNumber: number | null;
  T: TeamBuy | null;
  CT: TeamBuy | null;
  /** Final for the round: read one second into the live round. */
  firm: boolean;
}

/** What a full buy costs a player: a rifle, a helmet and utility (a kit for the CTs). Money kept for that next round is a half buy's. */
const FULL_COST = { T: 4300, CT: 4500 } as const;
/** Money and kept equipment from which a team buys rifles and armour all round. */
const RIFLES_AFFORDABLE = { T: 4000, CT: 3600 } as const;
/** Equipment that reads as a full buy: rifles for all but one, or for all but two with this much on average, or this much whatever the guns. */
const FULL_RIFLES_EQUIPMENT = 3000;
const FULL_EQUIPMENT = { T: 3600, CT: 3900 } as const;
const RICH_EQUIPMENT = 4800;
/** Less equipment than this (pistols, a vest or two) is an eco whatever was kept. */
const ECO_EQUIPMENT = 900;
/** Less money and kept equipment than this buys nothing worth the name. */
const ECO_RESOURCES = 2000;
/** A team buying against an eco with at least this much equipment is on an anti-eco. */
const ANTI_ECO_EQUIPMENT = 2000;
/** The classification is read from the equipment from this many seconds before the end of freeze time, and final one second into the live round. */
export const BUY_FIRM_LEFT_SEC = 5;
export const BUY_FIRM_LIVE_MS = 1000;
/** A team has bought once at least half of it spent this much since freeze time began... */
const SPENT = 500;
/** ...and teams buy in the first seconds: after this long into freeze time, one that hasn't spent is saving. */
const BUY_DONE_MS = 6000;

const RIFLES = new Set(["weapon_ak47", "weapon_m4a1", "weapon_m4a1_silencer", "weapon_galilar", "weapon_famas", "weapon_aug", "weapon_sg556", "weapon_awp", "weapon_ssg08", "weapon_scar20", "weapon_g3sg1"]);
const SMGS = new Set(["weapon_mac10", "weapon_mp9", "weapon_mp7", "weapon_mp5sd", "weapon_ump45", "weapon_p90", "weapon_bizon", "weapon_nova", "weapon_xm1014", "weapon_sawedoff", "weapon_mag7", "weapon_m249", "weapon_negev"]);

/** A player's best weapon class from the game data's weapons (null when none are listed). */
export function weaponClass(p: Pick<PlayerState, "weapons">): WeaponClass | null {
  if (p.weapons.length === 0) return null;
  let best: WeaponClass = "pistol";
  for (const w of p.weapons) {
    const t = w.type ?? "";
    if (t === "Rifle" || t === "SniperRifle" || RIFLES.has(w.name)) return "rifle";
    if (t === "Submachine Gun" || t === "Shotgun" || t === "Machine Gun" || SMGS.has(w.name)) best = "smg";
  }
  return best;
}

/** The loss bonus for losing the next round, from CS2's loss count. */
export function lossBonusNext(losses: number | null): number | null {
  return losses === null ? null : 1400 + 500 * Math.min(4, Math.max(0, losses));
}

function roundKind(r: BuyRound): { pistol: boolean; lastOfHalf: boolean } {
  const n = r.roundNumber;
  if (n === null) return { pistol: false, lastOfHalf: false };
  const half = r.regulationRounds / 2;
  const otHalf = r.overtimeRounds / 2;
  return {
    // Overtime halves start with money for a full buy: no pistol round.
    pistol: n === 1 || n === half + 1,
    lastOfHalf: n === half || n === r.regulationRounds || (n > r.regulationRounds && (n - r.regulationRounds) % otHalf === 0),
  };
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function summary(team: TeamEconomy, basis: TeamBuy["basis"], type: BuyType): TeamBuy {
  return {
    side: team.side,
    type,
    label: BUY_LABELS[type],
    basis,
    equipment: Math.round(avg(team.players.map((p) => p.equipment))),
    money: Math.round(avg(team.players.map((p) => p.money))),
    players: team.players.length,
    rifles: team.players.filter((p) => p.weapon === "rifle").length,
    smgs: team.players.filter((p) => p.weapon === "smg").length,
    lossBonus: lossBonusNext(team.losses),
  };
}

/**
 * Before they buy (the start of freeze time): what they will buy, from the money and kept equipment
 * they have, the loss bonus, the round and the round before. Rifles and armour all round in reach:
 * a full buy. Not enough for anything: an eco. In between: the last round of a half, or after a win,
 * they spend it (a force buy); after a loss they save when saving brings a full buy next round (an
 * eco), and force when even that wouldn't.
 */
export function buyFromResources(team: TeamEconomy, round: BuyRound): BuyType {
  const k = roundKind(round);
  if (k.pistol) return "pistol";
  const resources = avg(team.players.map((p) => p.money + p.equipment));
  const money = avg(team.players.map((p) => p.money));
  if (resources >= RIFLES_AFFORDABLE[team.side]) return "full";
  if (k.lastOfHalf) return resources >= ECO_RESOURCES / 2 ? "force" : "eco";
  if (resources < ECO_RESOURCES) return "eco";
  if (team.lostLast === false) return "force";
  const bonus = lossBonusNext(team.losses) ?? 1900;
  return money + bonus >= FULL_COST[team.side] ? "eco" : "force";
}

/**
 * After they bought (the end of freeze time): rifles all round (or nearly, with enough equipment) is a
 * full buy; next to nothing an eco. In between, money kept for a full buy next round (counting the
 * loss bonus) is a half buy, or an eco with one main weapon or none; spent so a full buy next round is
 * out of reach, a force buy.
 */
export function buyFromEquipment(team: TeamEconomy, round: BuyRound): BuyType {
  if (roundKind(round).pistol) return "pistol";
  const n = team.players.length;
  const e = avg(team.players.map((p) => p.equipment));
  const money = avg(team.players.map((p) => p.money));
  const known = team.players.some((p) => p.weapon !== null);
  const rifles = team.players.filter((p) => p.weapon === "rifle").length;
  const mains = rifles + team.players.filter((p) => p.weapon === "smg").length;
  if (e >= RICH_EQUIPMENT || (known && ((rifles >= n - 1 && e >= FULL_RIFLES_EQUIPMENT) || (rifles >= n - 2 && e >= FULL_EQUIPMENT[team.side])))) return "full";
  if (!known && e >= FULL_EQUIPMENT[team.side]) return "full";
  if (e < ECO_EQUIPMENT) return "eco";
  const bonus = roundKind(round).lastOfHalf ? 0 : (lossBonusNext(team.losses) ?? 1900);
  if (money + bonus >= FULL_COST[team.side]) return (known ? mains <= 1 : e < 1500) ? "eco" : "half";
  return "force";
}

/** A team buying (with real equipment) against a team on an eco is on an anti-eco. */
function antiEco(type: BuyType, other: BuyType | null, team: TeamEconomy, basis: TeamBuy["basis"]): BuyType {
  if (other !== "eco" || type === "eco" || type === "pistol") return type;
  const value = avg(team.players.map((p) => (basis === "equipment" ? p.equipment : p.money + p.equipment)));
  return value >= ANTI_ECO_EQUIPMENT ? "anti_eco" : type;
}

/** Both teams' buys from their economies, each read from resources or from what it bought. */
export function classifyBuys(teams: { T: TeamEconomy | null; CT: TeamEconomy | null }, basis: { T: TeamBuy["basis"]; CT: TeamBuy["basis"] }, round: BuyRound): { T: TeamBuy | null; CT: TeamBuy | null } {
  const base = (t: TeamEconomy | null, b: TeamBuy["basis"]) => (t && t.players.length ? (b === "equipment" ? buyFromEquipment(t, round) : buyFromResources(t, round)) : null);
  const bt = base(teams.T, basis.T);
  const bct = base(teams.CT, basis.CT);
  return {
    T: teams.T && bt ? summary(teams.T, basis.T, antiEco(bt, bct, teams.T, basis.T)) : null,
    CT: teams.CT && bct ? summary(teams.CT, basis.CT, antiEco(bct, bt, teams.CT, basis.CT)) : null,
  };
}

/** A team's economy from the match state (coaches left out). */
export function teamEconomy(state: MatchState, side: "T" | "CT"): TeamEconomy | null {
  const players = state.players.filter((p) => p.side === side && !p.coach && (p.money !== null || p.equipValue !== null));
  if (players.length === 0) return null;
  const last = state.roundHistory.at(-1);
  const roundNumber = state.roundNumber;
  // The round before this one, when the history has it (the round number moves on as a round ends).
  const lastResult = last && roundNumber !== null && last.roundNumber >= roundNumber - 1 && last.winnerSide ? last.winnerSide !== side : null;
  return {
    side,
    players: players.map((p) => ({ money: p.money ?? 0, equipment: p.equipValue ?? 0, weapon: weaponClass(p) })),
    losses: state.teams[side].consecutiveRoundLosses,
    lostLast: lastResult,
  };
}

/**
 * Each team's buy through a round. In freeze time it is read from what the team could spend until it
 * has bought (half of it spent $500 or more) or 6 s have gone by, then from what it bought, which is
 * how it is read in the freeze time's last 5 s and the first second of the live round; from then on it
 * is final for the round. A round first seen live is read from what the teams carry.
 */
export class BuyTracker {
  private round: string | null = null;
  private start = new Map<string, number>();
  private firm: BuyStory | null = null;
  private freezeSince: number | null = null;
  private liveSince: number | null = null;

  update(state: MatchState, now: number, opts: { regulationRounds: number; overtimeRounds: number }): BuyStory | null {
    if (state.roundAttemptId !== this.round) {
      this.round = state.roundAttemptId;
      this.start.clear();
      this.firm = null;
      this.freezeSince = null;
      this.liveSince = null;
    }
    if (this.firm) return this.firm;
    const phase = state.roundPhase;
    if (phase !== "freezetime" && phase !== "live") return null;
    const round: BuyRound = { roundNumber: state.roundNumber, ...opts };
    const T = teamEconomy(state, "T");
    const CT = teamEconomy(state, "CT");
    if (!T && !CT) return null;
    let basis: { T: TeamBuy["basis"]; CT: TeamBuy["basis"] } = { T: "equipment", CT: "equipment" };
    if (phase === "freezetime") {
      this.freezeSince ??= now;
      for (const p of state.players) if (p.money !== null && !this.start.has(p.steamId)) this.start.set(p.steamId, p.money);
      const left = projectCountdown({ countdownSec: state.phaseEndsInSec, observedAtMonotonicMs: state.phaseObservedAtMonotonicMs, nowMonotonicMs: now, running: !state.paused }).remainingSec;
      const late = (left !== null && left <= BUY_FIRM_LEFT_SEC) || now - this.freezeSince >= BUY_DONE_MS;
      const bought = (side: "T" | "CT") => {
        const team = state.players.filter((p) => p.side === side && !p.coach && p.money !== null);
        return team.filter((p) => (this.start.get(p.steamId) ?? p.money!) - p.money! >= SPENT).length * 2 >= team.length && team.length > 0;
      };
      basis = { T: late || bought("T") ? "equipment" : "resources", CT: late || bought("CT") ? "equipment" : "resources" };
    } else this.liveSince ??= now;
    const story: BuyStory = { roundAttemptId: state.roundAttemptId, roundNumber: state.roundNumber, ...classifyBuys({ T, CT }, basis, round), firm: false };
    if (phase === "live" && now - this.liveSince! >= BUY_FIRM_LIVE_MS) {
      this.firm = { ...story, firm: true };
      return this.firm;
    }
    return story;
  }
}
