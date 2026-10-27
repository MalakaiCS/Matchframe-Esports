import { z } from "zod";
import { Email, HourPack, Plan, StaffRole, SubscriptionStatus } from "@matchframe/cloud-contracts";
import type { CloudApp, SessionUser } from "../app.ts";
import { audit } from "../domain/audit.ts";
import { calendarMonth, computeAllowance, isPaidStatus, orgPlanState, resetPeriodUsage, usageResetsFor } from "../domain/allowance.ts";
import { revokeComputersOf } from "../domain/devices.ts";
import { getPlan, listHourPacks, listPlans, upsertHourPack, upsertPlan } from "../domain/plans.ts";
import type { Router } from "../http/router.ts";
import { HttpError } from "../http/router.ts";
import { newId } from "../ids.ts";
import { sendPasswordReset, sendVerification, sessionsFor, sessionView } from "./auth.ts";

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  email_verified_at: Date | null;
  staff_role: StaffRole | null;
  disabled_at: Date | null;
  disabled_reason: string | null;
  created_at: Date;
  last_login_at: Date | null;
  org_count: string;
}

const USER_COLUMNS = "u.id, u.email, u.display_name, u.email_verified_at, u.staff_role, u.disabled_at, u.disabled_reason, u.created_at, u.last_login_at, (SELECT count(*) FROM memberships m WHERE m.user_id = u.id) AS org_count";

const UserFilter = z.enum(["all", "unverified", "staff", "disabled"]);
const MessageStatus = z.enum(["open", "handled", "all"]);

/**
 * Matchframe staff administration. Staff roles: support (customer help: view accounts and
 * organisations, verify emails, send reset links, sign users out, clear sign-in lockouts, sign an
 * organisation's computers out, support inbox) and admin (additionally staff roles, disabling
 * accounts, editing users, hour grants, usage resets, subscription overrides, the catalogue,
 * Stripe events and resending emails). MF_STAFF_EMAILS are bootstrap admins that cannot be demoted.
 */
export function registerAdminRoutes(r: Router, app: CloudApp): void {
  const adminUser = (u: UserRow) => ({
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    emailVerified: !!u.email_verified_at,
    staffRole: u.staff_role,
    disabled: !!u.disabled_at,
    disabledReason: u.disabled_reason,
    createdAt: u.created_at.toISOString(),
    lastLoginAt: u.last_login_at?.toISOString() ?? null,
    orgCount: Number(u.org_count),
    bootstrapAdmin: app.isBootstrapAdmin(u.email),
  });

  const loadUser = async (id: string): Promise<UserRow> => {
    const { rows } = await app.sql.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = $1`, [id]);
    if (!rows[0]) throw new HttpError(404, "not_found", "user not found");
    return rows[0];
  };

  /** Changes to another person's role or access: never your own account, never a bootstrap admin. */
  const guardTarget = (staff: SessionUser, target: UserRow, what: string) => {
    if (target.id === staff.id) throw new HttpError(409, "self", `you cannot ${what} your own account; ask another admin`);
    if (app.isBootstrapAdmin(target.email)) throw new HttpError(409, "bootstrap_admin", `this account is a bootstrap admin (MF_STAFF_EMAILS on the server); you cannot ${what} it from the website`);
  };

  /**
   * Rate-limit counters that can lock this account out: sign-in attempts (by email, and from the
   * addresses its browsers signed in from), and the emails and approvals it can trigger. They are
   * per website instance and in memory.
   */
  const lockoutCounters = async (u: UserRow) => {
    const ips = (await app.sql.query<{ ip: string }>("SELECT DISTINCT ip FROM sessions WHERE user_id = $1 AND ip IS NOT NULL AND ip <> '' LIMIT 20", [u.id])).rows.map((x) => x.ip);
    const { auth, email, deviceLink } = app.limits;
    return [
      { limiter: auth, key: `login-email:${u.email}`, label: "Sign-in attempts with this email address" },
      ...ips.flatMap((ip) => [
        { limiter: auth, key: `login:${ip}`, label: `Sign-in attempts from ${ip}` },
        { limiter: auth, key: `device-login:${ip}`, label: `Program sign-in attempts from ${ip}` },
        { limiter: email, key: `reset:${ip}`, label: `Password reset requests from ${ip}` },
      ]),
      { limiter: email, key: `verify:${u.id}`, label: "Verification emails" },
      { limiter: email, key: `email-change:${u.id}`, label: "Email change confirmations" },
      { limiter: email, key: `invite:${u.id}`, label: "Invitations sent" },
      { limiter: email, key: `admin-reset:${u.id}`, label: "Password reset links sent by staff" },
      { limiter: deviceLink, key: `approve:${u.id}`, label: "Computer link approvals" },
    ];
  };
  const activeLockouts = async (u: UserRow) => {
    const out: { label: string; until: string }[] = [];
    for (const c of await lockoutCounters(u)) {
      const until = c.limiter.blockedUntil(c.key);
      if (until !== null) out.push({ label: c.label, until: new Date(until).toISOString() });
    }
    return out;
  };

  r.add("GET", "/v1/admin/overview", { summary: "Staff: headline numbers (accounts, organisations, computers, usage, revenue) and recent sign-ups" }, async (ctx) => {
    await app.requireStaff(ctx);
    const now = app.now();
    const users = (
      await app.sql.query<{ total: string; verified: string; staff: string; disabled: string; recent: string }>(
        `SELECT count(*) AS total,
                count(*) FILTER (WHERE email_verified_at IS NOT NULL) AS verified,
                count(*) FILTER (WHERE staff_role IS NOT NULL) AS staff,
                count(*) FILTER (WHERE disabled_at IS NOT NULL) AS disabled,
                count(*) FILTER (WHERE created_at >= $1) AS recent
           FROM users`,
        [new Date(now.getTime() - 30 * 86_400_000)],
      )
    ).rows[0]!;
    const orgTotal = Number((await app.sql.query<{ n: string }>("SELECT count(*) AS n FROM orgs")).rows[0]!.n);
    // Plan access follows the subscription state (see orgPlanState); revenue counts active and past-due subscriptions.
    const subs = (await app.sql.query<{ plan_id: string; status: string; n: string }>("SELECT plan_id, status, count(*) AS n FROM subscriptions WHERE status IN ('active', 'trialing', 'past_due') GROUP BY plan_id, status")).rows;
    const plans = new Map((await listPlans(app.sql)).map((p) => [p.id, p]));
    const byPlan: Record<string, number> = {};
    let onPaidPlans = 0;
    let paying = 0;
    let mrrCents = 0;
    let currency: string | null = null;
    for (const s of subs) {
      const n = Number(s.n);
      byPlan[s.plan_id] = (byPlan[s.plan_id] ?? 0) + n;
      onPaidPlans += n;
      if (s.status === "trialing") continue;
      paying += n;
      const plan = plans.get(s.plan_id);
      mrrCents += (plan?.priceMonthlyCents ?? 0) * n;
      currency ??= plan?.currency ?? null;
    }
    byPlan.free = (byPlan.free ?? 0) + Math.max(0, orgTotal - onPaidPlans);
    const linked = Number((await app.sql.query<{ n: string }>("SELECT count(*) AS n FROM devices WHERE revoked_at IS NULL")).rows[0]!.n);
    const month = calendarMonth(now);
    const usage = Number((await app.sql.query<{ s: string | null }>("SELECT sum(seconds) AS s FROM usage_records WHERE started_at >= $1 AND started_at < $2", [month.start, month.end])).rows[0]?.s ?? 0);
    const recent = await app.sql.query<{ id: string; email: string; display_name: string; created_at: Date; email_verified_at: Date | null }>("SELECT id, email, display_name, created_at, email_verified_at FROM users ORDER BY created_at DESC LIMIT 8");
    return {
      users: { total: Number(users.total), verified: Number(users.verified), staff: Number(users.staff), disabled: Number(users.disabled), newLast30Days: Number(users.recent) },
      orgs: { total: orgTotal, paying, byPlan },
      devices: { linked },
      usage: { secondsThisMonth: usage },
      revenue: { mrrCents, currency: currency ?? plans.get("pro")?.currency ?? "usd" },
      recentSignups: recent.rows.map((u) => ({ id: u.id, email: u.email, displayName: u.display_name, createdAt: u.created_at.toISOString(), emailVerified: !!u.email_verified_at })),
    };
  });

  // ---------------------------------------------------------------- users

  r.add("GET", "/v1/admin/users", { summary: "Staff: search accounts (q = email, name or id; filter = all | unverified | staff | disabled)" }, async (ctx) => {
    await app.requireStaff(ctx);
    const q = (ctx.query.get("q") ?? "").trim().toLowerCase().slice(0, 200);
    const filter = UserFilter.catch("all").parse(ctx.query.get("filter") ?? "all");
    const page = Math.max(1, Math.floor(Number(ctx.query.get("page")) || 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(Number(ctx.query.get("pageSize")) || 25)));
    const where = [
      "($1 = '' OR lower(u.email) LIKE '%' || $1 || '%' OR lower(u.display_name) LIKE '%' || $1 || '%' OR u.id = $1)",
      { all: "true", unverified: "u.email_verified_at IS NULL", staff: "u.staff_role IS NOT NULL", disabled: "u.disabled_at IS NOT NULL" }[filter],
    ].join(" AND ");
    const total = Number((await app.sql.query<{ n: string }>(`SELECT count(*) AS n FROM users u WHERE ${where}`, [q])).rows[0]!.n);
    const { rows } = await app.sql.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users u WHERE ${where} ORDER BY u.created_at DESC, u.id LIMIT $2 OFFSET $3`, [q, pageSize, (page - 1) * pageSize]);
    return { users: rows.map(adminUser), total, page, pageSize };
  });

  r.add("GET", "/v1/admin/users/:userId", { summary: "Staff: one account with organisations, signed-in browsers and recent activity" }, async (ctx) => {
    await app.requireStaff(ctx);
    const u = await loadUser(ctx.params.userId!);
    const m = await app.sql.query<{ org_id: string; name: string; role: string }>("SELECT m.org_id, o.name, m.role FROM memberships m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = $1 ORDER BY m.created_at", [u.id]);
    const memberships = [];
    for (const row of m.rows) memberships.push({ orgId: row.org_id, orgName: row.name, role: row.role, planName: (await orgPlanState(app.sql, row.org_id, app.now())).plan.name });
    const a = await app.sql.query<{ at: Date; action: string; org_id: string | null; detail: unknown }>("SELECT at, action, org_id, detail FROM audit_log WHERE actor = $1 OR detail->>'targetUserId' = $1 ORDER BY id DESC LIMIT 100", [u.id]);
    return {
      user: adminUser(u),
      memberships,
      sessions: (await sessionsFor(app, u.id)).map(sessionView),
      lockouts: await activeLockouts(u),
      audit: a.rows.map((e) => ({ at: e.at.toISOString(), action: e.action, orgId: e.org_id, detail: e.detail })),
    };
  });

  r.add("POST", "/v1/admin/users/:userId/verify-email", { summary: "Staff: mark an account's email address as verified" }, async (ctx) => {
    const staff = await app.requireStaff(ctx);
    const u = await loadUser(ctx.params.userId!);
    await app.sql.query("UPDATE users SET email_verified_at = COALESCE(email_verified_at, $2) WHERE id = $1", [u.id, app.now()]);
    await audit(app.sql, staff.id, null, "admin.user_email_verified", { targetUserId: u.id, email: u.email });
    return { ok: true };
  });

  r.add("POST", "/v1/admin/users/:userId/resend-verification", { summary: "Staff: send an account's verification email again" }, async (ctx) => {
    const staff = await app.requireStaff(ctx);
    const u = await loadUser(ctx.params.userId!);
    if (u.email_verified_at) return { sent: false, alreadyVerified: true };
    app.rateLimit(app.limits.email, `verify:${u.id}`);
    await sendVerification(app, u.id, u.email);
    await audit(app.sql, staff.id, null, "admin.user_verification_sent", { targetUserId: u.id, email: u.email });
    return { sent: true };
  });

  r.add("POST", "/v1/admin/users/:userId/password-reset", { summary: "Staff: email a password reset link to an account" }, async (ctx) => {
    const staff = await app.requireStaff(ctx);
    const u = await loadUser(ctx.params.userId!);
    if (u.disabled_at) throw new HttpError(409, "account_disabled", "this account is disabled; enable it first");
    app.rateLimit(app.limits.email, `admin-reset:${u.id}`);
    await sendPasswordReset(app, u.id, u.email);
    await audit(app.sql, staff.id, null, "admin.user_password_reset_sent", { targetUserId: u.id, email: u.email });
    return { sent: true };
  });

  r.add("POST", "/v1/admin/users/:userId/sign-out", { summary: "Staff: sign an account out of every browser and computer" }, async (ctx) => {
    const staff = await app.requireStaff(ctx);
    const u = await loadUser(ctx.params.userId!);
    const { rows } = await app.sql.query<{ id_hash: string }>("DELETE FROM sessions WHERE user_id = $1 RETURNING id_hash", [u.id]);
    const computers = await revokeComputersOf(app.sql, u.id, app.now());
    await audit(app.sql, staff.id, null, "admin.user_signed_out", { targetUserId: u.id, email: u.email, revoked: rows.length, computers });
    return { revoked: rows.length, computers };
  });

  r.add("POST", "/v1/admin/users/:userId/clear-lockout", { summary: "Staff: clear an account's sign-in and email lockouts (too many attempts) so it can try again straight away" }, async (ctx) => {
    const staff = await app.requireStaff(ctx);
    const u = await loadUser(ctx.params.userId!);
    const cleared: string[] = [];
    for (const c of await lockoutCounters(u)) if (c.limiter.clear(c.key)) cleared.push(c.label);
    await audit(app.sql, staff.id, null, "admin.user_lockout_cleared", { targetUserId: u.id, email: u.email, cleared });
    return { cleared: cleared.length };
  });

  r.add("PUT", "/v1/admin/users/:userId/staff-role", { body: z.object({ role: StaffRole.nullable() }), summary: "Admin: set an account's staff role (support, admin or none)" }, async (ctx) => {
    const staff = await app.requireStaff(ctx, "admin");
    const u = await loadUser(ctx.params.userId!);
    guardTarget(staff, u, "change the staff role of");
    if (ctx.body.role && u.disabled_at) throw new HttpError(409, "account_disabled", "this account is disabled; enable it first");
    await app.sql.query("UPDATE users SET staff_role = $2 WHERE id = $1", [u.id, ctx.body.role]);
    await audit(app.sql, staff.id, null, "admin.user_staff_role", { targetUserId: u.id, email: u.email, from: u.staff_role, to: ctx.body.role });
    return { ok: true, staffRole: ctx.body.role };
  });

  r.add("POST", "/v1/admin/users/:userId/disable", { body: z.object({ reason: z.string().trim().min(3).max(300) }), summary: "Admin: disable an account (signs it out of browsers and computers; it cannot sign in until enabled)" }, async (ctx) => {
    const staff = await app.requireStaff(ctx, "admin");
    const u = await loadUser(ctx.params.userId!);
    guardTarget(staff, u, "disable");
    await app.sql.transaction(async (tx) => {
      await tx.query("UPDATE users SET disabled_at = COALESCE(disabled_at, $2), disabled_reason = $3 WHERE id = $1", [u.id, app.now(), ctx.body.reason]);
      await tx.query("DELETE FROM sessions WHERE user_id = $1", [u.id]);
      const computers = await revokeComputersOf(tx, u.id, app.now());
      await audit(tx, staff.id, null, "admin.user_disabled", { targetUserId: u.id, email: u.email, reason: ctx.body.reason, computersSignedOut: computers });
    });
    return { ok: true };
  });

  r.add("POST", "/v1/admin/users/:userId/enable", { summary: "Admin: enable a disabled account" }, async (ctx) => {
    const staff = await app.requireStaff(ctx, "admin");
    const u = await loadUser(ctx.params.userId!);
    guardTarget(staff, u, "enable");
    await app.sql.query("UPDATE users SET disabled_at = NULL, disabled_reason = NULL WHERE id = $1", [u.id]);
    await audit(app.sql, staff.id, null, "admin.user_enabled", { targetUserId: u.id, email: u.email });
    return { ok: true };
  });

  r.add("PATCH", "/v1/admin/users/:userId", { body: z.object({ displayName: z.string().trim().min(1).max(80).optional(), email: Email.optional() }), summary: "Admin: edit an account's name or email (a new email must be verified again)" }, async (ctx) => {
    const staff = await app.requireStaff(ctx, "admin");
    const u = await loadUser(ctx.params.userId!);
    const { displayName, email } = ctx.body;
    const emailChanged = email !== undefined && email !== u.email;
    if (emailChanged) {
      if (u.id === staff.id) throw new HttpError(409, "self", "change your own email address from your account page");
      if (app.isBootstrapAdmin(u.email)) throw new HttpError(409, "bootstrap_admin", "a bootstrap admin's email address is set in MF_STAFF_EMAILS on the server; it cannot be changed from the website");
      if ((await app.sql.query("SELECT 1 FROM users WHERE email = $1", [email])).rows[0]) throw new HttpError(409, "email_taken", "another account already uses this email address");
    }
    try {
      await app.sql.query(
        `UPDATE users SET display_name = COALESCE($2, display_name)${emailChanged ? ", email = $3, email_verified_at = NULL" : ""} WHERE id = $1`,
        emailChanged ? [u.id, displayName ?? null, email] : [u.id, displayName ?? null],
      );
    } catch (e) {
      if (String(e).includes("duplicate key") || String(e).includes("users_email_key")) throw new HttpError(409, "email_taken", "another account already uses this email address");
      throw e;
    }
    if (emailChanged) {
      await sendVerification(app, u.id, email);
      await app.mailer.send({
        to: u.email,
        subject: "Your Matchframe email address was changed",
        text: `Matchframe support changed the sign-in email of your account to ${email}. If you did not ask for this, reply to this email or contact support.`,
      });
    }
    await audit(app.sql, staff.id, null, "admin.user_edited", { targetUserId: u.id, ...(displayName !== undefined ? { displayName } : {}), ...(emailChanged ? { fromEmail: u.email, toEmail: email } : {}) });
    return { ok: true };
  });

  // ---------------------------------------------------------------- organisations

  r.add("GET", "/v1/admin/orgs", { summary: "Staff: organisations with plan, status, members, computers and this period's usage" }, async (ctx) => {
    await app.requireStaff(ctx);
    const q = (ctx.query.get("q") ?? "").trim().toLowerCase();
    const { rows } = await app.sql.query<{ id: string; name: string; created_at: Date; members: string; devices: string; owner_email: string | null }>(
      `SELECT o.id, o.name, o.created_at,
              (SELECT count(*) FROM memberships m WHERE m.org_id = o.id) AS members,
              (SELECT count(*) FROM devices d WHERE d.org_id = o.id AND d.revoked_at IS NULL) AS devices,
              (SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = o.id AND m.role = 'owner' ORDER BY m.created_at LIMIT 1) AS owner_email
         FROM orgs o
        WHERE $1 = '' OR lower(o.name) LIKE '%' || $1 || '%' OR o.id = $1
           OR EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = o.id AND lower(u.email) LIKE '%' || $1 || '%')
        ORDER BY o.created_at DESC LIMIT 200`,
      [q],
    );
    const out = [];
    for (const o of rows) {
      const { planState, ...a } = await computeAllowance(app.sql, o.id, app.now());
      out.push({ id: o.id, name: o.name, createdAt: o.created_at.toISOString(), ownerEmail: o.owner_email, members: Number(o.members), devices: Number(o.devices), planId: planState.plan.id, subscriptionStatus: planState.subscriptionStatus, overridden: planState.override !== null, usedSeconds: a.usedSeconds, remainingSeconds: a.remainingSeconds });
    }
    return out;
  });

  r.add("GET", "/v1/admin/orgs/:orgId", { summary: "Staff: one organisation with subscription, allowance, members, computers and hour credits" }, async (ctx) => {
    await app.requireStaff(ctx);
    const id = ctx.params.orgId!;
    const o = (await app.sql.query<{ id: string; name: string; created_at: Date; stripe_customer_id: string | null }>("SELECT id, name, created_at, stripe_customer_id FROM orgs WHERE id = $1", [id])).rows[0];
    if (!o) throw new HttpError(404, "not_found", "organisation not found");
    const { planState, ...allowance } = await computeAllowance(app.sql, id, app.now());
    const members = await app.sql.query<{ user_id: string; email: string; display_name: string; role: string }>("SELECT m.user_id, u.email, u.display_name, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 ORDER BY m.created_at", [id]);
    const devices = await app.sql.query<{ id: string; name: string; platform: string; app_version: string; created_at: Date; last_seen_at: Date | null; revoked_at: Date | null }>(
      "SELECT id, name, platform, app_version, created_at, last_seen_at, revoked_at FROM devices WHERE org_id = $1 ORDER BY revoked_at NULLS FIRST, created_at DESC LIMIT 100",
      [id],
    );
    const staffEmail = async (id: string) => (await app.sql.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [id])).rows[0]?.email ?? id;
    const ov = planState.override;
    const resets = await usageResetsFor(app.sql, id, planState.periodStart);
    const credits = await app.sql.query<{ id: string; seconds: string; used: string | null; source: string; note: string | null; expires_at: Date | null; created_at: Date }>(
      "SELECT g.id, g.seconds, (SELECT COALESCE(sum(d.seconds), 0) FROM credit_debits d WHERE d.grant_id = g.id) AS used, g.source, g.note, g.expires_at, g.created_at FROM credit_grants g WHERE g.org_id = $1 ORDER BY g.created_at DESC LIMIT 100",
      [id],
    );
    return {
      org: { id: o.id, name: o.name, createdAt: o.created_at.toISOString(), stripeCustomerId: o.stripe_customer_id },
      plan: { id: planState.plan.id, name: planState.plan.name },
      subscription: {
        status: planState.subscriptionStatus,
        periodStart: planState.periodStart.toISOString(),
        periodEnd: planState.periodEnd.toISOString(),
        cancelAtPeriodEnd: planState.cancelAtPeriodEnd,
        override: ov ? { planId: ov.planId, status: ov.status, note: ov.note, createdBy: await staffEmail(ov.createdBy), createdAt: ov.createdAt.toISOString() } : null,
        stripe: planState.stripe,
      },
      limits: { maxDevices: planState.plan.features.maxDevices, maxMembers: planState.plan.features.maxMembers },
      allowance: { periodStart: allowance.periodStart, periodEnd: allowance.periodEnd, includedSeconds: allowance.includedSeconds, creditSeconds: allowance.creditSeconds, usedSeconds: allowance.usedSeconds, remainingSeconds: allowance.remainingSeconds },
      usageResets: await Promise.all(resets.map(async (x) => ({ id: x.id, seconds: x.seconds, note: x.note, createdBy: await staffEmail(x.createdBy), createdAt: x.createdAt.toISOString() }))),
      members: members.rows.map((m) => ({ userId: m.user_id, email: m.email, displayName: m.display_name, role: m.role })),
      devices: devices.rows.map((d) => ({ id: d.id, name: d.name, platform: d.platform, appVersion: d.app_version, linkedAt: d.created_at.toISOString(), lastSeenAt: d.last_seen_at?.toISOString() ?? null, revokedAt: d.revoked_at?.toISOString() ?? null })),
      credits: credits.rows.map((c) => ({ id: c.id, seconds: Number(c.seconds), remainingSeconds: Math.max(0, Number(c.seconds) - Number(c.used ?? 0)), source: c.source, note: c.note, expiresAt: c.expires_at?.toISOString() ?? null, createdAt: c.created_at.toISOString() })),
    };
  });

  r.add("POST", "/v1/admin/orgs/:orgId/credits", { body: z.object({ hours: z.number().positive().max(10000), note: z.string().trim().min(3).max(200), expiresAt: z.string().datetime().nullable().default(null) }), summary: "Admin: grant auto-director hours (support credit, trial extension)" }, async (ctx) => {
    const staff = await app.requireStaff(ctx, "admin");
    const { rows } = await app.sql.query<{ id: string }>("SELECT id FROM orgs WHERE id = $1", [ctx.params.orgId!]);
    if (!rows[0]) throw new HttpError(404, "not_found", "organisation not found");
    const id = newId("crd");
    await app.sql.query("INSERT INTO credit_grants (id, org_id, seconds, source, expires_at, created_by, note) VALUES ($1, $2, $3, 'grant', $4, $5, $6)", [id, ctx.params.orgId!, Math.round(ctx.body.hours * 3600), ctx.body.expiresAt, staff.id, ctx.body.note]);
    await audit(app.sql, staff.id, ctx.params.orgId!, "admin.credit_granted", ctx.body);
    return { id };
  });

  const requireOrgRow = async (orgId: string) => {
    const { rows } = await app.sql.query<{ id: string }>("SELECT id FROM orgs WHERE id = $1", [orgId]);
    if (!rows[0]) throw new HttpError(404, "not_found", "organisation not found");
  };

  r.add("POST", "/v1/admin/orgs/:orgId/devices/:deviceId/sign-out", { summary: "Staff: sign one of an organisation's computers out (frees a place under the plan's computer limit)" }, async (ctx) => {
    const staff = await app.requireStaff(ctx);
    const { rows } = await app.sql.query<{ id: string; name: string }>("UPDATE devices SET revoked_at = $3 WHERE id = $2 AND org_id = $1 AND revoked_at IS NULL RETURNING id, name", [ctx.params.orgId!, ctx.params.deviceId!, app.now()]);
    if (!rows[0]) throw new HttpError(404, "not_found", "computer not found or already signed out");
    await audit(app.sql, staff.id, ctx.params.orgId!, "admin.device_signed_out", { deviceId: rows[0].id, name: rows[0].name });
    return { computers: 1 };
  });

  r.add("POST", "/v1/admin/orgs/:orgId/devices/sign-out-all", { summary: "Staff: sign every computer of an organisation out (clears the computer limit)" }, async (ctx) => {
    const staff = await app.requireStaff(ctx);
    await requireOrgRow(ctx.params.orgId!);
    const { rows } = await app.sql.query<{ id: string }>("UPDATE devices SET revoked_at = $2 WHERE org_id = $1 AND revoked_at IS NULL RETURNING id", [ctx.params.orgId!, app.now()]);
    await audit(app.sql, staff.id, ctx.params.orgId!, "admin.devices_signed_out", { computers: rows.length });
    return { computers: rows.length };
  });

  r.add("POST", "/v1/admin/orgs/:orgId/usage-reset", { body: z.object({ note: z.string().trim().min(3).max(200) }), summary: "Admin: reset this period's auto-director usage to zero (usage history is kept)" }, async (ctx) => {
    const staff = await app.requireStaff(ctx, "admin");
    await requireOrgRow(ctx.params.orgId!);
    const reset = await app.sql.transaction((tx) => resetPeriodUsage(tx, ctx.params.orgId!, app.now(), staff.id, ctx.body.note));
    if (!reset) throw new HttpError(409, "nothing_to_reset", "this organisation has no auto-director usage this period");
    await audit(app.sql, staff.id, ctx.params.orgId!, "admin.usage_reset", { seconds: reset.seconds, creditSeconds: reset.creditSeconds, periodStart: reset.periodStart.toISOString(), note: ctx.body.note });
    return { seconds: reset.seconds };
  });

  r.add(
    "PUT",
    "/v1/admin/orgs/:orgId/subscription-override",
    { body: z.object({ status: SubscriptionStatus, planId: z.string().min(1).max(64).nullable().default(null), note: z.string().trim().min(3).max(200) }), summary: "Admin: set an organisation's subscription status and plan by hand; it wins over Stripe until removed" },
    async (ctx) => {
      const staff = await app.requireStaff(ctx, "admin");
      await requireOrgRow(ctx.params.orgId!);
      const { status, note } = ctx.body;
      let planId = "free";
      if (isPaidStatus(status)) {
        if (!ctx.body.planId) throw new HttpError(400, "plan_required", `choose the plan the organisation gets while ${status}`);
        if (!(await getPlan(app.sql, ctx.body.planId))) throw new HttpError(400, "unknown_plan", `there is no plan ${ctx.body.planId}`);
        planId = ctx.body.planId;
      }
      const before = await orgPlanState(app.sql, ctx.params.orgId!, app.now());
      await app.sql.query(
        `INSERT INTO subscription_overrides (org_id, plan_id, status, note, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (org_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, status = EXCLUDED.status, note = EXCLUDED.note, created_by = EXCLUDED.created_by, created_at = EXCLUDED.created_at`,
        [ctx.params.orgId!, planId, status, note, staff.id, app.now()],
      );
      await audit(app.sql, staff.id, ctx.params.orgId!, "admin.subscription_override_set", { from: { planId: before.plan.id, status: before.subscriptionStatus }, to: { planId, status }, stripe: before.stripe, note });
      return { planId, status };
    },
  );

  r.add("DELETE", "/v1/admin/orgs/:orgId/subscription-override", { summary: "Admin: remove a subscription override; Stripe's status applies again" }, async (ctx) => {
    const staff = await app.requireStaff(ctx, "admin");
    const { rows } = await app.sql.query<{ plan_id: string; status: string }>("DELETE FROM subscription_overrides WHERE org_id = $1 RETURNING plan_id, status", [ctx.params.orgId!]);
    if (!rows[0]) throw new HttpError(404, "not_found", "this organisation has no subscription override");
    const after = await orgPlanState(app.sql, ctx.params.orgId!, app.now());
    await audit(app.sql, staff.id, ctx.params.orgId!, "admin.subscription_override_removed", { removed: { planId: rows[0].plan_id, status: rows[0].status }, now: { planId: after.plan.id, status: after.subscriptionStatus } });
    return { planId: after.plan.id, status: after.subscriptionStatus };
  });

  r.add("GET", "/v1/admin/catalog", { summary: "Staff: full plan and hour-pack catalogue including Stripe price ids" }, async (ctx) => {
    await app.requireStaff(ctx);
    return { plans: await listPlans(app.sql), hourPacks: await listHourPacks(app.sql) };
  });

  r.add("PUT", "/v1/admin/plans/:planId", { body: Plan, summary: "Admin: create or edit a plan" }, async (ctx) => {
    const staff = await app.requireStaff(ctx, "admin");
    if (ctx.body.id !== ctx.params.planId!) throw new HttpError(400, "id_mismatch", "plan id in the body must match the URL");
    await upsertPlan(app.sql, ctx.body);
    await audit(app.sql, staff.id, null, "admin.plan_saved", ctx.body);
    return ctx.body;
  });

  r.add("PUT", "/v1/admin/hour-packs/:packId", { body: HourPack, summary: "Admin: create or edit an hour pack" }, async (ctx) => {
    const staff = await app.requireStaff(ctx, "admin");
    if (ctx.body.id !== ctx.params.packId!) throw new HttpError(400, "id_mismatch", "pack id in the body must match the URL");
    await upsertHourPack(app.sql, ctx.body);
    await audit(app.sql, staff.id, null, "admin.hour_pack_saved", ctx.body);
    return ctx.body;
  });

  r.add("GET", "/v1/admin/audit", { summary: "Staff: recent audit events (optionally for one organisation)" }, async (ctx) => {
    await app.requireStaff(ctx);
    const org = ctx.query.get("orgId");
    const { rows } = await app.sql.query<{ id: string; at: Date; actor: string; org_id: string | null; action: string; detail: unknown }>(
      `SELECT id, at, actor, org_id, action, detail FROM audit_log ${org ? "WHERE org_id = $1" : ""} ORDER BY id DESC LIMIT 300`,
      org ? [org] : [],
    );
    return rows.map((a) => ({ id: String(a.id), at: a.at.toISOString(), actor: a.actor, orgId: a.org_id, action: a.action, detail: a.detail }));
  });

  r.add("GET", "/v1/admin/stripe-events", { summary: "Admin: recent Stripe webhook events and processing errors" }, async (ctx) => {
    await app.requireStaff(ctx, "admin");
    const { rows } = await app.sql.query<{ id: string; type: string; received_at: Date; processed_at: Date | null; error: string | null }>("SELECT id, type, received_at, processed_at, error FROM stripe_events ORDER BY received_at DESC LIMIT 200");
    return rows.map((e) => ({ id: e.id, type: e.type, receivedAt: e.received_at.toISOString(), processedAt: e.processed_at?.toISOString() ?? null, error: e.error }));
  });
  // ---------------------------------------------------------------- support inbox and email log

  r.add("GET", "/v1/admin/messages", { summary: "Staff: contact form messages (status = open | handled | all)" }, async (ctx) => {
    await app.requireStaff(ctx);
    const status = MessageStatus.catch("open").parse(ctx.query.get("status") ?? "open");
    const where = { open: "WHERE c.handled_at IS NULL", handled: "WHERE c.handled_at IS NOT NULL", all: "" }[status];
    const { rows } = await app.sql.query<{ id: string; name: string; email: string; topic: string; message: string; org_id: string | null; user_id: string | null; created_at: Date; handled_at: Date | null; handled_by: string | null; handler_email: string | null }>(
      `SELECT c.id, c.name, c.email, c.topic, c.message, c.org_id, c.user_id, c.created_at, c.handled_at, c.handled_by, h.email AS handler_email
         FROM contact_messages c LEFT JOIN users h ON h.id = c.handled_by ${where} ORDER BY c.id DESC LIMIT 300`,
    );
    return {
      messages: rows.map((m) => ({ id: String(m.id), name: m.name, email: m.email, topic: m.topic, message: m.message, orgId: m.org_id, userId: m.user_id, createdAt: m.created_at.toISOString(), handledAt: m.handled_at?.toISOString() ?? null, handledBy: m.handler_email ?? m.handled_by })),
    };
  });

  r.add("POST", "/v1/admin/messages/:messageId/handled", { body: z.object({ handled: z.boolean() }), summary: "Staff: mark a contact message handled (or reopen it)" }, async (ctx) => {
    const staff = await app.requireStaff(ctx);
    const id = ctx.params.messageId!;
    if (!/^\d{1,18}$/.test(id)) throw new HttpError(404, "not_found", "message not found");
    const { rows } = await app.sql.query<{ id: string }>(
      ctx.body.handled ? "UPDATE contact_messages SET handled_at = COALESCE(handled_at, $2), handled_by = COALESCE(handled_by, $3) WHERE id = $1 RETURNING id" : "UPDATE contact_messages SET handled_at = NULL, handled_by = NULL WHERE id = $1 RETURNING id",
      ctx.body.handled ? [id, app.now(), staff.id] : [id],
    );
    if (!rows[0]) throw new HttpError(404, "not_found", "message not found");
    await audit(app.sql, staff.id, null, ctx.body.handled ? "admin.message_handled" : "admin.message_reopened", { messageId: id });
    return { ok: true };
  });

  r.add("GET", "/v1/admin/emails", { summary: "Staff: recent emails sent by the website (recipient, subject, delivery state; no bodies)" }, async (ctx) => {
    await app.requireStaff(ctx);
    const limit = Math.min(500, Math.max(1, Math.floor(Number(ctx.query.get("limit")) || 100)));
    const { rows } = await app.sql.query<{ id: string; to_addr: string; subject: string; created_at: Date; sent_at: Date | null; error: string | null }>("SELECT id, to_addr, subject, created_at, sent_at, error FROM outbox_emails ORDER BY id DESC LIMIT $1", [limit]);
    return { emails: rows.map((e) => ({ id: String(e.id), to: e.to_addr, subject: e.subject, createdAt: e.created_at.toISOString(), sentAt: e.sent_at?.toISOString() ?? null, error: e.error })), delivery: app.mailer.kind };
  });

  r.add("POST", "/v1/admin/emails/:emailId/resend", { summary: "Admin: send an email again (after an SMTP outage)" }, async (ctx) => {
    const staff = await app.requireStaff(ctx, "admin");
    const id = ctx.params.emailId!;
    const result = /^\d{1,18}$/.test(id) ? await app.mailer.resend(id) : null;
    if (!result) throw new HttpError(404, "not_found", "email not found");
    await audit(app.sql, staff.id, null, "admin.email_resent", { emailId: id, sent: result.sent });
    return result;
  });
}
