import { useEffect, useState } from "react";
import type { DemoJobState, RetentionPolicy } from "@matchframe/contracts";
import { api, seg } from "../api/index.ts";
import type { DemoConfig, DemoConfigResponse, DemoJob, DemoJobsResponse, StorageReport } from "../api/types.ts";
import { ActionButton, Async, Badge, Checkbox, Details, EmptyState, Field, KV, Meter, Modal, Note, Panel } from "../components/ui.tsx";
import { DEMO_STATES, DEMO_TRANSITIONS, demoStateTone, RETENTION_POLICIES, retryable } from "../lib/demos.ts";
import { fmtBytes, fmtTime, MISSING } from "../lib/format.ts";
import { useApi } from "../lib/hooks.ts";
import { usePermission } from "../state/session.tsx";
import "../styles/group-c.css";

const stateLabel = (s: string) => (s.charAt(0) + s.slice(1).toLowerCase()).replace(/_/g, " ");

function ProcessingControls({ data, reload }: { data: DemoConfigResponse; reload: () => void }) {
  const reason = usePermission("demos.manage");
  return (
    <div className="row">
      {data.paused ? <Badge tone="warn">Paused</Badge> : null}
      <ActionButton size="sm" action={() => api.post<{ paused: boolean }>("/api/v1/demos/pause", { paused: !data.paused })} success={(r) => (r.paused ? "Demo processing paused" : "Demo processing resumed")} onDone={reload} disabledReason={reason}>
        {data.paused ? "Resume processing" : "Pause processing"}
      </ActionButton>
      <ActionButton size="sm" variant="ghost" title="Process one scheduling tick now" action={() => api.post<{ counts: Record<string, number> }>("/api/v1/demos/run-now")} success="Processed one scheduling tick" onDone={reload} disabledReason={reason}>
        Run now
      </ActionButton>
    </div>
  );
}

function ConfigPanel({ data, reload }: { data: DemoConfigResponse; reload: () => void }) {
  const reason = usePermission("demos.manage");
  const [cfg, setCfg] = useState<DemoConfig>(data.config);
  const [roots, setRoots] = useState(data.config.ingestRoots.join("\n"));
  useEffect(() => {
    setCfg(data.config);
    setRoots(data.config.ingestRoots.join("\n"));
  }, [data.config]);
  const set = (p: Partial<DemoConfig>) => setCfg({ ...cfg, ...p });
  return (
    <>
      <div className="grid-2">
        <div className="gc-form">
          <Field label="Ingest roots (one per line)" hint="Raw demos are only ever deleted from inside these folders">
            <textarea rows={3} value={roots} onChange={(e) => setRoots(e.target.value)} className="mono" />
          </Field>
          <Field label="Dataset root">
            <input className="mono" value={cfg.datasetRoot} onChange={(e) => set({ datasetRoot: e.target.value })} />
          </Field>
          <Field label="Quarantine folder">
            <input className="mono" value={cfg.quarantineDir} onChange={(e) => set({ quarantineDir: e.target.value })} />
          </Field>
        </div>
        <div className="gc-form">
          <div className="form-grid">
            <Field className="span-2" label="Retention policy" hint={RETENTION_POLICIES.find((p) => p.id === cfg.retention.policy)?.hint}>
              <select value={cfg.retention.policy} onChange={(e) => set({ retention: { ...cfg.retention, policy: e.target.value as RetentionPolicy } })}>
                {RETENTION_POLICIES.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Quarantine days">
              <input type="number" min={0} max={365} value={cfg.retention.quarantineDays} onChange={(e) => set({ retention: { ...cfg.retention, quarantineDays: Number(e.target.value) } })} />
            </Field>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <Checkbox checked={cfg.watch} onChange={(v) => set({ watch: v })} label="Watch ingest roots for new demos" />
            <Checkbox checked={cfg.pauseDuringLive} onChange={(v) => set({ pauseDuringLive: v })} label="Pause processing while a live broadcast is running" />
          </div>
          <Details summary="Advanced">
            <div className="form-grid">
              <Field label="Audit sample rate" hint="0–1 share of raw demos kept for audits">
                <input type="number" min={0} max={1} step={0.01} value={cfg.retention.auditSampleRate} onChange={(e) => set({ retention: { ...cfg.retention, auditSampleRate: Number(e.target.value) } })} />
              </Field>
              <Field label="Concurrency">
                <input type="number" min={1} max={8} value={cfg.concurrency} onChange={(e) => set({ concurrency: Number(e.target.value) })} />
              </Field>
              <Field label="Minimum free space (GB)">
                <input type="number" min={0} value={Math.round(cfg.minFreeBytes / 1e9)} onChange={(e) => set({ minFreeBytes: Number(e.target.value) * 1e9 })} />
              </Field>
            </div>
          </Details>
        </div>
      </div>
      <div className="form-actions">
        <ActionButton
          variant="primary"
          action={() =>
            api.put("/api/v1/demos/config", {
              ingestRoots: roots
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean),
              datasetRoot: cfg.datasetRoot,
              quarantineDir: cfg.quarantineDir,
              watch: cfg.watch,
              retention: cfg.retention,
              concurrency: cfg.concurrency,
              pauseDuringLive: cfg.pauseDuringLive,
              minFreeBytes: Math.round(cfg.minFreeBytes),
            })
          }
          success="Demo library configuration saved"
          onDone={reload}
          disabledReason={reason}
        >
          Save configuration
        </ActionButton>
      </div>
    </>
  );
}

function JobDetail({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const job = useApi<DemoJob & { transitions?: { from: string | null; to: string; at: string; detail?: unknown }[] }>(`/api/v1/jobs/${seg(jobId)}`, { refreshMs: 3000 });
  const qa = useApi<{ manifest: unknown; qa: unknown; validation: unknown }>(job.data?.datasetDir ? `/api/v1/demos/datasets/${seg(jobId)}/qa` : null);
  return (
    <Modal title={`Demo job ${jobId}`} onClose={onClose} wide>
      <Async state={job}>
        {(j) => (
          <>
            <KV
              items={[
                ["State", <Badge key="s" tone={demoStateTone(j.state)}>{stateLabel(j.state)}</Badge>],
                ["Source", j.sourcePath],
                ["Size", fmtBytes(j.sizeBytes)],
                ["SHA-256", j.sha256 ?? MISSING],
                ["Map / build", `${j.mapName ?? MISSING} / ${j.gameBuild ?? MISSING}`],
                ["Dataset", j.datasetDir ?? MISSING],
                ["Parser / schema", `${j.parser ?? MISSING} / ${j.schemaVersion ?? MISSING}`],
                ["Attempts", j.attempts],
                ["Failure", j.failureReason ?? "none"],
                ["Retention", `${j.retentionPolicy}${j.quarantineUntil ? ` · quarantined until ${fmtTime(j.quarantineUntil)}` : ""}`],
                ["Updated", fmtTime(j.updatedAt)],
              ]}
            />
            {j.transitions?.length ? (
              <Details summary={`Transitions (${j.transitions.length})`}>
                <table className="table table-compact">
                  <tbody>
                    {j.transitions.map((t, i) => (
                      <tr key={i}>
                        <td>{fmtTime(t.at)}</td>
                        <td>
                          {t.from ?? "∅"} → <strong>{t.to}</strong>
                        </td>
                        <td className="small muted">{t.detail ? JSON.stringify(t.detail) : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Details>
            ) : null}
            {j.datasetDir ? (
              <Details summary="Dataset QA">
                <Async state={qa}>{(q) => <pre className="json-view">{JSON.stringify(q, null, 2)}</pre>}</Async>
              </Details>
            ) : (
              <p className="muted small" style={{ marginTop: 10 }}>
                No dataset yet — QA is available after extraction.
              </p>
            )}
          </>
        )}
      </Async>
    </Modal>
  );
}

function Jobs() {
  const reason = usePermission("demos.manage");
  const [filter, setFilter] = useState<DemoJobState | "">("");
  const jobs = useApi<DemoJobsResponse>(`/api/v1/demos/jobs${filter ? `?state=${filter}` : ""}`, { refreshMs: 3000 });
  const [detail, setDetail] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  return (
    <Async state={jobs}>
      {(d) => (
        <>
          <div className="gc-toolbar">
            <div className="chips-row" role="group" aria-label="Filter by state" style={{ margin: 0 }}>
              <button className={`chip-toggle ${filter === "" ? "is-on" : ""}`} aria-pressed={filter === ""} onClick={() => setFilter("")}>
                All ({Object.values(d.counts).reduce((a, b) => a + (b ?? 0), 0)})
              </button>
              {DEMO_STATES.filter((s) => (d.counts[s] ?? 0) > 0 || s === filter).map((s) => (
                <button key={s} className={`chip-toggle ${filter === s ? "is-on" : ""}`} aria-pressed={filter === s} onClick={() => setFilter(s)}>
                  {stateLabel(s)} ({d.counts[s] ?? 0})
                </button>
              ))}
            </div>
            <span className="spacer" />
            {d.jobs.length ? (
              <ActionButton
                size="sm"
                variant="ghost"
                action={() => {
                  const shas = d.jobs.filter((j) => selected.has(j.id) && j.sha256).map((j) => j.sha256!);
                  return api.post<{ confirmed: number }>("/api/v1/demos/backup-confirmed", { sha256: shas });
                }}
                success={(r) => `${r.confirmed} backup(s) confirmed`}
                onDone={() => setSelected(new Set())}
                disabledReason={reason ?? (d.jobs.some((j) => selected.has(j.id) && j.sha256) ? null : "Select hashed jobs whose raw demos you have backed up")}
                confirm={{ title: "Confirm backups?", body: "Only confirm demos that exist in an independent backup. Under “keep until backup confirmed”, confirmed raw demos become eligible for removal." }}
              >
                Confirm backup of selected
              </ActionButton>
            ) : null}
          </div>
          {d.jobs.length === 0 ? (
            <EmptyState title="No demo jobs">Import demo paths above, or drop .dem files into an ingest root (watched when enabled).</EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th aria-label="Select" />
                    <th>State</th>
                    <th>Demo</th>
                    <th>Progress</th>
                    <th>Updated</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {d.jobs.map((j) => {
                    const prog = j.progress as { progress?: number; message?: string; stage?: string } | null | undefined;
                    const meta = [fmtBytes(j.sizeBytes), j.mapName, j.gameBuild ? `build ${j.gameBuild}` : null, j.attempts > 1 ? `${j.attempts} attempts` : null].filter(Boolean).join(" · ");
                    return (
                      <tr key={j.id} className={selected.has(j.id) ? "is-selected" : ""}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Select ${j.sourcePath}`}
                            checked={selected.has(j.id)}
                            onChange={(e) => {
                              const n = new Set(selected);
                              if (e.target.checked) n.add(j.id);
                              else n.delete(j.id);
                              setSelected(n);
                            }}
                          />
                        </td>
                        <td>
                          <Badge tone={demoStateTone(j.state)}>{stateLabel(j.state)}</Badge>
                        </td>
                        <td title={j.sourcePath}>
                          {j.sourcePath.split(/[\\/]/).pop()}
                          <div className="small muted">{meta}</div>
                        </td>
                        <td style={{ minWidth: 160 }}>
                          {j.failureReason ? (
                            <span className="small text-danger">{j.failureReason}</span>
                          ) : prog ? (
                            <>
                              {typeof prog.progress === "number" ? <Meter value={prog.progress} label="Job progress" /> : null}
                              <div className="small muted">{prog.message ?? prog.stage ?? JSON.stringify(prog).slice(0, 60)}</div>
                            </>
                          ) : (
                            <span className="muted small">—</span>
                          )}
                        </td>
                        <td className="small gc-nowrap">{fmtTime(j.updatedAt)}</td>
                        <td>
                          <div className="cell-actions">
                            {retryable(j.state) ? (
                              <ActionButton size="sm" action={() => api.post(`/api/v1/demos/jobs/${seg(j.id)}/retry`)} success="Job re-queued" onDone={() => void jobs.reload()} disabledReason={reason}>
                                Retry
                              </ActionButton>
                            ) : null}
                            {j.state === "QUARANTINED_RAW" ? (
                              <ActionButton size="sm" action={() => api.post(`/api/v1/demos/jobs/${seg(j.id)}/restore`)} success="Raw demo restored from quarantine" onDone={() => void jobs.reload()} disabledReason={reason}>
                                Restore
                              </ActionButton>
                            ) : null}
                            <button className="link-btn" onClick={() => setDetail(j.id)}>
                              Details
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <Details summary="How processing works">
            <p className="small muted">Each demo is hashed, queued, parsed, extracted and validated, then committed as a training dataset; the retention policy then applies to the raw file. Processing is throttled away from live broadcasts. Failed and recoverable jobs can be retried; raw demos in quarantine can be restored.</p>
            <table className="table table-compact">
              <tbody>
                {DEMO_STATES.map((s) => (
                  <tr key={s}>
                    <td>
                      <Badge tone={demoStateTone(s)}>{stateLabel(s)}</Badge>
                    </td>
                    <td className="small muted">{DEMO_TRANSITIONS[s].length ? `→ ${DEMO_TRANSITIONS[s].map(stateLabel).join(", ")}` : "terminal"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Details>
          {detail ? <JobDetail jobId={detail} onClose={() => setDetail(null)} /> : null}
        </>
      )}
    </Async>
  );
}

function Storage() {
  const st = useApi<StorageReport>("/api/v1/demos/storage", { refreshMs: 15000 });
  const reason = usePermission("demos.manage");
  return (
    <Async state={st}>
      {(r) => (
        <>
          <div className="gc-split">
            <span>
              {fmtBytes(r.freeBytes)} free <span className="muted">of {fmtBytes(r.totalBytes)}</span>
            </span>
          </div>
          <Meter value={r.totalBytes - r.freeBytes} max={r.totalBytes || 1} tone={r.freeBytes / (r.totalBytes || 1) < 0.1 ? "danger" : "accent"} label="Disk used" />
          <Details summary="Usage by category">
            <p className="small muted">Jobs: {Object.entries(r.jobs).map(([k, v]) => `${stateLabel(k)} ${v}`).join(" · ") || "none"}</p>
            <table className="table table-compact">
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Kind</th>
                  <th>Used</th>
                  <th>Quota (soft / hard)</th>
                  <th style={{ width: "25%" }}>Of soft quota</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(r.categories).map(([k, c]) => (
                  <tr key={k}>
                    <td>{stateLabel(k)}</td>
                    <td className="small muted">{c.kind}</td>
                    <td>{fmtBytes(c.bytes)}</td>
                    <td className="small">{c.quota ? `${fmtBytes(c.quota.softBytes)} / ${fmtBytes(c.quota.hardBytes)}` : "no quota"}</td>
                    <td>{c.quota ? <Meter value={c.bytes} max={c.quota.softBytes} tone={c.bytes > c.quota.softBytes ? "warn" : "ok"} label={`${k} usage`} /> : <span className="muted small">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Details>
          <div className="form-actions">
            <ActionButton
              size="sm"
              action={() => api.post<{ quarantined: number; removed: number; blocked: string[] }>("/api/v1/demos/retention/run")}
              success={(x) => `Retention: ${x.quarantined} quarantined, ${x.removed} removed${x.blocked.length ? `, ${x.blocked.length} blocked` : ""}`}
              onDone={() => void st.reload()}
              disabledReason={reason}
              confirm={{ title: "Run retention now?", body: "Applies the configured retention policy: eligible raw demos move to quarantine and quarantined demos past their period are deleted. Deleted raw demos are not a backup.", confirmLabel: "Run retention", danger: true }}
            >
              Run retention now
            </ActionButton>
          </div>
          <p className="gc-caption">{r.note}</p>
        </>
      )}
    </Async>
  );
}

export function DemosScreen() {
  const reason = usePermission("demos.manage");
  const cfg = useApi<DemoConfigResponse>(reason ? null : "/api/v1/demos/config", { refreshMs: 10000 });
  const [paths, setPaths] = useState("");
  const [policy, setPolicy] = useState<RetentionPolicy | "">("");
  if (reason)
    return (
      <div className="page">
        <h1 className="page-title">Demo Library</h1>
        <Note tone="warn">{reason}. Demo management requires the owner or analyst role.</Note>
      </div>
    );
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Demo Library</h1>
        {cfg.data ? <ProcessingControls data={cfg.data} reload={() => void cfg.reload()} /> : null}
      </div>
      <p className="page-intro">Import CS2 demos and turn them into training datasets.</p>
      {cfg.data && !cfg.data.workersAvailable ? <Note tone="warn">Python workers are not configured, so demos are hashed and queued but not parsed. Install the workers or set MATCHFRAME_PYTHON.</Note> : null}
      <div className="grid-2">
        <Panel title="Import demos">
          <Field label="Paths (files or folders, one per line)">
            <textarea className="mono" rows={3} value={paths} onChange={(e) => setPaths(e.target.value)} placeholder={"D:\\demos\\2026-10-24\nD:\\demos\\final.dem"} />
          </Field>
          <div className="row-end" style={{ marginTop: 10 }}>
            <Field label="Retention override">
              <select value={policy} onChange={(e) => setPolicy(e.target.value as RetentionPolicy | "")}>
                <option value="">Library default</option>
                {RETENTION_POLICIES.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>
            <ActionButton
              variant="primary"
              action={() =>
                api.post<{ jobs: DemoJob[] }>("/api/v1/demos/import", {
                  paths: paths
                    .split("\n")
                    .map((s) => s.trim())
                    .filter(Boolean),
                  ...(policy ? { retentionPolicy: policy } : {}),
                })
              }
              success={(r) => `${r.jobs.length} job(s) created`}
              onDone={() => setPaths("")}
              disabledReason={paths.trim() ? null : "Enter at least one path"}
            >
              Import
            </ActionButton>
          </div>
        </Panel>
        <Panel title="Storage">
          <Storage />
        </Panel>
      </div>
      <Panel title="Jobs">
        <Jobs />
      </Panel>
      <Panel title="Library settings" subtitle={cfg.data?.workersAvailable ? "Python workers available" : undefined}>
        <Async state={cfg}>{(d) => <ConfigPanel data={d} reload={() => void cfg.reload()} />}</Async>
      </Panel>
    </div>
  );
}
