import type { MatchState, Side } from "@matchframe/contracts";

/**
 * Where the match stands, for the big-moment shots: a pistol round, a team on match point, half
 * time, the end of the map, and who won the round that just ended (and whether it was a big one).
 * Round counts assume `regulationRounds` (MR12: 24) and overtime halves of `overtimeRounds / 2`.
 */
export interface MatchMoment {
  pistol: boolean;
  /** The side(s) one round from winning the map. */
  matchPoint: Side[];
  halfTime: boolean;
  mapEnd: boolean;
  /** The winner of the round that just ended (round over, half time, map end), else null. */
  lastWinner: Side | null;
  /** That round mattered: a pistol round, the last of a half, the map, or it put the winner on match point. */
  lastRoundBig: boolean;
}

export function matchMoment(state: MatchState, opts: { regulationRounds: number; overtimeRounds: number }): MatchMoment {
  const reg = opts.regulationRounds;
  const half = reg / 2;
  const t = state.teams.T.score ?? 0;
  const ct = state.teams.CT.score ?? 0;
  const played = t + ct;
  /** Score that wins the map with `p` rounds played. */
  const winScore = (p: number) => (p < reg ? half + 1 : half + Math.floor((p - reg) / opts.overtimeRounds) * (opts.overtimeRounds / 2) + opts.overtimeRounds / 2 + 1);
  const n = state.roundNumber ?? played + 1;
  const halfTime = state.gamePhase === "halftime";
  const mapEnd = state.gamePhase === "gameover";
  const over = state.roundPhase === "over" || halfTime || mapEnd;
  const last = state.roundHistory.at(-1);
  // The result of the round that just ended (the round number moves on when it ends).
  const lastWinner = over && last && last.roundNumber >= played ? last.winnerSide : null;
  const winner = lastWinner === "T" ? t : ct;
  const lastRoundBig =
    lastWinner !== null &&
    (played === 1 || // the first pistol round
      played === half + 1 || // the second
      played === half || // the end of a half
      played === reg ||
      (played > reg && (played - reg) % (opts.overtimeRounds / 2) === 0) ||
      mapEnd ||
      winner >= winScore(played - 1) || // won the map
      winner === winScore(played) - 1); // now on match point
  const point = winScore(played) - 1;
  return {
    pistol: !over && (n === 1 || n === half + 1),
    matchPoint: mapEnd ? [] : (["T", "CT"] as const).filter((s) => (s === "T" ? t : ct) === point),
    halfTime,
    mapEnd,
    lastWinner,
    lastRoundBig,
  };
}
