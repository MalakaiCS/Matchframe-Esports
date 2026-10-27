import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/db/migrations.ts";
import { PgSql } from "../src/db/sql.ts";
import { computeAllowance, ingestUsage } from "../src/domain/allowance.ts";
import { getPlan, seedCatalog } from "../src/domain/plans.ts";

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
    expect(await migrate(sql)).toEqual({ from: 0, to: 3 });
    expect(await migrate(sql)).toEqual({ from: 3, to: 3 });
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
});
