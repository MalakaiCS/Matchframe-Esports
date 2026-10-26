import { z } from "zod";
import { CameraMode } from "./state.ts";
import { SteamId64, Vec3 } from "./common.ts";

export const ControllerOwner = z.enum(["operator", "director", "device", "remote", "none"]);
export type ControllerOwner = z.infer<typeof ControllerOwner>;

/** Context attached to every observer command (spec §12.1/§12.2). */
export const CommandContext = z.object({
  commandId: z.string(),
  sessionId: z.string(),
  epoch: z.number().int(),
  owner: ControllerOwner,
  /** Ownership generation at issue time; a takeover increments it and invalidates older commands. */
  ownershipGeneration: z.number().int(),
  decisionId: z.string().nullable(),
  basedOnSequence: z.number().int().nullable(),
  issuedAtMonotonicMs: z.number(),
  /** Absolute monotonic deadline after which the command must not be executed. */
  expiresAtMonotonicMs: z.number(),
  /** How long to wait for observed confirmation before declaring failure. */
  confirmationTimeoutMs: z.number(),
});
export type CommandContext = z.infer<typeof CommandContext>;

export const ConfirmationPrecision = z.enum([
  /** Source feedback directly shows the requested target (e.g. GSI observed player). */
  "observed_exact",
  /** Feedback is consistent with but not uniquely attributable to the command. */
  "observed_consistent",
  /** Only transport acknowledgement (bytes written / key sent). NOT proof of a camera change. */
  "transport_only",
  "none",
]);
export type ConfirmationPrecision = z.infer<typeof ConfirmationPrecision>;

export const CommandFailureReason = z.enum([
  "expired",
  "stale_epoch",
  "ownership_revoked",
  "unsupported",
  "capability_unverified",
  "target_invalid",
  "target_dead",
  "transport_error",
  "window_not_focused",
  "confirmation_timeout",
  "superseded",
  "automation_stopped",
  "adapter_unavailable",
]);
export type CommandFailureReason = z.infer<typeof CommandFailureReason>;

export const CommandStatus = z.enum([
  "pending",
  "sent",
  "transport_acknowledged",
  "confirmed",
  "failed",
  "cancelled",
]);
export type CommandStatus = z.infer<typeof CommandStatus>;

export const CommandResult = z.object({
  commandId: z.string(),
  status: CommandStatus,
  precision: ConfirmationPrecision,
  failureReason: CommandFailureReason.nullable(),
  detail: z.string().nullable(),
  transportAckAtMonotonicMs: z.number().nullable(),
  confirmedAtMonotonicMs: z.number().nullable(),
});
export type CommandResult = z.infer<typeof CommandResult>;

export const ObserverCommandKind = z.enum([
  "select_player",
  "set_observer_mode",
  "activate_static_camera",
  "play_camera_path",
  "cancel_path",
]);
export type ObserverCommandKind = z.infer<typeof ObserverCommandKind>;

export const ObserverCommand = z.object({
  kind: ObserverCommandKind,
  context: CommandContext,
  targetSteamId: SteamId64.nullable().default(null),
  mode: CameraMode.nullable().default(null),
  cameraId: z.string().nullable().default(null),
  pathId: z.string().nullable().default(null),
});
export type ObserverCommand = z.infer<typeof ObserverCommand>;

export const ObservedCameraState = z.object({
  observedSteamId: SteamId64.nullable(),
  observedSlot: z.number().int().nullable(),
  mode: CameraMode,
  /** Camera pose if the adapter can read it back (cameraReadback capability). */
  pose: z
    .object({ position: Vec3, pitch: z.number(), yaw: z.number(), fov: z.number().nullable() })
    .nullable(),
  observedAtMonotonicMs: z.number().nullable(),
  precision: ConfirmationPrecision,
});
export type ObservedCameraState = z.infer<typeof ObservedCameraState>;

export const OwnershipState = z.object({
  owner: ControllerOwner,
  generation: z.number().int(),
  holder: z.string().nullable(),
  acquiredAtMonotonicMs: z.number(),
  leaseExpiresAtMonotonicMs: z.number().nullable(),
  /** True when the operator took manual control; stays true until explicit resume. */
  manualSticky: z.boolean(),
  emergencyStopped: z.boolean(),
});
export type OwnershipState = z.infer<typeof OwnershipState>;
