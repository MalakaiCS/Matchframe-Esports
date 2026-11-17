import type { ReactNode } from "react";
import { api } from "../api/index.ts";
import { t } from "../i18n/index.ts";
import type { CloudStatus } from "../api/types.ts";
import { useApi } from "../lib/hooks.ts";
import { Link } from "../router.tsx";
import { CONTROL_HEALTH_TEXT, ownershipView } from "../lib/ownership.ts";
import { MODE_INFO, OBSERVER_MODE_INFO } from "../lib/director.ts";
import { fmtMs } from "../lib/format.ts";
import { liveStore, reconnectLive, useLive, useNow } from "../state/live.ts";
import { usePermission } from "../state/session.tsx";
import { Icon } from "./icons.tsx";
import { ActionButton, Button, StatusDot } from "./ui.tsx";
import type { Tone } from "./ui.tsx";

/** One compact status pill: a coloured dot plus a few words; the detail lives in the tooltip. */
export function Pill({ dot, tone = "neutral", title, children, className = "", ...data }: { dot: Tone; tone?: Tone; title?: string; children: ReactNode; className?: string; [data: `data-${string}`]: string }) {
  return (
    <div className={`chip tone-${tone} ${className}`} title={title} {...data}>
      <StatusDot tone={dot} />
      <span className="chip-value">{children}</span>
    </div>
  );
}

export const STOP_SHORTCUT_LABEL = "F8";

export async function emergencyStop(): Promise<unknown> {
  return api.post("/api/v1/observer/emergency-stop");
}

/** Games in the selector: CS2 today; the others are listed so operators can see what is coming. */
export const GAMES: { id: string; label: string; available: boolean }[] = [
  { id: "cs2", label: "Counter-Strike 2", available: true },
  { id: "valorant", label: "Valorant", available: false },
  { id: "dota2", label: "Dota 2", available: false },
  { id: "lol", label: "League of Legends", available: false },
  { id: "rl", label: "Rocket League", available: false },
];

function GameSelect() {
  return (
    <label className="toolbar-game" title={t("shell.top.gameTitle")}>
      <span className="sr-only">{t("shell.top.game")}</span>
      <select value="cs2" onChange={() => undefined} aria-label={t("shell.top.game")}>
        {GAMES.map((g) => (
          <option key={g.id} value={g.id} disabled={!g.available}>
            {g.available ? g.label : t("shell.top.notYet", { game: g.label })}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Who this computer is signed in as (optional sign-in), linking to Settings → Account. */
function AccountChip() {
  const st = useApi<CloudStatus>("/api/v1/cloud/status", { refreshMs: 60_000 });
  const user = st.data?.signIn.user ?? null;
  const signedIn = st.data?.signIn.state === "signed_in" && !!user;
  return (
    <Link to="/settings/account" className="topbar-account" title={signedIn ? (st.data?.device?.orgName ? t("shell.top.signedInAsOrg", { email: user!.email, org: st.data.device.orgName }) : t("shell.top.signedInAs", { email: user!.email })) : t("shell.top.notSignedIn")} data-account={signedIn ? "signed-in" : "signed-out"}>
      <Icon name="account" size={16} />
      <span className="topbar-account-label">{signedIn ? t("shell.top.hi", { name: user!.displayName || user!.email.split("@")[0] }) : t("shell.top.signIn")}</span>
      <Icon name="chevronRight" size={14} />
    </Link>
  );
}

/**
 * The program's title bar (the window has no system one): the page title, then the game, the
 * game-data connection, which data is active (live, the labelled test simulation, or none), the
 * Observer, Stop automation and the account. Empty parts of the bar drag the window; the window
 * buttons are drawn over its right end.
 */
export function TopBar({ crumbs = [] }: { crumbs?: string[] }) {
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

  // Console link first; once it is up, the pill reports the game-data connection instead.
  const [linkTone, linkText]: [Tone, string] =
    status === "connecting"
      ? ["info", t("shell.top.connecting")]
      : status === "reconnecting"
        ? ["warn", info.nextRetryInMs ? t("shell.top.reconnectingIn", { s: Math.ceil(info.nextRetryInMs / 1000) }) : t("shell.top.reconnecting")]
        : status === "unauthorized"
          ? ["danger", t("shell.top.tokenRejected")]
          : status === "closed" || status === "idle"
            ? ["danger", t("shell.top.offline")]
            : feedStale
              ? ["warn", t("shell.top.feedStale")]
              : snap?.simulated
                ? ["sim", t("shell.top.simFeed")]
                : !src
                  ? ["neutral", t("shell.top.waitingCs2")]
                  : src.stale
                    ? ["danger", t("shell.top.cs2Stale")]
                    : ["ok", t("shell.top.cs2Connected")];
  const linkTitle = [
    status === "open" ? t("shell.top.consoleConnected") : (info.lastError ?? t("shell.top.consoleNotConnected")),
    src ? t(src.stale ? "shell.top.telemetryStale" : "shell.top.telemetryFresh", { packets: src.packetsReceived, build: src.gameBuild ?? "?", age: age === null ? "?" : fmtMs(age), rejected: src.packetsRejected, gaps: src.sequenceGaps }) : t("shell.top.noGameState"),
  ].join(" ");

  const dataMode: "test" | "live" | "none" = snap?.simulated ? "test" : src && !src.stale ? "live" : "none";

  const health = snap?.director?.controlHealth ?? null;
  const healthInfo = health ? CONTROL_HEALTH_TEXT[health] : null;
  const own = ownershipView(snap?.ownership, snap?.resumeInMs);
  const modeLabel = !snap ? t("shell.top.observer") : snap.mode === "advisory" || snap.mode === "automatic" || snap.mode === "assisted" ? (snap.observerMode === "off" ? t("shell.top.observerOff") : OBSERVER_MODE_INFO[snap.observerMode].label) : MODE_INFO[snap.mode].label;
  const ownTone: Tone = own.kind === "manual" || own.kind === "unknown" ? "neutral" : own.tone;

  return (
    <header className="topbar">
      <div className="topbar-page" aria-label={t("shell.top.currentPage")}>
        <span className="topbar-title">{crumbs[0] ?? ""}</span>
        {crumbs.length > 1 ? <span className="topbar-subtitle">{crumbs.at(-1)}</span> : null}
      </div>

      <div className="topbar-status">
        <GameSelect />
        <Pill dot={linkTone} tone={linkTone === "danger" || linkTone === "warn" ? linkTone : "neutral"} title={linkTitle} data-link={status}>
          {linkText}
          {status === "reconnecting" || status === "closed" ? (
            <button className="chip-btn" onClick={reconnectLive}>
              {t("shell.top.retryNow")}
            </button>
          ) : null}
        </Pill>
        {dataMode === "test" ? (
          <Pill dot="sim" tone="sim" title={t("shell.top.testDataTitle")} className="chip-data" data-data="test">
            <span className="chip-strong">{t("shell.top.testData")}</span>
            <span className="chip-meta">SIMULATION</span>
          </Pill>
        ) : dataMode === "live" ? (
          <Pill dot="ok" title={t("shell.top.liveDataTitle")} className="chip-data" data-data="live">
            <span className="chip-strong">{t("shell.top.liveData")}</span>
          </Pill>
        ) : (
          <Pill dot="neutral" title={t("shell.top.noDataTitle")} className="chip-data" data-data="none">
            <span className="chip-meta">{t("shell.top.noData")}</span>
          </Pill>
        )}
      </div>

      <div className="topbar-stop">
        <Pill dot={ownTone} tone={own.kind === "emergency" || own.kind === "resuming" ? own.tone : "neutral"} title={`${own.detail}${healthInfo ? ` ${t("shell.top.control", { state: healthInfo.text.toLowerCase(), hint: healthInfo.hint })}` : ""}`} className="chip-ownership">
          <span className="chip-strong">{modeLabel}</span>
          <span className="chip-meta">{own.badge}</span>
          {own.actions.includes("resume") ? (
            <ActionButton size="sm" variant={snap?.observerMode === "off" ? "secondary" : "primary"} action={() => api.post("/api/v1/observer/resume", { countdownMs: 3000 })} success={t("shell.top.resumeSuccess")} disabledReason={directorReason ?? (snap?.observerMode === "off" ? t("shell.top.observerIsOff") : null)} inlineError={false}>
              {t("shell.top.resume")}
            </ActionButton>
          ) : null}
          {own.actions.includes("cancel_resume") ? (
            <ActionButton size="sm" variant="warn" action={() => api.post("/api/v1/observer/cancel-resume")} success={t("shell.top.cancelSuccess")} disabledReason={directorReason} inlineError={false}>
              {t("common.cancel")}
            </ActionButton>
          ) : null}
          {own.actions.includes("clear_emergency") ? (
            <ActionButton size="sm" action={() => api.post("/api/v1/observer/clear-emergency-stop")} success={t("shell.top.clearSuccess")} disabledReason={directorReason} inlineError={false}>
              {t("shell.top.clearStop")}
            </ActionButton>
          ) : null}
          {own.actions.includes("takeover") ? (
            <ActionButton size="sm" action={() => api.post("/api/v1/observer/takeover")} success={t("shell.top.takeoverSuccess")} disabledReason={cameraReason} inlineError={false}>
              {t("shell.top.takeOver")}
            </ActionButton>
          ) : null}
        </Pill>
        <ActionButton
          variant="danger"
          className="btn-stop"
          action={emergencyStop}
          success={t("shell.top.stopSuccess")}
          disabledReason={cameraReason}
          inlineError={false}
          aria-keyshortcuts="F8"
          title={t("shell.top.stopTitle", { key: STOP_SHORTCUT_LABEL })}
        >
          <Icon name="stop" /> {t("shell.top.stop")} <kbd>{STOP_SHORTCUT_LABEL}</kbd>
        </ActionButton>
        <AccountChip />
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
        <strong>{t("shell.offline.tokenRejected")}</strong> {t("shell.offline.tokenRejectedBody")}
      </div>
    );
  return (
    <div className="banner tone-warn" role="alert">
      <strong>{status === "closed" ? t("shell.offline.disconnected") : t("shell.offline.reconnecting")}</strong> {info.lastError ? t("shell.offline.pausedError", { error: info.lastError }) : t("shell.offline.paused")}
      <Button size="sm" onClick={reconnectLive}>
        {t("shell.offline.reconnectNow")}
      </Button>
    </div>
  );
}
