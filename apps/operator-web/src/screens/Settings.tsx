import { useEffect, useState } from "react";
import { api, seg } from "../api/index.ts";
import type { AuditEntry, BroadcastReport, EngineMetrics, LogEntry, StatsResponse } from "../api/types.ts";
import { ActionButton, Async, Badge, Button, EmptyState, Field, JsonEditor, KV, Note, Panel, parseJsonOr, Tabs } from "../components/ui.tsx";
import { fmtMs, fmtTime, MISSING, saveBlob } from "../lib/format.ts";
import { useApi, usePersistentState } from "../lib/hooks.ts";
import { Link } from "../router.tsx";
import { useSnapshot } from "../state/live.ts";
import { usePermission } from "../state/session.tsx";

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
                {settingWritable(s.key) ? null : <Badge>READ-ONLY</Badge>}
              </button>
            </li>
          ))}
        </ul>
        <div className="row-end" style={{ marginTop: 8 }}>
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
                <Button onClick={() => void value.reload()}>Reload</Button>
              </div>
            </>
          )}
        </Async>
      </Panel>
    </div>
  );
}

function AuditTab() {
  const reason = usePermission("settings.manage");
  const audit = useApi<AuditEntry[]>(reason ? null : "/api/v1/audit?limit=300", { refreshMs: 5000 });
  const [q, setQ] = useState("");
  if (reason) return <Note tone="warn">{reason}.</Note>;
  return (
    <Panel title="Audit log" subtitle="Every mutation through the API, newest first" actions={<input aria-label="Filter audit log" placeholder="filter (actor, action, target)" value={q} onChange={(e) => setQ(e.target.value)} />}>
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
                      <td className="mono small">{a.seq}</td>
                      <td className="small">{fmtTime(a.at)}</td>
                      <td>{a.actor}</td>
                      <td className="mono small">{a.action}</td>
                      <td className="small">{a.target ?? MISSING}</td>
                      <td className="small mono">{a.detail ? JSON.stringify(a.detail).slice(0, 140) : ""}</td>
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
          <option value="all">all levels</option>
          <option value="error">errors</option>
          <option value="warn">warnings+</option>
          <option value="info">info+</option>
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
                      <td className="small">{fmtTime(l.at ?? l.ts ?? l.time ?? null)}</td>
                      <td>
                        <Badge tone={l.level === "error" ? "danger" : l.level === "warn" ? "warn" : "neutral"}>{l.level}</Badge>
                      </td>
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
  const directorReason = usePermission("director.control");
  const metrics = useApi<EngineMetrics>("/api/v1/live/metrics", { refreshMs: 2000 });
  const snap = useSnapshot();
  return (
    <div className="grid-2">
      <div className="stack">
        <Panel title="Support bundle" subtitle="Redacted JSON for troubleshooting: config, health, capabilities, metrics, recent decisions, arbiter/program history, logs">
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
          <p className="small muted">Tokens, passwords and stream keys are never included.</p>
        </Panel>
        <Panel title="Security">
          <p className="small muted">Rotating the GSI token invalidates the token in every written GSI config: write the config again (Setup step 3) and restart CS2.</p>
          <div className="row">
            <ActionButton variant="warn" action={() => api.post<{ note: string }>("/api/v1/setup/rotate-gsi-token")} success={(r) => `GSI token rotated. ${r.note}`} disabledReason={settingsReason} confirm={{ title: "Rotate the GSI token?", body: "Telemetry stops until the GSI config is rewritten and CS2 restarted.", danger: true, confirmLabel: "Rotate" }}>
              Rotate GSI token
            </ActionButton>
            <Link to="/setup#step-gsi" className="btn btn-md">
              Rewrite GSI config
            </Link>
          </div>
        </Panel>
        <Panel title="Session">
          <div className="row">
            <ActionButton variant="warn" action={() => api.post<{ sessionId: string }>("/api/v1/session/restart")} success={(r) => `New live session ${r.sessionId}`} disabledReason={directorReason} confirm={{ title: "Restart the live session?", body: "Clears in-memory match state, events and director history; the next GSI packet starts a fresh session. Camera control resumes manual.", danger: true, confirmLabel: "Restart session" }}>
              Restart live session
            </ActionButton>
            {snap?.simulated ? (
              <ActionButton action={() => api.post("/api/v1/simulation/stop")} success="Simulation stopped" disabledReason={settingsReason}>
                Stop simulation
              </ActionButton>
            ) : (
              <ActionButton action={() => api.post("/api/v1/simulation/start", { startOffsetSec: 25 })} success="Simulation started" disabledReason={settingsReason}>
                Start labelled simulation
              </ActionButton>
            )}
            <Link to="/setup" className="btn btn-md">
              Open Setup
            </Link>
          </div>
        </Panel>
        <Panel title="API">
          <p className="small muted">
            The local HTTP API (used by this console, Companion and scripts) is described by an OpenAPI document at <code>/api/v1/openapi.json</code>.
          </p>
          <ActionButton
            action={async () => {
              const d = await api.download("/api/v1/openapi.json");
              saveBlob(d.blob, "matchframe-openapi.json");
              return d;
            }}
            success="OpenAPI document downloaded"
          >
            Download OpenAPI
          </ActionButton>
        </Panel>
      </div>
      <Panel title="Engine metrics" subtitle="Live, every 2 s">
        <Async state={metrics}>
          {(m) => (
            <div className="stat-tiles">
              {Object.entries(m).map(([k, v]) => (
                <div className="stat-tile" key={k}>
                  <div className="stat-label" title={k}>
                    {METRIC_LABEL[k] ?? k}
                  </div>
                  <div className="stat-value">{v === null ? MISSING : /Ms$/.test(k) ? fmtMs(v) : v.toLocaleString()}</div>
                </div>
              ))}
            </div>
          )}
        </Async>
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
        subtitle="Only metrics the source can compute are shown; the rest are marked unavailable (never estimated)"
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
          {(s) => (
            <div className="grid-2-1">
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
              <ul className="list-plain small">
                {s.metrics.map((m) => (
                  <li key={m.key}>
                    <strong>{m.label}</strong> {m.available ? <Badge tone="ok">AVAILABLE</Badge> : <Badge tone="warn">UNAVAILABLE</Badge>}
                    <div className="muted">
                      {m.definition} {m.reason ? `— ${m.reason}` : ""}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
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
                const d = await api.download("/api/v1/reports/broadcast");
                saveBlob(d.blob, `matchframe-broadcast-report-${Date.now()}.json`);
                return d;
              }}
              success="Report downloaded (JSON)"
            >
              JSON
            </ActionButton>
            <ActionButton
              size="sm"
              action={async () => {
                const d = await api.download("/api/v1/reports/broadcast?format=html");
                saveBlob(d.blob, `matchframe-broadcast-report-${Date.now()}.html`);
                return d;
              }}
              success="Report downloaded (HTML)"
            >
              HTML
            </ActionButton>
          </>
        }
      >
        <Async state={report}>
          {(r) => (
            <div className="grid-3">
              <KV
                items={[
                  ["Generated", fmtTime(r.generatedAt)],
                  ["Source", r.simulated ? <Badge key="s" tone="sim">SIMULATION</Badge> : "live"],
                  ["Policy", r.policyVersion],
                  ["Window", `${r.window.decisions} decisions · ${r.window.minutes} min`],
                  ["Actions", Object.entries(r.director.actions).map(([k, v]) => `${k} ${v}`).join(" · ") || MISSING],
                  ["Automated commands", `${r.director.automatedCommands} (${r.director.automatedConfirmed} confirmed, ${r.director.automatedFailed} failed)`],
                ]}
              />
              <KV
                items={[
                  ["Shot changes", r.continuity.shotChanges],
                  ["Cuts / minute", r.continuity.cutsPerMinute ?? MISSING],
                  ["Median shot", fmtMs(r.continuity.medianShotMs)],
                  ["P10 shot", fmtMs(r.continuity.p10ShotMs)],
                  ["Shots outliving their player", r.continuity.shotsThatOutlivedTheirPlayer],
                  ["Takeovers / external / e-stops", `${r.control.manualTakeovers} / ${r.control.externalChanges} / ${r.control.emergencyStops}`],
                ]}
              />
              <div>
                <h3 className="small muted">TOP REASONS</h3>
                <ul className="list-plain small">
                  {r.director.topReasons.slice(0, 8).map(([k, v]) => (
                    <li key={k}>
                      {k} · {v}
                    </li>
                  ))}
                </ul>
                {r.caveats.map((c, i) => (
                  <p key={i} className="small text-warn">
                    {c}
                  </p>
                ))}
              </div>
            </div>
          )}
        </Async>
      </Panel>
    </div>
  );
}

function BackupTab() {
  const settingsReason = usePermission("settings.manage");
  const [pkg, setPkg] = useState<Record<string, unknown> | null>(null);
  const [preview, setPreview] = useState<{ counts: Record<string, number>; collisions: { kind: string; id: string }[]; assets: number } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  return (
    <div className="grid-2">
      <Panel title="Export event package" subtitle="Teams, players, rosters, events, matches, veto, sponsors, rundown, rules, outputs and used assets (checksummed). Secrets are never exported.">
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
      </Panel>
      <Panel title="Restore event package" subtitle="Preview first; restoring refuses id collisions">
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
          <ActionButton action={() => api.post<{ counts: Record<string, number>; collisions: { kind: string; id: string }[]; assets: number }>("/api/v1/import/event-package", { package: pkg, mode: "preview" })} onDone={setPreview} success="Package verified" disabledReason={settingsReason ?? (pkg ? null : "Choose a package file")}>
            Preview
          </ActionButton>
          <ActionButton
            variant="primary"
            action={() => api.post("/api/v1/import/event-package", { package: pkg, mode: "commit" })}
            success="Event package restored"
            disabledReason={settingsReason ?? (!preview ? "Preview first" : preview.collisions.length ? `${preview.collisions.length} id collision(s) — cannot restore` : null)}
            confirm={{ title: "Restore this event package?", body: "Adds its teams, players, events, matches and assets to this installation." }}
          >
            Restore
          </ActionButton>
        </div>
        {preview ? (
          <>
            <KV items={Object.entries(preview.counts).map(([k, v]) => [k, v] as [string, number])} />
            <p className="small">{preview.assets} asset file(s).</p>
            {preview.collisions.length ? <Note tone="warn">Collisions: {preview.collisions.map((c) => `${c.kind} ${c.id}`).join(", ")}</Note> : <Note tone="ok">No id collisions.</Note>}
          </>
        ) : null}
      </Panel>
    </div>
  );
}

export function SettingsScreen() {
  const [tab, setTab] = usePersistentState<"settings" | "audit" | "logs" | "diagnostics" | "stats" | "backup">("settingsTab", "diagnostics");
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Settings &amp; Diagnostics</h1>
        <Link to="/setup" className="btn btn-md">
          Setup checklist
        </Link>
      </div>
      <Tabs
        label="Settings sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "diagnostics", label: "Diagnostics" },
          { id: "settings", label: "Settings" },
          { id: "audit", label: "Audit log" },
          { id: "logs", label: "Logs" },
          { id: "stats", label: "Stats & reports" },
          { id: "backup", label: "Backup" },
        ]}
      />
      {tab === "settings" ? <SettingsTab /> : null}
      {tab === "audit" ? <AuditTab /> : null}
      {tab === "logs" ? <LogsTab /> : null}
      {tab === "diagnostics" ? <DiagnosticsTab /> : null}
      {tab === "stats" ? <StatsTab /> : null}
      {tab === "backup" ? <BackupTab /> : null}
    </div>
  );
}
