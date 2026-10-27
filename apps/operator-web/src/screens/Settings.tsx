import { useEffect, useState } from "react";
import { api, seg } from "../api/index.ts";
import type { AuditEntry, BroadcastReport, EngineMetrics, LogEntry, StatsResponse } from "../api/types.ts";
import { ActionButton, Async, Badge, Button, Details, EmptyState, Field, JsonEditor, KV, Note, Panel, parseJsonOr, Tabs } from "../components/ui.tsx";
import { fmtMs, fmtTime, MISSING, saveBlob } from "../lib/format.ts";
import { useApi, usePersistentState } from "../lib/hooks.ts";
import { reasonInfo } from "../lib/reasons.ts";
import { Link } from "../router.tsx";
import { useSnapshot } from "../state/live.ts";
import { usePermission } from "../state/session.tsx";
import "../styles/group-c.css";

/** Settings keys the console knows about. Writable prefixes mirror the engine (hud|program|replay|director|demos|ui). */
export const KNOWN_SETTINGS: { key: string; description: string }[] = [
  { key: "program.scenes", description: "OBS scene per program mode (LIVE/REPLAY/STUDIO/BREAK)" },
  { key: "replay.provider", description: "Replay provider: {kind: obs|bridge|none, bufferSeconds?, bridgeUrl?}" },
  { key: "replay.mediaInput", description: "OBS media source used for replay playout" },
  { key: "hud.radarUtility", description: "Show utility on the HUD radar (boolean)" },
  { key: "hud.allowUnverifiedRadar", description: "Allow radar images with unverified calibration (boolean)" },
  { key: "hud.annotationsDraft", description: "Saved telestrator drawings" },
  { key: "demos.config", description: "Demo library configuration (prefer the Demo Library page)" },
  { key: "ui.rundownPosition", description: "Rundown ON AIR / NEXT pointer" },
  { key: "observer.adapter", description: "Observer adapter (read-only here — change it in Setup)" },
  { key: "observer.verifiedControl", description: "Recorded control verification evidence (read-only)" },
  { key: "live.activeMatchId", description: "Active match (read-only — change it in Matches)" },
];

export function settingWritable(key: string): boolean {
  return /^(hud|program|replay|director|demos|ui)\./.test(key);
}

function SettingsTab() {
  const reason = usePermission("settings.manage");
  const [key, setKey] = useState(KNOWN_SETTINGS[0]!.key);
  const [custom, setCustom] = useState("");
  const value = useApi<{ key: string; value: unknown }>(reason ? null : `/api/v1/settings/${seg(key)}`);
  const [text, setText] = useState("");
  useEffect(() => {
    if (value.data) setText(JSON.stringify(value.data.value, null, 2));
  }, [value.data]);
  const parsed = parseJsonOr<unknown>(text, null);
  if (reason) return <Note tone="warn">{reason}.</Note>;
  return (
    <>
      <p className="page-intro">Raw engine settings as JSON. Most of them have their own page; edit here only when a value isn&apos;t exposed elsewhere.</p>
      <div className="grid-1-2">
        <Panel title="Keys">
          <ul className="select-list">
            {KNOWN_SETTINGS.map((s) => (
              <li key={s.key}>
                <button className={s.key === key ? "is-selected" : ""} onClick={() => setKey(s.key)}>
                  <span style={{ flex: 1 }}>
                    <span className="mono">{s.key}</span>
                    <div className="small muted">{s.description}</div>
                  </span>
                  {settingWritable(s.key) ? null : <span className="small muted">Read-only</span>}
                </button>
              </li>
            ))}
          </ul>
          <div className="row-end" style={{ marginTop: 10 }}>
            <Field label="Other key">
              <input className="mono" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="hud.someSetting" />
            </Field>
            <Button onClick={() => custom.trim() && setKey(custom.trim())} disabled={!custom.trim()}>
              Open
            </Button>
          </div>
        </Panel>
        <Panel title={key} subtitle={settingWritable(key) ? "Changes take effect immediately and are audited" : "Read-only from this page"}>
          <Async state={value}>
            {() => (
              <>
                <JsonEditor label="Value" value={text} onChange={setText} rows={14} />
                <div className="form-actions">
                  <ActionButton
                    variant="primary"
                    action={() => {
                      if (!parsed.ok) throw new Error(parsed.error);
                      return api.put(`/api/v1/settings/${seg(key)}`, { value: parsed.value });
                    }}
                    success={`${key} saved`}
                    onDone={() => void value.reload()}
                    disabledReason={!settingWritable(key) ? "This key is not writable through the settings API" : parsed.ok ? null : "Invalid JSON"}
                  >
                    Save
                  </ActionButton>
                  <Button variant="ghost" onClick={() => void value.reload()}>
                    Reload
                  </Button>
                </div>
              </>
            )}
          </Async>
        </Panel>
      </div>
    </>
  );
}

function AuditTab() {
  const reason = usePermission("settings.manage");
  const audit = useApi<AuditEntry[]>(reason ? null : "/api/v1/audit?limit=300", { refreshMs: 5000 });
  const [q, setQ] = useState("");
  if (reason) return <Note tone="warn">{reason}.</Note>;
  return (
    <Panel title="Audit log" subtitle="Every change made through the API, newest first" actions={<input aria-label="Filter audit log" placeholder="Filter by actor, action or target" value={q} onChange={(e) => setQ(e.target.value)} />}>
      <Async state={audit}>
        {(list) => {
          const f = list.filter((a) => !q || `${a.actor} ${a.action} ${a.target ?? ""}`.toLowerCase().includes(q.toLowerCase()));
          return (
            <div className="table-wrap" style={{ maxHeight: 640, overflowY: "auto" }}>
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>At</th>
                    <th>Actor</th>
                    <th>Action</th>
                    <th>Target</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {f.map((a) => (
                    <tr key={a.seq}>
                      <td className="mono small muted">{a.seq}</td>
                      <td className="small gc-nowrap">{fmtTime(a.at)}</td>
                      <td>{a.actor}</td>
                      <td className="mono small">{a.action}</td>
                      <td className="small">{a.target ?? MISSING}</td>
                      <td className="small mono muted">{a.detail ? JSON.stringify(a.detail).slice(0, 140) : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }}
      </Async>
    </Panel>
  );
}

function LogsTab() {
  const reason = usePermission("settings.manage");
  const logs = useApi<LogEntry[]>(reason ? null : "/api/v1/logs/recent", { refreshMs: 4000 });
  const [level, setLevel] = useState("all");
  if (reason) return <Note tone="warn">{reason}.</Note>;
  return (
    <Panel
      title="Recent engine logs"
      subtitle="Secrets are redacted by the engine"
      actions={
        <select aria-label="Log level" value={level} onChange={(e) => setLevel(e.target.value)}>
          <option value="all">All levels</option>
          <option value="error">Errors</option>
          <option value="warn">Warnings and errors</option>
          <option value="info">Info and above</option>
        </select>
      }
    >
      <Async state={logs}>
        {(list) => {
          const rank: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
          const min = level === "all" ? 0 : (rank[level] ?? 0);
          const f = [...list].reverse().filter((l) => (rank[l.level] ?? 0) >= min);
          return f.length === 0 ? (
            <p className="muted small">No log entries at this level.</p>
          ) : (
            <div style={{ maxHeight: 640, overflowY: "auto" }}>
              <table className="table table-compact">
                <tbody>
                  {f.map((l, i) => (
                    <tr key={i}>
                      <td className="small gc-nowrap">{fmtTime(l.at ?? l.ts ?? l.time ?? null)}</td>
                      <td>{l.level === "error" || l.level === "warn" ? <Badge tone={l.level === "error" ? "danger" : "warn"}>{l.level}</Badge> : <span className="small muted">{l.level}</span>}</td>
                      <td>
                        {l.msg ?? l.message}
                        {l.data !== undefined ? <div className="small mono muted">{JSON.stringify(l.data).slice(0, 200)}</div> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }}
      </Async>
    </Panel>
  );
}

const METRIC_LABEL: Record<string, string> = {
  packets: "Packets ingested",
  rejected: "Packets rejected",
  invalid: "Invalid payloads",
  cuts: "Automated cuts",
  recommendations: "Recommendations",
  ingestP95Ms: "Ingest p95",
  evalP95Ms: "Director eval p95",
  maxIngestMs: "Max ingest",
  maxEvalMs: "Max director eval",
};

function DiagnosticsTab() {
  const settingsReason = usePermission("settings.manage");
  const metrics = useApi<EngineMetrics>("/api/v1/live/metrics", { refreshMs: 2000 });
  return (
    <div className="grid-2">
      <Panel title="Troubleshooting">
        <ActionButton
          variant="primary"
          action={async () => {
            const d = await api.download("/api/v1/diagnostics/bundle");
            saveBlob(d.blob, d.filename ?? `matchframe-support-${Date.now()}.json`);
            return d;
          }}
          success={(d) => `Downloaded ${d.filename ?? "support bundle"}`}
          disabledReason={settingsReason}
        >
          Download support bundle
        </ActionButton>
        <p className="gc-caption">Redacted JSON with config, health, capabilities, metrics, recent decisions, arbiter/program history and logs. Tokens, passwords and stream keys are never included.</p>
        <div className="gc-section">
          <h3 className="gc-section-title">API</h3>
          <ActionButton
            size="sm"
            action={async () => {
              const d = await api.download("/api/v1/openapi.json");
              saveBlob(d.blob, "matchframe-openapi.json");
              return d;
            }}
            success="OpenAPI document downloaded"
          >
            Download OpenAPI
          </ActionButton>
          <p className="gc-caption">
            The local HTTP API used by this console, Companion and scripts is described at <code>/api/v1/openapi.json</code>.
          </p>
        </div>
      </Panel>
      <Panel title="Engine metrics" subtitle="Updated every 2 s">
        <Async state={metrics}>
          {(m) => (
            <dl className="gc-metrics">
              {Object.entries(m).map(([k, v]) => (
                <div key={k}>
                  <dt title={k}>{METRIC_LABEL[k] ?? k}</dt>
                  <dd>{v === null ? MISSING : /Ms$/.test(k) ? fmtMs(v) : v.toLocaleString()}</dd>
                </div>
              ))}
            </dl>
          )}
        </Async>
      </Panel>
    </div>
  );
}

function GeneralTab() {
  const settingsReason = usePermission("settings.manage");
  const directorReason = usePermission("director.control");
  const snap = useSnapshot();
  const [pkg, setPkg] = useState<Record<string, unknown> | null>(null);
  const [preview, setPreview] = useState<{ counts: Record<string, number>; collisions: { kind: string; id: string }[]; assets: number } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  return (
    <div className="grid-2">
      <Panel title="Live session">
        <div className="row">
          {snap?.simulated ? (
            <ActionButton action={() => api.post("/api/v1/simulation/stop")} success="Simulation stopped" disabledReason={settingsReason}>
              Stop simulation
            </ActionButton>
          ) : (
            <ActionButton action={() => api.post("/api/v1/simulation/start", { startOffsetSec: 25 })} success="Simulation started" disabledReason={settingsReason}>
              Start labelled simulation
            </ActionButton>
          )}
          <ActionButton variant="ghost" action={() => api.post<{ sessionId: string }>("/api/v1/session/restart")} success={(r) => `New live session ${r.sessionId}`} disabledReason={directorReason} confirm={{ title: "Restart the live session?", body: "Clears in-memory match state, events and director history; the next GSI packet starts a fresh session. Camera control resumes manual.", danger: true, confirmLabel: "Restart session" }}>
            Restart live session
          </ActionButton>
        </div>
        <div className="gc-section">
          <h3 className="gc-section-title">GSI token</h3>
          <p className="small muted">Rotating the token breaks every GSI config written so far: write the config again in Setup and restart CS2.</p>
          <div className="row">
            <ActionButton variant="ghost" action={() => api.post<{ note: string }>("/api/v1/setup/rotate-gsi-token")} success={(r) => `GSI token rotated. ${r.note}`} disabledReason={settingsReason} confirm={{ title: "Rotate the GSI token?", body: "Telemetry stops until the GSI config is rewritten and CS2 restarted.", danger: true, confirmLabel: "Rotate" }}>
              Rotate GSI token
            </ActionButton>
            <Link to="/setup#step-gsi" className="btn btn-ghost btn-md">
              Rewrite GSI config
            </Link>
          </div>
        </div>
      </Panel>
      <Panel title="Event backup">
        <ActionButton
          variant="primary"
          action={async () => {
            const d = await api.download("/api/v1/export/event-package");
            saveBlob(d.blob, d.filename ?? `matchframe-event-${Date.now()}.json`);
            return d;
          }}
          success="Event package downloaded"
        >
          Export event package
        </ActionButton>
        <p className="gc-caption">Teams, players, rosters, events, matches, veto, sponsors, rundown, rules, outputs and used assets (checksummed). Secrets are never exported.</p>
        <div className="gc-section">
          <h3 className="gc-section-title">Restore an event package</h3>
          <input
            type="file"
            accept=".json,application/json"
            aria-label="Event package file"
            onChange={async (e) => {
              setPreview(null);
              setFileError(null);
              const f = e.target.files?.[0];
              if (!f) return;
              try {
                setPkg(JSON.parse(await f.text()) as Record<string, unknown>);
              } catch {
                setPkg(null);
                setFileError("Not a JSON file");
              }
            }}
          />
          {fileError ? <p className="small text-danger">{fileError}</p> : null}
          <div className="form-actions">
            <ActionButton size="sm" action={() => api.post<{ counts: Record<string, number>; collisions: { kind: string; id: string }[]; assets: number }>("/api/v1/import/event-package", { package: pkg, mode: "preview" })} onDone={setPreview} success="Package verified" disabledReason={settingsReason ?? (pkg ? null : "Choose a package file")}>
              Preview
            </ActionButton>
            <ActionButton
              size="sm"
              action={() => api.post("/api/v1/import/event-package", { package: pkg, mode: "commit" })}
              success="Event package restored"
              disabledReason={settingsReason ?? (!preview ? "Preview first" : preview.collisions.length ? `${preview.collisions.length} id collision(s) — cannot restore` : null)}
              confirm={{ title: "Restore this event package?", body: "Adds its teams, players, events, matches and assets to this installation." }}
            >
              Restore
            </ActionButton>
          </div>
          <p className="gc-caption">Preview first: restoring refuses id collisions.</p>
          {preview ? (
            <div style={{ marginTop: 10 }}>
              <KV items={[...Object.entries(preview.counts).map(([k, v]) => [k, v] as [string, number]), ["Asset files", preview.assets]]} />
              {preview.collisions.length ? <Note tone="warn">Collisions: {preview.collisions.map((c) => `${c.kind} ${c.id}`).join(", ")}</Note> : <p className="small text-ok">No id collisions.</p>}
            </div>
          ) : null}
        </div>
      </Panel>
    </div>
  );
}

function StatsTab() {
  const stats = useApi<StatsResponse>("/api/v1/stats/current", { refreshMs: 5000 });
  const report = useApi<BroadcastReport>("/api/v1/reports/broadcast", { refreshMs: 15000 });
  return (
    <div className="stack">
      <Panel
        title="Current match statistics"
        subtitle="Metrics the source can't compute are shown as n/a, never estimated."
        actions={
          <ActionButton
            size="sm"
            action={async () => {
              const d = await api.download("/api/v1/stats/current.csv");
              saveBlob(d.blob, d.filename ?? "matchframe-stats.csv");
              return d;
            }}
            success="CSV downloaded"
          >
            Download CSV
          </ActionButton>
        }
      >
        <Async state={stats}>
          {(s) => {
            const unavailable = s.metrics.filter((m) => !m.available);
            return (
              <>
                {s.players.length === 0 ? (
                  <EmptyState title="No players in telemetry">Statistics appear once telemetry arrives.</EmptyState>
                ) : (
                  <table className="table table-compact">
                    <thead>
                      <tr>
                        <th>Player</th>
                        <th>Side</th>
                        <th>K</th>
                        <th>D</th>
                        <th>A</th>
                        <th>MVP</th>
                        <th>Score</th>
                        <th>ADR</th>
                        <th>KAST</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.players.map((p) => (
                        <tr key={p.steamId}>
                          <td>{p.name}</td>
                          <td>{p.side ?? MISSING}</td>
                          <td>{p.kills ?? MISSING}</td>
                          <td>{p.deaths ?? MISSING}</td>
                          <td>{p.assists ?? MISSING}</td>
                          <td>{p.mvps ?? MISSING}</td>
                          <td>{p.score ?? MISSING}</td>
                          <td title="Requires exact damage events">{p.adr ?? "n/a"}</td>
                          <td title="Requires exact kill events">{p.kast ?? "n/a"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {unavailable.length ? <p className="gc-caption">Not available from this source: {unavailable.map((m) => m.label).join(", ")}.</p> : null}
                <Details summary="Metric definitions">
                  <ul className="list-plain small">
                    {s.metrics.map((m) => (
                      <li key={m.key}>
                        <strong>{m.label}</strong> {m.available ? <span className="text-ok">available</span> : <span className="text-warn">unavailable</span>}
                        <div className="muted">
                          {m.definition} {m.reason ? `— ${m.reason}` : ""}
                        </div>
                      </li>
                    ))}
                  </ul>
                </Details>
              </>
            );
          }}
        </Async>
      </Panel>
      <Panel
        title="Broadcast report"
        subtitle="Director decisions, continuity, control events, replays and sponsor deliveries for the current session"
        actions={
          <>
            <ActionButton
              size="sm"
              action={async () => {
                const d = await api.download("/api/v1/reports/broadcast?format=html");
                saveBlob(d.blob, `matchframe-broadcast-report-${Date.now()}.html`);
                return d;
              }}
              success="Report downloaded (HTML)"
            >
              Download HTML
            </ActionButton>
            <ActionButton
              size="sm"
              variant="ghost"
              action={async () => {
                const d = await api.download("/api/v1/reports/broadcast");
                saveBlob(d.blob, `matchframe-broadcast-report-${Date.now()}.json`);
                return d;
              }}
              success="Report downloaded (JSON)"
            >
              Download JSON
            </ActionButton>
          </>
        }
      >
        <Async state={report}>
          {(r) => (
            <>
              <div className="grid-2">
                <KV
                  items={[
                    ["Window", `${r.window.decisions} decisions · ${r.window.minutes} min`],
                    ["Actions", Object.entries(r.director.actions).map(([k, v]) => `${k} ${v}`).join(" · ") || MISSING],
                    ["Automated commands", `${r.director.automatedCommands} (${r.director.automatedConfirmed} confirmed, ${r.director.automatedFailed} failed)`],
                    ["Shot changes", r.continuity.shotChanges],
                    ["Cuts / minute", r.continuity.cutsPerMinute ?? MISSING],
                    ["Median shot", fmtMs(r.continuity.medianShotMs)],
                    ["Takeovers / external / e-stops", `${r.control.manualTakeovers} / ${r.control.externalChanges} / ${r.control.emergencyStops}`],
                  ]}
                />
                <div>
                  <h3 className="gc-section-title">Top reasons</h3>
                  <ul className="list-plain small">
                    {r.director.topReasons.slice(0, 8).map(([k, v]) => (
                      <li key={k} className="row" title={k}>
                        {reasonInfo(k).label}
                        <span className="spacer" />
                        <span className="muted">{v}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
              {r.caveats.map((c, i) => (
                <p key={i} className="gc-caption">
                  {c}
                </p>
              ))}
              <Details summary="Report details">
                <KV
                  items={[
                    ["Generated", fmtTime(r.generatedAt)],
                    ["Source", r.simulated ? "simulation" : "live"],
                    ["Policy", r.policyVersion],
                    ["P10 shot", fmtMs(r.continuity.p10ShotMs)],
                    ["Shots outliving their player", r.continuity.shotsThatOutlivedTheirPlayer],
                  ]}
                />
              </Details>
            </>
          )}
        </Async>
      </Panel>
    </div>
  );
}

type SettingsTabId = "general" | "stats" | "diagnostics" | "logs" | "audit" | "settings";
const SETTINGS_TABS: { id: SettingsTabId; label: string }[] = [
  { id: "general", label: "General" },
  { id: "stats", label: "Stats & reports" },
  { id: "diagnostics", label: "Diagnostics" },
  { id: "logs", label: "Logs" },
  { id: "audit", label: "Audit log" },
  { id: "settings", label: "Advanced" },
];

export function SettingsScreen() {
  const [stored, setTab] = usePersistentState<SettingsTabId | "backup">("settingsTab", "general");
  const tab: SettingsTabId = SETTINGS_TABS.some((t) => t.id === stored) ? (stored as SettingsTabId) : "general";
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Settings &amp; Diagnostics</h1>
      </div>
      <Tabs label="Settings sections" value={tab} onChange={setTab} tabs={SETTINGS_TABS} />
      {tab === "general" ? <GeneralTab /> : null}
      {tab === "stats" ? <StatsTab /> : null}
      {tab === "diagnostics" ? <DiagnosticsTab /> : null}
      {tab === "logs" ? <LogsTab /> : null}
      {tab === "audit" ? <AuditTab /> : null}
      {tab === "settings" ? <SettingsTab /> : null}
    </div>
  );
}
