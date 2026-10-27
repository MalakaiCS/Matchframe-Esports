import { useEffect, useRef, useState } from "react";
import type { HudLibrary } from "@matchframe/contracts";
import type { DesktopInfo } from "../api/desktop.ts";
import { desktopHud, desktopInfo } from "../api/desktop.ts";
import { gateView } from "../lib/cloud.ts";
import { fmtAgo, fmtHours, fmtMs } from "../lib/format.ts";
import { useApi } from "../lib/hooks.ts";
import { OUTPUT_LABEL, OUTPUT_MODES, totalOutputs, useDesktopOverlays } from "../lib/hudLibrary.ts";
import { Link } from "../router.tsx";
import { liveStore, useLive, useNow } from "../state/live.ts";
import { Icon } from "./icons.tsx";
import { Button, EmptyState, StatusDot } from "./ui.tsx";
import type { Tone } from "./ui.tsx";

const sentence = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

function hostPort(origin: string | null | undefined): string | null {
  if (!origin) return null;
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

/** Engine alerts (stale telemetry, camera takeovers, OBS problems), newest first. */
export function AlertList() {
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

function AlertsPopover() {
  const alerts = useLive((s) => s.alerts);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);
  const worst: Tone = alerts.some((a) => a.level === "error") ? "danger" : alerts.some((a) => a.level === "warn") ? "warn" : alerts.length ? "info" : "neutral";
  return (
    <div className="sb-popover-anchor" ref={ref}>
      <button className={`sb-item sb-button tone-${worst}`} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)} title="Engine alerts">
        <Icon name="bell" size={14} />
        <span>Alerts</span>
        <span className={`sb-count tone-${worst}`}>{alerts.length}</span>
      </button>
      {open ? (
        <div className="sb-popover" role="dialog" aria-label="Alerts">
          <div className="sb-popover-head">
            <strong>Alerts</strong>
            {alerts.length ? (
              <button className="link-btn" onClick={() => alerts.forEach((a) => liveStore.dismissAlert(a.id))}>
                Dismiss all
              </button>
            ) : null}
          </div>
          <AlertList />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Compact bottom status bar: the local server, active HUD outputs, the age of the last game data,
 * auto-director hours, OBS, alerts and a shortcut to the logs.
 */
export function StatusBar() {
  const status = useLive((s) => s.status);
  const snap = useLive((s) => s.snapshot);
  const now = useNow(1000);
  const bridge = desktopHud();
  const overlays = useDesktopOverlays(bridge);
  const library = useApi<HudLibrary>("/api/v1/hud/library", { refreshMs: 5000 });
  const [info, setInfo] = useState<DesktopInfo | null>(null);
  useEffect(() => {
    let alive = true;
    void desktopInfo().then((i) => {
      if (alive) setInfo(i);
    });
    return () => {
      alive = false;
    };
  }, []);

  const remote = info?.connection?.mode === "remote" || window.matchframe?.connectionMode === "remote";
  const engineTone: Tone = status === "open" ? "ok" : status === "connecting" || status === "idle" ? "info" : "danger";
  const engineText = status === "open" ? (remote ? "Remote engine connected" : "Engine connected") : status === "connecting" || status === "idle" ? "Connecting to engine…" : status === "unauthorized" ? "Engine token rejected" : "Engine offline";
  const ports = info?.ports;
  const portText = !remote && ports ? `API ${ports.api ?? "?"} · HUD ${ports.overlay ?? "?"} · GSI ${ports.gsi ?? "?"}` : remote && info?.connection?.mode === "remote" ? hostPort(info.connection.url) : hostPort(library.data?.overlayOrigin) ? `HUD server ${hostPort(library.data?.overlayOrigin)}` : null;

  const totals = totalOutputs(library.data?.huds ?? [], overlays);
  const anyOutput = totals.desktop + totals.obs + totals.preview > 0;

  const state = snap?.state ?? null;
  const age = state ? liveStore.clock.ageOf(state.time.receivedAtMonotonicMs, now) : null;
  const src = state?.sources[0] ?? null;

  const cloud = snap?.cloud;
  const gate = cloud ? gateView(cloud.gate, cloud.enforcement) : null;
  const obs = snap?.obs;
  const program = snap?.program;

  return (
    <footer className="statusbar" aria-label="Status bar">
      <span className="sb-item" title={[engineText, ports ? `Ports — API ${ports.api}, HUD server ${ports.overlay}, CS2 game state ${ports.gsi}` : null, info?.version ? `Program ${info.version}` : null].filter(Boolean).join(". ")} data-sb="engine">
        <StatusDot tone={engineTone} />
        <span>{engineText}</span>
        {portText ? <span className="sb-meta">{portText}</span> : null}
      </span>

      <Link to="/" className="sb-item sb-link" title={library.error ? `HUD library unavailable: ${library.error}` : "Active HUD outputs (desktop overlays, OBS browser sources, previews)"} data-sb="outputs">
        <StatusDot tone={anyOutput ? "ok" : "neutral"} />
        <span>HUD outputs</span>
        {OUTPUT_MODES.map((m) => (
          <span key={m} className={`sb-meta ${totals[m] ? "is-active" : ""}`} data-output={m}>
            {OUTPUT_LABEL[m]} {totals[m]}
          </span>
        ))}
        {library.data?.hiddenAll ? <span className="sb-meta text-warn">All hidden</span> : null}
      </Link>

      <span className="sb-item" title={src ? `Last game data ${age === null ? "?" : fmtMs(age)} ago (${src.packetsReceived} packets)` : "No game data received yet"} data-sb="data">
        <StatusDot tone={!src ? "neutral" : src.stale ? "danger" : snap?.simulated ? "sim" : "ok"} />
        <span>Last data</span>
        <span className="sb-meta">{age === null ? "none yet" : `${fmtMs(age)} ago`}</span>
      </span>

      {cloud && gate ? (
        <Link to="/settings/account" className="sb-item sb-link" title={cloud.gate.ok ? (cloud.metering ? "The Auto Director is directing and using hours" : `Auto Director: ${gate.text.toLowerCase()}`) : cloud.gate.reason} data-sb="hours">
          <StatusDot tone={gate.tone === "sim" ? "info" : gate.tone} />
          {cloud.gate.ok && cloud.remainingSeconds !== null ? (
            <>
              <span>{fmtHours(Math.max(0, cloud.remainingSeconds))}</span>
              <span className="sb-meta">left{cloud.metering ? " · in use" : ""}</span>
            </>
          ) : (
            <span>Hours: {gate.text}</span>
          )}
        </Link>
      ) : null}

      <Link
        to="/settings/devices"
        className="sb-item sb-link"
        title={[
          obs
            ? obs.connected
              ? `OBS connected · program scene ${obs.programScene ?? "none"}`
              : `${obs.lastError ? `OBS connection failed: ${obs.lastError}. ` : ""}Optional: HUDs reach OBS as browser sources (Copy OBS Browser URL) without this. Connect OBS under Settings → Devices only for automatic scene switching and replays.`
            : "OBS status unknown",
          program && obs?.connected ? `Program mode ${program.mode.replace("_", " ").toLowerCase()} (owner ${program.owner.kind}, ${program.owner.holder})` : "",
        ]
          .filter(Boolean)
          .join(". ")}
        data-sb="obs"
      >
        <StatusDot tone={!obs || (!obs.connected && !obs.lastError) ? "neutral" : !obs.connected ? "warn" : program?.mode === "DEGRADED" ? "danger" : "ok"} />
        <span>OBS</span>
        <span className="sb-meta">{!obs ? "—" : obs.connected ? (program ? sentence(program.mode.replace("_", " ")) : "Connected") : obs.lastError ? "Connection failed" : "Not connected (optional)"}</span>
      </Link>

      <span className="sb-spacer" />
      <AlertsPopover />
      <Link to="/settings/logs" className="sb-item sb-link" title="Settings → Logs" data-sb="logs">
        <Icon name="logs" size={14} />
        <span>Logs</span>
      </Link>
    </footer>
  );
}
