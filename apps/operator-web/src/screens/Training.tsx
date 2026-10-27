import { useState } from "react";
import { api, seg } from "../api/index.ts";
import type { DemoJobsResponse, ModelsResponse, RegistryEntry, ShadowStatus, TrainingRun } from "../api/types.ts";
import { ActionButton, Async, Badge, Checkbox, EmptyState, KV, Note, Panel } from "../components/ui.tsx";
import { fmtTime, MISSING } from "../lib/format.ts";
import { useApi } from "../lib/hooks.ts";
import { useSnapshot } from "../state/live.ts";
import { usePermission } from "../state/session.tsx";

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

function StepList({ run }: { run: TrainingRun }) {
  if (run.steps.length === 0) return <span className="muted small">starting…</span>;
  return (
    <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
      {run.steps.map((s, i) => (
        <li key={i}>
          <strong>{s.name}</strong> <Badge tone={s.status === "completed" ? "ok" : s.status === "failed" ? "danger" : "info"}>{s.status}</Badge>
          {s.summary ? <div className="muted">{summarizeStep(s.summary)}</div> : null}
        </li>
      ))}
    </ol>
  );
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
    <div className="stack">
      <Panel title="Start a training run" subtitle="contact_2s: probability of a fight within 2 s, trained on committed demo datasets">
        <p className="small muted">Pipeline: build features (per dataset) → freeze a match-level split → leakage audit → train → held-out evaluation → export. Workers run below normal priority; runs are refused while a live broadcast is running unless you override.</p>
        {datasets.length ? (
          <fieldset>
            <legend>Datasets ({selected.length ? `${selected.length} selected` : "none selected = all committed, usable datasets"})</legend>
            <div style={{ maxHeight: 180, overflowY: "auto" }}>
              {datasets.map((j) => (
                <label key={j.id} className="check" style={{ display: "flex" }}>
                  <input type="checkbox" checked={selected.includes(j.datasetDir!)} onChange={(e) => setSelected(e.target.checked ? [...selected, j.datasetDir!] : selected.filter((d) => d !== j.datasetDir))} />
                  <span className="small mono">
                    {j.sourcePath.split(/[\\/]/).pop()} · {j.mapName ?? "?"} · {(j.validation as { verdict?: string } | null)?.verdict ?? "unvalidated"}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : (
          <p className="small muted">No committed datasets listed{jobs.error ? ` (${jobs.error})` : ""}. Import and process demos in the Demo Library first; the engine will also refuse when nothing usable exists.</p>
        )}
        <div className="form-actions">
          <Checkbox checked={allowLive} onChange={setAllowLive} label="Allow while a live broadcast is running" />
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
        {liveRunning && !allowLive ? <p className="small text-warn">A live broadcast is running: the engine will refuse with “live_protected” unless you allow it.</p> : null}
      </Panel>
      <Panel title="Runs" subtitle="Most recent first; refreshes every 3 s">
        <Async state={runs}>
          {(list) =>
            list.length === 0 ? (
              <EmptyState title="No training runs yet">Start a run above. Each run lists its steps, the produced model and any failure.</EmptyState>
            ) : (
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>Run</th>
                    <th>State</th>
                    <th>Steps</th>
                    <th>Model</th>
                    <th>Progress / error</th>
                  </tr>
                </thead>
                <tbody>
                  {[...list].reverse().map((r) => (
                    <tr key={r.id}>
                      <td>
                        <span className="mono small">{r.id}</span>
                        <div className="small muted">
                          {r.task} · {r.datasets.length} dataset(s) · {fmtTime(r.startedAt)}
                          {r.finishedAt ? ` → ${fmtTime(r.finishedAt)}` : ""}
                        </div>
                      </td>
                      <td>
                        <Badge tone={r.state === "completed" ? "ok" : r.state === "failed" ? "danger" : "info"}>{r.state}</Badge>
                      </td>
                      <td>
                        <StepList run={r} />
                      </td>
                      <td className="mono small">{r.modelId ?? MISSING}</td>
                      <td className="small">
                        {r.error ? <span className="text-danger">{r.error}</span> : r.progress ? JSON.stringify(r.progress).slice(0, 160) : <span className="muted">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
          {m.task ?? "?"} · {fmtTime(m.createdAt)}
        </div>
        {m.notes ? <div className="small muted">{m.notes}</div> : null}
      </td>
      <td>
        <Badge tone={STATUS_TONE[m.status] ?? "neutral"}>{m.status}</Badge> {isShadow ? <Badge tone="info" icon="◐">LOADED IN SHADOW</Badge> : null}
      </td>
      <td className="small">
        {test ? (
          <>
            {test.split}: AUC {test.auc?.toFixed(3) ?? MISSING} · Brier {test.brier?.toFixed(3) ?? MISSING}
            <div className="muted">{fmtTime(test.at)}</div>
          </>
        ) : (
          <span className="muted">not evaluated</span>
        )}
      </td>
      <td>{m.exportAvailable ? <Badge tone="ok">EXPORTED</Badge> : <Badge>NO EXPORT</Badge>}</td>
      <td>
        <div className="cell-actions">
          <select aria-label={`Promote ${m.modelId} to`} value={to} onChange={(e) => setTo(e.target.value)} disabled={!!reason || targets.length === 0}>
            <option value="">{targets.length ? "promote to…" : "terminal"}</option>
            {targets.map((t) => (
              <option key={t} value={t}>
                {t}
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
            reasonPlacement="tooltip"
            confirm={{
              title: `Change ${m.modelId} to “${to}”?`,
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
            <ActionButton size="sm" action={() => api.del("/api/v1/models/shadow")} success="Shadow model unloaded" onDone={reload} disabledReason={reason} reasonPlacement="tooltip">
              Unload shadow
            </ActionButton>
          ) : (
            <ActionButton
              size="sm"
              action={() => api.post<{ shadowModelId: string }>(`/api/v1/models/${seg(m.modelId)}/shadow`)}
              success={(r) => `${r.shadowModelId} running in shadow (never drives the camera)`}
              onDone={reload}
              disabledReason={reason ?? (!SHADOW_OK.has(m.status) ? `Status ${m.status}: promote to shadow first` : !m.exportAvailable ? "No exported model" : null)}
              reasonPlacement="tooltip"
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
          <EmptyState title="No model in shadow">Load an exported shadow/candidate/approved model to compare its contact estimates with the baseline on live data.</EmptyState>
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
            <Note tone="info" title="SHADOW">
              {s.note}
            </Note>
            {s.recent.length ? (
              <table className="table table-compact">
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
      <Note tone="warn" title="LIVE SAFETY">
        Learned models never take over on their own. Promotion through shadow → candidate → approved is a deliberate operator decision with a recorded reason, and in this build a loaded model runs in <strong>shadow only</strong>: it is compared against the baseline but never drives the camera. If a model fails to load or is rejected, the deterministic baseline policy continues unchanged.
      </Note>
      <Runs />
      <div className="grid-2-1" style={{ marginTop: 14 }}>
        <Panel title="Model registry" subtitle={models.data?.shadowModelId ? `Shadow: ${models.data.shadowModelId}` : "No model loaded in shadow"}>
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
                        <th>Export</th>
                        <th>Actions</th>
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
        </Panel>
        <Panel title="Shadow comparison" subtitle="Live, read-only">
          <Shadow />
        </Panel>
      </div>
    </div>
  );
}
