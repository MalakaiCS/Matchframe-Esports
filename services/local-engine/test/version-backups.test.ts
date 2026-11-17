import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Database, NewerDatabaseError } from "../src/db/database.ts";
import { MIGRATIONS } from "../src/db/migrations.ts";
import { AuditRepo } from "../src/db/store.ts";
import { BACKUP_DIR, backupName, DB_FILE, inspectData, listBackups, parseBackupName, planRollbackData, restoreBackup, type DataBackup, type DataState } from "../src/db/version-backups.ts";

/**
 * Going back to an earlier version keeps the data safe (ADR-076). The "older version" is real: the
 * data folder fixtures/upgrade-0.11.0 was made by the 0.11.0 engine (database format 4, its
 * engine.start entry in the audit log).
 */

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DB = join(here, "..", "..", "..", "fixtures", "upgrade-0.11.0", "appdata", "Matchframe Esports", DB_FILE);

function dataDirFrom011(): string {
  const dir = mkdtempSync(join(tmpdir(), "mf-goback-"));
  copyFileSync(FIXTURE_DB, join(dir, DB_FILE));
  return dir;
}

/** What Engine does on start: migrate (copying first), then record engine.start with the outcome. */
function startEngine(dataDir: string, version: string, migrations = MIGRATIONS): Database {
  const db = new Database(join(dataDir, DB_FILE));
  const migration = db.migrate(join(dataDir, BACKUP_DIR), migrations);
  new AuditRepo(db).record("system", "engine.start", null, { version, migration });
  return db;
}

function addTeam(db: Database, id: string): void {
  const now = new Date().toISOString();
  db.run("INSERT INTO documents (kind, id, data, created_at, updated_at) VALUES ('team', ?, ?, ?, ?)", id, JSON.stringify({ id, name: id }), now, now);
}

function teamIds(file: string): string[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare("SELECT id FROM documents WHERE kind = 'team' ORDER BY id").all() as { id: string }[]).map((r) => r.id);
  } finally {
    db.close();
  }
}

function schemaOf(file: string): number {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v;
  } finally {
    db.close();
  }
}

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

describe("backups made by an update", () => {
  it("an update that changes the format keeps a copy named with the format and the version it came from", () => {
    const dataDir = dataDirFrom011();
    const before = teamIds(join(dataDir, DB_FILE));
    const db = startEngine(dataDir, "0.12.4");
    db.close();
    const backups = listBackups(join(dataDir, BACKUP_DIR));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatchObject({ schema: 4, fromVersion: "0.11.0" });
    expect(backups[0]!.name).toMatch(/^matchframe-v4-from-0\.11\.0-\d{4}-\d\d-\d\dT[\d-]+Z\.sqlite$/);
    expect(schemaOf(backups[0]!.file)).toBe(4);
    expect(teamIds(backups[0]!.file)).toEqual(before);
  });

  it("an update that keeps the format makes no copy", () => {
    const dataDir = dataDirFrom011();
    startEngine(dataDir, "0.12.4").close();
    startEngine(dataDir, "0.12.5").close();
    expect(listBackups(join(dataDir, BACKUP_DIR))).toHaveLength(1);
    expect(inspectData(dataDir).history).toEqual({ "0.11.0": 4, "0.12.4": 5, "0.12.5": 5 });
  });
});

describe("going back to an earlier version", () => {
  it("restores the copy made for that version, keeps today's data as a copy, and the earlier format opens", () => {
    const dataDir = dataDirFrom011();
    const before = teamIds(join(dataDir, DB_FILE));
    const db = startEngine(dataDir, "0.12.4");
    addTeam(db, "added-after-the-update");
    db.close();

    const state = inspectData(dataDir);
    expect(state).toMatchObject({ exists: true, schema: 5, history: { "0.11.0": 4, "0.12.4": 5 } });
    const plan = planRollbackData("0.11.0", state);
    expect(plan.kind).toBe("restore");
    if (plan.kind !== "restore") return;
    expect(plan.backup).toMatchObject({ schema: 4, fromVersion: "0.11.0" });
    expect(planRollbackData("0.12.4", state)).toEqual({ kind: "keep", schema: 5 });

    const { safetyCopy } = restoreBackup(dataDir, plan.backup);
    const file = join(dataDir, DB_FILE);
    // No write-ahead log of the newer data is left to be replayed onto the restored file.
    expect(existsSync(`${file}-wal`)).toBe(false);
    expect(schemaOf(file)).toBe(4);
    expect(teamIds(file)).toEqual(before);
    // Nothing is thrown away: the data as it was before going back is a copy in the backups folder.
    expect(safetyCopy).not.toBeNull();
    expect(parseBackupName(safetyCopy!.split(/[\\/]/).pop()!)).toMatchObject({ schema: 5, fromVersion: "0.12.4" });
    expect(teamIds(safetyCopy!)).toContain("added-after-the-update");
    // The earlier version's engine (formats up to 4) opens it without changing it.
    const old = new Database(file);
    expect(old.migrate(join(dataDir, BACKUP_DIR), MIGRATIONS.slice(0, 4))).toEqual({ from: 4, to: 4, backup: null });
    old.close();
  });

  it("refuses with no copy the earlier version can read, and when that version never used this data", () => {
    const dataDir = dataDirFrom011();
    startEngine(dataDir, "0.12.4").close();
    const state = inspectData(dataDir);
    const noCopy: DataState = { ...state, backups: [] };
    expect(planRollbackData("0.11.0", noCopy)).toMatchObject({ kind: "refuse", reason: expect.stringContaining("no backup in that format") });
    expect(planRollbackData("0.10.13", state)).toMatchObject({ kind: "refuse", reason: expect.stringContaining("never been used by version 0.10.13") });
  });

  it("has nothing to keep safe on a computer without data", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mf-goback-"));
    expect(planRollbackData("0.12.4", inspectData(dataDir))).toEqual({ kind: "fresh" });
  });

  it("restores the newest copy in the format the earlier version reads (labelled or from before labels)", () => {
    const at = (iso: string, schema: number, fromVersion: string | null): DataBackup => {
      const name = backupName(schema, fromVersion, new Date(iso));
      return { ...parseBackupName(name)!, file: `/backups/${name}` };
    };
    const older = at("2026-11-01T10:00:00.000Z", 5, "0.12.4");
    const newer = at("2026-11-10T10:00:00.000Z", 5, "0.13.0");
    const legacy = at("2026-10-01T10:00:00.000Z", 4, null);
    const state: DataState = { exists: true, schema: 6, history: { "0.11.0": 4, "0.12.4": 5, "0.13.0": 5, "0.14.0": 6 }, backups: [newer, older, legacy] };
    expect(planRollbackData("0.12.4", state)).toEqual({ kind: "restore", schema: 5, backup: newer });
    expect(planRollbackData("0.11.0", state)).toEqual({ kind: "restore", schema: 4, backup: legacy });
    expect(planRollbackData("0.14.0", state)).toEqual({ kind: "keep", schema: 6 });
    // A version known only from a copy's label.
    expect(planRollbackData("0.12.9", { ...state, history: {}, backups: [at("2026-11-12T00:00:00.000Z", 5, "0.12.9")] })).toMatchObject({ kind: "restore", schema: 5 });
  });

  it("refuses a damaged copy and leaves the database alone", () => {
    const dataDir = dataDirFrom011();
    startEngine(dataDir, "0.12.4").close();
    const backup = listBackups(join(dataDir, BACKUP_DIR))[0]!;
    writeFileSync(backup.file, "not a database");
    const file = join(dataDir, DB_FILE);
    const hash = sha256(file);
    expect(() => restoreBackup(dataDir, backup)).toThrow();
    expect(sha256(file)).toBe(hash);
  });
});

describe("an older engine and a newer database", () => {
  it("refuses with a clear message and changes nothing", () => {
    const dataDir = dataDirFrom011();
    startEngine(dataDir, "0.13.0").close();
    const file = join(dataDir, DB_FILE);
    const hash = sha256(file);
    const copies = readdirSync(join(dataDir, BACKUP_DIR)).length;

    const old = new Database(file);
    let error: unknown;
    try {
      old.migrate(join(dataDir, BACKUP_DIR), MIGRATIONS.slice(0, 4));
    } catch (e) {
      error = e;
    } finally {
      old.close();
    }
    expect(error).toBeInstanceOf(NewerDatabaseError);
    expect(error).toMatchObject({ schema: 5, supported: 4, lastVersion: "0.13.0" });
    expect((error as Error).message).toContain("last used by version 0.13.0");
    expect((error as Error).message).toContain("database version 5; this version reads up to 4");
    expect((error as Error).message).toContain("Go back to a previous version");
    expect(sha256(file)).toBe(hash);
    expect(readdirSync(join(dataDir, BACKUP_DIR))).toHaveLength(copies);
  });

  it("is the current engine's behaviour for a format it doesn't know", () => {
    const dir = mkdtempSync(join(tmpdir(), "mf-goback-"));
    mkdirSync(dir, { recursive: true });
    const db = new Database(join(dir, DB_FILE));
    db.migrate();
    db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", MIGRATIONS.at(-1)!.version + 1, new Date().toISOString());
    expect(() => db.migrate()).toThrow(NewerDatabaseError);
    db.close();
  });
});

describe("backup names", () => {
  it("round-trip beta versions and read copies made before labels", () => {
    const name = backupName(5, "0.13.0-beta.1", new Date("2026-11-17T09:08:07.006Z"));
    expect(name).toBe("matchframe-v5-from-0.13.0-beta.1-2026-11-17T09-08-07-006Z.sqlite");
    expect(parseBackupName(name)).toEqual({ name, schema: 5, fromVersion: "0.13.0-beta.1", createdAt: "2026-11-17T09:08:07.006Z" });
    expect(parseBackupName("matchframe-v3-2026-10-01T00-00-00-000Z.sqlite")).toMatchObject({ schema: 3, fromVersion: null });
    expect(parseBackupName("notes.txt")).toBeNull();
    expect(backupName(5, "../../evil", new Date(0))).toBe("matchframe-v5-1970-01-01T00-00-00-000Z.sqlite");
  });
});
