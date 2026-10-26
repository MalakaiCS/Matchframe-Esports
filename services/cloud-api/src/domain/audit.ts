import type { Queryable } from "../db/sql.ts";

export async function audit(db: Queryable, actor: string, orgId: string | null, action: string, detail: unknown = null): Promise<void> {
  await db.query("INSERT INTO audit_log (actor, org_id, action, detail) VALUES ($1, $2, $3, $4)", [actor, orgId, action, detail === null ? null : JSON.stringify(detail)]);
}
