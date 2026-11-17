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
import { perLocale, t } from "../i18n/index.ts";
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
        <h3 className="gc-section-title">{t("director.weights")}</h3>
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
        <h3 className="gc-section-title" style={{ marginTop: 12 }}>{t("director.thresholds")}</h3>
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
            <Checkbox checked={onlyActions} onChange={setOnlyActions} label={t("director.onlyCutsAndRecommendations")} />
            {rows.length === 0 ? (
              <EmptyState title={t("director.noDecisionsYet")}>{t("director.theDirectorLogsADecision")}</EmptyState>
            ) : (
              <div className="table-wrap" style={{ maxHeight: 420, overflowY: "auto", marginTop: 6 }}>
                <table className="table table-compact">
                  <thead>
                    <tr>
                      <th>{t("director.action")}</th>
                      <th>{t("director.currentDesired")}</th>
                      <th>{t("director.reasons")}</th>
                      <th>{t("director.confidence")}</th>
                      <th>{t("director.modeControl")}</th>
                      <th title={t("director.telemetrySequenceTheDecisionIs")}>{t("director.seq")}</th>
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
        ...(members.length ? ([[t("director.players"), members.map((m) => nameOf(m)).join(", ")]] as [string, string][]) : []),
        ...(regions.length ? ([[t("director.regions"), regions.join(", ")]] as [string, string][]) : []),
        ...rest.map(([k, v]) => [humanKey(k), humanValue(v)] as [string, string]),
      ]}
    />
  );
}

function Status({ st, nameOf }: { st: DirectorStatus; nameOf: (id: string) => string }) {
  const own = st.ownership;
  const health = st.decision ? CONTROL_HEALTH_TEXT[st.decision.controlHealth] : null;
  const mode = MODE_INFO[st.mode];
  const owner = own.emergencyStopped ? t("director.emergencyStop") : own.owner === "director" ? "Director" : `${humanKey(own.owner)}${own.manualSticky ? " (manual)" : ""}`;
  return (
    <>
      <ul className="status-list gc-status">
        <li title={mode?.hint}>
          <span className="muted">{t("director.mode")}</span>
          <span>{mode?.label ?? st.mode}</span>
        </li>
        <li>
          <span className="muted">{t("director.camera")}</span>
          <span className={own.emergencyStopped ? "text-danger" : undefined}>{owner}</span>
        </li>
        <li title={health?.hint}>
          <span className="muted">{t("director.control")}</span>
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
          <span className="muted">{t("director.currentShot")}</span>
          <span>{shotLabel(st.currentShot, nameOf)}</span>
        </li>
        {st.resumeInMs !== null ? (
          <li>
            <span className="muted">{t("director.resumingIn")}</span>
            <span>{fmtMs(st.resumeInMs)}</span>
          </li>
        ) : null}
        {st.pendingCommand ? (
          <li>
            <span className="muted">{t("director.pendingCommand")}</span>
            <span>
              {st.pendingCommand.request.kind} · {st.pendingCommand.status}
            </span>
          </li>
        ) : null}
      </ul>
      <Details summary={t("director.allDirectorState")}>
        <KV
          items={[
            [t("director.mode"), `${mode?.label ?? st.mode}${mode?.hint ? ` — ${mode.hint}` : ""}`],
            [t("director.controlHealth"), health ? `${health.text} — ${health.hint}` : MISSING],
            [t("director.ownership"), t("director.ownerVV2GenGeneration", { owner: own.owner, v: own.manualSticky ? t("director.manualStickySuffix") : "", v2: own.emergencyStopped ? t("director.emergencyStopSuffix") : "", generation: own.generation })],
            [t("director.resumeCountdown"), st.resumeInMs !== null ? fmtMs(st.resumeInMs) : t("common.none")],
            [t("director.pendingCommand"), st.pendingCommand ? `${st.pendingCommand.request.kind} · ${st.pendingCommand.status}` : t("common.none")],
            [t("director.cinematicsThisRound"), String(st.cinematicsUsedThisRound)],
            [t("director.activeCinematic"), st.cinematic ? JSON.stringify(st.cinematic) : t("common.none")],
            [t("director.policy"), t("director.vModelV2", { v: st.config.policyVersion ?? MISSING, v2: st.decision?.modelVersion ?? "none (baseline)" })],
          ]}
        />
      </Details>
    </>
  );
}

const GATES = perLocale(() => ([
  { key: "playerSelectionControl", gates: t("director.observerPovCutsAndRoster") },
  { key: "staticCameraControl", gates: t("director.cinematicsObserverCinematicsAndNade") },
  { key: "cameraPathControl", gates: t("director.cameraPathShots") },
  { key: "observerModeControl", gates: t("director.switchingInEyeChaseFree") },
  { key: "grenadeEntities", gates: t("director.utilityOpportunitiesFromTrackedGrenades") },
  { key: "playerPositions", gates: t("director.contactPredictionClustersAndMain") },
  { key: "exactKillEvents", gates: t("director.exactKillfeedOtherwiseEliminationsAre") },
] as const));

export function DirectorScreen() {
  const status = useApi<DirectorStatus>("/api/v1/director/status", { refreshMs: 2000 });
  const snap = useSnapshot();
  const decisions = useLive((s) => s.decisions);
  const nameOf = useMemo(() => makeNameOf(snap?.state), [snap?.state]);
  const caps = snap?.capabilities;
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">{t("director.autoDirector")}</h1>
        <Link to="/live" className="btn btn-primary btn-md">{t("director.operateInLiveControl")}</Link>
      </div>
      <p className="page-intro">{t("director.whatTheDirectorSeesAnd")}</p>
      <Async state={status}>
        {(st) => (
          <div className="stack">
            <div className="grid-2">
              <Panel title={t("director.status")}>
                <Status st={st} nameOf={nameOf} />
              </Panel>
              <Panel title={t("director.currentDecision")}>
                <DecisionExplain decision={st.decision} nameOf={nameOf} threshold={typeof st.config.advantageThreshold === "number" ? st.config.advantageThreshold : null} />
                <p className="gc-caption">{t("director.countDecisionsReceivedLiveSince", { count: decisions.length })}</p>
                <Details summary={t("director.howTheDirectorWorks")}>
                  <p className="small muted">{t("director.theBaselineDirectorIsDeterministic")}</p>
                </Details>
              </Panel>
            </div>
            <div className="grid-2">
              <Panel title={t("director.candidates")}>{snap ? <CandidateList candidates={snap.candidates} nameOf={nameOf} limit={6} currentShot={snap.currentShot} /> : <p className="muted">{t("director.waitingForLiveData")}</p>}</Panel>
              <div className="stack">
                <Panel title={t("director.mainStory")}>
                  {st.mainStory ? <MainStory story={st.mainStory} nameOf={nameOf} /> : <p className="muted small">{t("director.noMainStoryIdentified")}</p>}
                  {st.clusters.length ? (
                    <Details summary={t("director.interactionClustersCount", { count: st.clusters.length })}>
                      <ul className="list-plain small">
                        {st.clusters.map((c, i) => (
                          <li key={c.id ?? i}>
                            <strong>{c.id ?? t("director.clusterV", { v: i + 1 })}</strong>: {(c.steamIds ?? []).map((s) => nameOf(s)).join(", ") || t("director.noPlayers")}
                          </li>
                        ))}
                      </ul>
                    </Details>
                  ) : (
                    <p className="gc-caption">{t("director.noInteractionClusters")}</p>
                  )}
                </Panel>
                <Panel title={t("director.utilityOpportunities")}>
                  <OpportunityList opportunities={st.opportunities} nameOf={nameOf} />
                </Panel>
              </div>
            </div>
            <Panel title={t("director.decisionLog")} subtitle={t("director.mostRecentFirst")}>
              <DecisionLog nameOf={nameOf} />
            </Panel>
            <div className="grid-2" style={{ alignItems: "start" }}>
              <Panel title={t("director.capabilityGates")} subtitle={t("director.whatEachCapabilityUnlocks")}>
                <table className="table table-compact">
                  <thead>
                    <tr>
                      <th>{t("director.capability")}</th>
                      <th>{t("director.status")}</th>
                      <th>{t("director.unlocks")}</th>
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
                            <StatusDot tone={gate.enabled ? "ok" : "warn"} /> {gate.enabled ? t("director.open") : t("director.closed")}
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
                <Details summary={t("director.controlCapabilityReport")}>
                  <CapabilityTable caps={caps} group="control" />
                </Details>
              </Panel>
              <Panel title={t("director.policy")} subtitle={t("director.vModelV2", { v: st.config.policyVersion ?? MISSING, v2: st.decision?.modelVersion ?? t("director.noneBaseline") })}>
                <p className="small muted">{t("director.perMapUtilityScenariosAnd")}</p>
                <Details summary={t("director.utilityScenariosCount", { count: st.scenarios.length })}>
                  {st.scenarios.length === 0 ? (
                    <p className="muted small">{t("director.noScenariosLoaded")}</p>
                  ) : (
                    <>
                      <p className="gc-caption" style={{ marginTop: 0, marginBottom: 6 }}>{t("director.perMapRulesThatBoost")}</p>
                      <table className="table table-compact">
                        <thead>
                          <tr>
                            <th>{t("director.scenario")}</th>
                            <th>{t("director.mapRegions")}</th>
                            <th>{t("director.trigger")}</th>
                            <th>{t("director.boost")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {st.scenarios.map((s) => (
                            <tr key={s.id}>
                              <td className="mono small">{s.id}</td>
                              <td className="small">
                                {s.mapName} · {s.regionIds.join(", ")}
                              </td>
                              <td className="small">{t("director.joinOnMinalivetargetsTargetsideWithin", { join: s.grenadeTypes.join("/"), minAliveTargets: s.minAliveTargets, targetSide: s.targetSide, maxTimeToEffectMs: fmtMs(s.maxTimeToEffectMs), minConfidence: s.minConfidence })}</td>
                              <td>+{s.valueBoost}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  )}
                </Details>
                <Details summary={t("director.configuration")}>
                  <p className="gc-caption" style={{ marginTop: 0, marginBottom: 6 }}>{t("director.initialEngineeringDefaultsToBe")}</p>
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
