import type {
  CameraPath,
  CameraRecord,
  CommandContext,
  CommandResult,
  ControllerOwner,
  ObserverState,
  OwnershipState,
} from "@matchframe/contracts";
import type { ShotKey } from "../shots.ts";
import { cameraShot, parseShot, pathShot, povShot } from "../shots.ts";
import type { ObserverControlAdapter, PlayerView, PoseStream } from "./adapter.ts";
import { failedResult } from "./adapter.ts";

export type ControlRequest =
  | { kind: "select_player"; steamId: string; observerSlot: number | null; view?: PlayerView }
  | { kind: "activate_static_camera"; camera: CameraRecord; plannedDurationMs: number }
  | { kind: "play_camera_path"; path: CameraPath }
  /** A free camera flown along live poses; `shot` is its shot key (e.g. follow:<steamId>). */
  | { kind: "stream_camera"; shot: ShotKey; poses: PoseStream; durationMs: number }
  | { kind: "cancel_path" };

export interface SubmitOptions {
  owner: Exclude<ControllerOwner, "none">;
  holder?: string;
  decisionId?: string | null;
  basedOnSequence?: number | null;
  expiresInMs?: number;
  confirmationTimeoutMs?: number;
}

export interface InFlight {
  context: CommandContext;
  request: ControlRequest;
  expectedShot: ShotKey | null;
  status: CommandResult["status"];
  retries: number;
  result: CommandResult | null;
  observedPrecisionAvailable: boolean;
}

export interface ArbiterEvent {
  kind: "command" | "result" | "takeover" | "resume" | "emergency_stop" | "cleared" | "rejected" | "external_change" | "game_autoswitch";
  at: number;
  detail: Record<string, unknown>;
}

export interface ArbiterOptions {
  now: () => number;
  newId: () => string;
  /** Default command expiry relative to issue time. */
  defaultExpiresInMs?: number;
  defaultConfirmationTimeoutMs?: number;
  maxRetries?: number;
  /** Grace period after a confirmed command during which feedback jitter is not a takeover. */
  feedbackGraceMs?: number;
  onEvent?: (e: ArbiterEvent) => void;
}

/**
 * One authoritative camera writer per observer (spec §11.5, §12.2). Director, operator, devices and
 * remote clients all submit through here. Takeover increments the ownership generation, which
 * invalidates every older command; manual ownership is sticky until an explicit resume.
 */
export class ControlArbiter {
  private adapter: ObserverControlAdapter | null = null;
  private ownership: OwnershipState;
  private sessionId = "";
  private epoch = 0;
  private inFlight: InFlight | null = null;
  private lastConfirmedAt = 0;
  private lastObservedShot: ShotKey | null = null;
  private lastObserveAt = -Infinity;
  private resumeTimer: { at: number; owner: ControllerOwner } | null = null;
  private readonly opts: Required<Omit<ArbiterOptions, "onEvent">> & Pick<ArbiterOptions, "onEvent">;
  readonly log: ArbiterEvent[] = [];

  constructor(opts: ArbiterOptions) {
    this.opts = {
      defaultExpiresInMs: 600,
      defaultConfirmationTimeoutMs: 1500,
      maxRetries: 1,
      feedbackGraceMs: 400,
      ...opts,
    };
    this.ownership = {
      owner: "operator",
      generation: 1,
      holder: "local-operator",
      acquiredAtMonotonicMs: opts.now(),
      leaseExpiresAtMonotonicMs: null,
      // Start disarmed/manual: automation must be explicitly enabled (also after restart).
      manualSticky: true,
      emergencyStopped: false,
    };
  }

  setAdapter(adapter: ObserverControlAdapter | null): void {
    this.cancelInFlight("adapter changed");
    this.adapter = adapter;
  }

  getAdapter(): ObserverControlAdapter | null {
    return this.adapter;
  }

  /** A new session/epoch invalidates pending commands from the old timeline. */
  setTimeline(sessionId: string, epoch: number): void {
    if (sessionId !== this.sessionId || epoch !== this.epoch) {
      this.sessionId = sessionId;
      this.epoch = epoch;
      this.cancelInFlight("timeline changed (new epoch)");
    }
  }

  state(): Readonly<OwnershipState> {
    return { ...this.ownership };
  }

  pending(): Readonly<InFlight> | null {
    return this.inFlight;
  }

  get automationAllowed(): boolean {
    return this.ownership.owner === "director" && !this.ownership.manualSticky && !this.ownership.emergencyStopped;
  }

  /** Operator takes control: cancels pending automation and stays manual until resume. */
  takeover(holder = "local-operator", owner: Exclude<ControllerOwner, "none" | "director"> = "operator", leaseMs: number | null = null): void {
    const now = this.opts.now();
    this.cancelInFlight("manual takeover");
    this.resumeTimer = null;
    this.ownership = {
      owner,
      generation: this.ownership.generation + 1,
      holder,
      acquiredAtMonotonicMs: now,
      leaseExpiresAtMonotonicMs: leaseMs === null ? null : now + leaseMs,
      manualSticky: true,
      emergencyStopped: this.ownership.emergencyStopped,
    };
    this.emit("takeover", { holder, owner, generation: this.ownership.generation });
  }

  /** Explicit resume of automation, optionally after a cancellable countdown. */
  resumeAutomation(countdownMs = 0): void {
    if (this.ownership.emergencyStopped) {
      this.emit("rejected", { reason: "emergency stop active; clear it first" });
      return;
    }
    if (countdownMs > 0) {
      this.resumeTimer = { at: this.opts.now() + countdownMs, owner: "director" };
      this.emit("resume", { countdownMs, scheduled: true });
      return;
    }
    this.applyResume();
  }

  cancelResume(): void {
    if (this.resumeTimer) {
      this.resumeTimer = null;
      this.emit("resume", { cancelled: true });
    }
  }

  resumePendingInMs(): number | null {
    return this.resumeTimer ? Math.max(0, this.resumeTimer.at - this.opts.now()) : null;
  }

  async emergencyStop(): Promise<void> {
    this.cancelInFlight("emergency stop");
    this.resumeTimer = null;
    this.ownership = {
      ...this.ownership,
      owner: "operator",
      generation: this.ownership.generation + 1,
      holder: "local-operator",
      manualSticky: true,
      emergencyStopped: true,
    };
    this.emit("emergency_stop", { generation: this.ownership.generation });
    await this.adapter?.stopAutomation();
  }

  clearEmergencyStop(): void {
    this.ownership = { ...this.ownership, emergencyStopped: false };
    this.emit("cleared", {});
  }

  /** Called periodically: resume countdowns, lease expiry and confirmation timeouts. */
  tick(): void {
    const now = this.opts.now();
    if (this.resumeTimer && now >= this.resumeTimer.at) {
      this.resumeTimer = null;
      this.applyResume();
    }
    const lease = this.ownership.leaseExpiresAtMonotonicMs;
    if (lease !== null && now > lease) {
      // Remote/device lease expired: control reverts to the local operator, still manual.
      this.takeover("local-operator", "operator");
    }
    const f = this.inFlight;
    if (f && (f.status === "sent" || f.status === "transport_acknowledged" || f.status === "pending")) {
      const deadline = f.context.issuedAtMonotonicMs + f.context.confirmationTimeoutMs;
      if (now > deadline) {
        // Feedback is available when observer state arrived during the command window.
        const feedbackFlowing = this.lastObserveAt >= f.context.issuedAtMonotonicMs;
        if (!f.observedPrecisionAvailable && !feedbackFlowing && f.status === "transport_acknowledged") {
          // No feedback channel for this command type: transport-only result, never "confirmed".
          this.finish(f, { ...(f.result as CommandResult), status: "transport_acknowledged", precision: "transport_only" });
        } else {
          this.finish(f, failedResult(f.context, "confirmation_timeout", "no observed confirmation before deadline"));
        }
      }
    }
  }

  async submit(request: ControlRequest, opt: SubmitOptions): Promise<CommandResult> {
    const now = this.opts.now();
    const context: CommandContext = {
      commandId: this.opts.newId(),
      sessionId: this.sessionId,
      epoch: this.epoch,
      owner: opt.owner,
      ownershipGeneration: this.ownership.generation,
      decisionId: opt.decisionId ?? null,
      basedOnSequence: opt.basedOnSequence ?? null,
      issuedAtMonotonicMs: now,
      expiresAtMonotonicMs: now + (opt.expiresInMs ?? this.opts.defaultExpiresInMs),
      confirmationTimeoutMs: opt.confirmationTimeoutMs ?? this.opts.defaultConfirmationTimeoutMs,
    };
    const reject = (reason: NonNullable<CommandResult["failureReason"]>, detail: string) => {
      const r = failedResult(context, reason, detail);
      this.emit("rejected", { commandId: context.commandId, reason, detail, owner: opt.owner });
      return r;
    };
    if (!this.adapter) return reject("adapter_unavailable", "no observer control adapter configured");
    if (opt.owner === "director") {
      if (this.ownership.emergencyStopped) return reject("automation_stopped", "emergency stop active");
      if (!this.automationAllowed) return reject("ownership_revoked", "automation does not own the observer");
      if (this.inFlight && !this.isFinal(this.inFlight.status)) return reject("superseded", "a command is awaiting confirmation");
    } else {
      // Manual/device/remote: must hold ownership (operator always may take over first).
      if (this.ownership.owner === "director" || this.ownership.owner !== opt.owner) this.takeover(opt.holder ?? "local-operator", opt.owner as Exclude<ControllerOwner, "none" | "director">);
      context.ownershipGeneration = this.ownership.generation;
      if (this.inFlight && !this.isFinal(this.inFlight.status)) this.cancelInFlight("superseded by manual command");
    }

    const expectedShot = this.expectedShotFor(request);
    const flight: InFlight = { context, request, expectedShot, status: "pending", retries: 0, result: null, observedPrecisionAvailable: false };
    this.inFlight = flight;
    this.emit("command", { commandId: context.commandId, owner: opt.owner, request: this.describe(request), generation: context.ownershipGeneration });
    return this.send(flight);
  }

  /**
   * Feed observed camera state (e.g. GSI spectated player). Confirms pending commands, and treats
   * unexplained changes as a human takeover — except a game auto-switch after the observed player died.
   */
  observe(observer: ObserverState, opts: { previousTargetDied?: boolean; activeCinematic?: ShotKey | null } = {}): void {
    const now = this.opts.now();
    this.lastObserveAt = now;
    const shot: ShotKey | null = observer.observedSteamId ? povShot(observer.observedSteamId) : observer.cameraMode === "roaming" ? (opts.activeCinematic ?? "roaming") : null;
    const changed = shot !== this.lastObservedShot;
    const prev = this.lastObservedShot;
    this.lastObservedShot = shot;
    const f = this.inFlight;
    if (f && !this.isFinal(f.status) && f.expectedShot !== null) {
      const matches = f.expectedShot === shot || (parseShot(f.expectedShot).kind !== "pov" && observer.cameraMode === "roaming");
      if (matches) {
        f.observedPrecisionAvailable = true;
        const precision = parseShot(f.expectedShot).kind === "pov" ? "observed_exact" : "observed_consistent";
        this.finish(f, {
          commandId: f.context.commandId,
          status: "confirmed",
          precision,
          failureReason: null,
          detail: null,
          transportAckAtMonotonicMs: f.result?.transportAckAtMonotonicMs ?? null,
          confirmedAtMonotonicMs: now,
        });
        this.lastConfirmedAt = now;
        return;
      }
    }
    if (!changed || prev === null) return;
    if (now - this.lastConfirmedAt < this.opts.feedbackGraceMs) return;
    if (opts.previousTargetDied) {
      this.emit("game_autoswitch", { from: prev, to: shot });
      return;
    }
    // Unexplained change while automation owns the observer: a human changed the POV.
    this.emit("external_change", { from: prev, to: shot });
    if (this.ownership.owner === "director" && !this.ownership.manualSticky) this.takeover("external-observer-input");
  }

  // -------------------------------------------------------------------------------------------

  private applyResume(): void {
    this.cancelInFlight("ownership change");
    this.ownership = {
      owner: "director",
      generation: this.ownership.generation + 1,
      holder: "director",
      acquiredAtMonotonicMs: this.opts.now(),
      leaseExpiresAtMonotonicMs: null,
      manualSticky: false,
      emergencyStopped: false,
    };
    this.emit("resume", { generation: this.ownership.generation });
  }

  private async send(f: InFlight): Promise<CommandResult> {
    const adapter = this.adapter!;
    const ctx = f.context;
    const now = this.opts.now();
    if (now > ctx.expiresAtMonotonicMs) return this.finish(f, failedResult(ctx, "expired", "command expired before sending"));
    if (ctx.epoch !== this.epoch || ctx.sessionId !== this.sessionId) return this.finish(f, failedResult(ctx, "stale_epoch", "timeline changed"));
    if (ctx.ownershipGeneration !== this.ownership.generation) return this.finish(f, failedResult(ctx, "ownership_revoked", "ownership changed"));
    f.status = "sent";
    let result: CommandResult;
    try {
      const r = f.request;
      result =
        r.kind === "select_player"
          ? await adapter.selectPlayer(r.steamId, r.observerSlot, ctx, r.view)
          : r.kind === "activate_static_camera"
            ? await adapter.activateStaticCamera(r.camera, ctx)
            : r.kind === "play_camera_path"
              ? await adapter.playCameraPath(r.path, ctx)
              : r.kind === "stream_camera"
                ? adapter.streamCamera
                  ? await adapter.streamCamera(r.poses, r.durationMs, ctx)
                  : failedResult(ctx, "unsupported", "this camera control can't fly a free camera live")
                : await adapter.cancelPath(ctx);
    } catch (e) {
      result = failedResult(ctx, "transport_error", e instanceof Error ? e.message : String(e));
    }
    if (this.inFlight !== f) {
      // Superseded or cancelled while sending: never report it as the active command.
      return { ...result, status: "cancelled" };
    }
    f.result = result;
    if (result.status === "failed") {
      if (f.retries < this.opts.maxRetries && result.failureReason === "transport_error" && this.opts.now() < ctx.expiresAtMonotonicMs) {
        f.retries++;
        return this.send(f);
      }
      return this.finish(f, result);
    }
    if (result.status === "confirmed") return this.finish(f, result);
    f.status = "transport_acknowledged";
    this.emit("result", { commandId: ctx.commandId, status: f.status, precision: result.precision });
    return result;
  }

  private finish(f: InFlight, result: CommandResult): CommandResult {
    f.status = result.status;
    f.result = result;
    this.emit("result", { commandId: f.context.commandId, status: result.status, precision: result.precision, failureReason: result.failureReason, detail: result.detail });
    return result;
  }

  private cancelInFlight(reason: string): void {
    this.adapter?.cancelPending();
    const f = this.inFlight;
    if (f && !this.isFinal(f.status)) {
      this.finish(f, { ...failedResult(f.context, "superseded", reason), status: "cancelled" });
    }
    this.inFlight = null;
  }

  private isFinal(s: CommandResult["status"]): boolean {
    return s === "confirmed" || s === "failed" || s === "cancelled";
  }

  private expectedShotFor(r: ControlRequest): ShotKey | null {
    switch (r.kind) {
      case "select_player":
        return povShot(r.steamId);
      case "activate_static_camera":
        return cameraShot(r.camera.id);
      case "play_camera_path":
        return pathShot(r.path.id);
      case "stream_camera":
        return r.shot;
      default:
        return null;
    }
  }

  private describe(r: ControlRequest): Record<string, unknown> {
    switch (r.kind) {
      case "select_player":
        return { kind: r.kind, steamId: r.steamId, slot: r.observerSlot, view: r.view ?? "in_eye" };
      case "activate_static_camera":
        return { kind: r.kind, cameraId: r.camera.id, plannedDurationMs: r.plannedDurationMs };
      case "play_camera_path":
        return { kind: r.kind, pathId: r.path.id };
      case "stream_camera":
        return { kind: r.kind, shot: r.shot, durationMs: r.durationMs };
      default:
        return { kind: r.kind };
    }
  }

  private emit(kind: ArbiterEvent["kind"], detail: Record<string, unknown>): void {
    const e = { kind, at: this.opts.now(), detail };
    this.log.push(e);
    if (this.log.length > 500) this.log.shift();
    this.opts.onEvent?.(e);
  }
}
