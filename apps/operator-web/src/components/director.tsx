import { useState } from "react";
import type { DirectorDecision } from "@matchframe/contracts";
import type { CandidateSummary, UtilityOpportunity } from "../api/types.ts";
import { explainDecision } from "../lib/director.ts";
import { fmtMs, GRENADE_TYPE_LABEL, shotLabel, titleCase } from "../lib/format.ts";
import { reasonInfo } from "../lib/reasons.ts";
import { Badge, EmptyState, Meter, SupportBadge } from "./ui.tsx";

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

const COMPONENT_LABEL: Record<string, string> = {
  actionCoverage: "Action coverage",
  imminence: "Imminence",
  readiness: "Readiness",
  significance: "Significance",
  narrative: "Narrative",
  framing: "Framing",
  continuity: "Continuity",
  mainStory: "Main story",
  switchCost: "Switch cost (−)",
  stalenessPenalty: "Staleness (−)",
  cinematicOpportunityCost: "Cinematic cost (−)",
};

export function CandidateList({ candidates, nameOf, limit = 3, currentShot }: { candidates: CandidateSummary[]; nameOf: (id: string) => string; limit?: number; currentShot?: string | null }) {
  const [open, setOpen] = useState<string | null>(null);
  const valid = [...candidates].filter((c) => c.valid).sort((a, b) => b.utility - a.utility);
  const invalid = candidates.filter((c) => !c.valid);
  if (candidates.length === 0) return <EmptyState title="No candidates yet">They appear once live telemetry with player positions arrives.</EmptyState>;
  return (
    <div className="cands">
      <ol className="cand-list">
        {valid.slice(0, limit).map((c, i) => (
          <li key={c.shotKey} className={`cand ${c.shotKey === currentShot ? "is-current" : ""}`}>
            <div className="cand-head">
              <span className="cand-rank">#{i + 1}</span>
              <span className="cand-shot">{shotLabel(c.shotKey, nameOf)}</span>
              {c.shotKey === currentShot ? <Badge tone="ok">ON AIR</Badge> : null}
              <span className="cand-util" title="Candidate utility (0–1)">
                {c.utility.toFixed(2)}
              </span>
            </div>
            <Meter value={c.utility} label={`Utility of ${c.shotKey}`} />
            <ReasonChips codes={c.reasonCodes} />
            <button className="link-btn" aria-expanded={open === c.shotKey} onClick={() => setOpen(open === c.shotKey ? null : c.shotKey)}>
              {open === c.shotKey ? "Hide score breakdown" : "Score breakdown"}
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
      {valid.length === 0 ? <p className="muted">No valid candidate right now — the director holds.</p> : null}
      {invalid.length > 0 ? (
        <details className="cand-invalid">
          <summary>{invalid.length} rejected candidate(s)</summary>
          <ul>
            {invalid.map((c) => (
              <li key={c.shotKey}>
                {shotLabel(c.shotKey, nameOf)} — {c.invalidReason ?? "invalid"}
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
          <span className="decision-meta">
            confidence {(decision.confidence * 100).toFixed(0)}% · <span title="Evidence type of the decision">{decision.evidenceType}</span>
          </span>
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
    return <EmptyState title="No grenades in play">Smokes, flashes, molotovs and HEs show up here as they're thrown.</EmptyState>;
  return (
    <table className="table table-compact">
      <thead>
        <tr>
          <th>Utility</th>
          <th>Evidence</th>
          <th>Effect</th>
          <th>Scenario</th>
          <th>Camera</th>
          <th>Value</th>
        </tr>
      </thead>
      <tbody>
        {opportunities.map((o) => (
          <tr key={o.id}>
            <td>
              <strong>{o.types.map((t) => GRENADE_TYPE_LABEL[t] ?? t).join(" + ")}</strong>
              <div className="muted small">
                {titleCase(o.kind)} · {o.throwerSide ?? "?"} · {o.regionIds.join(", ") || "no region"}
              </div>
              {o.typeSupport !== "supported" ? (
                <div>
                  <SupportBadge support={o.typeSupport} title="Telemetry support for this grenade type" />
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
            <td>{o.timeToEffectMs <= 0 ? "active now" : `in ${fmtMs(o.timeToEffectMs)}`}</td>
            <td>{o.scenarioId ?? <span className="muted">—</span>}</td>
            <td>
              {o.camera ? (
                <>
                  {o.camera.camera.displayName}
                  <div className="muted small">{fmtMs(o.camera.plannedDurationMs)} planned</div>
                </>
              ) : (
                <>
                  <Badge tone="warn">NO CAMERA</Badge>
                  <div className="muted small">fallback: POV / radar / hold{o.cameraIssue ? ` — ${o.cameraIssue}` : ""}</div>
                </>
              )}
            </td>
            <td title={`confidence ${(o.confidence * 100).toFixed(0)}%; affects ${o.affected.map((a) => nameOf(a.steamId)).join(", ") || "nobody"}`}>
              {o.value.toFixed(2)}
              <div className="muted small">{(o.confidence * 100).toFixed(0)}% conf.</div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
