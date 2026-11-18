import type { ControlHealth, OwnershipState } from "@matchframe/contracts";
import { formatNumber, perLocale, t } from "../i18n/index.ts";

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
  if (!o) return { kind: "unknown", badge: t("control.own.unknown"), detail: t("control.own.unknownDetail"), tone: "neutral", actions: [] };
  if (o.emergencyStopped) {
    return {
      kind: "emergency",
      badge: t("control.own.emergency"),
      detail: t("control.own.emergencyDetail"),
      tone: "danger",
      actions: ["clear_emergency"],
    };
  }
  if (resumeInMs !== null && resumeInMs !== undefined) {
    return {
      kind: "resuming",
      badge: t("control.own.resuming", { s: formatNumber(resumeInMs / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }),
      detail: t("control.own.resumingDetail"),
      tone: "warn",
      actions: ["cancel_resume"],
    };
  }
  if (o.owner === "director" && !o.manualSticky) {
    return { kind: "automation", badge: t("control.own.automatic"), detail: t("control.own.automaticDetail"), tone: "ok", actions: ["takeover"] };
  }
  if (o.owner === "device") {
    return { kind: "device", badge: t("control.own.device"), detail: t("control.own.deviceDetail", { holder: o.holder ?? t("control.own.unknownHolder") }), tone: "warn", actions: ["takeover", "resume"] };
  }
  if (o.owner === "remote") {
    return { kind: "remote", badge: t("control.own.remote"), detail: t("control.own.remoteDetail", { holder: o.holder ?? t("control.own.unknownHolder") }), tone: "warn", actions: ["takeover", "resume"] };
  }
  return {
    kind: "manual",
    badge: t("control.own.manual"),
    detail: t("control.own.manualDetail", { holder: o.holder ?? t("control.own.theOperator") }),
    tone: "warn",
    actions: ["resume"],
  };
}

export const CONTROL_HEALTH_TEXT: Record<ControlHealth, { text: string; tone: "ok" | "info" | "warn" | "danger" | "neutral"; hint: string }> = perLocale(() => ({
  armed: { text: t("control.health.armed"), tone: "ok", hint: t("control.health.armedHint") },
  degraded: { text: t("control.health.degraded"), tone: "warn", hint: t("control.health.degradedHint") },
  paused: { text: t("control.health.paused"), tone: "info", hint: t("control.health.pausedHint") },
  manual_owned: { text: t("control.health.manual"), tone: "warn", hint: t("control.health.manualHint") },
  disarmed: { text: t("control.health.disarmed"), tone: "neutral", hint: t("control.health.disarmedHint") },
  emergency_stopped: { text: t("control.health.emergency"), tone: "danger", hint: t("control.health.emergencyHint") },
}));
