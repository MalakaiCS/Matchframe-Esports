import Stripe from "stripe";
import { HttpError } from "../http/router.ts";

/**
 * Stripe SDK errors carry `statusCode`/`type`, not `status`; without this they would surface as
 * "internal error". Refusals (bad price id, missing customer, …) become a clear 502.
 */
async function stripeCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const se = e as { type?: unknown; statusCode?: unknown; message?: unknown };
    if (typeof se.type === "string" && se.type.startsWith("Stripe")) {
      throw new HttpError(typeof se.statusCode === "number" && se.statusCode >= 500 ? 503 : 502, "payment_provider_error", `The payment provider refused the request: ${typeof se.message === "string" ? se.message : se.type}`);
    }
    throw e;
  }
}

/** The subset of a Stripe subscription the API stores. */
export interface ProviderSubscription {
  id: string;
  customerId: string;
  status: string;
  priceId: string | null;
  metadata: Record<string, string>;
  periodStart: Date | null;
  periodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

export interface ProviderInvoice {
  id: string;
  number: string | null;
  status: string | null;
  amountDue: number;
  amountPaid: number;
  currency: string;
  created: string;
  hostedInvoiceUrl: string | null;
  pdfUrl: string | null;
}

export interface ProviderEvent {
  id: string;
  type: string;
  object: Record<string, unknown>;
}

/** Billing boundary. The app only talks to this interface (Stripe in production, fakes in tests). */
export interface BillingProvider {
  readonly configured: boolean;
  createCustomer(args: { orgId: string; orgName: string; email: string }): Promise<string>;
  createCheckout(args: { mode: "subscription" | "payment"; customerId: string; priceId: string; orgId: string; metadata: Record<string, string>; successUrl: string; cancelUrl: string }): Promise<{ id: string; url: string }>;
  createPortal(args: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  listInvoices(customerId: string): Promise<ProviderInvoice[]>;
  retrieveSubscription(id: string): Promise<ProviderSubscription>;
  /** Verifies the webhook signature over the exact raw body; throws when invalid. */
  parseWebhook(rawBody: Buffer, signatureHeader: string): ProviderEvent;
}

const ts = (s: number | null | undefined) => (typeof s === "number" ? new Date(s * 1000) : null);

/** Maps a Stripe subscription object (webhook payload or API response) to the stored shape. */
export function mapSubscription(sub: Record<string, unknown>): ProviderSubscription {
  const items = ((sub.items as { data?: Record<string, unknown>[] } | undefined)?.data ?? []) as Record<string, unknown>[];
  const item = items[0];
  const price = item?.price as { id?: string } | string | undefined;
  // Current API versions keep the billing period on the subscription item; older payloads on the subscription.
  const periodStart = ts((item?.current_period_start as number | undefined) ?? (sub.current_period_start as number | undefined));
  const periodEnd = ts((item?.current_period_end as number | undefined) ?? (sub.current_period_end as number | undefined));
  const customer = sub.customer as string | { id: string };
  return {
    id: String(sub.id),
    customerId: typeof customer === "string" ? customer : customer.id,
    status: String(sub.status),
    priceId: typeof price === "string" ? price : (price?.id ?? null),
    metadata: (sub.metadata as Record<string, string> | undefined) ?? {},
    periodStart,
    periodEnd,
    cancelAtPeriodEnd: sub.cancel_at_period_end === true,
  };
}

export class StripeBilling implements BillingProvider {
  readonly configured = true;
  private readonly stripe: Stripe;

  constructor(
    secretKey: string,
    private readonly webhookSecret: string | null,
    apiBase: string | null = null,
  ) {
    const base = apiBase ? new URL(apiBase) : null;
    this.stripe = new Stripe(secretKey, {
      maxNetworkRetries: 2,
      appInfo: { name: "Matchframe Esports cloud", version: "0.1.0" },
      ...(base ? { host: base.hostname, port: Number(base.port || (base.protocol === "https:" ? 443 : 80)), protocol: base.protocol.replace(":", "") as "http" | "https" } : {}),
    });
  }

  async createCustomer(args: { orgId: string; orgName: string; email: string }): Promise<string> {
    const c = await stripeCall(() => this.stripe.customers.create({ name: args.orgName, email: args.email, metadata: { orgId: args.orgId } }, { idempotencyKey: `customer-${args.orgId}` }));
    return c.id;
  }

  async createCheckout(args: { mode: "subscription" | "payment"; customerId: string; priceId: string; orgId: string; metadata: Record<string, string>; successUrl: string; cancelUrl: string }): Promise<{ id: string; url: string }> {
    const metadata = { orgId: args.orgId, ...args.metadata };
    const s = await stripeCall(() =>
      this.stripe.checkout.sessions.create({
        mode: args.mode,
        customer: args.customerId,
        client_reference_id: args.orgId,
        line_items: [{ price: args.priceId, quantity: 1 }],
        success_url: args.successUrl,
        cancel_url: args.cancelUrl,
        metadata,
        ...(args.mode === "subscription" ? { subscription_data: { metadata } } : { payment_intent_data: { metadata } }),
      }),
    );
    if (!s.url) throw new Error("Stripe did not return a checkout URL");
    return { id: s.id, url: s.url };
  }

  async createPortal(args: { customerId: string; returnUrl: string }): Promise<{ url: string }> {
    const p = await stripeCall(() => this.stripe.billingPortal.sessions.create({ customer: args.customerId, return_url: args.returnUrl }));
    return { url: p.url };
  }

  async listInvoices(customerId: string): Promise<ProviderInvoice[]> {
    const list = await stripeCall(() => this.stripe.invoices.list({ customer: customerId, limit: 24 }));
    return list.data.map((i) => ({
      id: i.id ?? "",
      number: i.number ?? null,
      status: i.status ?? null,
      amountDue: i.amount_due,
      amountPaid: i.amount_paid,
      currency: i.currency,
      created: new Date(i.created * 1000).toISOString(),
      hostedInvoiceUrl: i.hosted_invoice_url ?? null,
      pdfUrl: i.invoice_pdf ?? null,
    }));
  }

  async retrieveSubscription(id: string): Promise<ProviderSubscription> {
    const s = await stripeCall(() => this.stripe.subscriptions.retrieve(id));
    return mapSubscription(s as unknown as Record<string, unknown>);
  }

  parseWebhook(rawBody: Buffer, signatureHeader: string): ProviderEvent {
    if (!this.webhookSecret) throw Object.assign(new Error("STRIPE_WEBHOOK_SECRET is not configured"), { status: 503 });
    const ev = this.stripe.webhooks.constructEvent(rawBody, signatureHeader, this.webhookSecret);
    return { id: ev.id, type: ev.type, object: ev.data.object as unknown as Record<string, unknown> };
  }
}

/** Used when Stripe is not configured: billing pages explain that checkout is unavailable. */
export class UnconfiguredBilling implements BillingProvider {
  readonly configured = false;
  private fail(): never {
    throw Object.assign(new Error("billing is not configured on this server (set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET)"), { status: 503 });
  }
  createCustomer(): Promise<string> {
    return this.fail();
  }
  createCheckout(): Promise<{ id: string; url: string }> {
    return this.fail();
  }
  createPortal(): Promise<{ url: string }> {
    return this.fail();
  }
  async listInvoices(): Promise<ProviderInvoice[]> {
    return [];
  }
  retrieveSubscription(): Promise<ProviderSubscription> {
    return this.fail();
  }
  parseWebhook(): ProviderEvent {
    return this.fail();
  }
}
