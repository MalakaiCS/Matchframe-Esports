import { z } from "zod";
import { Email, LoginRequest, Password, SignupRequest } from "@matchframe/cloud-contracts";
import type { OrgView } from "@matchframe/cloud-contracts";
import type { CloudApp } from "../app.ts";
import { DUMMY_HASH, hashPassword, verifyPassword } from "../auth/passwords.ts";
import type { Queryable } from "../db/sql.ts";
import { audit } from "../domain/audit.ts";
import { orgPlanState } from "../domain/allowance.ts";
import type { Router } from "../http/router.ts";
import { HttpError, reply } from "../http/router.ts";
import { hashSecret, newId, newSecret } from "../ids.ts";

const VERIFY_HOURS = 48;
const RESET_MINUTES = 60;

async function issueEmailToken(db: Queryable, userId: string, purpose: "verify" | "reset", ttlMs: number, now: Date): Promise<string> {
  const secret = newSecret();
  await db.query("INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at) VALUES ($1, $2, $3, $4)", [hashSecret(secret), userId, purpose, new Date(now.getTime() + ttlMs)]);
  return secret;
}

async function consumeEmailToken(db: Queryable, secret: string, purpose: "verify" | "reset", now: Date): Promise<string> {
  const { rows } = await db.query<{ user_id: string }>(
    "UPDATE email_tokens SET used_at = $3 WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > $3 RETURNING user_id",
    [hashSecret(secret), purpose, now],
  );
  if (!rows[0]) throw new HttpError(400, "invalid_token", "this link is invalid or has expired; request a new one");
  return rows[0].user_id;
}

export async function orgsFor(app: CloudApp, userId: string): Promise<OrgView[]> {
  const { rows } = await app.sql.query<{ id: string; name: string; role: OrgView["role"] }>("SELECT o.id, o.name, m.role FROM memberships m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = $1 ORDER BY o.created_at", [userId]);
  const out: OrgView[] = [];
  for (const r of rows) {
    const st = await orgPlanState(app.sql, r.id, app.now());
    out.push({ id: r.id, name: r.name, role: r.role, planId: st.plan.id, subscriptionStatus: st.subscriptionStatus });
  }
  return out;
}

async function sendVerification(app: CloudApp, userId: string, email: string): Promise<void> {
  const token = await issueEmailToken(app.sql, userId, "verify", VERIFY_HOURS * 3_600_000, app.now());
  await app.mailer.send({
    to: email,
    subject: "Confirm your Matchframe email address",
    text: `Confirm your email address to finish setting up Matchframe:\n\n${app.cfg.publicUrl}/verify-email?token=${token}\n\nThe link expires in ${VERIFY_HOURS} hours. If you did not sign up, ignore this email.`,
  });
}

export function registerAuthRoutes(r: Router, app: CloudApp): void {
  r.add("POST", "/v1/auth/signup", { body: SignupRequest, summary: "Create an account and organisation (signs in; sends a verification email)" }, async (ctx) => {
    app.rateLimit(app.limits.auth, `signup:${ctx.ip}`);
    const b = ctx.body;
    const passwordHash = await hashPassword(b.password);
    const userId = newId("usr");
    const orgId = newId("org");
    const staff = app.cfg.staffEmails.includes(b.email);
    try {
      await app.sql.transaction(async (tx) => {
        await tx.query("INSERT INTO users (id, email, display_name, password_hash, staff) VALUES ($1, $2, $3, $4, $5)", [userId, b.email, b.displayName, passwordHash, staff]);
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
    const { rows } = await app.sql.query<{ id: string; password_hash: string; staff: boolean }>("SELECT id, password_hash, staff FROM users WHERE email = $1", [ctx.body.email]);
    const u = rows[0];
    const ok = await verifyPassword(ctx.body.password, u?.password_hash ?? DUMMY_HASH);
    if (!u || !ok) throw new HttpError(401, "invalid_credentials", "email or password is incorrect");
    if (!u.staff && app.cfg.staffEmails.includes(ctx.body.email)) await app.sql.query("UPDATE users SET staff = true WHERE id = $1", [u.id]);
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
    const { rows } = await app.sql.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [ctx.body.email]);
    if (rows[0]) {
      const token = await issueEmailToken(app.sql, rows[0].id, "reset", RESET_MINUTES * 60_000, app.now());
      await app.mailer.send({
        to: ctx.body.email,
        subject: "Reset your Matchframe password",
        text: `Someone asked to reset the password for this Matchframe account. To choose a new password open:\n\n${app.cfg.publicUrl}/reset-password?token=${token}\n\nThe link expires in ${RESET_MINUTES} minutes. If this was not you, ignore this email.`,
      });
    }
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
}
