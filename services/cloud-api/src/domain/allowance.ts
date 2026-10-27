import type { AutoDirectorAllowance, Plan, SubscriptionStatus, UsageBatchResult, UsageRecord } from "@matchframe/cloud-contracts";
import type { Queryable } from "../db/sql.ts";
import { getPlan } from "./plans.ts";

/** Subscription states that keep the paid plan (past_due keeps access during Stripe's retry period). */
const PAID_STATES = new Set(["active", "trialing", "past_due"]);

export interface OrgPlanState {
  plan: Plan;
  subscriptionStatus: SubscriptionStatus;
  periodStart: Date;
  periodEnd: Date;
  cancelAtPeriodEnd: boolean;
}

export function calendarMonth(now: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

export async function orgPlanState(db: Queryable, orgId: string, now: Date): Promise<OrgPlanState> {
  const { rows } = await db.query<{ plan_id: string; status: string; current_period_start: Date | null; current_period_end: Date | null; cancel_at_period_end: boolean }>(
    "SELECT plan_id, status, current_period_start, current_period_end, cancel_at_period_end FROM subscriptions WHERE org_id = $1",
    [orgId],
  );
  const sub = rows[0];
  const paid = sub && PAID_STATES.has(sub.status);
  const plan = (paid ? await getPlan(db, sub.plan_id) : null) ?? (await getPlan(db, "free"));
  if (!plan) throw new Error("plan catalogue is missing the free plan");
  const inPeriod = paid && sub.current_period_start && sub.current_period_end && now >= sub.current_period_start && now < sub.current_period_end;
  const month = calendarMonth(now);
  return {
    plan,
    subscriptionStatus: (sub?.status as SubscriptionStatus | undefined) ?? "none",
    periodStart: inPeriod ? sub.current_period_start! : month.start,
    periodEnd: inPeriod ? sub.current_period_end! : month.end,
    cancelAtPeriodEnd: sub?.cancel_at_period_end ?? false,
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

async function periodUsage(db: Queryable, orgId: string, start: Date, end: Date): Promise<{ used: number; creditsConsumed: number }> {
  const u = await db.query<{ s: string | null }>("SELECT sum(seconds) AS s FROM usage_records WHERE org_id = $1 AND started_at >= $2 AND started_at < $3", [orgId, start, end]);
  const c = await db.query<{ s: string | null }>("SELECT sum(d.seconds) AS s FROM credit_debits d JOIN credit_grants g ON g.id = d.grant_id WHERE g.org_id = $1 AND d.period_start = $2", [orgId, start]);
  return { used: Number(u.rows[0]?.s ?? 0), creditsConsumed: Number(c.rows[0]?.s ?? 0) };
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
