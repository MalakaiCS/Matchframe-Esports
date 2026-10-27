import { useEffect, useState } from "react";
import type { OrgScope } from "../../App.tsx";
import { api } from "../../api/index.ts";
import type { BillingResponse, CreditGrant, PlansResponse, PublicHourPack, PublicPlan } from "../../api/types.ts";
import { AllowanceMeter } from "../../components/AllowanceMeter.tsx";
import { PackCard, PlanCard, purchaseBlocker } from "../../components/PlanCard.tsx";
import { ActionButton, Alert, Badge, Button, Card, Empty, ErrorState, Hours, Loading, PageHeader } from "../../components/ui.tsx";
import { formatDate, formatDateTime, formatMoney } from "../../lib/format.ts";
import { useResource, useTitle } from "../../lib/hooks.ts";
import { STATUS_LABEL, SUBSCRIBED, can, roleReason, statusTone } from "../../lib/roles.ts";
import type { ViewerRole } from "../../lib/roles.ts";
import { external } from "../../lib/storage.ts";
import { Link, navigate, useLocation } from "../../router.tsx";
import { useSession } from "../../state/session.tsx";

/** Delays after a successful checkout at which billing is re-fetched (the webhook may lag Stripe's redirect). */
export const CHECKOUT_REFETCH_MS = [1500, 4000, 9000];

function creditStatus(c: CreditGrant): { label: string; tone: "ok" | "neutral" | "danger" } {
  if (c.expired) return { label: "Expired", tone: "danger" };
  if (c.remainingSeconds <= 0) return { label: "Used up", tone: "neutral" };
  return { label: "Available", tone: "ok" };
}

function CheckoutBanner({ kind, onDismiss }: { kind: string; onDismiss: () => void }) {
  if (kind === "success")
    return (
      <Alert tone="ok" title="Payment received" actions={<Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button>}>
        Thanks! Stripe is confirming the payment with Matchframe; your plan or hours can take a few seconds to appear here. This page refreshes itself.
      </Alert>
    );
  if (kind === "cancelled")
    return (
      <Alert tone="info" title="Checkout cancelled" actions={<Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button>}>
        Nothing was charged. You can choose a plan or an hour pack again whenever you like.
      </Alert>
    );
  return null;
}

interface Gate {
  /** Why the viewer can't buy (role, verification, payments set up); null = can. */
  buy: (item: { purchasable: boolean }) => string | null;
  /** Why the viewer can't open the Stripe portal; null = can. */
  portal: string | null;
}

export function billingGate(role: ViewerRole, emailVerified: boolean, b: Pick<BillingResponse, "billingConfigured" | "hasCustomer">, catalogConfigured: boolean): Gate {
  const roleWhy = roleReason(role, "billing.manage");
  return {
    buy: (item) => roleWhy ?? purchaseBlocker(item, b.billingConfigured && catalogConfigured) ?? (emailVerified ? null : "Verify your email address before buying."),
    portal: roleWhy ?? (!b.billingConfigured ? "Online payments aren't set up on this server yet." : !b.hasCustomer ? "There's no billing account yet: choose a plan or buy hours first." : null),
  };
}

export function Billing({ scope }: { scope: OrgScope }) {
  useTitle("Billing & Subscription");
  const { orgId, role } = scope;
  const { me } = useSession();
  const { query, path } = useLocation();
  const canView = can(role, "billing.view");
  const billing = useResource(canView ? `billing:${orgId}` : null, () => api.billing(orgId));
  const plans = useResource(canView ? "plans" : null, api.plans);
  const checkout = query.get("checkout");
  const wantedPlan = query.get("plan");
  const [banner, setBanner] = useState<string | null>(checkout);
  const reload = billing.reload;

  useEffect(() => {
    if (checkout !== "success") return;
    const timers = CHECKOUT_REFETCH_MS.map((ms) => setTimeout(() => void reload(), ms));
    return () => timers.forEach(clearTimeout);
  }, [checkout, reload]);

  if (!canView) {
    return (
      <>
        <PageHeader title="Billing & Subscription" />
        <Alert tone="info" title="Billing is hidden for your role">
          {roleReason(role, "billing.view")} Ask an owner or billing member about the plan, or see the public <Link to="/pricing">pricing page</Link>.
        </Alert>
      </>
    );
  }

  const dismiss = () => {
    setBanner(null);
    navigate(path, { replace: true });
  };

  return (
    <>
      <PageHeader title="Billing & Subscription" subtitle="Plan, payments and auto-director hours. Payments are handled by Stripe." />
      {banner && <CheckoutBanner kind={banner} onDismiss={dismiss} />}
      {billing.loading && !billing.data && <Loading label="Loading billing…" />}
      {billing.error && <ErrorState error={billing.error} onRetry={billing.reload} />}
      {billing.data && <BillingBody orgId={orgId} role={role} emailVerified={!!me?.user.emailVerified} b={billing.data} catalog={plans.data} catalogError={plans.error} wantedPlan={wantedPlan} />}
    </>
  );
}

/** Keeps the button busy while the browser leaves for Stripe (bounded, in case navigation is blocked or the page is restored from cache). */
const leaving = () => new Promise<void>((r) => setTimeout(r, 15_000));

async function goCheckout(orgId: string, body: Parameters<typeof api.checkout>[1]): Promise<void> {
  const r = await api.checkout(orgId, body);
  external.assign(r.url);
  await leaving();
}

async function goPortal(orgId: string): Promise<void> {
  const r = await api.portal(orgId);
  external.assign(r.url);
  await leaving();
}

function BillingBody({ orgId, role, emailVerified, b, catalog, catalogError, wantedPlan }: { orgId: string; role: ViewerRole; emailVerified: boolean; b: BillingResponse; catalog: PlansResponse | undefined; catalogError: string | null; wantedPlan: string | null }) {
  const subscribed = SUBSCRIBED.has(b.subscription.status);
  const gate = billingGate(role, emailVerified, b, catalog?.billingConfigured ?? b.billingConfigured);
  const manageOnly = roleReason(role, "billing.manage");

  const planAction = (p: PublicPlan) => {
    if (p.id === b.plan.id) return <Button block disabledReason="This is the current plan.">Current plan</Button>;
    if (subscribed)
      return (
        <ActionButton block action={() => goPortal(orgId)} disabledReason={gate.portal}>
          {p.priceMonthlyCents === 0 ? "Cancel in the subscription portal" : `Switch to ${p.name} in the portal`}
        </ActionButton>
      );
    if (p.priceMonthlyCents === 0) return <Button block disabledReason="Organisations without a subscription are on this plan automatically.">Free</Button>;
    return (
      <ActionButton variant="primary" block action={() => goCheckout(orgId, { kind: "subscription", planId: p.id })} disabledReason={gate.buy(p)}>
        Choose {p.name}
      </ActionButton>
    );
  };

  const packAction = (h: PublicHourPack) => (
    <ActionButton action={() => goCheckout(orgId, { kind: "hour_pack", packId: h.id })} disabledReason={gate.buy(h)}>
      Buy
    </ActionButton>
  );

  return (
    <div className="stack-lg">
      {!b.billingConfigured && (
        <Alert tone="info" title="Online payments aren't set up on this server">
          Plans and hour packs can't be bought here yet. Prices are shown for reference; existing hours keep working.
        </Alert>
      )}
      {manageOnly && role !== "staff" && <Alert tone="info">{manageOnly} You can see billing but not change it.</Alert>}

      <div className="billing-top">
        <Card title="Current plan">
          <p className="dash-plan-name">
            {b.plan.name} <Badge tone={statusTone(b.subscription.status)}>{STATUS_LABEL[b.subscription.status]}</Badge>
          </p>
          <dl className="kv">
            <div>
              <dt>Price</dt>
              <dd>{b.plan.priceMonthlyCents === null ? "Price on request" : b.plan.priceMonthlyCents === 0 ? "Free" : `${formatMoney(b.plan.priceMonthlyCents, b.plan.currency)} / month`}</dd>
            </div>
            <div>
              <dt>{subscribed ? "Billing period" : "Hours period"}</dt>
              <dd>
                {formatDate(b.subscription.periodStart)} – {formatDate(b.subscription.periodEnd)}
              </dd>
            </div>
            <div>
              <dt>Included hours</dt>
              <dd>
                <Hours seconds={Math.round(b.plan.includedAutoDirectorHours * 3600)} /> per period
              </dd>
            </div>
          </dl>
          {b.subscription.cancelAtPeriodEnd && (
            <Alert tone="warn" title="Ends at the end of this period">
              The subscription was cancelled and stays active until {formatDateTime(b.subscription.periodEnd)}. After that the organisation moves to the free plan; unexpired hour packs remain. You can resume it in the subscription portal before then.
            </Alert>
          )}
          {b.subscription.status === "past_due" && <Alert tone="warn">The last payment failed. Stripe retries automatically; update the payment method in the portal to keep the plan.</Alert>}
          {(b.subscription.status === "incomplete" || b.subscription.status === "unpaid") && <Alert tone="warn">The subscription isn't paid, so the organisation uses the free plan for now. Finish the payment in the portal.</Alert>}
          <div className="button-row">
            <ActionButton variant={subscribed ? "primary" : "secondary"} action={() => goPortal(orgId)} disabledReason={gate.portal}>
              {subscribed ? "Manage subscription" : "Billing details and invoices"}
            </ActionButton>
          </div>
          <p className="small muted">The Stripe portal changes the plan, payment method and billing address, and cancels the subscription.</p>
        </Card>
        <Card title="Auto-director hours this period">
          <AllowanceMeter allowance={b.allowance} planName={b.plan.name} />
        </Card>
      </div>

      <Card title={subscribed ? "Change plan" : "Choose a plan"} id="plans">
        {catalogError && <ErrorState error={catalogError} />}
        {!catalog && !catalogError && <Loading label="Loading plans…" />}
        {catalog && (
          <>
            <p className="muted">{subscribed ? "Plan changes and cancellation happen in the Stripe portal; Stripe prorates the difference." : "Subscribing opens Stripe Checkout. Hours become available as soon as Stripe confirms the payment."}</p>
            <div className="plan-grid">
              {catalog.plans.map((p) => (
                <PlanCard key={p.id} plan={p} highlight={wantedPlan === p.id} badge={p.id === b.plan.id ? <Badge tone="ok">Current</Badge> : undefined} action={planAction(p)} />
              ))}
            </div>
          </>
        )}
      </Card>

      {catalog && catalog.hourPacks.length > 0 && (
        <Card title="Buy auto-director hours" id="packs">
          <p className="muted">One-off packs, used after the plan's included hours (earliest expiry first). No subscription needed.</p>
          <div className="pack-list">
            {catalog.hourPacks.map((h) => (
              <PackCard key={h.id} pack={h} action={packAction(h)} />
            ))}
          </div>
        </Card>
      )}

      <Card title="Hour credits">
        {b.credits.length === 0 ? (
          <Empty title="No hour credits yet">Bought hour packs and hours granted by Matchframe support appear here.</Empty>
        ) : (
          <table className="rtable">
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Hours</th>
                <th scope="col">Remaining</th>
                <th scope="col">Added</th>
                <th scope="col">Expires</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {b.credits.map((c) => {
                const st = creditStatus(c);
                return (
                  <tr key={c.id}>
                    <td data-label="Source">
                      {c.source === "hour_pack" ? "Hour pack" : c.source === "grant" ? "Granted by support" : c.source}
                      {c.note && <span className="muted small block">{c.note}</span>}
                    </td>
                    <td data-label="Hours">
                      <Hours seconds={c.seconds} />
                    </td>
                    <td data-label="Remaining">
                      <Hours seconds={c.remainingSeconds} />
                    </td>
                    <td data-label="Added">{formatDate(c.createdAt)}</td>
                    <td data-label="Expires">{c.expiresAt ? formatDate(c.expiresAt) : "Never"}</td>
                    <td data-label="Status">
                      <Badge tone={st.tone}>{st.label}</Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Invoices">
        {b.invoicesError && <Alert tone="warn">Invoices couldn't be loaded from Stripe right now: {b.invoicesError}</Alert>}
        {b.invoices.length === 0 && !b.invoicesError ? (
          <Empty title="No invoices yet">{b.hasCustomer ? "Invoices appear here after the first payment." : "Invoices appear here once you subscribe or buy hours."}</Empty>
        ) : (
          b.invoices.length > 0 && (
            <table className="rtable">
              <thead>
                <tr>
                  <th scope="col">Invoice</th>
                  <th scope="col">Date</th>
                  <th scope="col">Status</th>
                  <th scope="col">Amount</th>
                  <th scope="col">
                    <span className="visually-hidden">Links</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {b.invoices.map((i) => (
                  <tr key={i.id}>
                    <td data-label="Invoice" className="mono">
                      {i.number ?? i.id}
                    </td>
                    <td data-label="Date">{formatDate(i.created)}</td>
                    <td data-label="Status">
                      <Badge tone={i.status === "paid" ? "ok" : i.status === "open" ? "warn" : i.status === "uncollectible" ? "danger" : "neutral"}>{i.status ?? "—"}</Badge>
                    </td>
                    <td data-label="Amount">
                      {formatMoney(i.status === "paid" ? i.amountPaid : i.amountDue, i.currency)}
                    </td>
                    <td data-label="Links" className="cell-links">
                      {i.hostedInvoiceUrl && (
                        <a href={i.hostedInvoiceUrl} rel="noopener noreferrer" target="_blank">
                          View<span className="visually-hidden"> invoice {i.number ?? i.id} (opens Stripe)</span>
                        </a>
                      )}
                      {i.pdfUrl && (
                        <a href={i.pdfUrl} rel="noopener noreferrer" target="_blank">
                          PDF<span className="visually-hidden"> of invoice {i.number ?? i.id}</span>
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}
      </Card>
    </div>
  );
}
