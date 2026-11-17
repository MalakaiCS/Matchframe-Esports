import { useState } from "react";
import type { DirectorDecision } from "@matchframe/contracts";
import type { CandidateSummary, UtilityOpportunity } from "../api/types.ts";
import { explainDecision } from "../lib/director.ts";
import { fmtMs, GRENADE_TYPE_LABEL, shotLabel, titleCase } from "../lib/format.ts";
import { reasonInfo } from "../lib/reasons.ts";
import { Badge, EmptyState, Meter, SupportBadge } from "./ui.tsx";
import { perLocale, t } from "../i18n/index.ts";
import { T } from "../i18n/T.tsx";

export function ReasonChips({ codes, max }: { codes: string[]; max?: number }) {
  const shown = max ? codes.slice(0, max) : codes;
  return (
    <span className="reasons">
      {shown.map((c) => {
        const r = reasonInfo(c);
        return (
          <span key={c} className={`reason tone-${r.tone}`} title={`${c}: ${r.hint}`}>
            {r.label}
          </span>
        );
      })}
      {max && codes.length > max ? <span className="reason">+{codes.length - max}</span> : null}
    </span>
  );
}

const COMPONENT_LABEL: Record<string, string> = perLocale(() => ({
  actionCoverage: t("control.actionCoverage"),
  imminence: t("control.component.imminence"),
  readiness: t("control.component.readiness"),
  significance: t("control.component.significance"),
  narrative: t("control.component.narrative"),
  framing: t("control.component.framing"),
  continuity: t("control.component.continuity"),
  mainStory: t("control.mainStory"),
  switchCost: t("control.switchCost"),
  stalenessPenalty: t("control.staleness"),
  cinematicOpportunityCost: t("control.cinematicCost"),
}));

export function CandidateList({ candidates, nameOf, limit = 3, currentShot }: { candidates: CandidateSummary[]; nameOf: (id: string) => string; limit?: number; currentShot?: string | null }) {
  const [open, setOpen] = useState<string | null>(null);
  const valid = [...candidates].filter((c) => c.valid).sort((a, b) => b.utility - a.utility);
  const invalid = candidates.filter((c) => !c.valid);
  if (candidates.length === 0) return <EmptyState title={t("control.noCandidatesYet")}>{t("control.theyAppearOnceLiveTelemetry")}</EmptyState>;
  return (
    <div className="cands">
      <ol className="cand-list">
        {valid.slice(0, limit).map((c, i) => (
          <li key={c.shotKey} className={`cand ${c.shotKey === currentShot ? "is-current" : ""}`}>
            <div className="cand-head">
              <span className="cand-rank">#{i + 1}</span>
              <span className="cand-shot">{shotLabel(c.shotKey, nameOf)}</span>
              {c.shotKey === currentShot ? <Badge tone="ok">ON AIR</Badge> : null}
              <span className="cand-util" title={t("control.candidateUtility01")}>
                {c.utility.toFixed(2)}
              </span>
            </div>
            <Meter value={c.utility} label={t("control.utilityOfShotkey", { shotKey: c.shotKey })} />
            <ReasonChips codes={c.reasonCodes} />
            <button className="link-btn" aria-expanded={open === c.shotKey} onClick={() => setOpen(open === c.shotKey ? null : c.shotKey)}>
              {open === c.shotKey ? t("control.hideScoreBreakdown") : t("control.scoreBreakdown")}
            </button>
            {open === c.shotKey ? (
              <table className="mini-table">
                <tbody>
                  {Object.entries(c.components).map(([k, v]) => (
                    <tr key={k}>
                      <th>{COMPONENT_LABEL[k] ?? k}</th>
                      <td>{v.toFixed(3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </li>
        ))}
      </ol>
      {valid.length === 0 ? <p className="muted">{t("control.noValidCandidateRightNow")}</p> : null}
      {invalid.length > 0 ? (
        <details className="cand-invalid">
          <summary>{t("control.countRejectedCandidateS", { count: invalid.length })}</summary>
          <ul>
            {invalid.map((c) => (
              <li key={c.shotKey}>
                {shotLabel(c.shotKey, nameOf)} — {c.invalidReason ?? t("control.invalid")}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

export function DecisionExplain({ decision, nameOf, threshold }: { decision: DirectorDecision | null; nameOf: (id: string) => string; threshold?: number | null }) {
  const ex = explainDecision(decision, nameOf, threshold);
  return (
    <div className={`decision tone-${ex.tone}`}>
      <div className="decision-head">
        <span className="decision-headline">{ex.headline}</span>
        {decision ? (
          <span className="decision-meta"><T k="control.confidenceTofixedSpan" values={{ toFixed: (decision.confidence * 100).toFixed(0), span: <span title={t("control.evidenceTypeOfTheDecision")}>{decision.evidenceType}</span> }} /></span>
        ) : null}
      </div>
      <ul className="decision-lines">
        {ex.lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
      {decision ? <ReasonChips codes={decision.reasonCodes} /> : null}
    </div>
  );
}

export function OpportunityList({ opportunities, nameOf }: { opportunities: UtilityOpportunity[]; nameOf: (id: string) => string }) {
  if (opportunities.length === 0)
    return <EmptyState title={t("control.noGrenadesInPlay")}>{t("control.smokesFlashesMolotovsAndHes")}</EmptyState>;
  return (
    <table className="table table-compact">
      <thead>
        <tr>
          <th>{t("control.utility")}</th>
          <th>{t("control.evidence")}</th>
          <th>{t("control.effect")}</th>
          <th>{t("control.scenario")}</th>
          <th>{t("control.camera")}</th>
          <th>{t("control.value")}</th>
        </tr>
      </thead>
      <tbody>
        {opportunities.map((o) => (
          <tr key={o.id}>
            <td>
              <strong>{o.types.map((tRow) => GRENADE_TYPE_LABEL[tRow] ?? tRow).join(" + ")}</strong>
              <div className="muted small">
                {titleCase(o.kind)} · {o.throwerSide ?? "?"} · {o.regionIds.join(", ") || t("control.noRegion")}
              </div>
              {o.typeSupport !== "supported" ? (
                <div>
                  <SupportBadge support={o.typeSupport} title={t("control.telemetrySupportForThisGrenade")} />
                </div>
              ) : null}
            </td>
            <td>
              {o.evidence === "confirmed" ? (
                <Badge tone="ok" icon="✓">
                  CONFIRMED
                </Badge>
              ) : (
                <Badge tone="warn" icon="~">
                  PREDICTED
                </Badge>
              )}
              {o.evidence === "predicted" ? <div className="muted small">±{Math.round(o.uncertaintyUnits)} u</div> : null}
            </td>
            <td>{o.timeToEffectMs <= 0 ? t("control.activeNow") : t("control.inTimetoeffectms", { timeToEffectMs: fmtMs(o.timeToEffectMs) })}</td>
            <td>{o.scenarioId ?? <span className="muted">—</span>}</td>
            <td>
              {o.camera ? (
                <>
                  {o.camera.camera.displayName}
                  <div className="muted small">{t("control.planneddurationmsPlanned", { plannedDurationMs: fmtMs(o.camera.plannedDurationMs) })}</div>
                </>
              ) : (
                <>
                  <Badge tone="warn">NO CAMERA</Badge>
                  <div className="muted small">{o.cameraIssue ? t("control.fallbackIssue", { issue: o.cameraIssue }) : t("control.fallback")}</div>
                </>
              )}
            </td>
            <td title={t("control.confidenceTofixedAffectsV", { toFixed: (o.confidence * 100).toFixed(0), v: o.affected.map((a) => nameOf(a.steamId)).join(", ") || t("live.nobody") })}>
              {o.value.toFixed(2)}
              <div className="muted small">{(o.confidence * 100).toFixed(0)}% conf.</div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
