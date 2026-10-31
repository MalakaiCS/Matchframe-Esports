import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS, migrate } from "../src/db/migrations.ts";
import { PgSql } from "../src/db/sql.ts";
import { computeAllowance, ingestUsage } from "../src/domain/allowance.ts";
import { getPlan, seedCatalog } from "../src/domain/plans.ts";
import { listChanges, pushChanges } from "../src/domain/sync.ts";

/**
 * Real Postgres server through node-postgres (the production driver). Opt-in: set
 * MF_TEST_DATABASE_URL to an empty, disposable database.
 */
const url = process.env.MF_TEST_DATABASE_URL;

describe.skipIf(!url)("cloud API storage on a real Postgres server", () => {
  let sql: PgSql;

  beforeAll(async () => {
    sql = new PgSql(url!);
    await sql.query("DROP SCHEMA public CASCADE");
    await sql.query("CREATE SCHEMA public");
  });

  afterAll(async () => {
    await sql?.close();
  });

  it("migrates idempotently, seeds the catalogue, and rolls back failed transactions", async () => {
    const latest = MIGRATIONS[MIGRATIONS.length - 1]!.version;
    expect(await migrate(sql)).toEqual({ from: 0, to: latest });
    expect(await migrate(sql)).toEqual({ from: latest, to: latest });
    await seedCatalog(sql);
    const { rows } = await sql.query<{ n: string }>("SELECT count(*) AS n FROM plans");
    expect(Number(rows[0]!.n)).toBe(3);
    await seedCatalog(sql, { STRIPE_PRICE_PRO: "price_pro_after_first_start" });
    expect((await getPlan(sql, "pro"))?.stripePriceId).toBe("price_pro_after_first_start");
    await expect(
      sql.transaction(async (tx) => {
        await tx.query("INSERT INTO orgs (id, name) VALUES ('org_rb', 'rollback')");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await sql.query("SELECT 1 FROM orgs WHERE id = 'org_rb'")).rows).toHaveLength(0);
  });

  it("serialises concurrent usage uploads per organisation so credits are never double-spent", async () => {
    await sql.query("INSERT INTO orgs (id, name) VALUES ('org_c', 'concurrency')");
    await sql.query("INSERT INTO users (id, email, display_name, password_hash) VALUES ('usr_c', 'c@example.com', 'C', 'x')");
    const devices = ["dev_a", "dev_b", "dev_c", "dev_d", "dev_e", "dev_f"];
    for (const d of devices) await sql.query("INSERT INTO devices (id, org_id, name, platform, app_version, install_id, token_hash, approved_by) VALUES ($1, 'org_c', $1, 'win32', '0.1.0', $1, $1, 'usr_c')", [d]);
    // Free plan: 2 h included; one 1 h credit grant. Six computers upload 2 h each at the same time.
    await sql.query("INSERT INTO credit_grants (id, org_id, seconds, source) VALUES ('crd_c', 'org_c', 3600, 'grant')");
    const now = new Date();
    const batch = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ recordId: randomUUID(), kind: "auto_director" as const, startedAt: new Date(now.getTime() - (i + 1) * 3_700_000).toISOString(), endedAt: new Date(now.getTime() - (i + 1) * 3_700_000 + 3_600_000).toISOString(), seconds: 3600, sessionId: "s", matchRef: null, mapName: null, appVersion: "0.1.0" }));
    const results = await Promise.all(devices.map((d) => sql.transaction((tx) => ingestUsage(tx, "org_c", d, batch(2), now))));
    expect(results.reduce((n, r) => n + r.accepted.length, 0)).toBe(12);
    const debits = await sql.query<{ s: string }>("SELECT sum(seconds) AS s FROM credit_debits WHERE grant_id = 'crd_c'");
    expect(Number(debits.rows[0]!.s)).toBe(3600);
    const allowance = await computeAllowance(sql, "org_c", now);
    expect(allowance).toMatchObject({ usedSeconds: 43200, creditSeconds: 0, remainingSeconds: -32400 });
  });

  it("hands out account-sync seqs in commit order, with no duplicates, when computers push at once", async () => {
    await sql.query("INSERT INTO orgs (id, name) VALUES ('org_s', 'sync')");
    const now = new Date();
    const devices = ["dev_s1", "dev_s2", "dev_s3", "dev_s4", "dev_s5", "dev_s6"];
    // Each push also edits one item every computer edits, so pushes contend for the same rows.
    const push = (d: string, round: number) =>
      sql.transaction((tx) =>
        pushChanges(
          tx,
          { deviceId: d, orgId: "org_s", name: d },
          Array.from({ length: 20 }, (_, i) => ({ kind: "player" as const, id: i === round * 3 ? "shared" : `${d}-${round}-${i}`, data: { d, round, i }, blobs: [], baseSeq: null, editedAt: now.toISOString() })),
          now,
        ),
      );
    // A computer polling while the pushes run must never see a seq above one it hasn't seen yet.
    let done = false;
    const seen: number[] = [];
    const poll = (async () => {
      let cursor = 0;
      for (;;) {
        const finished = done;
        const page = await listChanges(sql, "org_s", cursor, 50);
        for (const it of page.items) seen.push(it.seq);
        cursor = page.cursor;
        if (finished && !page.more) return;
      }
    })();
    const results = await Promise.all(devices.flatMap((d) => [0, 1, 2, 3, 4].map((r) => push(d, r))));
    done = true;
    await poll;

    const seqs = results.flatMap((r) => r.results.map((x) => x.item!.seq)).sort((x, y) => x - y);
    expect(seqs).toEqual(Array.from({ length: 600 }, (_, i) => i + 1));
    expect(results.every((r) => r.results.every((x) => x.status === "applied"))).toBe(true);
    // Every item other than the shared one was seen exactly once, in increasing seq order.
    expect(seen).toEqual([...seen].sort((x, y) => x - y));
    expect(new Set(seen).size).toBe(seen.length);
    const { rows } = await sql.query<{ n: string; max: string }>("SELECT count(*) AS n, max(seq) AS max FROM sync_items WHERE org_id = 'org_s'");
    expect([Number(rows[0]!.n), Number(rows[0]!.max)]).toEqual([571, 600]);
    const unique = new Set((await listChanges(sql, "org_s", 0, 1000)).items.map((x) => x.seq));
    expect(seen.filter((x) => unique.has(x)).length).toBe(571);
  });
});
