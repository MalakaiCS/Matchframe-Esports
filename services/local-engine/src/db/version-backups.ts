import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Data safety for going back to an earlier version of the program (ADR-076).
 *
 * - **Backups:** before a new version changes the database format (a migration), the engine copies
 *   the database to `<dataDir>/backups/matchframe-v<format>-from-<version>-<time>.sqlite`: the
 *   format it is in and the program version that last used it. Copies made by 0.12.4 and earlier
 *   have no `-from-` part; they still carry their format and are used the same way.
 * - **Which version reads which format:** every engine since the first has written an
 *   `engine.start` audit entry with its version and the format it left the database in, so the
 *   database itself says which versions have used it and in which format.
 * - **Going back to version V:** if V used today's format (or a newer one), the data stays as it is.
 *   If V used an older format, the newest copy in V's format is restored and changes made since are
 *   lost (the operator is told). If this computer's data was never used by V and has no copy V can
 *   read, going back is refused: an older engine must never open a newer database.
 *
 * The program (apps/desktop/src/rollback.ts) uses these with the engine stopped; the engine uses
 * `backupName` and `lastProgramVersion` when it migrates (db/database.ts).
 */

export const DB_FILE = "matchframe.sqlite";
export const BACKUP_DIR = "backups";

/** Version strings that may appear in a file name. */
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const BACKUP_NAME = /^matchframe-v(\d+)(?:-from-(.+?))?-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.sqlite$/;

export interface DataBackup {
  file: string;
  name: string;
  /** The database format (schema version) inside the copy. */
  schema: number;
  /** The program version that last used the data before the update; null in copies made by 0.12.4 and earlier. */
  fromVersion: string | null;
  createdAt: string;
}

/** What this computer's data folder holds, for planning a step back. */
export interface DataState {
  /** There is a database (a computer that has only connected to another one may have none). */
  exists: boolean;
  /** Format of the database now (0 when there is none). */
  schema: number;
  /** Program version → the format it left the database in (its latest start). */
  history: Record<string, number>;
  /** Newest first. */
  backups: DataBackup[];
}

export type RollbackDataPlan =
  /** No data on this computer yet: nothing to keep safe. */
  | { kind: "fresh" }
  /** The earlier version reads today's database as it is: nothing is restored, nothing is lost. */
  | { kind: "keep"; schema: number }
  /** The earlier version reads an older format: this copy is restored; changes made since it was taken are lost. */
  | { kind: "restore"; schema: number; backup: DataBackup }
  /** No copy of the data the earlier version can read: going back would risk the data. */
  | { kind: "refuse"; reason: string };

export function backupName(schema: number, fromVersion: string | null, at: Date): string {
  const from = fromVersion && SAFE_VERSION.test(fromVersion) ? `-from-${fromVersion}` : "";
  return `matchframe-v${schema}${from}-${at.toISOString().replace(/[:.]/g, "-")}.sqlite`;
}

export function parseBackupName(name: string): Omit<DataBackup, "file"> | null {
  const m = BACKUP_NAME.exec(name);
  if (!m) return null;
  const createdAt = `${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`;
  if (Number.isNaN(Date.parse(createdAt))) return null;
  return { name, schema: Number(m[1]), fromVersion: m[2] ?? null, createdAt };
}

/** The data copies in `dir`, newest first (other files are ignored). */
export function listBackups(dir: string): DataBackup[] {
  if (!existsSync(dir)) return [];
  const out: DataBackup[] = [];
  for (const name of readdirSync(dir)) {
    const b = parseBackupName(name);
    if (b) out.push({ ...b, file: join(dir, name) });
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

function schemaOf(db: DatabaseSync): number {
  try {
    const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null } | undefined;
    return row?.v ?? 0;
  } catch {
    return 0;
  }
}

function engineStarts(db: DatabaseSync): { version: string; schema: number | null }[] {
  let rows: { detail: string | null }[];
  try {
    rows = db.prepare("SELECT detail FROM audit_log WHERE action = 'engine.start' ORDER BY seq").all() as { detail: string | null }[];
  } catch {
    return [];
  }
  const out: { version: string; schema: number | null }[] = [];
  for (const r of rows) {
    try {
      const d = JSON.parse(r.detail ?? "null") as { version?: unknown; migration?: { to?: unknown } } | null;
      if (typeof d?.version !== "string" || !SAFE_VERSION.test(d.version)) continue;
      out.push({ version: d.version, schema: typeof d.migration?.to === "number" ? d.migration.to : null });
    } catch {
      // An unreadable entry says nothing about versions.
    }
  }
  return out;
}

/** The program version that last started on this database (null for a new one). */
export function lastProgramVersion(db: DatabaseSync): string | null {
  return engineStarts(db).at(-1)?.version ?? null;
}

/** Program version → the format it left the database in. */
export function versionHistory(db: DatabaseSync): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of engineStarts(db)) if (s.schema !== null) out[s.version] = s.schema;
  return out;
}

/** Reads the data folder (the engine may be running: only reads, through its own connection). */
export function inspectData(dataDir: string): DataState {
  const file = join(dataDir, DB_FILE);
  const backups = listBackups(join(dataDir, BACKUP_DIR));
  if (!existsSync(file)) return { exists: false, schema: 0, history: {}, backups };
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout = 3000");
    return { exists: true, schema: schemaOf(db), history: versionHistory(db), backups };
  } finally {
    db.close();
  }
}

/** What going back to `target` does to this computer's data (see the module comment). */
export function planRollbackData(target: string, state: DataState): RollbackDataPlan {
  if (!state.exists) return { kind: "fresh" };
  const targetSchema = state.history[target] ?? state.backups.find((b) => b.fromVersion === target)?.schema;
  if (targetSchema === undefined) {
    return { kind: "refuse", reason: `This computer's data has never been used by version ${target} and has no copy from it, so MatchFrame can't tell whether ${target} can read it. Going back could damage your teams, matches and settings, so it won't.` };
  }
  if (targetSchema >= state.schema) return { kind: "keep", schema: state.schema };
  const backup = state.backups.find((b) => b.schema === targetSchema);
  if (!backup) {
    return { kind: "refuse", reason: `Version ${target} stores your data in an older format, and there's no backup in that format on this computer. Going back could damage your teams, matches and settings, so it won't.` };
  }
  return { kind: "restore", schema: targetSchema, backup };
}

/**
 * Puts `backup` in place of the database. Run only with the engine stopped. The database as it is
 * now is kept as a copy in the backups folder first (named like any other copy), so nothing is
 * thrown away.
 */
export function restoreBackup(dataDir: string, backup: DataBackup, now: Date = new Date()): { safetyCopy: string | null } {
  if (!existsSync(backup.file)) throw new Error(`The backup ${backup.name} is missing.`);
  const check = new DatabaseSync(backup.file, { readOnly: true });
  try {
    const ok = (check.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined) ?? {};
    if (Object.values(ok)[0] !== "ok") throw new Error(`The backup ${backup.name} is damaged.`);
    if (schemaOf(check) !== backup.schema) throw new Error(`The backup ${backup.name} is not in the format its name says.`);
  } finally {
    check.close();
  }
  const file = join(dataDir, DB_FILE);
  const dir = join(dataDir, BACKUP_DIR);
  let safetyCopy: string | null = null;
  if (existsSync(file)) {
    const db = new DatabaseSync(file);
    let schema: number;
    let from: string | null;
    try {
      db.exec("PRAGMA busy_timeout = 3000; PRAGMA wal_checkpoint(TRUNCATE)");
      schema = schemaOf(db);
      from = lastProgramVersion(db);
    } finally {
      db.close();
    }
    mkdirSync(dir, { recursive: true });
    safetyCopy = join(dir, backupName(schema, from, now));
    copyFileSync(file, safetyCopy);
  }
  for (const extra of [`${file}-wal`, `${file}-shm`]) rmSync(extra, { force: true });
  const temp = `${file}.restoring`;
  copyFileSync(backup.file, temp);
  renameSync(temp, file);
  return { safetyCopy };
}
