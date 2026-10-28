import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { CameraPath, CameraRecord, DirectorDecision, DirectorMode, MatchState, ObserverMode, ReasonCode, Side, SourceCapabilities } from "@matchframe/contracts";
import { emptySourceCapabilities } from "@matchframe/contracts";
import type { DerivedEvent, GsiObservation, IngestResult, ProfileSet, UtilityTrackerEvent } from "@matchframe/cs2-state";
import { CapabilitySampler, hash53, MatchStateStore, normalizeGsi, parseGsiPayload, stripAuth } from "@matchframe/cs2-state";
import type { ArbiterEvent, ControlCapabilities, DirectorOutput, ObserverControlAdapter, Pin, PlayerView } from "@matchframe/director-policy";
import { cameraShot, chaseMoment, ControlArbiter, Director, parseShot, pathShot, povShot } from "@matchframe/director-policy";
import type { MapRegistry } from "@matchframe/map-runtime";
import type { Logger } from "../logger.ts";
import type { LiveContactModel } from "./model-runtime.ts";
import { ShadowComparison } from "./model-runtime.ts";

export interface SessionEvents {
  state: [MatchState];
  decision: [DirectorDecision];
  events: [DerivedEvent[]];
  utility: [UtilityTrackerEvent[]];
  arbiter: [ArbiterEvent];
  capabilities: [SourceCapabilities];
  alert: [{ level: "info" | "warn" | "error"; code: string; message: string }];
}

export interface RosterResolver {
  (steamId: string): { playerId: string; teamId: string | null; displayName: string | null } | null;
}

export interface LiveSessionOptions {
  logger: Logger;
  maps: MapRegistry;
  now: () => number;
  resolveRoster?: RosterResolver;
  /** Capability evidence recorded by real setup tests (e.g. confirmed player selection). */
  verifiedControl?: () => Partial<Record<keyof ControlCapabilities, { support: "supported" | "partial"; build: string | null; at: string }>>;
  /**
   * Evidence that a kind of control works, seen in live use (the game data showed the requested
   * player after a switch). The engine records it per game build, like the setup tests.
   */
  recordEvidence?: (key: keyof ControlCapabilities, support: "supported" | "partial", detail: string) => void;
  /** The third-person chase view for plants, defuses and round wins (default on). */
  chaseEnabled?: () => boolean;
  simulated?: boolean;
  /** Per-type utility profiles (measured where available, defaults otherwise). */
  utilityProfiles?: ProfileSet;
  /**
   * Consulted only when automatic direction is armed (resume, or choosing an Observer mode while
   * armed). It never stops automation that is already running.
   */
  armGate?: (simulated: boolean, observerMode: ObserverMode) => { ok: true } | { ok: false; code: string; reason: string };
}

export interface IngestOutcome {
  accepted: boolean;
  reason: IngestResult["reason"] | "invalid";
  error?: string;
}

const MAX_EVENT_LOG = 2000;

/**
 * One authoritative live match session. Telemetry flows in through `ingestGsi`; the director
 * evaluates on fresh state; only the control arbiter writes to the observer.
 */
export class LiveSession extends EventEmitter<SessionEvents> {
  sessionId: string;
  readonly director: Director;
  readonly arbiter: ControlArbiter;
  private store: MatchStateStore;
  private sampler: CapabilitySampler | null = null;
  private samplerSourceId: string | null = null;
  private controlCaps: ControlCapabilities | null = null;
  private caps: SourceCapabilities = emptySourceCapabilities();
  private lastState: MatchState | null = null;
  private lastOutput: DirectorOutput | null = null;
  private readonly eventLog: DerivedEvent[] = [];
  private readonly utilityLog: UtilityTrackerEvent[] = [];
  readonly decisionLog: DirectorDecision[] = [];
  private lastEvaluatedSequence = -1;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private pendingCinematic: { commandId: string; shot: string; plannedDurationMs: number; opportunityId: string | null; countsTowardBudget: boolean } | null = null;
  /** Freeze-time establishing shots (static or a camera path) don't use the round's cinematic budget. */
  private static readonly OFF_BUDGET = new Set(["establishing", "camera_path"]);
  /** The chase view and first person each last at least this long. */
  private static readonly CHASE_MIN_MS = 1500;
  private view: PlayerView = "in_eye";
  private viewTarget: string | null = null;
  private viewSince = 0;
  private chaseBlockedUntil = 0;
  private stats = { packets: 0, rejected: 0, invalid: 0, cuts: 0, recommendations: 0, ingestMsTotal: 0, evalMsTotal: 0, evals: 0, maxIngestMs: 0, maxEvalMs: 0 };
  private ingestSamples: number[] = [];
  private evalSamples: number[] = [];
  /** Optional learned model, evaluated in shadow only (never drives the camera). */
  private shadowModel: LiveContactModel | null = null;
  shadow = new ShadowComparison();
  private lastShadowAt = -Infinity;

  constructor(private readonly opts: LiveSessionOptions) {
    super();
    this.sessionId = `session_${randomUUID().slice(0, 8)}`;
    this.store = this.makeStore();
    this.director = new Director();
    this.director.setObserverMode("off");
    this.arbiter = new ControlArbiter({
      now: opts.now,
      newId: () => `cmd_${randomUUID().slice(0, 12)}`,
      onEvent: (e) => this.onArbiterEvent(e),
    });
    this.arbiter.setTimeline(this.sessionId, 0);
  }

  private makeStore(): MatchStateStore {
    return new MatchStateStore({
      sessionId: this.sessionId,
      ...(this.opts.resolveRoster ? { resolveRoster: this.opts.resolveRoster } : {}),
      mapContextFor: (name) => this.opts.maps.get(name),
      simulated: this.opts.simulated ?? false,
      ...(this.opts.utilityProfiles ? { tracker: { profiles: this.opts.utilityProfiles } } : {}),
    });
  }

  /** Starts a fresh session (new match/map): new ids, state, sampler; automation disarmed. */
  restart(simulated = this.opts.simulated ?? false): void {
    this.opts.simulated = simulated;
    this.sessionId = `session_${randomUUID().slice(0, 8)}`;
    this.store = this.makeStore();
    this.sampler = null;
    this.samplerSourceId = null;
    this.lastState = null;
    this.lastOutput = null;
    this.lastEvaluatedSequence = -1;
    this.eventLog.length = 0;
    this.utilityLog.length = 0;
    this.arbiter.takeover("session-restart");
    this.arbiter.setTimeline(this.sessionId, 0);
    this.director.observeShot(null, this.opts.now());
  }

  get simulated(): boolean {
    return this.opts.simulated ?? false;
  }

  async setAdapter(adapter: ObserverControlAdapter | null): Promise<void> {
    const prev = this.arbiter.getAdapter();
    this.arbiter.setAdapter(adapter);
    if (prev && prev !== adapter) await prev.dispose().catch(() => undefined);
    await this.refreshControlCapabilities();
  }

  async refreshControlCapabilities(): Promise<void> {
    const adapter = this.arbiter.getAdapter();
    this.controlCaps = adapter ? await adapter.getCapabilities() : null;
    const verified = this.opts.verifiedControl?.() ?? {};
    if (this.controlCaps && !adapter?.simulated) {
      for (const [k, v] of Object.entries(verified)) {
        const key = k as keyof ControlCapabilities;
        const cur = this.controlCaps[key];
        if (cur && cur.support === "unverified") {
          this.controlCaps[key] = { ...cur, support: v.support, testedGameBuild: v.build, lastVerifiedAt: v.at, limitations: [...cur.limitations.filter((l) => !l.includes("verify")), "verified by setup checklist"] };
        }
      }
    }
    this.recomputeCapabilities();
  }

  private recomputeCapabilities(): void {
    const telemetry = this.sampler?.report() ?? emptySourceCapabilities();
    this.caps = { ...telemetry, ...(this.controlCaps ?? {}) };
    this.director.setCapabilities(this.caps);
    this.emit("capabilities", this.caps);
  }

  capabilities(): SourceCapabilities {
    return this.caps;
  }

  samplerSummary(): Record<string, unknown> | null {
    return this.sampler?.summary() ?? null;
  }

  state(): MatchState | null {
    return this.lastState;
  }

  stateAt(now: number): MatchState {
    return this.store.snapshot(now);
  }

  output(): DirectorOutput | null {
    return this.lastOutput;
  }

  recentEvents(limit = 200): DerivedEvent[] {
    return this.eventLog.slice(-limit);
  }

  recentUtilityEvents(limit = 200): UtilityTrackerEvent[] {
    return this.utilityLog.slice(-limit);
  }

  metrics(): Record<string, number | null> {
    const p95 = (xs: number[]) => {
      if (xs.length === 0) return null;
      const s = [...xs].sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!;
    };
    return {
      packets: this.stats.packets,
      rejected: this.stats.rejected,
      invalid: this.stats.invalid,
      cuts: this.stats.cuts,
      recommendations: this.stats.recommendations,
      ingestP95Ms: p95(this.ingestSamples),
      evalP95Ms: p95(this.evalSamples),
      maxIngestMs: this.stats.maxIngestMs,
      maxEvalMs: this.stats.maxEvalMs,
    };
  }

  /** GSI ingest (after authentication by the server). Returns quickly; never throws on bad input. */
  ingestGsi(raw: unknown, sourceId: string, receivedAtMonotonicMs: number, rawText: string): IngestOutcome {
    const t0 = performance.now();
    const parsed = parseGsiPayload(raw);
    if (!parsed.ok) {
      this.stats.invalid++;
      return { accepted: false, reason: "invalid", error: parsed.error };
    }
    const payload = stripAuth(parsed.payload);
    const obs: GsiObservation = normalizeGsi(payload, { sourceId, receivedAtMonotonicMs, payloadHash: hash53(rawText.replace(/"auth"\s*:\s*\{[^}]*\}/, "")) });
    if (!this.sampler || this.samplerSourceId !== sourceId) {
      if (!this.sampler) {
        this.sampler = new CapabilitySampler(sourceId);
        this.samplerSourceId = sourceId;
      }
    }
    if (this.samplerSourceId === sourceId) this.sampler.observe(obs, new Date().toISOString());
    const result = this.store.ingest(obs);
    this.stats.packets++;
    if (!result.accepted) {
      this.stats.rejected++;
      return { accepted: false, reason: result.reason };
    }
    const prev = this.lastState;
    const state = this.store.snapshot(receivedAtMonotonicMs);
    this.lastState = state;
    this.shadowModel?.observe(state);
    if (result.epochChanged) this.arbiter.setTimeline(this.sessionId, state.epoch);
    const observedPlayer = state.observer.observedSteamId ? state.players.find((p) => p.steamId === state.observer.observedSteamId) : undefined;
    this.arbiter.getAdapter()?.noteObserverState?.({ ...state.observer, observedPosition: observedPlayer?.position ?? null });
    // Observer feedback: confirms commands, detects human POV changes vs game auto-switch.
    const prevObserved = prev?.observer.observedSteamId ?? null;
    const prevTargetDied = prevObserved !== null && state.players.find((p) => p.steamId === prevObserved)?.lifeState === "dead";
    this.arbiter.observe(state.observer, { previousTargetDied: prevTargetDied, activeCinematic: this.director.shotPlanner.activeCinematic?.shotKey ?? null });
    if (result.events.length > 0) {
      for (const e of result.events) this.eventLog.push(e);
      if (this.eventLog.length > MAX_EVENT_LOG) this.eventLog.splice(0, this.eventLog.length - MAX_EVENT_LOG);
      this.emit("events", result.events);
      for (const e of result.events) {
        if (e.kind === "player_died" && prevObserved !== null && e.data.steamId !== prevObserved) {
          // A fight resolved near the current shot: allow a short explanatory hold.
          this.director.shotPlanner.notePostEvent(receivedAtMonotonicMs);
        }
      }
    }
    if (result.utilityEvents.length > 0) {
      for (const e of result.utilityEvents) this.utilityLog.push(e);
      if (this.utilityLog.length > MAX_EVENT_LOG) this.utilityLog.splice(0, this.utilityLog.length - MAX_EVENT_LOG);
      this.emit("utility", result.utilityEvents);
    }
    if (this.stats.packets % 20 === 1) this.recomputeCapabilities();
    const ingestMs = performance.now() - t0;
    this.track(this.ingestSamples, ingestMs);
    this.stats.maxIngestMs = Math.max(this.stats.maxIngestMs, ingestMs);
    this.emit("state", state);
    this.evaluate();
    return { accepted: true, reason: "ok" };
  }

  private track(arr: number[], v: number): void {
    arr.push(v);
    if (arr.length > 2000) arr.shift();
  }

  private inputFresh(now: number): boolean {
    const s = this.lastState;
    if (!s || s.sequence === 0) return false;
    return now - s.time.receivedAtMonotonicMs <= this.director.config.maxInputAgeMs;
  }

  /** Director evaluation + execution through the arbiter (only when allowed). */
  evaluate(): void {
    const s = this.lastState;
    if (!s) return;
    const now = this.opts.now();
    const t0 = performance.now();
    const pending = this.arbiter.pending();
    const output = this.director.evaluate(this.store.snapshot(now), now, {
      ownership: this.arbiter.state(),
      adapterAvailable: !!this.arbiter.getAdapter() && this.arbiter.getAdapter()!.kind !== "none",
      inputFresh: this.inputFresh(now),
      pendingCommand: !!pending && (pending.status === "sent" || pending.status === "transport_acknowledged" || pending.status === "pending"),
    });
    const evalMs = performance.now() - t0;
    this.track(this.evalSamples, evalMs);
    this.stats.maxEvalMs = Math.max(this.stats.maxEvalMs, evalMs);
    this.lastOutput = output;
    if (output.decision.decisionId !== this.decisionLog[this.decisionLog.length - 1]?.decisionId) {
      this.decisionLog.push(output.decision);
      if (this.decisionLog.length > 1000) this.decisionLog.shift();
      if (output.decision.action === "recommend") this.stats.recommendations++;
      this.emit("decision", output.decision);
    }
    this.lastEvaluatedSequence = s.sequence;
    if (this.shadowModel && now - this.lastShadowAt >= 250) {
      this.lastShadowAt = now;
      this.shadow.record(now, s.roundNumber, this.shadowModel.predict(s, output.interactions));
    }
    const intent = output.intent;
    if (!intent) this.presentChase(now);
    if (!intent || this.director.currentMode === "shadow") return;
    if (intent.kind === "select_player") {
      const sel = this.caps.playerSelectionControl.support;
      if (sel !== "supported" && sel !== "partial") {
        this.alertOnce("player_selection_unverified", "warn", "Automatic POV cuts are blocked: player selection control is not verified. Run the setup checklist test.");
        return;
      }
      this.stats.cuts++;
      this.noteView(intent.targetSteamId!, "in_eye", now);
      void this.arbiter.submit(
        { kind: "select_player", steamId: intent.targetSteamId!, observerSlot: intent.observerSlot },
        { owner: "director", decisionId: intent.decisionId, basedOnSequence: intent.basedOnSequence, expiresInMs: intent.expiresInMs },
      );
    } else if (intent.kind === "activate_static_camera") {
      const cam = this.findCamera(intent.cameraId!);
      if (!cam) return;
      this.stats.cuts++;
      void this.arbiter
        .submit({ kind: "activate_static_camera", camera: cam, plannedDurationMs: intent.plannedDurationMs ?? 2000 }, { owner: "director", decisionId: intent.decisionId, basedOnSequence: intent.basedOnSequence, expiresInMs: intent.expiresInMs })
        .then((r) => {
          if (r.status !== "failed" && r.status !== "cancelled") {
            this.pendingCinematic = { commandId: r.commandId, shot: cameraShot(cam.id), plannedDurationMs: intent.plannedDurationMs ?? 2000, opportunityId: intent.opportunityId, countsTowardBudget: !LiveSession.OFF_BUDGET.has(intent.shotClass) };
          }
        });
    } else if (intent.kind === "play_camera_path") {
      const path = this.findPath(intent.pathId ?? "");
      if (!path) return;
      this.stats.cuts++;
      void this.arbiter
        .submit({ kind: "play_camera_path", path }, { owner: "director", decisionId: intent.decisionId, basedOnSequence: intent.basedOnSequence, expiresInMs: intent.expiresInMs, confirmationTimeoutMs: 2500 })
        .then((r) => {
          if (r.status !== "failed" && r.status !== "cancelled") {
            this.pendingCinematic = { commandId: r.commandId, shot: pathShot(path.id), plannedDurationMs: intent.plannedDurationMs ?? 4000, opportunityId: null, countsTowardBudget: !LiveSession.OFF_BUDGET.has(intent.shotClass) };
          }
        });
    }
  }

  findPath(pathId: string): CameraPath | undefined {
    for (const rt of this.opts.maps.list()) {
      const p = rt.pack.paths.find((x) => x.id === pathId);
      if (p) return p;
    }
    return undefined;
  }

  private alerted = new Map<string, number>();
  private alertOnce(code: string, level: "info" | "warn" | "error", message: string): void {
    const now = this.opts.now();
    const last = this.alerted.get(code) ?? -Infinity;
    if (now - last < 30000) return;
    this.alerted.set(code, now);
    this.emit("alert", { level, code, message });
  }

  findCamera(cameraId: string): CameraRecord | undefined {
    for (const rt of this.opts.maps.list()) {
      const c = rt.pack.cameras.find((x) => x.id === cameraId);
      if (c) return c;
    }
    return undefined;
  }

  private onArbiterEvent(e: ArbiterEvent): void {
    if (e.kind === "result" && e.detail.status === "confirmed" && e.detail.precision === "observed_exact") {
      // The game data showed the requested player: player selection works on this build.
      const f = this.arbiter.pending();
      const adapter = this.arbiter.getAdapter();
      if (f && f.context.commandId === e.detail.commandId && f.request.kind === "select_player" && adapter && !adapter.simulated && this.caps.playerSelectionControl.support !== "supported") {
        this.opts.recordEvidence?.("playerSelectionControl", "supported", `the game data showed the requested player (${f.request.steamId})`);
      }
    }
    if (e.kind === "result" && e.detail.status === "confirmed" && this.pendingCinematic && e.detail.commandId === this.pendingCinematic.commandId) {
      this.director.cinematicStarted(this.pendingCinematic.shot, this.opts.now(), this.pendingCinematic.plannedDurationMs, this.pendingCinematic.opportunityId, this.pendingCinematic.countsTowardBudget);
      this.pendingCinematic = null;
    }
    if (e.kind === "external_change") this.alertOnce("external_takeover", "warn", "Observer POV changed outside Matchframe: manual takeover engaged. Resume automation explicitly when ready.");
    if (e.kind === "takeover" || e.kind === "emergency_stop") this.pendingCinematic = null;
    this.emit("arbiter", e);
  }

  start(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.tick(), 100);
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  /** Periodic work: staleness, arbiter timeouts/countdowns, time-based director transitions. */
  tick(): void {
    const now = this.opts.now();
    const stale = this.store.checkStale(now);
    this.arbiter.tick();
    if (stale && this.lastState) {
      const pending = this.arbiter.pending();
      if (pending && (pending.status === "sent" || pending.status === "transport_acknowledged") && pending.context.owner === "director") {
        // Unsafe to keep automated work in flight on stale telemetry.
        this.arbiter.takeover("stale-telemetry-guard", "operator");
        this.alertOnce("stale_telemetry", "error", "Telemetry is stale: automated control stopped (manual). Check the GSI connection.");
      }
    }
    if (this.lastState && (this.director.shotPlanner.activeCinematic || this.lastState.sequence !== this.lastEvaluatedSequence)) this.evaluate();
  }

  // ---- operator controls (all audited by the API layer) ----------------------------------

  get observerMode(): ObserverMode {
    return this.director.observerMode ?? "off";
  }

  /**
   * The operator's Observer mode. Choosing a mode while automation is armed checks the gate for that
   * mode (Full Action Observer is a plan feature); the current mode keeps running if it is refused.
   */
  setObserverMode(mode: ObserverMode): void {
    const armedOrArming = this.arbiter.automationAllowed || this.arbiter.resumePendingInMs() !== null;
    if (armedOrArming && mode !== "off" && mode !== this.observerMode) this.checkArmGate(mode);
    this.director.setObserverMode(mode);
  }

  /**
   * Editorial mode (API compatibility): automatic/assisted keep the current Observer mode, or choose
   * Observer when it is Off; other modes switch the Observer off.
   */
  setMode(mode: DirectorMode): void {
    if (mode === "automatic" || mode === "assisted") {
      const observer = this.observerMode === "off" ? "observer" : this.observerMode;
      this.setObserverMode(observer);
      this.director.setMode(mode);
      return;
    }
    this.director.setObserverMode("off");
    this.director.setMode(mode);
  }

  /** Whether automatic direction may run in an Observer mode (account, plan, hours); see `armGate`. */
  gateFor(mode: ObserverMode): { ok: true } | { ok: false; code: string; reason: string } {
    return this.opts.armGate?.(this.simulated, mode) ?? { ok: true };
  }

  /** Arms automatic direction in an Observer mode: the director owns the camera from now on. Throws (HTTP 402) like `resume`. */
  armAutomatic(mode: Exclude<ObserverMode, "off">): void {
    this.checkArmGate(mode);
    this.director.setObserverMode(mode);
    this.arbiter.resumeAutomation(0);
  }

  /** Throws (HTTP 402) when automatic direction may not be armed; see `armGate`. */
  private checkArmGate(mode: ObserverMode = this.observerMode): void {
    const g = this.opts.armGate?.(this.simulated, mode);
    if (g && !g.ok) throw Object.assign(new Error(g.reason), { status: 402, code: g.code });
  }

  hold(durationMs: number | null): void {
    this.director.hold(durationMs, this.opts.now());
  }

  releaseHold(): void {
    this.director.releaseHold();
  }

  pin(pin: Pin | null): void {
    this.director.pin(pin);
  }

  setOneSide(side: Side | null): void {
    this.director.setOneSide(side);
  }

  followAction(): void {
    this.director.followAction();
    this.evaluate();
  }

  requestCinematic(): void {
    this.director.requestCinematic();
    this.evaluate();
  }

  disableCinematics(scope: "round" | "map" | "match", disabled: boolean): void {
    this.director.disableCinematics(scope, this.lastState, disabled);
  }

  async manualSelectPlayer(steamId: string, holder: string, owner: "operator" | "device" | "remote" = "operator", view: PlayerView = "in_eye") {
    const p = this.lastState?.players.find((x) => x.steamId === steamId);
    if (!p) throw Object.assign(new Error("unknown player"), { status: 404 });
    if (view === "chase" && !this.arbiter.getAdapter()?.supportsChase) throw Object.assign(new Error("this camera control can't show the chase view"), { status: 409 });
    this.noteView(steamId, view, this.opts.now());
    return this.arbiter.submit({ kind: "select_player", steamId, observerSlot: p.observerSlot, view }, { owner, holder, expiresInMs: 1500 });
  }

  private noteView(steamId: string, view: PlayerView, now: number): void {
    if (steamId !== this.viewTarget || view !== this.view) this.viewSince = now;
    this.viewTarget = steamId;
    this.view = view;
  }

  /**
   * The third-person chase view for the moments that suit it (chaseMoment: a plant, a defuse, a round
   * the player's team won), on the player the director is already showing, and back to first person
   * after. Only while the director owns the camera, never during a cinematic, at most one view change
   * per CHASE_MIN_MS.
   */
  private presentChase(now: number): void {
    const s = this.lastState;
    const adapter = this.arbiter.getAdapter();
    if (!s || !adapter?.supportsChase || this.director.currentMode !== "automatic" || !this.arbiter.automationAllowed) return;
    if (this.director.shotPlanner.activeCinematic || now < this.chaseBlockedUntil) return;
    const pending = this.arbiter.pending();
    if (pending && (pending.status === "pending" || pending.status === "sent" || pending.status === "transport_acknowledged")) return;
    const id = s.observer.observedSteamId;
    if (!id) return;
    if (id !== this.viewTarget) {
      // The game moved on (after a death, or a pick in CS2) and keeps the view it had: free to change it now.
      this.viewTarget = id;
      this.viewSince = 0;
    }
    const want: PlayerView = this.opts.chaseEnabled?.() !== false && chaseMoment(s) ? "chase" : "in_eye";
    if (want === this.view || now - this.viewSince < LiveSession.CHASE_MIN_MS) return;
    const p = s.players.find((x) => x.steamId === id);
    const before = this.view;
    this.noteView(id, want, now);
    void this.arbiter.submit({ kind: "select_player", steamId: id, observerSlot: p?.observerSlot ?? null, view: want }, { owner: "director", expiresInMs: 1500 }).then((r) => {
      if (r.status === "failed" || r.status === "cancelled") {
        this.view = before;
        this.chaseBlockedUntil = this.opts.now() + 5000;
      }
    });
  }

  async manualCamera(cameraId: string, holder: string, plannedDurationMs = 3000) {
    const cam = this.findCamera(cameraId);
    if (!cam) throw Object.assign(new Error("unknown camera"), { status: 404 });
    return this.arbiter.submit({ kind: "activate_static_camera", camera: cam, plannedDurationMs }, { owner: "operator", holder, expiresInMs: 1500 });
  }

  /** RETURN LIVE for the observer: exit any cinematic to the best POV (manual action). */
  async returnToPov(holder: string) {
    const best = this.lastOutput?.candidates.find((c) => c.valid && parseShot(c.shotKey).kind === "pov");
    if (!best?.targetSteamId) return null;
    return this.manualSelectPlayer(best.targetSteamId, holder);
  }

  setShadowModel(model: LiveContactModel | null): void {
    this.shadowModel = model;
    this.shadow = new ShadowComparison();
  }

  get shadowModelId(): string | null {
    return this.shadowModel?.id ?? null;
  }

  takeover(holder: string): void {
    this.arbiter.takeover(holder);
  }

  resume(countdownMs: number): void {
    const mode = this.director.currentMode;
    if (mode === "automatic" || mode === "assisted") this.checkArmGate();
    this.arbiter.resumeAutomation(countdownMs);
  }

  cancelResume(): void {
    this.arbiter.cancelResume();
  }

  async emergencyStop(): Promise<void> {
    await this.arbiter.emergencyStop();
    if (this.director.currentMode === "automatic" || this.director.currentMode === "assisted") this.director.setObserverMode("off");
  }

  clearEmergencyStop(): void {
    this.arbiter.clearEmergencyStop();
  }

  currentShotKey(): string | null {
    const s = this.lastState;
    if (!s) return null;
    return s.observer.observedSteamId ? povShot(s.observer.observedSteamId) : (this.director.shotPlanner.activeCinematic?.shotKey ?? (s.observer.cameraMode === "roaming" ? "roaming" : null));
  }

  reasonsSummary(): ReasonCode[] {
    return this.lastOutput?.decision.reasonCodes ?? [];
  }
}
