import type { ReactNode } from "react";
import { api } from "../api/index.ts";
import type { PublicPlan } from "../api/types.ts";
import { Icon } from "../components/icons.tsx";
import { CtaBand, PageHero, SectionHead } from "../components/marketing.tsx";
import { PackCard, PlanCard, purchaseBlocker } from "../components/PlanCard.tsx";
import { Alert, Button, ErrorState, Loading } from "../components/ui.tsx";
import { FAQ, FaqList } from "../content/faq.tsx";
import { formatHours, formatMoney } from "../lib/format.ts";
import { useResource, useTitle } from "../lib/hooks.ts";
import { pickOrg } from "../lib/storage.ts";
import { Link } from "../router.tsx";
import { useSession } from "../state/session.tsx";

function Yes({ label = "Included" }: { label?: string }) {
  return (
    <span className="cmp-yes">
      <Icon name="check" size={18} />
      <span className="visually-hidden">{label}</span>
    </span>
  );
}

function No() {
  return (
    <span className="cmp-no">
      <span aria-hidden="true">—</span>
      <span className="visually-hidden">Not included</span>
    </span>
  );
}

/** Feature-by-plan comparison built from the live catalogue. */
export function PlanComparison({ plans }: { plans: PublicPlan[] }) {
  const rows: { label: string; hint?: string; cell: (p: PublicPlan) => ReactNode }[] = [
    { label: "Monthly price", cell: (p) => (p.priceMonthlyCents === null ? "On request" : formatMoney(p.priceMonthlyCents, p.currency)) },
    { label: "Auto-director hours each period", hint: "Time the director controls the camera on live matches.", cell: (p) => (p.features.autoDirector ? formatHours(p.includedAutoDirectorHours * 3600) : <No />) },
    { label: "Linked computers", cell: (p) => p.features.maxDevices },
    { label: "Team members", hint: "Pending invitations count too.", cell: (p) => p.features.maxMembers },
    { label: "Automatic direction on live matches", cell: (p) => (p.features.autoDirector ? <Yes /> : <No />) },
    { label: "Learned-director shadow mode", hint: "Compare demo-trained models with the director without moving the camera.", cell: (p) => (p.features.learnedDirectorShadow ? <Yes /> : <No />) },
    { label: "HUDs, manual and advisory direction, replays, administration", cell: () => <Yes /> },
    { label: "Hour packs available", cell: () => <Yes /> },
    { label: "Billing", cell: (p) => (p.priceMonthlyCents === 0 ? "Free" : "Monthly, cancel any time") },
  ];
  return (
    <div className="table-scroll" role="region" aria-label="Plan comparison" tabIndex={0}>
      <table className="cmp-table">
        <caption className="visually-hidden">Plan comparison</caption>
        <thead>
          <tr>
            <th scope="col">
              <span className="visually-hidden">Feature</span>
            </th>
            {plans.map((p) => (
              <th scope="col" key={p.id}>
                {p.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <th scope="row">
                {r.label}
                {r.hint && <span className="cmp-hint">{r.hint}</span>}
              </th>
              {plans.map((p) => (
                <td key={p.id}>{r.cell(p)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pricing() {
  useTitle("Pricing", "Matchframe plans and hour packs: start free, pay monthly for more auto-director hours, computers and team members. No overage charges; cancel any time.");
  const { me } = useSession();
  const plans = useResource("plans", api.plans);
  const orgId = me ? pickOrg(me.orgs) : null;
  const billingHref = (planId?: string) => (orgId ? `/orgs/${encodeURIComponent(orgId)}/billing${planId ? `?plan=${encodeURIComponent(planId)}` : ""}#plans` : "/dashboard");

  const planAction = (p: PublicPlan, configured: boolean) => {
    const free = p.priceMonthlyCents === 0;
    if (free) {
      return me ? (
        <Button block disabledReason="Every organisation starts on this plan.">Included</Button>
      ) : (
        <Link to="/signup" className="btn btn-secondary btn-block">
          Start free
        </Link>
      );
    }
    const blocked = purchaseBlocker(p, configured);
    if (blocked) return <Button block variant="primary" disabledReason={blocked}>Choose {p.name}</Button>;
    return me ? (
      <Link to={billingHref(p.id)} className="btn btn-primary btn-block">
        Choose {p.name} in billing
      </Link>
    ) : (
      <Link to={`/signup?plan=${encodeURIComponent(p.id)}`} className="btn btn-primary btn-block">
        Sign up to choose {p.name}
      </Link>
    );
  };

  const billingFaq = FAQ.filter((f) => f.category === "billing");

  return (
    <>
      <PageHero eyebrow="Plans and hour packs" title="Pricing" lead="Every plan includes the full program. Plans differ in auto-director hours, linked computers and team size, and extra hours come as one-off packs. No overage charges, no surprise bills." />
      <div className="wrap section-top">
        {plans.loading && !plans.data && <Loading label="Loading plans…" />}
        {plans.error && <ErrorState error={plans.error} onRetry={plans.reload} />}
        {plans.data && (
          <>
            {!plans.data.billingConfigured && (
              <Alert tone="info" title="Online payments aren't available yet">
                Prices are shown for reference. Plans and hour packs can't be bought on this server until payments are set up.
              </Alert>
            )}
            <div className="plan-grid">
              {plans.data.plans.map((p, i) => (
                <PlanCard key={p.id} plan={p} highlight={i === 1} badge={i === 1 ? <span className="badge badge-brand">Popular</span> : undefined} action={planAction(p, plans.data!.billingConfigured)} />
              ))}
            </div>
            <p className="small muted center-text pricing-note">Prices are per organisation per month. Any applicable taxes are shown at checkout. Payments are processed securely by Stripe.</p>

            {plans.data.plans.length > 0 && (
              <section className="section-tight" aria-labelledby="compare-title">
                <SectionHead id="compare-title" title="Compare plans" />
                <PlanComparison plans={plans.data.plans} />
              </section>
            )}

            {plans.data.hourPacks.length > 0 && (
              <section className="section-tight" aria-labelledby="packs-title">
                <SectionHead id="packs-title" title="Hour packs" lead="One-off top-ups for any plan, used after the included hours, earliest expiry first. No subscription change needed." />
                <div className="pack-list">
                  {plans.data.hourPacks.map((h) => {
                    const blocked = purchaseBlocker(h, plans.data!.billingConfigured);
                    return (
                      <PackCard
                        key={h.id}
                        pack={h}
                        action={
                          blocked ? (
                            <Button disabledReason={blocked}>Buy</Button>
                          ) : me ? (
                            <Link to={billingHref()} className="btn btn-secondary">
                              Buy in billing
                            </Link>
                          ) : (
                            <Link to="/signup" className="btn btn-secondary">
                              Sign up to buy
                            </Link>
                          )
                        }
                      />
                    );
                  })}
                </div>
              </section>
            )}
          </>
        )}

        <section className="section-tight" aria-labelledby="hours-faq">
          <div className="faq-teaser">
            <SectionHead id="hours-faq" eyebrow="Billing FAQ" title="How hours and billing work" lead={<>Still unsure? <Link to="/contact?topic=billing">Ask our team</Link> or read the <Link to="/help/plans-and-hours">plans and hours guide</Link>.</>} />
            <FaqList items={billingFaq} />
          </div>
        </section>
      </div>
      <div className="section-gap" />
      <CtaBand title="Start on the Free plan today" text="No card needed. Upgrade when your production needs more automation, computers or people.">
        {me ? (
          <Link to={billingHref()} className="btn btn-primary btn-lg">
            Open billing
          </Link>
        ) : (
          <Link to="/signup" className="btn btn-primary btn-lg">
            Create your free account
          </Link>
        )}
        <Link to="/contact?topic=sales" className="btn btn-on-dark btn-lg">
          Contact sales
        </Link>
      </CtaBand>
    </>
  );
}
