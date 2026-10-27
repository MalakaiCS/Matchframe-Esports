import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { AppShell, PublicLayout } from "./components/Layout.tsx";
import { Alert, Loading, PageHeader } from "./components/ui.tsx";
import { setLastOrg, pickOrg } from "./lib/storage.ts";
import type { ViewerRole } from "./lib/roles.ts";
import { useTitle } from "./lib/hooks.ts";
import { Link, Redirect, loginHref, matchPath, useLocation } from "./router.tsx";
import { useSession } from "./state/session.tsx";
import { Home } from "./pages/site/Home.tsx";
import { Features, FeatureDetail } from "./pages/site/Features.tsx";
import { HowItWorks } from "./pages/site/HowItWorks.tsx";
import { Requirements } from "./pages/site/Requirements.tsx";
import { UseCases } from "./pages/site/UseCases.tsx";
import { Faq } from "./pages/site/Faq.tsx";
import { HelpArticlePage, HelpCentre } from "./pages/site/Help.tsx";
import { Contact } from "./pages/site/Contact.tsx";
import { About } from "./pages/site/About.tsx";
import { Security } from "./pages/site/Security.tsx";
import { Status } from "./pages/site/Status.tsx";
import { Changelog } from "./pages/site/Changelog.tsx";
import { NotFound } from "./pages/site/NotFound.tsx";
import { LegalDocPage, LegalHub } from "./pages/legal/Legal.tsx";
import { Pricing } from "./pages/Pricing.tsx";
import { Download } from "./pages/Download.tsx";
import { Login } from "./pages/auth/Login.tsx";
import { Signup } from "./pages/auth/Signup.tsx";
import { ForgotPassword } from "./pages/auth/ForgotPassword.tsx";
import { ResetPassword } from "./pages/auth/ResetPassword.tsx";
import { VerifyEmail } from "./pages/auth/VerifyEmail.tsx";
import { ConfirmEmail } from "./pages/auth/ConfirmEmail.tsx";
import { Invite } from "./pages/auth/Invite.tsx";
import { LinkComputer } from "./pages/LinkComputer.tsx";
import { Dashboard } from "./pages/org/Dashboard.tsx";
import { Billing } from "./pages/org/Billing.tsx";
import { Usage } from "./pages/org/Usage.tsx";
import { Computers } from "./pages/org/Computers.tsx";
import { Team } from "./pages/org/Team.tsx";
import { Account } from "./pages/Account.tsx";
import { AdminAudit, AdminCatalog, AdminStripe } from "./pages/admin/Admin.tsx";
import { AdminOverview } from "./pages/admin/Overview.tsx";
import { AdminUsers } from "./pages/admin/Users.tsx";
import { AdminUserDetail } from "./pages/admin/UserDetail.tsx";
import { AdminOrgs } from "./pages/admin/Orgs.tsx";
import { AdminOrgDetail } from "./pages/admin/OrgDetail.tsx";
import { AdminInbox } from "./pages/admin/Inbox.tsx";
import { AdminEmails } from "./pages/admin/Emails.tsx";
import { ToastProvider } from "./components/overlay.tsx";

export interface OrgScope {
  orgId: string;
  role: ViewerRole;
}

type Layout = "site" | "narrow" | "app";

export interface RouteDef {
  path: string;
  layout: Layout;
  auth?: boolean;
  staff?: boolean;
  org?: boolean;
  render: (params: Record<string, string>, scope: OrgScope | null) => ReactNode;
}

export const ROUTES: RouteDef[] = [
  { path: "/", layout: "site", render: () => <Home /> },
  { path: "/features", layout: "site", render: () => <Features /> },
  { path: "/features/:feature", layout: "site", render: (p) => <FeatureDetail slug={p.feature!} /> },
  { path: "/how-it-works", layout: "site", render: () => <HowItWorks /> },
  { path: "/requirements", layout: "site", render: () => <Requirements /> },
  { path: "/use-cases", layout: "site", render: () => <UseCases /> },
  { path: "/pricing", layout: "site", render: () => <Pricing /> },
  { path: "/faq", layout: "site", render: () => <Faq /> },
  { path: "/help", layout: "site", render: () => <HelpCentre /> },
  { path: "/help/:article", layout: "site", render: (p) => <HelpArticlePage slug={p.article!} /> },
  { path: "/contact", layout: "site", render: () => <Contact /> },
  { path: "/about", layout: "site", render: () => <About /> },
  { path: "/security", layout: "site", render: () => <Security /> },
  { path: "/status", layout: "site", render: () => <Status /> },
  { path: "/changelog", layout: "site", render: () => <Changelog /> },
  { path: "/legal", layout: "site", render: () => <LegalHub /> },
  { path: "/legal/:doc", layout: "site", render: (p) => <LegalDocPage slug={p.doc!} /> },
  // Earlier addresses of pages that moved.
  { path: "/product", layout: "site", render: () => <Redirect to="/features" /> },
  { path: "/getting-started", layout: "site", render: () => <Redirect to="/how-it-works#setup" /> },
  { path: "/terms", layout: "site", render: () => <Redirect to="/legal/terms" /> },
  { path: "/privacy", layout: "site", render: () => <Redirect to="/legal/privacy" /> },
  { path: "/signup", layout: "narrow", render: () => <Signup /> },
  { path: "/login", layout: "narrow", render: () => <Login /> },
  { path: "/forgot-password", layout: "narrow", render: () => <ForgotPassword /> },
  { path: "/reset-password", layout: "narrow", render: () => <ResetPassword /> },
  { path: "/verify-email", layout: "narrow", render: () => <VerifyEmail /> },
  { path: "/confirm-email", layout: "narrow", render: () => <ConfirmEmail /> },
  { path: "/invite", layout: "narrow", render: () => <Invite /> },
  { path: "/link", layout: "narrow", auth: true, render: () => <LinkComputer /> },
  { path: "/dashboard", layout: "app", auth: true, render: () => <OrgHome /> },
  { path: "/orgs", layout: "app", auth: true, render: () => <OrgHome /> },
  { path: "/orgs/:orgId", layout: "app", auth: true, org: true, render: (_p, s) => <Dashboard scope={s!} /> },
  { path: "/orgs/:orgId/billing", layout: "app", auth: true, org: true, render: (_p, s) => <Billing scope={s!} /> },
  { path: "/orgs/:orgId/usage", layout: "app", auth: true, org: true, render: (_p, s) => <Usage scope={s!} /> },
  { path: "/orgs/:orgId/computers", layout: "app", auth: true, org: true, render: (_p, s) => <Computers scope={s!} /> },
  { path: "/orgs/:orgId/team", layout: "app", auth: true, org: true, render: (_p, s) => <Team scope={s!} /> },
  // Organisation name moved to the Team page; keep old links working.
  { path: "/orgs/:orgId/settings", layout: "app", auth: true, org: true, render: (p) => <Redirect to={`/orgs/${encodeURIComponent(p.orgId!)}/team#organisation`} /> },
  { path: "/download", layout: "app", auth: true, render: () => <Download /> },
  { path: "/account", layout: "app", auth: true, render: () => <Account /> },
  { path: "/admin", layout: "app", auth: true, staff: true, render: () => <AdminOverview /> },
  { path: "/admin/users", layout: "app", auth: true, staff: true, render: () => <AdminUsers /> },
  { path: "/admin/users/:userId", layout: "app", auth: true, staff: true, render: (p) => <AdminUserDetail userId={p.userId!} /> },
  { path: "/admin/orgs", layout: "app", auth: true, staff: true, render: () => <AdminOrgs /> },
  { path: "/admin/orgs/:adminOrgId", layout: "app", auth: true, staff: true, render: (p) => <AdminOrgDetail orgId={p.adminOrgId!} /> },
  { path: "/admin/inbox", layout: "app", auth: true, staff: true, render: () => <AdminInbox /> },
  { path: "/admin/emails", layout: "app", auth: true, staff: true, render: () => <AdminEmails /> },
  { path: "/admin/catalog", layout: "app", auth: true, staff: true, render: () => <AdminCatalog /> },
  { path: "/admin/audit", layout: "app", auth: true, staff: true, render: () => <AdminAudit /> },
  { path: "/admin/stripe", layout: "app", auth: true, staff: true, render: () => <AdminStripe /> },
];

/** The route a path (without query or hash) resolves to, or null for the not-found page. */
export function resolveRoute(path: string): { route: RouteDef; params: Record<string, string> } | null {
  const clean = path.split(/[?#]/)[0]!.replace(/\/+$/, "") || "/";
  for (const r of ROUTES) {
    const m = matchPath(r.path, clean);
    if (m) return { route: r, params: m };
  }
  return null;
}

/** /dashboard → the remembered (or first) organisation. */
function OrgHome() {
  const { me } = useSession();
  const id = pickOrg(me?.orgs ?? []);
  if (id) return <Redirect to={`/orgs/${encodeURIComponent(id)}`} />;
  return (
    <>
      <PageHeader title="No organisation" subtitle="You're not a member of any organisation." />
      <Alert tone="info">
        Ask an owner to invite you, or <Link to="/account#orgs">create an organisation</Link> from your account page.
      </Alert>
    </>
  );
}

function OrgNotFound() {
  useTitle("Organisation not found");
  return (
    <>
      <PageHeader title="Organisation not found" subtitle="It doesn't exist, or you're not a member of it." />
      <p>
        <Link to="/dashboard">Open one of your organisations</Link>
      </p>
    </>
  );
}

/** Moves focus to the page heading after client-side navigation (announces the new page). */
function useFocusOnNavigate(href: string): void {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const hash = window.location.hash.slice(1);
    const t = setTimeout(() => {
      const target = hash ? document.getElementById(hash) : null;
      if (target) {
        target.scrollIntoView();
        return;
      }
      const h = document.querySelector<HTMLElement>("[data-page-heading]");
      h?.focus({ preventScroll: true });
    }, 30);
    return () => clearTimeout(t);
  }, [href]);
}

export function App() {
  return (
    <ToastProvider>
      <Routes />
    </ToastProvider>
  );
}

function Routes() {
  const loc = useLocation();
  const session = useSession();
  // Query-only changes (search, filters, pagination) keep focus where it is.
  useFocusOnNavigate(loc.path + window.location.hash);

  const resolved = resolveRoute(loc.path);
  const route: RouteDef | null = resolved?.route ?? null;
  const params: Record<string, string> = resolved?.params ?? {};

  const orgId = params.orgId ?? null;
  const member = orgId ? session.me?.orgs.find((o) => o.id === orgId) : undefined;
  useEffect(() => {
    if (member) setLastOrg(member.id);
  }, [member]);

  // Signed-in pages always ask the API who is signed in (public pages only when the hint says so).
  const needsSession = !!route?.auth;
  const { status, refresh } = session;
  useEffect(() => {
    if (needsSession && status === "idle") void refresh();
  }, [needsSession, status, refresh]);

  if (!route) return <PublicLayout><NotFound /></PublicLayout>;

  const wrap = (node: ReactNode) => {
    if (route.layout === "app") return <AppShell orgId={orgId}>{node}</AppShell>;
    return <PublicLayout narrow={route.layout === "narrow"}>{node}</PublicLayout>;
  };

  if (route.auth) {
    if (session.status !== "ready") return wrap(<Loading label="Checking your session…" />);
    if (!session.me) {
      if (session.probeError) return <PublicLayout narrow><Alert tone="danger" title="Can't reach Matchframe">{session.probeError}</Alert></PublicLayout>;
      return <Redirect to={loginHref(loc.href) + (session.expired ? `${loginHref(loc.href).includes("?") ? "&" : "?"}expired=1` : "")} />;
    }
    if (route.staff && !session.me.user.staff)
      return wrap(
        <>
          <PageHeader title="Staff only" />
          <Alert tone="warn">This page is for Matchframe staff.</Alert>
        </>,
      );
  }

  let scope: OrgScope | null = null;
  if (route.org && orgId) {
    if (member) scope = { orgId, role: member.role };
    else if (session.me?.user.staff) scope = { orgId, role: "staff" };
    else return wrap(<OrgNotFound />);
  }

  return wrap(<div key={route.org ? `${route.path}:${orgId}` : route.path}>{route.render(params, scope)}</div>);
}
