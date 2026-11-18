import { useState } from "react";
import { api, seg } from "../api/index.ts";
import type { DemoJobsResponse, ModelsResponse, RegistryEntry, ShadowStatus, TrainingRun } from "../api/types.ts";
import { ActionButton, Async, Badge, Checkbox, Details, EmptyState, KV, Note, Panel } from "../components/ui.tsx";
import { fmtNum, fmtPct, fmtTime, MISSING } from "../lib/format.ts";
import { useApi } from "../lib/hooks.ts";
import { Link } from "../router.tsx";
import { useSnapshot } from "../state/live.ts";
import { usePermission } from "../state/session.tsx";
import { DemoModelPanel } from "./training/DemoModel.tsx";
import { TestBench } from "./training/TestBench.tsx";
import { perLocale, t } from "../i18n/index.ts";
import { T } from "../i18n/T.tsx";
import "../styles/group-c.css";

const STATUS_TONE: Record<string, "ok" | "info" | "warn" | "danger" | "neutral" | "accent"> = {
  experimental: "neutral",
  shadow: "info",
  candidate: "accent",
  approved: "ok",
  rolled_back: "warn",
  retired: "neutral",
};

/**
 * Registry transitions (workers/training/mf_training/registry.py) that the engine API accepts
 * (the API cannot move a model back to "experimental"). The registry remains the authority.
 */
export const PROMOTION_TARGETS: Record<string, string[]> = {
  experimental: ["shadow", "retired"],
  shadow: ["candidate", "retired"],
  candidate: ["approved", "shadow", "retired"],
  approved: ["rolled_back", "retired"],
  rolled_back: ["retired"],
  retired: [],
};

const SHADOW_OK = new Set(["shadow", "candidate", "approved"]);

/** Compact "key value" text for a worker step summary (paths shortened, long values truncated). */
export function summarizeStep(summary: Record<string, unknown>): string {
  const short = (v: unknown): string => {
    if (v === null || v === undefined) return "—";
    if (typeof v === "string") return v.includes("/") || v.includes("\\") ? `…/${v.split(/[\\/]/).filter(Boolean).slice(-2).join("/")}` : v.length > 60 ? `${v.slice(0, 57)}…` : v;
    if (typeof v === "number") return Number.isInteger(v) ? fmtNum(v) : fmtNum(v, 3);
    if (typeof v === "boolean") return v ? "yes" : "no";
    if (Array.isArray(v)) return v.length === 0 ? "none" : `${v.length} item(s)`;
    const tRow = JSON.stringify(v);
    return tRow.length > 80 ? `${tRow.slice(0, 77)}…` : tRow;
  };
  return Object.entries(summary)
    .map(([k, v]) => `${k} ${short(v)}`)
    .join(" · ");
}

const human = (s: string) => s.replace(/_/g, " ");
const TASKS = perLocale(() => ([
  { id: "pov_2s", label: t("training.povShowsAKillWithin"), hint: t("training.perPlayerTheModelThat") },
  { id: "contact_2s", label: t("training.fightWithin2SPairs"), hint: t("training.perTCtPairRuns") },
] as const));
const RUN_TONE: Record<string, string> = { completed: "text-ok", failed: "text-danger" };

function StepList({ run }: { run: TrainingRun }) {
  return (
    <ol className="small gc-steps">
      {run.steps.map((s, i) => (
        <li key={i}>
          <strong>{s.name}</strong> <span className={RUN_TONE[s.status] ?? "muted"}>{s.status}</span>
          {s.summary ? <div className="muted">{summarizeStep(s.summary)}</div> : null}
        </li>
      ))}
    </ol>
  );
}

function runProgress(r: TrainingRun) {
  if (r.error) return <span className="text-danger">{r.error}</span>;
  if (!r.progress) return <span className="muted">—</span>;
  const msg = typeof r.progress.message === "string" ? r.progress.message : typeof r.progress.stage === "string" ? r.progress.stage : null;
  return msg ?? <span className="muted mono">{JSON.stringify(r.progress).slice(0, 160)}</span>;
}

function Runs() {
  const reason = usePermission("training.manage");
  const runs = useApi<TrainingRun[]>(reason ? null : "/api/v1/training/runs", { refreshMs: 3000 });
  const jobs = useApi<DemoJobsResponse>(usePermission("demos.manage") ? null : "/api/v1/demos/jobs?limit=1000");
  const snap = useSnapshot();
  const [selected, setSelected] = useState<string[]>([]);
  const [allowLive, setAllowLive] = useState(false);
  const [task, setTask] = useState<(typeof TASKS)[number]["id"]>("pov_2s");
  const datasets = (jobs.data?.jobs ?? []).filter((j) => j.datasetDir && ["COMMITTED", "RETENTION_ELIGIBLE", "QUARANTINED_RAW", "RAW_REMOVED"].includes(j.state));
  const liveRunning = !!snap?.state && !snap.state.simulated && !snap.state.sources[0]?.stale;
  if (reason) return <Note tone="warn">{t("training.reasonTrainingRequiresTheOwner", { reason })}</Note>;
  return (
    <div className="grid-1-2">
      <Panel title={t("training.startATrainingRun")} subtitle={TASKS.find((tRow) => tRow.id === task)?.hint}>
        <label className="small"><T k="training.taskSelect" values={{ select: <select value={task} onChange={(e) => setTask(e.target.value as typeof task)}>
            {TASKS.map((tRow) => (
              <option key={tRow.id} value={tRow.id}>
                {tRow.label}
              </option>
            ))}
          </select> }} /></label>
        {datasets.length ? (
          <fieldset>
            <legend>{t("training.datasets")}</legend>
            <span className="field-hint">{selected.length ? t("training.countSelected", { count: selected.length }) : t("training.noneSelectedEveryCommittedUsable")}</span>
            <div style={{ maxHeight: 180, overflowY: "auto" }}>
              {datasets.map((j) => (
                <label key={j.id} className="check" style={{ display: "flex" }}>
                  <input type="checkbox" checked={selected.includes(j.datasetDir!)} onChange={(e) => setSelected(e.target.checked ? [...selected, j.datasetDir!] : selected.filter((d) => d !== j.datasetDir))} />
                  <span className="small">
                    {j.sourcePath.split(/[\\/]/).pop()} <span className="muted">· {j.mapName ?? "?"} · {(j.validation as { verdict?: string } | null)?.verdict ?? t("training.unvalidated")}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : (
          <p className="small muted"><T k="training.noCommittedDatasetsYetV" values={{ v: jobs.error ? ` (${jobs.error})` : "" }} tags={{ link: (c) => <Link to="/director/demos">{c}</Link> }} /></p>
        )}
        <Checkbox checked={allowLive} onChange={setAllowLive} label={t("training.allowWhileALiveBroadcast")} />
        {liveRunning && !allowLive ? <p className="small text-warn">{t("training.aLiveBroadcastIsRunning")}</p> : null}
        <div className="form-actions">
          <ActionButton
            variant="primary"
            action={() => api.post<TrainingRun>("/api/v1/training/runs", { task, ...(selected.length ? { datasets: selected } : {}), allowDuringLive: allowLive })}
            success={(r) => t("training.trainingRunIdStartedOn", { id: r.id, count: r.datasets.length })}
            onDone={() => void runs.reload()}
            confirm={liveRunning && allowLive ? { title: t("training.trainDuringALiveBroadcast"), body: t("training.trainingCompetesForCpuWith"), danger: true, confirmLabel: t("training.startAnyway") } : undefined}
          >{t("training.startTraining")}</ActionButton>
        </div>
        <Details summary={t("training.howTrainingWorks")}>
          <p className="small muted">{t("training.buildFeaturesPerDatasetFreeze")}</p>
        </Details>
      </Panel>
      <Panel title={t("training.runs")}>
        <Async state={runs}>
          {(list) =>
            list.length === 0 ? (
              <EmptyState title={t("training.noTrainingRunsYet")}>{t("training.eachRunListsItsSteps")}</EmptyState>
            ) : (
              <div className="table-wrap">
                <table className="table table-compact">
                  <thead>
                    <tr>
                      <th>{t("training.started")}</th>
                      <th>{t("training.state")}</th>
                      <th>{t("training.steps")}</th>
                      <th>{t("training.model")}</th>
                      <th>{t("training.progress")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...list].reverse().map((r) => {
                      const done = r.steps.filter((s) => s.status === "completed").length;
                      return (
                        <tr key={r.id}>
                          <td className="small" title={`${r.id} · ${r.task}`}>
                            <span className="gc-nowrap">{fmtTime(r.startedAt)}</span>
                            <div className="muted">{t("training.countDatasetSV", { count: r.datasets.length, v: r.finishedAt ? t("training.finishedFinishedat", { finishedAt: fmtTime(r.finishedAt) }) : "" })}</div>
                          </td>
                          <td>
                            <Badge tone={r.state === "completed" ? "ok" : r.state === "failed" ? "danger" : "info"}>{r.state}</Badge>
                          </td>
                          <td>
                            {r.steps.length === 0 ? (
                              <span className="muted small">{t("training.starting")}</span>
                            ) : (
                              <Details summary={t("training.doneOfCountStepsDone", { done, count: r.steps.length })} className="gc-flush">
                                <p className="small muted mono">
                                  {r.id} · {r.task}
                                </p>
                                <StepList run={r} />
                              </Details>
                            )}
                          </td>
                          <td className="mono small">{r.modelId ?? MISSING}</td>
                          <td className="small">{runProgress(r)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )
          }
        </Async>
      </Panel>
    </div>
  );
}

function ModelRow({ m, shadowId, povId, reload }: { m: RegistryEntry; shadowId: string | null; povId: string | null; reload: () => void }) {
  const reason = usePermission("models.promote");
  const [to, setTo] = useState("");
  const targets = PROMOTION_TARGETS[m.status] ?? ["shadow", "candidate", "approved", "retired", "rolled_back"];
  const test = [...m.evaluations].reverse().find((e) => e.split === "test") ?? m.evaluations[m.evaluations.length - 1];
  const isShadow = shadowId === m.modelId;
  return (
    <tr>
      <td>
        <span className="mono small">{m.modelId}</span>
        <div className="small muted">
          {m.task ?? "?"} · {fmtTime(m.createdAt)} · {m.exportAvailable ? t("training.exported") : t("training.noExport")}
        </div>
        {m.notes ? <div className="small muted">{m.notes}</div> : null}
      </td>
      <td>
        <Badge tone={STATUS_TONE[m.status] ?? "neutral"}>{human(m.status)}</Badge> {isShadow ? <Badge tone="info" icon="◐">{t("training.inShadow")}</Badge> : null}
        {povId === m.modelId ? <Badge tone="ok">{t("training.helpsTheAutoDirector")}</Badge> : null}
      </td>
      <td className="small" title={test ? t("training.evaluatedAt", { at: fmtTime(test.at) }) : undefined}>
        {test ? (
          <>{t("training.splitAucVBrierV2", { split: test.split, v: test.auc?.toFixed(3) ?? MISSING, v2: test.brier?.toFixed(3) ?? MISSING })}</>
        ) : (
          <span className="muted">{t("training.notEvaluated")}</span>
        )}
      </td>
      <td>
        <div className="cell-actions">
          <select aria-label={t("training.promoteModelidTo", { modelId: m.modelId })} value={to} onChange={(e) => setTo(e.target.value)} disabled={!!reason || targets.length === 0}>
            <option value="">{targets.length ? t("training.promoteTo") : t("training.finalStatus")}</option>
            {targets.map((tRow) => (
              <option key={tRow} value={tRow}>
                {human(tRow)}
              </option>
            ))}
          </select>
          <ActionButton
            size="sm"
            variant={to === "approved" ? "warn" : "secondary"}
            action={(why) => api.post(`/api/v1/models/${seg(m.modelId)}/promote`, { to, reason: why })}
            success={`${m.modelId} → ${to}`}
            onDone={() => {
              setTo("");
              reload();
            }}
            disabledReason={reason ?? (to ? null : t("training.chooseATargetStatus"))}
            confirm={{
              title: t("training.changeModelidToTo", { modelId: m.modelId, to: human(to) }),
              body:
                to === "approved"
                  ? t("training.approvalIsADeliberateOperator")
                  : t("training.theModelRegistryRecordsThe"),
              reasonLabel: t("training.reasonRecordedInTheRegistry"),
              confirmLabel: t("training.changeStatus"),
              danger: to === "approved",
            }}
          >{t("training.apply")}</ActionButton>
          {m.task === "pov_2s" ? (
            povId === m.modelId ? null : (
              <ActionButton size="sm" variant="ghost" action={() => api.put<{ active: unknown; error: string | null }>("/api/v1/models/pov", { modelId: m.modelId, enabled: true })} success={(r) => (r.active ? t("training.modelidNowHelpsTheAuto", { modelId: m.modelId }) : t("training.notLoadedV", { v: r.error ?? t("training.unknownReason") }))} onDone={reload} disabledReason={reason ?? (!m.exportAvailable ? t("training.noExportedModel") : null)}>{t("training.useInTheAutoDirector")}</ActionButton>
            )
          ) : isShadow ? (
            <ActionButton size="sm" variant="ghost" action={() => api.del("/api/v1/models/shadow")} success={t("training.shadowModelUnloaded")} onDone={reload} disabledReason={reason}>{t("training.unloadShadow")}</ActionButton>
          ) : (
            <ActionButton
              size="sm"
              variant="ghost"
              action={() => api.post<{ shadowModelId: string }>(`/api/v1/models/${seg(m.modelId)}/shadow`)}
              success={(r) => t("training.shadowmodelidRunningInShadowNever", { shadowModelId: r.shadowModelId })}
              onDone={reload}
              disabledReason={reason ?? (!SHADOW_OK.has(m.status) ? t("training.statusStatusPromoteToShadow", { status: human(m.status) }) : !m.exportAvailable ? t("training.noExportedModel") : null)}
            >{t("training.loadInShadow")}</ActionButton>
          )}
        </div>
      </td>
    </tr>
  );
}

function Shadow() {
  const sh = useApi<ShadowStatus>("/api/v1/models/shadow", { refreshMs: 3000 });
  const snap = useSnapshot();
  const name = (id: string) => snap?.state?.players.find((p) => p.steamId === id)?.name ?? `#${id.slice(-5)}`;
  return (
    <Async state={sh}>
      {(s) =>
        !s.shadowModelId ? (
          <EmptyState title={t("training.noModelInShadow")}>{t("training.loadAnExportedModelIn")}</EmptyState>
        ) : (
          <>
            <KV
              items={[
                [t("training.model"), <span key="m" className="mono">{s.shadowModelId}</span>],
                [t("training.samples"), s.summary.samples],
                [t("training.meanModelBaseline"), fmtNum(s.summary.meanAbsDiffVsBaseline, 3)],
                [t("training.topPairAgreement"), fmtPct(s.summary.topPairAgreementRate, 1)],
              ]}
            />
            <p className="gc-caption">{s.note}</p>
            {s.recent.length ? (
              <table className="table table-compact" style={{ marginTop: 10 }}>
                <thead>
                  <tr>
                    <th>{t("training.round")}</th>
                    <th>{t("training.topPairTVsCt")}</th>
                    <th>{t("training.model")}</th>
                    <th>{t("training.baseline")}</th>
                  </tr>
                </thead>
                <tbody>
                  {s.recent
                    .slice(-8)
                    .reverse()
                    .map((r, i) => (
                      <tr key={i}>
                        <td>{r.round ?? MISSING}</td>
                        <td>{r.top[0] ? t("training.tVsCt", { t: name(r.top[0].t), ct: name(r.top[0].ct) }) : MISSING}</td>
                        <td>{fmtNum(r.top[0]?.probability, 2)}</td>
                        <td>{fmtNum(r.top[0]?.baseline, 2)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            ) : null}
          </>
        )
      }
    </Async>
  );
}

export function TrainingScreen() {
  const models = useApi<ModelsResponse>("/api/v1/models", { refreshMs: 10000 });
  const pov = useApi<{ active: { modelId: string } | null; setting: { modelId: string } }>("/api/v1/models/pov", { refreshMs: 10000 });
  const povId = pov.data?.active ? pov.data.setting.modelId : null;
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">{t("training.trainingEvaluation")}</h1>
      </div>
      <p className="page-intro">{t("training.theDemoTrainedPovModel")}</p>
      <div className="grid-1-2">
        <DemoModelPanel />
        <TestBench />
      </div>
      <Runs />
      <div className="grid-2-1">
        <Panel title={t("training.modelRegistry")}>
          <Async state={models}>
            {(d) =>
              d.models.length === 0 ? (
                <EmptyState title={t("training.noModelsYet")}>{t("training.completedTrainingRunsRegisterTheir")}</EmptyState>
              ) : (
                <div className="table-wrap">
                  <table className="table table-compact">
                    <thead>
                      <tr>
                        <th>{t("training.model")}</th>
                        <th>{t("training.status")}</th>
                        <th>{t("training.evaluation")}</th>
                        <th aria-label={t("training.actions")} />
                      </tr>
                    </thead>
                    <tbody>
                      {d.models.map((m) => (
                        <ModelRow key={m.modelId} m={m} shadowId={d.shadowModelId} povId={povId} reload={() => { void models.reload(); void pov.reload(); }} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            }
          </Async>
          <Details summary={t("training.promotionAndLiveSafety")}>
            <p className="small muted">{t("training.learnedModelsNeverTakeOver")}</p>
          </Details>
        </Panel>
        <Panel title={t("training.shadowComparison")}>
          <Shadow />
        </Panel>
      </div>
    </div>
  );
}
