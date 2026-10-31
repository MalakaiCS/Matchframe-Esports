import { createHash } from "node:crypto";
import { request } from "node:http";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYNC_BLOB_MAX_BYTES, SYNC_ITEM_MAX_BYTES } from "@matchframe/cloud-contracts";
import type { SyncChange, SyncChanges, SyncItem, SyncPushResult, SyncStatus } from "@matchframe/cloud-contracts";
import { CloudApp } from "../src/app.ts";
import { loadCloudConfig } from "../src/config.ts";
import { PgliteSql } from "../src/db/sql.ts";
import { HttpError, readBody } from "../src/http/router.ts";
import { SYNC_PUSH_MAX_BYTES } from "../src/routes/sync.ts";
import { startCloudServer } from "../src/server.ts";
import { Client, freePort } from "./http.ts";

const PASSWORD = "correct horse battery";
const QUOTA = 4 * 1024 * 1024;
const MINUTE = 60_000;

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const bytes = (n: number, seed: number) => Buffer.alloc(n, seed);
type ApiError = { error: string; message: string; detail: Record<string, number> | null };

describe("account sync: players, matches and HUDs shared by an organisation's computers (/v1/sync)", () => {
  let app: CloudApp;
  let close: () => Promise<void>;
  let base: string;
  let clock = Date.now();
  const at = (offsetMs = 0) => new Date(clock + offsetMs).toISOString();

  let owner: { client: Client; userId: string; orgId: string };
  let stranger: { client: Client; userId: string; orgId: string };
  /** Two computers in the owner's organisation, one in another organisation. */
  let a: Computer;
  let b: Computer;
  let other: Computer;

  class Computer {
    private readonly c = new Client(base, null);
    constructor(
      readonly token: string,
      readonly deviceId: string,
    ) {}
    private get auth() {
      return { authorization: `Bearer ${this.token}` };
    }
    changes(since = 0, limit?: number) {
      return this.c.req<SyncChanges & ApiError>("GET", `/v1/sync/changes?since=${since}${limit === undefined ? "" : `&limit=${limit}`}`, undefined, this.auth);
    }
    push(changes: (Partial<SyncChange> & Pick<SyncChange, "kind" | "id">)[]) {
      return this.c.req<SyncPushResult & ApiError>("POST", "/v1/sync/push", { changes: changes.map((ch) => ({ data: {}, blobs: [], baseSeq: null, editedAt: at(), ...ch })) }, this.auth);
    }
    /** Pushes one change and returns its result. */
    async one(change: Partial<SyncChange> & Pick<SyncChange, "kind" | "id">) {
      const r = await this.push([change]);
      expect(r.status).toBe(200);
      return r.data.results[0]!;
    }
    status() {
      return this.c.req<SyncStatus>("GET", "/v1/sync/status", undefined, this.auth);
    }
    putBlob(name: string, body: Buffer) {
      return fetch(`${base}/v1/sync/blobs/${name}`, { method: "PUT", headers: { ...this.auth, "content-type": "application/octet-stream" }, body });
    }
    getBlob(name: string) {
      return fetch(`${base}/v1/sync/blobs/${name}`, { headers: this.auth });
    }
  }

  const lastEmail = async (to: string) => (await app.sql.query<{ body_text: string }>("SELECT body_text FROM outbox_emails WHERE to_addr = $1 ORDER BY id DESC LIMIT 1", [to])).rows[0]!;
  async function signup(email: string): Promise<{ client: Client; userId: string; orgId: string }> {
    const client = new Client(base);
    const r = await client.req<{ userId: string; orgId: string }>("POST", "/v1/auth/signup", { email, password: PASSWORD, displayName: email.split("@")[0], orgName: `${email} Org` });
    expect(r.status).toBe(201);
    const token = /token=([A-Za-z0-9_-]+)/.exec((await lastEmail(email)).body_text)![1]!;
    expect((await client.req("POST", "/v1/auth/verify-email", { token })).status).toBe(200);
    return { client, ...r.data };
  }
  async function signIn(email: string, installId: string, deviceName: string): Promise<Computer> {
    const r = await new Client(base, null).req<{ deviceToken: string; deviceId: string }>("POST", "/v1/device/login", { email, password: PASSWORD, deviceName, platform: "win32", appVersion: "0.10.0", installId });
    expect(r.status).toBe(200);
    return new Computer(r.data.deviceToken, r.data.deviceId);
  }

  /** A request through node:http, for headers fetch won't send (a declared length without the body) and chunked uploads. */
  function raw(method: string, path: string, headers: Record<string, string>, body?: Buffer): Promise<{ status: number; data: ApiError }> {
    return new Promise((resolve, reject) => {
      const req = request(`${base}${path}`, { method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({ status: res.statusCode!, data: JSON.parse(Buffer.concat(chunks).toString("utf8")) as ApiError });
          req.destroy();
        });
      });
      req.on("error", reject);
      if (body) req.end(body);
      else req.flushHeaders();
    });
  }

  beforeAll(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    app = new CloudApp(loadCloudConfig({}, { publicUrl: base, port, syncQuotaBytes: QUOTA }), { sql: new PgliteSql(), rateLimitScale: 100, now: () => new Date(clock) });
    await app.init();
    ({ close } = await startCloudServer(app));
    owner = await signup("sync-owner@example.com");
    // Pro allows two computers.
    await app.sql.query("INSERT INTO subscription_overrides (org_id, plan_id, status, note, created_by) VALUES ($1, 'pro', 'active', 'sync test', 'test')", [owner.orgId]);
    a = await signIn("sync-owner@example.com", "install-aaaaaaaaaaaaaaaa", "Desk A");
    b = await signIn("sync-owner@example.com", "install-bbbbbbbbbbbbbbbb", "Desk B");
    stranger = await signup("sync-other@example.com");
    other = await signIn("sync-other@example.com", "install-cccccccccccccccc", "Other desk");
  });

  afterAll(async () => {
    await close?.();
    await app?.close();
  });

  it("shares a change pushed on one computer with the organisation's other computers", async () => {
    const pushed = await a.one({ kind: "player", id: "p-nova", data: { name: "nova", steamId: "76561198000000001", country: "SE" }, editedAt: at(-1000) });
    expect(pushed).toEqual({
      kind: "player",
      id: "p-nova",
      status: "applied",
      reason: null,
      item: { kind: "player", id: "p-nova", data: { name: "nova", steamId: "76561198000000001", country: "SE" }, blobs: [], seq: 1, editedAt: at(-1000), deviceId: a.deviceId, deviceName: "Desk A" },
    });

    const seen = await b.changes(0);
    expect(seen.status).toBe(200);
    expect(seen.data).toEqual({ items: [pushed.item], cursor: 1, more: false });
    // The record comes back as it was sent, keys in the same order.
    expect(Object.keys(seen.data.items[0]!.data!)).toEqual(["name", "steamId", "country"]);
    expect((await b.changes(1)).data).toEqual({ items: [], cursor: 1, more: false });

    const st = await b.status();
    expect(st.data).toEqual({ cursor: 1, items: { team: 0, player: 1, roster: 0, event: 0, match: 0, map: 0, veto: 0, asset: 0, hud: 0 }, blobBytes: 0, quotaBytes: QUOTA });
  });

  it("pages through changes in seq order with a cursor", async () => {
    const start = (await a.status()).data.cursor;
    const r = await a.push(Array.from({ length: 25 }, (_, i) => ({ kind: "team" as const, id: `t-${i}`, data: { name: `Team ${i}` } })));
    expect(r.data.results.map((x) => x.item!.seq)).toEqual(Array.from({ length: 25 }, (_, i) => start + 1 + i));
    expect(r.data.cursor).toBe(start + 25);

    const pages: SyncItem[][] = [];
    let cursor = start;
    for (;;) {
      const page = await b.changes(cursor, 10);
      expect(page.status).toBe(200);
      pages.push(page.data.items);
      expect(page.data.cursor).toBe(page.data.items.at(-1)?.seq ?? cursor);
      cursor = page.data.cursor;
      if (!page.data.more) break;
    }
    expect(pages.map((p) => p.length)).toEqual([10, 10, 5]);
    expect(pages.flat().map((x) => x.id)).toEqual(Array.from({ length: 25 }, (_, i) => `t-${i}`));
    expect(cursor).toBe(start + 25);
    expect((await b.changes(cursor, 10)).data).toEqual({ items: [], cursor, more: false });

    // The default page is up to 500; larger limits are capped at 1000; bad values are refused.
    expect((await b.changes(0)).data.items.length).toBe(start + 25);
    expect((await b.changes(0, 5000)).status).toBe(200);
    for (const q of ["since=-1", "since=abc", "limit=0", "limit=1.5"]) expect((await new Client(base, null).req<ApiError>("GET", `/v1/sync/changes?${q}`, undefined, { authorization: `Bearer ${a.token}` })).data.error).toBe("bad_query");
  });

  it("hands out seqs strictly in order with no gaps when computers push at once", async () => {
    const start = (await a.status()).data.cursor;
    const batch = (who: string, n: number) => Array.from({ length: n }, (_, i) => ({ kind: "event" as const, id: `${who}-${i}`, data: { n: i } }));
    const results = await Promise.all([a.push(batch("a1", 7)), b.push(batch("b1", 5)), a.push(batch("a2", 3)), b.push(batch("b2", 9))]);
    const seqs = results.flatMap((r) => r.data.results.map((x) => x.item!.seq)).sort((x, y) => x - y);
    expect(seqs).toEqual(Array.from({ length: 24 }, (_, i) => start + 1 + i));
    const listed = (await b.changes(start)).data.items.map((x) => x.seq);
    expect(listed).toEqual(seqs);
  });

  it("keeps the last edit: stale when another computer changed the item later, applied otherwise", async () => {
    const created = (await a.one({ kind: "match", id: "m-1", data: { title: "Alpha vs Bravo", bestOf: 3 }, editedAt: at(-10 * MINUTE) })).item!;
    // B saw that version and edits it.
    const bEdit = await b.one({ kind: "match", id: "m-1", data: { title: "Alpha vs Bravo", bestOf: 5 }, baseSeq: created.seq, editedAt: at(-5 * MINUTE) });
    expect(bEdit.status).toBe("applied");

    // A hasn't seen B's edit and its own edit is older: stale, with B's version to apply.
    const older = await a.one({ kind: "match", id: "m-1", data: { title: "A vs B" }, baseSeq: created.seq, editedAt: at(-7 * MINUTE) });
    expect(older).toEqual({ kind: "match", id: "m-1", status: "stale", item: bEdit.item, reason: null });
    // Not having the item at all (baseSeq null) is the same.
    expect((await a.one({ kind: "match", id: "m-1", data: { title: "A vs B" }, baseSeq: null, editedAt: at(-6 * MINUTE) })).status).toBe("stale");

    // A later edit wins even without having seen B's.
    const newer = await a.one({ kind: "match", id: "m-1", data: { title: "Alpha vs Bravo", bestOf: 1 }, baseSeq: created.seq, editedAt: at(-2 * MINUTE) });
    expect(newer.status).toBe("applied");
    expect(newer.item).toMatchObject({ data: { bestOf: 1 }, deviceName: "Desk A" });
    expect(newer.item!.seq).toBeGreaterThan(bEdit.item!.seq);

    // An edit made on the latest version applies whatever its time (the computer built on it).
    const onTop = await b.one({ kind: "match", id: "m-1", data: { title: "Final" }, baseSeq: newer.item!.seq, editedAt: at(-3 * MINUTE) });
    expect(onTop.status).toBe("applied");

    // A clock that runs ahead can't win every later conflict: its time counts as the server's.
    const ahead = await a.one({ kind: "match", id: "m-2", data: { title: "Later" }, editedAt: at(24 * 60 * MINUTE) });
    expect(ahead.item!.editedAt).toBe(at());

    // A stale-only push still reports the organisation's cursor.
    const stale = await a.push([{ kind: "match", id: "m-1", data: { title: "x" }, baseSeq: created.seq, editedAt: at(-60 * MINUTE) }]);
    expect(stale.data).toMatchObject({ results: [{ status: "stale" }], cursor: (await a.status()).data.cursor });
  });

  it("keeps deletions as tombstones so the other computers delete the item too", async () => {
    const made = await a.one({ kind: "roster", id: "r-1", data: { team: "t-1", players: ["p-nova"] } });
    const before = (await b.status()).data;
    const del = await b.one({ kind: "roster", id: "r-1", data: null, blobs: [], baseSeq: made.item!.seq });
    expect(del).toMatchObject({ status: "applied", item: { kind: "roster", id: "r-1", data: null, blobs: [], deviceName: "Desk B" } });

    const seen = await a.changes(made.item!.seq);
    expect(seen.data.items).toEqual([del.item]);
    const after = (await b.status()).data;
    expect(after.items.roster).toBe(before.items.roster - 1);
    expect(after.cursor).toBe(del.item!.seq);

    // Deleting something the organisation never had is kept too; recreating a deleted item works.
    expect((await a.one({ kind: "veto", id: "v-never", data: null })).status).toBe("applied");
    expect((await a.one({ kind: "roster", id: "r-1", data: { team: "t-1", players: [] }, baseSeq: del.item!.seq })).status).toBe("applied");
    expect((await b.status()).data.items.roster).toBe(before.items.roster);
  });

  it("stores files by SHA-256: checks the hash, takes a file once, and refuses items naming files not uploaded", async () => {
    const hud = bytes(300_000, 7);
    const hudSha = sha(hud);

    const wrong = await a.putBlob(sha(bytes(10, 1)), hud);
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as ApiError).error).toBe("sha256_mismatch");
    expect(((await (await a.putBlob(hudSha.toUpperCase(), hud)).json()) as ApiError).error).toBe("bad_sha256");
    expect((await a.getBlob("nope")).status).toBe(400);

    // An item naming a file not uploaded yet is refused (the computer uploads it and pushes again).
    const early = await a.one({ kind: "hud", id: "h-1", data: { name: "Vector" }, blobs: [hudSha] });
    expect(early).toEqual({ kind: "hud", id: "h-1", status: "rejected", item: null, reason: `missing_blob ${hudSha}` });

    expect((await a.putBlob(hudSha, hud)).status).toBe(204);
    const got = await b.getBlob(hudSha);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("application/octet-stream");
    expect(got.headers.get("content-length")).toBe(String(hud.length));
    expect(Buffer.from(await got.arrayBuffer()).equals(hud)).toBe(true);

    // Uploading it again is accepted without storing it twice (the body isn't read).
    const big = bytes(2 * 1024 * 1024, 9);
    expect((await b.putBlob(sha(big), big)).status).toBe(204);
    expect((await b.putBlob(sha(big), big)).status).toBe(204);
    expect((await a.putBlob(hudSha, hud)).status).toBe(204);
    const stored = await app.sql.query<{ n: number }>("SELECT count(*)::int AS n FROM sync_blobs WHERE org_id = $1", [owner.orgId]);
    expect(stored.rows[0]!.n).toBe(2);

    const ok = await a.one({ kind: "hud", id: "h-1", data: { name: "Vector" }, blobs: [hudSha] });
    expect(ok).toMatchObject({ status: "applied", item: { blobs: [hudSha] } });
    expect((await b.status()).data).toMatchObject({ blobBytes: hud.length + big.length, items: { hud: 1 } });
    expect((await b.getBlob(sha(bytes(5, 5)))).status).toBe(404);
  });

  it("keeps each organisation's items and files to itself, and refuses unlinked computers", async () => {
    const hud = bytes(300_000, 7);
    expect((await other.changes(0)).data).toEqual({ items: [], cursor: 0, more: false });
    expect((await other.getBlob(sha(hud))).status).toBe(404);
    expect((await other.status()).data).toMatchObject({ cursor: 0, blobBytes: 0, items: { player: 0, hud: 0 } });

    // Same kind and id in another organisation: a separate item with its own seqs.
    const mine = await other.one({ kind: "player", id: "p-nova", data: { name: "someone else" } });
    expect(mine.item!.seq).toBe(1);
    expect((await b.changes(0)).data.items.find((x) => x.id === "p-nova")!.data).toEqual({ name: "nova", steamId: "76561198000000001", country: "SE" });
    // It can't name the first organisation's files; it uploads its own copy.
    expect((await other.one({ kind: "hud", id: "h-1", data: { name: "Vector" }, blobs: [sha(hud)] })).status).toBe("rejected");
    expect((await other.putBlob(sha(hud), hud)).status).toBe(204);
    expect((await other.status()).data.blobBytes).toBe(hud.length);

    // No credential, a wrong one, or an unlinked computer: 401, and an upload's body isn't read.
    const anon = new Client(base, null);
    expect((await anon.req<ApiError>("GET", "/v1/sync/changes")).status).toBe(401);
    expect((await anon.req<ApiError>("GET", "/v1/sync/status", undefined, { authorization: "Bearer mfd_nope" })).data.error).toBe("device_revoked");
    expect((await fetch(`${base}/v1/sync/blobs/${sha(hud)}`, { method: "PUT", body: hud })).status).toBe(401);
    expect((await raw("PUT", `/v1/sync/blobs/${sha(hud)}`, { "content-length": String(SYNC_BLOB_MAX_BYTES) })).status).toBe(401);
    const gone = other;
    expect((await new Client(base, null).req("POST", "/v1/device/unlink", undefined, { authorization: `Bearer ${gone.token}` })).status).toBe(200);
    expect((await gone.changes(0)).status).toBe(401);
    expect((await gone.push([{ kind: "team", id: "x" }])).status).toBe(401);
    expect((await gone.getBlob(sha(hud))).status).toBe(401);
    other = await signIn("sync-other@example.com", "install-cccccccccccccccc", "Other desk");
  });

  it("limits a record to 256 KB, a file to 60 MB, a push's size and an organisation's files to its quota", async () => {
    // {"text":"…"} is 11 bytes around the text.
    const atLimit = await a.one({ kind: "asset", id: "logo-meta", data: { text: "x".repeat(SYNC_ITEM_MAX_BYTES - 11) } });
    expect(atLimit.status).toBe("applied");
    const over = await a.one({ kind: "asset", id: "logo-meta", data: { text: "x".repeat(SYNC_ITEM_MAX_BYTES - 10) } });
    expect(over).toMatchObject({ status: "rejected", item: null, reason: `too_large ${SYNC_ITEM_MAX_BYTES + 1}` });

    const auth = { authorization: `Bearer ${a.token}` };
    const tooBig = await raw("PUT", `/v1/sync/blobs/${sha(bytes(1, 1))}`, { ...auth, "content-type": "application/octet-stream", "content-length": String(SYNC_BLOB_MAX_BYTES + 1) });
    expect(tooBig).toMatchObject({ status: 413, data: { error: "too_large", message: "a shared file can be at most 60 MB" } });
    const hugePush = await raw("POST", "/v1/sync/push", { ...auth, "content-type": "application/json", "content-length": String(SYNC_PUSH_MAX_BYTES + 1) });
    expect(hugePush).toMatchObject({ status: 413, data: { error: "too_large" } });
    // The largest legal push fits: 200 changes at the largest record size.
    expect(SYNC_PUSH_MAX_BYTES).toBeGreaterThan(200 * (SYNC_ITEM_MAX_BYTES + 2048));

    // Quota (the other organisation's): fill it up to the limit, then the next file is refused
    // (said up front from its declared length, or after reading a chunked upload).
    const used = (await other.status()).data.blobBytes;
    const fill = bytes(QUOTA - used - 100, 3);
    expect((await other.putBlob(sha(fill), fill)).status).toBe(204);
    expect((await other.status()).data.blobBytes).toBe(QUOTA - 100);
    const next = bytes(101, 4);
    const declared = await other.putBlob(sha(next), next);
    expect(declared.status).toBe(413);
    expect((await declared.json()) as ApiError).toMatchObject({ error: "quota_exceeded", detail: { usedBytes: QUOTA - 100, fileBytes: 101, quotaBytes: QUOTA } });
    const chunked = await raw("PUT", `/v1/sync/blobs/${sha(next)}`, { authorization: `Bearer ${other.token}`, "transfer-encoding": "chunked" }, next);
    expect(chunked).toMatchObject({ status: 413, data: { error: "quota_exceeded" } });
    expect(chunked.data.message).toContain("4 MB limit");
    const fits = bytes(100, 4);
    expect((await other.putBlob(sha(fits), fits)).status).toBe(204);
    expect((await other.status()).data.blobBytes).toBe(QUOTA);
    // The quota is per organisation: the first one still has room.
    expect((await a.putBlob(sha(next), next)).status).toBe(204);
  });

  it("deletes files no live item names once they are an hour old", async () => {
    const kept = bytes(1000, 11);
    const dropped = bytes(1000, 12);
    const orphan = bytes(1000, 13);
    const reuploaded = bytes(1000, 14);
    for (const f of [kept, dropped, orphan, reuploaded]) expect((await a.putBlob(sha(f), f)).status).toBe(204);
    await a.push([
      { kind: "player", id: "p-photo", data: { name: "zeal" }, blobs: [sha(kept)] },
      { kind: "team", id: "t-logo", data: { name: "Bravo" }, blobs: [sha(dropped)] },
    ]);
    // The team's logo is removed with the team (a tombstone names no files).
    const tomb = await b.one({ kind: "team", id: "t-logo", data: null, baseSeq: (await b.changes(0)).data.items.find((x) => x.id === "t-logo")!.seq });
    expect(tomb.status).toBe("applied");

    clock += 59 * MINUTE;
    // Uploading a file again restarts its hour; a new upload has its own.
    expect((await a.putBlob(sha(reuploaded), reuploaded)).status).toBe(204);
    const fresh = bytes(1000, 15);
    expect((await a.putBlob(sha(fresh), fresh)).status).toBe(204);
    clock += 2 * MINUTE;

    await a.one({ kind: "event", id: "e-cleanup", data: { name: "Cup" } });
    const has = async (f: Buffer) => (await a.getBlob(sha(f))).status === 200;
    expect([await has(kept), await has(dropped), await has(orphan), await has(reuploaded), await has(fresh)]).toEqual([true, false, false, true, true]);
    // Files of earlier tests that no item names are gone too; the HUD's package stays.
    expect(await has(bytes(300_000, 7))).toBe(true);
    expect(await has(bytes(2 * 1024 * 1024, 9))).toBe(false);
    // The other organisation's files are untouched.
    expect((await other.getBlob(sha(bytes(300_000, 7)))).status).toBe(200);

    clock += 2 * MINUTE;
    await a.one({ kind: "event", id: "e-cleanup", data: { name: "Cup 2" } });
    expect([await has(reuploaded), await has(fresh)]).toEqual([true, true]);
    clock += 60 * MINUTE;
    await a.one({ kind: "event", id: "e-cleanup", data: { name: "Cup 3" } });
    expect([await has(kept), await has(reuploaded), await has(fresh)]).toEqual([true, false, false]);
  });

  it("shows the organisation's members what its computers share (website)", async () => {
    const r = await owner.client.req<SyncStatus>("GET", `/v1/orgs/${owner.orgId}/sync`);
    expect(r.status).toBe(200);
    expect(r.data).toEqual((await a.status()).data);
    expect(r.data.items).toMatchObject({ player: 2, hud: 1, match: 2 });

    const member = await signup("sync-member@example.com");
    await app.sql.query("INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'member')", [owner.orgId, member.userId]);
    expect((await member.client.req("GET", `/v1/orgs/${owner.orgId}/sync`)).status).toBe(200);
    expect((await stranger.client.req("GET", `/v1/orgs/${owner.orgId}/sync`)).status).toBe(404);
    expect((await new Client(base).req("GET", `/v1/orgs/${owner.orgId}/sync`)).status).toBe(401);
    // A computer's token doesn't open the website route.
    expect((await new Client(base, null).req("GET", `/v1/orgs/${owner.orgId}/sync`, undefined, { authorization: `Bearer ${a.token}` })).status).toBe(401);
  });
});

describe("raw request bodies (router)", () => {
  const stream = (headers: Record<string, string> = {}) => Object.assign(new PassThrough(), { headers });

  it("reads a body up to its limit", async () => {
    const s = stream();
    const p = readBody(s, 10);
    s.write(Buffer.from("hello "));
    s.end(Buffer.from("you!"));
    expect((await p).toString()).toBe("hello you!");
  });

  it("refuses a declared length over the limit before reading anything", async () => {
    const s = stream({ "content-length": "11" });
    await expect(readBody(s, 10)).rejects.toMatchObject({ status: 413, code: "too_large" });
    expect(s.listenerCount("data")).toBe(0);
  });

  it("stops at the limit while streaming, without waiting for the rest or keeping it", async () => {
    const s = stream();
    const p = readBody(s, 10);
    s.write(Buffer.alloc(6));
    s.write(Buffer.alloc(6));
    // The stream never ends: the refusal comes as soon as the limit is passed.
    const e = await p.catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HttpError);
    expect(e).toMatchObject({ status: 413, code: "too_large" });
    s.destroy();
  });
});
