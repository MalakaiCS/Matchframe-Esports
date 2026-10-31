import type { HudKillfeedEntry, HudPlayer, HudSeriesMap, HudSide, HudState, HudTeam, HudWeapon } from "@matchframe/hud-sdk";
import { demoArt, demoRadar, NO_ART } from "./demoArt.ts";

/**
 * Built-in sample states (fictional teams and players) for `?demo=<scene>`: thumbnails,
 * development, and `?demo=cycle`, which plays the scenes in turn so every animation can be seen
 * without a running program: freeze time → live → kills → bomb planted → defuse → round won.
 */
export const DEMO_SCENES = ["freeze", "live", "kill", "bomb", "defuse", "over"] as const;
export type DemoScene = (typeof DEMO_SCENES)[number];

/** Demo extras from the page's query: `?bo=5` (series length), `?art=1` (sample HUD images), `?radar=1` (sample radar). */
export interface DemoOptions {
  bestOf?: number;
  art?: boolean;
  radar?: boolean;
}

const map = (mapName: string, displayName: string, status: HudSeriesMap["status"], pickedBy: HudSeriesMap["pickedBy"], winner: HudSeriesMap["winner"] = null, score: [number, number] = [0, 0]): HudSeriesMap => ({ mapName, displayName, status, scoreLeft: score[0], scoreRight: score[1], pickedBy, winner });

/** The sample series for a best-of (maps won by each side, and the maps with the live one). */
function demoSeries(bestOf: number, live: [number, number]): HudState["series"] {
  const mirage = map("de_mirage", "Mirage", "live", "left", null, live);
  const nuke = map("de_nuke", "Nuke", "upcoming", "decider");
  if (bestOf === 1) return { bestOf, left: 0, right: 0, maps: [{ ...mirage, pickedBy: "decider" }] };
  const played = [
    map("de_inferno", "Inferno", "completed", "right", "left", [13, 9]),
    map("de_ancient", "Ancient", "completed", "left", "right", [10, 13]),
    map("de_overpass", "Overpass", "completed", "right", "left", [13, 11]),
    map("de_anubis", "Anubis", "completed", "left", "right", [7, 13]),
    map("de_dust2", "Dust II", "completed", "right", "left", [16, 14]),
  ];
  const done = bestOf >= 7 ? 5 : bestOf >= 5 ? 3 : 1;
  const maps = [...played.slice(0, done), mirage, nuke];
  const won = (side: "left" | "right") => maps.filter((m) => m.winner === side).length;
  return { bestOf, left: won("left"), right: won("right"), maps };
}

const w = (name: string, kind: HudWeapon["kind"], active = false, clip: number | null = null, reserve: number | null = null): HudWeapon => ({ name: `weapon_${name}`, displayName: name, kind, active, ammoClip: clip, ammoClipMax: clip, ammoReserve: reserve });

function player(i: number, side: HudSide, name: string, over: Partial<HudPlayer> = {}): HudPlayer {
  const rifle = side === "CT" ? w("m4a1_silencer", "primary", true, 20, 60) : w("ak47", "primary", true, 30, 90);
  return {
    steamId: `7656119800000000${i}`,
    playerId: null,
    name,
    slot: i,
    side,
    alive: true,
    health: 100,
    armor: 100,
    helmet: true,
    defuseKit: side === "CT" && i % 2 === 0,
    money: 1850 + i * 350,
    equipValue: 4700,
    flashed: 0,
    primary: rifle,
    secondary: w(side === "CT" ? "usp_silencer" : "glock", "secondary", false, 12, 24),
    grenades: [w("smokegrenade", "grenade"), w("flashbang", "grenade", false, null, i % 2 ? 2 : 1), w(side === "CT" ? "incgrenade" : "molotov", "grenade")],
    hasBomb: false,
    activeWeapon: rifle,
    roundKills: 0,
    kills: 10 + i,
    deaths: 8 + (i % 3),
    assists: 2 + (i % 4),
    adr: 70 + i * 4,
    roundDamage: 0,
    observed: false,
    avatarUrl: null,
    countryCode: null,
    ...over,
  };
}

const dead = (p: HudPlayer): HudPlayer => ({ ...p, alive: false, health: 0, armor: 0, helmet: false, defuseKit: false, activeWeapon: null, primary: null, secondary: null, grenades: [], hasBomb: false });

function team(key: "left" | "right", side: HudSide, name: string, short: string, score: number, losses: number, players: HudPlayer[]): HudTeam {
  return { key, teamId: null, name, shortName: short, logoUrl: null, color: null, side, score, seriesWins: key === "left" ? 1 : 0, timeoutsRemaining: 3, consecutiveRoundLosses: losses, players };
}

const kill = (id: string, killer: HudPlayer, victim: HudPlayer, weapon: string, headshot: boolean, extra: Partial<HudKillfeedEntry> = {}): HudKillfeedEntry => ({
  id,
  kind: "exact",
  killer: { steamId: killer.steamId, name: killer.name, side: killer.side },
  victim: { steamId: victim.steamId, name: victim.name, side: victim.side },
  weapon,
  headshot,
  assister: null,
  attackerBlind: false,
  atMs: 0,
  ...extra,
});

export function demoScene(scene: DemoScene, opts: DemoOptions = {}): HudState {
  let ct = [player(1, "CT", "nova"), player(2, "CT", "kestrel"), player(3, "CT", "lumen"), player(4, "CT", "orbit"), player(5, "CT", "vale", { primary: w("awp", "primary", true, 5, 20), activeWeapon: w("awp", "primary", true, 5, 20) })];
  const t = [player(6, "T", "ember", { hasBomb: true }), player(7, "T", "riot"), player(8, "T", "saber"), player(9, "T", "dusk"), player(0, "T", "flint", { primary: w("galilar", "primary", true, 35, 90), activeWeapon: w("galilar", "primary", true, 35, 90) })];
  let phase: HudState["match"]["phase"] = "live";
  let clock: number | null = 108;
  let bomb: HudState["bomb"] = { state: "carried", site: null, remainingSec: null, clockRunning: false };
  const feed: HudKillfeedEntry[] = [];
  let scoreLeft = 9;
  const roundHistory: HudState["roundHistory"] = Array.from({ length: 16 }, (_, i) => ({ roundNumber: i + 1, winner: i % 3 === 2 ? "right" : i < 9 ? "left" : i % 2 ? "right" : "left", reason: "elimination" }));
  if (scene === "freeze") {
    phase = "freezetime";
    clock = 14;
    ct = ct.map((p) => ({ ...p, activeWeapon: p.secondary }));
  }
  if (scene === "kill" || scene === "bomb" || scene === "defuse" || scene === "over") {
    feed.push(kill("k1", ct[0]!, t[2]!, "m4a1_silencer", true), kill("k2", t[1]!, ct[3]!, "ak47", false, { assister: { steamId: t[0]!.steamId, name: "ember", side: "T" } }));
    t[2] = { ...dead(t[2]!), roundDamage: 42 };
    ct[3] = { ...dead(ct[3]!), roundDamage: 27 };
    ct[0] = { ...ct[0]!, roundKills: 1, health: 76, roundDamage: 100 };
    ct[2] = { ...ct[2]!, health: 31, armor: 64, roundDamage: 18 };
    t[1] = { ...t[1]!, roundKills: 1, health: 58, roundDamage: 124 };
    clock = 81;
  }
  if (scene === "bomb" || scene === "defuse" || scene === "over") {
    feed.push(kill("k3", ct[4]!, t[3]!, "awp", false), kill("k4", t[0]!, ct[1]!, "ak47", true, { attackerBlind: true }));
    t[3] = { ...dead(t[3]!), roundDamage: 78 };
    ct[1] = { ...dead(ct[1]!), roundDamage: 0 };
    t[0] = { ...t[0]!, hasBomb: false, roundKills: 1, roundDamage: 112 };
    phase = "bomb";
    clock = null;
    bomb = { state: "planted", site: "A", remainingSec: 31, clockRunning: false };
  }
  if (scene === "defuse" || scene === "over") {
    feed.push(kill("k5", ct[0]!, t[0]!, "m4a1_silencer", true));
    t[0] = { ...dead(t[0]!), roundDamage: 112 };
    ct[0] = { ...ct[0]!, roundKills: 2, roundDamage: 200 };
    phase = "defuse";
    bomb = { state: "defusing", site: "A", remainingSec: 19, clockRunning: false };
  }
  if (scene === "over") {
    phase = "over";
    clock = 6;
    bomb = { state: "defused", site: "A", remainingSec: null, clockRunning: false };
    scoreLeft = 10;
    roundHistory.push({ roundNumber: 17, winner: "left", reason: "ct_win_defuse" });
  }
  const observed = scene === "bomb" ? ct[4]! : ct[0]!;
  ct = ct.map((p) => ({ ...p, observed: p.steamId === observed.steamId }));
  const series = demoSeries([1, 3, 5, 7].includes(opts.bestOf ?? 3) ? (opts.bestOf ?? 3) : 3, [scoreLeft, 7]);
  if (opts.bestOf && ![1, 3, 5, 7].includes(opts.bestOf)) series.bestOf = opts.bestOf;
  const left = { ...team("left", "CT", "Northern Lights", "NRL", scoreLeft, 0, ct), seriesWins: series.left };
  const right = { ...team("right", "T", "Red Harbour", "RHB", 7, 2, t), seriesWins: series.right };
  const live = !(scene === "freeze" || scene === "over");
  return {
    schemaVersion: 1,
    outputId: "demo",
    variant: "live",
    presetId: null,
    simulated: false,
    timeline: { profile: "live", delayMs: 0 },
    dataAgeMs: 0,
    stale: false,
    match: { mapName: "de_mirage", mapDisplayName: "Mirage", roundNumber: scene === "over" ? 17 : 17, phase, phaseEndsInSec: clock, clockRunning: live || scene === "freeze", paused: false, regulationRounds: 24 },
    left,
    right,
    observed: { ...observed, observed: true },
    bomb,
    roundHistory,
    killfeed: { mode: "exact", entries: feed },
    radar: opts.radar ? demoRadar([...ct, ...t], bomb) : { available: false, reason: "demo", mapName: "de_mirage", mode: "none", calibrationVerified: false, backgroundUrl: null, cleanUrl: null, players: [], bomb: null, utility: [] },
    series,
    event: { name: "Matchframe Invitational", logoUrl: null, primary: "#5ab8f4", secondary: "#f0c941" },
    sponsors: {},
    cues: [],
    replay: { active: false, label: null, clip: null },
    annotations: [],
    veto: null,
    standings: null,
    bracket: null,
    settings: {},
    art: opts.art ? demoArt() : NO_ART,
  };
}

/** Sample plays for `?demo=replay&play=<play>` (the replay layer). */
export const DEMO_PLAYS = ["3k", "kill", "ace", "clutch", "manual", "none"] as const;
export type DemoPlay = (typeof DEMO_PLAYS)[number];

/** Two made-up emblems for `?logo=1` (plain shapes, not real teams' logos). */
export function demoLogo(key: "left" | "right"): string {
  const svg =
    key === "left"
      ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M32 4l24 10v18c0 14-10 24-24 28C18 56 8 46 8 32V14z" fill="#e8f2ff"/><path d="M18 40l9-16 6 9 5-7 8 14z" fill="#1d6fd8"/></svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="27" fill="#fff2f2"/><path d="M32 12v34M20 30c0 10 5 16 12 16s12-6 12-16M24 20h16" stroke="#c22636" stroke-width="5" fill="none" stroke-linecap="round"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * The replay layer's sample: the round-won scene's teams with a clip on air (`play`), or none
 * ("none": the replays ended). `logo`: the teams have the sample emblems.
 */
export function demoReplay(play: DemoPlay, opts: DemoOptions & { logo?: boolean } = {}): HudState {
  const base = demoScene("over", opts);
  const left = { ...base.left, logoUrl: opts.logo ? demoLogo("left") : null };
  const right = { ...base.right, logoUrl: opts.logo ? demoLogo("right") : null };
  const team = (t: HudTeam) => ({ key: t.key as "left" | "right", name: t.name, shortName: t.shortName, logoUrl: t.logoUrl, color: t.color });
  const weapon = (name: string, displayName: string) => ({ name: `weapon_${name}`, displayName });
  const clips: Record<Exclude<DemoPlay, "none">, HudState["replay"]["clip"]> = {
    "3k": { id: "demo-3k", roundNumber: 14, label: "3K: riot ▸ nova, lumen, vale (AK47)", player: { steamId: steamIdOf(7), name: "riot" }, team: team(right), side: "T", weapon: weapon("ak47", "AK-47"), headshot: true, victims: ["nova", "lumen", "vale"], kills: 3, multiKill: "3K", clutchVersus: null },
    kill: { id: "demo-kill", roundNumber: 15, label: "vale ▸ ember (AWP)", player: { steamId: steamIdOf(5), name: "vale" }, team: team(left), side: "CT", weapon: weapon("awp", "AWP"), headshot: false, victims: ["ember"], kills: 1, multiKill: null, clutchVersus: null },
    ace: { id: "demo-ace", roundNumber: 6, label: "5K: nova ▸ ember, riot, saber, dusk, flint (M4A1_SILENCER)", player: { steamId: steamIdOf(1), name: "nova" }, team: team(left), side: "T", weapon: weapon("m4a1_silencer", "M4A1-S"), headshot: true, victims: ["ember", "riot", "saber", "dusk", "flint"], kills: 5, multiKill: "ACE", clutchVersus: null },
    clutch: { id: "demo-clutch", roundNumber: 16, label: "Clutch 1v3: kestrel", player: { steamId: steamIdOf(2), name: "kestrel" }, team: team(left), side: "CT", weapon: null, headshot: false, victims: [], kills: null, multiKill: null, clutchVersus: 3 },
    manual: { id: "demo-manual", roundNumber: 12, label: "Manual bookmark", player: null, team: null, side: null, weapon: null, headshot: false, victims: [], kills: null, multiKill: null, clutchVersus: null },
  };
  const clip = play === "none" ? null : clips[play];
  return { ...base, variant: "replay", left, right, replay: { active: clip !== null, label: clip ? "REPLAY" : null, clip } };
}

/** The demo players' SteamIDs (as `player(i, …)` makes them). */
const steamIdOf = (i: number) => `7656119800000000${i}`;
