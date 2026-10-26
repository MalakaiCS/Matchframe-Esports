import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./migrations.ts";

export type SqlValue = string | number | bigint | null | Uint8Array;

/**
 * Thin wrapper around Node's built-in SQLite (node:sqlite), which is available in both the
 * development Node runtime and Electron's bundled Node (verified: Electron 44.9.3 / Node 24.22).
 * Transactions are kept short; no write lock is ever held across long work such as parsing.
 */
export class Database {
  readonly db: DatabaseSync;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000; PRAGMA synchronous = NORMAL;");
  }

  get schemaVersion(): number {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const row = this.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null } | undefined;
    return row?.v ?? 0;
  }

  /** Applies pending migrations. A file-backed database is copied to `backupDir` first. */
  migrate(backupDir?: string): { from: number; to: number; backup: string | null } {
    const from = this.schemaVersion;
    const pending = MIGRATIONS.filter((m) => m.version > from);
    if (pending.length === 0) return { from, to: from, backup: null };
    let backup: string | null = null;
    if (this.path !== ":memory:" && backupDir && from > 0 && existsSync(this.path)) {
      mkdirSync(backupDir, { recursive: true });
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      backup = join(backupDir, `matchframe-v${from}-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`);
      copyFileSync(this.path, backup);
    }
    for (const m of pending) {
      this.transaction(() => {
        this.db.exec(m.sql);
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", m.version, new Date().toISOString());
      });
    }
    return { from, to: pending[pending.length - 1]!.version, backup };
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  run(sql: string, ...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return this.db.prepare(sql).run(...params);
  }

  get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  close(): void {
    this.db.close();
  }
}
