import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../api/index.ts";
import { Link, navigate, useLocation } from "../router.tsx";
import { ROLE_LABEL } from "../lib/roles.ts";
import { STAFF_ROLE_LABEL, staffRoleOf } from "../lib/staff.ts";
import { pickOrg } from "../lib/storage.ts";
import { useSession } from "../state/session.tsx";
import { useSite } from "../state/site.ts";
import { Logo } from "./Logo.tsx";
import { ToastProvider } from "./overlay.tsx";
import { ActionButton, Alert } from "./ui.tsx";

function SkipLink() {
  return (
    <a className="skip" href="#main">
      Skip to content
    </a>
  );
}

function useCloseOnNavigate(setOpen: (v: boolean) => void): void {
  const { href } = useLocation();
  useEffect(() => setOpen(false), [href, setOpen]);
}

/** Escape closes an open menu and returns focus to its toggle. */
function useEscapeToClose(open: boolean, setOpen: (v: boolean) => void, toggleId: string): void {
  useEffect(() => {
    if (!open) return;
    const on = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      document.getElementById(toggleId)?.focus();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [open, setOpen, toggleId]);
}

async function signOut(clear: () => void): Promise<void> {
  await api.logout();
  clear();
  navigate("/login?signedOut=1");
}

const isActive = (path: string, to: string) => path === to || path.startsWith(`${to}/`);

function MenuToggle({ id, open, controls, onToggle }: { id: string; open: boolean; controls: string; onToggle: () => void }) {
  return (
    <button type="button" id={id} className={`menu-toggle${open ? " is-open" : ""}`} aria-expanded={open} aria-controls={controls} onClick={onToggle}>
      <span className="menu-icon" aria-hidden="true" />
      <span className="visually-hidden">Menu</span>
    </button>
  );
}

// ---------------------------------------------------------------------------- public site

export const SITE_NAV = [
  { to: "/product", label: "Product" },
  { to: "/getting-started", label: "How it works" },
  { to: "/pricing", label: "Pricing" },
  { to: "/help", label: "Help" },
  { to: "/contact", label: "Contact" },
];

export function SiteHeader() {
  const { me } = useSession();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const toggleId = useId();
  const { path } = useLocation();
  useCloseOnNavigate(setOpen);
  useEscapeToClose(open, setOpen, toggleId);
  return (
    <header className={`site-header${open ? " menu-open" : ""}`}>
      <div className="wrap site-header-row">
        <Link to="/" className="brand-link" aria-label="Matchframe home">
          <Logo />
        </Link>
        <MenuToggle id={toggleId} open={open} controls={menuId} onToggle={() => setOpen(!open)} />
        <nav id={menuId} className={`site-nav${open ? " is-open" : ""}`} aria-label="Main">
          <ul className="site-nav-links">
            {SITE_NAV.map((n) => (
              <li key={n.to}>
                <Link to={n.to} aria-current={isActive(path, n.to) ? "page" : undefined}>
                  {n.label}
                </Link>
              </li>
            ))}
          </ul>
          <div className="site-nav-cta">
            {me ? (
              <Link to="/dashboard" className="btn btn-primary btn-sm">
                Dashboard
              </Link>
            ) : (
              <>
                <Link to="/login" className="btn btn-ghost btn-sm" aria-current={path === "/login" ? "page" : undefined}>
                  Sign in
                </Link>
                <Link to="/signup" className="btn btn-primary btn-sm">
                  Create account
                </Link>
              </>
            )}
          </div>
        </nav>
      </div>
    </header>
  );
}

const FOOTER_COLUMNS: { title: string; links: { to: string; label: string }[] }[] = [
  {
    title: "Product",
    links: [
      { to: "/product", label: "Overview" },
      { to: "/pricing", label: "Pricing" },
      { to: "/getting-started", label: "How it works" },
      { to: "/download", label: "Download" },
      { to: "/changelog", label: "Changelog" },
    ],
  },
  {
    title: "Company",
    links: [
      { to: "/about", label: "About" },
      { to: "/contact", label: "Contact" },
      { to: "/security", label: "Security" },
      { to: "/status", label: "Status" },
    ],
  },
  {
    title: "Support",
    links: [
      { to: "/help", label: "Help centre" },
      { to: "/faq", label: "FAQ" },
      { to: "/getting-started", label: "Getting started" },
      { to: "/contact?topic=support", label: "Contact support" },
    ],
  },
  {
    title: "Legal",
    links: [
      { to: "/legal/terms", label: "Terms of Service" },
      { to: "/legal/privacy", label: "Privacy Policy" },
      { to: "/legal/cookies", label: "Cookie Policy" },
      { to: "/legal/refunds", label: "Refunds & cancellation" },
      { to: "/legal/acceptable-use", label: "Acceptable use" },
      { to: "/legal/eula", label: "Licence agreement (EULA)" },
    ],
  },
];

function Copyright() {
  const { site } = useSite();
  return (
    <>
      © {new Date().getFullYear()} {site?.companyName ?? "Matchframe"}. All rights reserved.
    </>
  );
}

export function SiteFooter() {
  const { me } = useSession();
  const { site } = useSite();
  return (
    <footer className="site-footer">
      <div className="wrap footer-grid">
        <div className="footer-brand">
          <Logo />
          <p className="footer-note">The Windows program for Counter-Strike 2 broadcasts, and the account that runs its plan, hours and team.</p>
          <div className="footer-cta">
            {me ? (
              <Link to="/dashboard" className="btn btn-secondary btn-sm">
                Open dashboard
              </Link>
            ) : (
              <>
                <Link to="/signup" className="btn btn-primary btn-sm">
                  Get started free
                </Link>
                <Link to="/login" className="btn btn-ghost btn-sm">
                  Sign in
                </Link>
              </>
            )}
          </div>
          {site?.supportEmail && (
            <p className="footer-contact">
              <a href={`mailto:${site.supportEmail}`}>{site.supportEmail}</a>
            </p>
          )}
        </div>
        {FOOTER_COLUMNS.map((c) => (
          <nav key={c.title} className="footer-col" aria-label={c.title}>
            <h2 className="footer-title">{c.title}</h2>
            <ul>
              {c.links.map((l) => (
                <li key={l.label}>
                  <Link to={l.to}>{l.label}</Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="wrap footer-legal">
        <span>
          <Copyright />
        </span>
        <span>Counter-Strike 2 is a trademark of Valve Corporation. Matchframe is not affiliated with or endorsed by Valve.</span>
      </div>
    </footer>
  );
}

export function PublicLayout({ children, narrow }: { children: ReactNode; narrow?: boolean }) {
  return (
    <div className="site">
      <SkipLink />
      <SiteHeader />
      <main id="main" className={narrow ? "main-narrow" : "main-site"}>
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}

// ---------------------------------------------------------------------------- signed-in app

const SECTIONS = [
  { slug: "", label: "Dashboard" },
  { slug: "usage", label: "Usage" },
  { slug: "billing", label: "Billing & Subscription" },
  { slug: "team", label: "Team" },
  { slug: "computers", label: "Computers" },
];

/** Sections of the staff console (/admin/...). */
export const ADMIN_SECTIONS: { to: string; label: string; exact?: boolean }[] = [
  { to: "/admin", label: "Overview", exact: true },
  { to: "/admin/users", label: "Users" },
  { to: "/admin/orgs", label: "Organisations" },
  { to: "/admin/inbox", label: "Support inbox" },
  { to: "/admin/emails", label: "Email log" },
  { to: "/admin/catalog", label: "Catalogue" },
  { to: "/admin/audit", label: "Audit log" },
  { to: "/admin/stripe", label: "Stripe events" },
];

export function VerifyBanner() {
  const { me } = useSession();
  const [sent, setSent] = useState(false);
  if (!me || me.user.emailVerified) return null;
  return (
    <Alert
      tone="warn"
      title="Verify your email address"
      actions={
        sent ? undefined : (
          <ActionButton size="sm" action={async () => {
            await api.resendVerification();
            setSent(true);
          }}>
            Resend email
          </ActionButton>
        )
      }
    >
      {sent ? (
        <>We sent a new link to {me.user.email}. It expires in 48 hours.</>
      ) : (
        <>
          Open the link we sent to <strong>{me.user.email}</strong>. Until then you can't buy a plan or hours, invite people, link computers or create organisations.
        </>
      )}
    </Alert>
  );
}

function AppFooter() {
  return (
    <footer className="app-footer">
      <nav aria-label="Help and legal">
        <ul>
          <li>
            <Link to="/help">Help centre</Link>
          </li>
          <li>
            <Link to="/contact">Contact support</Link>
          </li>
          <li>
            <Link to="/status">Status</Link>
          </li>
          <li>
            <Link to="/legal/terms">Terms</Link>
          </li>
          <li>
            <Link to="/legal/privacy">Privacy</Link>
          </li>
        </ul>
      </nav>
      <p>
        <Copyright />
      </p>
    </footer>
  );
}

export function AppShell({ orgId, children }: { orgId?: string | null; children: ReactNode }) {
  const { me, clear } = useSession();
  const { path } = useLocation();
  const [open, setOpen] = useState(false);
  const navId = useId();
  const toggleId = useId();
  const selectId = useId();
  useCloseOnNavigate(setOpen);
  useEscapeToClose(open, setOpen, toggleId);
  const orgs = me?.orgs ?? [];
  const current = orgId ?? pickOrg(orgs);
  const section = /^\/orgs\/[^/]+\/?([^/]*)/.exec(path)?.[1] ?? "";
  const memberOfCurrent = orgs.some((o) => o.id === current);
  const staffRole = staffRoleOf(me?.user);
  const inAdmin = path === "/admin" || path.startsWith("/admin/");
  return (
    <ToastProvider>
      <div className={`app${inAdmin ? " app-admin" : ""}`}>
        <SkipLink />
        <header className="app-topbar">
          <Link to="/" className="brand-link" aria-label="Matchframe home">
            <Logo />
          </Link>
          {inAdmin && staffRole && <span className="console-badge">Staff · {STAFF_ROLE_LABEL[staffRole]}</span>}
          <MenuToggle id={toggleId} open={open} controls={navId} onToggle={() => setOpen(!open)} />
        </header>
        <aside id={navId} className={`app-side${open ? " is-open" : ""}`}>
          <Link to="/" className="brand-link app-side-brand" aria-label="Matchframe home">
            <Logo />
          </Link>
          {inAdmin && staffRole ? (
            <>
              <div className="console-head">
                <p className="console-title">Staff console</p>
                <span className={`badge ${staffRole === "admin" ? "badge-brand" : "badge-info-plain"}`}>{STAFF_ROLE_LABEL[staffRole]}</span>
              </div>
              <nav aria-label="Staff console">
                <ul className="side-nav">
                  {ADMIN_SECTIONS.map((s) => {
                    const active = s.exact ? path === s.to : isActive(path, s.to);
                    return (
                      <li key={s.to}>
                        <Link to={s.to} aria-current={active ? "page" : undefined}>
                          {s.label}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </nav>
            </>
          ) : (
            <>
              {orgs.length > 0 && (
                <div className="org-switch">
                  <label htmlFor={selectId}>Organisation</label>
                  <select
                    id={selectId}
                    value={memberOfCurrent ? (current ?? "") : ""}
                    onChange={(e) => navigate(`/orgs/${encodeURIComponent(e.target.value)}${section && path.startsWith("/orgs/") ? `/${section}` : ""}`)}
                  >
                    {!memberOfCurrent && <option value="">Choose…</option>}
                    {orgs.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                  {memberOfCurrent && <p className="org-switch-role">Your role: {ROLE_LABEL[orgs.find((o) => o.id === current)!.role]}</p>}
                </div>
              )}
              {current && (
                <nav aria-label="Organisation">
                  <ul className="side-nav">
                    {SECTIONS.map((s) => {
                      const to = `/orgs/${encodeURIComponent(current)}${s.slug ? `/${s.slug}` : ""}`;
                      const active = path.startsWith("/orgs/") && section === s.slug && (orgId ?? null) === current;
                      return (
                        <li key={s.slug}>
                          <Link to={to} aria-current={active ? "page" : undefined}>
                            {s.label}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </nav>
              )}
            </>
          )}
          <nav aria-label="Account">
            <ul className="side-nav side-nav-secondary">
              {inAdmin && (
                <li>
                  <Link to="/dashboard">Your organisations</Link>
                </li>
              )}
              <li>
                <Link to="/account" aria-current={path === "/account" ? "page" : undefined}>
                  Account
                </Link>
              </li>
              {me?.user.staff && !inAdmin && (
                <li>
                  <Link to="/admin">Admin console</Link>
                </li>
              )}
            </ul>
          </nav>
          <div className="side-foot">
            {me && (
              <p className="side-user" title={me.user.email}>
                {me.user.displayName}
                <span>{me.user.email}</span>
              </p>
            )}
            <ActionButton size="sm" variant="ghost" action={() => signOut(clear)}>
              Sign out
            </ActionButton>
          </div>
        </aside>
        <main id="main" className="app-main">
          <div className="app-main-inner">
            <VerifyBanner />
            {children}
          </div>
          <AppFooter />
        </main>
      </div>
    </ToastProvider>
  );
}

export { signOut };
