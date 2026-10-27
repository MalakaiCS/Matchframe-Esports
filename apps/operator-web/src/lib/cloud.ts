import type { CloudGate } from "../api/types.ts";
import type { Tone } from "../components/ui.tsx";
import { MISSING } from "./format.ts";

/** Plain-language state of the arming gate (shared with the top bar chip). */
export function gateView(gate: CloudGate | undefined, enforcement: "required" | "off" | undefined): { tone: Tone; text: string } {
  if (!gate) return { tone: "neutral", text: MISSING };
  if (gate.ok) return enforcement === "off" ? { tone: "info", text: "Not enforced" } : gate.free ? { tone: "sim", text: "Free in simulation" } : { tone: "ok", text: "Available" };
  const text: Record<typeof gate.code, string> = { not_linked: "Signed out", no_entitlement: "No licence", entitlement_expired: "Licence expired", plan_excludes: "Not in plan", hours_exhausted: "No hours left" };
  return { tone: gate.code === "hours_exhausted" || gate.code === "entitlement_expired" ? "danger" : "warn", text: text[gate.code] };
}
