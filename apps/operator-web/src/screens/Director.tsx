import { useMemo, useState } from "react";
import type { DirectorDecision } from "@matchframe/contracts";
import type { DirectorStatus } from "../api/types.ts";
import { CapabilityTable } from "../components/CapabilityTable.tsx";
import { CandidateList, DecisionExplain, OpportunityList, ReasonChips } from "../components/director.tsx";
import { Async, Checkbox, Details, EmptyState, KV, Panel, StatusDot } from "../components/ui.tsx";
import { capabilityGate, capabilityMeta } from "../lib/capabilities.ts";
import { MODE_INFO } from "../lib/director.ts";
import { fmtMs, MISSING, shotLabel } from "../lib/format.ts";
import { useApi } from "../lib/hooks.ts";
import { CONTROL_HEALTH_TEXT } from "../lib/ownership.ts";
import { makeNameOf } from "../lib/players.ts";
import { Link } from "../router.tsx";
import { useLive, useSnapshot } from "../state/live.ts";
import "../styles/group-c.css";

const humanKey = (k: string) => {
  const s = k.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const humanValue = (v: unknown) => (typeof v === "boolean" ? (v ? "yes" : "no") : typeof v === "object" && v !== null ? JSON.stringify(v) : String(v));

function ConfigView({ config }: { config: DirectorStatus["config"] }) {
  const { weights, ...rest } = config as Record<string, unknown> & { weights?: Record<string, number> };
  const flat = Object.entries(rest).filter(([, v]) => typeof v !== "object" || v === null);
  const nested = Object.entries(rest).filter(([, v]) => typeof v === "object" && v !== null);
  return (
    <div className="grid-2">
      <div>
        <h3 className="gc-section-title">Weights</h3>
        <table className="mini-table">
          <tbody>
            {Object.entries(weights ?? {}).map(([k, v]) => (
              <tr key={k}>
                <th>{k}</th>
                <td>{v.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3 className="gc-section-title" style={{ marginTop: 12 }}>
          Thresholds
        </h3>
        <table className="mini-table">
          <tbody>
            {flat.map(([k, v]) => (
              <tr key={k}>
                <th>{k}</th>
                <td>{String(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        {nested.map(([k, v]) => (
          <div key={k} style={{ marginBottom: 12 }}>
            <h3 className="gc-section-title">{humanKey(k)}</h3>
            <table className="mini-table">
              <tbody>
                {Object.entries(v as Record<string, unknown>).map(([kk, vv]) => (
                  <tr key={kk}>
                    <th>{kk}</th>
                    <td>{Array.isArray(vv) ? vv.join(", ") : String(vv)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}

const ACTION_CLASS: Record<string, string> = { cut: "text-ok", recommend: "", hold: "muted", none: "muted" };

function DecisionLog({ nameOf }: { nameOf: (id: string) => string }) {
  const [onlyActions, setOnlyActions] = useState(false);
  const log = useApi<DirectorDecision[]>("/api/v1/director/decisions?limit=150", { refreshMs: 3000 });
  return (
    <Async state={log}>
      {(list) => {
        const rows = [...list].reverse().filter((d) => !onlyActions || d.action === "cut" || d.action === "recommend");
        return (
          <>
            <Checkbox checked={onlyActions} onChange={setOnlyActions} label="Only cuts and recommendations" />
            {rows.length === 0 ? (
              <EmptyState title="No decisions yet">The director logs a decision for every evaluated telemetry update.</EmptyState>
            ) : (
              <div className="table-wrap" style={{ maxHeight: 420, overflowY: "auto", marginTop: 6 }}>
                <table className="table table-compact">
                  <thead>
                    <tr>
                      <th>Action</th>
                      <th>Current → desired</th>
                      <th>Reasons</th>
                      <th>Confidence</th>
                      <th>Mode · control</th>
                      <th title="Telemetry sequence the decision is based on">Seq</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((d) => (
                      <tr key={d.decisionId}>
                        <td className={ACTION_CLASS[d.action] ?? ""}>{humanKey(d.action)}</td>
                        <td className="small">
                          {shotLabel(d.currentShot, nameOf)} → <strong>{shotLabel(d.desiredShot, nameOf)}</strong>
                        </td>
                        <td>
                          <ReasonChips codes={d.reasonCodes} max={3} />
                        </td>
                        <td>{(d.confidence * 100).toFixed(0)}%</td>
                        <td className="small muted">
                          {MODE_INFO[d.mode]?.label ?? d.mode} · {CONTROL_HEALTH_TEXT[d.controlHealth]?.text ?? d.controlHealth}
                        </td>
                        <td className="small mono muted">{d.basedOnSequence}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        );
      }}
    </Async>
  );
}

function MainStory({ story, nameOf }: { story: Record<string, unknown>; nameOf: (id: string) => string }) {
  const members = Array.isArray(story.members) ? (story.members as string[]) : [];
  const regions = Array.isArray(story.regionIds) ? (story.regionIds as string[]) : [];
  const rest = Object.entries(story).filter(([k]) => !["members", "regionIds", "centroid"].includes(k));
  return (
    <KV
      items={[
        ...(members.length ? ([["Players", members.map((m) => nameOf(m)).join(", ")]] as [string, string][]) : []),
        ...(regions.length ? ([["Regions", regions.join(", ")]] as [string, string][]) : []),
        ...rest.map(([k, v]) => [humanKey(k), humanValue(v)] as [string, string]),
      ]}
    />
  );
}

function Status({ st, nameOf }: { st: DirectorStatus; nameOf: (id: string) => string }) {
  const own = st.ownership;
  const health = st.decision ? CONTROL_HEALTH_TEXT[st.decision.controlHealth] : null;
  const mode = MODE_INFO[st.mode];
  const owner = own.emergencyStopped ? "Emergency stop" : own.owner === "director" ? "Director" : `${humanKey(own.owner)}${own.manualSticky ? " (manual)" : ""}`;
  return (
    <>
      <ul className="status-list gc-status">
        <li title={mode?.hint}>
          <span className="muted">Mode</span>
          <span>{mode?.label ?? st.mode}</span>
        </li>
        <li>
          <span className="muted">Camera</span>
          <span className={own.emergencyStopped ? "text-danger" : undefined}>{owner}</span>
        </li>
        <li title={health?.hint}>
          <span className="muted">Control</span>
          <span>
            {health ? (
              <>
                <StatusDot tone={health.tone} /> {health.text}
              </>
            ) : (
              MISSING
            )}
          </span>
        </li>
        <li>
          <span className="muted">Current shot</span>
          <span>{shotLabel(st.currentShot, nameOf)}</span>
        </li>
        {st.resumeInMs !== null ? (
          <li>
            <span className="muted">Resuming in</span>
            <span>{fmtMs(st.resumeInMs)}</span>
          </li>
        ) : null}
        {st.pendingCommand ? (
          <li>
            <span className="muted">Pending command</span>
            <span>
              {st.pendingCommand.request.kind} · {st.pendingCommand.status}
            </span>
          </li>
        ) : null}
      </ul>
      <Details summary="All director state">
        <KV
          items={[
            ["Mode", `${mode?.label ?? st.mode}${mode?.hint ? ` — ${mode.hint}` : ""}`],
            ["Control health", health ? `${health.text} — ${health.hint}` : MISSING],
            ["Ownership", `${own.owner}${own.manualSticky ? " (manual, sticky)" : ""}${own.emergencyStopped ? " · emergency stop" : ""} · gen ${own.generation}`],
            ["Resume countdown", st.resumeInMs !== null ? fmtMs(st.resumeInMs) : "none"],
            ["Pending command", st.pendingCommand ? `${st.pendingCommand.request.kind} · ${st.pendingCommand.status}` : "none"],
            ["Cinematics this round", String(st.cinematicsUsedThisRound)],
            ["Active cinematic", st.cinematic ? JSON.stringify(st.cinematic) : "none"],
            ["Policy", `${st.config.policyVersion ?? MISSING} · model ${st.decision?.modelVersion ?? "none (baseline)"}`],
          ]}
        />
      </Details>
    </>
  );
}

const GATES = [
  { key: "playerSelectionControl", gates: "Observer POV cuts and roster-card POV requests" },
  { key: "staticCameraControl", gates: "Cinematics (Observer & Cinematics) and nade cameras (Full Action Observer)" },
  { key: "cameraPathControl", gates: "Camera path shots" },
  { key: "observerModeControl", gates: "Switching in-eye / chase / free camera" },
  { key: "grenadeEntities", gates: "Utility opportunities from tracked grenades" },
  { key: "playerPositions", gates: "Contact prediction, clusters and main story" },
  { key: "exactKillEvents", gates: "Exact killfeed (otherwise eliminations are labelled as derived)" },
] as const;

export function DirectorScreen() {
  const status = useApi<DirectorStatus>("/api/v1/director/status", { refreshMs: 2000 });
  const snap = useSnapshot();
  const decisions = useLive((s) => s.decisions);
  const nameOf = useMemo(() => makeNameOf(snap?.state), [snap?.state]);
  const caps = snap?.capabilities;
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Director</h1>
        <Link to="/live" className="btn btn-primary btn-md">
          Operate in Live Control
        </Link>
      </div>
      <p className="page-intro">What the director sees and why it decides. Operate the camera from Live Control.</p>
      <Async state={status}>
        {(st) => (
          <div className="stack">
            <div className="grid-2">
              <Panel title="Status">
                <Status st={st} nameOf={nameOf} />
              </Panel>
              <Panel title="Current decision">
                <DecisionExplain decision={st.decision} nameOf={nameOf} threshold={typeof st.config.advantageThreshold === "number" ? st.config.advantageThreshold : null} />
                <p className="gc-caption">{decisions.length} decisions received live since this console connected.</p>
                <Details summary="How the director works">
                  <p className="small muted">The baseline director is deterministic and explainable: prediction (interaction features), editorial scoring (candidates), temporal planning (holds, budgets) and camera control (the arbiter) are separate stages. This page is for inspection; operate from Live Control.</p>
                </Details>
              </Panel>
            </div>
            <div className="grid-2">
              <Panel title="Candidates">{snap ? <CandidateList candidates={snap.candidates} nameOf={nameOf} limit={6} currentShot={snap.currentShot} /> : <p className="muted">Waiting for live data.</p>}</Panel>
              <div className="stack">
                <Panel title="Main story">
                  {st.mainStory ? <MainStory story={st.mainStory} nameOf={nameOf} /> : <p className="muted small">No main story identified.</p>}
                  {st.clusters.length ? (
                    <Details summary={`Interaction clusters (${st.clusters.length})`}>
                      <ul className="list-plain small">
                        {st.clusters.map((c, i) => (
                          <li key={c.id ?? i}>
                            <strong>{c.id ?? `cluster ${i + 1}`}</strong>: {(c.steamIds ?? []).map((s) => nameOf(s)).join(", ") || "no players"}
                          </li>
                        ))}
                      </ul>
                    </Details>
                  ) : (
                    <p className="gc-caption">No interaction clusters.</p>
                  )}
                </Panel>
                <Panel title="Utility opportunities">
                  <OpportunityList opportunities={st.opportunities} nameOf={nameOf} />
                </Panel>
              </div>
            </div>
            <Panel title="Decision log" subtitle="Most recent first">
              <DecisionLog nameOf={nameOf} />
            </Panel>
            <div className="grid-2" style={{ alignItems: "start" }}>
              <Panel title="Capability gates" subtitle="What each capability unlocks">
                <table className="table table-compact">
                  <thead>
                    <tr>
                      <th>Capability</th>
                      <th>Status</th>
                      <th>Unlocks</th>
                    </tr>
                  </thead>
                  <tbody>
                    {GATES.map((g) => {
                      const c = caps ? (caps as unknown as Record<string, Parameters<typeof capabilityGate>[1]>)[g.key] : null;
                      const gate = capabilityGate(g.key, c ?? null, { simulated: snap?.simulated });
                      return (
                        <tr key={g.key}>
                          <td className="small" title={g.key}>
                            {capabilityMeta(g.key).label}
                          </td>
                          <td className="small gc-nowrap" title={gate.enabled && gate.reason ? gate.reason : undefined}>
                            <StatusDot tone={gate.enabled ? "ok" : "warn"} /> {gate.enabled ? "Open" : "Closed"}
                          </td>
                          <td className="small">
                            {g.gates}
                            {gate.reason && (!gate.enabled || gate.support === "partial") ? <div className={gate.enabled ? "muted" : "text-warn"}>{gate.reason}</div> : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <Details summary="Control capability report">
                  <CapabilityTable caps={caps} group="control" />
                </Details>
              </Panel>
              <Panel title="Policy" subtitle={`${st.config.policyVersion ?? MISSING} · model ${st.decision?.modelVersion ?? "none (baseline)"}`}>
                <p className="small muted">Per-map utility scenarios and the director&apos;s tuning values. Read-only.</p>
                <Details summary={`Utility scenarios (${st.scenarios.length})`}>
                  {st.scenarios.length === 0 ? (
                    <p className="muted small">No scenarios loaded.</p>
                  ) : (
                    <>
                      <p className="gc-caption" style={{ marginTop: 0, marginBottom: 6 }}>
                        Per-map rules that boost specific utility moments.
                      </p>
                      <table className="table table-compact">
                        <thead>
                          <tr>
                            <th>Scenario</th>
                            <th>Map / regions</th>
                            <th>Trigger</th>
                            <th>Boost</th>
                          </tr>
                        </thead>
                        <tbody>
                          {st.scenarios.map((s) => (
                            <tr key={s.id}>
                              <td className="mono small">{s.id}</td>
                              <td className="small">
                                {s.mapName} · {s.regionIds.join(", ")}
                              </td>
                              <td className="small">
                                {s.grenadeTypes.join("/")} on ≥{s.minAliveTargets} {s.targetSide} within {fmtMs(s.maxTimeToEffectMs)}, conf ≥ {s.minConfidence}
                              </td>
                              <td>+{s.valueBoost}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  )}
                </Details>
                <Details summary="Configuration">
                  <p className="gc-caption" style={{ marginTop: 0, marginBottom: 6 }}>
                    Initial engineering defaults to be measured and tuned; not learned values.
                  </p>
                  <ConfigView config={st.config} />
                </Details>
              </Panel>
            </div>
          </div>
        )}
      </Async>
    </div>
  );
}
