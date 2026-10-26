import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../api/index.ts";
import { Link, navigate, useLocation } from "../router.tsx";
import { ROLE_LABEL } from "../lib/roles.ts";
import { pickOrg } from "../lib/storage.ts";
import { useSession } from "../state/session.tsx";
import { Logo } from "./Logo.tsx";
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

async function signOut(clear: () => void): Promise<void> {
  await api.logout();
  clear();
  navigate("/login?signedOut=1");
}

// ---------------------------------------------------------------------------- public site

export function SiteHeader() {
  const { me } = useSession();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const { path } = useLocation();
  useCloseOnNavigate(setOpen);
  const nav = [{ to: "/pricing", label: "Pricing", active: path === "/pricing" }];
  return (
    <header className="site-header">
      <div className="wrap site-header-row">
        <Link to="/" className="brand-link" aria-label="Matchframe home">
          <Logo />
        </Link>
        <button type="button" className="menu-toggle" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen(!open)}>
          <span className="menu-icon" aria-hidden="true" />
          <span className="visually-hidden">Menu</span>
        </button>
        <nav id={menuId} className={`site-nav${open ? " is-open" : ""}`} aria-label="Main">
          <ul className="site-nav-links">
            {nav.map((n) => (
              <li key={n.to}>
                <Link to={n.to} aria-current={n.active ? "page" : undefined}>
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

export function SiteFooter() {
  const { me } = useSession();
  return (
    <footer className="site-footer">
      <div className="wrap site-footer-row">
        <div>
          <Logo />
          <p className="footer-note">Subscription, auto-director hours, team and computers for the Matchframe program.</p>
        </div>
        <nav aria-label="Footer">
          <ul className="footer-links">
            <li>
              <Link to="/pricing">Pricing</Link>
            </li>
            <li>{me ? <Link to="/dashboard">Dashboard</Link> : <Link to="/login">Sign in</Link>}</li>
          </ul>
        </nav>
      </div>
      <div className="wrap footer-legal">
        <span>© {new Date().getFullYear()} Matchframe Esports.</span>
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

export function AppShell({ orgId, children }: { orgId?: string | null; children: ReactNode }) {
  const { me, clear } = useSession();
  const { path } = useLocation();
  const [open, setOpen] = useState(false);
  const navId = useId();
  const selectId = useId();
  useCloseOnNavigate(setOpen);
  const orgs = me?.orgs ?? [];
  const current = orgId ?? pickOrg(orgs);
  const section = /^\/orgs\/[^/]+\/?([^/]*)/.exec(path)?.[1] ?? "";
  const memberOfCurrent = orgs.some((o) => o.id === current);
  return (
    <div className="app">
      <SkipLink />
      <header className="app-topbar">
        <Link to="/" className="brand-link" aria-label="Matchframe home">
          <Logo />
        </Link>
        <button type="button" className="menu-toggle" aria-expanded={open} aria-controls={navId} onClick={() => setOpen(!open)}>
          <span className="menu-icon" aria-hidden="true" />
          <span className="visually-hidden">Menu</span>
        </button>
      </header>
      <aside id={navId} className={`app-side${open ? " is-open" : ""}`}>
        <Link to="/" className="brand-link app-side-brand" aria-label="Matchframe home">
          <Logo />
        </Link>
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
        <nav aria-label="Account">
          <ul className="side-nav side-nav-secondary">
            <li>
              <Link to="/account" aria-current={path === "/account" ? "page" : undefined}>
                Account
              </Link>
            </li>
            {me?.user.staff && (
              <li>
                <Link to="/admin" aria-current={path === "/admin" ? "page" : undefined}>
                  Admin
                </Link>
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
      </main>
    </div>
  );
}

export { signOut };
