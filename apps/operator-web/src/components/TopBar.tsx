import type { ReactNode } from "react";
import { api } from "../api/index.ts";
import { CONTROL_HEALTH_TEXT, ownershipView } from "../lib/ownership.ts";
import { MODE_INFO, OBSERVER_MODE_INFO } from "../lib/director.ts";
import { fmtHours, fmtMs } from "../lib/format.ts";
import { gateView } from "../lib/cloud.ts";
import { liveStore, reconnectLive, useLive, useNow } from "../state/live.ts";
import { usePermission } from "../state/session.tsx";
import { Link } from "../router.tsx";
import { Logo, Icon } from "./icons.tsx";
import { ActionButton, Badge, Button, StatusDot } from "./ui.tsx";
import type { Tone } from "./ui.tsx";

/** One compact status pill: a coloured dot plus a few words; the detail lives in the tooltip. */
function Pill({ dot, tone = "neutral", title, children, className = "", ...data }: { dot: Tone; tone?: Tone; title?: string; children: ReactNode; className?: string; [data: `data-${string}`]: string }) {
  return (
    <div className={`chip tone-${tone} ${className}`} title={title} {...data}>
      <StatusDot tone={dot} />
      <span className="chip-value">{children}</span>
    </div>
  );
}

const sentence = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

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

  // Console link first; once it is up, the pill reports the game data instead.
  const [linkTone, linkText]: [Tone, string] =
    status === "connecting"
      ? ["info", "Connecting…"]
      : status === "reconnecting"
        ? ["warn", info.nextRetryInMs ? `Reconnecting in ${Math.ceil(info.nextRetryInMs / 1000)} s` : "Reconnecting"]
        : status === "unauthorized"
          ? ["danger", "Token rejected"]
          : status === "closed" || status === "idle"
            ? ["danger", "Offline"]
            : feedStale
              ? ["warn", "Console feed stale"]
              : !src
                ? ["neutral", "Waiting for CS2"]
                : src.stale
                  ? ["danger", "CS2 data stale"]
                  : ["ok", "Live data"];
  const linkTitle = [
    status === "open" ? "Console connected to the engine." : (info.lastError ?? "Console not connected to the engine."),
    src ? `Telemetry ${src.stale ? "stale" : "fresh"}: ${src.packetsReceived} packets, build ${src.gameBuild ?? "?"}, age ${age === null ? "?" : fmtMs(age)}; ${src.packetsRejected} rejected, ${src.sequenceGaps} gaps.` : "No CS2 game state received yet.",
  ].join(" ");

  const health = snap?.director?.controlHealth ?? null;
  const healthInfo = health ? CONTROL_HEALTH_TEXT[health] : null;
  const own = ownershipView(snap?.ownership, snap?.resumeInMs);
  const modeLabel = !snap ? "Observer" : snap.mode === "advisory" || snap.mode === "automatic" || snap.mode === "assisted" ? (snap.observerMode === "off" ? "Observer off" : OBSERVER_MODE_INFO[snap.observerMode].label) : MODE_INFO[snap.mode].label;
  const ownTone: Tone = own.kind === "manual" || own.kind === "unknown" ? "neutral" : own.tone;
  const obs = snap?.obs;
  const program = snap?.program;
  const gate = snap?.cloud ? gateView(snap.cloud.gate, snap.cloud.enforcement) : null;

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
        <Pill dot={linkTone} tone={linkTone === "danger" || linkTone === "warn" ? linkTone : "neutral"} title={linkTitle} data-link={status}>
          {linkText}
          {status === "reconnecting" || status === "closed" ? (
            <button className="chip-btn" onClick={reconnectLive}>
              Retry now
            </button>
          ) : null}
        </Pill>
        <Pill dot={ownTone} tone={own.kind === "emergency" || own.kind === "resuming" ? own.tone : "neutral"} title={`${own.detail}${healthInfo ? ` Control: ${healthInfo.text.toLowerCase()}. ${healthInfo.hint}` : ""}`} className="chip-ownership">
          <span className="chip-strong">{modeLabel}</span>
          <span className="chip-meta">{own.badge}</span>
          {own.actions.includes("resume") ? (
            <ActionButton size="sm" variant={snap?.observerMode === "off" ? "secondary" : "primary"} action={() => api.post("/api/v1/observer/resume", { countdownMs: 3000 })} success="Automation resumes in 3 s (cancel to stay manual)" disabledReason={directorReason ?? (snap?.observerMode === "off" ? "The Observer is Off: choose an Observer mode in Live Control first" : null)} inlineError={false}>
              Resume automation
            </ActionButton>
          ) : null}
          {own.actions.includes("cancel_resume") ? (
            <ActionButton size="sm" variant="warn" action={() => api.post("/api/v1/observer/cancel-resume")} success="Resume cancelled — staying manual" disabledReason={directorReason} inlineError={false}>
              Cancel
            </ActionButton>
          ) : null}
          {own.actions.includes("clear_emergency") ? (
            <ActionButton size="sm" action={() => api.post("/api/v1/observer/clear-emergency-stop")} success="Emergency stop cleared — still manual until you resume" disabledReason={directorReason} inlineError={false}>
              Clear stop
            </ActionButton>
          ) : null}
          {own.actions.includes("takeover") ? (
            <ActionButton size="sm" action={() => api.post("/api/v1/observer/takeover")} success="Manual takeover: you own the camera" disabledReason={cameraReason} inlineError={false}>
              Take over
            </ActionButton>
          ) : null}
        </Pill>
        {snap?.cloud && gate ? (
          <Link to="/account" className="chip-link" aria-label="Auto-director hours — open Account">
            <Pill dot={gate.tone === "sim" ? "info" : gate.tone} tone={gate.tone === "danger" ? "danger" : "neutral"} title={snap.cloud.gate.ok ? (snap.cloud.metering ? "The Observer is directing and using hours" : `Automatic direction: ${gate.text.toLowerCase()}`) : snap.cloud.gate.reason}>
              {snap.cloud.gate.ok && snap.cloud.remainingSeconds !== null ? (
                <>
                  <span className="chip-strong">{fmtHours(Math.max(0, snap.cloud.remainingSeconds))}</span>
                  <span className="chip-meta">left{snap.cloud.metering ? " · in use" : ""}</span>
                </>
              ) : (
                gate.text
              )}
            </Pill>
          </Link>
        ) : null}
        <Pill
          dot={!obs ? "neutral" : !obs.connected ? "warn" : program?.mode === "DEGRADED" ? "danger" : "ok"}
          tone={program?.mode === "DEGRADED" ? "danger" : "neutral"}
          title={[obs ? (obs.connected ? `OBS connected · program scene ${obs.programScene ?? "none"}` : `OBS not connected${obs.lastError ? `: ${obs.lastError}` : ""}`) : "OBS status unknown", program ? `Program mode ${program.mode.replace("_", " ").toLowerCase()} (owner ${program.owner.kind}, ${program.owner.holder})` : ""].filter(Boolean).join(". ")}
        >
          <span className="chip-strong">OBS</span>
          <span className="chip-meta">{!obs ? "—" : obs.connected ? (program ? sentence(program.mode.replace("_", " ")) : "Connected") : "Offline"}</span>
        </Pill>
      </div>

      <div className="topbar-stop">
        <ActionButton
          variant="danger"
          className="btn-stop"
          action={emergencyStop}
          success="Emergency stop engaged: automation stopped"
          disabledReason={cameraReason}
          inlineError={false}
          aria-keyshortcuts="F8"
          title={`Stop all automated camera control now (${STOP_SHORTCUT_LABEL})`}
        >
          <Icon name="stop" /> Stop automation <kbd>{STOP_SHORTCUT_LABEL}</kbd>
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
        <strong>Token rejected.</strong> The engine rejected this console's token (rotated or revoked). Restart the Matchframe program, or update the token in File → Connection settings.
      </div>
    );
  return (
    <div className="banner tone-warn" role="alert">
      <strong>{status === "closed" ? "Disconnected." : "Reconnecting…"}</strong> Live data is paused{info.lastError ? ` (${info.lastError})` : ""}. Values on screen may be out of date; the view resyncs from the next engine snapshot.
      <Button size="sm" onClick={reconnectLive}>
        Reconnect now
      </Button>
    </div>
  );
}
