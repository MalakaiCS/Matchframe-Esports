import { describe, expect, it } from "vitest";
import {
  buildSyntheticGsiPayload,
  MatchStateStore,
  normalizeGsi,
  parseGsiPayload,
  parseVec3,
  projectCountdown,
  stripAuth,
  syntheticRoster,
} from "../src/index.ts";
import type { SyntheticPayloadSpec } from "../src/index.ts";

let t = 1000;
function obs(spec: SyntheticPayloadSpec, opts: { at?: number; sourceId?: string } = {}) {
  const raw = buildSyntheticGsiPayload(spec);
  const parsed = parseGsiPayload(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  const at = opts.at ?? (t += 100);
  return normalizeGsi(stripAuth(parsed.payload), {
    sourceId: opts.sourceId ?? "gsi:test",
    receivedAtMonotonicMs: at,
    payloadHash: JSON.stringify(raw),
  });
}

const roster = syntheticRoster();
const withPositions = () =>
  roster.map((p, i) => ({ ...p, position: { x: i * 100, y: 50, z: 10 }, forward: { x: 1, y: 0, z: 0 } }));

describe("vector parsing", () => {
  it("keeps missing or malformed vectors unknown instead of (0,0,0)", () => {
    expect(parseVec3(undefined)).toBeNull();
    expect(parseVec3("")).toBeNull();
    expect(parseVec3("1, 2")).toBeNull();
    expect(parseVec3("1, two, 3")).toBeNull();
    expect(parseVec3("1.5, -2, 3e2")).toEqual({ x: 1.5, y: -2, z: 300 });
  });
});

describe("normalization", () => {
  it("strips the GSI auth token before anything else sees the payload", () => {
    const raw = buildSyntheticGsiPayload({ players: roster, token: "secret-token" });
    const parsed = parseGsiPayload(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const stripped = stripAuth(parsed.payload);
    expect(JSON.stringify(stripped)).not.toContain("secret-token");
  });

  it("distinguishes an absent grenades component from an empty one", () => {
    const absent = obs({ players: roster, grenades: undefined });
    const empty = obs({ players: roster, grenades: [] });
    expect(absent.grenades).toBeNull();
    expect(empty.grenades).toEqual([]);
  });

  it("keeps SteamID64 as an exact string", () => {
    const o = obs({ players: [{ ...roster[0]!, steamId: "76561198123456789" }] });
    expect(o.players?.has("76561198123456789")).toBe(true);
  });
});

describe("MatchStateStore", () => {
  it("rejects duplicate payloads and does not duplicate derived events", () => {
    const store = new MatchStateStore({ sessionId: "s1" });
    const spec: SyntheticPayloadSpec = { players: roster, round: 3 };
    const first = obs(spec, { at: 100 });
    expect(store.ingest(first).accepted).toBe(true);
    const dup = { ...first, receivedAtMonotonicMs: 150 };
    const r = store.ingest(dup);
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe("duplicate");
  });

  it("rejects packets older than the last provider timestamp", () => {
    const store = new MatchStateStore({ sessionId: "s1" });
    store.ingest(obs({ players: roster, timestamp: 2000 }, { at: 100 }));
    const r = store.ingest(obs({ players: roster, timestamp: 1990, round: 1 }, { at: 200 }));
    expect(r.reason).toBe("out_of_order");
  });

  it("starts a new epoch and round attempt on a round restore without duplicating results", () => {
    const store = new MatchStateStore({ sessionId: "s1" });
    store.ingest(obs({ players: roster, round: 4, roundWins: { "1": "t_win_elimination", "2": "ct_win_defuse", "3": "ct_win_time", "4": "t_win_bomb" } }, { at: 100 }));
    const s1 = store.snapshot();
    expect(s1.roundHistory).toHaveLength(4);
    const attemptBefore = s1.roundAttemptId;
    // Technical restore back to round 4 (map.round = 3): rounds ≥ 4 must be replayed.
    const r = store.ingest(obs({ players: roster, round: 3, roundWins: { "1": "t_win_elimination", "2": "ct_win_defuse", "3": "ct_win_time" }, timestamp: 1_700_000_005 }, { at: 300 }));
    expect(r.epochChanged).toBe("round_regression");
    const s2 = store.snapshot();
    expect(s2.epoch).toBe(s1.epoch + 1);
    expect(s2.roundNumber).toBe(4);
    expect(s2.roundAttemptId).not.toBe(attemptBefore);
    expect(s2.roundHistory.map((x) => x.roundNumber)).toEqual([1, 2, 3]);
    // Round 4 is played again and recorded exactly once.
    store.ingest(obs({ players: roster, round: 3, roundWins: { "1": "t_win_elimination", "2": "ct_win_defuse", "3": "ct_win_time", "4": "ct_win_elimination" }, timestamp: 1_700_000_010 }, { at: 400 }));
    const s3 = store.snapshot();
    expect(s3.roundHistory.filter((x) => x.roundNumber === 4)).toHaveLength(1);
    expect(s3.roundHistory.find((x) => x.roundNumber === 4)?.reason).toBe("ct_win_elimination");
  });

  it("treats a halftime side swap as continuous and keeps team identity by roster", () => {
    // Synthetic roster: T players end in 01–05, CT players in 10–19.
    const teamOf = (sid: string) => (sid.startsWith("7656119800000000") ? "team-alpha" : "team-bravo");
    const store = new MatchStateStore({
      sessionId: "s1",
      resolveRoster: (sid) => ({ playerId: `p-${sid}`, teamId: teamOf(sid), displayName: null }),
    });
    store.ingest(obs({ players: roster, round: 11, scoreCT: 7, scoreT: 5 }, { at: 100 }));
    expect(store.snapshot().teams.T.teamId).toBe("team-alpha");
    const swapped = roster.map((p) => ({ ...p, side: p.side === "T" ? ("CT" as const) : ("T" as const) }));
    const r = store.ingest(obs({ players: swapped, round: 12, scoreCT: 5, scoreT: 7, timestamp: 1_700_000_100 }, { at: 200 }));
    expect(r.epochChanged).toBeNull();
    const s = store.snapshot();
    expect(s.teams.CT.teamId).toBe("team-alpha");
    expect(s.teams.T.teamId).toBe("team-bravo");
  });

  it("freezes the match clock while paused", () => {
    const store = new MatchStateStore({ sessionId: "s1" });
    store.ingest(obs({ players: roster, phase: "live", phaseEndsIn: 100 }, { at: 1000 }));
    store.ingest(obs({ players: roster, phase: "live", phaseEndsIn: 99, timestamp: 1_700_000_001 }, { at: 2000 }));
    const live = store.snapshot(2000).time.matchTimeMs!;
    store.ingest(obs({ players: roster, phase: "paused", phaseEndsIn: 99, timestamp: 1_700_000_002 }, { at: 3000 }));
    store.ingest(obs({ players: roster, phase: "paused", phaseEndsIn: 99, timestamp: 1_700_000_012, round: 0, scoreCT: 0 }, { at: 13000 }));
    const paused = store.snapshot(20000);
    expect(paused.paused).toBe(true);
    // Only the live segment(s) before the pause advanced the clock.
    expect(paused.time.matchTimeMs!).toBeLessThanOrEqual(live + 1000);
  });

  it("does not advance countdowns during pause or when data is stale", () => {
    expect(projectCountdown({ countdownSec: 30, observedAtMonotonicMs: 0, nowMonotonicMs: 10_000, running: false }).remainingSec).toBe(30);
    const stale = projectCountdown({ countdownSec: 30, observedAtMonotonicMs: 0, nowMonotonicMs: 10_000, running: true });
    expect(stale.stale).toBe(true);
    expect(stale.remainingSec).toBeCloseTo(28.5, 5);
    expect(projectCountdown({ countdownSec: 30, observedAtMonotonicMs: 0, nowMonotonicMs: 500, running: true }).remainingSec).toBeCloseTo(29.5, 5);
  });

  it("never fabricates killer, weapon or headshot details from counter changes", () => {
    const store = new MatchStateStore({ sessionId: "s1" });
    store.ingest(obs({ players: roster }, { at: 100 }));
    const after = roster.map((p) =>
      p.steamId === roster[0]!.steamId
        ? { ...p, kills: 1, roundKills: 1, roundKillsHs: 1 }
        : p.steamId === roster[5]!.steamId
          ? { ...p, health: 0, deaths: 1 }
          : p,
    );
    const r = store.ingest(obs({ players: after, timestamp: 1_700_000_001 }, { at: 200 }));
    const died = r.events.find((e) => e.kind === "player_died")!;
    expect(died.evidence).toBe("derived");
    expect(died.data.killer).toBeNull();
    expect(died.data.weapon).toBeNull();
    const link = r.events.find((e) => e.kind === "probable_kill_link")!;
    expect(link.evidence).toBe("estimated");
    expect(link.confidence).toBeLessThan(1);
    expect(r.events.some((e) => e.evidence === "measured" && e.kind === "player_died")).toBe(false);
  });

  it("pairs a kill with the killer's weapon in hand, headshot, a single assister and a blind killer, as estimates", () => {
    const store = new MatchStateStore({ sessionId: "s1" });
    store.ingest(obs({ players: roster }, { at: 100 }));
    const [k, mate] = [roster[0]!, roster[1]!];
    const v = roster[5]!;
    const after = roster.map((p) =>
      p.steamId === k.steamId
        ? { ...p, kills: 1, roundKills: 1, roundKillsHs: 1, flashed: 120 }
        : p.steamId === mate.steamId
          ? { ...p, assists: 1 }
          : p.steamId === v.steamId
            ? { ...p, health: 0, deaths: 1 }
            : p,
    );
    const r = store.ingest(obs({ players: after, timestamp: 1_700_000_001 }, { at: 200 }));
    const link = r.events.find((e) => e.kind === "probable_kill_link")!;
    expect(link.evidence).toBe("estimated");
    expect(link.data).toMatchObject({ killer: k.steamId, victim: v.steamId, headshot: "probable", weapon: "weapon_ak47", assister: mate.steamId, attackerBlind: true });
  });

  it("pairs a multi-kill by one player, and leaves several killers or a grenade in hand unknown", () => {
    const store = new MatchStateStore({ sessionId: "s1" });
    store.ingest(obs({ players: roster }, { at: 100 }));
    const k = roster[0]!;
    const [v1, v2] = [roster[5]!, roster[6]!];
    const double = roster.map((p) => (p.steamId === k.steamId ? { ...p, kills: 2, roundKills: 2, weapons: [{ name: "weapon_hegrenade", type: "Grenade", state: "active" as const }] } : p.steamId === v1.steamId || p.steamId === v2.steamId ? { ...p, health: 0, deaths: 1 } : p));
    const r = store.ingest(obs({ players: double, timestamp: 1_700_000_001 }, { at: 200 }));
    const links = r.events.filter((e) => e.kind === "probable_kill_link");
    expect(links.map((l) => l.data.victim).sort()).toEqual([v1.steamId, v2.steamId].sort());
    // The roster's previous packet had a rifle in hand: that is the estimate, not the grenade now held.
    expect(links.every((l) => l.data.weapon === "weapon_ak47" && l.data.headshot === null && l.data.assister === null)).toBe(true);

    const store2 = new MatchStateStore({ sessionId: "s2" });
    const nade = roster.map((p) => (p.steamId === k.steamId ? { ...p, weapons: [{ name: "weapon_molotov", type: "Grenade", state: "active" as const }] } : p));
    store2.ingest(obs({ players: nade }, { at: 100 }));
    const burned = nade.map((p) => (p.steamId === k.steamId ? { ...p, kills: 1, roundKills: 1 } : p.steamId === v1.steamId ? { ...p, health: 0, deaths: 1 } : p));
    const r2 = store2.ingest(obs({ players: burned, timestamp: 1_700_000_001 }, { at: 200 }));
    expect(r2.events.find((e) => e.kind === "probable_kill_link")!.data.weapon).toBeNull();

    const store3 = new MatchStateStore({ sessionId: "s3" });
    store3.ingest(obs({ players: roster }, { at: 100 }));
    const trade = roster.map((p) => (p.steamId === roster[0]!.steamId || p.steamId === roster[5]!.steamId ? { ...p, kills: 1, roundKills: 1 } : p.steamId === roster[1]!.steamId || p.steamId === roster[6]!.steamId ? { ...p, health: 0, deaths: 1 } : p));
    const r3 = store3.ingest(obs({ players: trade, timestamp: 1_700_000_001 }, { at: 200 }));
    expect(r3.events.some((e) => e.kind === "probable_kill_link")).toBe(false);
  });

  it("keeps a player missing from the all-player list as unknown, not dead", () => {
    const store = new MatchStateStore({ sessionId: "s1" });
    store.ingest(obs({ players: roster }, { at: 100 }));
    store.ingest(obs({ players: roster.slice(1), timestamp: 1_700_000_001 }, { at: 200 }));
    const p = store.snapshot().players.find((x) => x.steamId === roster[0]!.steamId)!;
    expect(p.lifeState).toBe("unknown");
  });

  it("does not invent positions or merge stale weapons", () => {
    const store = new MatchStateStore({ sessionId: "s1" });
    const start = roster.map((p) => ({ ...p, position: null, weapons: [...(p.weapons ?? []), { name: "weapon_hegrenade", type: "Grenade" }] }));
    store.ingest(obs({ players: start }, { at: 100 }));
    const p0 = store.snapshot().players[0]!;
    expect(p0.position).toBeNull();
    expect(p0.weapons.some((w) => w.name === "weapon_hegrenade")).toBe(true);
    store.ingest(obs({ players: roster, timestamp: 1_700_000_001 }, { at: 200 }));
    const p1 = store.snapshot().players.find((x) => x.steamId === p0.steamId)!;
    expect(p1.weapons.some((w) => w.name === "weapon_hegrenade")).toBe(false);
  });

  it("reports the spectated player from observer feedback and free camera as roaming", () => {
    const store = new MatchStateStore({ sessionId: "s1" });
    store.ingest(obs({ players: withPositions(), observed: roster[2]!.steamId }, { at: 100 }));
    expect(store.snapshot().observer.observedSteamId).toBe(roster[2]!.steamId);
    store.ingest(obs({ players: withPositions(), observed: null, timestamp: 1_700_000_001 }, { at: 200 }));
    const s = store.snapshot();
    expect(s.observer.observedSteamId).toBeNull();
    expect(s.observer.cameraMode).toBe("roaming");
  });

  it("starts a new epoch on map change and clears utility and players", () => {
    const store = new MatchStateStore({ sessionId: "s1" });
    store.ingest(obs({ players: withPositions(), grenades: [{ id: "10", type: "smoke", owner: roster[0]!.steamId, position: { x: 0, y: 0, z: 100 }, velocity: { x: 100, y: 0, z: 0 }, lifetime: 0.2 }] }, { at: 100 }));
    expect(store.snapshot().utility).toHaveLength(1);
    const r = store.ingest(obs({ players: withPositions(), mapName: "de_mirage", timestamp: 1_700_000_050 }, { at: 200 }));
    expect(r.epochChanged).toBe("map_change");
    const s = store.snapshot();
    expect(s.utility.every((u) => u.cleanupReason !== null || u.epoch === s.epoch)).toBe(true);
    expect(s.mapName).toBe("de_mirage");
  });

  it("marks the source stale after silence", () => {
    const store = new MatchStateStore({ sessionId: "s1", staleAfterMs: 1000 });
    store.ingest(obs({ players: roster }, { at: 100 }));
    expect(store.checkStale(500)).toBe(false);
    expect(store.checkStale(2000)).toBe(true);
    expect(store.snapshot().sources[0]!.stale).toBe(true);
  });

  it("tracks non-primary sources for health without merging them into match truth", () => {
    const store = new MatchStateStore({ sessionId: "s1", primarySourceId: "gsi:a" });
    store.ingest(obs({ players: roster, scoreCT: 3 }, { at: 100, sourceId: "gsi:a" }));
    const r = store.ingest(obs({ players: roster, scoreCT: 9, timestamp: 1_700_000_001 }, { at: 150, sourceId: "gsi:b" }));
    expect(r.reason).toBe("non_primary_source");
    const s = store.snapshot();
    expect(s.teams.CT.score).toBe(3);
    expect(s.sources.map((x) => x.sourceId).sort()).toEqual(["gsi:a", "gsi:b"]);
  });
});
