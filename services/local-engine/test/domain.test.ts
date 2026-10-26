import { describe, expect, it } from "vitest";
import type { Match } from "@matchframe/contracts";
import { Database } from "../src/db/database.ts";
import { VetoRepo } from "../src/db/store.ts";
import { mapWinner, seriesScore } from "../src/domain/series.ts";
import { SponsorRotation, zoneAllowed } from "../src/domain/sponsors.ts";
import { standardSequence, VetoService } from "../src/domain/veto.ts";
import { ProgramArbiter } from "../src/production/program.ts";

const match: Match = {
  id: "m1",
  eventId: null,
  stageId: null,
  teamAId: "ta",
  teamBId: "tb",
  format: { bestOf: 3, regulationRounds: 24, overtimeEnabled: true, overtimeRounds: 6, allowTie: false },
  status: "veto",
  scheduledAt: null,
  seriesScoreA: 0,
  seriesScoreB: 0,
  mapPool: ["de_inferno", "de_mirage", "de_nuke", "de_ancient", "de_anubis", "de_dust2", "de_train"],
  vetoSequenceId: null,
  title: null,
};

function db() {
  const d = new Database(":memory:");
  d.migrate();
  return d;
}

describe("veto", () => {
  it("builds sequences from the configured pool size, never assuming a fixed count", () => {
    const bo3 = standardSequence(3, 7);
    expect(bo3.filter((s) => s.kind === "ban")).toHaveLength(4);
    expect(bo3.filter((s) => s.kind === "pick")).toHaveLength(2);
    expect(bo3.filter((s) => s.kind === "decider")).toHaveLength(1);
    const bo1six = standardSequence(1, 6);
    expect(bo1six.filter((s) => s.kind === "ban")).toHaveLength(5);
    expect(() => standardSequence(5, 4)).toThrow();
  });

  it("A36: exactly one legal action commits for a step under concurrent submissions", () => {
    const d = db();
    const svc = new VetoService(new VetoRepo(d));
    const steps = standardSequence(3, 7);
    svc.act(match, steps, { stepOrder: 1, teamId: "ta", mapName: "de_train", decidedBy: "captain-a" });
    // Team B's captain double-submits step 2 from two devices.
    const results = [0, 1].map(() => {
      try {
        return svc.act(match, steps, { stepOrder: 2, teamId: "tb", mapName: "de_dust2", decidedBy: "captain-b" });
      } catch (e) {
        return e as Error;
      }
    });
    expect(results.filter((r) => !(r instanceof Error))).toHaveLength(1);
    expect(new VetoRepo(d).active("m1").filter((x) => x.stepOrder === 2)).toHaveLength(1);
  });

  it("rejects out-of-turn, wrong-team and unavailable-map actions; completes with a decider", () => {
    const d = db();
    const svc = new VetoService(new VetoRepo(d));
    const steps = standardSequence(3, 7);
    expect(() => svc.act(match, steps, { stepOrder: 2, teamId: "tb", mapName: "de_nuke", decidedBy: "x" })).toThrow(/step 1/);
    expect(() => svc.act(match, steps, { stepOrder: 1, teamId: "tb", mapName: "de_nuke", decidedBy: "x" })).toThrow(/turn/);
    expect(() => svc.act(match, steps, { stepOrder: 1, teamId: "ta", mapName: "de_cache", decidedBy: "x" })).toThrow(/available/);
    const order = ["de_train", "de_dust2", "de_inferno", "CT", "de_mirage", "T", "de_nuke", "de_ancient"];
    let i = 0;
    for (const step of steps) {
      if (step.kind === "decider") {
        svc.act(match, steps, { stepOrder: step.order, teamId: null, decidedBy: "system" });
        continue;
      }
      const team = step.actor === "A" ? "ta" : "tb";
      if (step.kind === "side_choice") {
        const side = i < order.length && (order[i] === "CT" || order[i] === "T") ? (order[i++] as "CT" | "T") : "CT";
        svc.act(match, steps, { stepOrder: step.order, teamId: team, side, decidedBy: "c" });
      } else svc.act(match, steps, { stepOrder: step.order, teamId: team, mapName: order[i++]!, decidedBy: "c" });
    }
    const st = svc.status(match, steps);
    expect(st.complete).toBe(true);
    expect(st.pickedMaps.map((m) => m.mapName)).toEqual(["de_inferno", "de_mirage", "de_anubis"]);
    expect(st.pickedMaps[2]!.decider).toBe(true);
    expect(st.pickedMaps[0]!.startingSide).toEqual({ team: "B", side: "CT" });
  });
});

describe("series", () => {
  it("never advances the series on a tied or unfinished map", () => {
    expect(mapWinner(match.format, 12, 12, "ta", "tb", true)).toBeNull();
    expect(mapWinner(match.format, 13, 9, "ta", "tb", false)).toBeNull();
    expect(mapWinner(match.format, 13, 9, "ta", "tb", true)).toBe("ta");
    expect(mapWinner(match.format, 16, 14, "ta", "tb", true)).toBe("ta");
    const s = seriesScore(match, [
      { id: "1", matchId: "m1", order: 1, mapName: "de_inferno", pickedByTeamId: "ta", isDecider: false, startingCtTeamId: null, status: "completed", scoreA: 13, scoreB: 7, winnerTeamId: "ta", mapRevision: null },
      { id: "2", matchId: "m1", order: 2, mapName: "de_mirage", pickedByTeamId: "tb", isDecider: false, startingCtTeamId: null, status: "live", scoreA: 5, scoreB: 9, winnerTeamId: null, mapRevision: null },
    ]);
    expect(s).toEqual({ a: 1, b: 0, winnerTeamId: null });
  });
});

describe("sponsors", () => {
  it("never covers a live fight with a full-screen ad and respects safe windows", () => {
    expect(zoneAllowed("break_fullscreen", { programMode: "LIVE", roundPhase: "live", bombPlanted: false, clutch: false }).allowed).toBe(false);
    expect(zoneAllowed("break_fullscreen", { programMode: "BREAK", roundPhase: null, bombPlanted: false, clutch: false }).allowed).toBe(true);
    expect(zoneAllowed("bottom_right", { programMode: "LIVE", roundPhase: "live", bombPlanted: false, clutch: false }).allowed).toBe(false);
    expect(zoneAllowed("bottom_right", { programMode: "LIVE", roundPhase: "freezetime", bombPlanted: false, clutch: false }).allowed).toBe(true);
    expect(zoneAllowed("top_bar", { programMode: "LIVE", roundPhase: "live", bombPlanted: true, clutch: false }).allowed).toBe(false);
  });

  it("rotates sponsors per zone by weight and holds each for its display time", () => {
    const r = new SponsorRotation();
    const sp = [
      { id: "s1", name: "One", assetIds: [], placements: ["top_bar" as const], displaySeconds: 10, weight: 1, active: true },
      { id: "s2", name: "Two", assetIds: [], placements: ["top_bar" as const], displaySeconds: 10, weight: 1, active: true },
    ];
    const a = r.next("top_bar", sp, 0)!;
    expect(r.next("top_bar", sp, 5000)!.sponsorId).toBe(a.sponsorId);
    expect(r.next("top_bar", sp, 11000)!.sponsorId).not.toBe(a.sponsorId);
  });
});

describe("program arbiter", () => {
  it("follows the replay flow with mixer confirmation and returns live", async () => {
    let scene = "";
    const p = new ProgramArbiter({ connected: () => true, setProgram: async (s) => ((scene = s), true) }, { LIVE: "Live", REPLAY: "Replay", STUDIO: "Studio", BREAK: "Break" });
    await p.request("REPLAY_PREPARED", "operator", "op", { replayItemId: "bm1" });
    await expect(p.request("LIVE", "schedule", "sched")).rejects.toThrow(/owned/);
    const t = await p.request("REPLAY_PLAYING", "operator", "op");
    expect(t.confirmed).toBe(true);
    expect(scene).toBe("Replay");
    await p.request("LIVE", "operator", "op");
    expect(scene).toBe("Live");
    expect(p.activeReplay).toBeNull();
  });

  it("refuses illegal transitions and requires the operator to recover from DEGRADED", async () => {
    const p = new ProgramArbiter({ connected: () => true, setProgram: async () => true }, { LIVE: "Live", REPLAY: "Replay", STUDIO: null, BREAK: null });
    await expect(p.request("REPLAY_PLAYING", "operator", "op")).rejects.toThrow(/not allowed/);
    p.markDegraded("OBS disconnected");
    await expect(p.request("LIVE", "automation", "rules")).rejects.toThrow(/operator/);
    await p.request("LIVE", "operator", "op");
    expect(p.mode).toBe("LIVE");
  });
});
