import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { OwnershipState } from "@matchframe/contracts";
import { MapPack } from "@matchframe/contracts";
import type { SyntheticPayloadSpec, SyntheticPlayer } from "@matchframe/cs2-state";
import { MapRuntime, VisibilityGrid } from "@matchframe/map-runtime";
import type { BuyType, ControlStatus, DirectorConfig, TeamEconomy, WeaponClass } from "../src/index.ts";
import { buyFromEquipment, buyFromResources, BuyTracker, classifyBuys, DEFAULT_DIRECTOR_CONFIG, Director } from "../src/index.ts";
import { capsWithCameraControl, CT, player, Sim, T } from "./helpers.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MR12 = { regulationRounds: 24, overtimeRounds: 6 };
const round = (n: number) => ({ roundNumber: n, ...MR12 });

/** Five players with the same money, equipment and weapon. */
const team = (side: "T" | "CT", money: number, equipment: number, weapon: WeaponClass | null, losses: number | null = 1, lostLast: boolean | null = true): TeamEconomy => ({
  side,
  players: Array.from({ length: 5 }, () => ({ money, equipment, weapon })),
  losses,
  lostLast,
});

describe("buy types", () => {
  it("knows the pistol rounds, and that overtime starts with a full buy, not a pistol round", () => {
    for (const n of [1, 13]) expect(buyFromEquipment(team("T", 100, 850, "pistol"), round(n))).toBe("pistol");
    expect(buyFromResources(team("CT", 800, 200, null), round(1))).toBe("pistol");
    // Overtime: $10,000+ each, rifles bought.
    expect(buyFromEquipment(team("T", 5200, 4800, "rifle"), round(25))).toBe("full");
  });

  it("reads what they bought: a full buy, an eco, a force buy (pistols or SMGs, money spent) and a half buy (money kept)", () => {
    expect(buyFromEquipment(team("T", 600, 4300, "rifle"), round(6))).toBe("full");
    // All rifles even without much utility.
    expect(buyFromEquipment(team("CT", 100, 3500, "rifle"), round(6))).toBe("full");
    // Saving: pistols, a vest or two, money kept.
    expect(buyFromEquipment(team("T", 2300, 480, "pistol"), round(3))).toBe("eco");
    // A light buy (armour, better pistols) keeping enough for a full buy next round is still an eco.
    expect(buyFromEquipment(team("T", 1900, 2050, "pistol", 5), round(5))).toBe("eco");
    // Everything spent on SMGs, or on armour and pistols: a force buy.
    expect(buyFromEquipment(team("CT", 100, 2160, "smg", 2), round(14))).toBe("force");
    expect(buyFromEquipment(team("T", 50, 2450, "pistol", 3), round(11))).toBe("force");
    // SMGs bought with the money for next round's full buy kept: a half buy.
    expect(buyFromEquipment(team("CT", 1500, 1850, "smg", 4), round(10))).toBe("half");
  });

  it("counts the loss bonus: the same buy is a half buy after many losses and a force buy after a win", () => {
    // $1,500 left: with four losses the next loss pays $3,400 (a full buy next round), after a win $1,400.
    expect(buyFromEquipment(team("CT", 1500, 2500, "smg", 4), round(9))).toBe("half");
    expect(buyFromEquipment(team("CT", 1500, 2500, "smg", 0, false), round(9))).toBe("force");
    // The last round of a half: money is reset after it, so nothing counts as kept.
    expect(buyFromEquipment(team("CT", 1500, 2500, "smg", 4), round(12))).toBe("force");
  });

  it("predicts the buy from money and kept equipment before they buy, with the round and the round before", () => {
    expect(buyFromResources(team("T", 4400, 600, null), round(6))).toBe("full");
    expect(buyFromResources(team("T", 1500, 200, null), round(3))).toBe("eco");
    // After a loss, saving when it brings a full buy next round ...
    expect(buyFromResources(team("T", 2260, 200, null, 3), round(3))).toBe("eco");
    // ... forcing when even that wouldn't (the pistol round lost: one loss so far, $1,900 next).
    expect(buyFromResources(team("CT", 2130, 300, null, 1), round(2))).toBe("force");
    // After a win, or on the last round of a half, they spend what they have.
    expect(buyFromResources(team("T", 2800, 200, null, 1, false), round(4))).toBe("force");
    expect(buyFromResources(team("T", 2420, 200, null, 3), round(12))).toBe("force");
  });

  it("calls a real buy against a team on an eco an anti-eco", () => {
    const r = classifyBuys({ T: team("T", 1860, 480, "pistol", 3), CT: team("CT", 2150, 5140, "rifle", 0, false) }, { T: "equipment", CT: "equipment" }, round(3));
    expect(r.T!.type).toBe("eco");
    expect(r.CT).toMatchObject({ type: "anti_eco", label: "ANTI-ECO", rifles: 5, equipment: 5140, lossBonus: 1400 });
    const full = classifyBuys({ T: team("T", 600, 4300, "rifle"), CT: team("CT", 1200, 5600, "rifle") }, { T: "equipment", CT: "equipment" }, round(8));
    expect([full.T!.label, full.CT!.label]).toEqual(["FULL BUY", "FULL BUY"]);
  });
});

describe("buy types on seven pro matches", () => {
  interface Fx {
    matches: { map: string; rounds: ({ round: number } & Partial<Record<"T" | "CT", { losses: number; lostLast: boolean | null; players: [number, number, number, number, "r" | "s" | "p"][] }>>)[] }[];
  }
  const fx = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "buy-rounds.json"), "utf8")) as Fx;
  const W = { r: "rifle", s: "smg", p: "pistol" } as const;
  const econ = (side: "T" | "CT", t: NonNullable<Fx["matches"][number]["rounds"][number]["T"]>, at: "start" | "bought"): TeamEconomy => ({
    side,
    losses: t.losses,
    lostLast: t.lostLast,
    players: t.players.map((p) => (at === "start" ? { money: p[0], equipment: p[1], weapon: null } : { money: p[2], equipment: p[3], weapon: W[p[4]] })),
  });
  const classify = (map: string, n: number, at: "start" | "bought" = "bought") => {
    const r = fx.matches.find((m) => m.map === map)!.rounds.find((x) => x.round === n)!;
    const b = at === "start" ? "resources" : "equipment";
    const out = classifyBuys({ T: econ("T", r.T!, at), CT: econ("CT", r.CT!, at) }, { T: b, CT: b }, round(n));
    return { T: out.T!.type, CT: out.CT!.type };
  };

  it("has 136 rounds of the seven matches", () => {
    expect(fx.matches.map((m) => m.map).sort()).toEqual(["de_ancient", "de_anubis", "de_cache", "de_dust2", "de_inferno", "de_mirage", "de_nuke"]);
    expect(fx.matches.reduce((s, m) => s + m.rounds.length, 0)).toBe(136);
  });

  it("reads the rounds an analyst would call", () => {
    // Every first round of a half.
    for (const m of fx.matches) for (const r of m.rounds.filter((x) => x.round === 1 || x.round === 13)) expect(classify(m.map, r.round), `${m.map} ${r.round}`).toEqual({ T: "pistol", CT: "pistol" });
    // Dust II: the pistol round lost, the Ts force two Galils and pistols; the CTs have rifles.
    expect(classify("de_dust2", 2)).toEqual({ T: "force", CT: "full" });
    // Dust II round 3: the Ts save ($480 of equipment, $1,860 kept) against the CTs' rifles.
    expect(classify("de_dust2", 3)).toEqual({ T: "eco", CT: "anti_eco" });
    // Dust II round 10: the CTs buy a few SMGs and keep $1,490 with the loss bonus at $3,400.
    expect(classify("de_dust2", 10).CT).toBe("half");
    // Dust II round 12, the last of the half: the Ts spend everything on armour and pistols.
    expect(classify("de_dust2", 12).T).toBe("force");
    // Anubis round 14: the CTs, a loss behind, spend it all on SMGs.
    expect(classify("de_anubis", 14).CT).toBe("force");
    // Ancient round 5: the Ts at the maximum loss bonus save with pistols and armour.
    expect(classify("de_ancient", 5).T).toBe("eco");
    // Mirage round 4: the CTs save, the Ts buy rifles against them.
    expect(classify("de_mirage", 4)).toEqual({ T: "anti_eco", CT: "eco" });
    // Nuke round 19: five rifles with little else at the maximum loss bonus is a full buy.
    expect(classify("de_nuke", 19).CT).toBe("full");
  });

  it("gives a pro match's mix of buys, and predicts most of them from the money at the start of freeze time", () => {
    const count: Partial<Record<BuyType, number>> = {};
    let agree = 0;
    let n = 0;
    for (const m of fx.matches) {
      for (const r of m.rounds) {
        const bought = classify(m.map, r.round);
        const start = classify(m.map, r.round, "start");
        for (const s of ["T", "CT"] as const) {
          count[bought[s]] = (count[bought[s]] ?? 0) + 1;
          n++;
          if (bought[s] === start[s]) agree++;
        }
      }
    }
    // 272 team-rounds: full buys most, then pistols, ecos, anti-ecos and force buys; half buys are rare among pros.
    expect(count.full! / n).toBeGreaterThan(0.5);
    for (const t of ["pistol", "eco", "force", "anti_eco"] as const) expect(count[t]!, t).toBeGreaterThanOrEqual(20);
    expect(count.half ?? 0).toBeLessThanOrEqual(8);
    // The prediction before anyone buys is right 83 % of the time; the buy itself settles the rest.
    expect(agree / n).toBeGreaterThan(0.8);
  });
});

describe("the buy through a round", () => {
  const armed: OwnershipState = { owner: "director", generation: 2, holder: "director", acquiredAtMonotonicMs: 0, leaseExpiresAtMonotonicMs: null, manualSticky: false, emergencyStopped: false };
  void armed;
  const pistols = [{ name: "weapon_glock", type: "Pistol", state: "active" as const }];
  const smgs = [{ name: "weapon_glock", type: "Pistol", state: "holstered" as const }, { name: "weapon_mac10", type: "Submachine Gun", state: "active" as const }];
  const rifles = [{ name: "weapon_m4a1", type: "Rifle", state: "active" as const }];
  const players = (t: { money: number; equip: number; weapons: SyntheticPlayer["weapons"] }) =>
    [1, 2, 3, 4, 5].map((n) => player(T(n), "T", n, { x: n * 50, y: 0, z: 0 }, null, { money: t.money, equipValue: t.equip, weapons: t.weapons })).concat([6, 7, 8, 9, 0].map((n) => player(CT(n), "CT", n, { x: n * 50, y: 2000, z: 0 }, null, { money: 3000, equipValue: 5200, weapons: rifles })));

  it("predicts, reads the buy once made, and is final a second into the live round", () => {
    const sim = new Sim();
    const tracker = new BuyTracker();
    const spec: Partial<SyntheticPayloadSpec> = { round: 6, lossesT: 3 };
    // Freeze time starts: $2,400 each and a pistol; three losses ($2,900 next): saving brings a full buy.
    let s = tracker.update(sim.push(players({ money: 2400, equip: 200, weapons: pistols }), { roundPhase: "freezetime", phase: "freezetime", phaseEndsIn: 18, spec }), sim.now, MR12)!;
    expect(s.T).toMatchObject({ type: "eco", basis: "resources" });
    expect(s.CT!.type).toBe("anti_eco");
    expect(s.firm).toBe(false);
    // They buy MAC-10s and armour instead and spend it all: a force buy.
    for (let i = 0; i < 20; i++) s = tracker.update(sim.push(players({ money: 100, equip: 2500, weapons: smgs }), { roundPhase: "freezetime", phase: "freezetime", phaseEndsIn: 16 - i * 0.1, spec }), sim.now, MR12)!;
    expect(s.T).toMatchObject({ type: "force", basis: "equipment", label: "FORCE BUY", smgs: 5 });
    expect(s.CT!.type).toBe("full");
    // Live: final after a second, whatever they pick up afterwards.
    for (let i = 0; i < 12; i++) s = tracker.update(sim.push(players({ money: 100, equip: 2500, weapons: smgs }), { roundPhase: "live", phase: "live", phaseEndsIn: 115, spec }), sim.now, MR12)!;
    expect(s.firm).toBe(true);
    const later = tracker.update(sim.push(players({ money: 100, equip: 4800, weapons: rifles }), { roundPhase: "live", phase: "live", phaseEndsIn: 100, spec }), sim.now, MR12)!;
    expect(later.T!.type).toBe("force");
  });

  it("reads a team that never spends as saving after the first seconds of freeze time", () => {
    const sim = new Sim();
    const tracker = new BuyTracker();
    // $4,000 and a pistol: rifles look affordable at first; they keep the money.
    let s = tracker.update(sim.push(players({ money: 4000, equip: 200, weapons: pistols }), { roundPhase: "freezetime", phase: "freezetime", phaseEndsIn: 20, spec: { round: 8, lossesT: 4 } }), sim.now, MR12)!;
    expect(s.T!.type).toBe("full");
    for (let i = 0; i < 65; i++) s = tracker.update(sim.push(players({ money: 4000, equip: 200, weapons: pistols }), { roundPhase: "freezetime", phase: "freezetime", phaseEndsIn: 20 - i * 0.1, spec: { round: 8, lossesT: 4 } }), sim.now, MR12)!;
    expect(s.T).toMatchObject({ type: "eco", basis: "equipment" });
  });
});

describe("freeze-time shots that tell the buy story (Mirage with its grid)", () => {
  const control: ControlStatus = { ownership: { owner: "director", generation: 2, holder: "director", acquiredAtMonotonicMs: 0, leaseExpiresAtMonotonicMs: null, manualSticky: false, emergencyStopped: false }, adapterAvailable: true, inputFresh: true, pendingCommand: false };
  const T_SPAWN = { x: 1230, y: -300, z: -167 };
  const CT_SPAWN = { x: -1650, y: -1950, z: -295 };
  const around = (c: { x: number; y: number; z: number }, i: number) => ({ x: c.x + (i % 3) * 50, y: c.y + Math.floor(i / 3) * 50, z: c.z });
  type Kit = { money: number; equip: number; weapons: SyntheticPlayer["weapons"] };
  const SMG: Kit = { money: 100, equip: 2300, weapons: [{ name: "weapon_mac10", type: "Submachine Gun", state: "active" }] };
  const RIFLES: Kit = { money: 3000, equip: 5200, weapons: [{ name: "weapon_m4a1", type: "Rifle", state: "active" }] };
  const AK: Kit = { money: 3000, equip: 5000, weapons: [{ name: "weapon_ak47", type: "Rifle", state: "active" }] };
  const SAVE: Kit = { money: 1500, equip: 200, weapons: [{ name: "weapon_usp_silencer", type: "Pistol", state: "active" }] };

  function play(t: Kit, ct: Kit, spec: Partial<SyntheticPayloadSpec>, config: Partial<DirectorConfig["cinematic"]> = {}) {
    const rt = new MapRuntime(MapPack.parse(JSON.parse(readFileSync(join(root, "assets", "map-packs", "de_mirage.json"), "utf8"))));
    rt.grid = VisibilityGrid.parse(readFileSync(join(root, "assets", "map-packs", "de_mirage.grid")), (b) => inflateSync(b));
    const sim = new Sim("de_mirage", rt);
    const director = new Director({ config: { cinematic: { ...DEFAULT_DIRECTOR_CONFIG.cinematic, ...config } }, newId: (() => { let i = 0; return () => `d${i++}`; })() });
    director.setMode("automatic");
    director.setObserverMode("observer_cinematics");
    director.setMap(rt);
    director.setCapabilities(capsWithCameraControl("supported"));
    const players = [1, 2, 3, 4, 5]
      .map((n, i) => player(T(n), "T", n, around(T_SPAWN, i), { x: -1, y: 0, z: 0 }, { money: t.money, equipValue: t.equip, weapons: t.weapons }))
      .concat([6, 7, 8, 9, 0].map((n, i) => player(CT(n), "CT", n, around(CT_SPAWN, i), { x: 1, y: 0, z: 0 }, { money: ct.money, equipValue: ct.equip, weapons: ct.weapons })));
    let observed: string | null = T(1);
    const shots: { at: number; id: string; durationMs: number | null; reasons: string[]; range: number | null; kind: string }[] = [];
    let buys = null as ReturnType<Director["evaluate"]>["buys"];
    for (let ms = 0; ms < 18000; ms += 100) {
      const state = sim.push(players, { mapName: "de_mirage", observed, roundPhase: "freezetime", phase: "freezetime", phaseEndsIn: (18000 - ms) / 1000, spec });
      const out = director.evaluate(state, sim.now, control);
      buys = out.buys;
      const i = out.intent;
      if (i?.kind === "select_player") {
        observed = i.targetSteamId;
        shots.push({ at: ms, id: i.targetSteamId!, durationMs: null, reasons: [], range: null, kind: "pov" });
      } else if (i?.kind === "activate_static_camera") {
        const key = `camera:${i.cameraId}`;
        const m = i.move;
        shots.push({ at: ms, id: i.cameraId!, durationMs: i.plannedDurationMs, reasons: out.candidates.find((c) => c.shotKey === key)?.reasonCodes ?? [], range: m ? Math.hypot(m.from.x - m.focus.x, m.from.y - m.focus.y, m.from.z - m.focus.z) : null, kind: "camera" });
        observed = null;
        director.cinematicStarted(key, sim.now, i.plannedDurationMs ?? 3000, null, false, i.shotClass);
      }
    }
    return { shots, buys };
  }

  it("on a force buy: the other team first, then the forcing team, longer and closer so their SMGs are in view", () => {
    const { shots, buys } = play(SMG, RIFLES, { round: 6, scoreT: 1, scoreCT: 4, lossesT: 2 });
    expect(buys!.T!.type).toBe("force");
    const team = shots.filter((s) => s.id.startsWith("team-"));
    expect(team.map((s) => s.id), JSON.stringify(shots)).toEqual(["team-CT", "team-T"]);
    expect(team.every((s) => s.reasons.includes("FORCE_BUY"))).toBe(true);
    expect(team[1]!.durationMs!).toBeGreaterThan(team[0]!.durationMs!);
    // The forcing team's shot is framed closer than their usual team shot (eye height, no buy story).
    const usual = play(SMG, RIFLES, { round: 6, scoreT: 1, scoreCT: 4, lossesT: 2 }, { buyStories: false, variety: false }).shots.find((s) => s.id === "team-T")!;
    expect(team[1]!.range!).toBeLessThan(usual.range!);
    // Within the freeze time's budget, shot after shot with no player view between.
    const first = shots.findIndex((s) => s.kind === "camera");
    expect(shots.slice(first).every((s) => s.kind === "camera")).toBe(true);
    expect(shots.filter((s) => s.kind === "camera").length).toBeLessThanOrEqual(DEFAULT_DIRECTOR_CONFIG.cinematic.establishingPerRound);
  });

  it("on an eco against a full buy: both teams, the full buy last", () => {
    const { shots, buys } = play(AK, SAVE, { round: 4, scoreT: 3, scoreCT: 1, lossesCT: 3 });
    expect([buys!.T!.type, buys!.CT!.type]).toEqual(["anti_eco", "eco"]);
    const team = shots.filter((s) => s.id.startsWith("team-"));
    expect(team.map((s) => s.id), JSON.stringify(shots)).toEqual(["team-CT", "team-T"]);
    expect(team[0]!.reasons).toContain("ECO_VS_FULL_BUY");
  });

  it("on a pistol round: the map's camera, then both spawns", () => {
    const { shots, buys } = play({ money: 0, equip: 1000, weapons: [] }, { money: 0, equip: 1000, weapons: [] }, { round: 0 });
    expect([buys!.T!.label, buys!.CT!.label]).toEqual(["PISTOL ROUND", "PISTOL ROUND"]);
    const cams = shots.filter((s) => s.kind === "camera");
    expect(cams[0]!.id.startsWith("team-"), JSON.stringify(cams)).toBe(false);
    expect(cams[0]!.reasons).toContain("PISTOL_ROUND");
    expect(cams.map((s) => s.id).filter((id) => id.startsWith("team-")).sort()).toEqual(["team-CT", "team-T"]);
    // Three shots share 18 s.
    for (const s of cams.slice(0, 2)) expect(s.durationMs!).toBeGreaterThanOrEqual(4000);
  });

  it("two full buys: the usual freeze time, with no buy story", () => {
    const { shots } = play(AK, RIFLES, { round: 4, scoreT: 2, scoreCT: 2 });
    const team = shots.filter((s) => s.id.startsWith("team-"));
    expect(team).toHaveLength(2);
    expect(team.some((s) => s.reasons.includes("FORCE_BUY") || s.reasons.includes("ECO_VS_FULL_BUY"))).toBe(false);
  });
});
