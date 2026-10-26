# Storage, retention and recovery

## Local data directory

`%APPDATA%\Matchframe Esports` on Windows (`MATCHFRAME_DATA_DIR` overrides): `matchframe.sqlite` (+WAL), `backups/` (pre-migration copies), `logs/` (rotating JSON lines, 5 MB × 5), `assets/` (content-addressed uploads), `huds/` (installed HUD packages by version), `datasets/` (Parquet datasets), `demo-ingest/` (managed ingest root), `demo-quarantine/`, `models/`, `secrets.json`, `operator-url.txt`.

## Demo library retention (spec §15.6)

Per-job retention policy: `keep_originals`, `quarantine_then_remove` (default, 7-day reversible quarantine), `keep_curated_sample` (deterministic audit/holdout sample kept by content hash, default 5%), `keep_until_backup_confirmed`, `remove_after_validation` (managed ingest folders only, still passes through quarantine with zero days).

A raw demo is deleted only when **all** hold:
1. The file's real path is inside a configured ingest root (files imported from arbitrary folders get `keep_originals`).
2. The job is `COMMITTED` with a `usable` validation verdict (failed, quarantined or unverified extractions are never eligible).
3. Its quarantine period has expired, and the quarantined file is inside the quarantine directory.
4. A fresh `verify` of the dataset (checksums + sample query) succeeds immediately before deletion.

Quarantined demos can be restored (`POST /api/v1/demos/jobs/:id/restore`). Provenance (source path, size, SHA-256, import time) stays in the job record after removal so a source can be re-downloaded and re-ingested when a future parser needs fields that were not retained.

## The ~2 TB plan

Planning allocation (decimal GB, configurable as soft/hard quotas in `demos.config`): sampled state 600, events/features 300, raw ingest workspace 200, curated raw audit/holdout 150, models/experiments 100, thumbnails/review clips 150, metadata/indexes/logs 50, free headroom 450. Admission control refuses an extraction when free space is below `max(20 GB, 3 × demo size)` or the dataset hard quota would be exceeded; the job waits in `QUEUED` with a visible reason. Measured sizes from real demos and the capacity forecast are in `docs/models/phase0-demo-pipeline-report.md`.

Backups are separate from raw deletion: deleting a raw demo is not a backup. If replication is configured, confirm it (`POST /api/v1/demos/backup-confirmed`) before `keep_until_backup_confirmed` allows removal.

## Crash recovery

- Jobs interrupted in `PARSING`/`EXTRACTED`/`VALIDATING` become `RECOVERABLE` → `QUEUED` on start; leftover temporary dataset directories are removed. Workers write to a temporary directory and rename atomically, so no half-written dataset is ever marked committed. If an attempt committed its dataset and crashed before the engine recorded it, the retry gets `duplicate` from the worker and adopts that dataset (after validation) instead of extracting twice (tested on real demos).
- Unreadable, unsupported, truncated or partial demos (worker codes `UNSUPPORTED_FORMAT`, `PARSER_FAILED`, `EMPTY_PARSE`, `INPUT_UNREADABLE`, or a `quarantine` validation verdict) go to `QUARANTINED` and are never retention-eligible; missing files and internal errors are `FAILED` and can be retried.
- The engine restarts in manual/disarmed mode and keeps its database, outputs, packages and settings.
- Before any schema migration of an existing database a copy is written to `backups/`.

## Event packages

`GET /api/v1/export/event-package` produces a checksummed JSON package (teams, players, rosters with history, events, matches, map instances, veto history, sponsors, rundown, stages, rules, outputs, corrections, referenced assets). Import previews counts and id collisions first; a modified package fails the checksum; restore refuses collisions.
