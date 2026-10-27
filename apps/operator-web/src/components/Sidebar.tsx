import { desktopHud } from "../api/desktop.ts";
import { Link } from "../router.tsx";
import type { NavId, NavItem } from "../routes.tsx";
import { NAV } from "../routes.tsx";
import { useLive } from "../state/live.ts";
import { Icon, Logo } from "./icons.tsx";

/** A module that is unavailable (or only partly available) right now: badge text plus the reason. */
export interface ModuleAvailability {
  badge: string;
  reason: string;
  /** "unavailable": the module's main feature is off; "limited": part of it is. */
  level: "unavailable" | "limited";
}

/** Which modules to mark in the sidebar and explain on their pages. */
export function useModuleAvailability(): Partial<Record<NavId, ModuleAvailability>> {
  const gate = useLive((s) => s.snapshot?.cloud?.gate);
  const out: Partial<Record<NavId, ModuleAvailability>> = {};
  if (gate && !gate.ok) {
    out.director = {
      badge: gate.code === "not_linked" ? "Sign in" : gate.code === "hours_exhausted" ? "No hours" : "Locked",
      level: "unavailable",
      reason: `${gate.reason} The Auto Director needs a Matchframe account with a plan (Settings → Account); HUDs, teams, matches and manual camera control work without one.`,
    };
  }
  const bridge = desktopHud();
  if (bridge && !bridge.available) {
    out.huds = { badge: "Remote", level: "limited", reason: `Desktop HUDs are unavailable: ${bridge.unavailableReason ?? "this program is connected to another production computer"}. The library, OBS browser sources and previews still work.` };
  }
  return out;
}

function NavLink({ item, active, collapsed, availability }: { item: NavItem; active: boolean; collapsed: boolean; availability?: ModuleAvailability }) {
  const title = availability ? `${item.label} — ${availability.reason}` : collapsed ? item.label : undefined;
  return (
    <li>
      <Link to={item.path} className={`nav-link ${active ? "is-active" : ""} ${availability ? `is-${availability.level}` : ""}`} aria-current={active ? "page" : undefined} title={title} data-nav={item.id}>
        <span className="nav-icon">
          <Icon name={item.icon} />
          {availability ? <span className="nav-icon-dot" aria-hidden /> : null}
        </span>
        <span className="nav-label">{item.label}</span>
        {availability ? (
          <span className="nav-badge" aria-hidden>
            {availability.badge}
          </span>
        ) : null}
        {availability ? <span className="sr-only">({availability.reason})</span> : null}
      </Link>
    </li>
  );
}

/** Persistent left sidebar: branding, the modules in order, Settings at the bottom, and the collapse toggle. */
export function Sidebar({ collapsed, onToggle, activeId }: { collapsed: boolean; onToggle: () => void; activeId: NavId | null }) {
  const availability = useModuleAvailability();
  const main = NAV.filter((n) => n.id !== "settings");
  const settings = NAV.find((n) => n.id === "settings")!;
  return (
    <aside className={`sidebar ${collapsed ? "is-collapsed" : ""}`}>
      <Link to="/" className="sidebar-brand" aria-label="Matchframe Esports — HUD Library" title={collapsed ? "Matchframe Esports" : undefined}>
        <Logo size={30} />
        <span className="brand-text">
          <span className="brand-name">Matchframe</span>
          <span className="brand-sub">Esports</span>
        </span>
      </Link>
      <nav className="nav" aria-label="Primary">
        <ul className="nav-main">
          {main.map((n) => (
            <NavLink key={n.id} item={n} active={activeId === n.id} collapsed={collapsed} availability={availability[n.id]} />
          ))}
        </ul>
        <ul className="nav-bottom">
          <NavLink item={settings} active={activeId === "settings"} collapsed={collapsed} availability={availability.settings} />
        </ul>
      </nav>
      <button className="sidebar-toggle" onClick={onToggle} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed} title={collapsed ? "Show labels" : "Icons only"}>
        <Icon name={collapsed ? "chevronRight" : "chevronLeft"} size={16} />
        <span className="nav-label">Collapse</span>
      </button>
    </aside>
  );
}
