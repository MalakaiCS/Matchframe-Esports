import { lazy } from "react";
import type { ComponentType } from "react";
import { perLocale, t } from "./i18n/index.ts";
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
const MatchEditorScreen = lazy(() => import("./screens/Matches.tsx").then((m) => ({ default: m.MatchEditorScreen })));
const PlayerCamerasScreen = lazy(() => import("./screens/PlayerCameras.tsx").then((m) => ({ default: m.PlayerCamerasScreen })));
const PlayersScreen = lazy(() => import("./screens/Teams.tsx").then((m) => ({ default: m.PlayersScreen })));
const PlayerEditorScreen = lazy(() => import("./screens/Teams.tsx").then((m) => ({ default: m.PlayerEditorScreen })));
const ReplaysScreen = lazy(() => import("./screens/Replays.tsx").then((m) => ({ default: m.ReplaysScreen })));
const SetupScreen = lazy(() => import("./screens/Setup.tsx").then((m) => ({ default: m.SetupScreen })));
const SponsorsScreen = lazy(() => import("./screens/Sponsors.tsx").then((m) => ({ default: m.SponsorsScreen })));
const StudioScreen = lazy(() => import("./screens/Studio.tsx").then((m) => ({ default: m.StudioScreen })));
const TeamCommsScreen = lazy(() => import("./screens/TeamComms.tsx").then((m) => ({ default: m.TeamCommsScreen })));
const TeamsScreen = lazy(() => import("./screens/Teams.tsx").then((m) => ({ default: m.TeamsScreen })));
const TeamEditorScreen = lazy(() => import("./screens/Teams.tsx").then((m) => ({ default: m.TeamEditorScreen })));
const TrainingScreen = lazy(() => import("./screens/Training.tsx").then((m) => ({ default: m.TrainingScreen })));

const settingsPage = (tab: SettingsTabId) =>
  lazy(() =>
    import("./screens/Settings.tsx").then((m) => ({
      default: function SettingsPage() {
        return <m.SettingsScreen tab={tab} />;
      },
    })),
  );

const SettingsGeneral = settingsPage("general");
const SettingsStats = settingsPage("stats");
const SettingsDiagnostics = settingsPage("diagnostics");
const SettingsLogs = settingsPage("logs");
const SettingsAudit = settingsPage("audit");
const SettingsAdvanced = settingsPage("settings");

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
export const NAV: NavItem[] = perLocale(() => [
  {
    id: "huds",
    path: "/",
    label: t("nav.hudLibrary"),
    icon: "library",
    sub: [
      { path: "/", label: t("nav.library") },
      { path: "/hud/outputs", label: t("nav.broadcastOutputs") },
      { path: "/hud/cues", label: t("nav.cues") },
      { path: "/hud/annotations", label: t("nav.annotations") },
      { path: "/hud/composer", label: t("nav.composer") },
      { path: "/hud/sponsors", label: t("nav.sponsorsAutomation") },
    ],
  },
  { id: "teams", path: "/teams", label: t("nav.teams"), icon: "teams" },
  { id: "players", path: "/players", label: t("nav.players"), icon: "players" },
  { id: "matches", path: "/matches", label: t("nav.matches"), icon: "matches" },
  { id: "tournaments", path: "/tournaments", label: t("nav.tournaments"), icon: "tournaments" },
  {
    id: "live",
    path: "/live",
    label: t("nav.liveControl"),
    icon: "live",
    sub: [
      { path: "/live", label: t("nav.liveControl") },
      { path: "/live/comms", label: t("nav.teamComms") },
      { path: "/live/studio", label: t("nav.studioRundown") },
    ],
  },
  {
    id: "director",
    path: "/director",
    label: t("nav.autoDirector"),
    icon: "director",
    sub: [
      { path: "/director", label: t("nav.director") },
      { path: "/director/demos", label: t("nav.demoLibrary") },
      { path: "/director/training", label: t("nav.training") },
    ],
  },
  { id: "replays", path: "/replays", label: t("nav.replays"), icon: "replays" },
  {
    id: "cameras",
    path: "/cameras",
    label: t("nav.cameras"),
    icon: "cameras",
    sub: [
      { path: "/cameras", label: t("nav.mapsCameras") },
      { path: "/cameras/players", label: t("nav.playerCameras") },
    ],
  },
  {
    id: "settings",
    path: "/settings",
    label: t("nav.settings"),
    icon: "settings",
    sub: [
      { path: "/settings", label: t("nav.general") },
      { path: "/settings/setup", label: t("nav.setup") },
      { path: "/settings/account", label: t("nav.account") },
      { path: "/settings/devices", label: t("nav.devices") },
      { path: "/settings/stats", label: t("nav.statsReports") },
      { path: "/settings/diagnostics", label: t("nav.diagnostics") },
      { path: "/settings/logs", label: t("nav.logs") },
      { path: "/settings/audit", label: t("nav.auditLog") },
      { path: "/settings/advanced", label: t("nav.advanced") },
    ],
  },
]);

export interface RouteDef {
  path: string;
  nav: NavId;
  /** Page name (toolbar and window title). */
  title: string;
  component: ComponentType;
  /** For pages with an id in the path (/teams/:id/edit): matches the path instead of `path`. */
  pattern?: RegExp;
}

export const ROUTES: RouteDef[] = perLocale(() => [
  { path: "/", nav: "huds", title: t("nav.hudLibrary"), component: HudLibraryScreen },
  // Opened from the library's toolbar (it applies to every HUD).
  { path: "/hud/images", nav: "huds", title: t("nav.hudImages"), component: HudImagesScreen },
  { path: "/hud/outputs", nav: "huds", title: t("nav.broadcastOutputs"), component: HudOutputsScreen },
  { path: "/hud/cues", nav: "huds", title: t("nav.cues"), component: HudCuesScreen },
  { path: "/hud/annotations", nav: "huds", title: t("nav.annotations"), component: HudAnnotationsScreen },
  { path: "/hud/composer", nav: "huds", title: t("nav.composer"), component: HudComposerScreen },
  { path: "/hud/sponsors", nav: "huds", title: t("nav.sponsorsAutomation"), component: SponsorsScreen },
  { path: "/teams", nav: "teams", title: t("nav.teams"), component: TeamsScreen },
  { path: "/players", nav: "players", title: t("nav.players"), component: PlayersScreen },
  { path: "/teams/new", nav: "teams", title: t("nav.addTeam"), component: TeamEditorScreen },
  { path: "/teams/:id/edit", nav: "teams", title: t("nav.editTeam"), component: TeamEditorScreen, pattern: /^\/teams\/[^/]+\/edit$/ },
  { path: "/players/new", nav: "players", title: t("nav.addPlayer"), component: PlayerEditorScreen },
  { path: "/players/:id/edit", nav: "players", title: t("nav.editPlayer"), component: PlayerEditorScreen, pattern: /^\/players\/[^/]+\/edit$/ },
  { path: "/matches", nav: "matches", title: t("nav.matches"), component: MatchesScreen },
  { path: "/matches/new", nav: "matches", title: t("nav.createMatch"), component: MatchEditorScreen },
  { path: "/matches/:id/edit", nav: "matches", title: t("nav.editMatch"), component: MatchEditorScreen, pattern: /^\/matches\/[^/]+\/edit$/ },
  { path: "/tournaments", nav: "tournaments", title: t("nav.tournaments"), component: EventsScreen },
  { path: "/live", nav: "live", title: t("nav.liveControl"), component: LiveControlScreen },
  { path: "/live/comms", nav: "live", title: t("nav.teamComms"), component: TeamCommsScreen },
  { path: "/live/studio", nav: "live", title: t("nav.studioRundown"), component: StudioScreen },
  { path: "/director", nav: "director", title: t("nav.autoDirector"), component: DirectorScreen },
  { path: "/director/demos", nav: "director", title: t("nav.demoLibrary"), component: DemosScreen },
  { path: "/director/training", nav: "director", title: t("nav.trainingEvaluation"), component: TrainingScreen },
  { path: "/replays", nav: "replays", title: t("nav.replaysHighlights"), component: ReplaysScreen },
  { path: "/cameras", nav: "cameras", title: t("nav.mapsCameras"), component: MapsScreen },
  { path: "/cameras/players", nav: "cameras", title: t("nav.playerCameras"), component: PlayerCamerasScreen },
  { path: "/settings", nav: "settings", title: t("nav.general"), component: SettingsGeneral },
  { path: "/settings/setup", nav: "settings", title: t("nav.setup"), component: SetupScreen },
  { path: "/settings/account", nav: "settings", title: t("nav.accountHours"), component: AccountScreen },
  { path: "/settings/devices", nav: "settings", title: t("nav.devicesIntegrations"), component: DevicesScreen },
  { path: "/settings/stats", nav: "settings", title: t("nav.statsReports"), component: SettingsStats },
  { path: "/settings/diagnostics", nav: "settings", title: t("nav.diagnostics"), component: SettingsDiagnostics },
  { path: "/settings/logs", nav: "settings", title: t("nav.logs"), component: SettingsLogs },
  { path: "/settings/audit", nav: "settings", title: t("nav.auditLog"), component: SettingsAudit },
  { path: "/settings/advanced", nav: "settings", title: t("nav.advanced"), component: SettingsAdvanced },
]);

/** Paths of the 0.1 console, still used by links, bookmarks and the docs. Query and #anchor are kept. */
export const REDIRECTS: Record<string, string> = {
  "/overview": "/",
  "/huds": "/",
  "/hud": "/",
  "/events": "/tournaments",
  "/maps": "/cameras",
  "/player-cameras": "/cameras/players",
  "/studio": "/live/studio",
  "/comms": "/live/comms",
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
  return ROUTES.find((r) => (r.pattern ? r.pattern.test(path) : r.path === path)) ?? null;
}

export function navItem(id: NavId): NavItem {
  return NAV.find((n) => n.id === id)!;
}

/** Toolbar breadcrumb: the module, then the page when the module has several. */
export function crumbsFor(path: string): string[] {
  const r = routeFor(path);
  if (!r) return [t("shell.notFound.title")];
  const n = navItem(r.nav);
  if (r.path === n.path) return n.sub && r.title !== n.label ? [n.label, r.title] : [n.label];
  // Sub-pages and editors (Teams › Add Team).
  return [n.label, r.title];
}
