import { Suspense, useCallback, useEffect, useLayoutEffect, useState } from "react";
import { api, describeError, NetworkError } from "./api/index.ts";
import { resolveOperatorToken, setOperatorToken } from "./api/auth.ts";
import type { Me } from "./api/types.ts";
import { BrandBadge } from "./components/icons.tsx";
import { t, useLocale } from "./i18n/index.ts";
import { T } from "./i18n/T.tsx";
import { Sidebar, useModuleAvailability } from "./components/Sidebar.tsx";
import { SignInNotice } from "./components/SignIn.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { emergencyStop, OfflineBanner, STOP_SHORTCUT_LABEL, TopBar } from "./components/TopBar.tsx";
import { ToastProvider, useToast } from "./components/toasts.tsx";
import { Button, Field, Loading, Note } from "./components/ui.tsx";
import { onCrashReportSent } from "./lib/crashReports.ts";
import { isTypingTarget, usePersistentState } from "./lib/hooks.ts";
import { useReplayShortcuts } from "./lib/replay-keys.ts";
import { Link, navigate, useLocation } from "./router.tsx";
import type { NavId, NavItem } from "./routes.tsx";
import { crumbsFor, navItem, redirectFor, routeFor } from "./routes.tsx";
import { startLive, stopLive } from "./state/live.ts";
import { SessionContext } from "./state/session.tsx";

export { NAV, ROUTES, REDIRECTS } from "./routes.tsx";

function NotFound({ path }: { path: string }) {
  return (
    <div className="page">
      <h1 className="page-title">{t("shell.notFound.title")}</h1>
      <p>
        <T k="shell.notFound.body" values={{ path: <code>{path}</code> }} /> <Link to="/">{t("shell.notFound.link")}</Link>
      </p>
    </div>
  );
}

/** Section bar: the pages of the current module, as links (each page has its own URL). */
function SectionBar({ item, path }: { item: NavItem; path: string }) {
  if (!item.sub) return null;
  return (
    <div className="section-bar" role="navigation" aria-label={t("shell.sectionPages", { module: item.label })}>
      {item.sub.map((p) => {
        const active = p.path === path;
        return (
          <Link key={p.path} to={p.path} className={`section-link ${active ? "is-active" : ""}`} aria-current={active ? "page" : undefined}>
            {p.label}
          </Link>
        );
      })}
    </div>
  );
}

/** Explains on the page why a module (or part of it) is unavailable; the sidebar shows the same as a badge. */
function ModuleNotice({ id }: { id: NavId }) {
  const availability = useModuleAvailability()[id];
  if (!availability) return null;
  return (
    <div className="module-notice" data-module-notice={id}>
      <Note tone={availability.level === "unavailable" ? "warn" : "neutral"} title={availability.level === "unavailable" ? t("shell.moduleUnavailable", { module: navItem(id).label }) : t("shell.desktopHudsUnavailable")}>
        {availability.reason} {id === "director" ? <Link to="/settings/account">{t("shell.openAccount")}</Link> : null}
      </Note>
    </div>
  );
}

/** Global Stop automation shortcut (F8 or Pause); ignored while typing in an input. */
function useStopShortcut(enabled: boolean) {
  const toast = useToast();
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "F8" && e.key !== "Pause") return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      emergencyStop()
        .then(() => toast.push("ok", t("shell.stopEngagedKey", { key: e.key })))
        .catch((err) => toast.push("danger", t("shell.stopFailed"), describeError(err)));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, toast]);
}

/** Desktop shell (Electron) global hotkey emergency stops are reported here too, and crash reports sent (ADR-077). */
function useDesktopEvents() {
  const toast = useToast();
  useEffect(() => {
    const off = window.matchframe?.onEmergencyStop?.(() => toast.push("ok", t("shell.stopFromHotkey")));
    const offCrash = onCrashReportSent((r) => toast.push("info", t("shell.crashSent", { id: r.id }), t("shell.crashSentBody")));
    return () => {
      off?.();
      offCrash();
    };
  }, [toast]);
}

/**
 * The console layout: sidebar (modules), top toolbar, the page, and the bottom status bar. Opens
 * straight into the HUD Library; signing in is optional (Settings → Account).
 */
export function Shell({ me }: { me: Me }) {
  const { path } = useLocation();
  useDesktopEvents();
  const [navCollapsed, setNavCollapsed] = usePersistentState("navCollapsed", typeof window !== "undefined" && window.innerWidth < 1440);
  useStopShortcut(true);
  // Skip, Hold / Resume, Stop and go live for the replays playing (Ctrl+Shift+F5, F6, F7).
  useReplayShortcuts();
  useEffect(() => {
    startLive();
    return () => stopLive();
  }, []);
  // In the program the window has no system title bar: the header becomes one (drag region,
  // room for the window buttons).
  useEffect(() => {
    const mf = window.matchframe;
    if (!mf?.customTitleBar) return;
    const cls = ["mf-custom-titlebar", `mf-platform-${mf.platform ?? "unknown"}`];
    document.documentElement.classList.add(...cls);
    return () => document.documentElement.classList.remove(...cls);
  }, []);
  const redirect = redirectFor(path);
  useLayoutEffect(() => {
    if (redirect) navigate(`${redirect}${window.location.search}${window.location.hash}`, true);
  }, [redirect]);
  const route = redirect ? null : routeFor(path);
  const item = route ? navItem(route.nav) : null;
  const Screen = route?.component ?? null;
  const crumbs = redirect ? [] : crumbsFor(path);
  useEffect(() => {
    document.title = `${route ? route.title : "MatchFrame"} · MatchFrame Esports`;
  });
  return (
    <SessionContext.Provider value={{ me }}>
      <a href="#main" className="skip-link">
        {t("shell.skip")}
      </a>
      <div className={`shell ${navCollapsed ? "nav-collapsed" : ""}`}>
        <Sidebar collapsed={navCollapsed} onToggle={() => setNavCollapsed(!navCollapsed)} activeId={route?.nav ?? null} />
        <TopBar crumbs={crumbs} />
        <main id="main" className="main" tabIndex={-1}>
          <OfflineBanner />
          <SignInNotice role={me.role} />
          {item ? <SectionBar item={item} path={path} /> : null}
          {item ? <ModuleNotice id={item.id} /> : null}
          {redirect ? null : Screen ? (
            <Suspense fallback={<div className="page"><Loading label={t("shell.loadingPage")} /></div>}>
              <Screen />
            </Suspense>
          ) : (
            <NotFound path={path} />
          )}
        </main>
        <StatusBar />
      </div>
    </SessionContext.Provider>
  );
}

type GateState = { kind: "resolving" } | { kind: "no_token" } | { kind: "invalid"; message: string } | { kind: "unreachable"; message: string } | { kind: "ready"; me: Me };

function TokenGate() {
  const [gate, setGate] = useState<GateState>({ kind: "resolving" });
  const [manual, setManual] = useState("");

  const verify = useCallback(async () => {
    setGate({ kind: "resolving" });
    const token = await resolveOperatorToken();
    if (!token) return setGate({ kind: "no_token" });
    try {
      const me = await api.get<Me>("/api/v1/me");
      if (!me.role) return setGate({ kind: "invalid", message: t("shell.gate.rejected") });
      if (me.role === "captain") return setGate({ kind: "invalid", message: t("shell.gate.captain") });
      setGate({ kind: "ready", me });
    } catch (e) {
      setGate({ kind: e instanceof NetworkError ? "unreachable" : "invalid", message: describeError(e) });
    }
  }, []);

  useEffect(() => {
    void verify();
  }, [verify]);

  if (gate.kind === "ready") return <Shell me={gate.me} />;
  return (
    <div className="gate">
      <div className="gate-card">
        <div className="gate-brand gate-brand-badge">
          <BrandBadge />
        </div>
        {gate.kind === "resolving" ? <p>{window.matchframe?.connectionMode === "remote" ? t("shell.gate.connectingRemote") : t("shell.gate.connecting")}</p> : null}
        {gate.kind === "unreachable" ? (
          <>
            <Note tone="danger" title={t("shell.gate.unreachable")}>
              {gate.message}
            </Note>
            <div className="row">
              <Button variant="primary" onClick={() => void verify()}>
                {t("shell.gate.tryAgain")}
              </Button>
              {window.matchframe?.openConnection ? <Button onClick={() => void window.matchframe!.openConnection!()}>{t("shell.gate.connection")}</Button> : null}
            </div>
          </>
        ) : null}
        {gate.kind === "no_token" || gate.kind === "invalid" ? (
          <>
            {gate.kind === "invalid" ? (
              <Note tone="danger" title={t("shell.gate.notAccepted")}>
                {gate.message}
              </Note>
            ) : (
              <p>
                <T k="shell.gate.devHint" />
              </p>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!manual.trim()) return;
                setOperatorToken(manual.trim());
                void verify();
              }}
            >
              <Field label={t("shell.gate.token")} hint={t("shell.gate.tokenHint")}>
                <input type="password" autoComplete="off" value={manual} onChange={(e) => setManual(e.target.value)} />
              </Field>
              <Button type="submit" variant="primary" disabledReason={manual.trim() ? null : t("shell.gate.pasteFirst")} reasonPlacement="tooltip">
                {t("shell.gate.continue")}
              </Button>
            </form>
          </>
        ) : null}
        <p className="gate-foot">{t("shell.gate.foot", { key: STOP_SHORTCUT_LABEL })}</p>
      </div>
    </div>
  );
}

export function App() {
  // The whole console renders again in the new language when the Language setting changes (ADR-082).
  useLocale();
  return (
    <ToastProvider>
      <TokenGate />
    </ToastProvider>
  );
}
