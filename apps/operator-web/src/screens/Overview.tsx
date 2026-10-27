import { api } from "../api/index.ts";
import type { HealthStatus, SetupStatus } from "../api/types.ts";
import { ActionButton, Async, Badge, Button, Details, EmptyState, KV, Meter, Panel, StatusDot } from "../components/ui.tsx";
import type { Tone } from "../components/ui.tsx";
import { fmtAgo, fmtTime, MISSING } from "../lib/format.ts";
import { useApi } from "../lib/hooks.ts";
import { checklistProgress, setupChecklist } from "../lib/setup.ts";
import type { ChecklistItem } from "../lib/setup.ts";
import { Link } from "../router.tsx";
import { liveStore, useLive, useNow } from "../state/live.ts";
import { usePermission } from "../state/session.tsx";

function Alerts() {
  const alerts = useLive((s) => s.alerts);
  const now = useNow(5000);
  if (alerts.length === 0) return <EmptyState title="All clear">Stale telemetry, camera takeovers and OBS problems show up here as they happen.</EmptyState>;
  return (
    <ul className="alert-list">
      {alerts.map((a) => (
        <li key={a.id} className="alert-item">
          <StatusDot tone={a.level === "error" ? "danger" : a.level === "warn" ? "warn" : "info"} />
          <span className="alert-msg" title={a.code}>
            {a.message}
            <span className="muted small">
              {" "}
              · {fmtAgo(new Date(a.at).toISOString(), now)}
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

function StepRow({ i }: { i: ChecklistItem }) {
  return (
    <li>
      <span className={`check-mark ${i.state === "done" ? "is-done" : i.state === "warn" ? "is-warn" : ""}`} aria-hidden>
        {i.done ? "✓" : ""}
      </span>
      <span>
        <Link to={`/setup#${i.anchor}`}>{i.label}</Link>
        {!i.done ? <span className="muted small"> — {i.detail}</span> : null}
        {i.state === "warn" ? <span className="muted small"> (simulation only)</span> : null}
        {!i.done ? <span className="sr-only"> (not done)</span> : null}
      </span>
    </li>
  );
}

function Status({ h }: { h: HealthStatus }) {
  const own = h.director.ownership;
  const rows: [string, Tone, string][] = [
    ["CS2 game data", !h.telemetry ? "neutral" : h.telemetry.stale ? "danger" : "ok", !h.telemetry ? "Waiting for CS2" : h.telemetry.stale ? "Stale" : h.simulated ? "Simulated" : "Live"],
    ["Camera", own.emergencyStopped ? "danger" : own.owner === "director" && !own.manualSticky ? "ok" : "neutral", own.emergencyStopped ? "Emergency stop" : own.owner === "director" && !own.manualSticky ? "Observer directing" : "Manual"],
    ["OBS", h.obs.connected ? "ok" : "warn", h.obs.connected ? "Connected" : "Not connected"],
    ["Map packs", h.mapPacks.length ? "ok" : "neutral", h.mapPacks.length ? `${h.mapPacks.length} loaded` : "None loaded"],
  ];
  return (
    <>
      <ul className="status-list">
        {rows.map(([label, tone, value]) => (
          <li key={label} title={label === "Map packs" ? h.mapPacks.join(", ") : undefined}>
            <span className="muted">{label}</span>
            <span>
              <StatusDot tone={tone} /> {value}
            </span>
          </li>
        ))}
      </ul>
      <Details summary="Engine details">
        <KV
          items={[
            ["Engine", `v${h.version} · started ${fmtTime(h.startedAt)} · schema ${h.schemaVersion}`],
            ["Telemetry source", h.telemetry ? `${h.telemetry.sourceId} · ${h.telemetry.packets} packets · build ${h.telemetry.gameBuild ?? MISSING}` : MISSING],
            ["Director", `${h.director.mode} · adapter ${h.director.adapter}`],
            ["Camera owner", `${own.owner}${own.manualSticky ? " (manual, sticky)" : ""}${own.holder ? ` · ${own.holder}` : ""}`],
            ["OBS", h.obs.connected ? "connected" : `disconnected${h.obs.lastError ? ` — ${h.obs.lastError}` : ""}`],
            ["Program", h.program],
          ]}
        />
      </Details>
    </>
  );
}

export function OverviewScreen() {
  const health = useApi<HealthStatus>("/api/v1/status", { refreshMs: 3000 });
  const setup = useApi<SetupStatus>("/api/v1/setup/status", { refreshMs: 3000 });
  const settingsReason = usePermission("settings.manage");
  const items = setup.data ? setupChecklist(setup.data) : [];
  const prog = checklistProgress(items);
  const todo = items.filter((i) => !i.done);
  const done = items.filter((i) => i.done);
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
            Start simulation
          </ActionButton>
        )}
      </div>
      {health.data && !health.data.telemetry ? (
        <p className="page-intro">
          No game data yet. <Link to="/setup">Set up CS2</Link> to connect a match, or start the simulation to rehearse.
        </p>
      ) : null}
      <div className="grid-2-1">
        <Panel
          title="Setup"
          subtitle={setup.data ? (todo.length ? `${prog.done} of ${prog.total} done` : "Everything is set up") : undefined}
          actions={
            <Link to="/setup" className="btn btn-secondary btn-sm">
              Open Setup
            </Link>
          }
        >
          <Async state={setup}>
            {() => (
              <>
                <Meter value={prog.done} max={prog.total} tone={prog.done === prog.total ? "ok" : "accent"} label="Setup progress" />
                {todo.length ? (
                  <ul className="checklist" style={{ marginTop: 12 }}>
                    {todo.map((i) => (
                      <StepRow key={i.id} i={i} />
                    ))}
                  </ul>
                ) : null}
                {done.length ? (
                  <Details summary={`${done.length} completed`} open={todo.length === 0}>
                    <ul className="checklist">
                      {done.map((i) => (
                        <StepRow key={i.id} i={i} />
                      ))}
                    </ul>
                  </Details>
                ) : null}
              </>
            )}
          </Async>
        </Panel>
        <div className="stack">
          <Panel title="Status" actions={health.data?.simulated ? <Badge tone="sim">Simulation</Badge> : null}>
            <Async state={health}>{(h) => <Status h={h} />}</Async>
          </Panel>
          <Panel title="Alerts">
            <Alerts />
          </Panel>
        </div>
      </div>
    </div>
  );
}
