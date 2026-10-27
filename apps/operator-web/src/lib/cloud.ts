import type { CloudGate } from "../api/types.ts";
import type { Tone } from "../components/ui.tsx";
import { MISSING } from "./format.ts";

/** Plain-language state of the arming gate (shared with the top bar chip). */
export function gateView(gate: CloudGate | undefined, enforcement: "required" | "off" | undefined): { tone: Tone; text: string } {
  if (!gate) return { tone: "neutral", text: MISSING };
  if (gate.ok) return enforcement === "off" ? { tone: "info", text: "NOT ENFORCED" } : gate.free ? { tone: "sim", text: "FREE (SIMULATION)" } : { tone: "ok", text: "AVAILABLE" };
  const text: Record<typeof gate.code, string> = { not_linked: "SIGNED OUT", no_entitlement: "NO LICENCE", entitlement_expired: "LICENCE EXPIRED", plan_excludes: "NOT IN PLAN", hours_exhausted: "NO HOURS LEFT" };
  return { tone: gate.code === "hours_exhausted" || gate.code === "entitlement_expired" ? "danger" : "warn", text: text[gate.code] };
}
