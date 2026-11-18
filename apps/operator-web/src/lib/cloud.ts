import type { CloudGate } from "../api/types.ts";
import type { Tone } from "../components/ui.tsx";
import { MISSING } from "./format.ts";
import { t } from "../i18n/index.ts";

/** Plain-language state of the arming gate (shared with the top bar chip). */
export function gateView(gate: CloudGate | undefined, enforcement: "required" | "off" | undefined): { tone: Tone; text: string } {
  if (!gate) return { tone: "neutral", text: MISSING };
  if (gate.ok) return enforcement === "off" ? { tone: "info", text: t("shell.gateState.notEnforced") } : gate.free ? { tone: "sim", text: t("shell.gateState.free") } : { tone: "ok", text: t("shell.gateState.available") };
  return { tone: gate.code === "hours_exhausted" || gate.code === "entitlement_expired" ? "danger" : "warn", text: t(`shell.gateState.${gate.code}`) };
}
