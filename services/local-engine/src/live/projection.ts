import type { EventRecord, MapInstance, Match, MatchState, Player, PlayerState, Side, Team } from "@matchframe/contracts";
import { projectCountdown } from "@matchframe/cs2-state";
import type { HudKillfeedEntry, HudPhase, HudPlayer, HudRadar, HudSeriesMap, HudState, HudTeam } from "@matchframe/hud-sdk";
import type { MapRuntime } from "@matchframe/map-runtime";
import { builtinRadarScale, builtinRadarUv, type BuiltinRadar } from "./builtin-radars.ts";
import type { TeamSideTracker } from "./team-sides.ts";
import { toHudWeapon } from "./weapons.ts";

export interface HudContext {
  outputId: string;
  variant: string;
  presetId: string | null;
  timeline: { profile: "live" | "delayed"; delayMs: number };
  match: Match | null;
  mapInstances: MapInstance[];
  teams: Map<string, Team>;
  playersBySteam: Map<string, Player>;
  event: EventRecord | null;
  assetUrl: (assetId: string | null) => string | null;
  map: MapRuntime | undefined;
  /** The built-in radar image for this map (assets/radars), when there is one. */
  builtinRadar?: BuiltinRadar | undefined;
  killfeed: { mode: "exact" | "degraded"; entries: HudKillfeedEntry[] };
  sponsors: HudState["sponsors"];
  cues: HudState["cues"];
  replay: HudState["replay"];
  annotations: HudState["annotations"];
  veto: HudState["veto"];
  standings: HudState["standings"];
  bracket: HudState["bracket"];
  settings: Record<string, unknown>;
  /** Public radar policy: show confirmed utility effects; never predictions. */
  radarUtility: boolean;
  /** Allow an unverified game-radar calibration on air (operator decision). */
  allowUnverifiedRadar: boolean;
}

const MAP_DISPLAY: Record<string, string> = {
  de_inferno: "Inferno",
  de_mirage: "Mirage",
  de_dust2: "Dust II",
  de_nuke: "Nuke",
  de_ancient: "Ancient",
  de_anubis: "Anubis",
  de_overpass: "Overpass",
  de_train: "Train",
  de_vertigo: "Vertigo",
};

export function mapDisplayName(name: string | null): string | null {
  if (!name) return null;
  return MAP_DISPLAY[name] ?? name.replace(/^(de|cs|ar)_/, "").replace(/^\w/, (c) => c.toUpperCase());
}

function hudPhase(state: MatchState): HudPhase {
  if (state.mapPhase === "warmup") return "warmup";
  if (state.mapPhase === "gameover") return "gameover";
  if (state.gamePhase !== "unknown") return state.gamePhase as HudPhase;
  return state.roundPhase === "unknown" ? "unknown" : state.roundPhase;
}

function toHudPlayer(p: PlayerState, observedSteamId: string | null, ctx: HudContext, bombCarrier: string | null): HudPlayer {
  const reg = ctx.playersBySteam.get(p.steamId);
  const primary = p.weapons.find((w) => toHudWeapon(w).kind === "primary");
  const secondary = p.weapons.find((w) => toHudWeapon(w).kind === "secondary");
  return {
    steamId: p.steamId,
    playerId: p.playerId,
    name: reg?.displayName ?? p.name,
    slot: p.observerSlot,
    side: p.side,
    alive: p.lifeState === "alive" ? true : p.lifeState === "dead" ? false : null,
    health: p.health,
    armor: p.armor,
    helmet: p.helmet,
    defuseKit: p.defuseKit,
    money: p.money,
    equipValue: p.equipValue,
    flashed: p.flashed,
    primary: primary ? toHudWeapon(primary) : null,
    secondary: secondary ? toHudWeapon(secondary) : null,
    grenades: p.weapons.filter((w) => toHudWeapon(w).kind === "grenade").map(toHudWeapon),
    hasBomb: bombCarrier === p.steamId || p.weapons.some((w) => w.name === "weapon_c4"),
    activeWeapon: p.activeWeapon ? toHudWeapon(p.activeWeapon) : null,
    roundKills: p.roundKills,
    kills: p.matchStats.kills,
    deaths: p.matchStats.deaths,
    assists: p.matchStats.assists,
    // ADR needs validated damage totals across rounds; GSI does not provide them reliably.
    adr: null,
    observed: observedSteamId === p.steamId,
    avatarUrl: reg && reg.photoVisible ? ctx.assetUrl(reg.avatarAssetId) : null,
    countryCode: reg?.countryCode ?? null,
  };
}

function hudTeam(state: MatchState, side: Side, key: "left" | "right", ctx: HudContext, observed: string | null, seriesWins: number): HudTeam {
  const ts = state.teams[side];
  const team = ts.teamId ? ctx.teams.get(ts.teamId) : undefined;
  const carrier = state.bomb?.state === "carried" ? state.bomb.carrierSteamId : null;
  return {
    key,
    teamId: ts.teamId,
    name: team?.name ?? ts.name ?? (side === "CT" ? "Counter-Terrorists" : "Terrorists"),
    shortName: team?.shortName ?? (ts.name ? ts.name.slice(0, 4).toUpperCase() : side),
    logoUrl: team ? ctx.assetUrl(team.logoAssetId) : null,
    color: team?.primaryColor ?? null,
    side,
    score: ts.score,
    seriesWins,
    timeoutsRemaining: ts.timeoutsRemaining,
    consecutiveRoundLosses: ts.consecutiveRoundLosses,
    players: state.players.filter((p) => p.side === side).map((p) => toHudPlayer(p, observed, ctx, carrier)),
  };
}

type Uv = { u: number; v: number };

function radar(state: MatchState, ctx: HudContext, observed: string | null): HudRadar {
  const map = ctx.map && ctx.map.mapName === state.mapName ? ctx.map : undefined;
  const builtin = ctx.builtinRadar && ctx.builtinRadar.mapName === state.mapName ? ctx.builtinRadar : undefined;
  const none = (reason: string): HudRadar => ({
    available: false,
    reason,
    mapName: state.mapName,
    mode: "none",
    calibrationVerified: false,
    backgroundUrl: null,
    players: [],
    bomb: null,
    utility: [],
  });
  // 1. An operator-calibrated radar image in the map pack (needs the image it was calibrated for).
  const cal = map?.radarCalibrationFor(null) ?? null;
  const operatorImage = !!map && !!cal && !!cal.imageAssetId && (cal.verified || ctx.allowUnverifiedRadar);
  let mode: HudRadar["mode"];
  let backgroundUrl: string | null;
  let verified: boolean;
  let transform: (p: { x: number; y: number; z: number }) => Uv | null;
  let radiusScale: (z: number) => number | null;
  if (operatorImage) {
    mode = "image";
    backgroundUrl = ctx.assetUrl(cal!.imageAssetId);
    verified = !!cal!.verified;
    transform = (p) => {
      const r = map!.worldToRadar(p, { requireVerified: !ctx.allowUnverifiedRadar });
      return r ? { u: r.u, v: r.v } : null;
    };
    radiusScale = () => 1 / (cal!.scale * cal!.imageSizePx);
  } else if (builtin) {
    // 2. The built-in radar image and its calibration (assets/radars).
    mode = "image";
    backgroundUrl = `/overlay-api/radar-image/${encodeURIComponent(builtin.mapName)}`;
    verified = true;
    transform = (p) => builtinRadarUv(builtin, p);
    radiusScale = (z) => builtinRadarScale(builtin, z);
  } else if (map?.schematicTransform()) {
    // 3. Matchframe's outline generated from map-pack geometry.
    const t = map.schematicTransform()!;
    mode = "schematic";
    backgroundUrl = `/overlay-api/radar/${encodeURIComponent(state.mapName ?? "")}`;
    verified = true;
    transform = (p) => map.worldToSchematic(p);
    radiusScale = () => 1 / t.size;
  } else {
    return none(map ? "map pack has no calibrated radar or sampled geometry" : "no radar for this map");
  }
  const carrier = state.bomb?.state === "carried" ? state.bomb.carrierSteamId : null;
  const players = state.players
    .filter((p) => p.position && p.side)
    .map((p) => {
      const uv = transform(p.position!);
      const yaw = p.forward ? (Math.atan2(p.forward.y, p.forward.x) * 180) / Math.PI : null;
      const levelId = map ? map.levelAt(p.position!) : builtin && builtin.layers.length > 1 ? (builtinRadarUv(builtin, p.position!)?.layerId ?? null) : null;
      return uv
        ? {
            id: p.steamId,
            u: uv.u,
            v: uv.v,
            side: p.side,
            alive: p.lifeState === "alive",
            observed: observed === p.steamId,
            levelId,
            label: p.observerSlot !== null ? String(p.observerSlot) : null,
            yawDeg: yaw,
            flashed: (p.flashed ?? 0) > 0,
            hasBomb: carrier === p.steamId || p.weapons.some((w) => w.name === "weapon_c4"),
          }
        : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  const bombUv = state.bomb?.position ? transform(state.bomb.position) : null;
  const utility = ctx.radarUtility
    ? state.utility
        .filter((u) => u.cleanupReason === null && u.phase === "active" && u.effect?.centroid)
        .map((u) => {
          const c = u.effect!.centroid!;
          const uv = transform(c);
          if (!uv) return null;
          const scale = radiusScale(c.z);
          return {
            id: u.utilityId,
            type: u.type,
            u: uv.u,
            v: uv.v,
            phase: u.phase,
            side: u.throwerSide,
            evidence: u.effect!.extentEvidence,
            radius: u.effect!.radiusUnits && scale ? u.effect!.radiusUnits * scale : null,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
    : [];
  return {
    available: true,
    reason: null,
    mapName: state.mapName,
    mode,
    calibrationVerified: verified,
    backgroundUrl,
    players,
    bomb: bombUv ? { ...bombUv, state: state.bomb!.state } : null,
    utility,
  };
}

function series(ctx: HudContext, leftTeamId: string | null): { bestOf: number | null; maps: HudSeriesMap[]; left: number; right: number } {
  const m = ctx.match;
  if (!m) return { bestOf: null, maps: [], left: 0, right: 0 };
  const leftIsA = leftTeamId === null || leftTeamId === m.teamAId;
  const maps: HudSeriesMap[] = ctx.mapInstances.map((mi) => {
    const a = mi.scoreA;
    const b = mi.scoreB;
    const winner = mi.winnerTeamId === null ? null : mi.winnerTeamId === m.teamAId ? (leftIsA ? "left" : "right") : leftIsA ? "right" : "left";
    const picked = mi.isDecider ? "decider" : mi.pickedByTeamId === null ? null : mi.pickedByTeamId === m.teamAId ? (leftIsA ? "left" : "right") : leftIsA ? "right" : "left";
    return {
      mapName: mi.mapName,
      displayName: mapDisplayName(mi.mapName) ?? mi.mapName,
      status: mi.status,
      scoreLeft: leftIsA ? a : b,
      scoreRight: leftIsA ? b : a,
      pickedBy: picked as HudSeriesMap["pickedBy"],
      winner: winner as HudSeriesMap["winner"],
    };
  });
  return {
    bestOf: m.format.bestOf,
    maps,
    left: leftIsA ? m.seriesScoreA : m.seriesScoreB,
    right: leftIsA ? m.seriesScoreB : m.seriesScoreA,
  };
}

/**
 * Builds the public HUD projection for one output. Only approved presentation data is included:
 * no director candidates, predictions, operator telemetry or lookahead state.
 */
export function buildHudState(state: MatchState | null, ctx: HudContext, sides: TeamSideTracker, nowMonotonicMs: number): HudState {
  const event = {
    name: ctx.event?.name ?? null,
    logoUrl: ctx.event ? ctx.assetUrl(ctx.event.logoAssetId) : null,
    primary: ctx.event?.brandPrimary ?? "#2f7cf6",
    secondary: ctx.event?.brandSecondary ?? "#ffffff",
  };
  const emptyTeam = (key: "left" | "right"): HudTeam => ({
    key,
    teamId: null,
    name: key === "left" ? "Team A" : "Team B",
    shortName: key === "left" ? "A" : "B",
    logoUrl: null,
    color: null,
    side: null,
    score: null,
    seriesWins: 0,
    timeoutsRemaining: null,
    consecutiveRoundLosses: null,
    players: [],
  });
  if (!state || state.sequence === 0) {
    const s = series(ctx, ctx.match?.teamAId ?? null);
    const left = emptyTeam("left");
    const right = emptyTeam("right");
    if (ctx.match) {
      const a = ctx.teams.get(ctx.match.teamAId);
      const b = ctx.teams.get(ctx.match.teamBId);
      if (a) Object.assign(left, { teamId: a.id, name: a.name, shortName: a.shortName, logoUrl: ctx.assetUrl(a.logoAssetId), color: a.primaryColor, seriesWins: s.left });
      if (b) Object.assign(right, { teamId: b.id, name: b.name, shortName: b.shortName, logoUrl: ctx.assetUrl(b.logoAssetId), color: b.primaryColor, seriesWins: s.right });
    }
    return {
      schemaVersion: 1,
      outputId: ctx.outputId,
      variant: ctx.variant,
      presetId: ctx.presetId,
      simulated: false,
      timeline: ctx.timeline,
      dataAgeMs: null,
      stale: true,
      match: { mapName: null, mapDisplayName: null, roundNumber: null, phase: "unknown", phaseEndsInSec: null, clockRunning: false, paused: false, regulationRounds: ctx.match?.format.regulationRounds ?? null },
      left,
      right,
      observed: null,
      bomb: null,
      roundHistory: [],
      killfeed: ctx.killfeed,
      radar: { available: false, reason: "no live data", mapName: null, mode: "none", calibrationVerified: false, backgroundUrl: null, players: [], bomb: null, utility: [] },
      series: s,
      event,
      sponsors: ctx.sponsors,
      cues: ctx.cues,
      replay: ctx.replay,
      annotations: ctx.annotations,
      veto: ctx.veto,
      standings: ctx.standings,
      bracket: ctx.bracket,
      settings: ctx.settings,
    };
  }

  const { left, right } = sides.assign(state);
  const observed = state.observer.observedSteamId;
  const sMeta = series(ctx, state.teams[left].teamId);
  const leftTeam = hudTeam(state, left, "left", ctx, observed, sMeta.left);
  const rightTeam = hudTeam(state, right, "right", ctx, observed, sMeta.right);
  const running = !state.paused && (state.gamePhase === "live" || state.gamePhase === "freezetime" || state.gamePhase === "bomb" || state.gamePhase === "defuse" || state.gamePhase === "warmup" || state.gamePhase === "over");
  const phaseClock = projectCountdown({ countdownSec: state.phaseEndsInSec, observedAtMonotonicMs: state.phaseObservedAtMonotonicMs, nowMonotonicMs, running });
  const planted = state.bomb && (state.bomb.state === "planted" || state.bomb.state === "defusing");
  const bombClock = planted
    ? projectCountdown({
        countdownSec: state.bomb!.countdownSec ?? (state.gamePhase === "bomb" || state.gamePhase === "defuse" ? state.phaseEndsInSec : null),
        observedAtMonotonicMs: state.bomb!.countdownObservedAtMonotonicMs ?? state.phaseObservedAtMonotonicMs,
        nowMonotonicMs,
        running: !state.paused,
      })
    : null;
  const dataAge = state.time.receivedAtMonotonicMs ? nowMonotonicMs - state.time.receivedAtMonotonicMs : null;
  const allPlayers = [...leftTeam.players, ...rightTeam.players];
  return {
    schemaVersion: 1,
    outputId: ctx.outputId,
    variant: ctx.variant,
    presetId: ctx.presetId,
    simulated: state.simulated,
    timeline: ctx.timeline,
    dataAgeMs: dataAge,
    stale: state.sources.find((s) => s.packetsReceived > 0)?.stale ?? dataAge === null,
    match: {
      mapName: state.mapName,
      mapDisplayName: mapDisplayName(state.mapName),
      roundNumber: state.roundNumber,
      phase: hudPhase(state),
      phaseEndsInSec: phaseClock.remainingSec,
      clockRunning: running && !phaseClock.frozen,
      paused: state.paused,
      regulationRounds: ctx.match?.format.regulationRounds ?? null,
    },
    left: leftTeam,
    right: rightTeam,
    observed: allPlayers.find((p) => p.observed) ?? null,
    bomb: state.bomb
      ? { state: state.bomb.state, site: state.bomb.site, remainingSec: bombClock?.remainingSec ?? null, clockRunning: !!bombClock && !bombClock.frozen }
      : null,
    roundHistory: state.roundHistory.map((r) => ({
      roundNumber: r.roundNumber,
      winner: r.winnerTeamId
        ? r.winnerTeamId === leftTeam.teamId
          ? "left"
          : r.winnerTeamId === rightTeam.teamId
            ? "right"
            : null
        : null,
      reason: r.reason,
    })),
    killfeed: ctx.killfeed,
    radar: radar(state, ctx, observed),
    series: sMeta,
    event,
    sponsors: ctx.sponsors,
    cues: ctx.cues,
    replay: ctx.replay,
    annotations: ctx.annotations,
    veto: ctx.veto,
    standings: ctx.standings,
    bracket: ctx.bracket,
    settings: ctx.settings,
  };
}
