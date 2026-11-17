import { useEffect, useRef, useState } from "react";
import type { HudLibrary } from "@matchframe/contracts";
import type { DesktopInfo } from "../api/desktop.ts";
import { desktopHud, desktopInfo } from "../api/desktop.ts";
import { t } from "../i18n/index.ts";
import { gateView } from "../lib/cloud.ts";
import { fmtAgo, fmtHours, fmtMs } from "../lib/format.ts";
import { useApi } from "../lib/hooks.ts";
import { OUTPUT_LABEL, OUTPUT_MODES, totalOutputs, useDesktopOverlays } from "../lib/hudLibrary.ts";
import { updates, updateSummary, useUpdates } from "../lib/updates.ts";
import { Link } from "../router.tsx";
import { liveStore, useLive, useNow } from "../state/live.ts";
import { Icon } from "./icons.tsx";
import { Button, EmptyState, StatusDot } from "./ui.tsx";
import type { Tone } from "./ui.tsx";


function hostPort(origin: string | null | undefined): string | null {
  if (!origin) return null;
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

/** The OBS program mode (LIVE, REPLAY, STUDIO, BREAK, …) in words ("Live", "Replay"). */
function programModeLabel(mode: string): string {
  const key = `shell.programMode.${mode}`;
  const text = t(key);
  return text === key ? mode.charAt(0) + mode.slice(1).toLowerCase().replace("_", " ") : text;
}

/** Engine alerts (stale telemetry, camera takeovers, OBS problems), newest first. */
export function AlertList() {
  const alerts = useLive((s) => s.alerts);
  const now = useNow(5000);
  if (alerts.length === 0) return <EmptyState title={t("shell.status.allClear")}>{t("shell.status.allClearBody")}</EmptyState>;
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
          <Button size="sm" variant="ghost" aria-label={t("shell.status.dismissAlert", { code: a.code })} onClick={() => liveStore.dismissAlert(a.id)}>
            {t("shell.status.dismiss")}
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
      <button className={`sb-item sb-button tone-${worst}`} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)} title={t("shell.status.engineAlerts")}>
        <Icon name="bell" size={14} />
        <span>{t("shell.status.alerts")}</span>
        <span className={`sb-count tone-${worst}`}>{alerts.length}</span>
      </button>
      {open ? (
        <div className="sb-popover" role="dialog" aria-label={t("shell.status.alerts")}>
          <div className="sb-popover-head">
            <strong>{t("shell.status.alerts")}</strong>
            {alerts.length ? (
              <button className="link-btn" onClick={() => alerts.forEach((a) => liveStore.dismissAlert(a.id))}>
                {t("shell.status.dismissAll")}
              </button>
            ) : null}
          </div>
          <AlertList />
        </div>
      ) : null}
    </div>
  );
}

/** A new version downloading or ready to install (shown only then). */
function UpdateItem() {
  const st = useUpdates();
  if (!st || (st.status !== "downloading" && st.status !== "ready" && st.status !== "available")) return null;
  if (st.status === "ready")
    return (
      <button className="sb-item sb-button sb-update" onClick={() => void updates.installNow()} title={t("shell.status.updateReadyTitle", { summary: updateSummary(st) })} data-sb="update">
        <Icon name="reload" size={14} />
        <span>{t("shell.status.updateReady", { version: st.version })}</span>
        <span className="sb-meta">{t("shell.status.restartNow")}</span>
      </button>
    );
  return (
    <Link to="/settings" className="sb-item sb-link" title={updateSummary(st)} data-sb="update">
      <Icon name="upload" size={14} />
      <span>{st.status === "available" ? (st.downgrade ? t("shell.status.stableAvailable", { version: st.version }) : t("shell.status.updateAvailable", { version: st.version })) : t("shell.status.downloading", { version: st.version })}</span>
      {st.percent !== null && st.status === "downloading" ? <span className="sb-meta">{st.percent} %</span> : null}
    </Link>
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
  const engineText = status === "open" ? (remote ? t("shell.status.remoteEngine") : t("shell.status.engine")) : status === "connecting" || status === "idle" ? t("shell.status.connecting") : status === "unauthorized" ? t("shell.status.tokenRejected") : t("shell.status.offline");
  const ports = info?.ports;
  const portText = !remote && ports ? `API ${ports.api ?? "?"} · HUD ${ports.overlay ?? "?"} · GSI ${ports.gsi ?? "?"}` : remote && info?.connection?.mode === "remote" ? hostPort(info.connection.url) : hostPort(library.data?.overlayOrigin) ? t("shell.status.hudServer", { host: hostPort(library.data?.overlayOrigin) }) : null;

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
    <footer className="statusbar" aria-label={t("shell.status.bar")}>
      <span className="sb-item" title={[engineText, ports ? t("shell.status.ports", { api: ports.api, overlay: ports.overlay, gsi: ports.gsi }) : null, info?.version ? t("shell.status.program", { version: info.version }) : null].filter(Boolean).join(". ")} data-sb="engine">
        <StatusDot tone={engineTone} />
        <span>{engineText}</span>
        {portText ? <span className="sb-meta">{portText}</span> : null}
      </span>

      <Link to="/" className="sb-item sb-link" title={library.error ? t("shell.status.libraryUnavailable", { error: library.error }) : t("shell.status.outputsTitle")} data-sb="outputs">
        <StatusDot tone={anyOutput ? "ok" : "neutral"} />
        <span>{t("shell.status.outputs")}</span>
        {OUTPUT_MODES.map((m) => (
          <span key={m} className={`sb-meta ${totals[m] ? "is-active" : ""}`} data-output={m}>
            {OUTPUT_LABEL[m]} {totals[m]}
          </span>
        ))}
        {library.data?.hiddenAll ? <span className="sb-meta text-warn">{t("shell.status.allHidden")}</span> : null}
      </Link>

      <span className="sb-item" title={src ? t("shell.status.lastDataTitle", { age: age === null ? "?" : fmtMs(age), count: src.packetsReceived }) : t("shell.status.noDataYet")} data-sb="data">
        <StatusDot tone={!src ? "neutral" : src.stale ? "danger" : snap?.simulated ? "sim" : "ok"} />
        <span>{t("shell.status.lastData")}</span>
        <span className="sb-meta">{age === null ? t("shell.status.noneYet") : t("shell.status.ago", { age: fmtMs(age) })}</span>
      </span>

      {cloud && gate ? (
        <Link to="/settings/account" className="sb-item sb-link" title={cloud.gate.ok ? (cloud.metering ? t("shell.status.metering") : t("shell.status.directorState", { state: gate.text.toLowerCase() })) : cloud.gate.reason} data-sb="hours">
          <StatusDot tone={gate.tone === "sim" ? "info" : gate.tone} />
          {cloud.gate.ok && cloud.remainingSeconds !== null ? (
            <>
              <span>{fmtHours(Math.max(0, cloud.remainingSeconds))}</span>
              <span className="sb-meta">{cloud.metering ? t("shell.status.leftInUse") : t("shell.status.left")}</span>
            </>
          ) : (
            <span>{t("shell.status.hours", { state: gate.text })}</span>
          )}
        </Link>
      ) : null}

      <Link
        to="/settings/devices"
        className="sb-item sb-link"
        title={[
          obs
            ? obs.connected
              ? t("shell.status.obsConnected", { scene: obs.programScene ?? t("shell.status.none") })
              : `${obs.lastError ? `${t("shell.status.obsFailed", { error: obs.lastError })} ` : ""}${t("shell.status.obsOptional")}`
            : t("shell.status.obsUnknown"),
          program && obs?.connected ? t("shell.status.programMode", { mode: programModeLabel(program.mode).toLowerCase(), kind: program.owner.kind, holder: program.owner.holder }) : "",
        ]
          .filter(Boolean)
          .join(". ")}
        data-sb="obs"
      >
        <StatusDot tone={!obs || (!obs.connected && !obs.lastError) ? "neutral" : !obs.connected ? "warn" : program?.mode === "DEGRADED" ? "danger" : "ok"} />
        <span>OBS</span>
        <span className="sb-meta">{!obs ? "—" : obs.connected ? (program ? programModeLabel(program.mode) : t("shell.status.connected")) : obs.lastError ? t("shell.status.connectionFailed") : t("shell.status.notConnected")}</span>
      </Link>

      <span className="sb-spacer" />
      <UpdateItem />
      <AlertsPopover />
      <Link to="/settings/logs" className="sb-item sb-link" title={`${t("nav.settings")} → ${t("nav.logs")}`} data-sb="logs">
        <Icon name="logs" size={14} />
        <span>{t("nav.logs")}</span>
      </Link>
    </footer>
  );
}
