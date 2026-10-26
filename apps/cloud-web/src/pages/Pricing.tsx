import { api } from "../api/index.ts";
import type { PublicPlan } from "../api/types.ts";
import { PackCard, PlanCard, purchaseBlocker } from "../components/PlanCard.tsx";
import { Alert, Button, ErrorState, Loading, PageHeader } from "../components/ui.tsx";
import { useResource, useTitle } from "../lib/hooks.ts";
import { pickOrg } from "../lib/storage.ts";
import { Link } from "../router.tsx";
import { useSession } from "../state/session.tsx";

export function HoursExplainer() {
  return (
    <dl className="faq">
      <div>
        <dt>What is an auto-director hour?</dt>
        <dd>Time the auto director actually controls the camera on a live match. The Matchframe program measures it and uploads it to your organisation, where you can see it on the Usage page.</dd>
      </div>
      <div>
        <dt>What doesn't use hours?</dt>
        <dd>Manual and advisory direction and simulated matches are free, as is everything else in the program.</dd>
      </div>
      <div>
        <dt>What happens when hours run out?</dt>
        <dd>Automatic direction can't be re-armed until hours are added or the period resets. It never cuts off in the middle of a map: a map that is already being directed is finished. There are no overage charges, so no surprise bills.</dd>
      </div>
      <div>
        <dt>How do I get more hours?</dt>
        <dd>Buy an hour pack, or move to a plan with more included hours. Pack hours are used after the plan's included hours, earliest expiry first.</dd>
      </div>
      <div>
        <dt>When do hours reset?</dt>
        <dd>Included hours renew each billing period (each calendar month on the free plan) and don't roll over. Hour packs last until their expiry date.</dd>
      </div>
    </dl>
  );
}

export function Pricing() {
  useTitle("Pricing");
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

  return (
    <div className="wrap section">
      <PageHeader title="Pricing" subtitle="Plans differ in included auto-director hours, linked computers and team size. Extra hours are available as one-off packs." />
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
              <PlanCard key={p.id} plan={p} highlight={i === 1} action={planAction(p, plans.data!.billingConfigured)} />
            ))}
          </div>
          {plans.data.hourPacks.length > 0 && (
            <section className="section-tight" aria-labelledby="packs-title">
              <h2 id="packs-title" className="section-title">
                Hour packs
              </h2>
              <p className="muted">One-off top-ups for any plan, used after the included hours. No subscription change needed.</p>
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
        <h2 id="hours-faq" className="section-title">
          How auto-director hours work
        </h2>
        <HoursExplainer />
      </section>
    </div>
  );
}
