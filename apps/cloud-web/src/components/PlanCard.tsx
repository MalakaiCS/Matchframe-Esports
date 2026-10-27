import type { ReactNode } from "react";
import type { PublicHourPack, PublicPlan } from "../api/types.ts";
import { formatHours, formatMoney } from "../lib/format.ts";

type PlanLike = Pick<PublicPlan, "id" | "name" | "priceMonthlyCents" | "currency" | "includedAutoDirectorHours" | "features">;

export function planPrice(p: Pick<PublicPlan, "priceMonthlyCents" | "currency">): ReactNode {
  if (p.priceMonthlyCents === null) return <span className="price-amount price-na">Price on request</span>;
  return (
    <>
      <span className="price-amount">{formatMoney(p.priceMonthlyCents, p.currency)}</span>
      <span className="price-unit">/ month</span>
    </>
  );
}

/**
 * Observer and Observer & Cinematics come with every plan that has auto-director hours. Full Action
 * Observer (nade cameras) is a plan feature on top of that, using the same hours.
 */
export const hasObserver = (f: Pick<PlanLike["features"], "autoDirector">): boolean => f.autoDirector;
export const hasFullActionObserver = (f: Pick<PlanLike["features"], "autoDirector" | "fullActionObserver">): boolean => f.autoDirector && f.fullActionObserver === true;

/** Names of the plans that include Full Action Observer, in catalogue order. */
export const fullActionPlanNames = (plans: Pick<PublicPlan, "name" | "features">[]): string[] => plans.filter((p) => hasFullActionObserver(p.features)).map((p) => p.name);

/** Plan cards list what differs between plans: price, auto-director hours, Observer modes, computers and members. */
export function PlanFeatures({ plan }: { plan: PlanLike }) {
  const f = plan.features;
  return (
    <ul className="plan-features">
      <li className={f.autoDirector ? "" : "is-off"}>
        {f.autoDirector ? (
          <>
            <strong>{formatHours(plan.includedAutoDirectorHours * 3600)}</strong> auto-director hours each period
          </>
        ) : (
          "No auto-director hours"
        )}
      </li>
      <li className={hasObserver(f) ? "" : "is-off"}>
        {!hasObserver(f) && <span className="visually-hidden">Not included: </span>}
        <strong>Observer</strong> and <strong>Observer &amp; Cinematics</strong>
      </li>
      <li className={hasFullActionObserver(f) ? "" : "is-off"}>
        {!hasFullActionObserver(f) && <span className="visually-hidden">Not included: </span>}
        <strong>Full Action Observer</strong> with nade cameras
      </li>
      <li>
        Up to <strong>{f.maxDevices}</strong> linked {f.maxDevices === 1 ? "computer" : "computers"}
      </li>
      <li>
        Up to <strong>{f.maxMembers}</strong> team {f.maxMembers === 1 ? "member" : "members"}
      </li>
    </ul>
  );
}

export function PlanCard({ plan, badge, action, highlight }: { plan: PlanLike; badge?: ReactNode; action?: ReactNode; highlight?: boolean }) {
  return (
    <article className={`plan${highlight ? " plan-highlight" : ""}`} aria-labelledby={`plan-${plan.id}`}>
      <header className="plan-head">
        <h3 id={`plan-${plan.id}`}>{plan.name}</h3>
        {badge}
      </header>
      <p className="price">{planPrice(plan)}</p>
      <PlanFeatures plan={plan} />
      {action && <div className="plan-action">{action}</div>}
    </article>
  );
}

export function PackCard({ pack, action }: { pack: Pick<PublicHourPack, "id" | "name" | "hours" | "priceCents" | "currency" | "validDays">; action?: ReactNode }) {
  return (
    <article className="pack" aria-labelledby={`pack-${pack.id}`}>
      <div className="pack-main">
        <h3 id={`pack-${pack.id}`}>{pack.name}</h3>
        <p className="pack-meta">
          <strong>{formatHours(pack.hours * 3600)}</strong> of automatic direction · {pack.validDays ? `valid ${pack.validDays} days from purchase` : "never expires"}
        </p>
      </div>
      <p className="pack-price">{formatMoney(pack.priceCents, pack.currency)}</p>
      {action && <div className="pack-action">{action}</div>}
    </article>
  );
}

/** Why a plan or pack can't be bought online right now (null = it can). */
export function purchaseBlocker(item: { purchasable: boolean }, billingConfigured: boolean): string | null {
  if (!billingConfigured) return "Online payments aren't set up on this server yet. The price is shown for reference.";
  if (!item.purchasable) return "Not available to buy online yet: no payment option has been set up for it.";
  return null;
}
