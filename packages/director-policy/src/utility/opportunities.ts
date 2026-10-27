import type { CameraPath, CameraRecord, GrenadeType, MatchState, ObservedGrenadeType, ReasonCode, Side, SourceCapabilities, UtilityItem, Vec3 } from "@matchframe/contracts";
import { GRENADE_TYPES } from "@matchframe/contracts";
import type { ProfileSet } from "@matchframe/cs2-state";
import { DEFAULT_PROFILES } from "@matchframe/cs2-state";
import { targetInFrame } from "@matchframe/map-runtime";
import type { CameraMatch } from "@matchframe/map-runtime";
import type { DirectorConfig } from "../config.ts";

/** Map context needed for utility directing; MapRuntime satisfies it. */
export interface UtilityDirectorMap {
  mapName: string;
  regionsAt(p: Vec3): string[];
  levelAt(p: Vec3): string | null;
  camerasCovering(p: Vec3, opts?: { includeUnvalidated?: boolean; grenadeType?: string; actionClass?: string }): CameraMatch[];
  /** Validated cameras with an action class and allowed phase, independent of a point (establishing shots). */
  camerasWith?(opts: { actionClass: string; phase: string }): CameraMatch[];
  /** Usable camera paths (validated or built in), optionally for some regions. */
  pathsFor?(opts?: { regionIds?: readonly string[] }): CameraPath[];
}

/**
 * Scenario rule layered on the generic utility engine (spec §13.10). Thresholds belong to the
 * scenario only — e.g. the "≥3 alive Ts" setting applies to Inferno Bottom Banana, nowhere else.
 */
export interface UtilityScenarioRule {
  id: string;
  mapName: string;
  regionIds: string[];
  targetSide: Side;
  minAliveTargets: number;
  grenadeTypes: GrenadeType[];
  maxTimeToEffectMs: number;
  minConfidence: number;
  valueBoost: number;
  preferredCameraIds: string[];
}

export const INFERNO_BOTTOM_BANANA_RULE: UtilityScenarioRule = {
  id: "inferno-bottom-banana",
  mapName: "de_inferno",
  regionIds: ["bottom_banana"],
  targetSide: "T",
  minAliveTargets: 3,
  grenadeTypes: ["he", "molotov", "incendiary"],
  maxTimeToEffectMs: 2500,
  minConfidence: 0.45,
  valueBoost: 0.25,
  preferredCameraIds: [],
};

export interface AffectedCandidate {
  steamId: string;
  side: Side | null;
  distance: number;
}

export interface UtilityOpportunity {
  id: string;
  utilityIds: string[];
  kind: "single" | "volley" | "flash_entry" | "smoke_execute" | "fire_displacement";
  types: ObservedGrenadeType[];
  primaryType: ObservedGrenadeType;
  actionPoint: Vec3;
  levelId: string | null;
  regionIds: string[];
  /** 0 when the effect is already active. */
  timeToEffectMs: number;
  evidence: "confirmed" | "predicted";
  uncertaintyUnits: number;
  throwerSide: Side | null;
  affected: AffectedCandidate[];
  value: number;
  confidence: number;
  scenarioId: string | null;
  reasons: ReasonCode[];
  camera: { camera: CameraRecord; plannedDurationMs: number } | null;
  cameraIssue: string | null;
  /** Telemetry for this grenade type is unsupported/unverified on the current source. */
  typeSupport: "supported" | "partial" | "unsupported" | "unverified";
}

function isGrenade(t: ObservedGrenadeType): t is GrenadeType {
  return (GRENADE_TYPES as readonly string[]).includes(t);
}

function pointOf(u: UtilityItem): Vec3 | null {
  return u.effect?.centroid ?? u.confirmedActivation?.position ?? u.predicted?.activationPosition ?? u.samples[u.samples.length - 1]?.position ?? null;
}

export interface OpportunityOptions {
  cfg: DirectorConfig;
  map?: UtilityDirectorMap | undefined;
  capabilities?: SourceCapabilities | null | undefined;
  profiles?: ProfileSet;
  scenarios?: UtilityScenarioRule[];
  mainStorySteamIds?: ReadonlySet<string>;
}

/**
 * Generates utility opportunities for every tracked item on any part of the map, for both teams.
 * Historical tendencies are never used here: only live tracked utility can gate automatic shots.
 */
export function findUtilityOpportunities(state: MatchState, now: number, opts: OpportunityOptions): UtilityOpportunity[] {
  const profiles = opts.profiles ?? DEFAULT_PROFILES;
  const map = opts.map;
  const alive = state.players.filter((p) => p.lifeState === "alive" && p.position);
  const singles: UtilityOpportunity[] = [];

  for (const u of state.utility) {
    if (u.cleanupReason !== null) continue;
    const age = now - u.lastObservedMonotonicMs;
    if (age > opts.cfg.cinematic.maxUtilityAgeMs * 3) continue;
    const point = pointOf(u);
    if (!point) continue;
    const profile = isGrenade(u.type) ? profiles[u.type] : null;
    let timeToEffectMs = 0;
    let evidence: UtilityOpportunity["evidence"] = "confirmed";
    let uncertainty = 0;
    let evidenceFactor: number;
    if (u.phase === "flight") {
      if (!u.predicted) continue;
      evidence = "predicted";
      timeToEffectMs = Math.max(0, u.predicted.activationInMs - (now - u.predicted.computedAtMonotonicMs));
      uncertainty = u.predicted.positionUncertaintyUnits;
      evidenceFactor = (u.predicted.tier === "A" ? 0.85 : 0.65) * Math.max(0.3, 1 - uncertainty / 900);
    } else if (u.phase === "active") {
      // A persistent effect is interesting near its start; an old smoke is not a new story.
      const activatedAt = u.confirmedActivation?.monotonicMs ?? u.firstObservedMonotonicMs;
      if (now - activatedAt > 2500) continue;
      evidenceFactor = u.confirmedActivation?.evidence === "measured" ? 1 : 0.85;
    } else {
      continue;
    }
    const levelId = map?.levelAt(point) ?? u.level;
    const regionIds = map?.regionsAt(point) ?? u.regions;
    const radius = (profile?.effectRadiusUnits ?? 300) + uncertainty * 0.5;
    const affected: AffectedCandidate[] = [];
    for (const p of alive) {
      const d = Math.hypot(p.position!.x - point.x, p.position!.y - point.y, p.position!.z - point.z);
      const sameLevel = !map || map.levelAt(p.position!) === levelId;
      if (d <= radius && sameLevel) affected.push({ steamId: p.steamId, side: p.side, distance: d });
    }
    const opponents = u.throwerSide ? affected.filter((a) => a.side !== null && a.side !== u.throwerSide) : affected;
    const reasons: ReasonCode[] = ["UTILITY_INCOMING"];
    let kind: UtilityOpportunity["kind"] = "single";
    let weighted = opponents.reduce((s, a) => s + (1 - a.distance / (radius * 1.2)), 0);
    if (u.type === "smoke") {
      // Smoke value comes from blocking a lane during an execute/retake, not from "damage".
      const story = opts.mainStorySteamIds;
      const supporting = story ? alive.filter((p) => story.has(p.steamId) && Math.hypot(p.position!.x - point.x, p.position!.y - point.y) < 1400).length : 0;
      weighted = supporting >= 2 ? 1.2 : 0.2;
      if (supporting >= 2) kind = "smoke_execute";
    } else if (u.type === "flashbang") {
      const teammates = u.throwerSide ? alive.filter((p) => p.side === u.throwerSide && Math.hypot(p.position!.x - point.x, p.position!.y - point.y) < 900).length : 0;
      if (teammates >= 1 && opponents.length >= 1) kind = "flash_entry";
    } else if (u.type === "molotov" || u.type === "incendiary" || u.type === "fire_unknown") {
      if (opponents.length > 0) kind = "fire_displacement";
    }
    const affectedFactor = 1 - Math.exp(-0.7 * weighted);
    const editorial = profile?.editorialWeight ?? 0.2;
    const value = Math.min(1, editorial * (0.35 + 0.65 * affectedFactor) * evidenceFactor);
    if (u.type === "decoy") reasons.push("UTILITY_LOW_VALUE");
    const typeSupport = isGrenade(u.type) && opts.capabilities ? opts.capabilities.grenadeTypeSupport[u.type].support : "unverified";
    singles.push({
      id: `opp:${u.utilityId}`,
      utilityIds: [u.utilityId],
      kind,
      types: [u.type],
      primaryType: u.type,
      actionPoint: point,
      levelId,
      regionIds,
      timeToEffectMs,
      evidence,
      uncertaintyUnits: uncertainty,
      throwerSide: u.throwerSide,
      affected,
      value,
      confidence: Math.min(1, evidenceFactor * u.typeConfidence + 0.1),
      scenarioId: null,
      reasons,
      camera: null,
      cameraIssue: null,
      typeSupport,
    });
  }

  // Coordinated volleys: damaging utility converging on the same area within ~1 s.
  const volleys: UtilityOpportunity[] = [];
  const used = new Set<string>();
  const damaging = singles.filter((o) => ["he", "molotov", "incendiary", "fire_unknown"].includes(o.primaryType));
  for (const o of damaging) {
    if (used.has(o.id)) continue;
    const group = damaging.filter(
      (x) =>
        !used.has(x.id) &&
        Math.hypot(x.actionPoint.x - o.actionPoint.x, x.actionPoint.y - o.actionPoint.y, x.actionPoint.z - o.actionPoint.z) < 400 &&
        Math.abs(x.timeToEffectMs - o.timeToEffectMs) < 1000,
    );
    if (group.length < 2) continue;
    group.forEach((g) => used.add(g.id));
    const affected = new Map<string, AffectedCandidate>();
    for (const g of group) for (const a of g.affected) affected.set(a.steamId, a);
    const cx = group.reduce((s, g) => s + g.actionPoint.x, 0) / group.length;
    const cy = group.reduce((s, g) => s + g.actionPoint.y, 0) / group.length;
    const cz = group.reduce((s, g) => s + g.actionPoint.z, 0) / group.length;
    const actionPoint = { x: cx, y: cy, z: cz };
    volleys.push({
      ...o,
      id: `volley:${group.map((g) => g.utilityIds[0]).join("+")}`,
      utilityIds: group.flatMap((g) => g.utilityIds),
      kind: "volley",
      types: group.map((g) => g.primaryType),
      actionPoint,
      timeToEffectMs: Math.min(...group.map((g) => g.timeToEffectMs)),
      affected: [...affected.values()],
      value: Math.min(1, Math.max(...group.map((g) => g.value)) + 0.15 * (group.length - 1)),
      confidence: Math.min(...group.map((g) => g.confidence)),
      reasons: [...o.reasons, "UTILITY_VOLLEY"],
    });
  }
  const all = [...volleys, ...singles.filter((s) => !used.has(s.id) || s.primaryType === "smoke")];

  for (const opp of all) {
    applyScenarios(opp, state, opts.scenarios ?? [], map);
    attachCamera(opp, opts.cfg, map);
  }
  return all.sort((a, b) => b.value - a.value);
}

function applyScenarios(opp: UtilityOpportunity, state: MatchState, rules: UtilityScenarioRule[], map: UtilityDirectorMap | undefined): void {
  if (!map) return;
  for (const rule of rules) {
    if (rule.mapName !== map.mapName && rule.mapName !== state.mapName) continue;
    if (!opp.regionIds.some((r) => rule.regionIds.includes(r))) continue;
    if (!opp.types.some((t) => isGrenade(t) && rule.grenadeTypes.includes(t))) {
      // A T mass with an irrelevant smoke/decoy incoming does not trigger the scenario.
      if (!opp.reasons.includes("UTILITY_LOW_VALUE")) opp.reasons.push("UTILITY_LOW_VALUE");
      continue;
    }
    const targets = state.players.filter(
      (p) => p.lifeState === "alive" && p.side === rule.targetSide && p.position && map.regionsAt(p.position).some((r) => rule.regionIds.includes(r)),
    );
    if (targets.length < rule.minAliveTargets) continue;
    if (opp.timeToEffectMs > rule.maxTimeToEffectMs) continue;
    if (opp.confidence < rule.minConfidence) continue;
    opp.value = Math.min(1, opp.value + rule.valueBoost);
    opp.scenarioId = rule.id;
    opp.reasons.push("UTILITY_CLUSTER_TARGET");
  }
}

function attachCamera(opp: UtilityOpportunity, cfg: DirectorConfig, map: UtilityDirectorMap | undefined): void {
  if (!map) {
    opp.cameraIssue = "no map pack";
    return;
  }
  const matches = map.camerasCovering(opp.actionPoint, { grenadeType: isGrenade(opp.primaryType) ? opp.primaryType : undefined, actionClass: "utility" });
  if (matches.length === 0) {
    opp.cameraIssue = "no validated camera covers this area/level";
    opp.reasons.push("UTILITY_NO_CAMERA");
    return;
  }
  for (const m of matches) {
    const cam = m.camera;
    if (!targetInFrame(cam, opp.actionPoint)) continue;
    const lead = opp.timeToEffectMs;
    const active = opp.evidence === "confirmed";
    if (!active && lead < cam.minAcquisitionMs + cfg.cinematic.leadMarginMs) continue;
    const planned = Math.min(cam.maxDurationMs, cfg.cinematic.maxDurationMs, Math.max(1000, lead + Math.min(cam.normalDurationMs, 1800)));
    opp.camera = { camera: cam, plannedDurationMs: planned };
    opp.cameraIssue = null;
    return;
  }
  opp.cameraIssue = "covering cameras lack framing or acquisition lead time";
  opp.reasons.push("UTILITY_NO_CAMERA");
}
