import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CloudApp } from "../src/app.ts";
import { loadCloudConfig } from "../src/config.ts";
import { MIGRATIONS, migrate } from "../src/db/migrations.ts";
import { PgliteSql } from "../src/db/sql.ts";
import { startCloudServer } from "../src/server.ts";
import { Client, freePort } from "./http.ts";

const PASSWORD = "correct horse battery";

interface AdminUser {
  id: string;
  email: string;
  emailVerified: boolean;
  staffRole: "support" | "admin" | null;
  disabled: boolean;
  disabledReason: string | null;
  lastLoginAt: string | null;
  orgCount: number;
  bootstrapAdmin: boolean;
}

describe("website: site info, contact form, account sessions and data export, staff administration", () => {
  let app: CloudApp;
  let close: () => Promise<void>;
  let base: string;

  const lastEmail = async (to: string) => (await app.sql.query<{ subject: string; body_text: string }>("SELECT subject, body_text FROM outbox_emails WHERE to_addr = $1 ORDER BY id DESC LIMIT 1", [to])).rows[0];
  const tokenFrom = (text: string) => /token=([A-Za-z0-9_-]+)/.exec(text)![1]!;

  async function signup(email: string, opts: { verify?: boolean } = {}): Promise<{ client: Client; userId: string; orgId: string }> {
    const client = new Client(base);
    const r = await client.req<{ userId: string; orgId: string }>("POST", "/v1/auth/signup", { email, password: PASSWORD, displayName: email.split("@")[0], orgName: `${email.split("@")[0]} Org` });
    expect(r.status).toBe(201);
    if (opts.verify !== false) expect((await client.req("POST", "/v1/auth/verify-email", { token: tokenFrom((await lastEmail(email))!.body_text) })).status).toBe(200);
    return { client, ...r.data };
  }

  async function login(email: string, password = PASSWORD): Promise<{ client: Client; status: number; error: string }> {
    const client = new Client(base);
    const r = await client.req<{ error: string }>("POST", "/v1/auth/login", { email, password }, { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0" });
    return { client, status: r.status, error: r.data.error };
  }

  beforeAll(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const cfg = loadCloudConfig({ MF_SUPPORT_EMAIL: "help@example.com", MF_COMPANY_NAME: "Example Esports Ltd" }, { publicUrl: base, port, staffEmails: ["admin@example.com"] });
    // Real limits (scale 1): the contact form allows 5 messages per 15 minutes per address.
    app = new CloudApp(cfg, { sql: new PgliteSql(), rateLimitScale: 1 });
    await app.init();
    ({ close } = await startCloudServer(app));
  });

  afterAll(async () => {
    await close?.();
    await app?.close();
  });

  it("site info and the contact form (validation, support email, organisation only for members, rate limit)", async () => {
    const site = await new Client(base).req("GET", "/v1/site");
    expect(site.data).toEqual({ companyName: "Example Esports Ltd", websiteName: "Matchframe", supportEmail: "help@example.com", address: null, jurisdiction: expect.any(String), legalEffectiveDate: "2026-10-27" });

    const anon = new Client(base);
    expect((await anon.req("POST", "/v1/contact", { name: "Sam", email: "sam@example.com", topic: "sales", message: "short" })).status).toBe(400);
    expect((await anon.req("POST", "/v1/contact", { name: "Sam", email: "sam@example.com", topic: "nonsense", message: "a long enough message" })).status).toBe(400);
    const sent = await anon.req("POST", "/v1/contact", { name: "Sam", email: "sam@example.com", topic: "sales", message: "We run a weekly league and want a quote.", orgId: "org_not_mine" });
    expect([sent.status, sent.data]).toEqual([201, { received: true }]);
    const notice = await lastEmail("help@example.com");
    expect(notice?.subject).toBe("[Matchframe contact · sales] Sam");
    expect(notice?.body_text).toContain("sam@example.com");

    const member = await signup("member@example.com");
    expect((await member.client.req("POST", "/v1/contact", { name: "Member", email: "member@example.com", topic: "billing", message: "Question about my invoice please.", orgId: member.orgId })).status).toBe(201);
    const { rows } = await app.sql.query<{ email: string; org_id: string | null; user_id: string | null }>("SELECT email, org_id, user_id FROM contact_messages ORDER BY id");
    expect(rows).toEqual([
      { email: "sam@example.com", org_id: null, user_id: null },
      { email: "member@example.com", org_id: member.orgId, user_id: member.userId },
    ]);
    for (let i = 0; i < 3; i++) expect((await anon.req("POST", "/v1/contact", { name: "Sam", email: "sam@example.com", topic: "other", message: `follow-up number ${i}` })).status).toBe(201);
    const limited = await anon.req<{ error: string }>("POST", "/v1/contact", { name: "Sam", email: "sam@example.com", topic: "other", message: "one message too many" });
    expect([limited.status, limited.data.error]).toEqual([429, "rate_limited"]);
  });

  it("account sessions: list, sign out one browser, sign out the others; data export", async () => {
    const owner = await signup("sessions@example.com");
    const laptop = await login("sessions@example.com");
    const list = await owner.client.req<{ sessions: { id: string; current: boolean; userAgent: string | null; lastSeenAt: string | null }[] }>("GET", "/v1/auth/sessions");
    expect(list.data.sessions).toHaveLength(2);
    expect(list.data.sessions.filter((s) => s.current)).toHaveLength(1);
    const other = list.data.sessions.find((s) => !s.current)!;
    expect(other.userAgent).toContain("Chrome");
    expect(other.id).toMatch(/^[0-9a-f]{24}$/);

    // Session ids are not usable as cookies and only work for their owner.
    const stranger = await signup("stranger@example.com");
    expect((await stranger.client.req("DELETE", `/v1/auth/sessions/${other.id}`)).status).toBe(404);
    expect((await owner.client.req("DELETE", `/v1/auth/sessions/${other.id}`)).status).toBe(200);
    expect((await laptop.client.req("GET", "/v1/auth/me")).status).toBe(401);
    expect((await owner.client.req("DELETE", "/v1/auth/sessions/0123456789abcdef01234567")).status).toBe(404);

    const a = await login("sessions@example.com");
    const b = await login("sessions@example.com");
    expect((await owner.client.req("POST", "/v1/auth/sessions/revoke-others")).data).toEqual({ revoked: 2 });
    expect((await a.client.req("GET", "/v1/auth/me")).status).toBe(401);
    expect((await b.client.req("GET", "/v1/auth/me")).status).toBe(401);
    expect((await owner.client.req("GET", "/v1/auth/me")).status).toBe(200);

    const exp = await owner.client.req<{ account: { email: string }; organisations: { role: string }[]; sessions: unknown[]; activity: { action: string }[] }>("GET", "/v1/auth/export");
    expect(exp.status).toBe(200);
    expect(exp.headers.get("content-disposition")).toMatch(/^attachment; filename="matchframe-account-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(exp.data.account.email).toBe("sessions@example.com");
    expect(exp.data.organisations).toEqual([expect.objectContaining({ role: "owner" })]);
    expect(exp.data.sessions).toHaveLength(1);
    expect(exp.data.activity.map((x) => x.action)).toContain("account.signup");
    expect(JSON.stringify(exp.data)).not.toMatch(/scrypt|password_hash|id_hash/);
  });

  it("staff roles: bootstrap admin, support vs admin permissions, guards for yourself and bootstrap admins", async () => {
    const admin = await signup("admin@example.com");
    const me = await admin.client.req<{ user: { staff: boolean; staffRole: string | null } }>("GET", "/v1/auth/me");
    expect(me.data.user).toMatchObject({ staff: true, staffRole: "admin" });

    const bob = await signup("bob@example.com");
    const carol = await signup("carol@example.com");
    const denied = await bob.client.req<{ error: string }>("GET", "/v1/admin/overview");
    expect([denied.status, denied.data.error]).toEqual([403, "forbidden"]);

    const ov = await admin.client.req<{ users: { total: number; staff: number }; orgs: { total: number; paying: number; byPlan: Record<string, number> }; recentSignups: { email: string }[] }>("GET", "/v1/admin/overview");
    expect(ov.status).toBe(200);
    expect(ov.data.users.staff).toBe(1);
    expect(ov.data.orgs.paying).toBe(0);
    expect(ov.data.orgs.byPlan.free).toBe(ov.data.orgs.total);
    expect(ov.data.recentSignups[0]?.email).toBe("carol@example.com");

    expect((await admin.client.req("PUT", `/v1/admin/users/${bob.userId}/staff-role`, { role: "support" })).data).toEqual({ ok: true, staffRole: "support" });
    expect((await bob.client.req<{ user: { staffRole: string } }>("GET", "/v1/auth/me")).data.user.staffRole).toBe("support");

    // Support: read access and customer help, no admin actions.
    expect((await bob.client.req("GET", "/v1/admin/users")).status).toBe(200);
    expect((await bob.client.req("GET", "/v1/admin/catalog")).status).toBe(200);
    for (const [method, path, body] of [
      ["PUT", `/v1/admin/users/${carol.userId}/staff-role`, { role: "support" }],
      ["POST", `/v1/admin/users/${carol.userId}/disable`, { reason: "testing" }],
      ["PATCH", `/v1/admin/users/${carol.userId}`, { displayName: "C" }],
      ["POST", `/v1/admin/orgs/${carol.orgId}/credits`, { hours: 1, note: "nope" }],
      ["GET", "/v1/admin/stripe-events", undefined],
    ] as const) {
      const r = await bob.client.req<{ error: string; message: string }>(method, path, body);
      expect([r.status, r.data.error, r.data.message], `${method} ${path}`).toEqual([403, "forbidden", "admin staff role required"]);
    }

    expect((await admin.client.req<{ error: string }>("PUT", `/v1/admin/users/${admin.userId}/staff-role`, { role: null })).data.error).toBe("self");
    expect((await admin.client.req("PUT", `/v1/admin/users/${carol.userId}/staff-role`, { role: "admin" })).status).toBe(200);
    const demote = await carol.client.req<{ error: string }>("PUT", `/v1/admin/users/${admin.userId}/staff-role`, { role: null });
    expect([demote.status, demote.data.error]).toEqual([409, "bootstrap_admin"]);
    expect((await carol.client.req<{ error: string }>("POST", `/v1/admin/users/${admin.userId}/disable`, { reason: "takeover" })).data.error).toBe("bootstrap_admin");
    expect((await carol.client.req("PUT", `/v1/admin/users/${bob.userId}/staff-role`, { role: null })).status).toBe(200);
    expect((await bob.client.req("GET", "/v1/admin/users")).status).toBe(403);

    const staffList = await admin.client.req<{ users: AdminUser[]; total: number }>("GET", "/v1/admin/users?filter=staff");
    expect(staffList.data.users.map((u) => [u.email, u.staffRole, u.bootstrapAdmin])).toEqual([
      ["carol@example.com", "admin", false],
      ["admin@example.com", "admin", true],
    ]);
  });

  it("user management: search, verify email, resend, password reset, sign out, disable and enable, edit name and email", async () => {
    const admin = await login("admin@example.com");
    expect(admin.status).toBe(200);
    const dana = await signup("dana@example.com", { verify: false });

    const search = await admin.client.req<{ users: AdminUser[]; total: number; page: number; pageSize: number }>("GET", "/v1/admin/users?q=DANA&filter=unverified&pageSize=10");
    expect(search.data).toMatchObject({ total: 1, page: 1, pageSize: 10 });
    expect(search.data.users[0]).toMatchObject({ id: dana.userId, emailVerified: false, staffRole: null, disabled: false, orgCount: 1, bootstrapAdmin: false });
    const paged = await admin.client.req<{ users: AdminUser[]; total: number }>("GET", "/v1/admin/users?pageSize=2&page=2");
    expect(paged.data.users).toHaveLength(2);
    expect(paged.data.total).toBeGreaterThan(4);

    expect((await admin.client.req("POST", `/v1/admin/users/${dana.userId}/resend-verification`)).data).toEqual({ sent: true });
    expect((await lastEmail("dana@example.com"))?.subject).toMatch(/Confirm/);
    expect((await admin.client.req("POST", `/v1/admin/users/${dana.userId}/verify-email`)).data).toEqual({ ok: true });
    expect((await dana.client.req<{ user: { emailVerified: boolean } }>("GET", "/v1/auth/me")).data.user.emailVerified).toBe(true);
    expect((await admin.client.req("POST", `/v1/admin/users/${dana.userId}/resend-verification`)).data).toEqual({ sent: false, alreadyVerified: true });

    expect((await admin.client.req("POST", `/v1/admin/users/${dana.userId}/password-reset`)).data).toEqual({ sent: true });
    expect((await lastEmail("dana@example.com"))?.subject).toBe("Reset your Matchframe password");

    // Disable: signs out, refuses sign-in (only after a correct password), and blocks reset emails.
    expect((await admin.client.req("POST", `/v1/admin/users/${dana.userId}/disable`, { reason: "x" })).status).toBe(400);
    expect((await admin.client.req("POST", `/v1/admin/users/${dana.userId}/disable`, { reason: "chargeback under review" })).data).toEqual({ ok: true });
    expect((await dana.client.req("GET", "/v1/auth/me")).status).toBe(401);
    expect(await login("dana@example.com").then((r) => [r.status, r.error])).toEqual([403, "account_disabled"]);
    expect(await login("dana@example.com", "wrong password!!").then((r) => [r.status, r.error])).toEqual([401, "invalid_credentials"]);
    expect((await admin.client.req<{ error: string }>("POST", `/v1/admin/users/${dana.userId}/password-reset`)).data.error).toBe("account_disabled");
    const disabled = await admin.client.req<{ users: AdminUser[] }>("GET", "/v1/admin/users?filter=disabled");
    expect(disabled.data.users.map((u) => [u.email, u.disabledReason])).toEqual([["dana@example.com", "chargeback under review"]]);
    expect((await admin.client.req("POST", `/v1/admin/users/${dana.userId}/enable`)).data).toEqual({ ok: true });
    const back = await login("dana@example.com");
    expect(back.status).toBe(200);

    expect((await admin.client.req("POST", `/v1/admin/users/${dana.userId}/sign-out`)).data).toEqual({ revoked: 1, computers: 0 });
    expect((await back.client.req("GET", "/v1/auth/me")).status).toBe(401);

    // Edit: name, then email (unverified again, verification to the new address, notice to the old one).
    expect((await admin.client.req<{ error: string }>("PATCH", `/v1/admin/users/${dana.userId}`, { email: "bob@example.com" })).data.error).toBe("email_taken");
    expect((await admin.client.req("PATCH", `/v1/admin/users/${dana.userId}`, { displayName: "Dana Lee", email: "dana.lee@example.com" })).data).toEqual({ ok: true });
    expect((await lastEmail("dana.lee@example.com"))?.subject).toMatch(/Confirm/);
    expect((await lastEmail("dana@example.com"))?.subject).toBe("Your Matchframe email address was changed");
    const adminId = (await app.sql.query<{ id: string }>("SELECT id FROM users WHERE email = 'admin@example.com'")).rows[0]!.id;
    expect((await admin.client.req<{ error: string }>("PATCH", `/v1/admin/users/${adminId}`, { email: "elsewhere@example.com" })).data.error).toBe("self");

    const detail = await admin.client.req<{ user: AdminUser & { displayName: string }; memberships: { orgName: string; role: string; planName: string }[]; sessions: unknown[]; audit: { action: string }[] }>("GET", `/v1/admin/users/${dana.userId}`);
    expect(detail.data.user).toMatchObject({ email: "dana.lee@example.com", displayName: "Dana Lee", emailVerified: false, disabled: false });
    expect(detail.data.user.lastLoginAt).not.toBeNull();
    expect(detail.data.memberships).toEqual([{ orgId: dana.orgId, orgName: "dana Org", role: "owner", planName: "Free" }]);
    expect(detail.data.sessions).toEqual([]);
    expect(detail.data.audit.map((a) => a.action)).toEqual(expect.arrayContaining(["admin.user_email_verified", "admin.user_disabled", "admin.user_enabled", "admin.user_signed_out", "admin.user_edited", "account.signup"]));
    expect((await admin.client.req("GET", "/v1/admin/users/usr_missing")).status).toBe(404);
  });

  it("organisation detail, support inbox and email log", async () => {
    const admin = await login("admin@example.com");
    const { rows } = await app.sql.query<{ org_id: string }>("SELECT m.org_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = 'member@example.com'");
    const orgId = rows[0]!.org_id;
    expect((await admin.client.req("POST", `/v1/admin/orgs/${orgId}/credits`, { hours: 2, note: "welcome credit" })).status).toBe(200);
    const org = await admin.client.req<{ org: { name: string }; plan: { id: string }; subscription: { status: string }; allowance: { creditSeconds: number }; members: { email: string; role: string }[]; devices: unknown[]; credits: { seconds: number; remainingSeconds: number; source: string; note: string }[] }>("GET", `/v1/admin/orgs/${orgId}`);
    expect(org.data).toMatchObject({ org: { name: "member Org" }, plan: { id: "free" }, subscription: { status: "none" }, allowance: { creditSeconds: 7200 }, devices: [] });
    expect(org.data.members).toEqual([{ userId: expect.any(String), email: "member@example.com", displayName: "member", role: "owner" }]);
    expect(org.data.credits).toEqual([expect.objectContaining({ seconds: 7200, remainingSeconds: 7200, source: "grant", note: "welcome credit" })]);
    expect((await admin.client.req("GET", "/v1/admin/orgs/org_missing")).status).toBe(404);

    const open = await admin.client.req<{ messages: { id: string; email: string; topic: string; handledAt: string | null }[] }>("GET", "/v1/admin/messages");
    expect(open.data.messages).toHaveLength(5);
    const first = open.data.messages.find((m) => m.topic === "billing")!;
    expect((await admin.client.req("POST", `/v1/admin/messages/${first.id}/handled`, { handled: true })).data).toEqual({ ok: true });
    const handled = await admin.client.req<{ messages: { id: string; handledBy: string | null }[] }>("GET", "/v1/admin/messages?status=handled");
    expect(handled.data.messages).toEqual([expect.objectContaining({ id: first.id, handledBy: "admin@example.com" })]);
    expect((await admin.client.req<{ messages: unknown[] }>("GET", "/v1/admin/messages")).data.messages).toHaveLength(4);
    expect((await admin.client.req("POST", `/v1/admin/messages/${first.id}/handled`, { handled: false })).status).toBe(200);
    expect((await admin.client.req<{ messages: unknown[] }>("GET", "/v1/admin/messages?status=all")).data.messages).toHaveLength(5);
    expect((await admin.client.req("POST", "/v1/admin/messages/999999/handled", { handled: true })).status).toBe(404);

    const emails = await admin.client.req<{ emails: { id: string; to: string; subject: string; sentAt: string | null; error: string | null }[]; delivery: string }>("GET", "/v1/admin/emails?limit=5");
    expect(emails.data.emails).toHaveLength(5);
    expect(emails.data.delivery).toBe("outbox");
    expect(Object.keys(emails.data.emails[0]!).sort()).toEqual(["createdAt", "error", "id", "sentAt", "subject", "to"]);
    // Without SMTP an email cannot be delivered again; it stays in the outbox.
    const resend = await admin.client.req<{ sent: boolean; error: string }>("POST", `/v1/admin/emails/${emails.data.emails[0]!.id}/resend`);
    expect(resend.data.sent).toBe(false);
    expect(resend.data.error).toMatch(/SMTP_URL/);
    expect((await admin.client.req("POST", "/v1/admin/emails/424242/resend")).status).toBe(404);
  });

  it("clearing lockouts: sign-in attempts, the computer limit, this period's usage; subscription overrides", async () => {
    const admin = await login("admin@example.com");
    const erin = await signup("erin@example.com");
    const support = await signup("frank@example.com");
    expect((await admin.client.req("PUT", `/v1/admin/users/${support.userId}/staff-role`, { role: "support" })).status).toBe(200);
    const program = () => new Client(base, null);
    const deviceLogin = (installId: string) =>
      program().req<{ deviceToken: string; deviceId: string; error: string }>("POST", "/v1/device/login", { email: "erin@example.com", password: PASSWORD, deviceName: `PC ${installId}`, platform: "win32", appVersion: "0.3.0", installId });
    type OrgDetail = {
      plan: { id: string };
      subscription: { status: string; override: { planId: string; status: string; note: string; createdBy: string } | null; stripe: { planId: string; status: string } | null };
      limits: { maxDevices: number };
      allowance: { usedSeconds: number; remainingSeconds: number; creditSeconds: number };
      usageResets: { seconds: number; note: string; createdBy: string }[];
      devices: { id: string; revokedAt: string | null }[];
    };
    const orgDetail = async () => (await admin.client.req<OrgDetail>("GET", `/v1/admin/orgs/${erin.orgId}`)).data;

    // Sign-in lockout: wrong passwords until the website refuses with 429; staff see it and clear it.
    let refused = 0;
    for (let i = 0; i < 25 && !refused; i++) if ((await login("erin@example.com", "wrong password!!")).status === 429) refused = i + 1;
    expect(refused).toBeGreaterThan(0);
    expect((await login("erin@example.com")).status).toBe(429);
    const locked = await support.client.req<{ lockouts: { label: string; until: string }[] }>("GET", `/v1/admin/users/${erin.userId}`);
    expect(locked.data.lockouts.length).toBeGreaterThan(0);
    expect(locked.data.lockouts.map((l) => l.label).join()).toMatch(/Sign-in attempts/);
    expect((await erin.client.req("POST", `/v1/admin/users/${erin.userId}/clear-lockout`)).status).toBe(403);
    const cleared = await support.client.req<{ cleared: number }>("POST", `/v1/admin/users/${erin.userId}/clear-lockout`);
    expect(cleared.data.cleared).toBe(locked.data.lockouts.length);
    expect((await login("erin@example.com")).status).toBe(200);
    expect((await admin.client.req<{ lockouts: unknown[] }>("GET", `/v1/admin/users/${erin.userId}`)).data.lockouts).toEqual([]);

    // Computer limit (Free: 1): staff sign one or all of the organisation's computers out.
    const first = await deviceLogin("install-erin-aaaaa");
    expect(first.status).toBe(200);
    expect(await deviceLogin("install-erin-bbbbb").then((r) => [r.status, r.data.error])).toEqual([409, "device_limit"]);
    expect((await orgDetail()).limits.maxDevices).toBe(1);
    expect((await support.client.req("POST", `/v1/admin/orgs/${erin.orgId}/devices/${first.data.deviceId}/sign-out`)).data).toEqual({ computers: 1 });
    expect((await support.client.req("POST", `/v1/admin/orgs/${erin.orgId}/devices/${first.data.deviceId}/sign-out`)).status).toBe(404);
    const second = await deviceLogin("install-erin-bbbbb");
    expect(second.status).toBe(200);
    expect((await support.client.req("POST", `/v1/admin/orgs/${erin.orgId}/devices/sign-out-all`)).data).toEqual({ computers: 1 });
    expect((await program().req("POST", "/v1/device/entitlement", undefined, { authorization: `Bearer ${second.data.deviceToken}` })).status).toBe(401);
    const pc = await deviceLogin("install-erin-ccccc");
    const bearer = { authorization: `Bearer ${pc.data.deviceToken}` };

    // Usage reset: the period starts again from zero; credits already spent don't count twice.
    expect((await admin.client.req("POST", `/v1/admin/orgs/${erin.orgId}/credits`, { hours: 1, note: "support credit" })).status).toBe(200);
    const now = Date.now();
    const rec = (minutesAgo: number, seconds: number) => ({ recordId: randomUUID(), kind: "auto_director", startedAt: new Date(now - minutesAgo * 60_000).toISOString(), endedAt: new Date(now - minutesAgo * 60_000 + seconds * 1000).toISOString(), seconds, sessionId: "s", matchRef: null, mapName: "de_nuke", appVersion: "0.3.0" });
    const upload = async (records: ReturnType<typeof rec>[]) => expect((await program().req<{ accepted: string[] }>("POST", "/v1/device/usage", { records }, bearer)).data.accepted).toHaveLength(records.length);
    await upload([rec(300, 3000), rec(240, 3000), rec(180, 3000)]);
    // 2 h included + 1 h credit; 2.5 h used: half an hour comes from the credit.
    expect((await orgDetail()).allowance).toMatchObject({ usedSeconds: 9000, creditSeconds: 1800, remainingSeconds: 1800 });
    expect((await support.client.req("POST", `/v1/admin/orgs/${erin.orgId}/usage-reset`, { note: "outage refund" })).status).toBe(403);
    expect((await admin.client.req("POST", `/v1/admin/orgs/${erin.orgId}/usage-reset`, { note: "x" })).status).toBe(400);
    expect((await admin.client.req("POST", `/v1/admin/orgs/${erin.orgId}/usage-reset`, { note: "outage refund" })).data).toEqual({ seconds: 9000 });
    const reset = await orgDetail();
    expect(reset.allowance).toMatchObject({ usedSeconds: 0, creditSeconds: 1800, remainingSeconds: 9000 });
    expect(reset.usageResets).toEqual([expect.objectContaining({ seconds: 9000, note: "outage refund", createdBy: "admin@example.com" })]);
    expect((await program().req<{ payload: { autoDirector: { remainingSeconds: number } } }>("POST", "/v1/device/entitlement", undefined, bearer)).data.payload.autoDirector.remainingSeconds).toBe(9000);
    await upload([rec(120, 3000), rec(60, 3000), rec(30, 1800)]);
    // 2 h 10 min after the reset: 10 minutes from the credit, which had 30 minutes left.
    expect((await orgDetail()).allowance).toMatchObject({ usedSeconds: 7800, creditSeconds: 1200, remainingSeconds: 1200 });
    expect((await admin.client.req<{ error: string }>("POST", `/v1/admin/orgs/${support.orgId}/usage-reset`, { note: "nothing used" })).data.error).toBe("nothing_to_reset");

    // Subscription override: wins over Stripe until removed, for the website and the program.
    expect((await support.client.req("PUT", `/v1/admin/orgs/${erin.orgId}/subscription-override`, { status: "active", planId: "pro", note: "partner league" })).status).toBe(403);
    expect((await admin.client.req<{ error: string }>("PUT", `/v1/admin/orgs/${erin.orgId}/subscription-override`, { status: "active", note: "partner league" })).data.error).toBe("plan_required");
    expect((await admin.client.req<{ error: string }>("PUT", `/v1/admin/orgs/${erin.orgId}/subscription-override`, { status: "active", planId: "platinum", note: "partner league" })).data.error).toBe("unknown_plan");
    expect((await admin.client.req("PUT", `/v1/admin/orgs/${erin.orgId}/subscription-override`, { status: "active", planId: "pro", note: "partner league" })).data).toEqual({ planId: "pro", status: "active" });
    let o = await orgDetail();
    expect(o).toMatchObject({ plan: { id: "pro" }, subscription: { status: "active", override: { planId: "pro", status: "active", note: "partner league", createdBy: "admin@example.com" }, stripe: null }, limits: { maxDevices: 2 } });
    expect((await deviceLogin("install-erin-ddddd")).status).toBe(200);
    expect((await erin.client.req<{ subscription: { status: string }; plan: { id: string } }>("GET", `/v1/orgs/${erin.orgId}/billing`)).data).toMatchObject({ plan: { id: "pro" }, subscription: { status: "active" } });
    expect((await program().req<{ payload: { plan: { id: string }; subscriptionStatus: string } }>("POST", "/v1/device/entitlement", undefined, bearer)).data.payload).toMatchObject({ plan: { id: "pro" }, subscriptionStatus: "active" });
    const listed = await admin.client.req<{ id: string; overridden: boolean }[]>("GET", "/v1/admin/orgs?q=erin");
    expect(listed.data.find((x) => x.id === erin.orgId)?.overridden).toBe(true);
    // Stripe reports a cancelled subscription meanwhile: recorded, but the override still applies.
    await app.sql.query("INSERT INTO subscriptions (org_id, stripe_subscription_id, plan_id, status) VALUES ($1, 'sub_erin', 'studio', 'canceled')", [erin.orgId]);
    o = await orgDetail();
    expect(o).toMatchObject({ plan: { id: "pro" }, subscription: { status: "active", stripe: { planId: "studio", status: "canceled" } } });
    // Overriding to a status without access gives the free plan.
    expect((await admin.client.req("PUT", `/v1/admin/orgs/${erin.orgId}/subscription-override`, { status: "unpaid", planId: "studio", note: "chargeback" })).data).toEqual({ planId: "free", status: "unpaid" });
    expect((await orgDetail())).toMatchObject({ plan: { id: "free" }, subscription: { status: "unpaid" } });
    expect((await admin.client.req("DELETE", `/v1/admin/orgs/${erin.orgId}/subscription-override`)).data).toEqual({ planId: "free", status: "canceled" });
    expect((await orgDetail()).subscription).toMatchObject({ status: "canceled", override: null, stripe: { planId: "studio", status: "canceled" } });
    expect((await admin.client.req("DELETE", `/v1/admin/orgs/${erin.orgId}/subscription-override`)).status).toBe(404);

    const actions = (await admin.client.req<{ action: string }[]>("GET", `/v1/admin/audit?orgId=${erin.orgId}`)).data.map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["admin.device_signed_out", "admin.devices_signed_out", "admin.usage_reset", "admin.subscription_override_set", "admin.subscription_override_removed"]));
  });
});

describe("migration 4: staff flag becomes the admin staff role", () => {
  it("keeps existing staff as admins", async () => {
    const sql = new PgliteSql();
    await sql.query("CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const m of MIGRATIONS.filter((x) => x.version <= 3)) {
      for (const stmt of m.sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) await sql.query(stmt);
      await sql.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [m.version, m.name]);
    }
    await sql.query("INSERT INTO users (id, email, display_name, password_hash, staff) VALUES ('usr_a', 'a@example.com', 'A', 'x', true), ('usr_b', 'b@example.com', 'B', 'x', false)");
    expect(await migrate(sql)).toEqual({ from: 3, to: MIGRATIONS[MIGRATIONS.length - 1]!.version });
    const { rows } = await sql.query<{ id: string; staff_role: string | null; disabled_at: Date | null }>("SELECT id, staff_role, disabled_at FROM users ORDER BY id");
    expect(rows).toEqual([
      { id: "usr_a", staff_role: "admin", disabled_at: null },
      { id: "usr_b", staff_role: null, disabled_at: null },
    ]);
    await sql.close();
  });
});
