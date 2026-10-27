import type { HudPlayer, HudSide, HudState, HudTeam, HudWeapon } from "@matchframe/hud-sdk";

/** A built-in sample state (fictional teams and players) for `?demo=1`: thumbnails and development. */

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
    adr: null,
    observed: false,
    avatarUrl: null,
    countryCode: null,
    ...over,
  };
}

function team(key: "left" | "right", side: HudSide, name: string, short: string, score: number, players: HudPlayer[]): HudTeam {
  return { key, teamId: null, name, shortName: short, logoUrl: null, color: null, side, score, seriesWins: key === "left" ? 1 : 0, timeoutsRemaining: 3, consecutiveRoundLosses: key === "left" ? 0 : 2, players };
}

export function demoState(): HudState {
  const ct = [
    player(1, "CT", "nova", { observed: true, roundKills: 2, kills: 18 }),
    player(2, "CT", "kestrel", { health: 64 }),
    player(3, "CT", "lumen", { health: 12, armor: 40, helmet: false }),
    player(4, "CT", "orbit", { alive: false, health: 0, armor: 0, helmet: false, defuseKit: false, activeWeapon: null, primary: null, secondary: null, grenades: [] }),
    player(5, "CT", "vale", { primary: w("awp", "primary", true, 5, 20), activeWeapon: w("awp", "primary", true, 5, 20) }),
  ];
  const t = [
    player(6, "T", "ember", { hasBomb: true, health: 87 }),
    player(7, "T", "riot", { roundKills: 1 }),
    player(8, "T", "saber", { alive: false, health: 0, armor: 0, helmet: false, defuseKit: false, activeWeapon: null, primary: null, secondary: null, grenades: [] }),
    player(9, "T", "dusk", { health: 45 }),
    player(0, "T", "flint", { primary: w("galilar", "primary", true, 35, 90), activeWeapon: w("galilar", "primary", true, 35, 90) }),
  ];
  const left = team("left", "CT", "Northern Lights", "NRL", 9, ct);
  const right = team("right", "T", "Red Harbour", "RHB", 7, t);
  return {
    schemaVersion: 1,
    outputId: "demo",
    variant: "live",
    presetId: null,
    simulated: false,
    timeline: { profile: "live", delayMs: 0 },
    dataAgeMs: 0,
    stale: false,
    match: { mapName: "de_mirage", mapDisplayName: "Mirage", roundNumber: 17, phase: "live", phaseEndsInSec: 74, clockRunning: false, paused: false, regulationRounds: 24 },
    left,
    right,
    observed: ct[0]!,
    bomb: { state: "carried", site: null, remainingSec: null, clockRunning: false },
    roundHistory: [],
    killfeed: {
      mode: "exact",
      entries: [
        { id: "k1", kind: "exact", killer: { steamId: ct[0]!.steamId, name: "nova", side: "CT" }, victim: { steamId: t[2]!.steamId, name: "saber", side: "T" }, weapon: "m4a1_silencer", headshot: true, assister: null, attackerBlind: false, atMs: 0 },
        { id: "k2", kind: "probable", killer: { steamId: t[1]!.steamId, name: "riot", side: "T" }, victim: { steamId: ct[3]!.steamId, name: "orbit", side: "CT" }, weapon: "ak47", headshot: false, assister: { steamId: t[0]!.steamId, name: "ember", side: "T" }, attackerBlind: true, atMs: 0 },
      ],
    },
    radar: { available: false, reason: "demo", mapName: "de_mirage", mode: "none", calibrationVerified: false, backgroundUrl: null, players: [], bomb: null, utility: [] },
    series: {
      bestOf: 3,
      left: 1,
      right: 0,
      maps: [
        { mapName: "de_inferno", displayName: "Inferno", status: "completed", scoreLeft: 13, scoreRight: 9, pickedBy: "right", winner: "left" },
        { mapName: "de_mirage", displayName: "Mirage", status: "live", scoreLeft: 9, scoreRight: 7, pickedBy: "left", winner: null },
        { mapName: "de_nuke", displayName: "Nuke", status: "upcoming", scoreLeft: 0, scoreRight: 0, pickedBy: "decider", winner: null },
      ],
    },
    event: { name: null, logoUrl: null, primary: "#5ab8f4", secondary: "#f0c941" },
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
