import { describe, expect, it } from "vitest";
import { buildSyntheticGsiPayload, detectCoaches, MatchStateStore, nameSaysCoach, normalizeGsi, observerKeys, parseGsiPayload, stripAuth, syntheticRoster } from "../src/index.ts";
import type { SyntheticPayloadSpec, SyntheticPlayer } from "../src/index.ts";

let t = 1000;
function obs(spec: SyntheticPayloadSpec) {
  const raw = buildSyntheticGsiPayload(spec);
  const parsed = parseGsiPayload(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return normalizeGsi(stripAuth(parsed.payload), { sourceId: "gsi:test", receivedAtMonotonicMs: (t += 100), payloadHash: JSON.stringify(raw) });
}

/** CS2's numbering: slots 0–4 the first team, 5–9 the second. */
const cs2Roster = (): SyntheticPlayer[] => syntheticRoster().map((p, i) => ({ ...p, slot: i }));
const P = (steamId: string, observerSlot: number | null, side: "T" | "CT") => ({ steamId, observerSlot, side });

describe("spectator number keys", () => {
  it("numbers CS2's slots from 1 (slot 0 is key 1, slot 9 is key 0)", () => {
    const keys = observerKeys([P("a", 0, "T"), P("b", 1, "T"), P("c", 4, "T"), P("d", 5, "CT"), P("e", 9, "CT")]);
    expect([...keys.values()]).toEqual([1, 2, 5, 6, 0]);
  });

  it("keeps slots that already are keys (1–9, then 0 for the tenth player)", () => {
    const keys = observerKeys([P("a", 1, "T"), P("b", 5, "T"), P("c", 6, "CT"), P("d", 0, "CT")]);
    expect([...keys.values()]).toEqual([1, 5, 6, 0]);
  });

  it("has no key for a player without a slot", () => {
    expect(observerKeys([P("a", null, "T"), P("b", 10, "CT")]).get("a")).toBe(null);
    expect(observerKeys([P("a", null, "T"), P("b", 10, "CT")]).get("b")).toBe(null);
  });

  it("gives each player of a CS2 game their key in the match state", () => {
    const store = new MatchStateStore({ sessionId: "s" });
    store.ingest(obs({ mapName: "de_dust2", players: cs2Roster() }));
    const s = store.snapshot();
    expect(s.players.map((p) => [p.observerSlot, p.observerKey])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((slot) => [slot, (slot + 1) % 10]));
  });
});

describe("coaches", () => {
  it("knows a coach by name", () => {
    for (const n of ["COACH|kassad", "kassad [coach]", "coach kassad", "Coach"]) expect(nameSaysCoach(n)).toBe(true);
    for (const n of ["Coachella", "roach", "kassad"]) expect(nameSaysCoach(n)).toBe(false);
  });

  it("finds the sixth listed with a team: no slot, or dead in freeze time while five teammates are alive", () => {
    const team = [1, 2, 3, 4, 5].map((i) => ({ steamId: `p${i}`, name: `P${i}`, side: "T" as const, observerSlot: i - 1, lifeState: "alive" as const }));
    const known = new Set<string>();
    detectCoaches([...team, { steamId: "c", name: "Bob", side: "T", observerSlot: null, lifeState: "alive" }], "live", known);
    expect([...known]).toEqual(["c"]);
    const known2 = new Set<string>();
    detectCoaches([...team, { steamId: "c", name: "Bob", side: "T", observerSlot: 5, lifeState: "dead" }], "freezetime", known2);
    expect([...known2]).toEqual(["c"]);
    // Five on a team: nobody is a coach unless the name says so.
    const known3 = new Set<string>();
    detectCoaches(team, "freezetime", known3);
    expect(known3.size).toBe(0);
  });

  it("forgets a detected coach who plays (alive in a live round)", () => {
    const known = new Set(["p1"]);
    detectCoaches([{ steamId: "p1", name: "P1", side: "T", observerSlot: 0, lifeState: "alive" }], "live", known);
    expect(known.size).toBe(0);
  });

  it("marks the coach in the match state, without a number key, and numbers the players round them", () => {
    const roster = cs2Roster();
    const coach: SyntheticPlayer = { steamId: "76561198000000099", name: "COACH|Bob", slot: 5, side: "T", health: 0 };
    // The coach takes slot 5; the CTs move up one.
    const players = [...roster.slice(0, 5), coach, ...roster.slice(5).map((p) => ({ ...p, slot: p.slot + 1 }))].filter((p) => p.slot <= 9);
    const store = new MatchStateStore({ sessionId: "s" });
    store.ingest(obs({ mapName: "de_dust2", players, roundPhase: "freezetime" }));
    const s = store.snapshot();
    const c = s.players.find((p) => p.steamId === coach.steamId)!;
    expect(c.coach).toBe(true);
    expect(c.observerKey).toBe(null);
    expect(s.players.filter((p) => !p.coach)).toHaveLength(9);
    expect(s.players.find((p) => p.observerSlot === 0)!.observerKey).toBe(1);
  });

  it("follows the operator's say over the detection", () => {
    const store = new MatchStateStore({ sessionId: "s", coachOverride: (id) => (id === "76561198000000001" ? true : id === "76561198000000099" ? false : null) });
    const coach: SyntheticPlayer = { steamId: "76561198000000099", name: "COACH|Bob", slot: 9, side: "CT", health: 0 };
    store.ingest(obs({ mapName: "de_dust2", players: [...cs2Roster().slice(0, 9), coach] }));
    const s = store.snapshot();
    expect(s.players.find((p) => p.steamId === "76561198000000001")!.coach).toBe(true);
    expect(s.players.find((p) => p.steamId === coach.steamId)!.coach).toBe(false);
  });
});
