import { api } from "../api/index.ts";
import type { HealthStatus, SetupStatus } from "../api/types.ts";
import { Icon } from "../components/icons.tsx";
import { ActionButton, Async, Badge, Button, EmptyState, KV, Meter, Note, Panel } from "../components/ui.tsx";
import { fmtAgo, fmtTime, MISSING } from "../lib/format.ts";
import { useApi } from "../lib/hooks.ts";
import { checklistProgress, setupChecklist } from "../lib/setup.ts";
import { Link } from "../router.tsx";
import { liveStore, useLive, useNow } from "../state/live.ts";
import { usePermission } from "../state/session.tsx";

const QUICK = [
  { to: "/live", icon: "live", label: "Live Control" },
  { to: "/setup", icon: "setup", label: "Setup checklist" },
  { to: "/matches", icon: "matches", label: "Matches & Veto" },
  { to: "/huds", icon: "huds", label: "HUD outputs" },
  { to: "/studio", icon: "studio", label: "Rundown" },
  { to: "/replays", icon: "replays", label: "Replays" },
  { to: "/devices", icon: "devices", label: "OBS & devices" },
  { to: "/settings", icon: "settings", label: "Diagnostics" },
];

function Alerts() {
  const alerts = useLive((s) => s.alerts);
  const now = useNow(5000);
  if (alerts.length === 0) return <EmptyState title="No alerts">Engine alerts (stale telemetry, external camera takeovers, OBS loss) appear here as they happen.</EmptyState>;
  return (
    <ul className="alert-list">
      {alerts.map((a) => (
        <li key={a.id} className="alert-item">
          <Badge tone={a.level === "error" ? "danger" : a.level === "warn" ? "warn" : "info"}>{a.level.toUpperCase()}</Badge>
          <span className="alert-msg">
            {a.message}
            <span className="muted small">
              {" "}
              · {a.code} · {fmtAgo(new Date(a.at).toISOString(), now)}
              {a.count > 1 ? ` · ×${a.count}` : ""}
            </span>
          </span>
          <Button size="sm" variant="ghost" aria-label={`Dismiss alert ${a.code}`} onClick={() => liveStore.dismissAlert(a.id)}>
            Dismiss
          </Button>
        </li>
      ))}
    </ul>
  );
}

function Health({ h }: { h: HealthStatus }) {
  const own = h.director.ownership;
  return (
    <KV
      items={[
        ["Engine", `v${h.version} · started ${fmtTime(h.startedAt)} · schema ${h.schemaVersion}`],
        ["Source", h.simulated ? <Badge key="s" tone="sim">SIMULATION</Badge> : <span key="s">live / none</span>],
        [
          "Telemetry",
          h.telemetry ? (
            <span key="t">
              {h.telemetry.stale ? <Badge tone="danger">STALE</Badge> : <Badge tone="ok">FRESH</Badge>} {h.telemetry.sourceId} · {h.telemetry.packets} packets · build {h.telemetry.gameBuild ?? MISSING}
            </span>
          ) : (
            <span key="t" className="muted">
              no GSI payload yet
            </span>
          ),
        ],
        ["Director", `${h.director.mode} · adapter ${h.director.adapter}`],
        ["Camera ownership", own.emergencyStopped ? <Badge key="o" tone="danger">EMERGENCY STOP</Badge> : `${own.owner}${own.manualSticky ? " (manual, sticky)" : ""} · ${own.holder ?? ""}`],
        ["OBS", h.obs.connected ? <Badge key="b" tone="ok">CONNECTED</Badge> : <span key="b">disconnected{h.obs.lastError ? ` — ${h.obs.lastError}` : ""}</span>],
        ["Program", h.program],
        ["Map packs", h.mapPacks.length ? h.mapPacks.join(", ") : <span key="m" className="muted">none loaded (only the synthetic map is created by the simulation)</span>],
      ]}
    />
  );
}

export function OverviewScreen() {
  const health = useApi<HealthStatus>("/api/v1/status", { refreshMs: 3000 });
  const setup = useApi<SetupStatus>("/api/v1/setup/status", { refreshMs: 3000 });
  const settingsReason = usePermission("settings.manage");
  const items = setup.data ? setupChecklist(setup.data) : [];
  const prog = checklistProgress(items);
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Overview</h1>
        {health.data?.simulated ? (
          <ActionButton action={() => api.post("/api/v1/simulation/stop")} success="Simulation stopped" disabledReason={settingsReason} onDone={() => void health.reload()}>
            Stop simulation
          </ActionButton>
        ) : (
          <ActionButton action={() => api.post("/api/v1/simulation/start", { startOffsetSec: 25 })} success="Labelled simulation started" disabledReason={settingsReason} onDone={() => void health.reload()}>
            Start labelled simulation
          </ActionButton>
        )}
      </div>
      <div className="grid-2-1">
        <div className="stack">
          <Panel
            title="Setup checklist"
            subtitle={setup.data ? `${prog.done} of ${prog.total} steps complete` : undefined}
            actions={
              <Link to="/setup" className="btn btn-primary btn-sm">
                Open Setup
              </Link>
            }
          >
            <Async state={setup}>
              {() => (
                <>
                  <Meter value={prog.done} max={prog.total} tone={prog.done === prog.total ? "ok" : "accent"} label="Setup progress" />
                  <ul className="checklist" style={{ marginTop: 10 }}>
                    {items.map((i) => (
                      <li key={i.id}>
                        <span className={`check-mark ${i.state === "done" ? "is-done" : i.state === "warn" ? "is-warn" : ""}`} aria-hidden>
                          {i.done ? "✓" : ""}
                        </span>
                        <span>
                          <Link to={`/setup#${i.anchor}`}>{i.label}</Link>
                          <span className="muted small"> — {i.detail}</span>
                          {i.state === "warn" ? <Badge tone="sim"> SIMULATION ONLY</Badge> : null}
                          {!i.done ? <span className="sr-only"> (not done)</span> : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </Async>
          </Panel>
          <Panel title="Engine health">
            <Async state={health}>{(h) => <Health h={h} />}</Async>
          </Panel>
        </div>
        <div className="stack">
          <Panel title="Alerts" subtitle="From the live engine feed">
            <Alerts />
          </Panel>
          <Panel title="Quick links">
            <div className="quick-links">
              {QUICK.map((q) => (
                <Link key={q.to} to={q.to} className="quick-link">
                  <Icon name={q.icon} /> {q.label}
                </Link>
              ))}
            </div>
          </Panel>
          {health.data && !health.data.telemetry ? (
            <Note tone="info" title="NEXT STEP">
              No telemetry yet. Open <Link to="/setup">Setup</Link> to detect CS2 and write the GSI config, or start the labelled simulation to rehearse the console.
            </Note>
          ) : null}
        </div>
      </div>
    </div>
  );
}
