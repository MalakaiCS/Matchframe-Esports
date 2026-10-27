import { api } from "../../api/index.ts";
import { Initials, StatCard } from "../../components/data.tsx";
import { Badge, Card, Empty, ErrorState, Loading, PageHeader } from "../../components/ui.tsx";
import { formatDate, formatHours, formatMoney, formatRelative } from "../../lib/format.ts";
import { useResource, useTitle } from "../../lib/hooks.ts";
import { Link } from "../../router.tsx";
import { StaffRoleBadge, useStaffRole } from "./shared.tsx";

export function AdminOverview() {
  useTitle("Admin overview");
  const { role } = useStaffRole();
  const ov = useResource("admin-overview", api.adminOverview);
  const inbox = useResource("admin-inbox-count", () => api.adminMessages("open"));
  const d = ov.data;
  const plans = d ? Object.entries(d.orgs.byPlan).sort((a, b) => b[1] - a[1]) : [];
  const maxPlan = Math.max(1, ...plans.map(([, n]) => n));
  const open = inbox.data?.messages.length ?? 0;
  return (
    <>
      <PageHeader eyebrow={<>Staff console · <StaffRoleBadge role={role} /></>} title="Overview" subtitle="Accounts, organisations, usage and revenue at a glance." />
      {ov.loading && !d && <Loading label="Loading the overview…" />}
      {ov.error && <ErrorState error={ov.error} onRetry={ov.reload} />}
      {d && (
        <div className="stack-lg">
          <div className="stat-grid">
            <StatCard label="Users" value={d.users.total.toLocaleString()} sub={`${d.users.verified.toLocaleString()} verified · ${d.users.newLast30Days.toLocaleString()} new in 30 days`} tone="brand" />
            <StatCard label="Organisations" value={d.orgs.total.toLocaleString()} sub={`${d.orgs.paying.toLocaleString()} paying`} />
            <StatCard label="Monthly recurring revenue" value={formatMoney(d.revenue.mrrCents, d.revenue.currency)} sub="Active and past-due subscriptions" tone="ok" />
            <StatCard label="Auto-director time this month" value={formatHours(d.usage.secondsThisMonth)} sub="All organisations, calendar month" />
            <StatCard label="Linked computers" value={d.devices.linked.toLocaleString()} />
            <StatCard label="Staff accounts" value={d.users.staff.toLocaleString()} />
            <StatCard label="Disabled accounts" value={d.users.disabled.toLocaleString()} tone={d.users.disabled > 0 ? "warn" : undefined} />
            <StatCard label="Open support messages" value={inbox.data ? open.toLocaleString() : "—"} sub={<Link to="/admin/inbox">Open the inbox</Link>} tone={open > 0 ? "warn" : undefined} />
          </div>
          <div className="two-col">
            <Card title="Recent sign-ups" actions={<Link to="/admin/users">All users</Link>}>
              {d.recentSignups.length === 0 ? (
                <Empty title="No sign-ups yet" />
              ) : (
                <ul className="person-list">
                  {d.recentSignups.map((u) => (
                    <li key={u.id}>
                      <Initials name={u.displayName || u.email} />
                      <div className="person-main">
                        <Link to={`/admin/users/${encodeURIComponent(u.id)}`} className="strong">
                          {u.displayName || u.email}
                        </Link>
                        <span className="small muted block">{u.email}</span>
                      </div>
                      <div className="person-side">
                        {u.emailVerified ? <Badge tone="ok">Verified</Badge> : <Badge tone="warn">Unverified</Badge>}
                        <span className="small muted block" title={formatDate(u.createdAt)}>
                          {formatRelative(u.createdAt)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="Organisations by plan" actions={<Link to="/admin/orgs">All organisations</Link>}>
              {plans.length === 0 ? (
                <Empty title="No organisations yet" />
              ) : (
                <ul className="plan-bars">
                  {plans.map(([id, n]) => (
                    <li key={id}>
                      <span className="plan-bar-label">{id}</span>
                      <span className="plan-bar-track" aria-hidden="true">
                        <span className="plan-bar-fill" style={{ width: `${Math.max(2, (n / maxPlan) * 100)}%` }} />
                      </span>
                      <span className="plan-bar-value">{n.toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
