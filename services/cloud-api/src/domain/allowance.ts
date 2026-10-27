import type { AutoDirectorAllowance, Plan, SubscriptionStatus, UsageBatchResult, UsageRecord } from "@matchframe/cloud-contracts";
import type { Queryable } from "../db/sql.ts";
import { newId } from "../ids.ts";
import { getPlan } from "./plans.ts";

/** Subscription states that keep the paid plan (past_due keeps access during Stripe's retry period). */
const PAID_STATES = new Set(["active", "trialing", "past_due"]);

export interface OrgPlanState {
  plan: Plan;
  subscriptionStatus: SubscriptionStatus;
  periodStart: Date;
  periodEnd: Date;
  cancelAtPeriodEnd: boolean;
  /** Set by staff on the website: wins over Stripe until staff remove it. */
  override: SubscriptionOverride | null;
  /** What Stripe last reported (null when the organisation never subscribed). Kept up to date under an override. */
  stripe: { planId: string; status: SubscriptionStatus } | null;
}

export interface SubscriptionOverride {
  planId: string;
  status: SubscriptionStatus;
  note: string;
  createdBy: string;
  createdAt: Date;
}

export const isPaidStatus = (status: string): boolean => PAID_STATES.has(status);

export function calendarMonth(now: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

export async function orgPlanState(db: Queryable, orgId: string, now: Date): Promise<OrgPlanState> {
  const { rows } = await db.query<{
    plan_id: string | null;
    status: string | null;
    current_period_start: Date | null;
    current_period_end: Date | null;
    cancel_at_period_end: boolean | null;
    o_plan_id: string | null;
    o_status: string | null;
    o_note: string | null;
    o_created_by: string | null;
    o_created_at: Date | null;
  }>(
    `SELECT s.plan_id, s.status, s.current_period_start, s.current_period_end, s.cancel_at_period_end,
            v.plan_id AS o_plan_id, v.status AS o_status, v.note AS o_note, v.created_by AS o_created_by, v.created_at AS o_created_at
       FROM orgs o LEFT JOIN subscriptions s ON s.org_id = o.id LEFT JOIN subscription_overrides v ON v.org_id = o.id
      WHERE o.id = $1`,
    [orgId],
  );
  const r = rows[0];
  const stripe = r?.status ? { planId: r.plan_id!, status: r.status as SubscriptionStatus } : null;
  const override = r?.o_status ? { planId: r.o_plan_id!, status: r.o_status as SubscriptionStatus, note: r.o_note ?? "", createdBy: r.o_created_by ?? "", createdAt: r.o_created_at! } : null;
  const effective = override ?? stripe;
  const paid = !!effective && PAID_STATES.has(effective.status);
  const plan = (paid ? await getPlan(db, effective.planId) : null) ?? (await getPlan(db, "free"));
  if (!plan) throw new Error("plan catalogue is missing the free plan");
  // Stripe's billing period when it covers today (also under an override); otherwise the calendar month.
  const inPeriod = paid && r?.current_period_start && r.current_period_end && now >= r.current_period_start && now < r.current_period_end;
  const month = calendarMonth(now);
  return {
    plan,
    subscriptionStatus: effective?.status ?? "none",
    periodStart: inPeriod ? r.current_period_start! : month.start,
    periodEnd: inPeriod ? r.current_period_end! : month.end,
    cancelAtPeriodEnd: override ? false : (r?.cancel_at_period_end ?? false),
    override,
    stripe,
  };
}

async function availableCredits(db: Queryable, orgId: string, now: Date): Promise<{ id: string; remaining: number; expiresAt: Date | null }[]> {
  const { rows } = await db.query<{ id: string; seconds: string; expires_at: Date | null; used: string | null }>(
    `SELECT g.id, g.seconds, g.expires_at, (SELECT COALESCE(sum(d.seconds), 0) FROM credit_debits d WHERE d.grant_id = g.id) AS used
       FROM credit_grants g
      WHERE g.org_id = $1 AND (g.expires_at IS NULL OR g.expires_at > $2)
      ORDER BY g.expires_at NULLS LAST, g.created_at`,
    [orgId, now],
  );
  return rows.map((r) => ({ id: r.id, remaining: Number(r.seconds) - Number(r.used ?? 0), expiresAt: r.expires_at })).filter((g) => g.remaining > 0);
}

/**
 * A period's usage and the credits it consumed, both net of staff usage resets: a reset records
 * both at the time it was made, so the period starts again from zero without spent credits
 * counting twice.
 */
async function periodUsage(db: Queryable, orgId: string, start: Date, end: Date): Promise<{ used: number; creditsConsumed: number }> {
  const u = await db.query<{ s: string | null }>("SELECT sum(seconds) AS s FROM usage_records WHERE org_id = $1 AND started_at >= $2 AND started_at < $3", [orgId, start, end]);
  const c = await db.query<{ s: string | null }>("SELECT sum(d.seconds) AS s FROM credit_debits d JOIN credit_grants g ON g.id = d.grant_id WHERE g.org_id = $1 AND d.period_start = $2", [orgId, start]);
  const r = await db.query<{ s: string | null; c: string | null }>("SELECT sum(seconds) AS s, sum(credit_seconds) AS c FROM usage_resets WHERE org_id = $1 AND period_start = $2", [orgId, start]);
  return {
    used: Math.max(0, Number(u.rows[0]?.s ?? 0) - Number(r.rows[0]?.s ?? 0)),
    creditsConsumed: Math.max(0, Number(c.rows[0]?.s ?? 0) - Number(r.rows[0]?.c ?? 0)),
  };
}

/**
 * Staff reset of the current period's auto-director usage to zero (usage records are kept as
 * history). Serialised with usage uploads by the organisation row lock. Null when nothing is used.
 */
export async function resetPeriodUsage(tx: Queryable, orgId: string, now: Date, by: string, note: string): Promise<{ id: string; seconds: number; creditSeconds: number; periodStart: Date } | null> {
  await tx.query("SELECT id FROM orgs WHERE id = $1 FOR UPDATE", [orgId]);
  const st = await orgPlanState(tx, orgId, now);
  const { used, creditsConsumed } = await periodUsage(tx, orgId, st.periodStart, st.periodEnd);
  if (used === 0 && creditsConsumed === 0) return null;
  const id = newId("rst");
  await tx.query("INSERT INTO usage_resets (id, org_id, period_start, seconds, credit_seconds, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)", [id, orgId, st.periodStart, used, creditsConsumed, note, by]);
  return { id, seconds: used, creditSeconds: creditsConsumed, periodStart: st.periodStart };
}

/** Staff usage resets of the period starting at `periodStart`, newest first. */
export async function usageResetsFor(db: Queryable, orgId: string, periodStart: Date): Promise<{ id: string; seconds: number; note: string; createdBy: string; createdAt: Date }[]> {
  const { rows } = await db.query<{ id: string; seconds: string; note: string; created_by: string; created_at: Date }>("SELECT id, seconds, note, created_by, created_at FROM usage_resets WHERE org_id = $1 AND period_start = $2 ORDER BY created_at DESC", [orgId, periodStart]);
  return rows.map((x) => ({ id: x.id, seconds: Number(x.seconds), note: x.note, createdBy: x.created_by, createdAt: x.created_at }));
}

/**
 * remaining = max(0, included − used) + available credits − overage not yet covered by credits.
 * Usage beyond the included hours draws on credits (earliest expiry first) when it is ingested.
 */
export async function computeAllowance(db: Queryable, orgId: string, now: Date): Promise<AutoDirectorAllowance & { planState: OrgPlanState }> {
  const st = await orgPlanState(db, orgId, now);
  const included = Math.round(st.plan.includedAutoDirectorHours * 3600);
  const { used, creditsConsumed } = await periodUsage(db, orgId, st.periodStart, st.periodEnd);
  const credits = (await availableCredits(db, orgId, now)).reduce((s, g) => s + g.remaining, 0);
  const uncovered = Math.max(0, used - included - creditsConsumed);
  return {
    periodStart: st.periodStart.toISOString(),
    periodEnd: st.periodEnd.toISOString(),
    includedSeconds: st.plan.features.autoDirector ? included : 0,
    creditSeconds: credits,
    usedSeconds: used,
    remainingSeconds: st.plan.features.autoDirector ? Math.max(0, included - used) + credits - uncovered : 0,
    overageAllowed: false,
    planState: st,
  };
}

const MAX_SKEW_MS = 5 * 60_000;
const MAX_AGE_MS = 60 * 86_400_000;

export function validateRecord(r: UsageRecord, now: Date): string | null {
  const start = Date.parse(r.startedAt);
  const end = Date.parse(r.endedAt);
  if (!(end >= start)) return "endedAt is before startedAt";
  if (r.seconds > (end - start) / 1000 + 5) return "seconds exceed the recorded interval";
  if (end > now.getTime() + MAX_SKEW_MS) return "record ends in the future (check the computer clock)";
  if (start < now.getTime() - MAX_AGE_MS) return "record is older than 60 days";
  return null;
}

/**
 * Idempotent ingestion for one device. Serialised per organisation (row lock) so concurrent
 * uploads from several computers cannot double-spend credits.
 */
export async function ingestUsage(tx: Queryable, orgId: string, deviceId: string, records: UsageRecord[], now: Date): Promise<UsageBatchResult> {
  await tx.query("SELECT id FROM orgs WHERE id = $1 FOR UPDATE", [orgId]);
  const out: UsageBatchResult = { accepted: [], duplicates: [], rejected: [] };
  const st = await orgPlanState(tx, orgId, now);
  const included = Math.round(st.plan.includedAutoDirectorHours * 3600);
  for (const r of records) {
    const bad = validateRecord(r, now);
    if (bad) {
      out.rejected.push({ recordId: r.recordId, reason: bad });
      continue;
    }
    const ins = await tx.query<{ record_id: string }>(
      `INSERT INTO usage_records (org_id, device_id, record_id, kind, started_at, ended_at, seconds, session_id, match_ref, map_name, app_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (device_id, record_id) DO NOTHING RETURNING record_id`,
      [orgId, deviceId, r.recordId, r.kind, r.startedAt, r.endedAt, r.seconds, r.sessionId, r.matchRef, r.mapName, r.appVersion],
    );
    if (!ins.rows[0]) {
      out.duplicates.push(r.recordId);
      continue;
    }
    out.accepted.push(r.recordId);
    // Records outside the current period (late uploads) are charged against the calendar month they started in.
    const started = new Date(r.startedAt);
    const inCurrent = started >= st.periodStart && started < st.periodEnd;
    const pStart = inCurrent ? st.periodStart : new Date(Date.UTC(started.getUTCFullYear(), started.getUTCMonth(), 1));
    const pEnd = inCurrent ? st.periodEnd : new Date(Date.UTC(started.getUTCFullYear(), started.getUTCMonth() + 1, 1));
    const { used, creditsConsumed } = await periodUsage(tx, orgId, pStart, pEnd);
    let need = Math.max(0, used - included - creditsConsumed);
    for (const g of await availableCredits(tx, orgId, now)) {
      if (need <= 0) break;
      const take = Math.min(need, g.remaining);
      await tx.query("INSERT INTO credit_debits (grant_id, device_id, record_id, seconds, period_start) VALUES ($1, $2, $3, $4, $5)", [g.id, deviceId, r.recordId, take, pStart]);
      need -= take;
    }
  }
  await tx.query("UPDATE devices SET last_seen_at = now() WHERE id = $1", [deviceId]);
  return out;
}
