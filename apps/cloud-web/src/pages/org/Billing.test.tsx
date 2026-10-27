// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { BillingResponse, PlansResponse } from "../../api/types.ts";
import type { ViewerRole } from "../../lib/roles.ts";
import { external } from "../../lib/storage.ts";
import { at, fakeFetch, makeMe, renderWithSession } from "../../test/helpers.tsx";
import { Billing, billingGate, CHECKOUT_REFETCH_MS } from "./Billing.tsx";

const features = (maxDevices: number, maxMembers: number) => ({ autoDirector: true, learnedDirectorShadow: maxDevices > 1, fullActionObserver: maxDevices > 2, maxDevices, maxMembers });
const freePlan = { id: "free", name: "Free", description: "", priceMonthlyCents: 0, currency: "usd", includedAutoDirectorHours: 2, features: features(1, 2), public: true, sortOrder: 0 };
const proPlan = { id: "pro", name: "Pro", description: "", priceMonthlyCents: 4900, currency: "usd", includedAutoDirectorHours: 40, features: features(2, 5), public: true, sortOrder: 1 };
const studioPlan = { id: "studio", name: "Studio", description: "", priceMonthlyCents: 14900, currency: "usd", includedAutoDirectorHours: 150, features: features(6, 20), public: true, sortOrder: 2 };

function plans(over: Partial<PlansResponse> = {}): PlansResponse {
  return {
    plans: [
      { ...freePlan, purchasable: false },
      { ...proPlan, purchasable: true },
      { ...studioPlan, purchasable: false },
    ],
    hourPacks: [{ id: "hours-10", name: "10 auto-director hours", hours: 10, priceCents: 1500, currency: "usd", validDays: 365, public: true, purchasable: true }],
    billingConfigured: true,
    ...over,
  };
}

function billing(over: Partial<BillingResponse> = {}): BillingResponse {
  return {
    plan: { ...freePlan, stripePriceId: null },
    subscription: { status: "none", cancelAtPeriodEnd: false, periodStart: "2026-10-01T00:00:00.000Z", periodEnd: "2026-11-01T00:00:00.000Z" },
    allowance: { periodStart: "2026-10-01T00:00:00.000Z", periodEnd: "2026-11-01T00:00:00.000Z", includedSeconds: 7200, creditSeconds: 0, usedSeconds: 1800, remainingSeconds: 5400, overageAllowed: false },
    credits: [],
    invoices: [],
    invoicesError: null,
    billingConfigured: true,
    hasCustomer: false,
    ...over,
  };
}

function setup(role: ViewerRole, opts: { b?: Partial<BillingResponse>; p?: Partial<PlansResponse>; verified?: boolean; extra?: Parameters<typeof fakeFetch>[0] } = {}) {
  const f = fakeFetch({ "GET /v1/orgs/org_1/billing": { body: billing(opts.b) }, "GET /v1/plans": { body: plans(opts.p) }, ...opts.extra });
  const me = makeMe({ user: { emailVerified: opts.verified ?? true }, orgs: role === "staff" ? [] : [{ id: "org_1", name: "Northside Broadcast", role, planId: "free", planName: "Free", subscriptionStatus: "none" }] });
  renderWithSession(<Billing scope={{ orgId: "org_1", role }} />, me);
  return f;
}

const reasonOf = (btn: HTMLElement) => document.getElementById(btn.getAttribute("aria-describedby") ?? "")?.textContent ?? null;

beforeEach(() => at("/orgs/org_1/billing"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("billing role gating", () => {
  it("owner can subscribe: checkout starts and the browser goes to Stripe", async () => {
    const assign = vi.spyOn(external, "assign").mockImplementation(() => undefined);
    const f = setup("owner", { extra: { "POST /v1/orgs/org_1/billing/checkout": { body: { url: "https://checkout.stripe.com/c/pay/cs_test_1" } } } });
    const choose = (await screen.findByRole("button", { name: "Choose Pro" })) as HTMLButtonElement;
    expect(choose.disabled).toBe(false);
    fireEvent.click(choose);
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_test_1"));
    expect(f.calls.find((c) => c.method === "POST")!.body).toEqual({ kind: "subscription", planId: "pro" });
  });

  it("owner buys an hour pack", async () => {
    const assign = vi.spyOn(external, "assign").mockImplementation(() => undefined);
    const f = setup("owner", { extra: { "POST /v1/orgs/org_1/billing/checkout": { body: { url: "https://checkout.stripe.com/c/pay/cs_test_2" } } } });
    fireEvent.click(await screen.findByRole("button", { name: "Buy" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_test_2"));
    expect(f.calls.find((c) => c.method === "POST")!.body).toEqual({ kind: "hour_pack", packId: "hours-10" });
  });

  it("billing members can buy too", async () => {
    setup("billing");
    expect(((await screen.findByRole("button", { name: "Choose Pro" })) as HTMLButtonElement).disabled).toBe(false);
  });

  it("admins see billing but every purchase and the portal say why they're disabled", async () => {
    setup("admin", { b: { hasCustomer: true } });
    const choose = await screen.findByRole("button", { name: "Choose Pro" });
    expect((choose as HTMLButtonElement).disabled).toBe(true);
    expect(reasonOf(choose)).toBe("Only owners and billing members can do this (your role: admin).");
    const portal = screen.getByRole("button", { name: "Billing details and invoices" });
    expect((portal as HTMLButtonElement).disabled).toBe(true);
    expect(reasonOf(portal)).toBe("Only owners and billing members can do this (your role: admin).");
    expect((screen.getByRole("button", { name: "Buy" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/You can see billing but not change it/)).toBeTruthy();
  });

  it("members don't load billing at all", async () => {
    const f = setup("member");
    expect(await screen.findByText("Billing is hidden for your role")).toBeTruthy();
    expect(f.count("GET", "/v1/orgs/org_1/billing")).toBe(0);
  });

  it("staff viewing an organisation get a read-only page", async () => {
    setup("staff", { b: { hasCustomer: true } });
    const choose = await screen.findByRole("button", { name: "Choose Pro" });
    expect(reasonOf(choose)).toMatch(/^Staff view/);
  });

  it("explains disabled purchases when Stripe isn't configured", async () => {
    setup("owner", { b: { billingConfigured: false }, p: { billingConfigured: false, plans: plans().plans.map((p) => ({ ...p, purchasable: false })) } });
    const choose = await screen.findByRole("button", { name: "Choose Pro" });
    expect(reasonOf(choose)).toBe("Online payments aren't set up on this server yet. The price is shown for reference.");
    expect(screen.getByText("Online payments aren't set up on this server")).toBeTruthy();
    expect(reasonOf(screen.getByRole("button", { name: "Billing details and invoices" }))).toBe("Online payments aren't set up on this server yet.");
  });

  it("explains plans without a Stripe price and unverified emails", async () => {
    setup("owner", { verified: false });
    expect(reasonOf(await screen.findByRole("button", { name: "Choose Studio" }))).toBe("Not available to buy online yet: no payment option has been set up for it.");
    expect(reasonOf(screen.getByRole("button", { name: "Choose Pro" }))).toBe("Verify your email address before buying.");
  });

  it("subscribed organisations manage the plan in the Stripe portal", async () => {
    const assign = vi.spyOn(external, "assign").mockImplementation(() => undefined);
    setup("owner", {
      b: { plan: { ...proPlan, stripePriceId: "price_pro" }, subscription: { status: "active", cancelAtPeriodEnd: true, periodStart: "2026-10-10T00:00:00.000Z", periodEnd: "2026-11-10T00:00:00.000Z" }, hasCustomer: true },
      extra: { "POST /v1/orgs/org_1/billing/portal": { body: { url: "https://billing.stripe.com/p/session/x" } } },
    });
    expect(await screen.findByText("Ends at the end of this period")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Current plan" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Switch to Studio in the portal" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Choose Studio" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Manage subscription" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://billing.stripe.com/p/session/x"));
  });

  it("shows API errors from checkout inline", async () => {
    setup("owner", { extra: { "POST /v1/orgs/org_1/billing/checkout": { status: 409, body: { error: "already_subscribed", message: "this organisation already has a subscription; change plan in the billing portal", detail: null } } } });
    fireEvent.click(await screen.findByRole("button", { name: "Choose Pro" }));
    await screen.findByText("This organisation already has a subscription; change plan in the billing portal.");
  });
});

describe("returning from Stripe", () => {
  it("success: says it may take a few seconds and refetches billing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    at("/orgs/org_1/billing?checkout=success");
    const f = setup("owner");
    await screen.findByText("Payment received");
    expect(screen.getByText(/can take a few seconds/)).toBeTruthy();
    await waitFor(() => expect(f.count("GET", "/v1/orgs/org_1/billing")).toBe(1));
    await act(async () => {
      vi.advanceTimersByTime(CHECKOUT_REFETCH_MS[0]! + 10);
    });
    await waitFor(() => expect(f.count("GET", "/v1/orgs/org_1/billing")).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Payment received")).toBeNull();
    expect(window.location.search).toBe("");
  });

  it("cancelled: nothing was charged", async () => {
    at("/orgs/org_1/billing?checkout=cancelled");
    setup("owner");
    expect(await screen.findByText("Checkout cancelled")).toBeTruthy();
    expect(screen.getByText(/Nothing was charged/)).toBeTruthy();
  });
});

describe("credits and invoices", () => {
  it("lists credits with remaining time and expiry, and invoice links", async () => {
    setup("owner", {
      b: {
        hasCustomer: true,
        credits: [
          { id: "c1", source: "grant", seconds: 18_000, remainingSeconds: 12_600, expiresAt: null, expired: false, note: "Support credit", createdAt: "2026-10-20T00:00:00.000Z" },
          { id: "c2", source: "hour_pack", seconds: 36_000, remainingSeconds: 36_000, expiresAt: "2026-10-01T00:00:00.000Z", expired: true, note: "10 auto-director hours", createdAt: "2025-10-01T00:00:00.000Z" },
        ],
        invoices: [{ id: "in_1", number: "MF-0001", status: "paid", amountDue: 4900, amountPaid: 4900, currency: "usd", created: "2026-10-10T00:00:00.000Z", hostedInvoiceUrl: "https://invoice.stripe.com/i/1", pdfUrl: "https://pay.stripe.com/invoice/1/pdf" }],
      },
    });
    expect(await screen.findByText("Granted by support")).toBeTruthy();
    expect(screen.getByText("3 h 30")).toBeTruthy();
    expect(screen.getByText("Expired")).toBeTruthy();
    expect(screen.getByText("Never")).toBeTruthy();
    expect(screen.getByText("MF-0001")).toBeTruthy();
    expect(screen.getByRole("link", { name: /View/ }).getAttribute("href")).toBe("https://invoice.stripe.com/i/1");
    expect(screen.getByRole("link", { name: /PDF/ }).getAttribute("href")).toBe("https://pay.stripe.com/invoice/1/pdf");
  });
});

describe("billingGate", () => {
  const configured = { billingConfigured: true, hasCustomer: true };
  it("orders the reasons: role, then payments, then verification", () => {
    expect(billingGate("member", false, { billingConfigured: false, hasCustomer: false }, false).buy({ purchasable: false })).toMatch(/^Only owners and billing members/);
    expect(billingGate("owner", false, { billingConfigured: false, hasCustomer: false }, false).buy({ purchasable: true })).toMatch(/^Online payments/);
    expect(billingGate("owner", false, configured, true).buy({ purchasable: true })).toBe("Verify your email address before buying.");
    expect(billingGate("owner", true, configured, true).buy({ purchasable: true })).toBeNull();
    expect(billingGate("owner", false, configured, true).portal).toBeNull();
    expect(billingGate("owner", true, { billingConfigured: true, hasCustomer: false }, true).portal).toMatch(/no billing account yet/);
  });
});
