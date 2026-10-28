import type { ActionClass, MatchState, ReasonCode, ScoreComponents, ShotCandidate, Side, SourceCapabilities, Vec3 } from "@matchframe/contracts";
import type { DirectorConfig, DirectorWeights } from "./config.ts";
import type { InteractionFeatures } from "./features/interactions.ts";
import { playerReadiness } from "./features/readiness.ts";
import type { RoundContext } from "./features/significance.ts";
import { playerSignificance } from "./features/significance.ts";
import type { ShotKey } from "./shots.ts";
import { cameraShot, parseShot, povShot } from "./shots.ts";
import type { UtilityOpportunity, UtilityDirectorMap } from "./utility/opportunities.ts";

export type Pin =
  | { kind: "player"; steamId: string }
  | { kind: "side"; side: Side }
  | { kind: "team"; teamId: string }
  | { kind: "cluster"; steamIds: string[] };

export interface CandidateInput {
  state: MatchState;
  now: number;
  cfg: DirectorConfig;
  currentShot: ShotKey | null;
  currentShotSinceMs: number | null;
  interactions: InteractionFeatures;
  round: RoundContext;
  opportunities: UtilityOpportunity[];
  capabilities: SourceCapabilities | null;
  pin: Pin | null;
  oneSide: Side | null;
  recentlyAbandoned: ReadonlyMap<ShotKey, number>;
  cinematicsAllowed: { allowed: boolean; reason: ReasonCode | null };
  map?: UtilityDirectorMap | undefined;
  /** Optional learned per-player contact/imminence overrides (validated model output). */
  learnedImminence?: ReadonlyMap<string, number> | undefined;
  /** What the Observer mode may do on its own; null = no restriction (advisory recommendations). */
  scope?: ReadonlySet<ActionClass> | null | undefined;
  /** Players another observer already shows (a replay PC avoids the main PC's player). */
  avoid?: ReadonlySet<string> | null | undefined;
}

/** Utility taken off a player another observer already shows: the next-best action wins, but they stay a fallback. */
const AVOID_PENALTY = 0.8;

export interface ScoredCandidate extends ShotCandidate {
  opportunity: UtilityOpportunity | null;
  plannedDurationMs: number | null;
  urgent: boolean;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function utilityOf(c: ScoreComponents, w: DirectorWeights): number {
  return (
    w.actionCoverage * c.actionCoverage +
    w.imminence * c.imminence +
    w.readiness * c.readiness +
    w.significance * c.significance +
    w.narrative * c.narrative +
    w.framing * c.framing +
    w.continuity * c.continuity +
    w.mainStory * c.mainStory -
    c.switchCost -
    c.stalenessPenalty -
    c.cinematicOpportunityCost
  );
}

function cameraControlUsable(caps: SourceCapabilities | null): boolean {
  const s = caps?.staticCameraControl.support;
  return s === "supported" || s === "partial";
}

export function generateCandidates(input: CandidateInput): ScoredCandidate[] {
  const { state, now, cfg, interactions } = input;
  const w = cfg.weights;
  const out: ScoredCandidate[] = [];
  const current = parseShot(input.currentShot);
  const sinceCut = input.currentShotSinceMs === null ? Infinity : now - input.currentShotSinceMs;
  const currentPovCluster = current.kind === "pov" && current.id ? (interactions.byPlayer.get(current.id)?.clusterId ?? null) : null;
  const storySet = new Set(interactions.mainStory?.members ?? []);
  const storyValue = interactions.mainStory ? clamp01((interactions.mainStory.members.length - 1) / 4) : 0;
  const ctPush = interactions.mainStory && interactions.mainStory.members.length >= 3 ? interactions.isolatedAggressors.filter((a) => a.side === "CT") : [];
  const byId = new Map(state.players.map((p) => [p.steamId, p]));

  // Fallback boosts for utility with no valid camera: show it from a relevant POV instead.
  // Without nade cameras in the Observer mode, utility is shown from a POV as if no camera covered it.
  const utilityCamerasAllowed = !input.scope || input.scope.has("utility_camera");
  const povUtilityBoost = new Map<string, { value: number; reason: ReasonCode }>();
  for (const opp of input.opportunities) {
    if (opp.camera && utilityCamerasAllowed) continue;
    for (const a of opp.affected) {
      const prev = povUtilityBoost.get(a.steamId)?.value ?? 0;
      if (opp.value > prev) povUtilityBoost.set(a.steamId, { value: opp.value, reason: "UTILITY_NO_CAMERA" });
    }
  }

  for (const p of state.players) {
    if (p.side === null) continue;
    const key = povShot(p.steamId);
    const isCurrent = input.currentShot === key;
    const reasons: ReasonCode[] = [];
    let valid = true;
    let invalidReason: string | null = null;
    if (p.lifeState !== "alive") {
      valid = false;
      invalidReason = p.lifeState === "dead" ? "player dead" : "player state unknown";
      if (isCurrent) reasons.push("CURRENT_POV_DEAD");
    }
    if (input.oneSide && p.side !== input.oneSide) {
      valid = false;
      invalidReason = "outside one-side observing profile";
    }
    const pin = input.pin;
    if (pin) {
      const pinned =
        (pin.kind === "player" && pin.steamId === p.steamId) ||
        (pin.kind === "side" && pin.side === p.side) ||
        (pin.kind === "team" && pin.teamId === p.teamId) ||
        (pin.kind === "cluster" && pin.steamIds.includes(p.steamId));
      if (!pinned) {
        valid = false;
        invalidReason = "not pinned";
      } else reasons.push("PINNED");
    }

    const f = interactions.byPlayer.get(p.steamId);
    const cluster = f?.clusterId ? interactions.clusters.find((c) => c.id === f.clusterId) : undefined;
    const opponentId = f?.bestPair ? (f.bestPair.t === p.steamId ? f.bestPair.ct : f.bestPair.t) : null;
    const opp = opponentId ? byId.get(opponentId) : undefined;
    const threatDir: Vec3 | null = opp?.position && p.position ? { x: opp.position.x - p.position.x, y: opp.position.y - p.position.y, z: 0 } : null;
    const readiness = playerReadiness(p, threatDir);

    const own2 = f?.contact["2"] ?? 0;
    let actionCoverage = cluster ? cluster.actionValue * Math.max(0.4, own2 / Math.max(0.01, cluster.maxContact["2"] ?? 1)) : 0.05 + (storySet.has(p.steamId) ? 0.1 : 0);
    let imminence = input.learnedImminence?.get(p.steamId) ?? f?.imminence ?? 0;
    if ((f?.contact["0.5"] ?? 0) >= 0.6) reasons.push("CONTACT_IMMINENT");
    else if ((f?.contact["2"] ?? 0) >= 0.5) reasons.push("CONTACT_LIKELY_SOON");

    const sig = playerSignificance(state, p.steamId, input.round);
    reasons.push(...sig.reasons);

    let narrative = 0;
    if (interactions.crossfires.some((c) => c.defenders.includes(p.steamId))) {
      narrative = Math.max(narrative, 0.7);
      reasons.push("CROSSFIRE_SETUP");
    }
    if (cluster && cluster.members.some((m) => m !== p.steamId && byId.get(m)?.side === p.side)) {
      narrative = Math.max(narrative, 0.45);
      reasons.push("TRADE_OPPORTUNITY");
    }
    const aggressor = interactions.isolatedAggressors.find((a) => a.steamId === p.steamId || a.targetSteamId === p.steamId);
    if (aggressor) {
      narrative = Math.max(narrative, 0.6);
      reasons.push("ISOLATED_AGGRESSOR");
      if (ctPush.some((c) => c.steamId === p.steamId || c.targetSteamId === p.steamId)) {
        // A CT pushing into the T group before the execute is the more imminent story.
        reasons.push("CT_PUSH_BEFORE_T_EXECUTE");
        imminence = Math.max(imminence, aggressor.contact2s);
        actionCoverage = Math.max(actionCoverage, aggressor.contact2s);
      }
    }

    let framing = 0.5;
    if (threatDir && p.forward) {
      const len = Math.hypot(threatDir.x, threatDir.y) || 1;
      const cos = (threatDir.x * p.forward.x + threatDir.y * p.forward.y) / (len * (Math.hypot(p.forward.x, p.forward.y) || 1));
      framing = 0.4 + 0.6 * Math.max(0, cos);
    }
    if (readiness.flags.flashed) {
      framing *= 1 - 0.7 * (p.flashed ?? 0);
      reasons.push("PLAYER_FLASHED");
    }
    if (readiness.flags.reloading) reasons.push("PLAYER_RELOADING");
    if (readiness.score > 0.75 && readiness.coverage >= 0.75) reasons.push("PLAYER_READY");

    const continuity = isCurrent ? 1 : currentPovCluster && f?.clusterId === currentPovCluster ? 0.5 : 0;
    const mainStory = storySet.has(p.steamId) ? storyValue : 0;
    if (mainStory > 0.4) reasons.push("MAIN_STORY");
    const boost = povUtilityBoost.get(p.steamId);
    if (boost) {
      actionCoverage = Math.max(actionCoverage, boost.value * 0.6);
      reasons.push(boost.reason);
    }

    const posAge = p.positionObservedAtMonotonicMs !== null ? now - p.positionObservedAtMonotonicMs : Infinity;
    const stalenessPenalty = posAge > cfg.positionStaleMs ? Math.min(0.3, (posAge - cfg.positionStaleMs) / 5000) : 0;
    if (stalenessPenalty > 0.05) reasons.push("STALE_DATA");
    let switchCost = isCurrent ? 0 : cfg.baseSwitchCost + (sinceCut < cfg.minShotMs ? 0.05 : 0);
    const abandonedAt = input.recentlyAbandoned.get(key);
    if (!isCurrent && abandonedAt !== undefined && now - abandonedAt < cfg.abandonCooldownMs && imminence < 0.7) {
      switchCost += 0.1;
      reasons.push("COOLDOWN_ACTIVE");
    }

    const components: ScoreComponents = {
      actionCoverage: clamp01(actionCoverage),
      imminence: clamp01(imminence),
      readiness: readiness.score,
      significance: sig.value,
      narrative,
      framing: clamp01(framing),
      continuity,
      mainStory,
      switchCost,
      stalenessPenalty,
      cinematicOpportunityCost: 0,
    };
    if (isCurrent) reasons.unshift(valid ? "CURRENT_SHOT_VALID" : "CURRENT_SHOT_INVALID");
    const avoided = input.avoid?.has(p.steamId) === true;
    if (avoided) reasons.push("MAIN_OBSERVER_ON_IT");
    const urgent = sig.reasons.includes("BOMB_CRITICAL") || sig.reasons.includes("BOMB_DEFUSE_PRESSURE") || (f?.contact["0.5"] ?? 0) >= 0.7;
    out.push({
      candidateId: `cand:${key}`,
      shotClass: "pov",
      shotKey: key,
      targetSteamId: p.steamId,
      cameraId: null,
      clusterId: f?.clusterId ?? null,
      regionIds: cluster?.regionIds ?? [],
      components,
      utility: valid ? utilityOf(components, w) - (avoided ? AVOID_PENALTY : 0) : -1,
      reasonCodes: [...new Set(reasons)],
      valid,
      invalidReason,
      evidenceType: "estimated",
      opportunity: null,
      plannedDurationMs: null,
      urgent: valid && urgent && !avoided,
    });
  }

  // Static utility cameras chosen from the actual action region anywhere on the map.
  const fightsElsewhere = (point: Vec3, radius: number) =>
    Math.max(0, ...interactions.clusters.filter((c) => Math.hypot(c.centroid.x - point.x, c.centroid.y - point.y) > radius).map((c) => c.maxContact["1"] ?? 0));
  for (const opp of input.opportunities) {
    if (!opp.camera) continue;
    const cam = opp.camera.camera;
    const key = cameraShot(cam.id);
    const isCurrent = input.currentShot === key;
    const reasons: ReasonCode[] = [...opp.reasons];
    let valid = true;
    let invalidReason: string | null = null;
    if (!input.cinematicsAllowed.allowed && !isCurrent) {
      valid = false;
      invalidReason = "cinematics not allowed";
      if (input.cinematicsAllowed.reason) reasons.push(input.cinematicsAllowed.reason);
    }
    if (!cameraControlUsable(input.capabilities)) {
      valid = false;
      invalidReason = "static camera control not verified for this environment";
      reasons.push("CAMERA_UNVERIFIED");
    }
    if (opp.value < cfg.cinematic.minValue) {
      valid = false;
      invalidReason = "utility value below cinematic threshold";
      reasons.push("UTILITY_LOW_VALUE");
    }
    if (opp.typeSupport === "unsupported") {
      valid = false;
      invalidReason = "grenade type unsupported by current source";
    }
    if (input.oneSide || (input.pin && input.pin.kind !== "cluster")) {
      valid = false;
      invalidReason = "pinned/one-side profile active";
    }
    if (!utilityCamerasAllowed) {
      valid = false;
      invalidReason = "nade cameras are part of the Full Action Observer mode";
      reasons.push("OBSERVER_MODE_EXCLUDES");
    }
    if (valid) reasons.push("CINEMATIC_ELIGIBLE");
    const storyAffected = opp.affected.some((a) => storySet.has(a.steamId));
    const inFight = opp.affected.some((a) => interactions.byPlayer.get(a.steamId)?.clusterId);
    // Relevant-player readiness for a utility shot = readiness of the players it shows.
    const affectedReadiness = opp.affected
      .map((a) => byId.get(a.steamId))
      .filter((p): p is NonNullable<typeof p> => !!p)
      .map((p) => playerReadiness(p, null).score);
    const readinessComponent = affectedReadiness.length > 0 ? affectedReadiness.reduce((x, y) => x + y, 0) / affectedReadiness.length : 0.5;
    const coordinated = opp.scenarioId !== null || opp.kind === "volley" || opp.kind === "flash_entry" || opp.kind === "smoke_execute";
    const components: ScoreComponents = {
      actionCoverage: clamp01(opp.value),
      imminence: opp.evidence === "confirmed" ? 1 : clamp01(1 - opp.timeToEffectMs / 3000),
      readiness: readinessComponent,
      significance: input.round.bombPlanted && input.round.bombPosition && Math.hypot(input.round.bombPosition.x - opp.actionPoint.x, input.round.bombPosition.y - opp.actionPoint.y) < 1000 ? 0.6 : 0.2,
      narrative: coordinated ? 0.5 : inFight ? 0.4 : 0.15,
      framing: clamp01(1 - 0.5 * (Math.hypot(cam.coverage.center.x - opp.actionPoint.x, cam.coverage.center.y - opp.actionPoint.y) / cam.coverage.radiusUnits)),
      continuity: isCurrent ? 1 : 0,
      mainStory: storyAffected ? storyValue : 0,
      switchCost: isCurrent ? 0 : cfg.baseSwitchCost + 0.02,
      stalenessPenalty: 0,
      cinematicOpportunityCost: 0.03 + 0.35 * fightsElsewhere(opp.actionPoint, cam.coverage.radiusUnits),
    };
    out.push({
      candidateId: `cand:${key}:${opp.id}`,
      shotClass: "static_utility",
      shotKey: key,
      targetSteamId: null,
      cameraId: cam.id,
      clusterId: null,
      regionIds: opp.regionIds,
      components,
      utility: valid ? utilityOf(components, w) : -1,
      reasonCodes: [...new Set(reasons)],
      valid,
      invalidReason,
      evidenceType: opp.evidence === "confirmed" ? "measured" : "estimated",
      opportunity: opp,
      plannedDurationMs: opp.camera.plannedDurationMs,
      urgent: false,
    });
  }
  return out.sort((a, b) => b.utility - a.utility);
}
