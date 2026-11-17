import type { HudKillfeedEntry, HudPlayer, HudSeriesMap, HudSide, HudState, HudTeam, HudWeapon } from "@matchframe/hud-sdk";
import { DEMO_SILHOUETTE, demoArt, demoRadar, NO_ART, SAMPLE_SPONSOR_BANNER, SAMPLE_SPONSOR_PLATE } from "./demoArt.ts";

/**
 * Built-in sample states (fictional teams and players) for `?demo=<scene>`: thumbnails,
 * development, and `?demo=cycle`, which plays the scenes in turn so every animation can be seen
 * without a running program: freeze time → live → kills → bomb planted → defuse → round won → a
 * tactical timeout in the next freeze time → that round live with the last round's MVP (`mvp`, the
 * teams on the other sides, as after half time). `nocam` is the live round for a HUD to show the
 * observed player without a player cam.
 */
export const DEMO_SCENES = ["freeze", "live", "kill", "plant", "bomb", "defuse", "over", "timeout", "mvp", "nocam"] as const;
/**
 * Test states for a HUD's edges (`?demo=edge` …, not in the cycle): long names (ten capitals, 16 and
 * 32 characters, twelve W's, a long team name), knives, grenades and pistols in hand next to bought
 * guns, a pistol-only player, a team without a logo, black-silhouette default pictures. `edge` is a
 * live round with the observed player on the right team; `edgebomb` the bomb planted with its timer
 * while the data has paused, the team tag unusable ("?"); `edgeover` the round won with the
 * 32-character name as its MVP; `edgeboard` freeze time with the scoreboard.
 */
export const DEMO_TEST_SCENES = ["edge", "edgebomb", "edgeover", "edgeboard"] as const;
type DemoTestScene = (typeof DEMO_TEST_SCENES)[number];
export type DemoScene = (typeof DEMO_SCENES)[number] | DemoTestScene;

/** Demo extras from the page's query: `?bo=5` (series length), `?art=1` (sample HUD images), `?radar=1` (sample radar), `?logo=1` (sample team emblems). */
export interface DemoOptions {
  bestOf?: number;
  art?: boolean;
  /** A sample radar: the made-up clean one, or Mirage's real radar image (`?radar=mirage`, served by the screenshot scripts). */
  radar?: boolean | "mirage";
  logo?: boolean;
  /** The made-up SAMPLE CO sponsor in the top bar and scoreboard slots (`?sponsor=1`). */
  sponsor?: boolean;
  /** Icon names of an icon pack served at /icon-pack/ (`?iconpack=ak47,awp,…`; scripts/shots.mjs --icons). */
  iconPack?: string[];
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

function team(key: "left" | "right", side: HudSide, name: string, short: string, score: number, losses: number, players: HudPlayer[], coach: HudTeam["coach"] = null): HudTeam {
  return { key, teamId: null, name, shortName: short, logoUrl: null, color: null, side, score, seriesWins: key === "left" ? 1 : 0, timeoutsRemaining: 3, consecutiveRoundLosses: losses, players, coach };
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
  if ((DEMO_TEST_SCENES as readonly string[]).includes(scene)) return edgeScene(scene as DemoTestScene, opts);
  // `ct` is the left team and `t` the right one; in the `mvp` scene they have swapped sides.
  const swapped = scene === "mvp";
  const L: HudSide = swapped ? "T" : "CT";
  const R: HudSide = swapped ? "CT" : "T";
  const leftAwp = swapped ? w("ak47", "primary", true, 30, 90) : w("awp", "primary", true, 5, 20);
  let ct = [player(1, L, "nova"), player(2, L, "kestrel", { hasBomb: swapped }), player(3, L, "lumen"), player(4, L, "orbit"), player(5, L, "vale", { primary: leftAwp, activeWeapon: leftAwp })];
  const rightRifle = swapped ? w("famas", "primary", true, 25, 90) : w("galilar", "primary", true, 35, 90);
  const t = [player(6, R, "ember", { hasBomb: !swapped }), player(7, R, "riot"), player(8, R, "saber"), player(9, R, "dusk"), player(0, R, "flint", { primary: rightRifle, activeWeapon: rightRifle })];
  let phase: HudState["match"]["phase"] = "live";
  let clock: number | null = 108;
  let bomb: HudState["bomb"] = { state: "carried", site: null, remainingSec: null, clockRunning: false };
  const feed: HudKillfeedEntry[] = [];
  let scoreLeft = 9;
  const roundHistory: HudState["roundHistory"] = Array.from({ length: 16 }, (_, i) => ({ roundNumber: i + 1, winner: i % 3 === 2 ? "right" : i < 9 ? "left" : i % 2 ? "right" : "left", reason: "elimination" }));
  if (scene === "freeze" || scene === "timeout") {
    phase = scene === "timeout" ? "timeout_t" : "freezetime";
    clock = scene === "timeout" ? 23 : 14;
    ct = ct.map((p) => ({ ...p, activeWeapon: p.secondary }));
  }
  // The next round's freeze time, with the team on T in a tactical timeout (one of three used).
  if (scene === "timeout" || scene === "mvp") {
    scoreLeft = 10;
    roundHistory.push({ roundNumber: 17, winner: "left", reason: "ct_win_defuse" });
  }
  // That round under way, a few seconds in: everyone alive, the last round's MVP still up.
  if (scene === "mvp") clock = 103;
  if (scene === "kill" || scene === "plant" || scene === "bomb" || scene === "defuse" || scene === "over") {
    feed.push(kill("k1", ct[0]!, t[2]!, "m4a1_silencer", true), kill("k2", t[1]!, ct[3]!, "ak47", false, { assister: { steamId: t[0]!.steamId, name: "ember", side: "T" } }));
    t[2] = { ...dead(t[2]!), roundDamage: 42 };
    ct[3] = { ...dead(ct[3]!), roundDamage: 27 };
    ct[0] = { ...ct[0]!, roundKills: 1, health: 76, roundDamage: 100 };
    ct[2] = { ...ct[2]!, health: 31, armor: 64, roundDamage: 18 };
    t[1] = { ...t[1]!, roundKills: 1, health: 58, roundDamage: 124 };
    clock = 81;
  }
  // The bomb carrier planting (the countdown to the bomb being down).
  if (scene === "plant") bomb = { state: "planting", site: "A", remainingSec: null, clockRunning: false };
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
  const observed = scene === "bomb" ? ct[4]! : scene === "mvp" ? ct[2]! : scene === "nocam" ? t[0]! : ct[0]!;
  ct = ct.map((p) => ({ ...p, observed: p.steamId === observed.steamId }));
  t.forEach((p, i) => (t[i] = { ...p, observed: p.steamId === observed.steamId }));
  // A player who has dropped out of the game data (disconnected): life unknown.
  if (scene === "nocam") t[3] = { ...t[3]!, alive: null, health: null };
  const series = demoSeries([1, 3, 5, 7].includes(opts.bestOf ?? 3) ? (opts.bestOf ?? 3) : 3, [scoreLeft, 7]);
  if (opts.bestOf && ![1, 3, 5, 7].includes(opts.bestOf)) series.bestOf = opts.bestOf;
  const art = { ...(opts.art ? demoArt() : NO_ART), iconPack: opts.iconPack?.length ? { names: opts.iconPack, base: "/icon-pack/" } : null };
  const left = { ...team("left", L, "Northern Lights", "NRL", scoreLeft, 0, ct), seriesWins: series.left, logoUrl: opts.logo ? demoLogo("left") : null };
  const right = { ...team("right", R, "Red Harbour", "RHB", 7, scene === "timeout" || scene === "mvp" ? 3 : 2, t), seriesWins: series.right, logoUrl: opts.logo ? demoLogo("right") : null, timeoutsRemaining: scene === "timeout" || scene === "mvp" ? 2 : 3 };
  const live = !(scene === "freeze" || scene === "over" || scene === "timeout");
  // Round 17's key player, kept from its end: nova's two kills and the defuse round's damage.
  const nova = ct[0]!;
  const lastRound: HudState["lastRound"] = roundHistory.some((r) => r.roundNumber === 17) ? { roundNumber: 17, winnerSide: L, mvp: { steamId: nova.steamId, kills: 2, damage: 200, health: 76, armor: 100, helmet: true } } : null;
  return {
    schemaVersion: 1,
    outputId: "demo",
    variant: "live",
    presetId: null,
    simulated: false,
    timeline: { profile: "live", delayMs: 0 },
    dataAgeMs: 0,
    stale: false,
    match: { mapName: "de_mirage", mapDisplayName: "Mirage", roundNumber: scene === "timeout" || scene === "mvp" ? 18 : 17, phase, phaseEndsInSec: clock, clockRunning: live || scene === "freeze" || scene === "timeout", paused: false, regulationRounds: 24 },
    left,
    right,
    observed: { ...(ct.find((p) => p.observed) ?? t.find((p) => p.observed) ?? observed), observed: true },
    bomb,
    roundHistory,
    killfeed: { mode: "exact", entries: feed },
    radar: opts.radar ? demoRadar([...ct, ...t], bomb, opts.radar === "mirage") : { available: false, reason: "demo", mapName: "de_mirage", mode: "none", calibrationVerified: false, backgroundUrl: null, cleanUrl: null, players: [], bomb: null, utility: [] },
    series,
    event: { name: "MatchFrame Invitational", logoUrl: null, primary: "#5ab8f4", secondary: "#f0c941" },
    sponsors: opts.sponsor ? { top_bar: { sponsorId: "sample", name: "SAMPLE CO", assetUrl: SAMPLE_SPONSOR_PLATE, untilMs: 0 }, scoreboard_slot: { sponsorId: "sample", name: "SAMPLE CO", assetUrl: SAMPLE_SPONSOR_BANNER, untilMs: 0 } } : {},
    cues: [],
    replay: { active: false, label: null, clip: null },
    annotations: [],
    veto: null,
    standings: null,
    bracket: null,
    settings: {},
    art,
    lastRound,
  };
}

/** The test scenes' names, by team order (left: nova, kestrel, lumen, orbit, vale; right: ember, riot, saber, dusk, flint). */
const EDGE_NAMES = {
  left: ["Spudwrecker", "kestrel", "ThisNameIsExactlyThirtyTwoChars!", "orbit", "WWWWWWWWWWWW"],
  right: ["ember", "SixteenCharacter", "saber", "dusk", "flint"],
};

/** A test scene (DEMO_TEST_SCENES): the `kill`, `bomb`, `over` or `freeze` scene with the edges described there. */
function edgeScene(scene: DemoTestScene, opts: DemoOptions): HudState {
  const s = demoScene(scene === "edgebomb" ? "bomb" : scene === "edgeover" ? "over" : scene === "edgeboard" ? "freeze" : "kill", opts);
  const names = new Map<string, string>();
  const rename = (team: HudTeam, list: string[]) =>
    team.players.map((p, i) => {
      names.set(p.steamId, list[i] ?? p.name);
      return { ...p, name: list[i] ?? p.name };
    });
  const left = rename(s.left, EDGE_NAMES.left);
  const right = rename(s.right, EDGE_NAMES.right);
  const hold = (list: HudPlayer[], i: number, over: (p: HudPlayer) => Partial<HudPlayer>) => {
    if (list[i]!.alive) list[i] = { ...list[i]!, ...over(list[i]!) };
  };
  const knife = w("knife", "knife", true);
  hold(left, 1, () => ({ activeWeapon: knife })); // a knife out, the M4 bought
  hold(left, 4, (p) => ({ activeWeapon: p.secondary })); // the pistol out next to the AWP
  hold(right, 0, (p) => ({ primary: null, activeWeapon: p.secondary })); // a pistol, nothing else (and the bomb)
  hold(right, 1, () => ({ activeWeapon: knife })); // the knife out, the AK bought
  hold(right, 4, (p) => ({ activeWeapon: p.grenades[1] ?? null })); // a flashbang out, the Galil bought
  if (scene === "edgebomb") hold(left, 2, (p) => ({ primary: null, activeWeapon: p.secondary }));
  const at = (e: HudKillfeedEntry["killer"]) => (e ? { ...e, name: names.get(e.steamId) ?? e.name } : e);
  const feed = s.killfeed.entries.map((e) => ({ ...e, killer: at(e.killer), victim: { ...e.victim, name: names.get(e.victim.steamId) ?? e.victim.name }, assister: at(e.assister) }));
  let lastRound = s.lastRound;
  if (scene === "edge") {
    // A second kill for Spudwrecker.
    right[3] = { ...dead(right[3]!), roundDamage: 0 };
    left[0] = { ...left[0]!, roundKills: 2 };
    feed.push(kill("k3", left[0], right[3], "m4a1_silencer", false));
  }
  if (scene === "edgeover") {
    // The last kill and the round's MVP are the 32-character name's.
    const last = feed[feed.length - 1]!;
    feed[feed.length - 1] = { ...last, killer: { steamId: left[2]!.steamId, name: left[2]!.name, side: left[2]!.side } };
    left[2] = { ...left[2]!, roundKills: 1 };
    left[0] = { ...left[0]!, roundKills: 1 };
    lastRound = { roundNumber: 17, winnerSide: s.left.side!, mvp: { steamId: left[2]!.steamId, kills: 1, damage: 131, health: 31, armor: 64, helmet: true } };
  }
  const observedId = scene === "edge" ? right[1]!.steamId : scene === "edgebomb" ? left[2]!.steamId : s.observed?.steamId;
  const mark = (p: HudPlayer) => ({ ...p, observed: p.steamId === observedId });
  const players = [...left, ...right].map(mark);
  const observed = players.find((p) => p.observed) ?? null;
  return {
    ...s,
    stale: scene === "edgebomb",
    dataAgeMs: scene === "edgebomb" ? 6500 : 0,
    left: { ...s.left, name: "NORTHERN LIGHTS ESPORTS", shortName: "NLE", logoUrl: demoLogo("left"), players: players.slice(0, left.length) },
    right: { ...s.right, shortName: scene === "edgebomb" ? "?" : "RHB", logoUrl: null, players: players.slice(left.length) },
    observed,
    killfeed: { ...s.killfeed, entries: feed },
    lastRound,
    art: { ...s.art, defaultPlayers: { ct: s.art.defaultPlayers.ct, t: [DEMO_SILHOUETTE] } },
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
