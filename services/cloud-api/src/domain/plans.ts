import type { HourPack, Plan } from "@matchframe/cloud-contracts";
import { HourPack as HourPackSchema, Plan as PlanSchema } from "@matchframe/cloud-contracts";
import type { Queryable } from "../db/sql.ts";

/**
 * Placeholder catalogue seeded on first start. Names, prices and hours are the owner's business
 * decision: edit them in the admin pages (or the database). Charged prices come from Stripe via
 * the referenced price ids (set STRIPE_PRICE_* or edit in admin); display prices are informational.
 */
export function defaultPlans(env: NodeJS.ProcessEnv = process.env): Plan[] {
  return [
    { id: "free", name: "Free", description: "A small monthly allowance of auto-director hours to try automatic direction.", priceMonthlyCents: 0, currency: "usd", includedAutoDirectorHours: 2, features: { autoDirector: true, learnedDirectorShadow: false, maxDevices: 1, maxMembers: 2 }, stripePriceId: null, public: true, sortOrder: 0 },
    { id: "pro", name: "Pro", description: "For regular productions.", priceMonthlyCents: 4900, currency: "usd", includedAutoDirectorHours: 40, features: { autoDirector: true, learnedDirectorShadow: true, maxDevices: 2, maxMembers: 5 }, stripePriceId: env.STRIPE_PRICE_PRO || null, public: true, sortOrder: 1 },
    { id: "studio", name: "Studio", description: "For leagues and multi-stream studios.", priceMonthlyCents: 14900, currency: "usd", includedAutoDirectorHours: 150, features: { autoDirector: true, learnedDirectorShadow: true, maxDevices: 6, maxMembers: 20 }, stripePriceId: env.STRIPE_PRICE_STUDIO || null, public: true, sortOrder: 2 },
  ];
}

export function defaultHourPacks(env: NodeJS.ProcessEnv = process.env): HourPack[] {
  return [
    { id: "hours-10", name: "10 auto-director hours", hours: 10, priceCents: 1500, currency: "usd", stripePriceId: env.STRIPE_PRICE_PACK_10 || null, validDays: 365, public: true },
    { id: "hours-50", name: "50 auto-director hours", hours: 50, priceCents: 6000, currency: "usd", stripePriceId: env.STRIPE_PRICE_PACK_50 || null, validDays: 365, public: true },
  ];
}

/**
 * Inserts the default catalogue once. Stripe price ids from the environment fill in entries that
 * have none yet (prices are often created after the first start); edits made by staff are kept.
 */
export async function seedCatalog(db: Queryable, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const fillPrice = "UPDATE %t SET data = jsonb_set(data, '{stripePriceId}', to_jsonb($2::text)) WHERE id = $1 AND data->>'stripePriceId' IS NULL";
  for (const p of defaultPlans(env)) {
    await db.query("INSERT INTO plans (id, data) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [p.id, JSON.stringify(p)]);
    if (p.stripePriceId) await db.query(fillPrice.replace("%t", "plans"), [p.id, p.stripePriceId]);
  }
  for (const h of defaultHourPacks(env)) {
    await db.query("INSERT INTO hour_packs (id, data) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [h.id, JSON.stringify(h)]);
    if (h.stripePriceId) await db.query(fillPrice.replace("%t", "hour_packs"), [h.id, h.stripePriceId]);
  }
}

export async function listPlans(db: Queryable): Promise<Plan[]> {
  const { rows } = await db.query<{ data: unknown }>("SELECT data FROM plans");
  return rows.map((r) => PlanSchema.parse(r.data)).sort((a, b) => a.sortOrder - b.sortOrder);
}

export async function getPlan(db: Queryable, id: string): Promise<Plan | null> {
  const { rows } = await db.query<{ data: unknown }>("SELECT data FROM plans WHERE id = $1", [id]);
  return rows[0] ? PlanSchema.parse(rows[0].data) : null;
}

export async function listHourPacks(db: Queryable): Promise<HourPack[]> {
  const { rows } = await db.query<{ data: unknown }>("SELECT data FROM hour_packs");
  return rows.map((r) => HourPackSchema.parse(r.data)).sort((a, b) => a.hours - b.hours);
}

export async function getHourPack(db: Queryable, id: string): Promise<HourPack | null> {
  const { rows } = await db.query<{ data: unknown }>("SELECT data FROM hour_packs WHERE id = $1", [id]);
  return rows[0] ? HourPackSchema.parse(rows[0].data) : null;
}

export async function upsertPlan(db: Queryable, plan: Plan): Promise<void> {
  await db.query("INSERT INTO plans (id, data, updated_at) VALUES ($1, $2, now()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()", [plan.id, JSON.stringify(PlanSchema.parse(plan))]);
}

export async function upsertHourPack(db: Queryable, pack: HourPack): Promise<void> {
  await db.query("INSERT INTO hour_packs (id, data, updated_at) VALUES ($1, $2, now()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()", [pack.id, JSON.stringify(HourPackSchema.parse(pack))]);
}
