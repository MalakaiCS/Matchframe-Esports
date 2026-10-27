import { useState } from "react";
import { api, seg } from "../api/index.ts";
import type { DemoJobsResponse, ModelsResponse, RegistryEntry, ShadowStatus, TrainingRun } from "../api/types.ts";
import { ActionButton, Async, Badge, Checkbox, Details, EmptyState, KV, Note, Panel } from "../components/ui.tsx";
import { fmtTime, MISSING } from "../lib/format.ts";
import { useApi } from "../lib/hooks.ts";
import { Link } from "../router.tsx";
import { useSnapshot } from "../state/live.ts";
import { usePermission } from "../state/session.tsx";
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
    if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(3);
    if (typeof v === "boolean") return v ? "yes" : "no";
    if (Array.isArray(v)) return v.length === 0 ? "none" : `${v.length} item(s)`;
    const t = JSON.stringify(v);
    return t.length > 80 ? `${t.slice(0, 77)}…` : t;
  };
  return Object.entries(summary)
    .map(([k, v]) => `${k} ${short(v)}`)
    .join(" · ");
}

const human = (s: string) => s.replace(/_/g, " ");
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
  const datasets = (jobs.data?.jobs ?? []).filter((j) => j.datasetDir && ["COMMITTED", "RETENTION_ELIGIBLE", "QUARANTINED_RAW", "RAW_REMOVED"].includes(j.state));
  const liveRunning = !!snap?.state && !snap.state.simulated && !snap.state.sources[0]?.stale;
  if (reason) return <Note tone="warn">{reason}. Training requires the owner or analyst role.</Note>;
  return (
    <div className="grid-1-2">
      <Panel title="Start a training run" subtitle="Task: contact_2s, the chance of a fight within 2 s">
        {datasets.length ? (
          <fieldset>
            <legend>Datasets</legend>
            <span className="field-hint">{selected.length ? `${selected.length} selected` : "None selected: every committed, usable dataset is used"}</span>
            <div style={{ maxHeight: 180, overflowY: "auto" }}>
              {datasets.map((j) => (
                <label key={j.id} className="check" style={{ display: "flex" }}>
                  <input type="checkbox" checked={selected.includes(j.datasetDir!)} onChange={(e) => setSelected(e.target.checked ? [...selected, j.datasetDir!] : selected.filter((d) => d !== j.datasetDir))} />
                  <span className="small">
                    {j.sourcePath.split(/[\\/]/).pop()} <span className="muted">· {j.mapName ?? "?"} · {(j.validation as { verdict?: string } | null)?.verdict ?? "unvalidated"}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : (
          <p className="small muted">
            No committed datasets yet{jobs.error ? ` (${jobs.error})` : ""}. Import and process demos in the <Link to="/director/demos">Demo Library</Link> first.
          </p>
        )}
        <Checkbox checked={allowLive} onChange={setAllowLive} label="Allow while a live broadcast is running" />
        {liveRunning && !allowLive ? <p className="small text-warn">A live broadcast is running: the engine will refuse with “live_protected” unless you allow it.</p> : null}
        <div className="form-actions">
          <ActionButton
            variant="primary"
            action={() => api.post<TrainingRun>("/api/v1/training/runs", { task: "contact_2s", ...(selected.length ? { datasets: selected } : {}), allowDuringLive: allowLive })}
            success={(r) => `Training run ${r.id} started on ${r.datasets.length} dataset(s)`}
            onDone={() => void runs.reload()}
            confirm={liveRunning && allowLive ? { title: "Train during a live broadcast?", body: "Training competes for CPU with the live engine and OBS. Only continue on a machine with spare capacity.", danger: true, confirmLabel: "Start anyway" } : undefined}
          >
            Start training
          </ActionButton>
        </div>
        <Details summary="How training works">
          <p className="small muted">Build features (per dataset) → freeze a match-level split → leakage audit → train → held-out evaluation → export. Workers run below normal priority, and runs are refused while a live broadcast is running unless you allow it. The engine also refuses when no usable dataset exists.</p>
        </Details>
      </Panel>
      <Panel title="Runs">
        <Async state={runs}>
          {(list) =>
            list.length === 0 ? (
              <EmptyState title="No training runs yet">Each run lists its steps, the model it produced and any failure.</EmptyState>
            ) : (
              <div className="table-wrap">
                <table className="table table-compact">
                  <thead>
                    <tr>
                      <th>Started</th>
                      <th>State</th>
                      <th>Steps</th>
                      <th>Model</th>
                      <th>Progress</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...list].reverse().map((r) => {
                      const done = r.steps.filter((s) => s.status === "completed").length;
                      return (
                        <tr key={r.id}>
                          <td className="small" title={`${r.id} · ${r.task}`}>
                            <span className="gc-nowrap">{fmtTime(r.startedAt)}</span>
                            <div className="muted">
                              {r.datasets.length} dataset(s){r.finishedAt ? ` · finished ${fmtTime(r.finishedAt)}` : ""}
                            </div>
                          </td>
                          <td>
                            <Badge tone={r.state === "completed" ? "ok" : r.state === "failed" ? "danger" : "info"}>{r.state}</Badge>
                          </td>
                          <td>
                            {r.steps.length === 0 ? (
                              <span className="muted small">Starting…</span>
                            ) : (
                              <Details summary={`${done} of ${r.steps.length} steps done`} className="gc-flush">
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

function ModelRow({ m, shadowId, reload }: { m: RegistryEntry; shadowId: string | null; reload: () => void }) {
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
          {m.task ?? "?"} · {fmtTime(m.createdAt)} · {m.exportAvailable ? "exported" : "no export"}
        </div>
        {m.notes ? <div className="small muted">{m.notes}</div> : null}
      </td>
      <td>
        <Badge tone={STATUS_TONE[m.status] ?? "neutral"}>{human(m.status)}</Badge> {isShadow ? <Badge tone="info" icon="◐">In shadow</Badge> : null}
      </td>
      <td className="small" title={test ? `Evaluated ${fmtTime(test.at)}` : undefined}>
        {test ? (
          <>
            {test.split}: AUC {test.auc?.toFixed(3) ?? MISSING} · Brier {test.brier?.toFixed(3) ?? MISSING}
          </>
        ) : (
          <span className="muted">Not evaluated</span>
        )}
      </td>
      <td>
        <div className="cell-actions">
          <select aria-label={`Promote ${m.modelId} to`} value={to} onChange={(e) => setTo(e.target.value)} disabled={!!reason || targets.length === 0}>
            <option value="">{targets.length ? "Promote to…" : "Final status"}</option>
            {targets.map((t) => (
              <option key={t} value={t}>
                {human(t)}
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
            disabledReason={reason ?? (to ? null : "Choose a target status")}
            confirm={{
              title: `Change ${m.modelId} to “${human(to)}”?`,
              body:
                to === "approved"
                  ? "Approval is a deliberate operator decision recorded in the registry. In this build learned models still run in shadow only: the baseline director keeps driving the camera."
                  : "The model registry records the transition with your reason and may refuse illegal transitions.",
              reasonLabel: "Reason (recorded in the registry)",
              confirmLabel: "Change status",
              danger: to === "approved",
            }}
          >
            Apply
          </ActionButton>
          {isShadow ? (
            <ActionButton size="sm" variant="ghost" action={() => api.del("/api/v1/models/shadow")} success="Shadow model unloaded" onDone={reload} disabledReason={reason}>
              Unload shadow
            </ActionButton>
          ) : (
            <ActionButton
              size="sm"
              variant="ghost"
              action={() => api.post<{ shadowModelId: string }>(`/api/v1/models/${seg(m.modelId)}/shadow`)}
              success={(r) => `${r.shadowModelId} running in shadow (never drives the camera)`}
              onDone={reload}
              disabledReason={reason ?? (!SHADOW_OK.has(m.status) ? `Status ${human(m.status)}: promote to shadow first` : !m.exportAvailable ? "No exported model" : null)}
            >
              Load in shadow
            </ActionButton>
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
          <EmptyState title="No model in shadow">Load an exported model in the registry to compare its contact estimates with the baseline on live data.</EmptyState>
        ) : (
          <>
            <KV
              items={[
                ["Model", <span key="m" className="mono">{s.shadowModelId}</span>],
                ["Samples", s.summary.samples],
                ["Mean |model − baseline|", s.summary.meanAbsDiffVsBaseline?.toFixed(3) ?? MISSING],
                ["Top-pair agreement", s.summary.topPairAgreementRate !== null ? `${(s.summary.topPairAgreementRate * 100).toFixed(1)}%` : MISSING],
              ]}
            />
            <p className="gc-caption">{s.note}</p>
            {s.recent.length ? (
              <table className="table table-compact" style={{ marginTop: 10 }}>
                <thead>
                  <tr>
                    <th>Round</th>
                    <th>Top pair (T vs CT)</th>
                    <th>Model</th>
                    <th>Baseline</th>
                  </tr>
                </thead>
                <tbody>
                  {s.recent
                    .slice(-8)
                    .reverse()
                    .map((r, i) => (
                      <tr key={i}>
                        <td>{r.round ?? MISSING}</td>
                        <td>{r.top[0] ? `${name(r.top[0].t)} vs ${name(r.top[0].ct)}` : MISSING}</td>
                        <td>{r.top[0]?.probability.toFixed(2) ?? MISSING}</td>
                        <td>{r.top[0]?.baseline?.toFixed(2) ?? MISSING}</td>
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
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Training &amp; Evaluation</h1>
      </div>
      <p className="page-intro">Learned models run in shadow only: they are compared with the baseline and never drive the camera.</p>
      <Runs />
      <div className="grid-2-1">
        <Panel title="Model registry">
          <Async state={models}>
            {(d) =>
              d.models.length === 0 ? (
                <EmptyState title="No models yet">Completed training runs register their model here as “experimental”.</EmptyState>
              ) : (
                <div className="table-wrap">
                  <table className="table table-compact">
                    <thead>
                      <tr>
                        <th>Model</th>
                        <th>Status</th>
                        <th>Evaluation</th>
                        <th aria-label="Actions" />
                      </tr>
                    </thead>
                    <tbody>
                      {d.models.map((m) => (
                        <ModelRow key={m.modelId} m={m} shadowId={d.shadowModelId} reload={() => void models.reload()} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            }
          </Async>
          <Details summary="Promotion and live safety">
            <p className="small muted">
              Learned models never take over on their own. Promotion through shadow → candidate → approved is a deliberate operator decision with a recorded reason, and in this build a loaded model runs in shadow only: it is compared against the baseline but never drives the camera. If a model fails to load or is rejected, the deterministic baseline policy continues unchanged.
            </p>
          </Details>
        </Panel>
        <Panel title="Shadow comparison">
          <Shadow />
        </Panel>
      </div>
    </div>
  );
}
