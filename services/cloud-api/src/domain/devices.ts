import type { Queryable } from "../db/sql.ts";
import { hashSecret, newId, newSecret } from "../ids.ts";

/**
 * Issues a computer's credential. Re-linking the same install replaces its old link. `userId` is
 * the account the computer is signed in as (who signed in, or who approved the link code).
 */
export async function issueDeviceCredential(
  tx: Queryable,
  d: { orgId: string; userId: string | null; installId: string; name: string; platform: string; appVersion: string },
  now: Date,
): Promise<{ deviceId: string; token: string }> {
  const token = `mfd_${newSecret()}`;
  const deviceId = newId("dev");
  await tx.query("UPDATE devices SET revoked_at = $3 WHERE org_id = $1 AND install_id = $2 AND revoked_at IS NULL", [d.orgId, d.installId, now]);
  await tx.query("INSERT INTO devices (id, org_id, name, platform, app_version, install_id, token_hash, approved_by, last_seen_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)", [
    deviceId,
    d.orgId,
    d.name,
    d.platform,
    d.appVersion,
    d.installId,
    hashSecret(token),
    d.userId,
    now,
  ]);
  return { deviceId, token };
}

/**
 * Signs a person's computers out (password changed or reset, account disabled, removed from an
 * organisation, staff "sign out everywhere"). The program keeps running until it is closed but
 * asks to sign in again; automation already running is never cut mid-map.
 */
export async function revokeComputersOf(db: Queryable, userId: string, now: Date, orgId: string | null = null): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `UPDATE devices SET revoked_at = $2 WHERE approved_by = $1 AND revoked_at IS NULL${orgId ? " AND org_id = $3" : ""} RETURNING id`,
    orgId ? [userId, now, orgId] : [userId, now],
  );
  return rows.length;
}
