import type { DirectorDecision, DirectorMode, ObserverMode } from "@matchframe/contracts";
import { reasonInfo } from "./reasons.ts";
import { shotLabel } from "./format.ts";

export const MODE_INFO: Record<DirectorMode, { label: string; hint: string }> = {
  off: { label: "Off", hint: "No decisions are made." },
  advisory: { label: "Advisory", hint: "Recommends shots; never moves the camera." },
  assisted: { label: "Assisted", hint: "Executes only the action classes enabled below; recommends everything else." },
  automatic: { label: "Automatic", hint: "Executes cuts when it owns the camera (requires Resume automation)." },
  shadow: { label: "Shadow", hint: "Decides silently for evaluation; never executes or recommends on air." },
  demo_review: { label: "Demo review", hint: "Decision review against demo playback." },
  delayed_lookahead: { label: "Delayed look-ahead", hint: "Uses a delayed program timeline to look ahead before cutting." },
};

export const DIRECTOR_MODES = Object.keys(MODE_INFO) as DirectorMode[];

/** The Observer (auto director) modes the operator chooses from, in order. */
export const OBSERVER_MODE_INFO: Record<ObserverMode, { label: string; hint: string; topPlan?: true }> = {
  off: { label: "Off", hint: "Matchframe never moves the camera. Shot suggestions stay visible here. Uses no hours." },
  observer: { label: "Observer", hint: "Switches between player POVs automatically." },
  observer_cinematics: { label: "Observer & Cinematics", hint: "POV observing plus cinematic static cameras: an establishing shot in freeze time, the bomb at plant and defuse, and overviews of big fights (cameras from Maps & Cameras)." },
  full_action: { label: "Full Action Observer", hint: "Everything in Observer & Cinematics plus nade cameras that catch smokes, flashes, molotovs and HE grenades as they land.", topPlan: true },
};

export const OBSERVER_MODES = Object.keys(OBSERVER_MODE_INFO) as ObserverMode[];

export const ASSISTED_ACTIONS = [
  { id: "pov_cut", label: "POV cuts", hint: "Switch the spectated player" },
  { id: "cinematic", label: "Cinematic cameras", hint: "Static utility/tactical cameras (needs static camera control)" },
  { id: "replay_suggestion", label: "Replay suggestions", hint: "Bookmark replay candidates (never auto-plays)" },
  { id: "mixer_cue", label: "Mixer cues", hint: "Program/mixer cue suggestions" },
] as const;

const HOLD_REASONS = new Set(["MIN_SHOT_DURATION", "ADVANTAGE_BELOW_THRESHOLD", "ADVANTAGE_NOT_PERSISTENT", "POST_EVENT_HOLD", "HOLD_REQUESTED", "PINNED", "COOLDOWN_ACTIVE", "CURRENT_SHOT_VALID", "NO_VALID_CANDIDATE"]);
const BLOCK_REASONS: Record<string, string> = {
  MANUAL_OWNERSHIP: "the operator owns the camera (manual is sticky until Resume automation)",
  EMERGENCY_STOP: "emergency stop is active",
  STALE_DATA: "telemetry is stale",
  LOW_CONFIDENCE: "confidence is too low to act",
};

export interface DecisionExplanation {
  headline: string;
  tone: "neutral" | "info" | "ok" | "warn" | "danger";
  lines: string[];
}

/** Plain-language "why hold / why cut" for the current director decision. */
export function explainDecision(d: DirectorDecision | null | undefined, nameOf: (id: string) => string, advantageThreshold?: number | null): DecisionExplanation {
  if (!d) return { headline: "No decision yet", tone: "neutral", lines: ["The director evaluates as soon as telemetry arrives."] };
  const cur = shotLabel(d.currentShot, nameOf);
  const want = shotLabel(d.desiredShot, nameOf);
  const f = d.supportingFeatures;
  const cand = typeof f.candidateUtility === "number" ? f.candidateUtility : null;
  const curU = typeof f.currentUtility === "number" ? f.currentUtility : null;
  const lines: string[] = [];
  const advantage = cand !== null && curU !== null ? cand - curU : null;
  const advLine =
    advantage !== null
      ? `Best alternative scores ${cand!.toFixed(2)} vs current ${curU!.toFixed(2)} (${advantage >= 0 ? "+" : ""}${advantage.toFixed(2)}${typeof advantageThreshold === "number" ? `; cut threshold +${advantageThreshold.toFixed(2)}` : ""}).`
      : null;
  switch (d.action) {
    case "cut":
      if (advLine) lines.push(advLine);
      for (const r of d.reasonCodes) if (!HOLD_REASONS.has(r)) lines.push(`${reasonInfo(r).label}: ${reasonInfo(r).hint}`);
      return { headline: `Cut to ${want}`, tone: "ok", lines };
    case "hold": {
      const holds = d.reasonCodes.filter((r) => HOLD_REASONS.has(r) || r in BLOCK_REASONS);
      for (const r of holds) lines.push(`${reasonInfo(r).label}: ${reasonInfo(r).hint}`);
      if (advLine) lines.push(advLine);
      if (lines.length === 0) lines.push("The current shot remains the best available.");
      return { headline: `Holding ${cur}`, tone: "info", lines };
    }
    case "recommend": {
      const blockers = d.reasonCodes.filter((r) => r in BLOCK_REASONS).map((r) => BLOCK_REASONS[r]!);
      if (d.mode === "advisory") blockers.push("the Observer is Off (suggestions only)");
      if (d.mode === "assisted") blockers.push("this action class is not enabled for assisted execution");
      if (d.mode === "shadow") blockers.push("shadow mode never executes");
      lines.push(blockers.length ? `Not executed because ${[...new Set(blockers)].join("; ")}.` : "Recommendation only.");
      if (advLine) lines.push(advLine);
      for (const r of d.reasonCodes) if (!(r in BLOCK_REASONS) && !HOLD_REASONS.has(r)) lines.push(`${reasonInfo(r).label}: ${reasonInfo(r).hint}`);
      return { headline: `Recommends ${want}`, tone: "warn", lines };
    }
    default:
      for (const r of d.reasonCodes) lines.push(`${reasonInfo(r).label}: ${reasonInfo(r).hint}`);
      return { headline: "No action", tone: "neutral", lines: lines.length ? lines : ["Nothing to do on the current state."] };
  }
}
