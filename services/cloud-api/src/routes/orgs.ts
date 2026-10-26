import { z } from "zod";
import { InviteRequest, OrgRole } from "@matchframe/cloud-contracts";
import type { CloudApp } from "../app.ts";
import { audit } from "../domain/audit.ts";
import { orgPlanState } from "../domain/allowance.ts";
import type { Router } from "../http/router.ts";
import { HttpError } from "../http/router.ts";
import { hashSecret, newId, newSecret } from "../ids.ts";

const INVITE_DAYS = 7;

export function registerOrgRoutes(r: Router, app: CloudApp): void {
  r.add("POST", "/v1/orgs", { body: z.object({ name: z.string().trim().min(1).max(80) }), summary: "Create another organisation (you become its owner)" }, async (ctx) => {
    const u = await app.requireUser(ctx, { verified: true });
    const id = newId("org");
    await app.sql.transaction(async (tx) => {
      await tx.query("INSERT INTO orgs (id, name) VALUES ($1, $2)", [id, ctx.body.name]);
      await tx.query("INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner')", [id, u.id]);
      await audit(tx, u.id, id, "org.create", { name: ctx.body.name });
    });
    return { id, name: ctx.body.name };
  });

  r.add("GET", "/v1/orgs/:orgId", { summary: "Organisation details" }, async (ctx) => {
    const { role } = await app.requireOrg(ctx, ctx.params.orgId!, "org.view");
    const { rows } = await app.sql.query<{ id: string; name: string; created_at: Date }>("SELECT id, name, created_at FROM orgs WHERE id = $1", [ctx.params.orgId!]);
    if (!rows[0]) throw new HttpError(404, "not_found", "organisation not found");
    const st = await orgPlanState(app.sql, rows[0].id, app.now());
    return { id: rows[0].id, name: rows[0].name, createdAt: rows[0].created_at.toISOString(), role, plan: st.plan, subscriptionStatus: st.subscriptionStatus };
  });

  r.add("PATCH", "/v1/orgs/:orgId", { body: z.object({ name: z.string().trim().min(1).max(80) }), summary: "Rename the organisation" }, async (ctx) => {
    const { user } = await app.requireOrg(ctx, ctx.params.orgId!, "org.rename");
    await app.sql.query("UPDATE orgs SET name = $2 WHERE id = $1", [ctx.params.orgId!, ctx.body.name]);
    await audit(app.sql, user.id, ctx.params.orgId!, "org.rename", ctx.body);
    return { ok: true };
  });

  r.add("GET", "/v1/orgs/:orgId/members", { summary: "Members and pending invites" }, async (ctx) => {
    await app.requireOrg(ctx, ctx.params.orgId!, "org.view");
    const members = await app.sql.query<{ user_id: string; email: string; display_name: string; role: string; created_at: Date }>(
      "SELECT m.user_id, u.email, u.display_name, m.role, m.created_at FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 ORDER BY m.created_at",
      [ctx.params.orgId!],
    );
    const invites = await app.sql.query<{ email: string; role: string; expires_at: Date; token_hash: string }>(
      "SELECT email, role, expires_at, token_hash FROM invites WHERE org_id = $1 AND accepted_at IS NULL AND expires_at > $2 ORDER BY expires_at",
      [ctx.params.orgId!, app.now()],
    );
    return {
      members: members.rows.map((m) => ({ userId: m.user_id, email: m.email, displayName: m.display_name, role: m.role, since: m.created_at.toISOString() })),
      invites: invites.rows.map((i) => ({ id: i.token_hash.slice(0, 16), email: i.email, role: i.role, expiresAt: i.expires_at.toISOString() })),
    };
  });

  r.add("POST", "/v1/orgs/:orgId/invites", { body: InviteRequest, summary: "Invite someone by email" }, async (ctx) => {
    const { user } = await app.requireOrg(ctx, ctx.params.orgId!, "members.manage", { verified: true });
    app.rateLimit(app.limits.email, `invite:${user.id}`);
    const st = await orgPlanState(app.sql, ctx.params.orgId!, app.now());
    const { rows } = await app.sql.query<{ n: string }>("SELECT (SELECT count(*) FROM memberships WHERE org_id = $1) + (SELECT count(*) FROM invites WHERE org_id = $1 AND accepted_at IS NULL AND expires_at > $2) AS n", [ctx.params.orgId!, app.now()]);
    if (Number(rows[0]!.n) >= st.plan.features.maxMembers) throw new HttpError(409, "member_limit", `the ${st.plan.name} plan allows ${st.plan.features.maxMembers} members; upgrade or remove someone first`);
    const token = newSecret();
    await app.sql.query("INSERT INTO invites (token_hash, org_id, email, role, invited_by, expires_at) VALUES ($1, $2, $3, $4, $5, $6)", [hashSecret(token), ctx.params.orgId!, ctx.body.email, ctx.body.role, user.id, new Date(app.now().getTime() + INVITE_DAYS * 86_400_000)]);
    const org = await app.sql.query<{ name: string }>("SELECT name FROM orgs WHERE id = $1", [ctx.params.orgId!]);
    await app.mailer.send({
      to: ctx.body.email,
      subject: `${user.displayName} invited you to ${org.rows[0]!.name} on Matchframe`,
      text: `${user.displayName} invited you to join ${org.rows[0]!.name} on Matchframe as ${ctx.body.role}.\n\nAccept the invitation:\n${app.cfg.publicUrl}/invite?token=${token}\n\nThe invitation expires in ${INVITE_DAYS} days.`,
    });
    await audit(app.sql, user.id, ctx.params.orgId!, "org.invite", { email: ctx.body.email, role: ctx.body.role });
    return { invited: true };
  });

  r.add("DELETE", "/v1/orgs/:orgId/invites/:inviteId", { summary: "Withdraw a pending invite" }, async (ctx) => {
    const { user } = await app.requireOrg(ctx, ctx.params.orgId!, "members.manage");
    await app.sql.query("DELETE FROM invites WHERE org_id = $1 AND substr(token_hash, 1, 16) = $2 AND accepted_at IS NULL", [ctx.params.orgId!, ctx.params.inviteId!]);
    await audit(app.sql, user.id, ctx.params.orgId!, "org.invite_withdrawn", { inviteId: ctx.params.inviteId! });
    return { ok: true };
  });

  r.add("GET", "/v1/invites/:token", { summary: "Preview an invitation" }, async (ctx) => {
    const { rows } = await app.sql.query<{ org_name: string; email: string; role: string; expires_at: Date; accepted_at: Date | null }>(
      "SELECT o.name AS org_name, i.email, i.role, i.expires_at, i.accepted_at FROM invites i JOIN orgs o ON o.id = i.org_id WHERE i.token_hash = $1",
      [hashSecret(ctx.params.token!)],
    );
    const i = rows[0];
    if (!i || i.accepted_at || i.expires_at <= app.now()) throw new HttpError(404, "invalid_invite", "this invitation is invalid, used or expired");
    return { orgName: i.org_name, email: i.email, role: i.role, expiresAt: i.expires_at.toISOString() };
  });

  r.add("POST", "/v1/invites/:token/accept", { summary: "Accept an invitation (the signed-in email must match)" }, async (ctx) => {
    const u = await app.requireUser(ctx, { verified: true });
    const h = hashSecret(ctx.params.token!);
    return app.sql.transaction(async (tx) => {
      const { rows } = await tx.query<{ org_id: string; email: string; role: string }>("SELECT org_id, email, role FROM invites WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > $2 FOR UPDATE", [h, app.now()]);
      const i = rows[0];
      if (!i) throw new HttpError(404, "invalid_invite", "this invitation is invalid, used or expired");
      if (i.email !== u.email) throw new HttpError(403, "wrong_account", `this invitation is for ${i.email}; sign in with that email`);
      await tx.query("INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (org_id, user_id) DO NOTHING", [i.org_id, u.id, i.role]);
      await tx.query("UPDATE invites SET accepted_at = $2 WHERE token_hash = $1", [h, app.now()]);
      await audit(tx, u.id, i.org_id, "org.invite_accepted", { role: i.role });
      return { orgId: i.org_id, role: i.role };
    });
  });

  r.add("PATCH", "/v1/orgs/:orgId/members/:userId", { body: z.object({ role: OrgRole }), summary: "Change a member's role" }, async (ctx) => {
    const { user, role: myRole } = await app.requireOrg(ctx, ctx.params.orgId!, "members.manage");
    const target = await app.roleIn(ctx.params.userId!, ctx.params.orgId!);
    if (!target) throw new HttpError(404, "not_found", "member not found");
    if ((target === "owner" || ctx.body.role === "owner") && myRole !== "owner") throw new HttpError(403, "forbidden", "only owners can grant or change the owner role");
    await app.sql.transaction(async (tx) => {
      await tx.query("UPDATE memberships SET role = $3 WHERE org_id = $1 AND user_id = $2", [ctx.params.orgId!, ctx.params.userId!, ctx.body.role]);
      const owners = await tx.query<{ n: string }>("SELECT count(*) AS n FROM memberships WHERE org_id = $1 AND role = 'owner'", [ctx.params.orgId!]);
      if (Number(owners.rows[0]!.n) < 1) throw new HttpError(409, "last_owner", "an organisation needs at least one owner");
      await audit(tx, user.id, ctx.params.orgId!, "org.member_role", { userId: ctx.params.userId!, role: ctx.body.role });
    });
    return { ok: true };
  });

  r.add("DELETE", "/v1/orgs/:orgId/members/:userId", { summary: "Remove a member (or leave, when it is you)" }, async (ctx) => {
    const u = await app.requireUser(ctx);
    const leaving = u.id === ctx.params.userId!;
    const { role: myRole } = leaving ? { role: await app.roleIn(u.id, ctx.params.orgId!) } : await app.requireOrg(ctx, ctx.params.orgId!, "members.manage");
    if (!myRole) throw new HttpError(404, "not_found", "organisation not found");
    const target = await app.roleIn(ctx.params.userId!, ctx.params.orgId!);
    if (!target) throw new HttpError(404, "not_found", "member not found");
    if (target === "owner" && myRole !== "owner") throw new HttpError(403, "forbidden", "only owners can remove an owner");
    await app.sql.transaction(async (tx) => {
      await tx.query("DELETE FROM memberships WHERE org_id = $1 AND user_id = $2", [ctx.params.orgId!, ctx.params.userId!]);
      const owners = await tx.query<{ n: string }>("SELECT count(*) AS n FROM memberships WHERE org_id = $1 AND role = 'owner'", [ctx.params.orgId!]);
      if (Number(owners.rows[0]!.n) < 1) throw new HttpError(409, "last_owner", "an organisation needs at least one owner; transfer ownership first");
      await audit(tx, u.id, ctx.params.orgId!, leaving ? "org.member_left" : "org.member_removed", { userId: ctx.params.userId! });
    });
    return { ok: true };
  });
}
