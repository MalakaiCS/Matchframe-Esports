import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

export type SqlParam = string | number | boolean | null | Date | Buffer;

export interface Queryable {
  query<T = Record<string, unknown>>(text: string, params?: SqlParam[]): Promise<{ rows: T[] }>;
}

/** Postgres access used by the cloud API: plain parameterised SQL and transactions. */
export interface Sql extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly kind: "postgres" | "pglite";
}

/** Production: a real Postgres server through node-postgres. */
export class PgSql implements Sql {
  readonly kind = "postgres" as const;
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10 });
  }

  async query<T>(text: string, params: SqlParam[] = []): Promise<{ rows: T[] }> {
    const r = await this.pool.query(text, params);
    return { rows: r.rows as T[] };
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const tx: Queryable = { query: async <R>(text: string, params: SqlParam[] = []) => ({ rows: (await client.query(text, params)).rows as R[] }) };
      const r = await fn(tx);
      await client.query("COMMIT");
      return r;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Tests and single-machine development: Postgres compiled to WebAssembly, in process. */
export class PgliteSql implements Sql {
  readonly kind = "pglite" as const;
  private readonly db: PGlite;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(dataDir?: string) {
    this.db = new PGlite(dataDir);
  }

  query<T>(text: string, params: SqlParam[] = []): Promise<{ rows: T[] }> {
    return this.db.query<T>(text, params).then((r) => ({ rows: r.rows }));
  }

  /** PGlite has a single connection: serialise transactions so they never interleave. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const run = this.chain.then(() =>
      this.db.transaction(async (t) => fn({ query: async <R>(text: string, params: SqlParam[] = []) => ({ rows: (await t.query<R>(text, params)).rows }) })),
    );
    this.chain = run.catch(() => undefined);
    return run;
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

export function openSql(databaseUrl: string | null, pgliteDir?: string): Sql {
  if (databaseUrl) return new PgSql(databaseUrl);
  return new PgliteSql(pgliteDir);
}
