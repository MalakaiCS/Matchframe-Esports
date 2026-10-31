import { SYNC_ITEM_MAX_BYTES, SyncKind } from "@matchframe/cloud-contracts";
import type { SyncChange, SyncChanges, SyncItem, SyncPushResult, SyncStatus } from "@matchframe/cloud-contracts";
import type { Queryable } from "../db/sql.ts";

/**
 * Account sync (shared by every computer linked to an organisation). Items are stored as sent
 * (`data` is `json`, not `jsonb`, so keys keep their order); files are stored once per
 * organisation by SHA-256.
 */

/** A file no live item names is kept this long, so a computer can upload files before the push that names them. */
export const BLOB_GRACE_MS = 60 * 60_000;

interface ItemRow {
  kind: SyncKind;
  id: string;
  data: Record<string, unknown> | null;
  blobs: string[];
  seq: number | string;
  edited_at: Date;
  device_id: string;
  device_name: string;
}

const ITEM_COLUMNS = "kind, id, data, blobs, seq, edited_at, device_id, device_name";

const toItem = (r: ItemRow): SyncItem => ({ kind: r.kind, id: r.id, data: r.data, blobs: r.blobs, seq: Number(r.seq), editedAt: r.edited_at.toISOString(), deviceId: r.device_id, deviceName: r.device_name });

/**
 * Takes the organisation's sync lock (its counter row, created on first use) and returns its
 * latest seq. Pushes, file uploads and the clean-up hold it until they commit. Pushes therefore
 * take seqs one transaction at a time and commit in seq order, so a computer that has read up to
 * seq n never later sees a change below n appear (on Postgres, where transactions run in parallel).
 */
export async function lockSync(tx: Queryable, orgId: string): Promise<number> {
  const select = () => tx.query<{ seq: number | string }>("SELECT seq FROM sync_counters WHERE org_id = $1 FOR UPDATE", [orgId]);
  let { rows } = await select();
  if (!rows[0]) {
    await tx.query("INSERT INTO sync_counters (org_id) VALUES ($1) ON CONFLICT (org_id) DO NOTHING", [orgId]);
    ({ rows } = await select());
  }
  return Number(rows[0]!.seq);
}

/** The organisation's items changed after `since`, oldest first. */
export async function listChanges(db: Queryable, orgId: string, since: number, limit: number): Promise<SyncChanges> {
  const { rows } = await db.query<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM sync_items WHERE org_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`, [orgId, since, limit + 1]);
  const items = rows.slice(0, limit).map(toItem);
  return { items, cursor: items.at(-1)?.seq ?? since, more: rows.length > limit };
}

async function firstMissingBlob(tx: Queryable, orgId: string, blobs: string[]): Promise<string | null> {
  if (blobs.length === 0) return null;
  const { rows } = await tx.query<{ sha256: string }>("SELECT sha256 FROM sync_blobs WHERE org_id = $1 AND sha256 IN (SELECT jsonb_array_elements_text($2::jsonb))", [orgId, JSON.stringify(blobs)]);
  const have = new Set(rows.map((r) => r.sha256));
  return blobs.find((b) => !have.has(b)) ?? null;
}

/**
 * Applies a computer's changes in order (call inside a transaction). A change is stale when the
 * item changed after the version the computer had (`baseSeq`) by an edit made later than this
 * one: the last edit wins. A deletion (`data: null`) is kept as a tombstone.
 */
export async function pushChanges(tx: Queryable, device: { deviceId: string; orgId: string; name: string }, changes: SyncChange[], now: Date): Promise<SyncPushResult> {
  const start = await lockSync(tx, device.orgId);
  let seq = start;
  const results: SyncPushResult["results"] = [];
  for (const c of changes) {
    const cur = (await tx.query<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM sync_items WHERE org_id = $1 AND kind = $2 AND id = $3 FOR UPDATE`, [device.orgId, c.kind, c.id])).rows[0];
    // An edit stamped later than now (a computer whose clock is ahead) counts as made now.
    const editedAt = new Date(Math.min(Date.parse(c.editedAt), now.getTime()));
    if (cur && Number(cur.seq) > (c.baseSeq ?? 0) && cur.edited_at.getTime() > editedAt.getTime()) {
      results.push({ kind: c.kind, id: c.id, status: "stale", item: toItem(cur), reason: null });
      continue;
    }
    const blobs = c.data === null ? [] : c.blobs;
    if (c.data !== null) {
      let reason: string | null = null;
      const size = Buffer.byteLength(JSON.stringify(c.data));
      if (size > SYNC_ITEM_MAX_BYTES) reason = `too_large ${size}`;
      else {
        const missing = await firstMissingBlob(tx, device.orgId, blobs);
        if (missing) reason = `missing_blob ${missing}`;
      }
      if (reason) {
        results.push({ kind: c.kind, id: c.id, status: "rejected", item: null, reason });
        continue;
      }
    }
    seq += 1;
    await tx.query(
      `INSERT INTO sync_items (org_id, kind, id, data, blobs, seq, edited_at, device_id, device_name) VALUES ($1, $2, $3, $4::json, $5::jsonb, $6, $7, $8, $9)
       ON CONFLICT (org_id, kind, id) DO UPDATE SET data = EXCLUDED.data, blobs = EXCLUDED.blobs, seq = EXCLUDED.seq, edited_at = EXCLUDED.edited_at, device_id = EXCLUDED.device_id, device_name = EXCLUDED.device_name`,
      [device.orgId, c.kind, c.id, c.data === null ? null : JSON.stringify(c.data), JSON.stringify(blobs), seq, editedAt, device.deviceId, device.name],
    );
    const item: SyncItem = { kind: c.kind, id: c.id, data: c.data, blobs, seq, editedAt: editedAt.toISOString(), deviceId: device.deviceId, deviceName: device.name };
    results.push({ kind: c.kind, id: c.id, status: "applied", item, reason: null });
  }
  if (seq !== start) await tx.query("UPDATE sync_counters SET seq = $2 WHERE org_id = $1", [device.orgId, seq]);
  return { results, cursor: seq };
}

/** Bytes of files the organisation keeps. */
export async function blobBytes(db: Queryable, orgId: string): Promise<number> {
  const { rows } = await db.query<{ n: number | string }>("SELECT COALESCE(sum(size), 0) AS n FROM sync_blobs WHERE org_id = $1", [orgId]);
  return Number(rows[0]!.n);
}

/** True when the organisation has the file; it then counts as just uploaded (the clean-up leaves it another hour). */
export async function touchBlob(db: Queryable, orgId: string, sha256: string, now: Date): Promise<boolean> {
  const { rows } = await db.query("UPDATE sync_blobs SET uploaded_at = $3 WHERE org_id = $1 AND sha256 = $2 RETURNING sha256", [orgId, sha256, now]);
  return rows.length > 0;
}

/** Stores a file whose hash was checked (call inside a transaction). Refused when it would take the organisation over `quotaBytes`. */
export async function storeBlob(tx: Queryable, orgId: string, sha256: string, data: Buffer, quotaBytes: number, now: Date): Promise<{ stored: true } | { stored: false; usedBytes: number }> {
  await lockSync(tx, orgId);
  if (await touchBlob(tx, orgId, sha256, now)) return { stored: true };
  const used = await blobBytes(tx, orgId);
  if (used + data.length > quotaBytes) return { stored: false, usedBytes: used };
  await tx.query("INSERT INTO sync_blobs (org_id, sha256, size, data, uploaded_at) VALUES ($1, $2, $3, $4, $5)", [orgId, sha256, data.length, data, now]);
  return { stored: true };
}

export async function readBlob(db: Queryable, orgId: string, sha256: string): Promise<Buffer | null> {
  const { rows } = await db.query<{ data: Uint8Array }>("SELECT data FROM sync_blobs WHERE org_id = $1 AND sha256 = $2", [orgId, sha256]);
  const d = rows[0]?.data;
  return d ? Buffer.from(d.buffer, d.byteOffset, d.byteLength) : null;
}

/** Deletes the organisation's files that no live item names once they are older than the grace period (call inside a transaction). */
export async function cleanUnusedBlobs(tx: Queryable, orgId: string, now: Date): Promise<number> {
  await lockSync(tx, orgId);
  const { rows } = await tx.query(
    `DELETE FROM sync_blobs b WHERE b.org_id = $1 AND b.uploaded_at < $2
       AND NOT EXISTS (SELECT 1 FROM sync_items i WHERE i.org_id = b.org_id AND i.data IS NOT NULL AND i.blobs ? b.sha256)
     RETURNING b.sha256`,
    [orgId, new Date(now.getTime() - BLOB_GRACE_MS)],
  );
  return rows.length;
}

/** Live items per kind, file bytes and the latest seq. */
export async function syncStatus(db: Queryable, orgId: string, quotaBytes: number): Promise<SyncStatus> {
  const counts = await db.query<{ kind: string; n: number | string }>("SELECT kind, count(*) AS n FROM sync_items WHERE org_id = $1 AND data IS NOT NULL GROUP BY kind", [orgId]);
  const counter = await db.query<{ seq: number | string }>("SELECT seq FROM sync_counters WHERE org_id = $1", [orgId]);
  const items = Object.fromEntries(SyncKind.options.map((k) => [k, 0])) as Record<SyncKind, number>;
  for (const r of counts.rows) if (r.kind in items) items[r.kind as SyncKind] = Number(r.n);
  return { cursor: Number(counter.rows[0]?.seq ?? 0), items, blobBytes: await blobBytes(db, orgId), quotaBytes };
}
