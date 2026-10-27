import { Suspense, useCallback, useEffect, useLayoutEffect, useState } from "react";
import { api, describeError, NetworkError } from "./api/index.ts";
import { resolveOperatorToken, setOperatorToken } from "./api/auth.ts";
import type { Me } from "./api/types.ts";
import { BrandBadge } from "./components/icons.tsx";
import { Sidebar, useModuleAvailability } from "./components/Sidebar.tsx";
import { SignInNotice } from "./components/SignIn.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { emergencyStop, OfflineBanner, STOP_SHORTCUT_LABEL, TopBar } from "./components/TopBar.tsx";
import { ToastProvider, useToast } from "./components/toasts.tsx";
import { Button, Field, Loading, Note } from "./components/ui.tsx";
import { isTypingTarget, usePersistentState } from "./lib/hooks.ts";
import { Link, navigate, useLocation } from "./router.tsx";
import type { NavId, NavItem } from "./routes.tsx";
import { crumbsFor, navItem, redirectFor, routeFor } from "./routes.tsx";
import { startLive, stopLive } from "./state/live.ts";
import { SessionContext } from "./state/session.tsx";

export { NAV, ROUTES, REDIRECTS } from "./routes.tsx";

function NotFound({ path }: { path: string }) {
  return (
    <div className="page">
      <h1 className="page-title">Page not found</h1>
      <p>
        There is no console page at <code>{path}</code>. <Link to="/">Go to the HUD Library.</Link>
      </p>
    </div>
  );
}

/** Section bar: the pages of the current module, as links (each page has its own URL). */
function SectionBar({ item, path }: { item: NavItem; path: string }) {
  if (!item.sub) return null;
  return (
    <div className="section-bar" role="navigation" aria-label={`${item.label} pages`}>
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
      <Note tone={availability.level === "unavailable" ? "warn" : "neutral"} title={availability.level === "unavailable" ? `${navItem(id).label} unavailable` : "Desktop HUDs unavailable"}>
        {availability.reason} {id === "director" ? <Link to="/settings/account">Open Settings → Account</Link> : null}
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
        .then(() => toast.push("ok", `Emergency stop engaged (${e.key}): automation stopped`))
        .catch((err) => toast.push("danger", "Stop automation failed", describeError(err)));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, toast]);
}

/** Desktop shell (Electron) global hotkey emergency stops are reported here too. */
function useDesktopEvents() {
  const toast = useToast();
  useEffect(() => {
    const off = window.matchframe?.onEmergencyStop?.(() => toast.push("ok", "Emergency stop engaged from the desktop global hotkey"));
    return () => off?.();
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
  useEffect(() => {
    startLive();
    return () => stopLive();
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
    document.title = `${route ? route.title : "Matchframe"} · Matchframe Esports`;
  }, [route]);
  return (
    <SessionContext.Provider value={{ me }}>
      <a href="#main" className="skip-link">
        Skip to content
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
            <Suspense fallback={<div className="page"><Loading label="Loading page…" /></div>}>
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
      if (!me.role) return setGate({ kind: "invalid", message: "The engine did not accept this token. It may have been rotated, revoked or belong to another engine installation." });
      if (me.role === "captain") return setGate({ kind: "invalid", message: "This is a captain veto token, not an operator token. Captains use their veto link in a browser." });
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
        {gate.kind === "resolving" ? <p>{window.matchframe?.connectionMode === "remote" ? "Connecting to the production computer…" : "Connecting to the Matchframe engine…"}</p> : null}
        {gate.kind === "unreachable" ? (
          <>
            <Note tone="danger" title="Engine unreachable">
              {gate.message}
            </Note>
            <div className="row">
              <Button variant="primary" onClick={() => void verify()}>
                Try again
              </Button>
              {window.matchframe?.openConnection ? <Button onClick={() => void window.matchframe!.openConnection!()}>Connection settings</Button> : null}
            </div>
          </>
        ) : null}
        {gate.kind === "no_token" || gate.kind === "invalid" ? (
          <>
            {gate.kind === "invalid" ? (
              <Note tone="danger" title="Token not accepted">
                {gate.message}
              </Note>
            ) : (
              <p>This console runs inside the Matchframe program, which signs it in automatically. During development, paste the operator token from <code>operator-token.txt</code> in the Matchframe data folder.</p>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!manual.trim()) return;
                setOperatorToken(manual.trim());
                void verify();
              }}
            >
              <Field label="Operator token" hint="Kept only for this session; never shown in the address bar.">
                <input type="password" autoComplete="off" value={manual} onChange={(e) => setManual(e.target.value)} />
              </Field>
              <Button type="submit" variant="primary" disabledReason={manual.trim() ? null : "Paste a token first"} reasonPlacement="tooltip">
                Continue
              </Button>
            </form>
          </>
        ) : null}
        <p className="gate-foot">Emergency stop shortcut once connected: {STOP_SHORTCUT_LABEL} (or Pause).</p>
      </div>
    </div>
  );
}

export function App() {
  return (
    <ToastProvider>
      <TokenGate />
    </ToastProvider>
  );
}
