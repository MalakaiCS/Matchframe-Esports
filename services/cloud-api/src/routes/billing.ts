import { CheckoutRequest } from "@matchframe/cloud-contracts";
import type { CloudApp } from "../app.ts";
import type { Queryable } from "../db/sql.ts";
import { audit } from "../domain/audit.ts";
import { computeAllowance } from "../domain/allowance.ts";
import type { ProviderSubscription } from "../domain/billing-provider.ts";
import { mapSubscription } from "../domain/billing-provider.ts";
import { getHourPack, getPlan, listHourPacks, listPlans } from "../domain/plans.ts";
import type { Router } from "../http/router.ts";
import { HttpError } from "../http/router.ts";
import { newId } from "../ids.ts";

async function planIdForSubscription(db: Queryable, sub: ProviderSubscription): Promise<string> {
  if (sub.metadata.planId && (await getPlan(db, sub.metadata.planId))) return sub.metadata.planId;
  const match = (await listPlans(db)).find((p) => p.stripePriceId && p.stripePriceId === sub.priceId);
  return match?.id ?? "free";
}

async function orgForCustomer(db: Queryable, customerId: string, metadataOrgId: string | undefined): Promise<string | null> {
  if (metadataOrgId) {
    const { rows } = await db.query<{ id: string }>("SELECT id FROM orgs WHERE id = $1", [metadataOrgId]);
    if (rows[0]) return rows[0].id;
  }
  const { rows } = await db.query<{ id: string }>("SELECT id FROM orgs WHERE stripe_customer_id = $1", [customerId]);
  return rows[0]?.id ?? null;
}

export async function upsertSubscription(db: Queryable, orgId: string, sub: ProviderSubscription): Promise<void> {
  const planId = await planIdForSubscription(db, sub);
  await db.query(
    `INSERT INTO subscriptions (org_id, stripe_subscription_id, plan_id, status, current_period_start, current_period_end, cancel_at_period_end, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (org_id) DO UPDATE SET stripe_subscription_id = EXCLUDED.stripe_subscription_id, plan_id = EXCLUDED.plan_id, status = EXCLUDED.status,
       current_period_start = EXCLUDED.current_period_start, current_period_end = EXCLUDED.current_period_end, cancel_at_period_end = EXCLUDED.cancel_at_period_end, updated_at = now()`,
    [orgId, sub.id, planId, sub.status, sub.periodStart, sub.periodEnd, sub.cancelAtPeriodEnd],
  );
}

async function grantPack(db: Queryable, orgId: string, packId: string, reference: string, actor: string, now: Date): Promise<boolean> {
  const pack = await getHourPack(db, packId);
  if (!pack) throw new Error(`unknown hour pack ${packId}`);
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO credit_grants (id, org_id, seconds, source, reference, expires_at, created_by, note) VALUES ($1, $2, $3, 'hour_pack', $4, $5, $6, $7) ON CONFLICT (reference) DO NOTHING RETURNING id",
    [newId("crd"), orgId, Math.round(pack.hours * 3600), reference, pack.validDays ? new Date(now.getTime() + pack.validDays * 86_400_000) : null, actor, pack.name],
  );
  return !!rows[0];
}

/** Applies one verified Stripe event. Safe to call repeatedly with the same event. */
export async function applyStripeEvent(app: CloudApp, ev: { id: string; type: string; object: Record<string, unknown> }): Promise<{ duplicate: boolean; action: string }> {
  const ins = await app.sql.query<{ id: string }>("INSERT INTO stripe_events (id, type) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id", [ev.id, ev.type]);
  if (!ins.rows[0]) {
    const { rows } = await app.sql.query<{ processed_at: Date | null }>("SELECT processed_at FROM stripe_events WHERE id = $1", [ev.id]);
    if (rows[0]?.processed_at) return { duplicate: true, action: "none" };
  }
  let action = "ignored";
  try {
    const o = ev.object;
    const metadata = (o.metadata as Record<string, string> | undefined) ?? {};
    if (ev.type === "checkout.session.completed" || ev.type === "checkout.session.async_payment_succeeded") {
      const customerId = typeof o.customer === "string" ? o.customer : ((o.customer as { id?: string } | null)?.id ?? null);
      const orgId = customerId ? await orgForCustomer(app.sql, customerId, (o.client_reference_id as string | undefined) ?? metadata.orgId) : null;
      if (!orgId) throw new Error(`checkout session ${String(o.id)} does not belong to a known organisation`);
      if (customerId) await app.sql.query("UPDATE orgs SET stripe_customer_id = COALESCE(stripe_customer_id, $2) WHERE id = $1", [orgId, customerId]);
      if (o.mode === "subscription" && typeof o.subscription === "string") {
        await upsertSubscription(app.sql, orgId, await app.billing.retrieveSubscription(o.subscription));
        action = "subscription_synced";
      } else if (o.mode === "payment" && metadata.packId) {
        if (o.payment_status === "paid") action = (await grantPack(app.sql, orgId, metadata.packId, String(o.id), "stripe", app.now())) ? "credits_granted" : "credits_already_granted";
        else action = "awaiting_payment";
      }
      await audit(app.sql, "stripe", orgId, `billing.${action}`, { event: ev.id, session: o.id });
    } else if (ev.type.startsWith("customer.subscription.")) {
      const sub = mapSubscription(o);
      const orgId = await orgForCustomer(app.sql, sub.customerId, sub.metadata.orgId);
      if (!orgId) throw new Error(`subscription ${sub.id} does not belong to a known organisation`);
      await upsertSubscription(app.sql, orgId, sub);
      action = "subscription_synced";
      await audit(app.sql, "stripe", orgId, "billing.subscription", { event: ev.id, status: sub.status });
    } else if (ev.type === "invoice.payment_failed") {
      const customerId = String(o.customer ?? "");
      const orgId = await orgForCustomer(app.sql, customerId, undefined);
      action = "payment_failed_recorded";
      await audit(app.sql, "stripe", orgId, "billing.payment_failed", { event: ev.id, invoice: o.id });
    }
    await app.sql.query("UPDATE stripe_events SET processed_at = now(), error = NULL WHERE id = $1", [ev.id]);
    return { duplicate: false, action };
  } catch (e) {
    await app.sql.query("UPDATE stripe_events SET error = $2 WHERE id = $1", [ev.id, String(e).slice(0, 500)]);
    throw e;
  }
}

export function registerBillingRoutes(r: Router, app: CloudApp): void {
  r.add("GET", "/v1/plans", { summary: "Public plans and hour packs" }, async () => ({
    plans: (await listPlans(app.sql)).filter((p) => p.public).map(({ stripePriceId, ...p }) => ({ ...p, purchasable: !!stripePriceId && app.billing.configured })),
    hourPacks: (await listHourPacks(app.sql)).filter((h) => h.public).map(({ stripePriceId, ...h }) => ({ ...h, purchasable: !!stripePriceId && app.billing.configured })),
    billingConfigured: app.billing.configured,
  }));

  r.add("GET", "/v1/orgs/:orgId/billing", { summary: "Plan, subscription, auto-director allowance, credits and invoices" }, async (ctx) => {
    await app.requireOrg(ctx, ctx.params.orgId!, "billing.view");
    const now = app.now();
    const { planState, ...allowance } = await computeAllowance(app.sql, ctx.params.orgId!, now);
    const credits = await app.sql.query<{ id: string; seconds: string; source: string; expires_at: Date | null; note: string | null; created_at: Date; used: string }>(
      "SELECT g.id, g.seconds, g.source, g.expires_at, g.note, g.created_at, (SELECT COALESCE(sum(seconds), 0) FROM credit_debits d WHERE d.grant_id = g.id) AS used FROM credit_grants g WHERE g.org_id = $1 ORDER BY g.created_at DESC",
      [ctx.params.orgId!],
    );
    const org = await app.sql.query<{ stripe_customer_id: string | null }>("SELECT stripe_customer_id FROM orgs WHERE id = $1", [ctx.params.orgId!]);
    let invoices: Awaited<ReturnType<typeof app.billing.listInvoices>> = [];
    let invoicesError: string | null = null;
    if (org.rows[0]?.stripe_customer_id) {
      try {
        invoices = await app.billing.listInvoices(org.rows[0].stripe_customer_id);
      } catch (e) {
        invoicesError = e instanceof Error ? e.message : String(e);
      }
    }
    return {
      plan: planState.plan,
      subscription: { status: planState.subscriptionStatus, cancelAtPeriodEnd: planState.cancelAtPeriodEnd, periodStart: planState.periodStart.toISOString(), periodEnd: planState.periodEnd.toISOString() },
      allowance,
      credits: credits.rows.map((c) => ({ id: c.id, source: c.source, seconds: Number(c.seconds), remainingSeconds: Math.max(0, Number(c.seconds) - Number(c.used)), expiresAt: c.expires_at?.toISOString() ?? null, expired: !!c.expires_at && c.expires_at <= now, note: c.note, createdAt: c.created_at.toISOString() })),
      invoices,
      invoicesError,
      billingConfigured: app.billing.configured,
      hasCustomer: !!org.rows[0]?.stripe_customer_id,
    };
  });

  r.add("POST", "/v1/orgs/:orgId/billing/checkout", { body: CheckoutRequest, summary: "Start Stripe Checkout for a plan or an hour pack" }, async (ctx) => {
    const { user } = await app.requireOrg(ctx, ctx.params.orgId!, "billing.manage", { verified: true });
    if (!app.billing.configured) throw new HttpError(503, "billing_unavailable", "billing is not configured on this server");
    let priceId: string | null;
    let mode: "subscription" | "payment";
    let metadata: Record<string, string>;
    if (ctx.body.kind === "subscription") {
      const plan = await getPlan(app.sql, ctx.body.planId);
      if (!plan || !plan.public) throw new HttpError(404, "not_found", "plan not found");
      priceId = plan.stripePriceId;
      mode = "subscription";
      metadata = { planId: plan.id };
      const current = await app.sql.query<{ status: string; plan_id: string }>("SELECT status, plan_id FROM subscriptions WHERE org_id = $1", [ctx.params.orgId!]);
      if (current.rows[0] && ["active", "trialing", "past_due"].includes(current.rows[0].status)) throw new HttpError(409, "already_subscribed", "this organisation already has a subscription; change plan in the billing portal");
    } else {
      const pack = await getHourPack(app.sql, ctx.body.packId);
      if (!pack || !pack.public) throw new HttpError(404, "not_found", "hour pack not found");
      priceId = pack.stripePriceId;
      mode = "payment";
      metadata = { packId: pack.id };
    }
    if (!priceId) throw new HttpError(409, "not_purchasable", "this item has no Stripe price configured yet");
    const org = await app.sql.query<{ name: string; stripe_customer_id: string | null }>("SELECT name, stripe_customer_id FROM orgs WHERE id = $1", [ctx.params.orgId!]);
    let customerId = org.rows[0]!.stripe_customer_id;
    if (!customerId) {
      customerId = await app.billing.createCustomer({ orgId: ctx.params.orgId!, orgName: org.rows[0]!.name, email: user.email });
      await app.sql.query("UPDATE orgs SET stripe_customer_id = $2 WHERE id = $1 AND stripe_customer_id IS NULL", [ctx.params.orgId!, customerId]);
    }
    const base = `${app.cfg.publicUrl}/orgs/${encodeURIComponent(ctx.params.orgId!)}/billing`;
    const session = await app.billing.createCheckout({ mode, customerId, priceId, orgId: ctx.params.orgId!, metadata, successUrl: `${base}?checkout=success`, cancelUrl: `${base}?checkout=cancelled` });
    await audit(app.sql, user.id, ctx.params.orgId!, "billing.checkout_started", { kind: ctx.body.kind, session: session.id, ...metadata });
    return { url: session.url };
  });

  r.add("POST", "/v1/orgs/:orgId/billing/portal", { summary: "Open the Stripe customer portal (change plan, payment method, cancel)" }, async (ctx) => {
    const { user } = await app.requireOrg(ctx, ctx.params.orgId!, "billing.manage");
    const org = await app.sql.query<{ stripe_customer_id: string | null }>("SELECT stripe_customer_id FROM orgs WHERE id = $1", [ctx.params.orgId!]);
    if (!org.rows[0]?.stripe_customer_id) throw new HttpError(409, "no_customer", "there is no billing account yet; choose a plan first");
    const p = await app.billing.createPortal({ customerId: org.rows[0].stripe_customer_id, returnUrl: `${app.cfg.publicUrl}/orgs/${encodeURIComponent(ctx.params.orgId!)}/billing` });
    await audit(app.sql, user.id, ctx.params.orgId!, "billing.portal_opened");
    return { url: p.url };
  });

  r.add("POST", "/v1/stripe/webhook", { browserMutation: false, summary: "Stripe webhook endpoint (signature-verified)" }, async (ctx) => {
    const sig = ctx.headers["stripe-signature"];
    if (typeof sig !== "string") throw new HttpError(400, "missing_signature", "missing Stripe-Signature header");
    let ev;
    try {
      ev = app.billing.parseWebhook(ctx.rawBody, sig);
    } catch (e) {
      if ((e as { status?: number }).status === 503) throw e;
      throw new HttpError(400, "bad_signature", "webhook signature verification failed");
    }
    // A failed event returns 500 so Stripe retries it; processed events are acknowledged once.
    return { received: true, ...(await applyStripeEvent(app, ev)) };
  });
}
