import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { AppShell, PublicLayout } from "./components/Layout.tsx";
import { Alert, Loading, PageHeader } from "./components/ui.tsx";
import { setLastOrg, pickOrg } from "./lib/storage.ts";
import type { ViewerRole } from "./lib/roles.ts";
import { useTitle } from "./lib/hooks.ts";
import { Link, Redirect, loginHref, matchPath, useLocation } from "./router.tsx";
import { useSession } from "./state/session.tsx";
import { Landing } from "./pages/Landing.tsx";
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
import { Admin } from "./pages/admin/Admin.tsx";

export interface OrgScope {
  orgId: string;
  role: ViewerRole;
}

type Layout = "site" | "narrow" | "app";

interface RouteDef {
  path: string;
  layout: Layout;
  auth?: boolean;
  staff?: boolean;
  org?: boolean;
  render: (params: Record<string, string>, scope: OrgScope | null) => ReactNode;
}

const ROUTES: RouteDef[] = [
  { path: "/", layout: "site", render: () => <Landing /> },
  { path: "/pricing", layout: "site", render: () => <Pricing /> },
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
  { path: "/admin", layout: "app", auth: true, staff: true, render: () => <Admin /> },
];

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

function NotFound() {
  useTitle("Page not found");
  return (
    <section className="wrap section">
      <PageHeader title="Page not found" subtitle="That address doesn't match any page on this site." />
      <p>
        <Link to="/">Go to the home page</Link> or <Link to="/dashboard">open your dashboard</Link>.
      </p>
    </section>
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
  const loc = useLocation();
  const session = useSession();
  useFocusOnNavigate(loc.href + window.location.hash);

  let route: RouteDef | null = null;
  let params: Record<string, string> = {};
  for (const r of ROUTES) {
    const m = matchPath(r.path, loc.path);
    if (m) {
      route = r;
      params = m;
      break;
    }
  }

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
