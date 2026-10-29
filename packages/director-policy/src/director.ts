import type {
  ActionClass,
  ControlHealth,
  DirectorDecision,
  DirectorMode,
  MatchState,
  ObserverMode,
  OwnershipState,
  ReasonCode,
  ShotCandidate,
  ShotClass,
  Side,
  SourceCapabilities,
  Vec3,
} from "@matchframe/contracts";
import { actionClassOfShot, OBSERVER_MODE_ACTIONS } from "@matchframe/contracts";
import type { ProfileSet } from "@matchframe/cs2-state";
import type { MapRuntime } from "@matchframe/map-runtime";
import type { Pin, ScoredCandidate } from "./candidates.ts";
import { generateCandidates } from "./candidates.ts";
import { cinematicCandidates, PAUSE_HOLD_MS } from "./cinematics.ts";
import type { DirectorConfig } from "./config.ts";
import { mergeConfig } from "./config.ts";
import type { FreeSpace, TeamShot } from "./framing.ts";
import { frameTeam } from "./framing.ts";
import type { InteractionFeatures, SpatialContext } from "./features/interactions.ts";
import { computeInteractions } from "./features/interactions.ts";
import type { RoundContext } from "./features/significance.ts";
import { roundContext } from "./features/significance.ts";
import { StateHistory } from "./history.ts";
import { ShotPlanner } from "./planner.ts";
import type { ShotKey } from "./shots.ts";
import { parseShot, povShot } from "./shots.ts";
import type { UtilityOpportunity, UtilityScenarioRule } from "./utility/opportunities.ts";
import { findUtilityOpportunities, INFERNO_BOTTOM_BANANA_RULE } from "./utility/opportunities.ts";

/** How long after a cinematic is confirmed a player's view in the game data is taken as data from before the cut. */
export const CINEMATIC_SETTLE_MS = 600;
/** A team shot is framed again when the team's middle moved this far (units). */
const TEAM_MOVED = 150;

/** What the engine should do with a decision. The director never talks to the game directly. */
export interface DirectorIntent {
  kind: "select_player" | "activate_static_camera" | "play_camera_path" | "follow_player";
  /** Kind of shot (a static camera can be a nade camera, a fight overview, the bomb or an establishing shot). */
  shotClass: ShotClass;
  targetSteamId: string | null;
  /** select_player: the player's spectator number key (1–9, 0), for a keyboard or {slot} console command. */
  observerSlot: number | null;
  cameraId: string | null;
  /** The camera path for play_camera_path. */
  pathId?: string | null;
  plannedDurationMs: number | null;
  /** activate_static_camera: turn slowly while on air (degrees a second, positive to the left); 0 or absent: still. */
  panDegPerSec?: number | null;
  /**
   * activate_static_camera of a team shot (camera `team-T` / `team-CT`, not in the map pack): where the
   * camera glides from and to over the shot (the same point: still), looking at `focus`.
   */
  move?: { from: Vec3; to: Vec3; focus: Vec3 } | null;
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
  /** Players another observer shows right now (replay PC: the main PC's player), until a time. */
  avoid: { steamIds: string[]; until: number } | null;
  /** Clutch mode: in a 1vX, stay with the last player alive on their side; no cutaways to cameras. */
  clutchMode: boolean;
  /** Follow cams (needs the map's free-space grid): a free camera behind a running player in quiet moments. */
  followCams: boolean;
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
  /** The operator's Observer mode; null when only the editorial mode is set (tests, legacy callers): no scope restriction. */
  private observer: ObserverMode | null = null;
  private map: MapRuntime | undefined;
  private capabilities: SourceCapabilities | null = null;
  private readonly history = new StateHistory();
  private readonly planner: ShotPlanner;
  private scenarios: UtilityScenarioRule[];
  private readonly profiles: ProfileSet | undefined;
  private modelVersion: string | null;
  private readonly newId: () => string;
  private lastSequence = -1;
  private lastOutput: DirectorOutput | null = null;
  private lastEvalAt = -Infinity;
  /** When the current live round went live (monotonic ms), or null outside one. */
  private liveSince: number | null = null;
  /** Follow cams played on the current map. */
  private follows = { map: null as string | null, count: 0 };
  /** A pause (tactical or technical timeout) in this round's freeze time: held on one team's spawn until live. */
  private pause: { round: string | null; side: "T" | "CT" | null; since: number } | null = null;
  /** Team shots of this round, by side and still/gliding, with where the team stood when framed. */
  private teamShots: { round: string | null; shots: Map<string, { shot: TeamShot | null; at: { x: number; y: number }; when: number }> } = { round: null, shots: new Map() };
  readonly controls: DirectorControls = {
    hold: null,
    pin: null,
    oneSide: null,
    cinematicsDisabled: { round: null, map: null, match: false },
    autoReplaysDisabled: false,
    assistedActions: new Set<ActionClass>(["pov_cut"]),
    followActionRequested: false,
    cinematicRequested: false,
    avoid: null,
    clutchMode: false,
    followCams: false,
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

  get observerMode(): ObserverMode | null {
    return this.observer;
  }

  /** Off recommends only; the other modes direct automatically within their scope (see OBSERVER_MODE_ACTIONS). */
  setObserverMode(mode: ObserverMode): void {
    this.observer = mode;
    this.mode = mode === "off" ? "advisory" : "automatic";
  }

  /** What automation may do on its own; null = unrestricted (recommendations in advisory mode, or no Observer mode set). */
  get observerScope(): ReadonlySet<ActionClass> | null {
    if (this.observer === null || this.observer === "off" || (this.mode !== "automatic" && this.mode !== "assisted")) return null;
    return new Set(OBSERVER_MODE_ACTIONS[this.observer]);
  }

  setConfig(partial: Partial<DirectorConfig>): void {
    this.cfg = mergeConfig({ ...this.cfg, ...partial });
    this.planner.setConfig(this.cfg);
  }

  setScenarios(rules: UtilityScenarioRule[]): void {
    this.scenarios = rules;
  }

  get scenarioRules(): readonly UtilityScenarioRule[] {
    return this.scenarios;
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

  /** Prefer anyone but these players until `until` (another observer has them on air). */
  avoid(steamIds: string[], until: number): void {
    this.controls.avoid = steamIds.length ? { steamIds, until } : null;
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

  /**
   * A cinematic became active (confirmed by the controller). Freeze-time shots run their planned
   * length (their share of the freeze time, or a pause until live), follow cams up to their planned
   * length, other cameras up to `maxDurationMs`.
   */
  cinematicStarted(shot: ShotKey, at: number, plannedDurationMs: number, opportunityId: string | null, countsTowardBudget = true, shotClass: string | null = null): void {
    const kind = parseShot(shot).kind;
    const long = shotClass === "establishing" || shotClass === "camera_path";
    const maxMs = long ? Math.min(PAUSE_HOLD_MS, Math.max(this.cfg.cinematic.establishingMaxMs, plannedDurationMs)) : kind === "follow" ? Math.max(this.cfg.cinematic.maxDurationMs, plannedDurationMs) : this.cfg.cinematic.maxDurationMs;
    if (kind === "follow" && this.planner.activeCinematic?.shotKey !== shot) this.follows.count++;
    this.planner.cinematicStarted(shot, at, plannedDurationMs, opportunityId, countsTowardBudget, maxMs);
  }

  /**
   * A cinematic command failed or was never confirmed: it is not tried again this round (sending it
   * again would restart a path or a camera on air, over and over).
   */
  cinematicFailed(shot: ShotKey): void {
    this.planner.cinematicFailed(shot);
  }

  /** Follow cam material now: while this map's follow cams are used up, only the one on air (so it finishes). */
  private followableNow(state: MatchState): { steamId: string; speed: number; alone: boolean }[] {
    const all = this.followable(state);
    if (this.follows.count < this.cfg.cinematic.followPerMap) return all;
    const cur = parseShot(this.planner.shot);
    return cur.kind === "follow" ? all.filter((f) => f.steamId === cur.id) : [];
  }

  /** Moving players with their speed, and whether a teammate is near (follow cam material). */
  private followable(state: MatchState): { steamId: string; speed: number; alone: boolean }[] {
    const out: { steamId: string; speed: number; alone: boolean }[] = [];
    const alive = state.players.filter((p) => p.lifeState === "alive" && p.position && p.side);
    for (const p of alive) {
      const v = this.history.velocity(p.steamId);
      if (!v) continue;
      const alone = !alive.some((m) => m !== p && m.side === p.side && Math.hypot(m.position!.x - p.position!.x, m.position!.y - p.position!.y) < 1000);
      out.push({ steamId: p.steamId, speed: Math.hypot(v.x, v.y), alone });
    }
    return out;
  }

  private cinematicsAllowed(state: MatchState, round?: RoundContext): { allowed: boolean; reason: ReasonCode | null } {
    // Mid-clutch, a camera would cut away from the player the whole round is about.
    if (this.controls.clutchMode && round?.clutch) return { allowed: false, reason: "CLUTCH" };
    const d = this.controls.cinematicsDisabled;
    if (!this.cfg.cinematic.enabled || d.match || (d.map !== null && d.map === state.mapName) || (d.round !== null && d.round === state.roundAttemptId)) {
      return { allowed: false, reason: "CINEMATIC_DISABLED" };
    }
    if (this.planner.cinematicBudgetLeft() <= 0 && !this.controls.cinematicRequested) return { allowed: false, reason: "CINEMATIC_BUDGET_EXHAUSTED" };
    return { allowed: true, reason: null };
  }

  /**
   * A tactical or technical pause during freeze time: noted for the rest of this round's freeze time
   * (the camera stays on the pause shot until the round goes live, also after the pause ends).
   */
  private notePause(state: MatchState, now: number): void {
    if (state.roundPhase !== "freezetime") {
      this.pause = null;
      return;
    }
    if (this.pause && this.pause.round !== state.roundAttemptId) this.pause = null;
    const g = state.gamePhase;
    const pausedNow = state.paused || g === "timeout_t" || g === "timeout_ct" || g === "paused";
    if (!pausedNow || this.pause) return;
    this.pause = { round: state.roundAttemptId, side: g === "timeout_t" ? "T" : g === "timeout_ct" ? "CT" : null, since: now };
  }

  /**
   * A team's shot this round (see frameTeam): framed once (players can't move in freeze time) and
   * framed again when the team's middle moved (the first game data of a round can be from before
   * the respawn) or, when no spot worked, a second later.
   */
  private teamShot(state: MatchState, space: FreeSpace, side: "T" | "CT", still: boolean, now: number): TeamShot | null {
    if (this.teamShots.round !== state.roundAttemptId) this.teamShots = { round: state.roundAttemptId, shots: new Map() };
    const team = state.players.filter((p) => p.side === side && p.lifeState === "alive" && p.position);
    if (team.length < 2) return null;
    const at = { x: team.reduce((s, p) => s + p.position!.x, 0) / team.length, y: team.reduce((s, p) => s + p.position!.y, 0) / team.length };
    const key = `${side}:${still ? "still" : "glide"}`;
    const cached = this.teamShots.shots.get(key);
    if (cached && Math.hypot(cached.at.x - at.x, cached.at.y - at.y) < TEAM_MOVED && (cached.shot || now - cached.when < 1000)) return cached.shot;
    const others = state.players.filter((p) => p.side !== side && p.lifeState === "alive" && p.position).map((p) => p.position!);
    const shot = frameTeam(
      team.map((p) => ({ steamId: p.steamId, position: p.position!, forward: p.forward ?? null })),
      space,
      { still, others },
    );
    this.teamShots.shots.set(key, { shot, at, when: now });
    return shot;
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
    // window returns the previous output, without its intent: that was acted on already (sending
    // it again re-sent the same camera, or restarted a path on air, right after it was confirmed).
    const minInterval = 1000 / this.cfg.maxAnalysisHz;
    if (this.lastOutput && state.sequence === this.lastSequence && now - this.lastEvalAt < minInterval && !this.controls.followActionRequested) {
      return this.lastOutput.intent ? { ...this.lastOutput, intent: null } : this.lastOutput;
    }
    this.lastEvalAt = now;
    this.lastSequence = state.sequence;
    if (this.controls.hold?.until !== null && this.controls.hold?.until !== undefined && now >= this.controls.hold.until) this.controls.hold = null;

    this.history.push(state);
    if (state.roundPhase !== "live") this.liveSince = null;
    else this.liveSince ??= now;
    if (this.follows.map !== state.mapName) this.follows = { map: state.mapName, count: 0 };
    this.planner.setRound(state.roundAttemptId);
    this.notePause(state, now);
    const observed: ShotKey | null = state.observer.observedSteamId ? povShot(state.observer.observedSteamId) : null;
    // Keep the planner on a confirmed cinematic; otherwise follow observed POV feedback. Just after a
    // cinematic is confirmed (the console confirms a camera at once), game data from before the cut
    // can still show the old player: that doesn't end the shot.
    const activeCine = this.planner.activeCinematic;
    const settling = !!activeCine && now - activeCine.startedAt < CINEMATIC_SETTLE_MS;
    if (!(activeCine && (state.observer.cameraMode === "roaming" || settling))) this.planner.observeShot(observed, now);

    const map = this.map && this.map.mapName === state.mapName ? this.map : undefined;
    const grid = map?.grid ?? null;
    const spatial: SpatialContext | undefined = map ? { levelAt: (p) => map.levelAt(p), regionsAt: (p) => map.regionsAt(p), hasVisibilityGeometry: !!grid, ...(grid ? { lineOfSight: (a: Vec3, b: Vec3) => grid.lineOfSight(a, b) } : {}) } : undefined;
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
    const scope = this.observerScope;
    const cinematicsAllowed = this.cinematicsAllowed(state, round);
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
      cinematicsAllowed,
      map,
      scope,
      avoid: this.controls.avoid && this.controls.avoid.until > now ? new Set(this.controls.avoid.steamIds) : null,
      clutchMode: this.controls.clutchMode,
    });
    if (scope?.has("cinematic")) {
      candidates.push(...cinematicCandidates({ state, now, cfg: this.cfg, currentShot: this.planner.shot, interactions, round, capabilities: this.capabilities, pin: this.controls.pin, oneSide: this.controls.oneSide, cinematicsAllowed, map, followable: this.controls.followCams && grid ? this.followableNow(state) : undefined, currentShotSinceMs: this.planner.shotSince, shownThisRound: this.planner.cinematicsShownThisRound, sight: grid ? (a, b) => grid.lineOfSight(a, b) : undefined, liveForMs: this.liveSince === null ? null : now - this.liveSince, pause: this.pause, teamShot: grid && state.roundPhase === "freezetime" ? (side, still) => this.teamShot(state, grid, side, still, now) : undefined }));
      candidates.sort((a, b) => b.utility - a.utility);
    }

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
    const desiredClass: ActionClass | null = desired ? actionClassOfShot(desired.shotClass) : null;
    const executable =
      plan.action === "cut" &&
      desired !== null &&
      desiredClass !== null &&
      health === "armed" &&
      !control.pendingCommand &&
      ((this.mode === "automatic" && (!scope || scope.has(desiredClass))) ||
        (this.mode === "assisted" &&
          (!scope || scope.has(desiredClass)) &&
          (this.controls.assistedActions.has(desiredClass) || (desiredClass === "utility_camera" && this.controls.assistedActions.has("cinematic")))));

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
              shotClass: desired.shotClass,
              targetSteamId: shot.id,
              observerSlot: target?.observerKey ?? null,
              cameraId: null,
              plannedDurationMs: null,
              opportunityId: null,
              decisionId,
              basedOnSequence: state.sequence,
              expiresInMs: 450,
            }
          : shot.kind === "follow"
            ? {
                kind: "follow_player",
                shotClass: desired.shotClass,
                targetSteamId: shot.id,
                observerSlot: null,
                cameraId: null,
                plannedDurationMs: desired.plannedDurationMs,
                opportunityId: null,
                decisionId,
                basedOnSequence: state.sequence,
                expiresInMs: 450,
              }
          : shot.kind === "path"
            ? {
                kind: "play_camera_path",
                shotClass: desired.shotClass,
                targetSteamId: null,
                observerSlot: null,
                cameraId: null,
                pathId: shot.id,
                plannedDurationMs: desired.plannedDurationMs,
                opportunityId: null,
                decisionId,
                basedOnSequence: state.sequence,
                expiresInMs: 450,
              }
            : {
                kind: "activate_static_camera",
                shotClass: desired.shotClass,
                targetSteamId: null,
                observerSlot: null,
                cameraId: shot.id,
                plannedDurationMs: desired.plannedDurationMs,
                panDegPerSec: desired.panDegPerSec ?? 0,
                move: desired.framing ?? null,
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
