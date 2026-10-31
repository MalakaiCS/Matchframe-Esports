import type { HudKillfeedEntry, HudPlayer, HudSide, HudState, HudTeam, HudWeapon } from "@matchframe/hud-sdk";

/**
 * Built-in sample states (fictional teams and players) for `?demo=<scene>`: thumbnails,
 * development, and `?demo=cycle`, which plays the scenes in turn so every animation can be seen
 * without a running program: freeze time → live → kills → bomb planted → defuse → round won.
 */
export const DEMO_SCENES = ["freeze", "live", "kill", "bomb", "defuse", "over"] as const;
export type DemoScene = (typeof DEMO_SCENES)[number];

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

export function demoScene(scene: DemoScene): HudState {
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
    t[2] = dead(t[2]!);
    ct[3] = dead(ct[3]!);
    ct[0] = { ...ct[0]!, roundKills: 1, health: 76 };
    ct[2] = { ...ct[2]!, health: 31, armor: 64 };
    t[1] = { ...t[1]!, roundKills: 1, health: 58 };
    clock = 81;
  }
  if (scene === "bomb" || scene === "defuse" || scene === "over") {
    feed.push(kill("k3", ct[4]!, t[3]!, "awp", false), kill("k4", t[0]!, ct[1]!, "ak47", true, { attackerBlind: true }));
    t[3] = dead(t[3]!);
    ct[1] = dead(ct[1]!);
    t[0] = { ...t[0]!, hasBomb: false, roundKills: 1 };
    phase = "bomb";
    clock = null;
    bomb = { state: "planted", site: "A", remainingSec: 31, clockRunning: false };
  }
  if (scene === "defuse" || scene === "over") {
    feed.push(kill("k5", ct[0]!, t[0]!, "m4a1_silencer", true));
    t[0] = dead(t[0]!);
    ct[0] = { ...ct[0]!, roundKills: 2 };
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
  const left = team("left", "CT", "Northern Lights", "NRL", scoreLeft, 0, ct);
  const right = team("right", "T", "Red Harbour", "RHB", 7, 2, t);
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
    radar: { available: false, reason: "demo", mapName: "de_mirage", mode: "none", calibrationVerified: false, backgroundUrl: null, players: [], bomb: null, utility: [] },
    series: {
      bestOf: 3,
      left: 1,
      right: 0,
      maps: [
        { mapName: "de_inferno", displayName: "Inferno", status: "completed", scoreLeft: 13, scoreRight: 9, pickedBy: "right", winner: "left" },
        { mapName: "de_mirage", displayName: "Mirage", status: "live", scoreLeft: scoreLeft, scoreRight: 7, pickedBy: "left", winner: null },
        { mapName: "de_nuke", displayName: "Nuke", status: "upcoming", scoreLeft: 0, scoreRight: 0, pickedBy: "decider", winner: null },
      ],
    },
    event: { name: "Matchframe Invitational", logoUrl: null, primary: "#5ab8f4", secondary: "#f0c941" },
    sponsors: {},
    cues: [],
    replay: { active: false, label: null },
    annotations: [],
    veto: null,
    standings: null,
    bracket: null,
    settings: {},
  };
}
