import type { ControlHealth, OwnershipState } from "@matchframe/contracts";

export type OwnershipKind = "unknown" | "emergency" | "resuming" | "manual" | "automation" | "device" | "remote";
export type OwnershipAction = "clear_emergency" | "resume" | "cancel_resume" | "takeover";

export interface OwnershipView {
  kind: OwnershipKind;
  /** Short badge text (never colour alone). */
  badge: string;
  detail: string;
  tone: "neutral" | "info" | "ok" | "warn" | "danger";
  actions: OwnershipAction[];
}

/**
 * Derives the persistent ownership banner. Precedence: emergency stop > pending resume countdown >
 * manual (sticky) > director automation > device/remote holders.
 */
export function ownershipView(o: OwnershipState | null | undefined, resumeInMs: number | null | undefined): OwnershipView {
  if (!o) return { kind: "unknown", badge: "OWNERSHIP ?", detail: "Waiting for the engine", tone: "neutral", actions: [] };
  if (o.emergencyStopped) {
    return {
      kind: "emergency",
      badge: "EMERGENCY STOP",
      detail: "Automation halted. The camera stays where it is until an operator acts. Clear the stop, then resume automation explicitly.",
      tone: "danger",
      actions: ["clear_emergency"],
    };
  }
  if (resumeInMs !== null && resumeInMs !== undefined) {
    return {
      kind: "resuming",
      badge: `RESUMING IN ${(resumeInMs / 1000).toFixed(1)} s`,
      detail: "Automation will take the camera when the countdown ends. Cancel to stay manual.",
      tone: "warn",
      actions: ["cancel_resume"],
    };
  }
  if (o.owner === "director" && !o.manualSticky) {
    return { kind: "automation", badge: "AUTOMATION", detail: "The director owns the observer camera.", tone: "ok", actions: ["takeover"] };
  }
  if (o.owner === "device") {
    return { kind: "device", badge: "DEVICE CONTROL", detail: `A control device (${o.holder ?? "unknown"}) owns the camera.`, tone: "warn", actions: ["takeover", "resume"] };
  }
  if (o.owner === "remote") {
    return { kind: "remote", badge: "REMOTE CONTROL", detail: `A remote client (${o.holder ?? "unknown"}) owns the camera.`, tone: "warn", actions: ["takeover", "resume"] };
  }
  return {
    kind: "manual",
    badge: "MANUAL",
    detail: `${o.holder ?? "The operator"} owns the camera. Manual control is sticky: automation only returns after an explicit resume.`,
    tone: "warn",
    actions: ["resume"],
  };
}

export const CONTROL_HEALTH_TEXT: Record<ControlHealth, { text: string; tone: "ok" | "info" | "warn" | "danger" | "neutral"; hint: string }> = {
  armed: { text: "ARMED", tone: "ok", hint: "Automation may execute cuts." },
  degraded: { text: "DEGRADED", tone: "warn", hint: "Control works with reduced confidence (e.g. transport-only confirmation)." },
  paused: { text: "PAUSED", tone: "info", hint: "Automation paused (hold active)." },
  manual_owned: { text: "MANUAL OWNED", tone: "warn", hint: "The operator owns the camera; decisions are recommendations." },
  disarmed: { text: "DISARMED", tone: "neutral", hint: "Automation is not armed (advisory mode or manual ownership)." },
  emergency_stopped: { text: "EMERGENCY STOPPED", tone: "danger", hint: "Emergency stop is active." },
};
