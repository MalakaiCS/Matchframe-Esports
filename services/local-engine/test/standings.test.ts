import { describe, expect, it } from "vitest";
import type { EventStage, MapInstance, Match } from "@matchframe/contracts";
import { EventStage as EventStageSchema } from "@matchframe/contracts";
import { buildBracket, computeStandings, validateBracket } from "../src/domain/standings.ts";

const fmt = { bestOf: 1, regulationRounds: 24, overtimeEnabled: true, overtimeRounds: 6, allowTie: false };
let n = 0;
function match(a: string, b: string, sa: number, sb: number, opts: Partial<Match> = {}): Match {
  return { id: `m${++n}`, eventId: "ev", stageId: "g1", teamAId: a, teamBId: b, format: fmt, status: "completed", scheduledAt: null, seriesScoreA: sa, seriesScoreB: sb, mapPool: [], vetoSequenceId: null, title: null, ...opts };
}
function map(m: Match, ra: number, rb: number): MapInstance {
  return { id: `${m.id}-1`, matchId: m.id, order: 1, mapName: "de_inferno", pickedByTeamId: null, isDecider: true, startingCtTeamId: null, status: "completed", scoreA: ra, scoreB: rb, winnerTeamId: ra > rb ? m.teamAId : m.teamBId, mapRevision: null };
}
const stage = (o: Partial<EventStage> = {}): EventStage => EventStageSchema.parse({ id: "g1", eventId: "ev", name: "Group A", kind: "round_robin", teamIds: ["A", "B", "C", "D"], advancing: 2, ...o });

describe("stage standings", () => {
  it("counts only completed matches with a winner and orders by points then tiebreakers", () => {
    const ms = [match("A", "B", 1, 0), match("C", "D", 1, 0), match("A", "C", 0, 1), match("B", "D", 1, 0), match("A", "D", 1, 0), match("B", "C", 1, 0), match("A", "B", 0, 0, { status: "live" })];
    const maps = [map(ms[0]!, 13, 5), map(ms[1]!, 13, 11), map(ms[2]!, 9, 13), map(ms[3]!, 13, 7), map(ms[4]!, 16, 14), map(ms[5]!, 13, 10)];
    const s = computeStandings(stage(), ms, maps);
    // A, B, C all 2-1 (6 pts). Head-to-head among them is a cycle → map diff equal → round diff
    // decides: A +6, C +3, B +1.
    expect(s.rows.map((r) => [r.teamId, r.position, r.points])).toEqual([
      ["A", 1, 6],
      ["C", 2, 6],
      ["B", 3, 6],
      ["D", 4, 0],
    ]);
    expect(s.rows[0]!.roundDifference).toBe(13 - 5 + (9 - 13) + (16 - 14));
    expect(s.rows.filter((r) => r.advancing).map((r) => r.teamId)).toEqual(["A", "C"]);
    expect(s.rows.every((r) => !r.tied)).toBe(true);
    expect(s.pendingMatches).toBe(1);
  });

  it("head-to-head separates two teams level on points", () => {
    // A and B both 1-1; B beat A.
    const ms = [match("A", "B", 0, 1), match("A", "C", 1, 0), match("B", "D", 0, 1), match("C", "D", 0, 1)];
    const s = computeStandings(stage({ tiebreakers: ["head_to_head"] }), ms, []);
    const pos = Object.fromEntries(s.rows.map((r) => [r.teamId, r.position]));
    expect(pos.B).toBeLessThan(pos.A!);
  });

  it("shares a position instead of inventing an order when tiebreakers cannot separate teams", () => {
    const ms = [match("A", "C", 1, 0), match("B", "D", 1, 0)];
    const s = computeStandings(stage({ tiebreakers: ["map_difference"], advancing: 1 }), ms, []);
    const top = s.rows.filter((r) => r.position === 1);
    expect(top.map((r) => r.teamId)).toEqual(["A", "B"]);
    expect(top.every((r) => r.tied && r.cutUnresolved && !r.advancing)).toBe(true);
  });

  it("reports a completed draw in a no-tie format as excluded rather than guessing", () => {
    const s = computeStandings(stage(), [match("A", "B", 1, 1)], []);
    expect(s.excluded).toHaveLength(1);
    expect(s.rows.every((r) => r.played === 0)).toBe(true);
  });
});

describe("single-elimination bracket", () => {
  const nodes = [
    { id: "sf1", round: 1, slot: 1, label: "SF1", matchId: "s1", teamAFrom: null, teamBFrom: null },
    { id: "sf2", round: 1, slot: 2, label: "SF2", matchId: "s2", teamAFrom: null, teamBFrom: null },
    { id: "f", round: 2, slot: 1, label: "Final", matchId: null, teamAFrom: { nodeId: "sf1", outcome: "winner" as const }, teamBFrom: { nodeId: "sf2", outcome: "winner" as const } },
  ];

  it("advances decided winners and shows placeholders for undecided slots", () => {
    const s1 = match("A", "B", 2, 1, { id: "s1", stageId: "po" });
    const s2 = match("C", "D", 0, 0, { id: "s2", stageId: "po", status: "live" });
    const v = buildBracket(stage({ id: "po", kind: "single_elimination", bracket: nodes }), [s1, s2]);
    const final = v.find((x) => x.id === "f")!;
    expect(final.a.teamId).toBe("A");
    expect(final.b.teamId).toBeNull();
    expect(final.b.placeholder).toBe("Winner of SF2");
    expect(final.status).toBe("not_scheduled");
    expect(v.find((x) => x.id === "sf1")!.a.winner).toBe(true);
  });

  it("flags a scheduled final whose teams contradict the bracket", () => {
    const s1 = match("A", "B", 2, 0, { id: "s1", stageId: "po" });
    const s2 = match("C", "D", 2, 0, { id: "s2", stageId: "po" });
    const fm = match("B", "C", 0, 0, { id: "fm", stageId: "po", status: "scheduled" });
    const v = buildBracket(stage({ id: "po", kind: "single_elimination", bracket: nodes.map((x) => (x.id === "f" ? { ...x, matchId: "fm" } : x)) }), [s1, s2, fm]);
    expect(v.find((x) => x.id === "f")!.conflict).toMatch(/differ/);
  });

  it("validates sources and slots", () => {
    expect(validateBracket(nodes)).toEqual([]);
    expect(validateBracket([...nodes, { ...nodes[2]!, id: "bad", slot: 2, teamAFrom: { nodeId: "f", outcome: "winner" } }])).toContain("bad: source f is not in an earlier round");
  });
});
