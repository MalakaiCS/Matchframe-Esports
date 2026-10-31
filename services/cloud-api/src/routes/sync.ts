import { createHash } from "node:crypto";
import { SYNC_BLOB_MAX_BYTES, SYNC_ITEM_MAX_BYTES, Sha256, SyncPush } from "@matchframe/cloud-contracts";
import type { SyncChanges, SyncPushResult, SyncStatus } from "@matchframe/cloud-contracts";
import type { CloudApp, DeviceAuth } from "../app.ts";
import { blobBytes, cleanUnusedBlobs, listChanges, pushChanges, readBlob, storeBlob, syncStatus, touchBlob } from "../domain/sync.ts";
import type { Ctx, Router } from "../http/router.ts";
import { HttpError, reply } from "../http/router.ts";

/** Largest push: the most changes one may carry (200, SyncPush), each with the largest record and room for the rest of the change. */
export const SYNC_PUSH_MAX_BYTES = 200 * (SYNC_ITEM_MAX_BYTES + 8 * 1024);
const CLEAN_INTERVAL_MS = 60_000;

function sizeText(bytes: number): string {
  const [v, unit] = bytes >= 1024 ** 3 ? [bytes / 1024 ** 3, "GB"] : bytes >= 1024 ** 2 ? [bytes / 1024 ** 2, "MB"] : [bytes / 1024, "KB"];
  return `${Math.round(v * 10) / 10} ${unit}`;
}

function intParam(ctx: Ctx, name: string, fallback: number): number {
  const v = ctx.query.get(name);
  if (v === null || v === "") return fallback;
  const n = Number(v);
  if (!/^\d+$/.test(v) || !Number.isSafeInteger(n)) throw new HttpError(400, "bad_query", `${name} must be a whole number`);
  return n;
}

function shaParam(ctx: Ctx): string {
  const sha = ctx.params.sha256 ?? "";
  if (!Sha256.safeParse(sha).success) throw new HttpError(400, "bad_sha256", "a shared file is named by its SHA-256: 64 lowercase hexadecimal characters");
  return sha;
}

const quotaError = (used: number, size: number, quota: number) =>
  new HttpError(413, "quota_exceeded", `this organisation's shared files would go over its ${sizeText(quota)} limit (${sizeText(used)} used, this file is ${sizeText(size)}); remove HUDs or pictures you no longer need, and their space is freed about an hour later`, {
    usedBytes: used,
    fileBytes: size,
    quotaBytes: quota,
  });

/**
 * Account sync: players, teams, matches and imported HUDs shared by every computer linked to an
 * organisation. Computers use their device token; an organisation only ever sees its own items
 * and files. The website shows a summary to the organisation's members.
 */
export function registerSyncRoutes(r: Router, app: CloudApp): void {
  const cleanedAt = new Map<string, number>();

  const device = async (ctx: Ctx): Promise<DeviceAuth> => {
    const d = await app.requireDevice(ctx);
    app.rateLimit(app.limits.sync, `sync:${d.deviceId}`);
    return d;
  };

  /** After a push, at most once a minute per organisation. A failure is logged; the push stands. */
  const cleanUp = async (orgId: string) => {
    const now = app.now();
    if (now.getTime() - (cleanedAt.get(orgId) ?? 0) < CLEAN_INTERVAL_MS) return;
    cleanedAt.set(orgId, now.getTime());
    try {
      await app.sql.transaction((tx) => cleanUnusedBlobs(tx, orgId, now));
    } catch (e) {
      console.error("[cloud-api] sync clean-up:", e);
    }
  };

  r.add("GET", "/v1/sync/changes", { summary: "Desktop: the organisation's shared items changed after a cursor (?since=<seq>&limit=<n>, oldest first)" }, async (ctx) => {
    const d = await device(ctx);
    const since = intParam(ctx, "since", 0);
    const limit = Math.min(intParam(ctx, "limit", 500), 1000);
    if (limit < 1) throw new HttpError(400, "bad_query", "limit must be at least 1");
    const out: SyncChanges = await listChanges(app.sql, d.orgId, since, limit);
    return out;
  });

  r.add(
    "POST",
    "/v1/sync/push",
    { body: SyncPush, lazyBody: { maxBytes: SYNC_PUSH_MAX_BYTES }, browserMutation: false, summary: "Desktop: send local changes; each is applied, stale (a later edit won) or rejected" },
    async (ctx) => {
      const d = await device(ctx);
      const { body } = await ctx.readBody();
      const out: SyncPushResult = await app.sql.transaction((tx) => pushChanges(tx, d, body.changes, app.now()));
      await cleanUp(d.orgId);
      return out;
    },
  );

  r.add(
    "PUT",
    "/v1/sync/blobs/:sha256",
    { lazyBody: { maxBytes: SYNC_BLOB_MAX_BYTES }, browserMutation: false, summary: "Desktop: upload a shared file (raw bytes, named by their SHA-256, up to 60 MB)" },
    async (ctx) => {
      const d = await device(ctx);
      const sha = shaParam(ctx);
      const now = app.now();
      const quota = app.cfg.syncQuotaBytes;
      // Already shared: nothing to take in (the rest of the upload is discarded).
      if (await touchBlob(app.sql, d.orgId, sha, now)) return reply({ status: 204 });
      const declared = Number(ctx.headers["content-length"]);
      if (Number.isSafeInteger(declared) && declared <= SYNC_BLOB_MAX_BYTES) {
        const used = await blobBytes(app.sql, d.orgId);
        if (used + declared > quota) throw quotaError(used, declared, quota);
      }
      let raw: Buffer;
      try {
        ({ raw } = await ctx.readBody());
      } catch (e) {
        if (e instanceof HttpError && e.code === "too_large") throw new HttpError(413, "too_large", `a shared file can be at most ${sizeText(SYNC_BLOB_MAX_BYTES)}`);
        throw e;
      }
      if (createHash("sha256").update(raw).digest("hex") !== sha) throw new HttpError(400, "sha256_mismatch", "the file's SHA-256 doesn't match the name it was uploaded under");
      const stored = await app.sql.transaction((tx) => storeBlob(tx, d.orgId, sha, raw, quota, now));
      if (!stored.stored) throw quotaError(stored.usedBytes, raw.length, quota);
      return reply({ status: 204 });
    },
  );

  r.add("GET", "/v1/sync/blobs/:sha256", { summary: "Desktop: download a shared file (raw bytes)" }, async (ctx) => {
    const d = await device(ctx);
    const data = await readBlob(app.sql, d.orgId, shaParam(ctx));
    if (!data) throw new HttpError(404, "not_found", "this organisation has no shared file with that SHA-256");
    return reply({ body: data, contentType: "application/octet-stream", headers: { "content-length": String(data.length), "cache-control": "no-store" } });
  });

  r.add("GET", "/v1/sync/status", { summary: "Desktop: the organisation's shared items per kind, file bytes, quota and latest cursor" }, async (ctx) => {
    const d = await device(ctx);
    const out: SyncStatus = await syncStatus(app.sql, d.orgId, app.cfg.syncQuotaBytes);
    return out;
  });

  r.add("GET", "/v1/orgs/:orgId/sync", { summary: "What the organisation's computers share: items per kind, file bytes and quota" }, async (ctx) => {
    await app.requireOrg(ctx, ctx.params.orgId!, "org.view");
    const out: SyncStatus = await syncStatus(app.sql, ctx.params.orgId!, app.cfg.syncQuotaBytes);
    return out;
  });
}
