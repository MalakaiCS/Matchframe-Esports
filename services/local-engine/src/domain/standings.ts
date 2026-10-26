import type { BracketNode, EventStage, MapInstance, Match, StageTiebreaker } from "@matchframe/contracts";

export interface StandingRow {
  teamId: string;
  position: number;
  /** True when tiebreakers could not separate this team from another (shared position). */
  tied: boolean;
  advancing: boolean;
  /** The advancement cut falls inside an unresolved tie that includes this team. */
  cutUnresolved: boolean;
  played: number;
  wins: number;
  ties: number;
  losses: number;
  points: number;
  mapsWon: number;
  mapsLost: number;
  mapDifference: number;
  roundDifference: number;
  opponentWins: number;
}

export interface StandingsResult {
  stageId: string;
  kind: EventStage["kind"];
  rows: StandingRow[];
  /** Completed matches that could not be counted, with the reason (never guessed). */
  excluded: { matchId: string; reason: string }[];
  pendingMatches: number;
}

interface Outcome {
  match: Match;
  a: string;
  b: string;
  /** 1 = A won, -1 = B won, 0 = tie. */
  result: 1 | -1 | 0;
  roundsA: number;
  roundsB: number;
}

function outcomes(stage: EventStage, matches: Match[], maps: MapInstance[], excluded: StandingsResult["excluded"]): Outcome[] {
  const out: Outcome[] = [];
  for (const m of matches) {
    if (m.stageId !== stage.id || m.status !== "completed") continue;
    const own = maps.filter((mi) => mi.matchId === m.id && mi.status === "completed");
    let result: Outcome["result"];
    if (m.seriesScoreA > m.seriesScoreB) result = 1;
    else if (m.seriesScoreB > m.seriesScoreA) result = -1;
    else if (m.format.allowTie) result = 0;
    else {
      excluded.push({ matchId: m.id, reason: "completed without a series winner and the format does not allow ties" });
      continue;
    }
    out.push({ match: m, a: m.teamAId, b: m.teamBId, result, roundsA: own.reduce((s, mi) => s + mi.scoreA, 0), roundsB: own.reduce((s, mi) => s + mi.scoreB, 0) });
  }
  return out;
}

function table(teamIds: Iterable<string>, results: Outcome[], points: EventStage["points"]): Map<string, StandingRow> {
  const rows = new Map<string, StandingRow>();
  const row = (id: string) => {
    let r = rows.get(id);
    if (!r) {
      r = { teamId: id, position: 0, tied: false, advancing: false, cutUnresolved: false, played: 0, wins: 0, ties: 0, losses: 0, points: 0, mapsWon: 0, mapsLost: 0, mapDifference: 0, roundDifference: 0, opponentWins: 0 };
      rows.set(id, r);
    }
    return r;
  };
  for (const id of teamIds) row(id);
  for (const o of results) {
    const ra = row(o.a);
    const rb = row(o.b);
    ra.played++;
    rb.played++;
    if (o.result === 1) {
      ra.wins++;
      rb.losses++;
    } else if (o.result === -1) {
      rb.wins++;
      ra.losses++;
    } else {
      ra.ties++;
      rb.ties++;
    }
    ra.mapsWon += o.match.seriesScoreA;
    ra.mapsLost += o.match.seriesScoreB;
    rb.mapsWon += o.match.seriesScoreB;
    rb.mapsLost += o.match.seriesScoreA;
    ra.roundDifference += o.roundsA - o.roundsB;
    rb.roundDifference += o.roundsB - o.roundsA;
  }
  for (const r of rows.values()) {
    r.points = r.wins * points.win + r.ties * points.tie + r.losses * points.loss;
    r.mapDifference = r.mapsWon - r.mapsLost;
  }
  for (const o of results) {
    rows.get(o.a)!.opponentWins += rows.get(o.b)!.wins;
    rows.get(o.b)!.opponentWins += rows.get(o.a)!.wins;
  }
  return rows;
}

/**
 * Orders a group of teams level on points by the stage's tiebreakers in sequence. Head-to-head
 * uses only matches among the still-tied teams (re-applied as the group splits). Teams no
 * tiebreaker separates share a position and are flagged — no coin flips or name ordering.
 */
function resolveTies(group: StandingRow[], tiebreakers: StageTiebreaker[], results: Outcome[], points: EventStage["points"]): StandingRow[][] {
  if (group.length <= 1 || tiebreakers.length === 0) return [group];
  const [tb, ...rest] = tiebreakers;
  let key: (r: StandingRow) => number;
  if (tb === "head_to_head") {
    const ids = new Set(group.map((r) => r.teamId));
    const mini = table(ids, results.filter((o) => ids.has(o.a) && ids.has(o.b)), points);
    key = (r) => mini.get(r.teamId)!.points;
  } else if (tb === "map_difference") key = (r) => r.mapDifference;
  else if (tb === "round_difference") key = (r) => r.roundDifference;
  else if (tb === "maps_won") key = (r) => r.mapsWon;
  else key = (r) => r.opponentWins;
  const buckets = new Map<number, StandingRow[]>();
  for (const r of group) buckets.set(key(r), [...(buckets.get(key(r)) ?? []), r]);
  const ordered = [...buckets.entries()].sort((x, y) => y[0] - x[0]).map(([, rows]) => rows);
  return ordered.flatMap((b) => resolveTies(b, rest, results, points));
}

export function computeStandings(stage: EventStage, matches: Match[], maps: MapInstance[]): StandingsResult {
  const excluded: StandingsResult["excluded"] = [];
  const results = outcomes(stage, matches, maps, excluded);
  const rows = [...table(stage.teamIds, results, stage.points).values()];
  const byPoints = new Map<number, StandingRow[]>();
  for (const r of rows) byPoints.set(r.points, [...(byPoints.get(r.points) ?? []), r]);
  const groups = [...byPoints.entries()].sort((a, b) => b[0] - a[0]).flatMap(([, g]) => resolveTies(g, stage.tiebreakers, results, stage.points));
  const out: StandingRow[] = [];
  let position = 1;
  for (const g of groups) {
    for (const r of g.sort((a, b) => a.teamId.localeCompare(b.teamId))) out.push({ ...r, position, tied: g.length > 1 });
    position += g.length;
  }
  for (const r of out) {
    const lastPosition = r.position + out.filter((x) => x.position === r.position).length - 1;
    r.advancing = stage.advancing > 0 && lastPosition <= stage.advancing;
    r.cutUnresolved = stage.advancing > 0 && r.position <= stage.advancing && lastPosition > stage.advancing;
  }
  const pending = matches.filter((m) => m.stageId === stage.id && m.status !== "completed" && m.status !== "cancelled").length;
  return { stageId: stage.id, kind: stage.kind, rows: out, excluded, pendingMatches: pending };
}

export interface BracketSide {
  teamId: string | null;
  /** Shown when the team is not known yet, e.g. "Winner of SF1". */
  placeholder: string | null;
  score: number | null;
  winner: boolean;
}

export interface BracketViewNode {
  id: string;
  round: number;
  slot: number;
  label: string;
  matchId: string | null;
  status: Match["status"] | "not_scheduled";
  a: BracketSide;
  b: BracketSide;
  /** Set when the stored match teams contradict the bracket sources. */
  conflict: string | null;
}

export function validateBracket(nodes: BracketNode[]): string[] {
  const issues: string[] = [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (byId.size !== nodes.length) issues.push("duplicate node ids");
  const slots = new Set<string>();
  for (const n of nodes) {
    const k = `${n.round}:${n.slot}`;
    if (slots.has(k)) issues.push(`two nodes in round ${n.round} slot ${n.slot}`);
    slots.add(k);
    for (const src of [n.teamAFrom, n.teamBFrom]) {
      if (!src) continue;
      const from = byId.get(src.nodeId);
      if (!from) issues.push(`${n.id}: source ${src.nodeId} does not exist`);
      else if (from.round >= n.round) issues.push(`${n.id}: source ${src.nodeId} is not in an earlier round`);
    }
  }
  return issues;
}

export function buildBracket(stage: EventStage, matches: Match[]): BracketViewNode[] {
  const byMatch = new Map(matches.map((m) => [m.id, m]));
  const nodes = [...stage.bracket].sort((a, b) => a.round - b.round || a.slot - b.slot);
  const label = (n: BracketNode) => n.label ?? `R${n.round} M${n.slot}`;
  const view = new Map<string, BracketViewNode>();
  const decided = (v: BracketViewNode | undefined, outcome: "winner" | "loser"): string | null => {
    if (!v || v.status !== "completed") return null;
    const aWon = v.a.winner;
    const bWon = v.b.winner;
    if (!aWon && !bWon) return null;
    return outcome === "winner" ? (aWon ? v.a.teamId : v.b.teamId) : aWon ? v.b.teamId : v.a.teamId;
  };
  for (const n of nodes) {
    const m = n.matchId ? byMatch.get(n.matchId) : undefined;
    const src = (s: BracketNode["teamAFrom"]) => (s ? { teamId: decided(view.get(s.nodeId), s.outcome), placeholder: `${s.outcome === "winner" ? "Winner" : "Loser"} of ${view.get(s.nodeId)?.label ?? s.nodeId}` } : { teamId: null, placeholder: "TBD" });
    const fromA = src(n.teamAFrom);
    const fromB = src(n.teamBFrom);
    const done = m?.status === "completed";
    const aWins = !!m && done && m.seriesScoreA > m.seriesScoreB;
    const bWins = !!m && done && m.seriesScoreB > m.seriesScoreA;
    let conflict: string | null = null;
    if (m && ((fromA.teamId && fromA.teamId !== m.teamAId) || (fromB.teamId && fromB.teamId !== m.teamBId))) conflict = "match teams differ from the teams that advanced into this slot";
    const side = (teamId: string | null, from: { teamId: string | null; placeholder: string }, score: number | null, winner: boolean): BracketSide => ({ teamId: teamId ?? from.teamId, placeholder: (teamId ?? from.teamId) ? null : from.placeholder, score, winner });
    view.set(n.id, {
      id: n.id,
      round: n.round,
      slot: n.slot,
      label: label(n),
      matchId: n.matchId,
      status: m?.status ?? "not_scheduled",
      a: side(m?.teamAId ?? null, fromA, m && m.status !== "scheduled" ? m.seriesScoreA : null, aWins),
      b: side(m?.teamBId ?? null, fromB, m && m.status !== "scheduled" ? m.seriesScoreB : null, bWins),
      conflict,
    });
  }
  return nodes.map((n) => view.get(n.id)!);
}
