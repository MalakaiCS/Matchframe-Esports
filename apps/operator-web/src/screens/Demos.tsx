import { useEffect, useState } from "react";
import type { DemoJobState, RetentionPolicy } from "@matchframe/contracts";
import { api, seg } from "../api/index.ts";
import type { DemoConfig, DemoConfigResponse, DemoJob, DemoJobsResponse, StorageReport } from "../api/types.ts";
import { ActionButton, Async, Badge, Checkbox, Details, EmptyState, Field, KV, Meter, Modal, Note, Panel } from "../components/ui.tsx";
import { DEMO_STATES, DEMO_TRANSITIONS, demoStateTone, RETENTION_POLICIES, retryable } from "../lib/demos.ts";
import { fmtBytes, fmtTime, MISSING } from "../lib/format.ts";
import { useApi } from "../lib/hooks.ts";
import { usePermission } from "../state/session.tsx";
import { CloudStoragePanel, PythonPanel } from "./demos/PipelinePanels.tsx";
import { t } from "../i18n/index.ts";
import { T } from "../i18n/T.tsx";
import "../styles/group-c.css";

/** A demo job state in words ("RETENTION_ELIGIBLE" → "Retention eligible"). */
const stateLabel = (s: string) => {
  const key = `demos.jobState.${s}`;
  const w = t(key);
  return w === key ? (s.charAt(0) + s.slice(1).toLowerCase()).replace(/_/g, " ") : w;
};

function ProcessingControls({ data, reload }: { data: DemoConfigResponse; reload: () => void }) {
  const reason = usePermission("demos.manage");
  return (
    <div className="row">
      {data.paused ? <Badge tone="warn">{t("demos.paused")}</Badge> : null}
      <ActionButton size="sm" action={() => api.post<{ paused: boolean }>("/api/v1/demos/pause", { paused: !data.paused })} success={(r) => (r.paused ? t("demos.demoProcessingPaused") : t("demos.demoProcessingResumed"))} onDone={reload} disabledReason={reason}>
        {data.paused ? t("demos.resumeProcessing") : t("demos.pauseProcessing")}
      </ActionButton>
      <ActionButton size="sm" variant="ghost" title={t("demos.processOneSchedulingTickNow")} action={() => api.post<{ counts: Record<string, number> }>("/api/v1/demos/run-now")} success={t("demos.processedOneSchedulingTick")} onDone={reload} disabledReason={reason}>{t("demos.runNow")}</ActionButton>
    </div>
  );
}

export function ConfigPanel({ data, reload }: { data: DemoConfigResponse; reload: () => void }) {
  const reason = usePermission("demos.manage");
  const [cfg, setCfg] = useState<DemoConfig>(data.config);
  const [roots, setRoots] = useState(data.config.ingestRoots.join("\n"));
  // The settings are fetched again every 10 s: what is being edited stays until it is saved, and
  // only a saved configuration that changed (elsewhere) replaces an unedited form.
  const [edited, setEdited] = useState(false);
  const saved = JSON.stringify(data.config);
  useEffect(() => {
    if (edited) return;
    setCfg(data.config);
    setRoots(data.config.ingestRoots.join("\n"));
  }, [saved]);
  const set = (p: Partial<DemoConfig>) => {
    setEdited(true);
    setCfg({ ...cfg, ...p });
  };
  return (
    <>
      <div className="grid-2">
        <div className="gc-form">
          <Field label={t("demos.ingestRootsOnePerLine")} hint={t("demos.rawDemosAreOnlyEver")}>
            <textarea
              rows={3}
              value={roots}
              onChange={(e) => {
                setEdited(true);
                setRoots(e.target.value);
              }}
              className="mono"
            />
          </Field>
          <Field label={t("demos.datasetRoot")}>
            <input className="mono" value={cfg.datasetRoot} onChange={(e) => set({ datasetRoot: e.target.value })} />
          </Field>
          <Field label={t("demos.quarantineFolder")}>
            <input className="mono" value={cfg.quarantineDir} onChange={(e) => set({ quarantineDir: e.target.value })} />
          </Field>
        </div>
        <div className="gc-form">
          <div className="form-grid">
            <Field className="span-2" label={t("demos.retentionPolicy")} hint={RETENTION_POLICIES.find((p) => p.id === cfg.retention.policy)?.hint}>
              <select value={cfg.retention.policy} onChange={(e) => set({ retention: { ...cfg.retention, policy: e.target.value as RetentionPolicy } })}>
                {RETENTION_POLICIES.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("demos.quarantineDays")}>
              <input type="number" min={0} max={365} value={cfg.retention.quarantineDays} onChange={(e) => set({ retention: { ...cfg.retention, quarantineDays: Number(e.target.value) } })} />
            </Field>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <Checkbox checked={cfg.watch} onChange={(v) => set({ watch: v })} label={t("demos.watchIngestRootsForNew")} />
            <Checkbox checked={cfg.pauseDuringLive} onChange={(v) => set({ pauseDuringLive: v })} label={t("demos.pauseProcessingWhileALive")} />
          </div>
          <Details summary={t("demos.advanced")}>
            <div className="form-grid">
              <Field label={t("demos.auditSampleRate")} hint={t("demos.text01ShareOfRaw")}>
                <input type="number" min={0} max={1} step={0.01} value={cfg.retention.auditSampleRate} onChange={(e) => set({ retention: { ...cfg.retention, auditSampleRate: Number(e.target.value) } })} />
              </Field>
              <Field label={t("demos.concurrency")}>
                <input type="number" min={1} max={8} value={cfg.concurrency} onChange={(e) => set({ concurrency: Number(e.target.value) })} />
              </Field>
              <Field label={t("demos.minimumFreeSpaceGb")}>
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
          success={t("demos.demoLibraryConfigurationSaved")}
          onDone={() => {
            setEdited(false);
            reload();
          }}
          disabledReason={reason}
        >{t("demos.saveConfiguration")}</ActionButton>
      </div>
    </>
  );
}

function JobDetail({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const job = useApi<DemoJob & { transitions?: { from: string | null; to: string; at: string; detail?: unknown }[] }>(`/api/v1/jobs/${seg(jobId)}`, { refreshMs: 3000 });
  const qa = useApi<{ manifest: unknown; qa: unknown; validation: unknown }>(job.data?.datasetDir ? `/api/v1/demos/datasets/${seg(jobId)}/qa` : null);
  return (
    <Modal title={t("demos.demoJobJobid", { jobId })} onClose={onClose} wide>
      <Async state={job}>
        {(j) => (
          <>
            <KV
              items={[
                [t("demos.state"), <Badge key="s" tone={demoStateTone(j.state)}>{stateLabel(j.state)}</Badge>],
                [t("demos.source"), j.sourcePath],
                [t("demos.size"), fmtBytes(j.sizeBytes)],
                ["SHA-256", j.sha256 ?? MISSING],
                [t("demos.mapBuild"), `${j.mapName ?? MISSING} / ${j.gameBuild ?? MISSING}`],
                [t("demos.dataset"), j.datasetDir ?? MISSING],
                [t("demos.parserSchema"), `${j.parser ?? MISSING} / ${j.schemaVersion ?? MISSING}`],
                [t("demos.attempts"), j.attempts],
                [t("demos.failure"), j.failureReason ?? t("common.none")],
                [t("demos.retention"), `${j.retentionPolicy}${j.quarantineUntil ? ` · quarantined until ${fmtTime(j.quarantineUntil)}` : ""}`],
                [t("demos.updated"), fmtTime(j.updatedAt)],
              ]}
            />
            {j.transitions?.length ? (
              <Details summary={t("demos.transitionsCount", { count: j.transitions.length })}>
                <table className="table table-compact">
                  <tbody>
                    {j.transitions.map((tRow, i) => (
                      <tr key={i}>
                        <td>{fmtTime(tRow.at)}</td>
                        <td>
                          {tRow.from ?? "∅"} → <strong>{tRow.to}</strong>
                        </td>
                        <td className="small muted">{tRow.detail ? JSON.stringify(tRow.detail) : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Details>
            ) : null}
            {j.datasetDir ? (
              <Details summary={t("demos.datasetQa")}>
                <Async state={qa}>{(q) => <pre className="json-view">{JSON.stringify(q, null, 2)}</pre>}</Async>
              </Details>
            ) : (
              <p className="muted small" style={{ marginTop: 10 }}>{t("demos.noDatasetYetQaIs")}</p>
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
            <div className="chips-row" role="group" aria-label={t("demos.filterByState")} style={{ margin: 0 }}>
              <button className={`chip-toggle ${filter === "" ? "is-on" : ""}`} aria-pressed={filter === ""} onClick={() => setFilter("")}>{t("demos.allReduce", { reduce: Object.values(d.counts).reduce((a, b) => a + (b ?? 0), 0) })}</button>
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
                success={(r) => t("demos.confirmedBackupSConfirmed", { count: r.confirmed })}
                onDone={() => setSelected(new Set())}
                disabledReason={reason ?? (d.jobs.some((j) => selected.has(j.id) && j.sha256) ? null : t("demos.selectHashedJobsWhoseRaw"))}
                confirm={{ title: t("demos.confirmBackups"), body: t("demos.onlyConfirmDemosThatExist") }}
              >{t("demos.confirmBackupOfSelected")}</ActionButton>
            ) : null}
          </div>
          {d.jobs.length === 0 ? (
            <EmptyState title={t("demos.noDemoJobs")}>{t("demos.importDemoPathsAboveOr")}</EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th aria-label={t("demos.select")} />
                    <th>{t("demos.state")}</th>
                    <th>{t("demos.demo")}</th>
                    <th>{t("demos.progress")}</th>
                    <th>{t("demos.updated")}</th>
                    <th aria-label={t("demos.actions")} />
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
                            aria-label={t("demos.selectSourcepath", { sourcePath: j.sourcePath })}
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
                              {typeof prog.progress === "number" ? <Meter value={prog.progress} label={t("demos.jobProgress")} /> : null}
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
                              <ActionButton size="sm" action={() => api.post(`/api/v1/demos/jobs/${seg(j.id)}/retry`)} success={t("demos.jobReQueued")} onDone={() => void jobs.reload()} disabledReason={reason}>{t("common.retry")}</ActionButton>
                            ) : null}
                            {j.state === "QUARANTINED_RAW" ? (
                              <ActionButton size="sm" action={() => api.post(`/api/v1/demos/jobs/${seg(j.id)}/restore`)} success={t("demos.rawDemoRestoredFromQuarantine")} onDone={() => void jobs.reload()} disabledReason={reason}>{t("demos.restore")}</ActionButton>
                            ) : null}
                            <button className="link-btn" onClick={() => setDetail(j.id)}>{t("common.details")}</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <Details summary={t("demos.howProcessingWorks")}>
            <p className="small muted">{t("demos.eachDemoIsHashedQueued")}</p>
            <table className="table table-compact">
              <tbody>
                {DEMO_STATES.map((s) => (
                  <tr key={s}>
                    <td>
                      <Badge tone={demoStateTone(s)}>{stateLabel(s)}</Badge>
                    </td>
                    <td className="small muted">{DEMO_TRANSITIONS[s].length ? `→ ${DEMO_TRANSITIONS[s].map(stateLabel).join(", ")}` : t("demos.terminal")}</td>
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
            <span><T k="demos.freebytesFreeSpan" values={{ freeBytes: fmtBytes(r.freeBytes), span: <span className="muted">{t("demos.ofTotalbytes", { totalBytes: fmtBytes(r.totalBytes) })}</span> }} /></span>
          </div>
          <Meter value={r.totalBytes - r.freeBytes} max={r.totalBytes || 1} tone={r.freeBytes / (r.totalBytes || 1) < 0.1 ? "danger" : "accent"} label={t("demos.diskUsed")} />
          <Details summary={t("demos.usageByCategory")}>
            <p className="small muted">{t("demos.jobsV", { v: Object.entries(r.jobs).map(([k, v]) => `${stateLabel(k)} ${v}`).join(" · ") || t("common.none") })}</p>
            <table className="table table-compact">
              <thead>
                <tr>
                  <th>{t("demos.category")}</th>
                  <th>{t("demos.kind")}</th>
                  <th>{t("demos.used")}</th>
                  <th>{t("demos.quotaSoftHard")}</th>
                  <th style={{ width: "25%" }}>{t("demos.ofSoftQuota")}</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(r.categories).map(([k, c]) => (
                  <tr key={k}>
                    <td>{stateLabel(k)}</td>
                    <td className="small muted">{c.kind}</td>
                    <td>{fmtBytes(c.bytes)}</td>
                    <td className="small">{c.quota ? `${fmtBytes(c.quota.softBytes)} / ${fmtBytes(c.quota.hardBytes)}` : t("demos.noQuota")}</td>
                    <td>{c.quota ? <Meter value={c.bytes} max={c.quota.softBytes} tone={c.bytes > c.quota.softBytes ? "warn" : "ok"} label={t("demos.kUsage", { k })} /> : <span className="muted small">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Details>
          <div className="form-actions">
            <ActionButton
              size="sm"
              action={() => api.post<{ quarantined: number; removed: number; blocked: string[] }>("/api/v1/demos/retention/run")}
              success={(x) => t("demos.retentionQuarantinedQuarantinedRemovedRe", { quarantined: x.quarantined, removed: x.removed, v: x.blocked.length ? `, ${x.blocked.length} blocked` : "" })}
              onDone={() => void st.reload()}
              disabledReason={reason}
              confirm={{ title: t("demos.runRetentionNow2"), body: t("demos.appliesTheConfiguredRetentionPolicy"), confirmLabel: t("demos.runRetention"), danger: true }}
            >{t("demos.runRetentionNow")}</ActionButton>
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
        <h1 className="page-title">{t("demos.demoLibrary")}</h1>
        <Note tone="warn">{t("demos.reasonDemoManagementRequiresThe", { reason })}</Note>
      </div>
    );
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">{t("demos.demoLibrary")}</h1>
        {cfg.data ? <ProcessingControls data={cfg.data} reload={() => void cfg.reload()} /> : null}
      </div>
      <p className="page-intro">{t("demos.importCs2DemosDemOr")}</p>
      {cfg.data && !cfg.data.workersAvailable ? <Note tone="warn">{t("demos.pythonIsnTSetUp")}</Note> : null}
      {cfg.data?.archiveIssues?.length ? (
        <Note tone="warn" title={t("demos.anArchiveCouldNotBe")}>
          {cfg.data.archiveIssues.map((a) => `${a.archive.split(/[\\/]/).pop()}: ${a.error}`).join(" · ")}
        </Note>
      ) : null}
      <div className="grid-2">
        <Panel title={t("demos.pythonForReadingDemos")}>
          <PythonPanel onChange={() => void cfg.reload()} />
        </Panel>
        <Panel title={t("demos.cloudStorageFtp")} subtitle={t("demos.datasetsUploadedDemosDeleted")}>
          <CloudStoragePanel demos={cfg.data ?? null} onConfigChange={() => void cfg.reload()} />
        </Panel>
      </div>
      <div className="grid-2">
        <Panel title={t("demos.importDemos")}>
          <Field label={t("demos.pathsFilesOrFoldersOne")}>
            <textarea className="mono" rows={3} value={paths} onChange={(e) => setPaths(e.target.value)} placeholder={"D:\\demos\\2026-10-24\nD:\\demos\\final.dem"} />
          </Field>
          <div className="row-end" style={{ marginTop: 10 }}>
            <Field label={t("demos.retentionOverride")}>
              <select value={policy} onChange={(e) => setPolicy(e.target.value as RetentionPolicy | "")}>
                <option value="">{t("demos.libraryDefault")}</option>
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
              success={(r) => t("demos.countJobSCreated", { count: r.jobs.length })}
              onDone={() => setPaths("")}
              disabledReason={paths.trim() ? null : t("demos.enterAtLeastOnePath")}
            >{t("demos.import")}</ActionButton>
          </div>
        </Panel>
        <Panel title={t("demos.storage")}>
          <Storage />
        </Panel>
      </div>
      <Panel title={t("demos.jobs")}>
        <Jobs />
      </Panel>
      <Panel title={t("demos.librarySettings")} subtitle={cfg.data?.workersAvailable ? t("demos.pythonWorkersAvailable") : undefined}>
        <Async state={cfg}>{(d) => <ConfigPanel data={d} reload={() => void cfg.reload()} />}</Async>
      </Panel>
    </div>
  );
}
