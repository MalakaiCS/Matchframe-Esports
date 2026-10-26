import type { OrgScope } from "../../App.tsx";
import { api } from "../../api/index.ts";
import { AllowanceMeter } from "../../components/AllowanceMeter.tsx";
import { Alert, Badge, Card, ErrorState, Hours, Loading, PageHeader } from "../../components/ui.tsx";
import { formatDate } from "../../lib/format.ts";
import { useResource, useTitle } from "../../lib/hooks.ts";
import { STATUS_LABEL, can, statusTone } from "../../lib/roles.ts";
import { Link } from "../../router.tsx";
import { DownloadCard } from "../Download.tsx";
import { useSession } from "../../state/session.tsx";

export function Dashboard({ scope }: { scope: OrgScope }) {
  const { orgId, role } = scope;
  const { me } = useSession();
  const org = useResource(`org:${orgId}`, () => api.org(orgId));
  // Members can't view billing (403), but every role can view usage, which carries the same allowance.
  const viewBilling = can(role, "billing.view");
  const billing = useResource(viewBilling ? `billing:${orgId}` : null, () => api.billing(orgId));
  const usage = useResource(viewBilling ? null : `usage:${orgId}`, () => api.usage(orgId));
  const devices = useResource(`devices:${orgId}`, () => api.devices(orgId));
  const name = org.data?.name ?? me?.orgs.find((o) => o.id === orgId)?.name ?? "Organisation";
  useTitle(name);
  const base = `/orgs/${encodeURIComponent(orgId)}`;
  const allowance = billing.data?.allowance ?? usage.data?.allowance;
  const allowanceErr = billing.error ?? usage.error;
  const active = devices.data?.filter((d) => !d.revokedAt) ?? [];
  const plan = org.data?.plan;

  return (
    <>
      <PageHeader title={name} subtitle="Plan, auto-director hours and linked computers at a glance." />
      {org.error && <ErrorState error={org.error} onRetry={org.reload} />}
      <div className="dash-grid">
        <Card title="Plan" className="dash-plan" actions={viewBilling ? <Link to={`${base}/billing`}>Billing</Link> : undefined}>
          {!org.data && !org.error && <Loading />}
          {org.data && (
            <>
              <p className="dash-plan-name">
                {org.data.plan.name} <Badge tone={statusTone(org.data.subscriptionStatus)}>{STATUS_LABEL[org.data.subscriptionStatus]}</Badge>
              </p>
              <p className="muted small">
                <Hours seconds={Math.round(org.data.plan.includedAutoDirectorHours * 3600)} /> auto-director hours each period · up to {org.data.plan.features.maxDevices} {org.data.plan.features.maxDevices === 1 ? "computer" : "computers"} · up to {org.data.plan.features.maxMembers} members
              </p>
              {billing.data?.subscription.cancelAtPeriodEnd && (
                <Alert tone="warn">
                  The subscription ends on {formatDate(billing.data.subscription.periodEnd)}; the organisation then moves to the free plan.
                </Alert>
              )}
              {org.data.subscriptionStatus === "past_due" && <Alert tone="warn">The last payment failed. Stripe is retrying; update the payment method from the billing page to keep the plan.</Alert>}
              {!viewBilling && <p className="small muted">Your role can't see billing details. Ask an owner or billing member about the plan.</p>}
            </>
          )}
        </Card>

        <Card title="Auto-director hours" className="dash-hours" actions={<Link to={`${base}/usage`}>Usage</Link>}>
          {!allowance && !allowanceErr && <Loading />}
          {allowanceErr && <ErrorState error={allowanceErr} onRetry={() => void (billing.reload(), usage.reload())} />}
          {allowance && <AllowanceMeter allowance={allowance} planName={plan?.name} />}
        </Card>

        <Card title="Linked computers" className="dash-devices" actions={<Link to={`${base}/computers`}>Manage</Link>}>
          {!devices.data && !devices.error && <Loading />}
          {devices.error && <ErrorState error={devices.error} onRetry={devices.reload} />}
          {devices.data && (
            <>
              <p className="big-stat">
                {active.length}
                {plan && <span className="big-stat-of"> of {plan.features.maxDevices}</span>}
              </p>
              <p className="muted small">{active.length === 1 ? "computer is" : "computers are"} linked to this organisation.</p>
              {active.length > 0 ? (
                <ul className="mini-list">
                  {active.slice(0, 4).map((d) => (
                    <li key={d.id}>{d.name}</li>
                  ))}
                </ul>
              ) : (
                <p>
                  No computers yet. <Link to="/download">Download the program</Link>, then open <strong>Account → Link this computer</strong> in it and enter the code at <Link to="/link">/link</Link>.
                </p>
              )}
              {can(role, "devices.link") && (
                <Link className="btn btn-secondary btn-sm" to="/link">
                  Link a computer
                </Link>
              )}
            </>
          )}
        </Card>

        <DownloadCard />
      </div>
    </>
  );
}
