import type { ReactNode } from "react";
import { api } from "../api/index.ts";
import { CONTROL_HEALTH_TEXT, ownershipView } from "../lib/ownership.ts";
import { fmtMs } from "../lib/format.ts";
import { liveStore, reconnectLive, useLive, useNow } from "../state/live.ts";
import { usePermission } from "../state/session.tsx";
import { Link } from "../router.tsx";
import { Logo, Icon } from "./icons.tsx";
import { ActionButton, Badge, Button } from "./ui.tsx";
import type { Tone } from "./ui.tsx";

function Chip({ label, children, tone = "neutral", title }: { label: string; children: ReactNode; tone?: Tone; title?: string }) {
  return (
    <div className={`chip tone-${tone}`} title={title}>
      <span className="chip-label">{label}</span>
      <span className="chip-value">{children}</span>
    </div>
  );
}

export const STOP_SHORTCUT_LABEL = "F8";

export async function emergencyStop(): Promise<unknown> {
  return api.post("/api/v1/observer/emergency-stop");
}

export function TopBar({ onToggleNav }: { onToggleNav: () => void }) {
  const status = useLive((s) => s.status);
  const info = useLive((s) => s.info);
  const snap = useLive((s) => s.snapshot);
  const snapshotAt = useLive((s) => s.snapshotAt);
  const now = useNow(250);
  const cameraReason = usePermission("camera.control");
  const directorReason = usePermission("director.control");

  const state = snap?.state ?? null;
  const src = state?.sources[0] ?? null;
  const age = state ? liveStore.clock.ageOf(state.time.receivedAtMonotonicMs, now) : null;
  const feedStale = status === "open" && snapshotAt > 0 && now - snapshotAt > 3000;

  const [linkTone, linkText]: [Tone, string] =
    status === "connecting"
      ? ["info", "CONNECTING"]
      : status === "reconnecting"
        ? ["warn", info.nextRetryInMs ? `RETRY IN ${Math.ceil(info.nextRetryInMs / 1000)} s` : "RECONNECTING"]
        : status === "unauthorized"
          ? ["danger", "TOKEN REJECTED"]
          : status === "closed" || status === "idle"
            ? ["danger", "OFFLINE"]
            : feedStale
              ? ["warn", "FEED STALE"]
              : ["ok", "CONNECTED"];

  const [telTone, telText]: [Tone, string] = !src ? ["neutral", "NO DATA"] : src.stale ? ["danger", "STALE"] : ["ok", "FRESH"];

  const health = snap?.director?.controlHealth ?? null;
  const healthInfo = health ? CONTROL_HEALTH_TEXT[health] : null;
  const own = ownershipView(snap?.ownership, snap?.resumeInMs);
  const obs = snap?.obs;
  const program = snap?.program;

  return (
    <header className="topbar">
      <div className="topbar-brand">
        <button className="icon-btn nav-toggle" aria-label="Toggle navigation" onClick={onToggleNav}>
          <Icon name="menu" />
        </button>
        <Link to="/" className="brand-link" aria-label="Matchframe Operator — Overview">
          <Logo />
          <span className="brand-text">
            <span className="brand-name">Matchframe</span>
            <span className="brand-sub">Operator</span>
          </span>
        </Link>
      </div>

      <div className="topbar-status">
        {snap?.simulated ? (
          <Badge tone="sim" icon="◆" title="The labelled simulation is running: synthetic data on a synthetic map. It does not certify any real integration." className="badge-lg">
            SIMULATION
          </Badge>
        ) : null}
        <Chip label="Console link" tone={linkTone} title={info.lastError ?? undefined}>
          {linkText}
          {status === "reconnecting" || status === "closed" ? (
            <button className="chip-btn" onClick={reconnectLive}>
              Retry now
            </button>
          ) : null}
        </Chip>
        <Chip label="Telemetry" tone={telTone} title={src ? `Source ${src.sourceId}; ${src.packetsRejected} rejected, ${src.sequenceGaps} gaps` : "No GSI payload received yet"}>
          <span className="chip-strong">{telText}</span>
          {src ? (
            <span className="chip-meta">
              {src.packetsReceived} pkts · build {src.gameBuild ?? "?"} · age {age === null ? "?" : fmtMs(age)}
            </span>
          ) : null}
        </Chip>
        <Chip label="Director" tone={healthInfo?.tone ?? "neutral"} title={healthInfo?.hint}>
          <span className="chip-strong">{(snap?.mode ?? "—").toUpperCase().replace("_", " ")}</span>
          <span className="chip-meta">{healthInfo?.text ?? "NO DECISION"}</span>
        </Chip>
        <div className={`chip chip-ownership tone-${own.tone}`} title={own.detail}>
          <span className="chip-label">Camera ownership</span>
          <span className="chip-value">
            <span className="chip-strong">{own.badge}</span>
            {own.actions.includes("resume") ? (
              <ActionButton size="sm" variant="primary" action={() => api.post("/api/v1/observer/resume", { countdownMs: 3000 })} success="Automation resumes in 3 s (cancel to stay manual)" disabledReason={directorReason} reasonPlacement="tooltip" inlineError={false}>
                Resume automation
              </ActionButton>
            ) : null}
            {own.actions.includes("cancel_resume") ? (
              <ActionButton size="sm" variant="warn" action={() => api.post("/api/v1/observer/cancel-resume")} success="Resume cancelled — staying manual" disabledReason={directorReason} reasonPlacement="tooltip" inlineError={false}>
                Cancel
              </ActionButton>
            ) : null}
            {own.actions.includes("clear_emergency") ? (
              <ActionButton size="sm" action={() => api.post("/api/v1/observer/clear-emergency-stop")} success="Emergency stop cleared — still manual until you resume" disabledReason={directorReason} reasonPlacement="tooltip" inlineError={false}>
                Clear stop
              </ActionButton>
            ) : null}
            {own.actions.includes("takeover") ? (
              <ActionButton size="sm" action={() => api.post("/api/v1/observer/takeover")} success="Manual takeover: you own the camera" disabledReason={cameraReason} reasonPlacement="tooltip" inlineError={false}>
                Take over
              </ActionButton>
            ) : null}
          </span>
        </div>
        <Chip label="OBS" tone={obs?.connected ? "ok" : "warn"} title={obs?.lastError ?? undefined}>
          <span className="chip-strong">{obs ? (obs.connected ? "CONNECTED" : "DISCONNECTED") : "—"}</span>
          {obs?.connected ? <span className="chip-meta">{obs.programScene ?? "no program scene"}</span> : null}
        </Chip>
        <Chip label="Program" tone={program?.mode === "DEGRADED" ? "danger" : program?.mode === "LIVE" ? "ok" : program ? "info" : "neutral"} title={program ? `Owner: ${program.owner.kind} (${program.owner.holder})` : undefined}>
          <span className="chip-strong">{program?.mode.replace("_", " ") ?? "—"}</span>
        </Chip>
      </div>

      <div className="topbar-stop">
        <ActionButton
          variant="danger"
          size="lg"
          className="btn-stop"
          action={emergencyStop}
          success="STOP AUTOMATION: emergency stop engaged"
          disabledReason={cameraReason}
          reasonPlacement="tooltip"
          inlineError={false}
          aria-keyshortcuts="F8"
          title={`Stop all automated camera control now (${STOP_SHORTCUT_LABEL})`}
        >
          <Icon name="stop" /> STOP AUTOMATION <kbd>{STOP_SHORTCUT_LABEL}</kbd>
        </ActionButton>
      </div>
    </header>
  );
}

export function OfflineBanner() {
  const status = useLive((s) => s.status);
  const info = useLive((s) => s.info);
  if (status === "open" || status === "connecting" || status === "idle") return null;
  if (status === "unauthorized")
    return (
      <div className="banner tone-danger" role="alert">
        <strong>TOKEN REJECTED</strong> The engine rejected this console's token (rotated or revoked). Reopen the operator URL from the engine or desktop app.
      </div>
    );
  return (
    <div className="banner tone-warn" role="alert">
      <strong>{status === "closed" ? "DISCONNECTED" : "RECONNECTING"}</strong> Live data is paused{info.lastError ? ` (${info.lastError})` : ""}. Values on screen may be out of date; the view resyncs from the next engine snapshot.
      <Button size="sm" onClick={reconnectLive}>
        Reconnect now
      </Button>
    </div>
  );
}
