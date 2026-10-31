import { lazy } from "react";
import type { ComponentType } from "react";
import type { SettingsTabId } from "./screens/Settings.tsx";

// Screens are code-split: each loads on first visit.
const AccountScreen = lazy(() => import("./screens/Account.tsx").then((m) => ({ default: m.AccountScreen })));
const DemosScreen = lazy(() => import("./screens/Demos.tsx").then((m) => ({ default: m.DemosScreen })));
const DevicesScreen = lazy(() => import("./screens/Devices.tsx").then((m) => ({ default: m.DevicesScreen })));
const DirectorScreen = lazy(() => import("./screens/Director.tsx").then((m) => ({ default: m.DirectorScreen })));
const EventsScreen = lazy(() => import("./screens/Events.tsx").then((m) => ({ default: m.EventsScreen })));
const HudLibraryScreen = lazy(() => import("./screens/HudLibrary.tsx").then((m) => ({ default: m.HudLibraryScreen })));
const HudImagesScreen = lazy(() => import("./screens/HudImages.tsx").then((m) => ({ default: m.HudImagesScreen })));
const HudOutputsScreen = lazy(() => import("./screens/Huds.tsx").then((m) => ({ default: m.HudOutputsScreen })));
const HudCuesScreen = lazy(() => import("./screens/Huds.tsx").then((m) => ({ default: m.HudCuesScreen })));
const HudAnnotationsScreen = lazy(() => import("./screens/Huds.tsx").then((m) => ({ default: m.HudAnnotationsScreen })));
const HudComposerScreen = lazy(() => import("./screens/Huds.tsx").then((m) => ({ default: m.HudComposerScreen })));
const LiveControlScreen = lazy(() => import("./screens/LiveControl.tsx").then((m) => ({ default: m.LiveControlScreen })));
const MapsScreen = lazy(() => import("./screens/Maps.tsx").then((m) => ({ default: m.MapsScreen })));
const MatchesScreen = lazy(() => import("./screens/Matches.tsx").then((m) => ({ default: m.MatchesScreen })));
const PlayerCamerasScreen = lazy(() => import("./screens/PlayerCameras.tsx").then((m) => ({ default: m.PlayerCamerasScreen })));
const PlayersScreen = lazy(() => import("./screens/Teams.tsx").then((m) => ({ default: m.PlayersScreen })));
const ReplaysScreen = lazy(() => import("./screens/Replays.tsx").then((m) => ({ default: m.ReplaysScreen })));
const SetupScreen = lazy(() => import("./screens/Setup.tsx").then((m) => ({ default: m.SetupScreen })));
const SponsorsScreen = lazy(() => import("./screens/Sponsors.tsx").then((m) => ({ default: m.SponsorsScreen })));
const StudioScreen = lazy(() => import("./screens/Studio.tsx").then((m) => ({ default: m.StudioScreen })));
const TeamsScreen = lazy(() => import("./screens/Teams.tsx").then((m) => ({ default: m.TeamsScreen })));
const TrainingScreen = lazy(() => import("./screens/Training.tsx").then((m) => ({ default: m.TrainingScreen })));

const settingsPage = (tab: SettingsTabId) =>
  lazy(() =>
    import("./screens/Settings.tsx").then((m) => ({
      default: function SettingsPage() {
        return <m.SettingsScreen tab={tab} />;
      },
    })),
  );

export type NavId = "huds" | "teams" | "players" | "matches" | "tournaments" | "live" | "director" | "replays" | "cameras" | "settings";

export interface SubPage {
  path: string;
  label: string;
}

export interface NavItem {
  id: NavId;
  path: string;
  label: string;
  icon: string;
  /** Pages of this module, shown as a section bar above the page. */
  sub?: SubPage[];
}

/** Sidebar, in the order operators asked for; Settings sits at the bottom. */
export const NAV: NavItem[] = [
  {
    id: "huds",
    path: "/",
    label: "HUD Library",
    icon: "library",
    sub: [
      { path: "/", label: "Library" },
      { path: "/hud/outputs", label: "Broadcast outputs" },
      { path: "/hud/cues", label: "Cues" },
      { path: "/hud/annotations", label: "Annotations" },
      { path: "/hud/composer", label: "Composer" },
      { path: "/hud/sponsors", label: "Sponsors & automation" },
    ],
  },
  { id: "teams", path: "/teams", label: "Teams", icon: "teams" },
  { id: "players", path: "/players", label: "Players", icon: "players" },
  { id: "matches", path: "/matches", label: "Matches", icon: "matches" },
  { id: "tournaments", path: "/tournaments", label: "Tournaments", icon: "tournaments" },
  {
    id: "live",
    path: "/live",
    label: "Live Control",
    icon: "live",
    sub: [
      { path: "/live", label: "Live Control" },
      { path: "/live/studio", label: "Studio & rundown" },
    ],
  },
  {
    id: "director",
    path: "/director",
    label: "Auto Director",
    icon: "director",
    sub: [
      { path: "/director", label: "Director" },
      { path: "/director/demos", label: "Demo library" },
      { path: "/director/training", label: "Training" },
    ],
  },
  { id: "replays", path: "/replays", label: "Replays", icon: "replays" },
  {
    id: "cameras",
    path: "/cameras",
    label: "Cameras",
    icon: "cameras",
    sub: [
      { path: "/cameras", label: "Maps & cameras" },
      { path: "/cameras/players", label: "Player cameras" },
    ],
  },
  {
    id: "settings",
    path: "/settings",
    label: "Settings",
    icon: "settings",
    sub: [
      { path: "/settings", label: "General" },
      { path: "/settings/setup", label: "Setup" },
      { path: "/settings/account", label: "Account" },
      { path: "/settings/devices", label: "Devices" },
      { path: "/settings/stats", label: "Stats & reports" },
      { path: "/settings/diagnostics", label: "Diagnostics" },
      { path: "/settings/logs", label: "Logs" },
      { path: "/settings/audit", label: "Audit log" },
      { path: "/settings/advanced", label: "Advanced" },
    ],
  },
];

export interface RouteDef {
  path: string;
  nav: NavId;
  /** Page name (toolbar and window title). */
  title: string;
  component: ComponentType;
}

export const ROUTES: RouteDef[] = [
  { path: "/", nav: "huds", title: "HUD Library", component: HudLibraryScreen },
  // Opened from the library's toolbar (it applies to every HUD).
  { path: "/hud/images", nav: "huds", title: "HUD images", component: HudImagesScreen },
  { path: "/hud/outputs", nav: "huds", title: "Broadcast outputs", component: HudOutputsScreen },
  { path: "/hud/cues", nav: "huds", title: "Cues", component: HudCuesScreen },
  { path: "/hud/annotations", nav: "huds", title: "Annotations", component: HudAnnotationsScreen },
  { path: "/hud/composer", nav: "huds", title: "Composer", component: HudComposerScreen },
  { path: "/hud/sponsors", nav: "huds", title: "Sponsors & automation", component: SponsorsScreen },
  { path: "/teams", nav: "teams", title: "Teams", component: TeamsScreen },
  { path: "/players", nav: "players", title: "Players", component: PlayersScreen },
  { path: "/matches", nav: "matches", title: "Matches & veto", component: MatchesScreen },
  { path: "/tournaments", nav: "tournaments", title: "Tournaments", component: EventsScreen },
  { path: "/live", nav: "live", title: "Live Control", component: LiveControlScreen },
  { path: "/live/studio", nav: "live", title: "Studio & rundown", component: StudioScreen },
  { path: "/director", nav: "director", title: "Auto Director", component: DirectorScreen },
  { path: "/director/demos", nav: "director", title: "Demo library", component: DemosScreen },
  { path: "/director/training", nav: "director", title: "Training & evaluation", component: TrainingScreen },
  { path: "/replays", nav: "replays", title: "Replays & highlights", component: ReplaysScreen },
  { path: "/cameras", nav: "cameras", title: "Maps & cameras", component: MapsScreen },
  { path: "/cameras/players", nav: "cameras", title: "Player cameras", component: PlayerCamerasScreen },
  { path: "/settings", nav: "settings", title: "General", component: settingsPage("general") },
  { path: "/settings/setup", nav: "settings", title: "Setup", component: SetupScreen },
  { path: "/settings/account", nav: "settings", title: "Account & hours", component: AccountScreen },
  { path: "/settings/devices", nav: "settings", title: "Devices & integrations", component: DevicesScreen },
  { path: "/settings/stats", nav: "settings", title: "Stats & reports", component: settingsPage("stats") },
  { path: "/settings/diagnostics", nav: "settings", title: "Diagnostics", component: settingsPage("diagnostics") },
  { path: "/settings/logs", nav: "settings", title: "Logs", component: settingsPage("logs") },
  { path: "/settings/audit", nav: "settings", title: "Audit log", component: settingsPage("audit") },
  { path: "/settings/advanced", nav: "settings", title: "Advanced", component: settingsPage("settings") },
];

/** Paths of the 0.1 console, still used by links, bookmarks and the docs. Query and #anchor are kept. */
export const REDIRECTS: Record<string, string> = {
  "/overview": "/",
  "/huds": "/",
  "/hud": "/",
  "/events": "/tournaments",
  "/maps": "/cameras",
  "/player-cameras": "/cameras/players",
  "/studio": "/live/studio",
  "/sponsors": "/hud/sponsors",
  "/demos": "/director/demos",
  "/training": "/director/training",
  "/setup": "/settings/setup",
  "/devices": "/settings/devices",
  "/account": "/settings/account",
  "/settings/general": "/settings",
};

export function redirectFor(path: string): string | null {
  return REDIRECTS[path] ?? null;
}

export function routeFor(path: string): RouteDef | null {
  return ROUTES.find((r) => r.path === path) ?? null;
}

export function navItem(id: NavId): NavItem {
  return NAV.find((n) => n.id === id)!;
}

/** Toolbar breadcrumb: the module, then the page when the module has several. */
export function crumbsFor(path: string): string[] {
  const r = routeFor(path);
  if (!r) return ["Page not found"];
  const n = navItem(r.nav);
  if (!n.sub || r.path === n.path) return n.sub && r.title !== n.label ? [n.label, r.title] : [n.label];
  return [n.label, r.title];
}
