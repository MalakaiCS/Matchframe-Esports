import type {
  AffectedPlayer,
  EvidenceType,
  GrenadeType,
  LifeState,
  ObservedGrenadeType,
  Side,
  UtilityEffect,
  UtilityEffectKind,
  UtilityItem,
  Vec3,
  WeaponState,
} from "@matchframe/contracts";
import { GRENADE_TYPES } from "@matchframe/contracts";
import type { UtilityObservation } from "../gsi/normalize.ts";
import { centroid, distance, length } from "../vec.ts";
import { predictActivation } from "./predict.ts";
import type { BallisticParams } from "./predict.ts";
import type { ProfileSet } from "./profiles.ts";
import { DEFAULT_PROFILES, GRENADE_WEAPON_NAMES, resolveRawType } from "./profiles.ts";

/** Spatial context injected from the map runtime; the tracker never hard-codes callouts. */
export interface UtilityMapContext {
  regionsAt(p: Vec3): string[];
  levelAt(p: Vec3): string | null;
  floorZAt?(p: Vec3): number | null;
  /** True when prediction for this grenade type has been calibrated on this map. */
  isCalibrated?(type: GrenadeType): boolean;
}

export interface TrackerPlayerView {
  side: Side | null;
  weapons: WeaponState[] | null;
  flashed: number | null;
  health: number | null;
  position: Vec3 | null;
  lifeState: LifeState;
}

export interface UtilityTrackerContext {
  sessionId: string;
  epoch: number;
  sourceId: string;
  nowMonotonicMs: number;
  matchTimeMs: number | null;
  players: ReadonlyMap<string, TrackerPlayerView> | null;
}

export type UtilityTrackerEvent =
  | { kind: "thrown"; utilityId: string; type: ObservedGrenadeType; ownerSteamId: string | null; side: Side | null }
  | { kind: "type_resolved"; utilityId: string; from: ObservedGrenadeType; to: ObservedGrenadeType; evidence: string }
  | { kind: "activated"; utilityId: string; type: ObservedGrenadeType; evidence: EvidenceType; position: Vec3 }
  | { kind: "expired"; utilityId: string; type: ObservedGrenadeType; reason: string }
  | { kind: "lost"; utilityId: string; type: ObservedGrenadeType }
  | { kind: "linked"; projectileId: string; effectId: string }
  | { kind: "affected"; utilityId: string; steamId: string; effect: AffectedPlayer["effect"]; evidence: EvidenceType };

/** Event from an event-capable source (parser or authorized server adapter). */
export interface UtilitySourceEvent {
  kind: "detonate" | "effect_start" | "effect_end";
  sourceEntityId: string | null;
  type: GrenadeType;
  position: Vec3 | null;
  ownerSteamId: string | null;
  eventRef: string;
}

interface Internal {
  item: UtilityItem;
  entityKey: string;
  present: boolean;
  isFireArea: boolean;
  lastLifetimeSec: number | null;
  restSamples: number;
  removedAtMonotonicMs: number | null;
  corroborateUntilMs: number | null;
  typeLocked: boolean;
}

interface Consumption {
  steamId: string;
  type: GrenadeType;
  atMonotonicMs: number;
  used: boolean;
}

export interface UtilityTrackerOptions {
  profiles?: ProfileSet;
  map?: UtilityMapContext;
  ballistics?: BallisticParams;
  maxSamples?: number;
  /** Keep ended items visible this long (ms) for display and director context. */
  recentRetentionMs?: number;
  /** Items not refreshed for this long while the source is silent are cleaned up as stale. */
  staleTimeoutMs?: number;
  /** Bounded per-epoch history of ended items. */
  maxHistory?: number;
}

const REST_SPEED = 5;
const FIRE_LINK_RADIUS = 450;
const FIRE_LINK_WINDOW_MS = 1500;
const CONSUMPTION_WINDOW_MS = 2000;
const CORROBORATION_WINDOW_MS = 700;

function effectKindFor(type: ObservedGrenadeType, isFireArea: boolean): UtilityEffectKind | null {
  if (isFireArea) return "fire_area";
  switch (type) {
    case "he":
      return "he_burst";
    case "flashbang":
      return "flash_burst";
    case "smoke":
      return "smoke_volume";
    case "decoy":
      return "decoy_active";
    case "molotov":
    case "incendiary":
    case "fire_unknown":
      return "fire_area";
    default:
      return null;
  }
}

function isGrenadeType(t: ObservedGrenadeType): t is GrenadeType {
  return (GRENADE_TYPES as readonly string[]).includes(t);
}

function isFireType(t: ObservedGrenadeType): boolean {
  return t === "molotov" || t === "incendiary" || t === "fire_unknown";
}

/**
 * Universal utility tracker: one engine for HE, flashbang, smoke, Molotov, incendiary and decoy,
 * from both teams, anywhere on the map. Snapshot sources (GSI `grenades`) use full-snapshot
 * semantics: an entity missing from a present component has been removed. Removal is NOT treated
 * as proof of detonation at the last sampled position.
 */
export class UtilityTracker {
  private readonly profiles: ProfileSet;
  private map: UtilityMapContext | undefined;
  private readonly ballistics: BallisticParams | undefined;
  private readonly maxSamples: number;
  private readonly recentRetentionMs: number;
  private readonly staleTimeoutMs: number;
  private readonly maxHistory: number;
  private readonly records = new Map<string, Internal>();
  private readonly entityToUtility = new Map<string, string>();
  private readonly generation = new Map<string, number>();
  private history: UtilityItem[] = [];
  private consumptions: Consumption[] = [];
  private prevInventory = new Map<string, Map<GrenadeType, number>>();
  private prevFlashed = new Map<string, number>();
  private prevHealth = new Map<string, number>();
  private epochKey = "";
  private gapOpenSinceMs: number | null = null;

  constructor(opts: UtilityTrackerOptions = {}) {
    this.profiles = opts.profiles ?? DEFAULT_PROFILES;
    this.map = opts.map;
    this.ballistics = opts.ballistics;
    this.maxSamples = opts.maxSamples ?? 48;
    this.recentRetentionMs = opts.recentRetentionMs ?? 8000;
    this.staleTimeoutMs = opts.staleTimeoutMs ?? 5000;
    this.maxHistory = opts.maxHistory ?? 2000;
  }

  setMapContext(map: UtilityMapContext | undefined): void {
    this.map = map;
    for (const r of this.records.values()) this.assignRegions(r);
  }

  /** Clears all live items (epoch reset / map change). Ended items move to history. */
  reset(reason: "epoch_reset" | "map_change", nowMonotonicMs: number): UtilityTrackerEvent[] {
    const events: UtilityTrackerEvent[] = [];
    for (const r of this.records.values()) {
      if (r.item.cleanupReason === null) {
        r.item.cleanupReason = reason;
        if (r.item.phase === "flight" || r.item.phase === "active" || r.item.phase === "unknown") {
          r.item.phase = "lost";
        }
        r.item.lastObservedMonotonicMs = Math.max(r.item.lastObservedMonotonicMs, nowMonotonicMs);
        events.push({ kind: "expired", utilityId: r.item.utilityId, type: r.item.type, reason });
      }
      this.pushHistory(r.item);
    }
    this.records.clear();
    this.entityToUtility.clear();
    this.consumptions = [];
    this.prevInventory.clear();
    this.prevFlashed.clear();
    this.prevHealth.clear();
    this.gapOpenSinceMs = null;
    return events;
  }

  /** Called when a packet arrives without the grenades component, or the source is silent. */
  markSourceGap(nowMonotonicMs: number): void {
    if (this.gapOpenSinceMs === null) this.gapOpenSinceMs = nowMonotonicMs;
  }

  ingestSnapshot(observations: readonly UtilityObservation[], ctx: UtilityTrackerContext): UtilityTrackerEvent[] {
    this.ensureEpoch(ctx);
    const events: UtilityTrackerEvent[] = [];
    const now = ctx.nowMonotonicMs;
    if (ctx.players) this.trackInventories(ctx.players, now);

    if (this.gapOpenSinceMs !== null) {
      for (const r of this.records.values()) {
        if (r.present) r.item.visibilityGaps.push({ fromMonotonicMs: this.gapOpenSinceMs, toMonotonicMs: now });
      }
      this.gapOpenSinceMs = null;
    }

    const seen = new Set<string>();
    for (const obs of observations) {
      const entityKey = `${ctx.sourceId}:${obs.sourceEntityId}`;
      seen.add(entityKey);
      let rec = this.currentRecord(entityKey);
      const res = resolveRawType(obs.rawType);
      if (rec) {
        const lifetimeReset =
          obs.lifetimeSec !== null && rec.lastLifetimeSec !== null && obs.lifetimeSec + 0.5 < rec.lastLifetimeSec;
        const typeChanged = rec.isFireArea !== res.isFireArea;
        if (lifetimeReset || typeChanged) {
          // Entity index reused by a new grenade: end the old item and start a new one.
          this.endRecord(rec, now, "source_removed", events);
          this.entityToUtility.delete(entityKey);
          rec = undefined;
        }
      }
      let created = false;
      if (!rec) {
        rec = this.createRecord(entityKey, obs, ctx, res);
        created = true;
        events.push({
          kind: "thrown",
          utilityId: rec.item.utilityId,
          type: rec.item.type,
          ownerSteamId: rec.item.throwerSteamId,
          side: rec.item.throwerSide,
        });
      }
      this.updateRecord(rec, obs, ctx, events);
      // Link a new fire area only after its first position/extent has been recorded.
      if (created && rec.isFireArea) this.linkFireArea(rec, now, events);
    }

    // Full-snapshot semantics: anything we were tracking from this source and did not see is removed.
    for (const [entityKey, utilityId] of [...this.entityToUtility.entries()]) {
      if (!entityKey.startsWith(`${ctx.sourceId}:`) || seen.has(entityKey)) continue;
      const rec = this.records.get(utilityId);
      if (rec && rec.present) this.handleRemoval(rec, now, events);
      this.entityToUtility.delete(entityKey);
    }

    this.resolvePendingTypes(now, events);
    this.corroborate(ctx, events);
    this.cleanup(now);
    return events;
  }

  /** Detonation / effect events from an event-capable source give measured confirmations. */
  ingestSourceEvent(evt: UtilitySourceEvent, ctx: UtilityTrackerContext): UtilityTrackerEvent[] {
    this.ensureEpoch(ctx);
    const events: UtilityTrackerEvent[] = [];
    let rec: Internal | undefined;
    if (evt.sourceEntityId !== null) rec = this.currentRecord(`${ctx.sourceId}:${evt.sourceEntityId}`);
    if (!rec && evt.sourceEntityId !== null) {
      const id = [...this.records.values()].find((r) => r.item.sourceEntityId === evt.sourceEntityId && r.item.cleanupReason === null);
      rec = id;
    }
    if (!rec) return events;
    if (rec.item.type !== evt.type && isGrenadeType(evt.type)) {
      events.push({ kind: "type_resolved", utilityId: rec.item.utilityId, from: rec.item.type, to: evt.type, evidence: `source event ${evt.eventRef}` });
      rec.item.type = evt.type;
      rec.item.typeConfidence = 0.99;
      rec.item.typeEvidence = `source event ${evt.eventRef}`;
      rec.typeLocked = true;
    }
    if (evt.kind === "detonate" || evt.kind === "effect_start") {
      if (evt.position) {
        rec.item.confirmedActivation = {
          position: evt.position,
          monotonicMs: ctx.nowMonotonicMs,
          matchTimeMs: ctx.matchTimeMs,
          evidenceRef: evt.eventRef,
          evidence: "measured",
        };
        this.ensureEffect(rec, evt.position, "measured", ctx.nowMonotonicMs);
        events.push({ kind: "activated", utilityId: rec.item.utilityId, type: rec.item.type, evidence: "measured", position: evt.position });
      }
      rec.item.phase = this.isInstant(rec.item.type) ? "expired" : "active";
    } else if (evt.kind === "effect_end") {
      this.endRecord(rec, ctx.nowMonotonicMs, "expired", events);
    }
    this.assignRegions(rec);
    return events;
  }

  /** Advance time without a packet: cleans up stale items when the source has gone silent. */
  tick(nowMonotonicMs: number): void {
    this.cleanup(nowMonotonicMs);
  }

  /** Live and recently ended items. */
  items(): UtilityItem[] {
    return [...this.records.values()].map((r) => r.item);
  }

  activeItems(): UtilityItem[] {
    return this.items().filter((i) => i.cleanupReason === null);
  }

  /** Bounded history of ended items in this epoch (for stats, replay graphics and evaluation). */
  historyItems(): readonly UtilityItem[] {
    return this.history;
  }

  // ---------------------------------------------------------------------------------------

  private ensureEpoch(ctx: UtilityTrackerContext): void {
    const key = `${ctx.sessionId}:${ctx.epoch}`;
    if (this.epochKey === "") {
      this.epochKey = key;
    } else if (this.epochKey !== key) {
      this.reset("epoch_reset", ctx.nowMonotonicMs);
      this.history = [];
      this.epochKey = key;
    }
  }

  private currentRecord(entityKey: string): Internal | undefined {
    const id = this.entityToUtility.get(entityKey);
    return id ? this.records.get(id) : undefined;
  }

  private isInstant(t: ObservedGrenadeType): boolean {
    return t === "he" || t === "flashbang";
  }

  private createRecord(
    entityKey: string,
    obs: UtilityObservation,
    ctx: UtilityTrackerContext,
    res: ReturnType<typeof resolveRawType>,
  ): Internal {
    const gen = (this.generation.get(entityKey) ?? 0) + 1;
    this.generation.set(entityKey, gen);
    const utilityId = `${ctx.sessionId}:${ctx.epoch}:${ctx.sourceId}:${obs.sourceEntityId}#${gen}`;
    const owner = obs.ownerSteamId && obs.ownerSteamId !== "0" ? obs.ownerSteamId : null;
    const ownerView = owner ? ctx.players?.get(owner) : undefined;
    const item: UtilityItem = {
      utilityId,
      sessionId: ctx.sessionId,
      epoch: ctx.epoch,
      sourceId: ctx.sourceId,
      sourceEntityId: obs.sourceEntityId,
      type: res.type,
      typeConfidence: res.confidence,
      typeEvidence: res.evidence,
      throwerSteamId: owner,
      throwerSide: ownerView?.side ?? null,
      ownerConfidence: owner ? (ownerView ? 0.95 : 0.7) : 0,
      firstObservedMonotonicMs: ctx.nowMonotonicMs,
      lastObservedMonotonicMs: ctx.nowMonotonicMs,
      firstMatchTimeMs: ctx.matchTimeMs,
      lastMatchTimeMs: ctx.matchTimeMs,
      samples: [],
      bounces: [],
      phase: res.isFireArea ? "active" : "flight",
      predicted: null,
      confirmedActivation: null,
      effect: null,
      affectedPlayers: [],
      regions: [],
      level: null,
      clusterId: null,
      linkedUtilityIds: [],
      cleanupReason: null,
      visibilityGaps: [],
    };
    const rec: Internal = {
      item,
      entityKey,
      present: true,
      isFireArea: res.isFireArea,
      lastLifetimeSec: null,
      restSamples: 0,
      removedAtMonotonicMs: null,
      corroborateUntilMs: null,
      typeLocked: res.confidence >= 0.9,
    };
    this.records.set(utilityId, rec);
    this.entityToUtility.set(entityKey, utilityId);
    return rec;
  }

  private updateRecord(rec: Internal, obs: UtilityObservation, ctx: UtilityTrackerContext, events: UtilityTrackerEvent[]): void {
    const item = rec.item;
    const now = ctx.nowMonotonicMs;
    item.lastObservedMonotonicMs = now;
    item.lastMatchTimeMs = ctx.matchTimeMs;
    rec.present = true;

    if (obs.position) {
      const prev = item.samples[item.samples.length - 1];
      item.samples.push({ monotonicMs: now, matchTimeMs: ctx.matchTimeMs, position: obs.position, velocity: obs.velocity });
      if (item.samples.length > this.maxSamples) {
        // Keep the first sample (release point) and the most recent history.
        item.samples.splice(1, item.samples.length - this.maxSamples);
      }
      if (prev?.velocity && obs.velocity && prev.velocity.z < -50 && obs.velocity.z > 50) {
        item.bounces.push({ monotonicMs: now, position: obs.position, evidence: "derived" });
      }
    }
    if (obs.lifetimeSec !== null) rec.lastLifetimeSec = obs.lifetimeSec;

    if (rec.isFireArea) {
      const pts = obs.flames ?? [];
      const c = centroid(pts) ?? obs.position;
      if (c) {
        if (item.confirmedActivation === null) {
          item.confirmedActivation = {
            position: c,
            monotonicMs: now,
            matchTimeMs: ctx.matchTimeMs,
            evidenceRef: `fire-area:${obs.sourceEntityId}`,
            evidence: "measured",
          };
          events.push({ kind: "activated", utilityId: item.utilityId, type: item.type, evidence: "measured", position: c });
        }
        const radius = pts.length > 0 ? Math.max(...pts.map((p) => distance(p, c))) + 40 : null;
        this.ensureEffect(rec, c, pts.length > 0 ? "measured" : "estimated", now);
        if (item.effect) {
          item.effect.extentPoints = pts.length > 0 ? pts : [c];
          item.effect.centroid = c;
          item.effect.radiusUnits = radius ?? item.effect.radiusUnits;
          item.effect.extentEvidence = pts.length > 0 ? "measured" : "estimated";
        }
      }
      item.phase = "active";
      this.assignRegions(rec);
      return;
    }

    // Projectile lifecycle.
    const speed = obs.velocity ? length(obs.velocity) : null;
    if (speed !== null && speed < REST_SPEED) rec.restSamples++;
    else if (speed !== null) rec.restSamples = 0;

    const activeBySource = obs.effectTimeSec !== null && obs.effectTimeSec > 0;
    const activeByRest = rec.restSamples >= 2 && (item.type === "smoke" || item.type === "decoy");
    if (item.phase === "flight" && (activeBySource || activeByRest) && obs.position) {
      item.phase = "active";
      const evidence: EvidenceType = activeBySource ? "measured" : "derived";
      item.confirmedActivation = {
        position: obs.position,
        monotonicMs: now,
        matchTimeMs: ctx.matchTimeMs,
        evidenceRef: activeBySource ? `effecttime:${obs.sourceEntityId}` : `at-rest:${obs.sourceEntityId}`,
        evidence,
      };
      this.ensureEffect(rec, obs.position, evidence, now);
      events.push({ kind: "activated", utilityId: item.utilityId, type: item.type, evidence, position: obs.position });
    }

    if (item.phase === "flight" && obs.position) {
      const profile = isGrenadeType(item.type) ? this.profiles[item.type] : null;
      if (profile) {
        item.predicted = predictActivation({
          position: obs.position,
          velocity: obs.velocity,
          lifetimeSec: obs.lifetimeSec,
          nowMonotonicMs: now,
          profile,
          floorZAt: this.map?.floorZAt?.bind(this.map),
          calibrated: this.map?.isCalibrated?.(profile.type) ?? false,
          ...(this.ballistics ? { ballistics: this.ballistics } : {}),
        });
      } else {
        item.predicted = null;
      }
    }
    this.assignRegions(rec);
  }

  private ensureEffect(rec: Internal, at: Vec3, evidence: EvidenceType, now: number): void {
    const item = rec.item;
    const kind = effectKindFor(item.type, rec.isFireArea);
    if (!kind) return;
    const profile = isGrenadeType(item.type) ? this.profiles[item.type] : null;
    const duration = profile?.effectDuration ?? null;
    if (!item.effect) {
      const effect: UtilityEffect = {
        kind,
        extentPoints: [at],
        centroid: at,
        radiusUnits: profile?.effectRadiusUnits ?? null,
        extentEvidence: profile?.effectRadiusUnits ? "estimated" : evidence,
        estimatedExpiryMonotonicMs: duration ? now + duration.meanMs : null,
        expiryEvidence: duration ? "estimated" : "unknown",
        expiryUncertaintyMs: duration ? duration.sdMs * 2 : null,
      };
      item.effect = effect;
    }
  }

  private handleRemoval(rec: Internal, now: number, events: UtilityTrackerEvent[]): void {
    const item = rec.item;
    rec.present = false;
    rec.removedAtMonotonicMs = now;
    if (rec.isFireArea || item.phase === "active") {
      this.endRecord(rec, now, "expired", events);
      if (item.effect) item.effect.expiryEvidence = "measured";
      return;
    }
    // Projectile disappeared in flight. Fire projectiles may be followed by a fire area (linked later).
    if (isFireType(item.type)) {
      rec.corroborateUntilMs = now + FIRE_LINK_WINDOW_MS;
      item.phase = "unknown";
      return;
    }
    if (this.isInstant(item.type)) {
      const profile = isGrenadeType(item.type) ? this.profiles[item.type] : null;
      const lifetimeMs = rec.lastLifetimeSec !== null ? rec.lastLifetimeSec * 1000 : null;
      const fuse = profile?.fuse;
      const consistent =
        fuse !== null && fuse !== undefined && lifetimeMs !== null && Math.abs(lifetimeMs + 100 - fuse.meanMs) <= fuse.sdMs * 3;
      const last = item.samples[item.samples.length - 1]?.position ?? null;
      if (last) this.ensureEffect(rec, last, "estimated", now);
      if (item.effect) item.effect.extentEvidence = "estimated";
      rec.corroborateUntilMs = now + CORROBORATION_WINDOW_MS;
      if (consistent) {
        this.endRecord(rec, now, "source_removed", events, "expired");
      } else {
        this.endRecord(rec, now, "source_removed", events, "lost");
      }
      return;
    }
    // Smoke / decoy / unknown removed before activation evidence.
    this.endRecord(rec, now, "source_removed", events, "lost");
  }

  private endRecord(
    rec: Internal,
    now: number,
    reason: NonNullable<UtilityItem["cleanupReason"]>,
    events: UtilityTrackerEvent[],
    phase: "expired" | "lost" = "expired",
  ): void {
    const item = rec.item;
    if (item.cleanupReason !== null) return;
    rec.present = false;
    rec.removedAtMonotonicMs ??= now;
    item.cleanupReason = reason;
    item.phase = phase;
    item.predicted = phase === "expired" && item.confirmedActivation ? null : item.predicted;
    events.push(
      phase === "lost"
        ? { kind: "lost", utilityId: item.utilityId, type: item.type }
        : { kind: "expired", utilityId: item.utilityId, type: item.type, reason },
    );
  }

  private linkFireArea(fire: Internal, now: number, events: UtilityTrackerEvent[]): void {
    const firePos = fire.item.effect?.centroid ?? fire.item.samples[0]?.position ?? null;
    let best: Internal | null = null;
    let bestScore = Infinity;
    for (const r of this.records.values()) {
      if (r === fire || r.isFireArea || !isFireType(r.item.type)) continue;
      if (r.item.linkedUtilityIds.length > 0) continue;
      const removedAt = r.removedAtMonotonicMs ?? now;
      if (now - removedAt > FIRE_LINK_WINDOW_MS) continue;
      const last = r.item.samples[r.item.samples.length - 1]?.position ?? null;
      const d = firePos && last ? distance(firePos, last) : FIRE_LINK_RADIUS;
      if (d > FIRE_LINK_RADIUS) continue;
      const sameOwner = fire.item.throwerSteamId !== null && fire.item.throwerSteamId === r.item.throwerSteamId;
      const score = d - (sameOwner ? 200 : 0);
      if (score < bestScore) {
        best = r;
        bestScore = score;
      }
    }
    if (!best) return;
    fire.item.linkedUtilityIds.push(best.item.utilityId);
    best.item.linkedUtilityIds.push(fire.item.utilityId);
    if (best.item.type !== "fire_unknown" && fire.item.type === "fire_unknown") {
      fire.item.type = best.item.type;
      fire.item.typeConfidence = best.item.typeConfidence;
      fire.item.typeEvidence = `inherited from linked projectile (${best.item.typeEvidence})`;
    }
    if (fire.item.throwerSteamId === null && best.item.throwerSteamId !== null) {
      fire.item.throwerSteamId = best.item.throwerSteamId;
      fire.item.throwerSide = best.item.throwerSide;
      fire.item.ownerConfidence = best.item.ownerConfidence * 0.9;
    }
    events.push({ kind: "linked", projectileId: best.item.utilityId, effectId: fire.item.utilityId });
    if (best.item.cleanupReason === null) {
      if (firePos) {
        best.item.confirmedActivation = {
          position: firePos,
          monotonicMs: now,
          matchTimeMs: fire.item.firstMatchTimeMs,
          evidenceRef: `linked-fire:${fire.item.utilityId}`,
          evidence: "derived",
        };
        events.push({ kind: "activated", utilityId: best.item.utilityId, type: best.item.type, evidence: "derived", position: firePos });
      }
      this.endRecord(best, now, "source_removed", events, "expired");
    }
  }

  private trackInventories(players: ReadonlyMap<string, TrackerPlayerView>, now: number): void {
    for (const [steamId, p] of players) {
      if (!p.weapons) continue;
      const inv = new Map<GrenadeType, number>();
      for (const t of GRENADE_TYPES) {
        const w = p.weapons.find((x) => x.name === GRENADE_WEAPON_NAMES[t]);
        if (w) inv.set(t, Math.max(1, w.ammoReserve ?? 1));
      }
      const prev = this.prevInventory.get(steamId);
      if (prev) {
        for (const [t, count] of prev) {
          const nowCount = inv.get(t) ?? 0;
          for (let i = 0; i < count - nowCount; i++) {
            this.consumptions.push({ steamId, type: t, atMonotonicMs: now, used: false });
          }
        }
      }
      this.prevInventory.set(steamId, inv);
    }
    this.consumptions = this.consumptions.filter((c) => now - c.atMonotonicMs <= CONSUMPTION_WINDOW_MS * 2);
  }

  /** Disambiguates fire_unknown/unknown items from the thrower's inventory delta, then team side. */
  private resolvePendingTypes(now: number, events: UtilityTrackerEvent[]): void {
    for (const rec of this.records.values()) {
      const item = rec.item;
      if (rec.typeLocked) continue;
      if (item.type !== "fire_unknown" && item.type !== "unknown") continue;
      if (rec.isFireArea && item.linkedUtilityIds.length > 0 && item.type !== "fire_unknown") continue;
      const owner = item.throwerSteamId;
      if (owner) {
        const candidates = this.consumptions.filter(
          (c) =>
            !c.used &&
            c.steamId === owner &&
            Math.abs(c.atMonotonicMs - item.firstObservedMonotonicMs) <= CONSUMPTION_WINDOW_MS &&
            (item.type === "unknown" || c.type === "molotov" || c.type === "incendiary"),
        );
        const match = candidates[0];
        if (match) {
          match.used = true;
          events.push({
            kind: "type_resolved",
            utilityId: item.utilityId,
            from: item.type,
            to: match.type,
            evidence: "thrower inventory delta",
          });
          item.type = match.type;
          item.typeConfidence = 0.9;
          item.typeEvidence = `thrower inventory delta (${GRENADE_WEAPON_NAMES[match.type]} consumed)`;
          rec.typeLocked = true;
          this.propagateTypeToLinks(rec);
          continue;
        }
      }
      // Fallback after the consumption window: team-side default is an estimate, not proof
      // (a CT can throw a dropped Molotov).
      if (
        item.type === "fire_unknown" &&
        item.throwerSide !== null &&
        now - item.firstObservedMonotonicMs > CONSUMPTION_WINDOW_MS
      ) {
        const to: GrenadeType = item.throwerSide === "T" ? "molotov" : "incendiary";
        events.push({ kind: "type_resolved", utilityId: item.utilityId, from: item.type, to, evidence: "thrower side default (estimated)" });
        item.type = to;
        item.typeConfidence = 0.7;
        item.typeEvidence = "estimated from thrower side; not confirmed";
        rec.typeLocked = true;
        this.propagateTypeToLinks(rec);
      }
    }
  }

  private propagateTypeToLinks(rec: Internal): void {
    for (const id of rec.item.linkedUtilityIds) {
      const other = this.records.get(id);
      if (other && !other.typeLocked && (other.item.type === "fire_unknown" || other.item.type === "unknown")) {
        other.item.type = rec.item.type;
        other.item.typeConfidence = rec.item.typeConfidence;
        other.item.typeEvidence = `inherited from linked item (${rec.item.typeEvidence})`;
        other.typeLocked = true;
      }
    }
  }

  /**
   * Links measured player-state changes (flash intensity, health loss) to recently ended
   * HE/flash items. Flash state is measured; attribution to a particular grenade is derived and
   * its confidence is divided across concurrent candidates. Health loss is never presented as
   * confirmed grenade damage.
   */
  private corroborate(ctx: UtilityTrackerContext, events: UtilityTrackerEvent[]): void {
    const players = ctx.players;
    if (!players) return;
    const now = ctx.nowMonotonicMs;
    const flashCands = [...this.records.values()].filter(
      (r) => r.item.type === "flashbang" && r.corroborateUntilMs !== null && now <= r.corroborateUntilMs,
    );
    const heCands = [...this.records.values()].filter(
      (r) => r.item.type === "he" && r.corroborateUntilMs !== null && now <= r.corroborateUntilMs,
    );
    for (const [steamId, p] of players) {
      const prevF = this.prevFlashed.get(steamId) ?? 0;
      if (p.flashed !== null && p.flashed > prevF + 0.25 && flashCands.length > 0) {
        for (const r of flashCands) {
          this.addAffected(r, { steamId, effect: "flashed", value: p.flashed, evidence: "derived", attributionConfidence: 0.85 / flashCands.length }, events);
          if (r.item.phase === "lost") r.item.phase = "expired";
        }
      }
      if (p.flashed !== null) this.prevFlashed.set(steamId, p.flashed);
      const prevH = this.prevHealth.get(steamId);
      if (p.health !== null && prevH !== undefined && p.health < prevH && heCands.length > 0) {
        for (const r of heCands) {
          const c = r.item.effect?.centroid ?? null;
          const near = c && p.position ? distance(c, p.position) <= (this.profiles.he.effectRadiusUnits ?? 350) : false;
          if (!near) continue;
          this.addAffected(r, { steamId, effect: "damaged", value: prevH - p.health, evidence: "derived", attributionConfidence: 0.5 / heCands.length }, events);
          if (r.item.phase === "lost") r.item.phase = "expired";
        }
      }
      if (p.health !== null) this.prevHealth.set(steamId, p.health);
    }
  }

  private addAffected(rec: Internal, a: AffectedPlayer, events: UtilityTrackerEvent[]): void {
    const existing = rec.item.affectedPlayers.find((x) => x.steamId === a.steamId && x.effect === a.effect);
    if (existing) {
      existing.value = a.value;
      return;
    }
    rec.item.affectedPlayers.push(a);
    events.push({ kind: "affected", utilityId: rec.item.utilityId, steamId: a.steamId, effect: a.effect, evidence: a.evidence });
  }

  private assignRegions(rec: Internal): void {
    const item = rec.item;
    const p =
      item.effect?.centroid ??
      item.confirmedActivation?.position ??
      item.predicted?.activationPosition ??
      item.samples[item.samples.length - 1]?.position ??
      null;
    if (!p || !this.map) {
      item.regions = [];
      item.level = null;
      return;
    }
    item.regions = this.map.regionsAt(p);
    item.level = this.map.levelAt(p);
  }

  private pushHistory(item: UtilityItem): void {
    this.history.push(item);
    if (this.history.length > this.maxHistory) this.history.splice(0, this.history.length - this.maxHistory);
  }

  private cleanup(now: number): void {
    for (const [id, r] of this.records) {
      const item = r.item;
      if (item.cleanupReason === null) {
        // Unlinked fire projectile whose link window passed: activation unknown.
        if (item.phase === "unknown" && r.corroborateUntilMs !== null && now > r.corroborateUntilMs) {
          item.cleanupReason = "source_removed";
          item.phase = "lost";
        } else if (now - item.lastObservedMonotonicMs > this.staleTimeoutMs) {
          item.cleanupReason = "stale_timeout";
          item.phase = item.phase === "active" ? "expired" : "lost";
          this.entityToUtility.delete(r.entityKey);
        }
        continue;
      }
      const endedAt = r.removedAtMonotonicMs ?? item.lastObservedMonotonicMs;
      if (now - endedAt > this.recentRetentionMs) {
        this.pushHistory(item);
        this.records.delete(id);
      }
    }
  }
}
