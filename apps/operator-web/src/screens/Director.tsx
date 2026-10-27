import { useMemo, useState } from "react";
import type { DirectorDecision } from "@matchframe/contracts";
import type { DirectorStatus } from "../api/types.ts";
import { CapabilityTable } from "../components/CapabilityTable.tsx";
import { CandidateList, DecisionExplain, OpportunityList, ReasonChips } from "../components/director.tsx";
import { Async, Badge, Checkbox, EmptyState, KV, Note, Panel } from "../components/ui.tsx";
import { capabilityGate, capabilityMeta } from "../lib/capabilities.ts";
import { MODE_INFO } from "../lib/director.ts";
import { fmtMs, MISSING, shotLabel } from "../lib/format.ts";
import { useApi } from "../lib/hooks.ts";
import { CONTROL_HEALTH_TEXT } from "../lib/ownership.ts";
import { makeNameOf } from "../lib/players.ts";
import { Link } from "../router.tsx";
import { useLive, useSnapshot } from "../state/live.ts";

function ConfigView({ config }: { config: DirectorStatus["config"] }) {
  const { weights, ...rest } = config as Record<string, unknown> & { weights?: Record<string, number> };
  const flat = Object.entries(rest).filter(([, v]) => typeof v !== "object" || v === null);
  const nested = Object.entries(rest).filter(([, v]) => typeof v === "object" && v !== null);
  return (
    <div className="grid-2">
      <div>
        <h3 className="small muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em" }}>
          Weights
        </h3>
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
        <h3 className="small muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", marginTop: 10 }}>
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
          <div key={k} style={{ marginBottom: 8 }}>
            <h3 className="small muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em" }}>
              {k}
            </h3>
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
              <div className="table-wrap" style={{ maxHeight: 460, overflowY: "auto" }}>
                <table className="table table-compact">
                  <thead>
                    <tr>
                      <th>Action</th>
                      <th>Current → desired</th>
                      <th>Reasons</th>
                      <th>Conf.</th>
                      <th>Mode / health</th>
                      <th>Seq</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((d) => (
                      <tr key={d.decisionId}>
                        <td>
                          <Badge tone={d.action === "cut" ? "ok" : d.action === "recommend" ? "accent" : d.action === "hold" ? "info" : "neutral"}>{d.action}</Badge>
                        </td>
                        <td className="small">
                          {shotLabel(d.currentShot, nameOf)} → <strong>{shotLabel(d.desiredShot, nameOf)}</strong>
                        </td>
                        <td>
                          <ReasonChips codes={d.reasonCodes} max={4} />
                        </td>
                        <td>{(d.confidence * 100).toFixed(0)}%</td>
                        <td className="small">
                          {d.mode} · {CONTROL_HEALTH_TEXT[d.controlHealth]?.text ?? d.controlHealth}
                        </td>
                        <td className="small mono">{d.basedOnSequence}</td>
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
        ...rest.map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)] as [string, string]),
      ]}
    />
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
      <p className="page-intro">The baseline director is deterministic and explainable: prediction (interaction features), editorial scoring (candidates), temporal planning (holds, budgets) and camera control (the arbiter) are separate stages. This page is for inspection; operate from Live Control.</p>
      <Async state={status}>
        {(st) => (
          <div className="stack">
            <div className="grid-3">
              <Panel title="Mode & control">
                <KV
                  items={[
                    ["Mode", <span key="m">{MODE_INFO[st.mode]?.label ?? st.mode} <span className="muted small">— {MODE_INFO[st.mode]?.hint}</span></span>],
                    ["Control health", st.decision ? <Badge key="h" tone={CONTROL_HEALTH_TEXT[st.decision.controlHealth].tone}>{CONTROL_HEALTH_TEXT[st.decision.controlHealth].text}</Badge> : MISSING],
                    ["Ownership", `${st.ownership.owner}${st.ownership.manualSticky ? " (manual, sticky)" : ""}${st.ownership.emergencyStopped ? " · EMERGENCY STOP" : ""} · gen ${st.ownership.generation}`],
                    ["Resume countdown", st.resumeInMs !== null ? fmtMs(st.resumeInMs) : "none"],
                    ["Current shot", shotLabel(st.currentShot, nameOf)],
                    ["Pending command", st.pendingCommand ? `${st.pendingCommand.request.kind} · ${st.pendingCommand.status}` : "none"],
                    ["Cinematics this round", String(st.cinematicsUsedThisRound)],
                    ["Active cinematic", st.cinematic ? JSON.stringify(st.cinematic) : "none"],
                    ["Policy", `${st.config.policyVersion ?? MISSING} · model ${st.decision?.modelVersion ?? "none (baseline)"}`],
                  ]}
                />
              </Panel>
              <Panel title="Current decision">
                <DecisionExplain decision={st.decision} nameOf={nameOf} threshold={typeof st.config.advantageThreshold === "number" ? st.config.advantageThreshold : null} />
                <p className="small muted" style={{ marginTop: 8 }}>
                  {decisions.length} decisions received live since this console connected.
                </p>
              </Panel>
              <Panel title="Main story & clusters">
                {st.mainStory ? <MainStory story={st.mainStory} nameOf={nameOf} /> : <p className="muted small">No main story identified.</p>}
                {st.clusters.length ? (
                  <ul className="list-plain small">
                    {st.clusters.map((c, i) => (
                      <li key={c.id ?? i}>
                        <strong>{c.id ?? `cluster ${i + 1}`}</strong>: {(c.steamIds ?? []).map((s) => nameOf(s)).join(", ")}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted small">No interaction clusters.</p>
                )}
              </Panel>
            </div>
            <div className="grid-2">
              <Panel title="Candidates (live)">{snap ? <CandidateList candidates={snap.candidates} nameOf={nameOf} limit={6} currentShot={snap.currentShot} /> : <p className="muted">Waiting for live data.</p>}</Panel>
              <Panel title="Capability gates" subtitle="What each control/telemetry capability unlocks">
                <table className="table table-compact">
                  <thead>
                    <tr>
                      <th>Capability</th>
                      <th>Status</th>
                      <th>Gates</th>
                    </tr>
                  </thead>
                  <tbody>
                    {GATES.map((g) => {
                      const c = caps ? (caps as unknown as Record<string, Parameters<typeof capabilityGate>[1]>)[g.key] : null;
                      const gate = capabilityGate(g.key, c ?? null, { simulated: snap?.simulated });
                      return (
                        <tr key={g.key}>
                          <td className="small">
                            {capabilityMeta(g.key).label}
                            <div className="mono muted">{g.key}</div>
                          </td>
                          <td>{gate.enabled ? <Badge tone="ok">OPEN</Badge> : <Badge tone="warn">CLOSED</Badge>}</td>
                          <td className="small">
                            {g.gates}
                            {gate.reason ? <div className={gate.enabled ? "muted" : "text-warn"}>{gate.reason}</div> : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Panel>
            </div>
            <Panel title="Decision log" subtitle="Most recent first">
              <DecisionLog nameOf={nameOf} />
            </Panel>
            <div className="grid-2">
              <Panel title="Utility opportunities">
                <OpportunityList opportunities={st.opportunities} nameOf={nameOf} />
              </Panel>
              <Panel title={`Utility scenarios (${st.scenarios.length})`} subtitle="Per-map rules that boost specific utility moments">
                {st.scenarios.length === 0 ? (
                  <p className="muted small">No scenarios loaded.</p>
                ) : (
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
                )}
              </Panel>
            </div>
            <Panel title="Configuration (read-only)" subtitle="Initial engineering defaults to be measured and tuned; not learned values">
              <ConfigView config={st.config} />
            </Panel>
            <Panel title="Control capabilities">
              <CapabilityTable caps={caps} group="control" />
            </Panel>
            {snap?.simulated ? <Note tone="sim">Values reflect the labelled simulation.</Note> : null}
          </div>
        )}
      </Async>
    </div>
  );
}
