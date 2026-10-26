import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EntitlementPayload } from "@matchframe/cloud-contracts";
import { verifyEntitlement } from "@matchframe/cloud-contracts/token";
import { CloudApp } from "../src/app.ts";
import { loadCloudConfig } from "../src/config.ts";
import { PgliteSql } from "../src/db/sql.ts";
import { startCloudServer } from "../src/server.ts";
import { StripeStub } from "./stripe-stub.ts";

const WEBHOOK_SECRET = "whsec_test_matchframe";
const signer = new Stripe("sk_test_signer");

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

class Client {
  cookie = "";
  constructor(
    private readonly base: string,
    private readonly origin: string | null = base,
  ) {}
  async req<T = Record<string, unknown>>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; data: T; headers: Headers }> {
    const res = await fetch(this.base + path, {
      method,
      headers: { "content-type": "application/json", ...(this.cookie ? { cookie: this.cookie } : {}), ...(this.origin ? { origin: this.origin } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      this.cookie = pair!.endsWith("=") ? "" : pair!;
    }
    const text = await res.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      // non-JSON (CSV)
    }
    return { status: res.status, data: data as T, headers: res.headers };
  }
}

describe("cloud API end to end (HTTP server, PGlite Postgres, Stripe SDK against a local stub)", () => {
  let app: CloudApp;
  let close: () => Promise<void>;
  let base: string;
  const stub = new StripeStub();
  let clockOffsetMs = 0;

  const lastEmail = async (to: string) => {
    const { rows } = await app.sql.query<{ subject: string; body_text: string }>("SELECT subject, body_text FROM outbox_emails WHERE to_addr = $1 ORDER BY id DESC LIMIT 1", [to]);
    return rows[0]!;
  };
  const tokenFrom = (text: string) => /token=([A-Za-z0-9_-]+)/.exec(text)![1]!;

  async function signupVerified(email: string, orgName = "Org"): Promise<{ client: Client; orgId: string }> {
    const client = new Client(base);
    const r = await client.req<{ orgId: string }>("POST", "/v1/auth/signup", { email, password: "correct horse battery", displayName: email.split("@")[0], orgName });
    expect(r.status).toBe(201);
    const v = await client.req("POST", "/v1/auth/verify-email", { token: tokenFrom((await lastEmail(email)).body_text) });
    expect(v.status).toBe(200);
    return { client, orgId: r.data.orgId };
  }

  async function signedWebhook(event: Record<string, unknown>): Promise<{ status: number; data: Record<string, unknown> }> {
    const payload = JSON.stringify(event);
    const header = signer.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
    const res = await fetch(`${base}/v1/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": header }, body: payload });
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  }

  beforeAll(async () => {
    await stub.start();
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    process.env.STRIPE_PRICE_PRO = "price_pro";
    process.env.STRIPE_PRICE_PACK_10 = "price_pack10";
    const cfg = loadCloudConfig({}, { publicUrl: base, port, stripeSecretKey: "sk_test_123", stripeWebhookSecret: WEBHOOK_SECRET, stripeApiBase: `http://127.0.0.1:${stub.port}`, staffEmails: ["staff@example.com"] });
    app = new CloudApp(cfg, { sql: new PgliteSql(), now: () => new Date(Date.now() + clockOffsetMs), rateLimitScale: 100 });
    await app.init();
    ({ close } = await startCloudServer(app));
  });

  afterAll(async () => {
    await close?.();
    await app?.close();
    await stub.stop();
  });

  it("accounts: signup, email verification, login, enumeration-safe errors, password reset, CSRF origin check", async () => {
    const c = new Client(base);
    const s = await c.req<{ orgId: string }>("POST", "/v1/auth/signup", { email: "Owner@Example.com", password: "correct horse battery", displayName: "Owner", orgName: "Owner Org" });
    expect(s.status).toBe(201);
    expect(c.cookie).toMatch(/^mf_session=/);
    const me = await c.req<{ user: { email: string; emailVerified: boolean }; orgs: { role: string; planId: string }[] }>("GET", "/v1/auth/me");
    expect(me.data.user).toMatchObject({ email: "owner@example.com", emailVerified: false });
    expect(me.data.orgs[0]).toMatchObject({ role: "owner", planId: "free" });
    // Unverified accounts cannot start checkout.
    expect((await c.req("POST", `/v1/orgs/${s.data.orgId}/billing/checkout`, { kind: "subscription", planId: "pro" })).status).toBe(403);
    const mail = await lastEmail("owner@example.com");
    expect(mail.subject).toMatch(/Confirm/);
    expect((await c.req("POST", "/v1/auth/verify-email", { token: tokenFrom(mail.body_text) })).status).toBe(200);
    expect((await c.req("POST", "/v1/auth/verify-email", { token: tokenFrom(mail.body_text) })).status).toBe(400); // single use
    expect(((await c.req<{ user: { emailVerified: boolean } }>("GET", "/v1/auth/me")).data.user.emailVerified)).toBe(true);

    expect((await new Client(base).req("POST", "/v1/auth/signup", { email: "owner@example.com", password: "another long password", displayName: "X", orgName: "Y" })).status).toBe(409);
    const wrong = await new Client(base).req<{ error: string }>("POST", "/v1/auth/login", { email: "owner@example.com", password: "nope nope nope" });
    const unknown = await new Client(base).req<{ error: string }>("POST", "/v1/auth/login", { email: "nobody@example.com", password: "nope nope nope" });
    expect([wrong.status, wrong.data.error]).toEqual([401, "invalid_credentials"]);
    expect([unknown.status, unknown.data.error]).toEqual([401, "invalid_credentials"]);

    // Cross-site browser mutation refused.
    const evil = new Client(base, "https://evil.example");
    evil.cookie = c.cookie;
    expect((await evil.req("PATCH", `/v1/orgs/${s.data.orgId}`, { name: "pwned" })).status).toBe(403);

    // Password reset: always OK; token works once; other sessions are signed out.
    expect((await new Client(base).req("POST", "/v1/auth/request-password-reset", { email: "nobody@example.com" })).status).toBe(200);
    expect((await new Client(base).req("POST", "/v1/auth/request-password-reset", { email: "owner@example.com" })).status).toBe(200);
    const reset = tokenFrom((await lastEmail("owner@example.com")).body_text);
    expect((await new Client(base).req("POST", "/v1/auth/reset-password", { token: reset, password: "brand new password!" })).status).toBe(200);
    expect((await c.req("GET", "/v1/auth/me")).status).toBe(401);
    const back = new Client(base);
    expect((await back.req("POST", "/v1/auth/login", { email: "owner@example.com", password: "brand new password!" })).status).toBe(200);
    expect((await back.req("POST", "/v1/auth/logout")).status).toBe(200);
    expect((await back.req("GET", "/v1/auth/me")).status).toBe(401);
  });

  it("organisations: invites, roles, last-owner protection, member limits", async () => {
    const { client: owner, orgId } = await signupVerified("lead@example.com", "Team Org");
    expect((await owner.req("POST", `/v1/orgs/${orgId}/invites`, { email: "op@example.com", role: "member" })).status).toBe(200);
    const inviteToken = tokenFrom((await lastEmail("op@example.com")).body_text);
    // Free plan: 2 members (owner + pending invite) → a third is refused.
    expect((await owner.req<{ error: string }>("POST", `/v1/orgs/${orgId}/invites`, { email: "third@example.com", role: "member" })).data.error).toBe("member_limit");
    const { client: op } = await signupVerified("op@example.com", "Op's own org");
    const wrongUser = (await signupVerified("intruder@example.com")).client;
    expect((await wrongUser.req("POST", `/v1/invites/${inviteToken}/accept`)).status).toBe(403);
    expect((await op.req<{ orgId: string }>("POST", `/v1/invites/${inviteToken}/accept`)).data.orgId).toBe(orgId);
    const members = await owner.req<{ members: { userId: string; email: string; role: string }[] }>("GET", `/v1/orgs/${orgId}/members`);
    expect(members.data.members.map((m) => m.email).sort()).toEqual(["lead@example.com", "op@example.com"]);
    const opId = members.data.members.find((m) => m.email === "op@example.com")!.userId;
    const leadId = members.data.members.find((m) => m.email === "lead@example.com")!.userId;
    expect((await op.req("POST", `/v1/orgs/${orgId}/invites`, { email: "x@example.com", role: "member" })).status).toBe(403);
    expect((await owner.req<{ error: string }>("PATCH", `/v1/orgs/${orgId}/members/${leadId}`, { role: "admin" })).data.error).toBe("last_owner");
    expect((await owner.req("PATCH", `/v1/orgs/${orgId}/members/${opId}`, { role: "admin" })).status).toBe(200);
    expect((await owner.req<{ error: string }>("DELETE", `/v1/orgs/${orgId}/members/${leadId}`)).data.error).toBe("last_owner");
    expect((await new Client(base).req("GET", `/v1/orgs/${orgId}/members`)).status).toBe(401);
    expect((await wrongUser.req("GET", `/v1/orgs/${orgId}/members`)).status).toBe(404);
  });

  it("devices: code linking with polling rules, signed entitlement, idempotent usage, device limit, revocation", async () => {
    const { client, orgId } = await signupVerified("producer@example.com", "Producer Org");
    const desktop = new Client(base, null);
    const installId = randomUUID().replace(/-/g, "");
    const auth = await desktop.req<{ deviceCode: string; userCode: string; verificationUriComplete: string; interval: number }>("POST", "/v1/device/authorize", { deviceName: "Observer PC", platform: "win32", appVersion: "0.1.0", installId });
    expect(auth.status).toBe(200);
    expect(auth.data.userCode).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    expect(auth.data.verificationUriComplete).toContain(`/link?code=${auth.data.userCode}`);
    expect((await desktop.req<{ error: string }>("POST", "/v1/device/token", { deviceCode: auth.data.deviceCode })).data.error).toBe("authorization_pending");
    expect((await desktop.req<{ error: string }>("POST", "/v1/device/token", { deviceCode: auth.data.deviceCode })).data.error).toBe("slow_down");

    const preview = await client.req<{ deviceName: string }>("GET", `/v1/device-link/${auth.data.userCode.replace("-", "").toLowerCase()}`);
    expect(preview.data.deviceName).toBe("Observer PC");
    expect((await client.req("POST", "/v1/device-link/approve", { userCode: auth.data.userCode, orgId })).status).toBe(200);
    clockOffsetMs += 11_000;
    const tok = await desktop.req<{ deviceId: string; orgId: string; deviceToken: string }>("POST", "/v1/device/token", { deviceCode: auth.data.deviceCode });
    expect(tok.status).toBe(200);
    expect(tok.data.orgId).toBe(orgId);
    expect(tok.data.deviceToken).toMatch(/^mfd_/);
    clockOffsetMs += 11_000;
    expect((await desktop.req<{ error: string }>("POST", "/v1/device/token", { deviceCode: auth.data.deviceCode })).data.error).toBe("expired_token");

    const bearer = { authorization: `Bearer ${tok.data.deviceToken}` };
    const ent = await desktop.req<{ token: string; payload: EntitlementPayload }>("POST", "/v1/device/entitlement", undefined, bearer);
    const keys = (await desktop.req<{ keys: Record<string, string> }>("GET", "/v1/keys")).data.keys;
    const check = verifyEntitlement(ent.data.token, keys, new Date(Date.now() + clockOffsetMs), tok.data.deviceId);
    expect(check.ok && check.state).toBe("valid");
    expect(check.ok && check.payload.plan.id).toBe("free");
    expect(check.ok && check.payload.autoDirector).toMatchObject({ includedSeconds: 7200, usedSeconds: 0, remainingSeconds: 7200, overageAllowed: false });

    const now = Date.now() + clockOffsetMs;
    const rec = (minutesAgo: number, seconds: number) => ({ recordId: randomUUID(), kind: "auto_director", startedAt: new Date(now - minutesAgo * 60_000).toISOString(), endedAt: new Date(now - minutesAgo * 60_000 + seconds * 1000).toISOString(), seconds, sessionId: "session_a", matchRef: null, mapName: "de_inferno", appVersion: "0.1.0" });
    const records = [rec(200, 1200), rec(150, 1200), rec(100, 1200)];
    const up = await desktop.req<{ accepted: string[]; duplicates: string[]; rejected: unknown[] }>("POST", "/v1/device/usage", { records }, bearer);
    expect(up.data.accepted).toHaveLength(3);
    const again = await desktop.req<{ accepted: string[]; duplicates: string[] }>("POST", "/v1/device/usage", { records }, bearer);
    expect([again.data.accepted.length, again.data.duplicates.length]).toEqual([0, 3]);
    const bad = { ...rec(50, 600), seconds: 5000 };
    const rej = await desktop.req<{ rejected: { reason: string }[] }>("POST", "/v1/device/usage", { records: [bad] }, bearer);
    expect(rej.data.rejected[0]!.reason).toMatch(/exceed/);
    const ent2 = await desktop.req<{ payload: EntitlementPayload }>("POST", "/v1/device/entitlement", undefined, bearer);
    expect(ent2.data.payload.autoDirector).toMatchObject({ usedSeconds: 3600, remainingSeconds: 3600 });

    const usage = await client.req<{ byDevice: { name: string; seconds: number }[]; daily: unknown[] }>("GET", `/v1/orgs/${orgId}/usage`);
    expect(usage.data.byDevice[0]).toMatchObject({ name: "Observer PC", seconds: 3600 });
    const csv = await client.req<string>("GET", `/v1/orgs/${orgId}/usage?format=csv`);
    expect(csv.headers.get("content-type")).toMatch(/text\/csv/);
    expect(String(csv.data).split("\n")[0]).toBe("started_at,ended_at,seconds,computer,map,match");

    // Free plan allows one computer; re-linking the same install replaces it, a second install is refused.
    const auth2 = await desktop.req<{ userCode: string }>("POST", "/v1/device/authorize", { deviceName: "Second PC", platform: "win32", appVersion: "0.1.0", installId: randomUUID().replace(/-/g, "") });
    expect((await client.req<{ error: string }>("POST", "/v1/device-link/approve", { userCode: auth2.data.userCode, orgId })).data.error).toBe("device_limit");

    const devices = await client.req<{ id: string; revokedAt: string | null }[]>("GET", `/v1/orgs/${orgId}/devices`);
    expect((await client.req("DELETE", `/v1/orgs/${orgId}/devices/${devices.data[0]!.id}`)).status).toBe(200);
    const revoked = await desktop.req<{ error: string }>("POST", "/v1/device/entitlement", undefined, bearer);
    expect([revoked.status, revoked.data.error]).toEqual([401, "device_revoked"]);
  });

  it("billing: Stripe Checkout via the SDK, signed webhooks (idempotent), plan sync, hour packs, portal, invoices, cancellation", async () => {
    const { client, orgId } = await signupVerified("billing@example.com", "Billing Org");
    const plans = await new Client(base).req<{ plans: { id: string; purchasable: boolean }[]; billingConfigured: boolean }>("GET", "/v1/plans");
    expect(plans.data.billingConfigured).toBe(true);
    expect(plans.data.plans.find((p) => p.id === "pro")!.purchasable).toBe(true);
    expect(plans.data.plans.find((p) => p.id === "studio")!.purchasable).toBe(false); // no Stripe price configured
    expect(JSON.stringify(plans.data)).not.toContain("price_pro");

    const co = await client.req<{ url: string }>("POST", `/v1/orgs/${orgId}/billing/checkout`, { kind: "subscription", planId: "pro" });
    expect(co.data.url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    const customerReq = stub.requests.find((r) => r.path === "/v1/customers" && r.form["metadata[orgId]"] === orgId)!;
    expect(customerReq.idempotencyKey).toBe(`customer-${orgId}`);
    const sessionReq = stub.requests.filter((r) => r.path === "/v1/checkout/sessions").pop()!;
    expect(sessionReq.form).toMatchObject({ mode: "subscription", "line_items[0][price]": "price_pro", "line_items[0][quantity]": "1", client_reference_id: orgId, "metadata[planId]": "pro", "subscription_data[metadata][orgId]": orgId });
    expect(sessionReq.form.success_url).toBe(`${base}/orgs/${orgId}/billing?checkout=success`);
    const { rows } = await app.sql.query<{ stripe_customer_id: string }>("SELECT stripe_customer_id FROM orgs WHERE id = $1", [orgId]);
    const customer = rows[0]!.stripe_customer_id;

    const t = Math.floor(Date.now() / 1000);
    stub.addSubscription("sub_1", customer, { status: "active", priceId: "price_pro", planId: "pro", orgId, start: t - 86400, end: t + 29 * 86400 });
    const completed = { id: "evt_1", object: "event", type: "checkout.session.completed", data: { object: { id: "cs_1", object: "checkout.session", mode: "subscription", customer, subscription: "sub_1", client_reference_id: orgId, metadata: { orgId, planId: "pro" }, payment_status: "paid" } } };
    const w1 = await signedWebhook(completed);
    expect(w1.data).toMatchObject({ received: true, duplicate: false, action: "subscription_synced" });
    expect((await signedWebhook(completed)).data).toMatchObject({ duplicate: true });
    const forged = await fetch(`${base}/v1/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": signer.webhooks.generateTestHeaderString({ payload: JSON.stringify(completed), secret: "whsec_wrong" }) }, body: JSON.stringify(completed) });
    expect(forged.status).toBe(400);

    let billing = await client.req<{ plan: { id: string }; subscription: { status: string }; allowance: { includedSeconds: number }; invoices: { number: string }[] }>("GET", `/v1/orgs/${orgId}/billing`);
    expect(billing.data.plan.id).toBe("pro");
    expect(billing.data.subscription.status).toBe("active");
    expect(billing.data.allowance.includedSeconds).toBe(40 * 3600);
    expect(billing.data.invoices[0]!.number).toBe("MF-0001");
    expect((await client.req<{ error: string }>("POST", `/v1/orgs/${orgId}/billing/checkout`, { kind: "subscription", planId: "pro" })).data.error).toBe("already_subscribed");
    expect((await client.req<{ url: string }>("POST", `/v1/orgs/${orgId}/billing/portal`)).data.url).toMatch(/^https:\/\/billing\.stripe\.test\//);

    // Hour pack: credits only once, only when paid.
    expect((await client.req<{ url: string }>("POST", `/v1/orgs/${orgId}/billing/checkout`, { kind: "hour_pack", packId: "hours-10" })).data.url).toBeTruthy();
    expect(stub.requests.filter((r) => r.path === "/v1/checkout/sessions").pop()!.form).toMatchObject({ mode: "payment", "line_items[0][price]": "price_pack10", "metadata[packId]": "hours-10" });
    const packEvent = (id: string, paid: string) => ({ id, object: "event", type: "checkout.session.completed", data: { object: { id: "cs_pack_1", object: "checkout.session", mode: "payment", customer, client_reference_id: orgId, metadata: { orgId, packId: "hours-10" }, payment_status: paid } } });
    expect((await signedWebhook(packEvent("evt_pack_unpaid", "unpaid"))).data.action).toBe("awaiting_payment");
    expect((await signedWebhook(packEvent("evt_pack_paid", "paid"))).data.action).toBe("credits_granted");
    expect((await signedWebhook(packEvent("evt_pack_paid_again", "paid"))).data.action).toBe("credits_already_granted");
    billing = await client.req("GET", `/v1/orgs/${orgId}/billing`);
    expect((billing.data as unknown as { allowance: { creditSeconds: number } }).allowance.creditSeconds).toBe(36000);

    // Cancellation drops back to the free plan; credits remain.
    const canceled = mapToEvent("evt_cancel", "customer.subscription.deleted", { ...stub.subscriptions.get("sub_1")!, status: "canceled" });
    expect((await signedWebhook(canceled)).data.action).toBe("subscription_synced");
    const after = await client.req<{ plan: { id: string }; allowance: { includedSeconds: number; creditSeconds: number } }>("GET", `/v1/orgs/${orgId}/billing`);
    expect(after.data.plan.id).toBe("free");
    expect(after.data.allowance).toMatchObject({ includedSeconds: 7200, creditSeconds: 36000 });
  });

  it("allowance: usage beyond included hours draws credits (earliest expiry first); expired credits do not count; staff grants", async () => {
    const { client, orgId } = await signupVerified("quota@example.com", "Quota Org");
    const staff = await signupVerified("staff@example.com", "Staff Org");
    expect((await client.req("POST", `/v1/admin/orgs/${orgId}/credits`, { hours: 5, note: "nope" })).status).toBe(403);
    const soon = new Date(Date.now() + clockOffsetMs + 10 * 86_400_000).toISOString();
    expect((await staff.client.req("POST", `/v1/admin/orgs/${orgId}/credits`, { hours: 1, note: "expires soon", expiresAt: soon })).status).toBe(200);
    expect((await staff.client.req("POST", `/v1/admin/orgs/${orgId}/credits`, { hours: 2, note: "no expiry" })).status).toBe(200);
    expect((await staff.client.req("POST", `/v1/admin/orgs/${orgId}/credits`, { hours: 9, note: "already expired", expiresAt: new Date(Date.now() + clockOffsetMs - 1000).toISOString() })).status).toBe(200);

    // Link a computer and upload 3.5 h: 2 h included, 1 h from the expiring grant, 0.5 h from the open-ended grant.
    const desktop = new Client(base, null);
    const a = await desktop.req<{ deviceCode: string; userCode: string }>("POST", "/v1/device/authorize", { deviceName: "Quota PC", platform: "win32", appVersion: "0.1.0", installId: randomUUID().replace(/-/g, "") });
    await client.req("POST", "/v1/device-link/approve", { userCode: a.data.userCode, orgId });
    clockOffsetMs += 11_000;
    const tok = await desktop.req<{ deviceToken: string }>("POST", "/v1/device/token", { deviceCode: a.data.deviceCode });
    const bearer = { authorization: `Bearer ${tok.data.deviceToken}` };
    const now = Date.now() + clockOffsetMs;
    const records = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ recordId: randomUUID(), kind: "auto_director", startedAt: new Date(now - (8 - i) * 3_600_000).toISOString(), endedAt: new Date(now - (8 - i) * 3_600_000 + 1800_000).toISOString(), seconds: 1800, sessionId: "s", matchRef: null, mapName: null, appVersion: "0.1.0" }));
    expect((await desktop.req<{ accepted: string[] }>("POST", "/v1/device/usage", { records }, bearer)).data.accepted).toHaveLength(7);
    const b = await client.req<{ allowance: { usedSeconds: number; creditSeconds: number; remainingSeconds: number }; credits: { note: string; remainingSeconds: number; expired: boolean }[] }>("GET", `/v1/orgs/${orgId}/billing`);
    expect(b.data.allowance).toMatchObject({ usedSeconds: 12600, creditSeconds: 5400, remainingSeconds: 5400 });
    const byNote = Object.fromEntries(b.data.credits.map((c) => [c.note, c]));
    expect(byNote["expires soon"]!.remainingSeconds).toBe(0);
    expect(byNote["no expiry"]!.remainingSeconds).toBe(5400);
    expect(byNote["already expired"]!.expired).toBe(true);

    const admin = await staff.client.req<{ id: string; usedSeconds: number }[]>("GET", "/v1/admin/orgs?q=quota");
    expect(admin.data.find((o) => o.id === orgId)!.usedSeconds).toBe(12600);
    const health = await new Client(base).req<{ ok: boolean; database: string }>("GET", "/v1/health");
    expect(health.data).toMatchObject({ ok: true, database: "pglite" });
  });
});

function mapToEvent(id: string, type: string, object: Record<string, unknown>) {
  return { id, object: "event", type, data: { object } };
}
