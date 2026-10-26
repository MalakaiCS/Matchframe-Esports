import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import type { ComponentType } from "react";
import { api, describeError, NetworkError } from "./api/index.ts";
import { resolveOperatorToken, setOperatorToken } from "./api/auth.ts";
import type { Me } from "./api/types.ts";
import { Icon, Logo } from "./components/icons.tsx";
import { emergencyStop, OfflineBanner, STOP_SHORTCUT_LABEL, TopBar } from "./components/TopBar.tsx";
import { ToastProvider, useToast } from "./components/toasts.tsx";
import { Button, Field, Loading, Note } from "./components/ui.tsx";
import { isTypingTarget, usePersistentState } from "./lib/hooks.ts";
import { Link, useLocation } from "./router.tsx";
import { startLive, stopLive } from "./state/live.ts";
import { SessionContext } from "./state/session.tsx";

// Screens are code-split: each loads on first visit.
const CaptainPage = lazy(() => import("./screens/Captain.tsx").then((m) => ({ default: m.CaptainPage })));
const DemosScreen = lazy(() => import("./screens/Demos.tsx").then((m) => ({ default: m.DemosScreen })));
const DevicesScreen = lazy(() => import("./screens/Devices.tsx").then((m) => ({ default: m.DevicesScreen })));
const DirectorScreen = lazy(() => import("./screens/Director.tsx").then((m) => ({ default: m.DirectorScreen })));
const EventsScreen = lazy(() => import("./screens/Events.tsx").then((m) => ({ default: m.EventsScreen })));
const HudsScreen = lazy(() => import("./screens/Huds.tsx").then((m) => ({ default: m.HudsScreen })));
const LiveControlScreen = lazy(() => import("./screens/LiveControl.tsx").then((m) => ({ default: m.LiveControlScreen })));
const MapsScreen = lazy(() => import("./screens/Maps.tsx").then((m) => ({ default: m.MapsScreen })));
const MatchesScreen = lazy(() => import("./screens/Matches.tsx").then((m) => ({ default: m.MatchesScreen })));
const OverviewScreen = lazy(() => import("./screens/Overview.tsx").then((m) => ({ default: m.OverviewScreen })));
const PlayerCamerasScreen = lazy(() => import("./screens/PlayerCameras.tsx").then((m) => ({ default: m.PlayerCamerasScreen })));
const ReplaysScreen = lazy(() => import("./screens/Replays.tsx").then((m) => ({ default: m.ReplaysScreen })));
const SettingsScreen = lazy(() => import("./screens/Settings.tsx").then((m) => ({ default: m.SettingsScreen })));
const SetupScreen = lazy(() => import("./screens/Setup.tsx").then((m) => ({ default: m.SetupScreen })));
const SponsorsScreen = lazy(() => import("./screens/Sponsors.tsx").then((m) => ({ default: m.SponsorsScreen })));
const StudioScreen = lazy(() => import("./screens/Studio.tsx").then((m) => ({ default: m.StudioScreen })));
const TeamsScreen = lazy(() => import("./screens/Teams.tsx").then((m) => ({ default: m.TeamsScreen })));
const TrainingScreen = lazy(() => import("./screens/Training.tsx").then((m) => ({ default: m.TrainingScreen })));

export interface NavItem {
  path: string;
  label: string;
  icon: string;
  component: ComponentType;
}

/** Primary navigation, in the order defined by the product spec. */
export const NAV: NavItem[] = [
  { path: "/", label: "Overview", icon: "overview", component: OverviewScreen },
  { path: "/events", label: "Events", icon: "events", component: EventsScreen },
  { path: "/teams", label: "Teams & Players", icon: "teams", component: TeamsScreen },
  { path: "/matches", label: "Matches & Veto", icon: "matches", component: MatchesScreen },
  { path: "/live", label: "Live Control", icon: "live", component: LiveControlScreen },
  { path: "/huds", label: "HUDs & Composer", icon: "huds", component: HudsScreen },
  { path: "/director", label: "Director", icon: "director", component: DirectorScreen },
  { path: "/maps", label: "Maps & Cameras", icon: "maps", component: MapsScreen },
  { path: "/replays", label: "Replays & Highlights", icon: "replays", component: ReplaysScreen },
  { path: "/player-cameras", label: "Player Cameras", icon: "playercams", component: PlayerCamerasScreen },
  { path: "/studio", label: "Studio & Rundown", icon: "studio", component: StudioScreen },
  { path: "/sponsors", label: "Sponsors & Automation", icon: "sponsors", component: SponsorsScreen },
  { path: "/demos", label: "Demo Library", icon: "demos", component: DemosScreen },
  { path: "/training", label: "Training & Evaluation", icon: "training", component: TrainingScreen },
  { path: "/devices", label: "Devices & Integrations", icon: "devices", component: DevicesScreen },
  { path: "/settings", label: "Settings & Diagnostics", icon: "settings", component: SettingsScreen },
];

const EXTRA_ROUTES: Record<string, ComponentType> = { "/setup": SetupScreen };

function Nav({ collapsed, path }: { collapsed: boolean; path: string }) {
  return (
    <nav className={`nav ${collapsed ? "is-collapsed" : ""}`} aria-label="Primary">
      <ul>
        {NAV.map((n) => {
          const active = n.path === "/" ? path === "/" : path === n.path || path.startsWith(`${n.path}/`);
          return (
            <li key={n.path}>
              <Link to={n.path} className={`nav-link ${active ? "is-active" : ""}`} aria-current={active ? "page" : undefined} title={collapsed ? n.label : undefined}>
                <Icon name={n.icon} />
                <span className="nav-label">{n.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="nav-foot">
        <Link to="/setup" className={`nav-link nav-link-secondary ${path === "/setup" ? "is-active" : ""}`} aria-current={path === "/setup" ? "page" : undefined} title={collapsed ? "Setup checklist" : undefined}>
          <Icon name="setup" />
          <span className="nav-label">Setup checklist</span>
        </Link>
      </div>
    </nav>
  );
}

function NotFound({ path }: { path: string }) {
  return (
    <div className="page">
      <h1 className="page-title">Page not found</h1>
      <p>
        There is no console page at <code>{path}</code>. <Link to="/">Go to the Overview.</Link>
      </p>
    </div>
  );
}

/** Global STOP AUTOMATION shortcut (F8 or Pause); ignored while typing in an input. */
function useStopShortcut(enabled: boolean) {
  const toast = useToast();
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "F8" && e.key !== "Pause") return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      emergencyStop()
        .then(() => toast.push("ok", `STOP AUTOMATION (${e.key}): emergency stop engaged`))
        .catch((err) => toast.push("danger", "STOP AUTOMATION failed", describeError(err)));
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

function Shell({ me }: { me: Me }) {
  const { path } = useLocation();
  useDesktopEvents();
  const [navCollapsed, setNavCollapsed] = usePersistentState("navCollapsed", typeof window !== "undefined" && window.innerWidth < 1440);
  useStopShortcut(true);
  useEffect(() => {
    startLive();
    return () => stopLive();
  }, []);
  const item = NAV.find((n) => n.path === path);
  const Screen = item?.component ?? EXTRA_ROUTES[path] ?? null;
  useEffect(() => {
    const label = item?.label ?? (path === "/setup" ? "Setup" : "Matchframe");
    document.title = `${label} · Matchframe Operator`;
  }, [item, path]);
  return (
    <SessionContext.Provider value={{ me }}>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <div className={`shell ${navCollapsed ? "nav-collapsed" : ""}`}>
        <TopBar onToggleNav={() => setNavCollapsed(!navCollapsed)} />
        <Nav collapsed={navCollapsed} path={path} />
        <main id="main" className="main" tabIndex={-1}>
          <OfflineBanner />
          {Screen ? (
            <Suspense fallback={<div className="page"><Loading label="Loading page…" /></div>}>
              <Screen />
            </Suspense>
          ) : (
            <NotFound path={path} />
          )}
        </main>
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
      if (me.role === "captain") return setGate({ kind: "invalid", message: "This is a captain veto link, not an operator token. Open it at /captain." });
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
        <div className="gate-brand">
          <Logo /> <span>Matchframe Operator</span>
        </div>
        {gate.kind === "resolving" ? <p>Connecting to the local engine…</p> : null}
        {gate.kind === "unreachable" ? (
          <>
            <Note tone="danger" title="ENGINE UNREACHABLE">
              {gate.message}
            </Note>
            <Button variant="primary" onClick={() => void verify()}>
              Try again
            </Button>
          </>
        ) : null}
        {gate.kind === "no_token" || gate.kind === "invalid" ? (
          <>
            {gate.kind === "invalid" ? (
              <Note tone="danger" title="TOKEN NOT ACCEPTED">
                {gate.message}
              </Note>
            ) : (
              <p>This console needs the operator token. Open the operator URL printed by the engine (it is also written to <code>operator-url.txt</code> in the Matchframe data folder), or paste the token below.</p>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!manual.trim()) return;
                setOperatorToken(manual.trim());
                void verify();
              }}
            >
              <Field label="Operator token" hint="Kept only for this browser session; never shown in the address bar.">
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
  const { path } = useLocation();
  return (
    <ToastProvider>
      {path === "/captain" ? (
        <Suspense fallback={<Loading label="Loading veto…" />}>
          <CaptainPage />
        </Suspense>
      ) : (
        <TokenGate />
      )}
    </ToastProvider>
  );
}
