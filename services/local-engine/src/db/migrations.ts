export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Ordered, append-only schema migrations. Never edit a released migration; add a new one. */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial",
    sql: `
      CREATE TABLE documents (
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        data TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (kind, id)
      );
      CREATE INDEX documents_kind ON documents(kind, archived);

      CREATE TABLE players_steam (
        steam_id TEXT PRIMARY KEY,
        player_id TEXT NOT NULL
      );

      CREATE TABLE roster_memberships (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        player_id TEXT NOT NULL,
        role TEXT NOT NULL,
        valid_from TEXT NOT NULL,
        valid_to TEXT
      );
      CREATE INDEX roster_by_team ON roster_memberships(team_id);
      CREATE INDEX roster_by_player ON roster_memberships(player_id);

      CREATE TABLE map_instances (
        id TEXT PRIMARY KEY,
        match_id TEXT NOT NULL,
        ord INTEGER NOT NULL,
        data TEXT NOT NULL,
        UNIQUE (match_id, ord)
      );

      CREATE TABLE veto_decisions (
        id TEXT PRIMARY KEY,
        match_id TEXT NOT NULL,
        step_order INTEGER NOT NULL,
        data TEXT NOT NULL,
        superseded_by TEXT,
        created_at TEXT NOT NULL
      );
      -- Exactly one active decision per step: concurrent submissions cannot both commit.
      CREATE UNIQUE INDEX veto_one_active_per_step ON veto_decisions(match_id, step_order) WHERE superseded_by IS NULL;

      CREATE TABLE audit_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        detail TEXT
      );

      CREATE TABLE stat_corrections (
        id TEXT PRIMARY KEY,
        match_id TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE hud_packages (
        id TEXT PRIMARY KEY,
        manifest TEXT NOT NULL,
        classification TEXT NOT NULL,
        install_dir TEXT NOT NULL,
        checksums TEXT NOT NULL,
        installed_at TEXT NOT NULL,
        previous TEXT
      );

      CREATE TABLE output_revisions (
        output_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        data TEXT NOT NULL,
        published_at TEXT NOT NULL,
        published_by TEXT NOT NULL,
        PRIMARY KEY (output_id, revision)
      );

      CREATE TABLE demo_jobs (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        source_path TEXT NOT NULL,
        ingest_root TEXT,
        sha256 TEXT,
        size_bytes INTEGER,
        map_name TEXT,
        game_build TEXT,
        dataset_dir TEXT,
        parser TEXT,
        schema_version INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_checkpoint TEXT,
        failure_reason TEXT,
        validation TEXT,
        retention_policy TEXT NOT NULL,
        quarantine_until TEXT,
        bytes_read INTEGER,
        bytes_written INTEGER,
        provenance TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX demo_jobs_sha ON demo_jobs(sha256) WHERE sha256 IS NOT NULL AND state NOT IN ('DUPLICATE','FAILED');
      CREATE INDEX demo_jobs_state ON demo_jobs(state);

      CREATE TABLE demo_job_transitions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        from_state TEXT,
        to_state TEXT NOT NULL,
        at TEXT NOT NULL,
        detail TEXT
      );

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE sponsor_deliveries (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        sponsor_id TEXT NOT NULL,
        output_id TEXT NOT NULL,
        zone TEXT NOT NULL,
        shown_at TEXT NOT NULL,
        hidden_at TEXT,
        duration_ms INTEGER,
        acknowledged INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE replay_clips (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: "cloud usage ledger",
    sql: `
      CREATE TABLE cloud_usage (
        record_id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL,
        seconds INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        match_ref TEXT,
        map_name TEXT,
        app_version TEXT NOT NULL,
        uploaded_at TEXT,
        rejected_reason TEXT
      );
      CREATE INDEX cloud_usage_pending ON cloud_usage(uploaded_at);
    `,
  },
];
