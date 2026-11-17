import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, type Migration } from "./migrations.ts";
import { backupName, lastProgramVersion } from "./version-backups.ts";

export type SqlValue = string | number | bigint | null | Uint8Array;

/**
 * The database was saved by a newer version in a format this version doesn't know (ADR-076). The
 * engine stops before reading or writing anything: an older engine must never change a newer
 * database. The message is for the operator (the program shows it).
 */
export class NewerDatabaseError extends Error {
  constructor(
    readonly schema: number,
    readonly supported: number,
    readonly lastVersion: string | null,
  ) {
    const newer = lastVersion ? `version ${lastVersion}` : "a newer version of MatchFrame";
    super(
      `Your MatchFrame data was last used by ${newer}, which saved it in a newer format (database version ${schema}; this version reads up to ${supported}). ` +
        `To keep it safe, this version hasn't opened it. Install ${lastVersion ? `version ${lastVersion}` : "the newer version"} again, ` +
        `or go back from it with Settings → General → Program → Go back to a previous version, which restores the backup made for this version.`,
    );
    this.name = "NewerDatabaseError";
  }
}

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

  /**
   * Applies pending migrations. A file-backed database is copied to `backupDir` first, named with its
   * format and the program version that last used it (going back to that version restores it;
   * db/version-backups.ts). A database in a newer format than `migrations` knows is refused.
   */
  migrate(backupDir?: string, migrations: readonly Migration[] = MIGRATIONS): { from: number; to: number; backup: string | null } {
    const from = this.schemaVersion;
    const supported = migrations.at(-1)?.version ?? 0;
    if (from > supported) throw new NewerDatabaseError(from, supported, lastProgramVersion(this.db));
    const pending = migrations.filter((m) => m.version > from);
    if (pending.length === 0) return { from, to: from, backup: null };
    let backup: string | null = null;
    if (this.path !== ":memory:" && backupDir && from > 0 && existsSync(this.path)) {
      mkdirSync(backupDir, { recursive: true });
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      backup = join(backupDir, backupName(from, lastProgramVersion(this.db), new Date()));
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

  private txDepth = 0;

  /** Runs fn atomically. Nested calls use savepoints, so repository methods compose. */
  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      const sp = `sp_${this.txDepth}`;
      this.db.exec(`SAVEPOINT ${sp}`);
      this.txDepth++;
      try {
        const r = fn();
        this.db.exec(`RELEASE ${sp}`);
        return r;
      } catch (e) {
        this.db.exec(`ROLLBACK TO ${sp}`);
        this.db.exec(`RELEASE ${sp}`);
        throw e;
      } finally {
        this.txDepth--;
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.txDepth = 1;
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.txDepth = 0;
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
