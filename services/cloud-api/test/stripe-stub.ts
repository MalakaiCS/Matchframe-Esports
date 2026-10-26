import { createServer } from "node:http";
import type { Server } from "node:http";

/**
 * Minimal local stand-in for the Stripe REST endpoints the cloud API calls, so the real Stripe SDK
 * can be exercised over HTTP in tests. It records requests (form-decoded) and returns the fields
 * the API reads. It is not a Stripe emulator.
 */
export interface StubRequest {
  method: string;
  path: string;
  form: Record<string, string>;
  idempotencyKey: string | null;
}

export class StripeStub {
  readonly requests: StubRequest[] = [];
  readonly subscriptions = new Map<string, Record<string, unknown>>();
  private server: Server | null = null;
  port = 0;
  private n = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const url = new URL(req.url ?? "/", "http://stub");
        const form = Object.fromEntries(new URLSearchParams(body));
        this.requests.push({ method: req.method ?? "", path: url.pathname, form, idempotencyKey: (req.headers["idempotency-key"] as string | undefined) ?? null });
        const send = (status: number, obj: unknown) => {
          res.writeHead(status, { "content-type": "application/json", "request-id": `req_${++this.n}` });
          res.end(JSON.stringify(obj));
        };
        if (req.method === "POST" && url.pathname === "/v1/customers") return send(200, { id: `cus_${++this.n}`, object: "customer", email: form.email, name: form.name, metadata: { orgId: form["metadata[orgId]"] } });
        if (req.method === "POST" && url.pathname === "/v1/checkout/sessions") return send(200, { id: `cs_test_${++this.n}`, object: "checkout.session", url: `https://checkout.stripe.test/c/${this.n}`, mode: form.mode });
        if (req.method === "POST" && url.pathname === "/v1/billing_portal/sessions") return send(200, { id: `bps_${++this.n}`, object: "billing_portal.session", url: `https://billing.stripe.test/p/${this.n}` });
        if (req.method === "GET" && url.pathname.startsWith("/v1/subscriptions/")) {
          const sub = this.subscriptions.get(url.pathname.split("/").pop()!);
          return sub ? send(200, sub) : send(404, { error: { type: "invalid_request_error", message: "No such subscription" } });
        }
        if (req.method === "GET" && url.pathname === "/v1/invoices") return send(200, { object: "list", data: [{ id: "in_1", object: "invoice", number: "MF-0001", status: "paid", amount_due: 4900, amount_paid: 4900, currency: "usd", created: 1793000000, hosted_invoice_url: "https://invoice.stripe.test/1", invoice_pdf: null }], has_more: false });
        send(404, { error: { type: "invalid_request_error", message: `stub has no ${req.method} ${url.pathname}` } });
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", () => r()));
    this.port = (this.server.address() as { port: number }).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server?.close(() => r()));
  }

  addSubscription(id: string, customer: string, opts: { status: string; priceId: string; planId: string; orgId: string; start: number; end: number }): void {
    this.subscriptions.set(id, {
      id,
      object: "subscription",
      customer,
      status: opts.status,
      cancel_at_period_end: false,
      metadata: { orgId: opts.orgId, planId: opts.planId },
      items: { object: "list", data: [{ id: `si_${id}`, object: "subscription_item", price: { id: opts.priceId, object: "price" }, current_period_start: opts.start, current_period_end: opts.end }] },
    });
  }
}
