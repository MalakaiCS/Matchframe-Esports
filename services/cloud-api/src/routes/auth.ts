import { z } from "zod";
import { ChangeEmailRequest, Email, LoginRequest, Password, SignupRequest, UpdateProfileRequest } from "@matchframe/cloud-contracts";
import type { OrgView } from "@matchframe/cloud-contracts";
import type { CloudApp } from "../app.ts";
import { sessionPublicId } from "../app.ts";
import { DUMMY_HASH, hashPassword, verifyPassword } from "../auth/passwords.ts";
import type { Queryable } from "../db/sql.ts";
import { audit } from "../domain/audit.ts";
import { orgPlanState } from "../domain/allowance.ts";
import type { Router } from "../http/router.ts";
import { HttpError, reply } from "../http/router.ts";
import { hashSecret, newId, newSecret } from "../ids.ts";

const VERIFY_HOURS = 48;
const RESET_MINUTES = 60;

type EmailTokenPurpose = "verify" | "reset" | "email_change";

async function issueEmailToken(db: Queryable, userId: string, purpose: EmailTokenPurpose, ttlMs: number, now: Date, newEmail: string | null = null): Promise<string> {
  const secret = newSecret();
  await db.query("INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at, new_email) VALUES ($1, $2, $3, $4, $5)", [hashSecret(secret), userId, purpose, new Date(now.getTime() + ttlMs), newEmail]);
  return secret;
}

async function consumeEmailToken(db: Queryable, secret: string, purpose: EmailTokenPurpose, now: Date): Promise<string> {
  return (await consumeEmailTokenRow(db, secret, purpose, now)).userId;
}

async function consumeEmailTokenRow(db: Queryable, secret: string, purpose: EmailTokenPurpose, now: Date): Promise<{ userId: string; newEmail: string | null }> {
  const { rows } = await db.query<{ user_id: string; new_email: string | null }>(
    "UPDATE email_tokens SET used_at = $3 WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > $3 RETURNING user_id, new_email",
    [hashSecret(secret), purpose, now],
  );
  if (!rows[0]) throw new HttpError(400, "invalid_token", "this link is invalid or has expired; request a new one");
  return { userId: rows[0].user_id, newEmail: rows[0].new_email };
}

export async function orgsFor(app: CloudApp, userId: string): Promise<OrgView[]> {
  const { rows } = await app.sql.query<{ id: string; name: string; role: OrgView["role"] }>("SELECT o.id, o.name, m.role FROM memberships m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = $1 ORDER BY o.created_at", [userId]);
  const out: OrgView[] = [];
  for (const r of rows) {
    const st = await orgPlanState(app.sql, r.id, app.now());
    out.push({ id: r.id, name: r.name, role: r.role, planId: st.plan.id, planName: st.plan.name, subscriptionStatus: st.subscriptionStatus });
  }
  return out;
}

export async function sendVerification(app: CloudApp, userId: string, email: string): Promise<void> {
  const token = await issueEmailToken(app.sql, userId, "verify", VERIFY_HOURS * 3_600_000, app.now());
  await app.mailer.send({
    to: email,
    subject: "Confirm your Matchframe email address",
    text: `Confirm your email address to finish setting up Matchframe:\n\n${app.cfg.publicUrl}/verify-email?token=${token}\n\nThe link expires in ${VERIFY_HOURS} hours. If you did not sign up, ignore this email.`,
  });
}

export async function sendPasswordReset(app: CloudApp, userId: string, email: string): Promise<void> {
  const token = await issueEmailToken(app.sql, userId, "reset", RESET_MINUTES * 60_000, app.now());
  await app.mailer.send({
    to: email,
    subject: "Reset your Matchframe password",
    text: `Someone asked to reset the password for this Matchframe account. To choose a new password open:\n\n${app.cfg.publicUrl}/reset-password?token=${token}\n\nThe link expires in ${RESET_MINUTES} minutes. If this was not you, ignore this email.`,
  });
}

export interface SessionRow {
  id_hash: string;
  created_at: Date;
  last_seen_at: Date | null;
  user_agent: string | null;
  ip: string | null;
}

export async function sessionsFor(app: CloudApp, userId: string): Promise<SessionRow[]> {
  const { rows } = await app.sql.query<SessionRow>("SELECT id_hash, created_at, last_seen_at, user_agent, ip FROM sessions WHERE user_id = $1 AND expires_at > $2 ORDER BY COALESCE(last_seen_at, created_at) DESC", [userId, app.now()]);
  return rows;
}

export const sessionView = (s: SessionRow) => ({ id: sessionPublicId(s.id_hash), createdAt: s.created_at.toISOString(), lastSeenAt: s.last_seen_at?.toISOString() ?? null, userAgent: s.user_agent || null, ip: s.ip || null });

export function registerAuthRoutes(r: Router, app: CloudApp): void {
  r.add("POST", "/v1/auth/signup", { body: SignupRequest, summary: "Create an account and organisation (signs in; sends a verification email)" }, async (ctx) => {
    app.rateLimit(app.limits.auth, `signup:${ctx.ip}`);
    const b = ctx.body;
    const passwordHash = await hashPassword(b.password);
    const userId = newId("usr");
    const orgId = newId("org");
    const staffRole = app.isBootstrapAdmin(b.email) ? "admin" : null;
    try {
      await app.sql.transaction(async (tx) => {
        await tx.query("INSERT INTO users (id, email, display_name, password_hash, staff_role) VALUES ($1, $2, $3, $4, $5)", [userId, b.email, b.displayName, passwordHash, staffRole]);
        await tx.query("INSERT INTO orgs (id, name) VALUES ($1, $2)", [orgId, b.orgName]);
        await tx.query("INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner')", [orgId, userId]);
        await audit(tx, userId, orgId, "account.signup", { email: b.email });
      });
    } catch (e) {
      if (String(e).includes("users_email_key") || String(e).includes("duplicate key")) throw new HttpError(409, "email_taken", "an account with this email already exists; sign in or reset your password");
      throw e;
    }
    await sendVerification(app, userId, b.email);
    const c = await app.createSession(userId, ctx);
    return reply({ status: 201, json: { userId, orgId }, cookies: [c] });
  });

  r.add("POST", "/v1/auth/login", { body: LoginRequest, summary: "Sign in" }, async (ctx) => {
    app.rateLimit(app.limits.auth, `login:${ctx.ip}`);
    app.rateLimit(app.limits.auth, `login-email:${ctx.body.email}`);
    const { rows } = await app.sql.query<{ id: string; password_hash: string; staff_role: string | null; disabled_at: Date | null }>("SELECT id, password_hash, staff_role, disabled_at FROM users WHERE email = $1", [ctx.body.email]);
    const u = rows[0];
    const ok = await verifyPassword(ctx.body.password, u?.password_hash ?? DUMMY_HASH);
    if (!u || !ok) throw new HttpError(401, "invalid_credentials", "email or password is incorrect");
    // Only after the password is checked, so this does not reveal which addresses have accounts.
    if (u.disabled_at) throw new HttpError(403, "account_disabled", "this account has been disabled; contact Matchframe support");
    if (u.staff_role !== "admin" && app.isBootstrapAdmin(ctx.body.email)) await app.sql.query("UPDATE users SET staff_role = 'admin' WHERE id = $1", [u.id]);
    await app.sql.query("UPDATE users SET last_login_at = $2 WHERE id = $1", [u.id, app.now()]);
    const c = await app.createSession(u.id, ctx);
    await audit(app.sql, u.id, null, "account.login", { ip: ctx.ip });
    return reply({ json: { userId: u.id }, cookies: [c] });
  });

  r.add("POST", "/v1/auth/logout", { summary: "Sign out this browser" }, async (ctx) => {
    const u = await app.optionalUser(ctx);
    if (u) await app.sql.query("DELETE FROM sessions WHERE id_hash = $1", [u.sessionHash]);
    return reply({ json: { ok: true }, cookies: [app.clearSessionCookie()] });
  });

  r.add("GET", "/v1/auth/me", { summary: "Current user and organisations" }, async (ctx) => {
    const u = await app.requireUser(ctx);
    const { sessionHash: _s, ...user } = u;
    return { user, orgs: await orgsFor(app, u.id), billingConfigured: app.billing.configured };
  });

  r.add("PATCH", "/v1/auth/me", { body: UpdateProfileRequest, summary: "Change your display name" }, async (ctx) => {
    const u = await app.requireUser(ctx);
    await app.sql.query("UPDATE users SET display_name = $2 WHERE id = $1", [u.id, ctx.body.displayName]);
    await audit(app.sql, u.id, null, "account.profile_updated", { displayName: ctx.body.displayName });
    return { ok: true, displayName: ctx.body.displayName };
  });

  r.add("POST", "/v1/auth/change-email", { body: ChangeEmailRequest, summary: "Change your email address (confirmed from a link sent to the new address)" }, async (ctx) => {
    const u = await app.requireUser(ctx);
    app.rateLimit(app.limits.email, `email-change:${u.id}`);
    const { rows } = await app.sql.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [u.id]);
    if (!(await verifyPassword(ctx.body.password, rows[0]!.password_hash))) throw new HttpError(400, "invalid_credentials", "password is incorrect");
    if (ctx.body.newEmail === u.email) throw new HttpError(400, "same_email", "that is already your email address");
    const taken = await app.sql.query("SELECT 1 FROM users WHERE email = $1", [ctx.body.newEmail]);
    if (taken.rows[0]) throw new HttpError(409, "email_taken", "another account already uses this email address");
    const token = await issueEmailToken(app.sql, u.id, "email_change", VERIFY_HOURS * 3_600_000, app.now(), ctx.body.newEmail);
    await app.mailer.send({
      to: ctx.body.newEmail,
      subject: "Confirm your new Matchframe email address",
      text: `Confirm this address for your Matchframe account:\n\n${app.cfg.publicUrl}/confirm-email?token=${token}\n\nThe link expires in ${VERIFY_HOURS} hours. If you did not ask for this, ignore this email.`,
    });
    await app.mailer.send({
      to: u.email,
      subject: "Your Matchframe email address is being changed",
      text: `A change of your Matchframe sign-in email to ${ctx.body.newEmail} was requested. It takes effect once confirmed from that address.\n\nIf this was not you, change your password now: ${app.cfg.publicUrl}/forgot-password`,
    });
    await audit(app.sql, u.id, null, "account.email_change_requested", { newEmail: ctx.body.newEmail });
    return { sent: true };
  });

  r.add("POST", "/v1/auth/confirm-email-change", { body: z.object({ token: z.string().min(10).max(200) }), browserMutation: false, summary: "Confirm a new email address from the emailed link" }, async (ctx) => {
    const { userId, newEmail } = await consumeEmailTokenRow(app.sql, ctx.body.token, "email_change", app.now());
    if (!newEmail) throw new HttpError(400, "invalid_token", "this link is invalid or has expired; request a new one");
    try {
      await app.sql.query("UPDATE users SET email = $2, email_verified_at = $3 WHERE id = $1", [userId, newEmail, app.now()]);
    } catch (e) {
      if (String(e).includes("duplicate key") || String(e).includes("users_email_key")) throw new HttpError(409, "email_taken", "another account already uses this email address");
      throw e;
    }
    await audit(app.sql, userId, null, "account.email_changed", { newEmail });
    return { changed: true, email: newEmail };
  });

  r.add("POST", "/v1/auth/verify-email", { body: z.object({ token: z.string().min(10).max(200) }), browserMutation: false, summary: "Confirm an email address from the emailed link" }, async (ctx) => {
    const userId = await consumeEmailToken(app.sql, ctx.body.token, "verify", app.now());
    await app.sql.query("UPDATE users SET email_verified_at = COALESCE(email_verified_at, $2) WHERE id = $1", [userId, app.now()]);
    await audit(app.sql, userId, null, "account.email_verified");
    return { verified: true };
  });

  r.add("POST", "/v1/auth/resend-verification", { summary: "Send the verification email again" }, async (ctx) => {
    const u = await app.requireUser(ctx);
    if (u.emailVerified) return { sent: false, alreadyVerified: true };
    app.rateLimit(app.limits.email, `verify:${u.id}`);
    await sendVerification(app, u.id, u.email);
    return { sent: true };
  });

  r.add("POST", "/v1/auth/request-password-reset", { body: z.object({ email: Email }), summary: "Email a password reset link (always answers OK)" }, async (ctx) => {
    app.rateLimit(app.limits.email, `reset:${ctx.ip}`);
    const { rows } = await app.sql.query<{ id: string }>("SELECT id FROM users WHERE email = $1 AND disabled_at IS NULL", [ctx.body.email]);
    if (rows[0]) await sendPasswordReset(app, rows[0].id, ctx.body.email);
    return { ok: true };
  });

  r.add("POST", "/v1/auth/reset-password", { body: z.object({ token: z.string().min(10).max(200), password: Password }), summary: "Set a new password from a reset link (signs out other sessions)" }, async (ctx) => {
    const userId = await consumeEmailToken(app.sql, ctx.body.token, "reset", app.now());
    await app.sql.query("UPDATE users SET password_hash = $2, email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1", [userId, await hashPassword(ctx.body.password)]);
    await app.sql.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
    await audit(app.sql, userId, null, "account.password_reset");
    return { ok: true };
  });

  r.add("POST", "/v1/auth/change-password", { body: z.object({ currentPassword: z.string().min(1).max(200), newPassword: Password }), summary: "Change password (signs out other sessions)" }, async (ctx) => {
    const u = await app.requireUser(ctx);
    const { rows } = await app.sql.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [u.id]);
    if (!(await verifyPassword(ctx.body.currentPassword, rows[0]!.password_hash))) throw new HttpError(400, "invalid_credentials", "current password is incorrect");
    await app.sql.query("UPDATE users SET password_hash = $2 WHERE id = $1", [u.id, await hashPassword(ctx.body.newPassword)]);
    await app.sql.query("DELETE FROM sessions WHERE user_id = $1 AND id_hash <> $2", [u.id, u.sessionHash]);
    await audit(app.sql, u.id, null, "account.password_changed");
    return { ok: true };
  });
  r.add("GET", "/v1/auth/sessions", { summary: "Browsers signed in to your account" }, async (ctx) => {
    const u = await app.requireUser(ctx);
    const current = sessionPublicId(u.sessionHash);
    return { sessions: (await sessionsFor(app, u.id)).map((s) => ({ ...sessionView(s), current: sessionPublicId(s.id_hash) === current })) };
  });

  r.add("DELETE", "/v1/auth/sessions/:id", { summary: "Sign out one browser" }, async (ctx) => {
    const u = await app.requireUser(ctx);
    const s = (await sessionsFor(app, u.id)).find((x) => sessionPublicId(x.id_hash) === ctx.params.id);
    if (!s) throw new HttpError(404, "not_found", "no such session");
    await app.sql.query("DELETE FROM sessions WHERE id_hash = $1 AND user_id = $2", [s.id_hash, u.id]);
    await audit(app.sql, u.id, null, "account.session_revoked", { session: ctx.params.id });
    const cookies = s.id_hash === u.sessionHash ? [app.clearSessionCookie()] : [];
    return reply({ json: { ok: true }, cookies });
  });

  r.add("POST", "/v1/auth/sessions/revoke-others", { summary: "Sign out every other browser" }, async (ctx) => {
    const u = await app.requireUser(ctx);
    const { rows } = await app.sql.query<{ id_hash: string }>("DELETE FROM sessions WHERE user_id = $1 AND id_hash <> $2 RETURNING id_hash", [u.id, u.sessionHash]);
    await audit(app.sql, u.id, null, "account.sessions_revoked", { revoked: rows.length });
    return { revoked: rows.length };
  });

  r.add("GET", "/v1/auth/export", { summary: "Download a copy of your account data (JSON)" }, async (ctx) => {
    const u = await app.requireUser(ctx);
    const user = (await app.sql.query<{ last_login_at: Date | null }>("SELECT last_login_at FROM users WHERE id = $1", [u.id])).rows[0];
    const memberships = await app.sql.query<{ org_id: string; name: string; role: string; created_at: Date }>("SELECT m.org_id, o.name, m.role, m.created_at FROM memberships m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = $1 ORDER BY m.created_at", [u.id]);
    const devices = await app.sql.query<{ id: string; org_id: string; name: string; platform: string; created_at: Date; revoked_at: Date | null }>("SELECT id, org_id, name, platform, created_at, revoked_at FROM devices WHERE approved_by = $1 ORDER BY created_at", [u.id]);
    const activity = await app.sql.query<{ at: Date; org_id: string | null; action: string; detail: unknown }>("SELECT at, org_id, action, detail FROM audit_log WHERE actor = $1 ORDER BY id DESC LIMIT 1000", [u.id]);
    const messages = await app.sql.query<{ topic: string; message: string; created_at: Date }>("SELECT topic, message, created_at FROM contact_messages WHERE user_id = $1 OR email = $2 ORDER BY id", [u.id, u.email]);
    const data = {
      exportedAt: app.now().toISOString(),
      account: { id: u.id, email: u.email, displayName: u.displayName, emailVerified: u.emailVerified, staffRole: u.staffRole ?? null, createdAt: u.createdAt, lastLoginAt: user?.last_login_at?.toISOString() ?? null },
      organisations: memberships.rows.map((m) => ({ id: m.org_id, name: m.name, role: m.role, joinedAt: m.created_at.toISOString() })),
      sessions: (await sessionsFor(app, u.id)).map(sessionView),
      computersLinked: devices.rows.map((d) => ({ id: d.id, orgId: d.org_id, name: d.name, platform: d.platform, linkedAt: d.created_at.toISOString(), unlinkedAt: d.revoked_at?.toISOString() ?? null })),
      activity: activity.rows.map((a) => ({ at: a.at.toISOString(), orgId: a.org_id, action: a.action, detail: a.detail })),
      contactMessages: messages.rows.map((m) => ({ topic: m.topic, message: m.message, sentAt: m.created_at.toISOString() })),
    };
    await audit(app.sql, u.id, null, "account.data_exported");
    const day = app.now().toISOString().slice(0, 10);
    return reply({ body: JSON.stringify(data, null, 2), contentType: "application/json; charset=utf-8", headers: { "content-disposition": `attachment; filename="matchframe-account-${day}.json"`, "cache-control": "no-store" } });
  });
}
