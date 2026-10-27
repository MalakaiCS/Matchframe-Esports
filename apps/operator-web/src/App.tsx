import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import { api, describeError, NetworkError } from "./api/index.ts";
import { resolveOperatorToken, setOperatorToken } from "./api/auth.ts";
import type { Me } from "./api/types.ts";
import { BrandBadge, Icon } from "./components/icons.tsx";
import { SignInGate } from "./components/SignIn.tsx";
import { emergencyStop, OfflineBanner, STOP_SHORTCUT_LABEL, TopBar } from "./components/TopBar.tsx";
import { ToastProvider, useToast } from "./components/toasts.tsx";
import { Button, Field, Loading, Note } from "./components/ui.tsx";
import { isTypingTarget, usePersistentState } from "./lib/hooks.ts";
import { Link, useLocation } from "./router.tsx";
import { startLive, stopLive } from "./state/live.ts";
import { SessionContext } from "./state/session.tsx";

// Screens are code-split: each loads on first visit.
const AccountScreen = lazy(() => import("./screens/Account.tsx").then((m) => ({ default: m.AccountScreen })));
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
  /** Page name in the window title, when it differs from the short sidebar label. */
  title?: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/** Sidebar, grouped by what the operator is doing. */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Broadcast",
    items: [
      { path: "/", label: "Overview", icon: "overview", component: OverviewScreen },
      { path: "/live", label: "Live Control", icon: "live", component: LiveControlScreen },
      { path: "/director", label: "Director", icon: "director", component: DirectorScreen },
      { path: "/replays", label: "Replays", icon: "replays", component: ReplaysScreen, title: "Replays & Highlights" },
      { path: "/studio", label: "Studio", icon: "studio", component: StudioScreen, title: "Studio & Rundown" },
    ],
  },
  {
    label: "Event",
    items: [
      { path: "/events", label: "Events", icon: "events", component: EventsScreen },
      { path: "/teams", label: "Teams", icon: "teams", component: TeamsScreen, title: "Teams & Players" },
      { path: "/matches", label: "Matches", icon: "matches", component: MatchesScreen, title: "Matches & Veto" },
    ],
  },
  {
    label: "Graphics & cameras",
    items: [
      { path: "/huds", label: "HUDs", icon: "huds", component: HudsScreen, title: "HUDs & Composer" },
      { path: "/sponsors", label: "Sponsors", icon: "sponsors", component: SponsorsScreen, title: "Sponsors & Automation" },
      { path: "/maps", label: "Maps & Cameras", icon: "maps", component: MapsScreen },
      { path: "/player-cameras", label: "Player Cameras", icon: "playercams", component: PlayerCamerasScreen },
    ],
  },
  {
    label: "Analysis",
    items: [
      { path: "/demos", label: "Demos", icon: "demos", component: DemosScreen, title: "Demo Library" },
      { path: "/training", label: "Training", icon: "training", component: TrainingScreen, title: "Training & Evaluation" },
    ],
  },
  {
    label: "System",
    items: [
      { path: "/setup", label: "Setup", icon: "setup", component: SetupScreen },
      { path: "/devices", label: "Devices", icon: "devices", component: DevicesScreen, title: "Devices & Integrations" },
      { path: "/account", label: "Account", icon: "account", component: AccountScreen, title: "Account & Hours" },
      { path: "/settings", label: "Settings", icon: "settings", component: SettingsScreen, title: "Settings & Diagnostics" },
    ],
  },
];

export const NAV: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

function Nav({ collapsed, path }: { collapsed: boolean; path: string }) {
  return (
    <nav className={`nav ${collapsed ? "is-collapsed" : ""}`} aria-label="Primary">
      {NAV_GROUPS.map((g) => (
        <div className="nav-group" key={g.label}>
          <div className="nav-group-label" aria-hidden>
            {g.label}
          </div>
          <ul aria-label={g.label}>
            {g.items.map((n) => {
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
        </div>
      ))}
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

function Shell({ me, notice }: { me: Me; notice?: ReactNode }) {
  const { path } = useLocation();
  useDesktopEvents();
  const [navCollapsed, setNavCollapsed] = usePersistentState("navCollapsed", typeof window !== "undefined" && window.innerWidth < 1440);
  useStopShortcut(true);
  useEffect(() => {
    startLive();
    return () => stopLive();
  }, []);
  const item = NAV.find((n) => n.path === path);
  const Screen = item?.component ?? null;
  useEffect(() => {
    document.title = `${item ? (item.title ?? item.label) : "Matchframe"} · Matchframe Operator`;
  }, [item]);
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
          {notice ? <div className="signin-notice">{notice}</div> : null}
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
      if (me.role === "captain") return setGate({ kind: "invalid", message: "This is a captain veto token, not an operator token. Captains use their veto link in a browser." });
      setGate({ kind: "ready", me });
    } catch (e) {
      setGate({ kind: e instanceof NetworkError ? "unreachable" : "invalid", message: describeError(e) });
    }
  }, []);

  useEffect(() => {
    void verify();
  }, [verify]);

  if (gate.kind === "ready") {
    const me = gate.me;
    return <SignInGate role={me.role}>{(notice) => <Shell me={me} notice={notice} />}</SignInGate>;
  }
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
