import { describe, expect, it } from "vitest";
import type { MatchState } from "@matchframe/contracts";
import { buildSyntheticGsiPayload, MatchStateStore, normalizeGsi, parseGsiPayload, stripAuth } from "@matchframe/cs2-state";
import type { SyntheticPayloadSpec, SyntheticPlayer } from "@matchframe/cs2-state";
import { detectKnifeRound, readLoadouts, weaponKind } from "../src/replay/knife-round.ts";
import { IntroTriggerWatch, LOADOUT_SETTLE_MS, normalMap, secondHalfStart, type IntroTrigger } from "../src/replay/map-intro-trigger.ts";
import { RoundSimulator } from "../src/sim/simulator.ts";

type Weapon = NonNullable<SyntheticPlayer["weapons"]>[number];
const KNIFE_T: Weapon = { name: "weapon_knife_t", type: "Knife", state: "active" };
const KNIFE_CT: Weapon = { name: "weapon_knife", type: "Knife", state: "active" };
const GLOCK: Weapon = { name: "weapon_glock", type: "Pistol", state: "holstered", ammoClip: 20, ammoClipMax: 20, ammoReserve: 120 };
const USP: Weapon = { name: "weapon_usp_silencer", type: "Pistol", state: "holstered", ammoClip: 12, ammoClipMax: 12, ammoReserve: 24 };
const AK: Weapon = { name: "weapon_ak47", type: "Rifle", state: "active", ammoClip: 30, ammoClipMax: 30, ammoReserve: 90 };
const C4: Weapon = { name: "weapon_c4", type: "C4", state: "holstered" };
const ZEUS: Weapon = { name: "weapon_taser", type: "Taser", state: "holstered" };

/** Ten players (5 T, 5 CT) with a loadout per side, and money. */
function team(loadout: { T: Weapon[]; CT: Weapon[] }, money: number, edit?: (p: SyntheticPlayer, i: number) => SyntheticPlayer): SyntheticPlayer[] {
  const t = [1, 2, 3, 4, 5].map((i): SyntheticPlayer => ({ steamId: `7656119800000000${i}`, name: `T${i}`, slot: i, side: "T", money, weapons: loadout.T }));
  const ct = [6, 7, 8, 9, 0].map((i): SyntheticPlayer => ({ steamId: `7656119800000001${i}`, name: `CT${i}`, slot: i, side: "CT", money, weapons: loadout.CT }));
  return [...t, ...ct].map((p, i) => (edit ? edit(p, i) : p));
}
const WARMUP = team({ T: [KNIFE_T, AK, GLOCK], CT: [KNIFE_CT, AK, USP] }, 16000);
const KNIVES = team({ T: [KNIFE_T], CT: [KNIFE_CT] }, 0);
const PISTOLS = team({ T: [KNIFE_T, GLOCK], CT: [KNIFE_CT, USP] }, 800);
const RIFLES = team({ T: [KNIFE_T, AK], CT: [KNIFE_CT, AK] }, 3000);

/**
 * Game data as CS2 sends it (synthetic GSI payloads), through the engine's own reconciler, into the
 * trigger watcher: `at` advances the game data's arrival clock (ms).
 */
class Game {
  private readonly store = new MatchStateStore({ sessionId: "trigger-test" });
  readonly watch = new IntroTriggerWatch();
  private t = 10_000;
  private ts = 1_700_000_000;
  state!: MatchState;

  feed(spec: SyntheticPayloadSpec, at = 500): MatchState {
    this.t += at;
    this.ts += 1;
    const raw = buildSyntheticGsiPayload({ mapName: "de_mirage", timestamp: this.ts, ...spec });
    const parsed = parseGsiPayload(raw);
    if (!parsed.ok) throw new Error(parsed.error);
    this.store.ingest(normalizeGsi(stripAuth(parsed.payload), { sourceId: "gsi:test", receivedAtMonotonicMs: this.t, payloadHash: JSON.stringify(raw) }));
    this.state = this.store.snapshot(this.t);
    this.watch.see(this.state);
    return this.state;
  }

  /** The moments each trigger has open now: kind (and round), or null. */
  moments(regulation = 24): Record<Exclude<IntroTrigger, "manual">, string | null> {
    const of = (tr: IntroTrigger) => {
      const m = this.watch.moment(this.state, tr, regulation);
      return m ? `${m.kind}${m.kind === "pistol2" ? ` r${m.round}` : ""}` : null;
    };
    return { map_load: of("map_load"), knife: of("knife"), pistol: of("pistol"), pistols: of("pistols"), match_live: of("match_live") };
  }

  id(trigger: IntroTrigger, regulation = 24): string | null {
    return this.watch.moment(this.state, trigger, regulation)?.id ?? null;
  }
}

const NONE = { map_load: null, knife: null, pistol: null, pistols: null, match_live: null };
const freeze = (round: number, players: SyntheticPlayer[], extra: Partial<SyntheticPayloadSpec> = {}): SyntheticPayloadSpec => ({ mapPhase: "live", round: round - 1, roundPhase: "freezetime", phase: "freezetime", phaseEndsIn: 15, players, ...extra });
const live = (round: number, players: SyntheticPlayer[], extra: Partial<SyntheticPayloadSpec> = {}): SyntheticPayloadSpec => ({ mapPhase: "live", round: round - 1, roundPhase: "live", phase: "live", phaseEndsIn: 100, players, ...extra });

describe("Knife rounds in CS2 game data", () => {
  it("weapons: every knife skin and fists are knives, the bomb is left aside, guns, grenades and the Zeus are arms", () => {
    expect([KNIFE_T, KNIFE_CT, { name: "weapon_knife_karambit", type: "Knife" }, { name: "weapon_bayonet", type: null }, { name: "weapon_knife_butterfly", type: null }, { name: "weapon_fists", type: "Fists" }].map(weaponKind)).toEqual(["knife", "knife", "knife", "knife", "knife", "knife"]);
    expect(weaponKind(C4)).toBe("bomb");
    expect([GLOCK, AK, ZEUS, { name: "weapon_hegrenade", type: "Grenade" }, { name: "weapon_taser", type: null }].map(weaponKind)).toEqual(["armed", "armed", "armed", "armed", "armed"]);
  });

  it("a MatchZy / get5-style knife round: round 1 at 0–0 after the warmup, knives only (no money): a knife round, in freeze time and live", () => {
    const g = new Game();
    g.feed({ mapPhase: "warmup", roundPhase: "live", phase: "warmup", players: WARMUP });
    expect(detectKnifeRound(g.state)).toMatchObject({ verdict: "not_knife", reason: "warmup" });
    g.feed(freeze(1, KNIVES));
    expect(detectKnifeRound(g.state)).toMatchObject({ verdict: "knife", reason: "knives only (10 players, no money)", loadouts: { read: 10, knifeOnly: 10, armed: 0, noMoney: true } });
    g.feed(live(1, KNIVES));
    expect(detectKnifeRound(g.state).verdict).toBe("knife");
    // Its end: CS2's round number has moved on, the winner has a point.
    g.feed({ ...live(2, KNIVES), roundPhase: "over", phase: "over", scoreT: 1 });
    expect(detectKnifeRound(g.state)).toMatchObject({ verdict: "not_knife", reason: "not the map's first round at 0–0" });
  });

  it("a plain mp_ config that still hands out the bomb, and dead players: still a knife round", () => {
    const g = new Game();
    g.feed(freeze(1, team({ T: [KNIFE_T], CT: [KNIFE_CT] }, 0, (p, i) => (i === 0 ? { ...p, weapons: [KNIFE_T, C4] } : p))));
    expect(detectKnifeRound(g.state).verdict).toBe("knife");
    // Mid-round, two players dead (no weapons in the game data): the living still have knives only.
    g.feed(live(1, team({ T: [KNIFE_T], CT: [KNIFE_CT] }, 0, (p, i) => (i < 2 ? { ...p, health: 0, weapons: [] } : p))));
    expect(detectKnifeRound(g.state)).toMatchObject({ verdict: "knife", loadouts: { read: 8 } });
  });

  it("negatives: the pistol round, one player with a pistol, a Zeus or a grenade, a later round, the round over, rifles", () => {
    const g = new Game();
    g.feed(freeze(1, PISTOLS));
    expect(detectKnifeRound(g.state)).toMatchObject({ verdict: "not_knife", reason: "10 of 10 players have a gun or grenade", loadouts: { noMoney: false } });
    g.feed(freeze(1, team({ T: [KNIFE_T], CT: [KNIFE_CT] }, 0, (p, i) => (i === 7 ? { ...p, weapons: [KNIFE_CT, USP] } : p))));
    expect(detectKnifeRound(g.state)).toMatchObject({ verdict: "not_knife", reason: "1 of 10 players have a gun or grenade" });
    g.feed(freeze(1, team({ T: [KNIFE_T, ZEUS], CT: [KNIFE_CT] }, 0)));
    expect(detectKnifeRound(g.state).verdict).toBe("not_knife");
    g.feed(freeze(1, team({ T: [KNIFE_T], CT: [KNIFE_CT, { name: "weapon_flashbang", type: "Grenade" }] }, 0)));
    expect(detectKnifeRound(g.state).verdict).toBe("not_knife");
    // Knives only, but not round 1 at 0–0 (an eco after a lost round, say): not a knife round.
    g.feed({ ...freeze(5, KNIVES), scoreT: 3, scoreCT: 1 });
    expect(detectKnifeRound(g.state)).toMatchObject({ verdict: "not_knife", reason: "not the map's first round at 0–0" });
    g.feed(live(3, RIFLES, { scoreT: 1, scoreCT: 1 }));
    expect(detectKnifeRound(g.state).verdict).toBe("not_knife");
  });

  it("unknown without the players' weapons: a player's own game data (no allplayers), or one side's only", () => {
    const g = new Game();
    g.feed({ ...freeze(1, KNIVES), omitAllPlayers: true, observed: KNIVES[0]!.steamId });
    expect(detectKnifeRound(g.state)).toMatchObject({ verdict: "unknown", reason: "the players' weapons aren't in the game data" });
    expect(readLoadouts(KNIVES.slice(0, 5).map((p) => ({ ...g.state.players[0]!, steamId: p.steamId, side: "T" })))).toMatchObject({ verdict: "unknown", read: 5 });
    // Coaches (no side, or marked) aren't read.
    expect(readLoadouts(g.state.players.map((p) => ({ ...p, coach: true }))).read).toBe(0);
  });
});

describe("When an intro starts by itself, on simulated game data", () => {
  /**
   * A MatchZy-style map: the observer joins in the warmup, everyone ready, a knife round, the side
   * pick (a pause), the restart, the pistol round, rounds to the half, halftime, the second half's
   * pistol round. Every trigger's moment along the way.
   */
  it("with a knife round: each trigger at its moment, open only in its warmup or freeze time, never in a live round", () => {
    const g = new Game();
    // The map loads (the observer joins in the warmup).
    g.feed({ mapPhase: "warmup", roundPhase: "live", phase: "warmup", players: WARMUP });
    expect(g.moments()).toEqual({ ...NONE, map_load: "map_load" });
    const load = g.id("map_load");
    g.feed({ mapPhase: "warmup", roundPhase: "live", phase: "warmup", players: WARMUP }, 30_000);
    expect(g.id("map_load")).toBe(load);
    // The knife round's freeze time: the match is live at once; knives are read once the freeze time has settled.
    g.feed(freeze(1, KNIVES, { phaseEndsIn: 10 }));
    expect(g.moments()).toEqual({ ...NONE, match_live: "match_live" });
    g.feed(freeze(1, KNIVES, { phaseEndsIn: 9.4 }), 600);
    expect(g.moments()).toEqual({ ...NONE, match_live: "match_live" });
    g.feed(freeze(1, KNIVES, { phaseEndsIn: 8.4 }), LOADOUT_SETTLE_MS - 600 + 400);
    expect(g.moments()).toEqual({ ...NONE, knife: "knife", match_live: "match_live" });
    const knife = g.id("knife");
    // Live: nothing.
    g.feed(live(1, KNIVES));
    expect(g.moments()).toEqual(NONE);
    g.feed({ ...live(2, KNIVES), roundPhase: "over", phase: "over", scoreCT: 1 });
    expect(g.moments()).toEqual(NONE);
    // The side pick (MatchZy pauses), then the restart: round 1 at 0–0 again, pistols and $800.
    g.feed({ ...freeze(2, KNIVES), scoreCT: 1, phase: "paused" });
    expect(g.moments()).toEqual(NONE);
    g.feed(freeze(1, PISTOLS, { phaseEndsIn: 20 }));
    // (Not settled yet: no pistol round before the loadouts are read.)
    expect(g.moments()).toEqual({ ...NONE, match_live: "match_live" });
    expect(g.id("match_live")).not.toBe(null);
    g.feed(freeze(1, PISTOLS, { phaseEndsIn: 18.5 }), LOADOUT_SETTLE_MS + 300);
    expect(g.moments()).toEqual({ ...NONE, pistol: "pistol", pistols: "pistol", match_live: "match_live" });
    expect(g.id("pistol")).not.toBe(knife);
    expect(g.watch.moment(g.state, "pistol", 24)).toMatchObject({ kind: "pistol", slot: "first", map: "de_mirage", knife: "10 of 10 players have a gun or grenade" });
    g.feed(live(1, PISTOLS));
    expect(g.moments()).toEqual(NONE);
    // Mid-half: nothing.
    g.feed(freeze(7, RIFLES, { scoreT: 4, scoreCT: 2 }), 2000);
    g.feed(freeze(7, RIFLES, { scoreT: 4, scoreCT: 2 }), 2000);
    expect(g.moments()).toEqual(NONE);
    // Halftime, then the second half's first round: both pistol rounds only.
    g.feed({ mapPhase: "intermission", round: 12, roundPhase: "over", phase: "over", scoreT: 7, scoreCT: 5, players: RIFLES });
    expect(g.moments()).toEqual(NONE);
    g.feed(freeze(13, PISTOLS, { scoreT: 7, scoreCT: 5 }));
    expect(g.moments()).toEqual({ ...NONE, pistols: "pistol2 r13" });
    expect(g.watch.moment(g.state, "pistols", 24)).toMatchObject({ slot: "pistol2", round: 13 });
    g.feed(live(13, PISTOLS, { scoreT: 7, scoreCT: 5 }));
    expect(g.moments()).toEqual(NONE);
  });

  it("follows the match format: MR15's second half starts at round 16", () => {
    expect([secondHalfStart(24), secondHalfStart(30), secondHalfStart(16)]).toEqual([13, 16, 9]);
    const g = new Game();
    g.feed(freeze(13, PISTOLS, { scoreT: 7, scoreCT: 5 }));
    expect(g.moments(30).pistols).toBeNull();
    g.feed(freeze(16, PISTOLS, { scoreT: 8, scoreCT: 7 }));
    expect(g.moments(30).pistols).toBe("pistol2 r16");
  });

  it("without a knife round (plain mp_ configs): the pistol round is the first round; no knife moment ever", () => {
    const g = new Game();
    g.feed({ mapPhase: "warmup", roundPhase: "live", phase: "warmup", players: WARMUP });
    g.feed(freeze(1, PISTOLS));
    g.feed(freeze(1, PISTOLS, { phaseEndsIn: 13 }), 2000);
    expect(g.moments()).toEqual({ ...NONE, pistol: "pistol", pistols: "pistol", match_live: "match_live" });
  });

  it("the first freeze time's update still carrying the warmup's weapons doesn't make the knife round a pistol round", () => {
    const g = new Game();
    g.feed({ mapPhase: "warmup", roundPhase: "live", phase: "warmup", players: WARMUP });
    // The first update of the knife round: the phase has changed, the loadouts not yet.
    g.feed(freeze(1, WARMUP));
    expect(g.moments()).toEqual({ ...NONE, match_live: "match_live" });
    // No newer game data: still nothing read (the loadouts are read from an update past the settling time).
    expect(g.moments().pistol).toBeNull();
    g.feed(freeze(1, KNIVES, { phaseEndsIn: 13 }), LOADOUT_SETTLE_MS + 100);
    expect(g.moments()).toEqual({ ...NONE, knife: "knife", match_live: "match_live" });
  });

  it("a player's own game data (no loadouts): round 1 is taken as the pistol round, never as a knife round", () => {
    const g = new Game();
    g.feed({ ...freeze(1, KNIVES), omitAllPlayers: true, observed: KNIVES[0]!.steamId });
    g.feed({ ...freeze(1, KNIVES, { phaseEndsIn: 12 }), omitAllPlayers: true, observed: KNIVES[0]!.steamId }, 2000);
    // (The map's first state is its first freeze time: that is its load too.)
    expect(g.moments()).toEqual({ map_load: "map_load", knife: null, pistol: "pistol", pistols: "pistol", match_live: "match_live" });
  });

  it("a server without a warmup: the map loads into its first round's freeze time; joining a map mid-way is no map load", () => {
    const g = new Game();
    g.feed(freeze(1, PISTOLS, { mapName: "de_inferno" }));
    expect(g.moments().map_load).toBe("map_load");
    g.feed(live(1, PISTOLS, { mapName: "de_inferno" }));
    expect(g.moments().map_load).toBeNull();
    // Joined at round 5 of another map: nothing at all there.
    g.feed(live(5, RIFLES, { mapName: "de_nuke", scoreT: 2, scoreCT: 2 }));
    expect(g.moments()).toEqual(NONE);
    g.feed(freeze(6, RIFLES, { mapName: "de_nuke", scoreT: 2, scoreCT: 3 }));
    expect(g.moments()).toEqual(NONE);
    // The next map loads: its warmup.
    g.feed({ mapName: "de_ancient", mapPhase: "warmup", roundPhase: "live", phase: "warmup", players: WARMUP });
    expect(g.watch.moment(g.state, "map_load", 24)).toMatchObject({ kind: "map_load", map: "de_ancient", slot: "first" });
  });

  it("the built-in simulation (live rounds with rifles and pistols, no warmup): its first round's freeze time is the map load, the pistol round and the match going live; never a knife round, nothing live or later", () => {
    let now = 0;
    const sim = new RoundSimulator({ activeCameraId: null, observedSteamId: null } as unknown as ConstructorParameters<typeof RoundSimulator>[0], () => now);
    const store = new MatchStateStore({ sessionId: "simulation" });
    const watch = new IntroTriggerWatch();
    const seen = new Set<string>();
    // Two rounds of the simulation (80 s each, 12 s of freeze time), a game-data update every 250 ms.
    for (let t = 0; t <= 165_000; t += 250) {
      now = t;
      const raw = sim.payload("token");
      const parsed = parseGsiPayload(raw);
      if (!parsed.ok) throw new Error(parsed.error);
      store.ingest(normalizeGsi(stripAuth(parsed.payload), { sourceId: "gsi:sim", receivedAtMonotonicMs: t, payloadHash: JSON.stringify(raw) }));
      const s = store.snapshot(t);
      watch.see(s);
      for (const tr of ["map_load", "knife", "pistol", "pistols", "match_live"] as const) {
        const m = watch.moment(s, tr, 24);
        if (m) seen.add(`${tr}: ${m.kind} r${s.roundNumber} ${s.roundPhase}${t < LOADOUT_SETTLE_MS ? " (unsettled)" : ""}`);
      }
    }
    expect([...seen].sort()).toEqual(["map_load: map_load r1 freezetime", "map_load: map_load r1 freezetime (unsettled)", "match_live: match_live r1 freezetime", "match_live: match_live r1 freezetime (unsettled)", "pistol: pistol r1 freezetime", "pistols: pistol r1 freezetime"]);
  });

  it("map names as the game data gives them", () => {
    expect([normalMap("de_mirage"), normalMap("workshop/3070321829/de_cache"), normalMap("DE_Dust2"), normalMap(""), normalMap(null)]).toEqual(["de_mirage", "de_cache", "de_dust2", null, null]);
  });
});
