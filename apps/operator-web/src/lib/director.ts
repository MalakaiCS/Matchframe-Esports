import type { DirectorDecision, DirectorMode, ObserverMode } from "@matchframe/contracts";
import { reasonInfo } from "./reasons.ts";
import { shotLabel } from "./format.ts";
import { formatNumber, perLocale, t } from "../i18n/index.ts";

const MODE_IDS: DirectorMode[] = ["off", "advisory", "assisted", "automatic", "shadow", "demo_review", "delayed_lookahead"];
export const MODE_INFO: Record<DirectorMode, { label: string; hint: string }> = perLocale(
  () => Object.fromEntries(MODE_IDS.map((m) => [m, { label: t(`control.mode.${m}.label`), hint: t(`control.mode.${m}.hint`) }])) as Record<DirectorMode, { label: string; hint: string }>,
);

export const DIRECTOR_MODES = MODE_IDS;

/** The Observer (auto director) modes the operator chooses from, in order. */
export const OBSERVER_MODES: ObserverMode[] = ["off", "observer", "observer_cinematics", "full_action"];
export const OBSERVER_MODE_INFO: Record<ObserverMode, { label: string; hint: string; topPlan?: true }> = perLocale(() => ({
  off: { label: t("control.observer.off.label"), hint: t("control.observer.off.hint") },
  observer: { label: t("control.observer.observer.label"), hint: t("control.observer.observer.hint") },
  observer_cinematics: { label: t("control.observer.observer_cinematics.label"), hint: t("control.observer.observer_cinematics.hint") },
  full_action: { label: t("control.observer.full_action.label"), hint: t("control.observer.full_action.hint"), topPlan: true as const },
}));

const ASSISTED_IDS = ["pov_cut", "cinematic", "replay_suggestion", "mixer_cue"] as const;
export const ASSISTED_ACTIONS: readonly { id: (typeof ASSISTED_IDS)[number]; label: string; hint: string }[] = perLocale(() => ASSISTED_IDS.map((id) => ({ id, label: t(`control.assisted.${id}.label`), hint: t(`control.assisted.${id}.hint`) })));

const HOLD_REASONS = new Set(["MIN_SHOT_DURATION", "ADVANTAGE_BELOW_THRESHOLD", "ADVANTAGE_NOT_PERSISTENT", "POST_EVENT_HOLD", "HOLD_REQUESTED", "PINNED", "COOLDOWN_ACTIVE", "CURRENT_SHOT_VALID", "NO_VALID_CANDIDATE"]);
const BLOCK_REASONS: Record<string, string> = perLocale(() => ({
  MANUAL_OWNERSHIP: t("control.block.manual"),
  EMERGENCY_STOP: t("control.block.emergency"),
  STALE_DATA: t("control.block.stale"),
  LOW_CONFIDENCE: t("control.block.lowConfidence"),
}));

export interface DecisionExplanation {
  headline: string;
  tone: "neutral" | "info" | "ok" | "warn" | "danger";
  lines: string[];
}

/** Plain-language "why hold / why cut" for the current director decision. */
export function explainDecision(d: DirectorDecision | null | undefined, nameOf: (id: string) => string, advantageThreshold?: number | null): DecisionExplanation {
  if (!d) return { headline: t("control.explain.none"), tone: "neutral", lines: [t("control.explain.noneLine")] };
  const cur = shotLabel(d.currentShot, nameOf);
  const want = shotLabel(d.desiredShot, nameOf);
  const f = d.supportingFeatures;
  const cand = typeof f.candidateUtility === "number" ? f.candidateUtility : null;
  const curU = typeof f.currentUtility === "number" ? f.currentUtility : null;
  const lines: string[] = [];
  const advantage = cand !== null && curU !== null ? cand - curU : null;
  const n2 = (v: number) => formatNumber(v, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const advLine =
    advantage !== null
      ? t(typeof advantageThreshold === "number" ? "control.explain.advantageThreshold" : "control.explain.advantage", { best: n2(cand!), current: n2(curU!), diff: `${advantage >= 0 ? "+" : ""}${n2(advantage)}`, threshold: typeof advantageThreshold === "number" ? `+${n2(advantageThreshold)}` : "" })
      : null;
  switch (d.action) {
    case "cut":
      if (advLine) lines.push(advLine);
      for (const r of d.reasonCodes) if (!HOLD_REASONS.has(r)) lines.push(`${reasonInfo(r).label}: ${reasonInfo(r).hint}`);
      return { headline: t("control.explain.cut", { shot: want }), tone: "ok", lines };
    case "hold": {
      const holds = d.reasonCodes.filter((r) => HOLD_REASONS.has(r) || r in BLOCK_REASONS);
      for (const r of holds) lines.push(`${reasonInfo(r).label}: ${reasonInfo(r).hint}`);
      if (advLine) lines.push(advLine);
      if (lines.length === 0) lines.push(t("control.explain.holdBest"));
      return { headline: t("control.explain.hold", { shot: cur }), tone: "info", lines };
    }
    case "recommend": {
      const blockers = d.reasonCodes.filter((r) => r in BLOCK_REASONS).map((r) => BLOCK_REASONS[r]!);
      if (d.mode === "advisory") blockers.push(t("control.block.advisory"));
      if (d.mode === "assisted") blockers.push(t("control.block.assisted"));
      if (d.mode === "shadow") blockers.push(t("control.block.shadow"));
      lines.push(blockers.length ? t("control.explain.notExecuted", { reasons: [...new Set(blockers)].join("; ") }) : t("control.explain.recommendOnly"));
      if (advLine) lines.push(advLine);
      for (const r of d.reasonCodes) if (!(r in BLOCK_REASONS) && !HOLD_REASONS.has(r)) lines.push(`${reasonInfo(r).label}: ${reasonInfo(r).hint}`);
      return { headline: t("control.explain.recommend", { shot: want }), tone: "warn", lines };
    }
    default:
      for (const r of d.reasonCodes) lines.push(`${reasonInfo(r).label}: ${reasonInfo(r).hint}`);
      return { headline: t("control.explain.noAction"), tone: "neutral", lines: lines.length ? lines : [t("control.explain.nothing")] };
  }
}
