import type {
  CameraMode,
  CameraPath,
  CameraRecord,
  Capability,
  CommandContext,
  CommandResult,
  ObservedCameraState,
} from "@matchframe/contracts";

/** How a spectated player is shown: through their eyes, or from behind in the third-person chase view. */
export type PlayerView = "in_eye" | "chase";

/** A free-camera pose (Hammer units, degrees). */
export interface CameraPose {
  position: { x: number; y: number; z: number };
  pitch: number;
  yaw: number;
}

/** Where the free camera is `elapsedMs` into a streamed shot; null ends the shot. */
export type PoseStream = (elapsedMs: number) => CameraPose | null;

/** Control-related capabilities reported by an adapter (never inferred from telemetry). */
export interface ControlCapabilities {
  playerSelectionControl: Capability;
  observerModeControl: Capability;
  staticCameraControl: Capability;
  cameraPathControl: Capability;
  cameraReadback: Capability;
}

/**
 * Semantic observer control (spec §12.1). Implementations: verified direct channel, keyboard
 * fallback scoped to the observer window, demo-playback controller, and the separate, labelled
 * simulation adapter. Writing bytes to a socket or an input API is transport acknowledgement only —
 * confirmation comes from observed camera feedback.
 */
/** A camera turning while it is on air: degrees a second (positive to the left), over the shot's planned length. */
export interface CameraMotion {
  panDegPerSec: number;
  durationMs: number;
}

export interface ObserverControlAdapter {
  readonly id: string;
  readonly kind: "direct" | "keyboard" | "demo_playback" | "simulation" | "none";
  readonly simulated: boolean;
  /** Can show a player in the third-person chase view (`selectPlayer(..., "chase")`). */
  readonly supportsChase?: boolean;
  getCapabilities(): Promise<ControlCapabilities>;
  /** Spectate a player, first person by default or in the third-person chase view. */
  selectPlayer(steamId: string, observerSlot: number | null, context: CommandContext, view?: PlayerView): Promise<CommandResult>;
  setObserverMode(mode: CameraMode, context: CommandContext): Promise<CommandResult>;
  /**
   * Shows a camera. With `motion`, it turns slowly while on air (in the game, every frame), centred on
   * the camera's aim over `durationMs`; an adapter that can't turn it shows it still.
   */
  activateStaticCamera(camera: CameraRecord, context: CommandContext, motion?: CameraMotion): Promise<CommandResult>;
  playCameraPath(path: CameraPath, context: CommandContext): Promise<CommandResult>;
  /** Flies the free camera along poses computed live (follow cam), up to `durationMs`. */
  streamCamera?(poses: PoseStream, durationMs: number, context: CommandContext): Promise<CommandResult>;
  cancelPath(context: CommandContext): Promise<CommandResult>;
  readState(): Promise<ObservedCameraState>;
  /** Cancel queued keypresses / pending transport work immediately. */
  cancelPending(): void;
  /** Observer state from the game data (e.g. whether the camera is in the free camera), with the spectated player's position. */
  noteObserverState?(observer: { cameraMode: string; observedSteamId: string | null; observedPosition?: { x: number; y: number; z: number } | null }): void;
  stopAutomation(): Promise<void>;
  dispose(): Promise<void>;
}

export function transportResult(context: CommandContext, ok: boolean, detail: string | null, now: number, failure: CommandResult["failureReason"] = null): CommandResult {
  return {
    commandId: context.commandId,
    status: ok ? "transport_acknowledged" : "failed",
    precision: ok ? "transport_only" : "none",
    failureReason: ok ? null : (failure ?? "transport_error"),
    detail,
    transportAckAtMonotonicMs: ok ? now : null,
    confirmedAtMonotonicMs: null,
  };
}

export function failedResult(context: CommandContext, reason: NonNullable<CommandResult["failureReason"]>, detail: string): CommandResult {
  return {
    commandId: context.commandId,
    status: "failed",
    precision: "none",
    failureReason: reason,
    detail,
    transportAckAtMonotonicMs: null,
    confirmedAtMonotonicMs: null,
  };
}
