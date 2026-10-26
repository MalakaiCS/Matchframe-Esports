import type {
  ActionClass,
  ControlHealth,
  DirectorDecision,
  DirectorMode,
  MatchState,
  OwnershipState,
  ReasonCode,
  ShotCandidate,
  Side,
  SourceCapabilities,
} from "@matchframe/contracts";
import type { ProfileSet } from "@matchframe/cs2-state";
import type { MapRuntime } from "@matchframe/map-runtime";
import type { Pin, ScoredCandidate } from "./candidates.ts";
import { generateCandidates } from "./candidates.ts";
import type { DirectorConfig } from "./config.ts";
import { mergeConfig } from "./config.ts";
import type { InteractionFeatures, SpatialContext } from "./features/interactions.ts";
import { computeInteractions } from "./features/interactions.ts";
import { roundContext } from "./features/significance.ts";
import { StateHistory } from "./history.ts";
import { ShotPlanner } from "./planner.ts";
import type { ShotKey } from "./shots.ts";
import { parseShot, povShot } from "./shots.ts";
import type { UtilityOpportunity, UtilityScenarioRule } from "./utility/opportunities.ts";
import { findUtilityOpportunities, INFERNO_BOTTOM_BANANA_RULE } from "./utility/opportunities.ts";

/** What the engine should do with a decision. The director never talks to the game directly. */
export interface DirectorIntent {
  kind: "select_player" | "activate_static_camera";
  targetSteamId: string | null;
  observerSlot: number | null;
  cameraId: string | null;
  plannedDurationMs: number | null;
  opportunityId: string | null;
  decisionId: string;
  basedOnSequence: number;
  expiresInMs: number;
}

export interface DirectorOutput {
  decision: DirectorDecision;
  intent: DirectorIntent | null;
  opportunities: UtilityOpportunity[];
  interactions: InteractionFeatures;
  candidates: ScoredCandidate[];
}

export interface ControlStatus {
  ownership: OwnershipState;
  adapterAvailable: boolean;
  /** Data is fresh and timelines are aligned. */
  inputFresh: boolean;
  pendingCommand: boolean;
}

export interface DirectorControls {
  hold: { until: number | null } | null;
  pin: Pin | null;
  oneSide: Side | null;
  cinematicsDisabled: { round: string | null; map: string | null; match: boolean };
  autoReplaysDisabled: boolean;
  /** Assisted mode: the action classes the operator enabled for automatic execution. */
  assistedActions: Set<ActionClass>;
  /** One-shot override: cut to the best candidate now (FOLLOW ACTION). */
  followActionRequested: boolean;
  /** One-shot: allow the next eligible cinematic even if the round budget is used. */
  cinematicRequested: boolean;
}

export interface DirectorOptions {
  config?: Partial<DirectorConfig>;
  scenarios?: UtilityScenarioRule[];
  profiles?: ProfileSet;
  modelVersion?: string | null;
  newId?: () => string;
}

let decisionCounter = 0;

function toShotCandidate(c: ScoredCandidate): ShotCandidate {
  const { opportunity: _o, plannedDurationMs: _p, urgent: _u, ...rest } = c;
  return rest;
}

/**
 * Matchframe Director (baseline-1). Deterministic, explainable, bounded-latency. Prediction
 * (interaction features), editorial value (candidate scoring), temporal planning (planner) and
 * camera control (arbiter, outside this class) are separate stages.
 */
export class Director {
  private cfg: DirectorConfig;
  private mode: DirectorMode = "advisory";
  private map: MapRuntime | undefined;
  private capabilities: SourceCapabilities | null = null;
  private readonly history = new StateHistory();
  private readonly planner: ShotPlanner;
  private readonly scenarios: UtilityScenarioRule[];
  private readonly profiles: ProfileSet | undefined;
  private modelVersion: string | null;
  private readonly newId: () => string;
  private lastSequence = -1;
  private lastOutput: DirectorOutput | null = null;
  private lastEvalAt = -Infinity;
  readonly controls: DirectorControls = {
    hold: null,
    pin: null,
    oneSide: null,
    cinematicsDisabled: { round: null, map: null, match: false },
    autoReplaysDisabled: false,
    assistedActions: new Set<ActionClass>(["pov_cut"]),
    followActionRequested: false,
    cinematicRequested: false,
  };

  constructor(opts: DirectorOptions = {}) {
    this.cfg = mergeConfig(opts.config);
    this.planner = new ShotPlanner(this.cfg);
    this.scenarios = opts.scenarios ?? [INFERNO_BOTTOM_BANANA_RULE];
    this.profiles = opts.profiles;
    this.modelVersion = opts.modelVersion ?? null;
    this.newId = opts.newId ?? (() => `decision-${Date.now().toString(36)}-${(decisionCounter++).toString(36)}`);
  }

  get config(): DirectorConfig {
    return this.cfg;
  }

  get currentMode(): DirectorMode {
    return this.mode;
  }

  get shotPlanner(): ShotPlanner {
    return this.planner;
  }

  setMode(mode: DirectorMode): void {
    this.mode = mode;
  }

  setConfig(partial: Partial<DirectorConfig>): void {
    this.cfg = mergeConfig({ ...this.cfg, ...partial });
    this.planner.setConfig(this.cfg);
  }

  setMap(map: MapRuntime | undefined): void {
    this.map = map;
  }

  setCapabilities(caps: SourceCapabilities | null): void {
    this.capabilities = caps;
  }

  setModelVersion(v: string | null): void {
    this.modelVersion = v;
  }

  hold(durationMs: number | null, now: number): void {
    this.controls.hold = { until: durationMs === null ? null : now + durationMs };
  }

  releaseHold(): void {
    this.controls.hold = null;
  }

  pin(pin: Pin | null): void {
    this.controls.pin = pin;
  }

  setOneSide(side: Side | null): void {
    this.controls.oneSide = side;
  }

  followAction(): void {
    this.controls.hold = null;
    this.controls.pin = null;
    this.controls.followActionRequested = true;
  }

  requestCinematic(): void {
    this.controls.cinematicRequested = true;
  }

  disableCinematics(scope: "round" | "map" | "match", state: MatchState | null, disabled = true): void {
    if (scope === "round") this.controls.cinematicsDisabled.round = disabled ? (state?.roundAttemptId ?? "current") : null;
    if (scope === "map") this.controls.cinematicsDisabled.map = disabled ? (state?.mapName ?? "current") : null;
    if (scope === "match") this.controls.cinematicsDisabled.match = disabled;
  }

  /** Observed (confirmed) shot feedback from the camera/telemetry layer. */
  observeShot(shot: ShotKey | null, at: number): void {
    this.planner.observeShot(shot, at);
  }

  cinematicStarted(shot: ShotKey, at: number, plannedDurationMs: number, opportunityId: string | null): void {
    this.planner.cinematicStarted(shot, at, plannedDurationMs, opportunityId);
  }

  private cinematicsAllowed(state: MatchState): { allowed: boolean; reason: ReasonCode | null } {
    const d = this.controls.cinematicsDisabled;
    if (!this.cfg.cinematic.enabled || d.match || (d.map !== null && d.map === state.mapName) || (d.round !== null && d.round === state.roundAttemptId)) {
      return { allowed: false, reason: "CINEMATIC_DISABLED" };
    }
    if (this.planner.cinematicBudgetLeft() <= 0 && !this.controls.cinematicRequested) return { allowed: false, reason: "CINEMATIC_BUDGET_EXHAUSTED" };
    return { allowed: true, reason: null };
  }

  private controlHealth(control: ControlStatus): ControlHealth {
    if (control.ownership.emergencyStopped) return "emergency_stopped";
    if (this.mode === "off" || this.mode === "advisory" || this.mode === "shadow" || this.mode === "demo_review") return "disarmed";
    if (control.ownership.manualSticky || control.ownership.owner !== "director") return "manual_owned";
    if (this.controls.hold) return "paused";
    if (!control.inputFresh || !control.adapterAvailable) return "degraded";
    return "armed";
  }

  evaluate(state: MatchState, now: number, control: ControlStatus): DirectorOutput {
    // No repeated decision pretending to be new evidence: unchanged telemetry within the cadence
    // window returns the previous output.
    const minInterval = 1000 / this.cfg.maxAnalysisHz;
    if (this.lastOutput && state.sequence === this.lastSequence && now - this.lastEvalAt < minInterval && !this.controls.followActionRequested) {
      return this.lastOutput;
    }
    this.lastEvalAt = now;
    this.lastSequence = state.sequence;
    if (this.controls.hold?.until !== null && this.controls.hold?.until !== undefined && now >= this.controls.hold.until) this.controls.hold = null;

    this.history.push(state);
    this.planner.setRound(state.roundAttemptId);
    const observed: ShotKey | null = state.observer.observedSteamId ? povShot(state.observer.observedSteamId) : null;
    // Keep the planner on a confirmed cinematic; otherwise follow observed POV feedback.
    const activeCine = this.planner.activeCinematic;
    if (!(activeCine && state.observer.cameraMode === "roaming")) this.planner.observeShot(observed, now);

    const map = this.map && this.map.mapName === state.mapName ? this.map : undefined;
    const spatial: SpatialContext | undefined = map ? { levelAt: (p) => map.levelAt(p), regionsAt: (p) => map.regionsAt(p), hasVisibilityGeometry: false } : undefined;
    const interactions = computeInteractions(state, now, this.cfg, spatial, this.history);
    const round = roundContext(state, now, map ? (p) => map.siteAt(p) : undefined);
    const opportunities = findUtilityOpportunities(state, now, {
      cfg: this.cfg,
      map,
      capabilities: this.capabilities,
      ...(this.profiles ? { profiles: this.profiles } : {}),
      scenarios: this.scenarios,
      mainStorySteamIds: new Set(interactions.mainStory?.members ?? []),
    });
    const candidates = generateCandidates({
      state,
      now,
      cfg: this.cfg,
      currentShot: this.planner.shot,
      currentShotSinceMs: this.planner.shotSince,
      interactions,
      round,
      opportunities,
      capabilities: this.capabilities,
      pin: this.controls.pin,
      oneSide: this.controls.oneSide,
      recentlyAbandoned: this.planner.recentlyAbandoned,
      cinematicsAllowed: this.cinematicsAllowed(state),
      map,
    });

    const health = this.controlHealth(control);
    const reasons: ReasonCode[] = [];
    let plan = this.planner.plan(candidates, now, state.sequence);
    if (this.controls.followActionRequested) {
      const best = candidates.find((c) => c.valid && c.shotKey !== this.planner.shot);
      if (best) plan = { action: "cut", desired: best, current: plan.current, reasons: ["MAIN_STORY"], urgent: true };
      this.controls.followActionRequested = false;
    }
    if (this.controls.hold) {
      reasons.push("HOLD_REQUESTED");
      plan = { ...plan, action: "hold" };
    }
    if (!control.inputFresh) {
      reasons.push("STALE_DATA");
      plan = { ...plan, action: "hold" };
    }
    if (control.ownership.emergencyStopped) reasons.push("EMERGENCY_STOP");
    else if (control.ownership.manualSticky || control.ownership.owner !== "director") reasons.push("MANUAL_OWNERSHIP");
    reasons.push(...plan.reasons);

    const desired = plan.desired;
    const desiredKey = desired?.shotKey ?? null;
    const executable =
      plan.action === "cut" &&
      desired !== null &&
      health === "armed" &&
      !control.pendingCommand &&
      (this.mode === "automatic" ||
        (this.mode === "assisted" && this.controls.assistedActions.has(parseShot(desiredKey).kind === "pov" ? "pov_cut" : "cinematic")));

    const action: DirectorDecision["action"] =
      plan.action === "hold" ? "hold" : executable ? "cut" : this.mode === "off" ? "none" : "recommend";
    const decisionId = this.newId();
    const top = candidates.filter((c) => c.valid).slice(0, 3);
    const best = desired ?? top[0] ?? null;
    const sf = best?.targetSteamId ? interactions.byPlayer.get(best.targetSteamId) : undefined;
    const confidence = desired ? Math.max(0.05, Math.min(0.95, 0.5 + (desired.utility - (plan.current?.utility ?? 0)))) : 0.5;
    const decision: DirectorDecision = {
      decisionId,
      sessionId: state.sessionId,
      epoch: state.epoch,
      basedOnSequence: state.sequence,
      decidedAtMonotonicMs: now,
      mode: this.mode,
      controlHealth: health,
      currentShot: this.planner.shot,
      desiredShot: plan.action === "cut" ? desiredKey : this.planner.shot,
      action,
      reasonCodes: [...new Set(reasons)],
      supportingFeatures: {
        contactProbabilityWithin0_5s: sf?.contact["0.5"] ?? null,
        contactProbabilityWithin1s: sf?.contact["1"] ?? null,
        contactProbabilityWithin2s: sf?.contact["2"] ?? null,
        contactProbabilityWithin3s: sf?.contact["3"] ?? null,
        readiness: best?.components.readiness ?? null,
        dataAgeMs: state.time.receivedAtMonotonicMs ? now - state.time.receivedAtMonotonicMs : null,
        candidateUtility: best?.utility ?? null,
        currentUtility: plan.current?.utility ?? null,
        cinematicsLeftThisRound: this.planner.cinematicBudgetLeft(),
      },
      confidence,
      evidenceType: "estimated",
      policyVersion: this.cfg.policyVersion,
      modelVersion: this.modelVersion,
      expiresInMs: 450,
      topCandidates: top.map(toShotCandidate),
      effectiveWeights: { ...this.cfg.weights },
    };

    let intent: DirectorIntent | null = null;
    if (executable && desired) {
      const shot = parseShot(desired.shotKey);
      const target = shot.kind === "pov" ? state.players.find((p) => p.steamId === shot.id) : undefined;
      intent =
        shot.kind === "pov"
          ? {
              kind: "select_player",
              targetSteamId: shot.id,
              observerSlot: target?.observerSlot ?? null,
              cameraId: null,
              plannedDurationMs: null,
              opportunityId: null,
              decisionId,
              basedOnSequence: state.sequence,
              expiresInMs: 450,
            }
          : {
              kind: "activate_static_camera",
              targetSteamId: null,
              observerSlot: null,
              cameraId: shot.id,
              plannedDurationMs: desired.plannedDurationMs,
              opportunityId: desired.opportunity?.id ?? null,
              decisionId,
              basedOnSequence: state.sequence,
              expiresInMs: 450,
            };
      if (shot.kind !== "pov") this.controls.cinematicRequested = false;
    }

    const output: DirectorOutput = { decision, intent, opportunities, interactions, candidates };
    this.lastOutput = output;
    return output;
  }
}
