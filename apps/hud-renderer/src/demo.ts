import type { HudReplayClip, HudState, HudTeam } from "@matchframe/hud-sdk";

/**
 * `?demo=replay&play=<3k|kill|ace|clutch|none>&preset=<classic|minimal|arena>`: the replay layer with
 * a sample clip on air (made-up teams and players), for checking its look without a running program.
 */
export function demoReplayState(play: string | null, preset: string | null): HudState {
  const team = (key: "left" | "right", name: string, shortName: string, side: "CT" | "T"): HudTeam => ({ key, teamId: null, name, shortName, logoUrl: null, color: null, side, score: key === "left" ? 9 : 7, seriesWins: 0, timeoutsRemaining: 3, consecutiveRoundLosses: 0, players: [] });
  const left = team("left", "Northern Lights", "NRL", "CT");
  const right = team("right", "Red Harbour", "RHB", "T");
  const of = (t: HudTeam) => ({ key: t.key as "left" | "right", name: t.name, shortName: t.shortName, logoUrl: t.logoUrl, color: t.color });
  const clips: Record<string, HudReplayClip> = {
    "3k": { id: "demo-3k", roundNumber: 14, label: "3K: riot", player: { steamId: "76561198000000007", name: "riot" }, team: of(right), side: "T", weapon: { name: "weapon_ak47", displayName: "AK-47" }, headshot: true, victims: ["nova", "lumen", "vale"], kills: 3, multiKill: "3K", clutchVersus: null },
    kill: { id: "demo-kill", roundNumber: 15, label: "vale ▸ ember", player: { steamId: "76561198000000005", name: "vale" }, team: of(left), side: "CT", weapon: { name: "weapon_awp", displayName: "AWP" }, headshot: false, victims: ["ember"], kills: 1, multiKill: null, clutchVersus: null },
    ace: { id: "demo-ace", roundNumber: 6, label: "5K: nova", player: { steamId: "76561198000000001", name: "nova" }, team: of(left), side: "T", weapon: { name: "weapon_m4a1_silencer", displayName: "M4A1-S" }, headshot: true, victims: ["ember", "riot", "saber", "dusk", "flint"], kills: 5, multiKill: "ACE", clutchVersus: null },
    clutch: { id: "demo-clutch", roundNumber: 16, label: "Clutch 1v3: kestrel", player: { steamId: "76561198000000002", name: "kestrel" }, team: of(left), side: "CT", weapon: null, headshot: false, victims: [], kills: null, multiKill: null, clutchVersus: 3 },
  };
  const clip = play === "none" ? null : (clips[play ?? "3k"] ?? clips["3k"]!);
  return {
    schemaVersion: 1,
    outputId: "demo",
    variant: "replay",
    presetId: preset,
    simulated: false,
    timeline: { profile: "live", delayMs: 0 },
    dataAgeMs: 0,
    stale: false,
    match: { mapName: "de_mirage", mapDisplayName: "Mirage", roundNumber: 17, phase: "over", phaseEndsInSec: 6, clockRunning: false, paused: false, regulationRounds: 24 },
    left,
    right,
    observed: null,
    bomb: null,
    roundHistory: [],
    killfeed: { mode: "exact", entries: [] },
    radar: { available: false, reason: "demo", mapName: "de_mirage", mode: "none", calibrationVerified: false, backgroundUrl: null, cleanUrl: null, players: [], bomb: null, utility: [] },
    series: { bestOf: 3, maps: [], left: 0, right: 0 },
    event: { name: null, logoUrl: null, primary: "#2f7cf6", secondary: "#ffffff" },
    sponsors: {},
    cues: [],
    replay: { active: clip !== null, label: clip ? "REPLAY" : null, clip },
    annotations: [],
    veto: null,
    standings: null,
    bracket: null,
    settings: {},
    art: { defaultPlayers: { ct: [], t: [] }, maps: {}, icons: { dead: null } },
  };
}
