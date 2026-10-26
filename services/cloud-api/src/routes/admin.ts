import { z } from "zod";
import { HourPack, Plan } from "@matchframe/cloud-contracts";
import type { CloudApp } from "../app.ts";
import { audit } from "../domain/audit.ts";
import { computeAllowance } from "../domain/allowance.ts";
import { listHourPacks, listPlans, upsertHourPack, upsertPlan } from "../domain/plans.ts";
import type { Router } from "../http/router.ts";
import { HttpError } from "../http/router.ts";
import { newId } from "../ids.ts";

/** Staff-only administration (users with staff=true, see MF_STAFF_EMAILS). */
export function registerAdminRoutes(r: Router, app: CloudApp): void {
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
      out.push({ id: o.id, name: o.name, createdAt: o.created_at.toISOString(), ownerEmail: o.owner_email, members: Number(o.members), devices: Number(o.devices), planId: planState.plan.id, subscriptionStatus: planState.subscriptionStatus, usedSeconds: a.usedSeconds, remainingSeconds: a.remainingSeconds });
    }
    return out;
  });

  r.add("POST", "/v1/admin/orgs/:orgId/credits", { body: z.object({ hours: z.number().positive().max(10000), note: z.string().trim().min(3).max(200), expiresAt: z.string().datetime().nullable().default(null) }), summary: "Staff: grant auto-director hours (support credit, trial extension)" }, async (ctx) => {
    const staff = await app.requireStaff(ctx);
    const { rows } = await app.sql.query<{ id: string }>("SELECT id FROM orgs WHERE id = $1", [ctx.params.orgId!]);
    if (!rows[0]) throw new HttpError(404, "not_found", "organisation not found");
    const id = newId("crd");
    await app.sql.query("INSERT INTO credit_grants (id, org_id, seconds, source, expires_at, created_by, note) VALUES ($1, $2, $3, 'grant', $4, $5, $6)", [id, ctx.params.orgId!, Math.round(ctx.body.hours * 3600), ctx.body.expiresAt, staff.id, ctx.body.note]);
    await audit(app.sql, staff.id, ctx.params.orgId!, "admin.credit_granted", ctx.body);
    return { id };
  });

  r.add("GET", "/v1/admin/catalog", { summary: "Staff: full plan and hour-pack catalogue including Stripe price ids" }, async (ctx) => {
    await app.requireStaff(ctx);
    return { plans: await listPlans(app.sql), hourPacks: await listHourPacks(app.sql) };
  });

  r.add("PUT", "/v1/admin/plans/:planId", { body: Plan, summary: "Staff: create or edit a plan" }, async (ctx) => {
    const staff = await app.requireStaff(ctx);
    if (ctx.body.id !== ctx.params.planId!) throw new HttpError(400, "id_mismatch", "plan id in the body must match the URL");
    await upsertPlan(app.sql, ctx.body);
    await audit(app.sql, staff.id, null, "admin.plan_saved", ctx.body);
    return ctx.body;
  });

  r.add("PUT", "/v1/admin/hour-packs/:packId", { body: HourPack, summary: "Staff: create or edit an hour pack" }, async (ctx) => {
    const staff = await app.requireStaff(ctx);
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

  r.add("GET", "/v1/admin/stripe-events", { summary: "Staff: recent Stripe webhook events and processing errors" }, async (ctx) => {
    await app.requireStaff(ctx);
    const { rows } = await app.sql.query<{ id: string; type: string; received_at: Date; processed_at: Date | null; error: string | null }>("SELECT id, type, received_at, processed_at, error FROM stripe_events ORDER BY received_at DESC LIMIT 200");
    return rows.map((e) => ({ id: e.id, type: e.type, receivedAt: e.received_at.toISOString(), processedAt: e.processed_at?.toISOString() ?? null, error: e.error }));
  });
}
