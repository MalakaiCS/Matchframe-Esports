import type { MapInstance, Match, MatchFormat } from "@matchframe/contracts";

/** Map winner under the configured regulation/overtime rules; null while undecided or tied. */
export function mapWinner(format: MatchFormat, scoreA: number, scoreB: number, teamAId: string, teamBId: string, completed: boolean): string | null {
  if (!completed) return null;
  if (scoreA === scoreB) return null; // a tie never silently advances the series
  const half = format.regulationRounds / 2;
  const regulationWin = Math.max(scoreA, scoreB) >= half + 1;
  if (!regulationWin && !format.allowTie) return null;
  return scoreA > scoreB ? teamAId : teamBId;
}

/** Series score derived only from completed maps with a winner (or forfeits recorded with a winner). */
export function seriesScore(match: Match, maps: MapInstance[]): { a: number; b: number; winnerTeamId: string | null } {
  let a = 0;
  let b = 0;
  for (const m of maps) {
    if (m.status !== "completed" && m.status !== "forfeited") continue;
    if (m.winnerTeamId === match.teamAId) a++;
    else if (m.winnerTeamId === match.teamBId) b++;
  }
  const needed = Math.floor(match.format.bestOf / 2) + 1;
  return { a, b, winnerTeamId: a >= needed ? match.teamAId : b >= needed ? match.teamBId : null };
}

/**
 * The match's series score: maps won (completed maps only, each counted once) plus the stored
 * manual correction. The winner is decided on this total.
 */
export function seriesTotals(match: Match, maps: MapInstance[]): { a: number; b: number; fromMapsA: number; fromMapsB: number; winnerTeamId: string | null } {
  const s = seriesScore(match, maps);
  const a = Math.max(0, s.a + (match.seriesCorrectionA ?? 0));
  const b = Math.max(0, s.b + (match.seriesCorrectionB ?? 0));
  const needed = Math.floor(match.format.bestOf / 2) + 1;
  return { a, b, fromMapsA: s.a, fromMapsB: s.b, winnerTeamId: a >= needed && a > b ? match.teamAId : b >= needed && b > a ? match.teamBId : null };
}
