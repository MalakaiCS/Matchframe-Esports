import type { CameraMode, CameraPath, CameraRecord, CommandContext, CommandResult, ObservedCameraState } from "@matchframe/contracts";
import type { ControlCapabilities, ObserverControlAdapter, PlayerView, PoseStream } from "@matchframe/director-policy";
import { transportResult } from "@matchframe/director-policy";
import { cap } from "./common.ts";

/** The simulated observer the simulation source renders from. */
export interface SimulatedObserver {
  observedSteamId: string | null;
  activeCameraId: string | null;
  mode: CameraMode;
}

/**
 * SIMULATION adapter for development and demos. It changes the simulated observer state that the
 * labelled simulation source feeds back through the normal telemetry path, after a configurable
 * acquisition delay. It never touches a real game and its capabilities are marked simulated.
 */
export class SimulationObserverAdapter implements ObserverControlAdapter {
  readonly id = "simulation";
  readonly kind = "simulation" as const;
  readonly simulated = true;
  readonly supportsChase = true;
  readonly observer: SimulatedObserver = { observedSteamId: null, activeCameraId: null, mode: "in_eye" };
  private timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly now: () => number,
    private readonly opts: { acquisitionMs?: number; failRate?: number } = {},
  ) {}

  async getCapabilities(): Promise<ControlCapabilities> {
    const lim = ["SIMULATION: not a real game; does not certify live control."];
    return {
      playerSelectionControl: cap("playerSelectionControl", "supported", lim, "simulation"),
      observerModeControl: cap("observerModeControl", "supported", lim, "simulation"),
      staticCameraControl: cap("staticCameraControl", "supported", lim, "simulation"),
      cameraPathControl: cap("cameraPathControl", "supported", lim, "simulation"),
      cameraReadback: cap("cameraReadback", "partial", lim, "simulation"),
    };
  }

  private later(fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, this.opts.acquisitionMs ?? 120);
    this.timers.add(t);
  }

  private maybeFail(ctx: CommandContext): CommandResult | null {
    if ((this.opts.failRate ?? 0) > 0 && Math.random() < (this.opts.failRate ?? 0)) return transportResult(ctx, false, "simulated transport failure", this.now());
    return null;
  }

  async selectPlayer(steamId: string, _slot: number | null, ctx: CommandContext, view: PlayerView = "in_eye"): Promise<CommandResult> {
    const f = this.maybeFail(ctx);
    if (f) return f;
    this.later(() => {
      this.observer.observedSteamId = steamId;
      this.observer.activeCameraId = null;
      this.observer.mode = view;
    });
    return transportResult(ctx, true, "simulated", this.now());
  }

  async setObserverMode(mode: CameraMode, ctx: CommandContext): Promise<CommandResult> {
    this.later(() => (this.observer.mode = mode));
    return transportResult(ctx, true, "simulated", this.now());
  }

  async activateStaticCamera(camera: CameraRecord, ctx: CommandContext): Promise<CommandResult> {
    const f = this.maybeFail(ctx);
    if (f) return f;
    this.later(() => {
      this.observer.observedSteamId = null;
      this.observer.activeCameraId = camera.id;
      this.observer.mode = "static_camera";
    });
    return transportResult(ctx, true, "simulated", this.now());
  }

  /** The simulated camera flies the path: a free camera until its last keyframe (or the next command). */
  async playCameraPath(path: CameraPath, ctx: CommandContext): Promise<CommandResult> {
    const f = this.maybeFail(ctx);
    if (f) return f;
    this.later(() => {
      this.observer.observedSteamId = null;
      this.observer.activeCameraId = path.id;
      this.observer.mode = "camera_path";
    });
    return transportResult(ctx, true, "simulated", this.now());
  }

  /** Follow cam: the simulated observer flies the free camera (no pose to show, so just the free camera). */
  async streamCamera(poses: PoseStream, _durationMs: number, ctx: CommandContext): Promise<CommandResult> {
    const f = this.maybeFail(ctx);
    if (f) return f;
    if (!poses(0)) return transportResult(ctx, false, "no pose to start from", this.now(), "target_invalid");
    this.later(() => {
      this.observer.observedSteamId = null;
      this.observer.activeCameraId = null;
      this.observer.mode = "roaming";
    });
    return transportResult(ctx, true, "simulated", this.now());
  }

  async cancelPath(ctx: CommandContext): Promise<CommandResult> {
    return transportResult(ctx, true, "simulated", this.now());
  }

  async readState(): Promise<ObservedCameraState> {
    return {
      observedSteamId: this.observer.observedSteamId,
      observedSlot: null,
      mode: this.observer.mode,
      pose: null,
      observedAtMonotonicMs: this.now(),
      precision: "observed_consistent",
    };
  }

  cancelPending(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  async stopAutomation(): Promise<void> {
    this.cancelPending();
  }

  async dispose(): Promise<void> {
    this.cancelPending();
  }
}
