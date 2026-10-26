import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { DemoJobState, MapInstance, RetentionPolicy, RosterMembership, VetoDecision } from "@matchframe/contracts";
import { DEMO_JOB_TRANSITIONS, MapInstance as MapInstanceSchema, RosterMembership as RosterSchema } from "@matchframe/contracts";
import type { Database } from "./database.ts";

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
const nowIso = () => new Date().toISOString();

export class NotFoundError extends Error {
  readonly status = 404;
}

export class ConflictError extends Error {
  readonly status = 409;
}

export class ValidationError extends Error {
  readonly status = 400;
  constructor(
    message: string,
    readonly issues: unknown = null,
  ) {
    super(message);
  }
}

interface DocRow {
  id: string;
  data: string;
  revision: number;
  archived: number;
  created_at: string;
  updated_at: string;
}

export interface Doc<T> {
  id: string;
  data: T;
  revision: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Schema-validated document repository with optimistic revision checks. */
export class DocumentRepo<S extends z.ZodType<{ id: string }>> {
  constructor(
    private readonly db: Database,
    readonly kind: string,
    private readonly schema: S,
  ) {}

  private parse(input: unknown): z.infer<S> {
    const r = this.schema.safeParse(input);
    if (!r.success) throw new ValidationError(`invalid ${this.kind}`, r.error.issues);
    return r.data;
  }

  private toDoc(row: DocRow): Doc<z.infer<S>> {
    return {
      id: row.id,
      data: JSON.parse(row.data) as z.infer<S>,
      revision: row.revision,
      archived: row.archived === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  list(opts: { includeArchived?: boolean } = {}): Doc<z.infer<S>>[] {
    const rows = this.db.all<DocRow>(
      `SELECT id, data, revision, archived, created_at, updated_at FROM documents WHERE kind = ? ${opts.includeArchived ? "" : "AND archived = 0"} ORDER BY created_at`,
      this.kind,
    );
    return rows.map((r) => this.toDoc(r));
  }

  get(id: string): Doc<z.infer<S>> | undefined {
    const row = this.db.get<DocRow>("SELECT id, data, revision, archived, created_at, updated_at FROM documents WHERE kind = ? AND id = ?", this.kind, id);
    return row ? this.toDoc(row) : undefined;
  }

  require(id: string): Doc<z.infer<S>> {
    const d = this.get(id);
    if (!d) throw new NotFoundError(`${this.kind} ${id} not found`);
    return d;
  }

  create(input: Record<string, unknown>, idPrefix = this.kind): Doc<z.infer<S>> {
    const data = this.parse({ ...input, id: (input.id as string | undefined) ?? newId(idPrefix) });
    const at = nowIso();
    try {
      this.db.run("INSERT INTO documents (kind, id, data, revision, archived, created_at, updated_at) VALUES (?, ?, ?, 1, 0, ?, ?)", this.kind, data.id, JSON.stringify(data), at, at);
    } catch (e) {
      if (String(e).includes("UNIQUE")) throw new ConflictError(`${this.kind} ${data.id} already exists`);
      throw e;
    }
    return this.require(data.id);
  }

  /** Update with an optional expected revision (optimistic concurrency). */
  update(id: string, patch: Record<string, unknown>, expectedRevision?: number): Doc<z.infer<S>> {
    return this.db.transaction(() => {
      const cur = this.require(id);
      if (expectedRevision !== undefined && cur.revision !== expectedRevision) {
        throw new ConflictError(`${this.kind} ${id} revision ${cur.revision} != expected ${expectedRevision}`);
      }
      const data = this.parse({ ...(cur.data as object), ...patch, id });
      this.db.run("UPDATE documents SET data = ?, revision = revision + 1, updated_at = ? WHERE kind = ? AND id = ?", JSON.stringify(data), nowIso(), this.kind, id);
      return this.require(id);
    });
  }

  archive(id: string, archived = true): void {
    this.require(id);
    this.db.run("UPDATE documents SET archived = ?, updated_at = ? WHERE kind = ? AND id = ?", archived ? 1 : 0, nowIso(), this.kind, id);
  }

  delete(id: string): void {
    this.db.run("DELETE FROM documents WHERE kind = ? AND id = ?", this.kind, id);
  }
}

export interface AuditEntry {
  seq: number;
  at: string;
  actor: string;
  action: string;
  target: string | null;
  detail: unknown;
}

export class AuditRepo {
  constructor(private readonly db: Database) {}

  record(actor: string, action: string, target: string | null, detail: unknown = null): void {
    this.db.run("INSERT INTO audit_log (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)", nowIso(), actor, action, target, detail === null ? null : JSON.stringify(detail));
  }

  recent(limit = 200): AuditEntry[] {
    return this.db
      .all<{ seq: number; at: string; actor: string; action: string; target: string | null; detail: string | null }>("SELECT * FROM audit_log ORDER BY seq DESC LIMIT ?", limit)
      .map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
  }
}

export class SettingsRepo {
  constructor(private readonly db: Database) {}

  get<T>(key: string, fallback: T): T {
    const row = this.db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key);
    return row ? (JSON.parse(row.value) as T) : fallback;
  }

  set(key: string, value: unknown): void {
    this.db.run(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      key,
      JSON.stringify(value),
      nowIso(),
    );
  }
}

export class RosterRepo {
  constructor(private readonly db: Database) {}

  forTeam(teamId: string, at: string = nowIso()): RosterMembership[] {
    return this.db
      .all<{ id: string; team_id: string; player_id: string; role: string; valid_from: string; valid_to: string | null }>(
        "SELECT * FROM roster_memberships WHERE team_id = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?) ORDER BY valid_from",
        teamId,
        at,
        at,
      )
      .map((r) => RosterSchema.parse({ id: r.id, teamId: r.team_id, playerId: r.player_id, role: r.role, validFrom: r.valid_from, validTo: r.valid_to }));
  }

  history(playerId: string): RosterMembership[] {
    return this.db
      .all<{ id: string; team_id: string; player_id: string; role: string; valid_from: string; valid_to: string | null }>("SELECT * FROM roster_memberships WHERE player_id = ? ORDER BY valid_from", playerId)
      .map((r) => RosterSchema.parse({ id: r.id, teamId: r.team_id, playerId: r.player_id, role: r.role, validFrom: r.valid_from, validTo: r.valid_to }));
  }

  /** Adds a player to a team, closing any open membership elsewhere (history is preserved). */
  join(teamId: string, playerId: string, role: RosterMembership["role"] = "player", at: string = nowIso()): RosterMembership {
    return this.db.transaction(() => {
      this.db.run("UPDATE roster_memberships SET valid_to = ? WHERE player_id = ? AND valid_to IS NULL AND team_id != ?", at, playerId, teamId);
      const existing = this.db.get<{ id: string }>("SELECT id FROM roster_memberships WHERE player_id = ? AND team_id = ? AND valid_to IS NULL", playerId, teamId);
      if (existing) {
        this.db.run("UPDATE roster_memberships SET role = ? WHERE id = ?", role, existing.id);
        return this.forTeam(teamId, at).find((m) => m.id === existing.id)!;
      }
      const id = newId("mem");
      this.db.run("INSERT INTO roster_memberships (id, team_id, player_id, role, valid_from, valid_to) VALUES (?, ?, ?, ?, ?, NULL)", id, teamId, playerId, role, at);
      return { id, teamId, playerId, role, validFrom: at, validTo: null };
    });
  }

  leave(teamId: string, playerId: string, at: string = nowIso()): void {
    this.db.run("UPDATE roster_memberships SET valid_to = ? WHERE team_id = ? AND player_id = ? AND valid_to IS NULL", at, teamId, playerId);
  }

  /** Team for a player at a given time (null when not rostered). */
  teamOf(playerId: string, at: string = nowIso()): string | null {
    const row = this.db.get<{ team_id: string }>(
      "SELECT team_id FROM roster_memberships WHERE player_id = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?) ORDER BY valid_from DESC LIMIT 1",
      playerId,
      at,
      at,
    );
    return row?.team_id ?? null;
  }
}

export class SteamIndexRepo {
  constructor(private readonly db: Database) {}

  set(steamId: string, playerId: string): void {
    this.db.run("INSERT INTO players_steam (steam_id, player_id) VALUES (?, ?) ON CONFLICT(steam_id) DO UPDATE SET player_id = excluded.player_id", steamId, playerId);
  }

  remove(steamId: string): void {
    this.db.run("DELETE FROM players_steam WHERE steam_id = ?", steamId);
  }

  lookup(steamId: string): string | null {
    return this.db.get<{ player_id: string }>("SELECT player_id FROM players_steam WHERE steam_id = ?", steamId)?.player_id ?? null;
  }
}

export class MapInstanceRepo {
  constructor(private readonly db: Database) {}

  forMatch(matchId: string): MapInstance[] {
    return this.db.all<{ data: string }>("SELECT data FROM map_instances WHERE match_id = ? ORDER BY ord", matchId).map((r) => MapInstanceSchema.parse(JSON.parse(r.data)));
  }

  upsert(mi: MapInstance): MapInstance {
    const data = MapInstanceSchema.parse(mi);
    this.db.run(
      "INSERT INTO map_instances (id, match_id, ord, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, ord = excluded.ord",
      data.id,
      data.matchId,
      data.order,
      JSON.stringify(data),
    );
    return data;
  }

  remove(id: string): void {
    this.db.run("DELETE FROM map_instances WHERE id = ?", id);
  }
}

export class VetoRepo {
  constructor(private readonly db: Database) {}

  active(matchId: string): VetoDecision[] {
    return this.db
      .all<{ data: string }>("SELECT data FROM veto_decisions WHERE match_id = ? AND superseded_by IS NULL ORDER BY step_order", matchId)
      .map((r) => JSON.parse(r.data) as VetoDecision);
  }

  history(matchId: string): (VetoDecision & { supersededBy: string | null })[] {
    return this.db
      .all<{ data: string; superseded_by: string | null }>("SELECT data, superseded_by FROM veto_decisions WHERE match_id = ? ORDER BY created_at", matchId)
      .map((r) => ({ ...(JSON.parse(r.data) as VetoDecision), supersededBy: r.superseded_by }));
  }

  /** Inserts a decision; the unique partial index makes concurrent submissions for one step fail. */
  commit(d: VetoDecision): VetoDecision {
    try {
      this.db.run("INSERT INTO veto_decisions (id, match_id, step_order, data, superseded_by, created_at) VALUES (?, ?, ?, ?, NULL, ?)", d.id, d.matchId, d.stepOrder, JSON.stringify(d), d.decidedAt);
    } catch (e) {
      if (String(e).includes("UNIQUE")) throw new ConflictError(`veto step ${d.stepOrder} already decided`);
      throw e;
    }
    return d;
  }

  /** Audited operator revision: supersedes the active decision for a step with a new one. */
  revise(matchId: string, stepOrder: number, next: VetoDecision): VetoDecision {
    return this.db.transaction(() => {
      const cur = this.db.get<{ id: string }>("SELECT id FROM veto_decisions WHERE match_id = ? AND step_order = ? AND superseded_by IS NULL", matchId, stepOrder);
      if (!cur) throw new NotFoundError(`no decision for step ${stepOrder}`);
      this.db.run("UPDATE veto_decisions SET superseded_by = ? WHERE id = ?", next.id, cur.id);
      this.db.run("INSERT INTO veto_decisions (id, match_id, step_order, data, superseded_by, created_at) VALUES (?, ?, ?, ?, NULL, ?)", next.id, matchId, stepOrder, JSON.stringify({ ...next, revisionOf: cur.id }), next.decidedAt);
      return { ...next, revisionOf: cur.id };
    });
  }

  reset(matchId: string): void {
    this.db.run("DELETE FROM veto_decisions WHERE match_id = ?", matchId);
  }
}

export interface DemoJob {
  id: string;
  state: DemoJobState;
  sourcePath: string;
  ingestRoot: string | null;
  sha256: string | null;
  sizeBytes: number | null;
  mapName: string | null;
  gameBuild: string | null;
  datasetDir: string | null;
  parser: string | null;
  schemaVersion: number | null;
  attempts: number;
  lastCheckpoint: string | null;
  failureReason: string | null;
  validation: unknown;
  retentionPolicy: RetentionPolicy;
  quarantineUntil: string | null;
  bytesRead: number | null;
  bytesWritten: number | null;
  provenance: unknown;
  createdAt: string;
  updatedAt: string;
}

interface DemoJobRow {
  id: string;
  state: string;
  source_path: string;
  ingest_root: string | null;
  sha256: string | null;
  size_bytes: number | null;
  map_name: string | null;
  game_build: string | null;
  dataset_dir: string | null;
  parser: string | null;
  schema_version: number | null;
  attempts: number;
  last_checkpoint: string | null;
  failure_reason: string | null;
  validation: string | null;
  retention_policy: string;
  quarantine_until: string | null;
  bytes_read: number | null;
  bytes_written: number | null;
  provenance: string | null;
  created_at: string;
  updated_at: string;
}

export class IllegalTransitionError extends Error {
  readonly status = 409;
}

export class DemoJobRepo {
  constructor(private readonly db: Database) {}

  private toJob(r: DemoJobRow): DemoJob {
    return {
      id: r.id,
      state: r.state as DemoJobState,
      sourcePath: r.source_path,
      ingestRoot: r.ingest_root,
      sha256: r.sha256,
      sizeBytes: r.size_bytes,
      mapName: r.map_name,
      gameBuild: r.game_build,
      datasetDir: r.dataset_dir,
      parser: r.parser,
      schemaVersion: r.schema_version,
      attempts: r.attempts,
      lastCheckpoint: r.last_checkpoint,
      failureReason: r.failure_reason,
      validation: r.validation ? JSON.parse(r.validation) : null,
      retentionPolicy: r.retention_policy as RetentionPolicy,
      quarantineUntil: r.quarantine_until,
      bytesRead: r.bytes_read,
      bytesWritten: r.bytes_written,
      provenance: r.provenance ? JSON.parse(r.provenance) : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  create(sourcePath: string, ingestRoot: string | null, retentionPolicy: RetentionPolicy, provenance: unknown): DemoJob {
    const id = newId("demo");
    const at = nowIso();
    this.db.transaction(() => {
      this.db.run(
        "INSERT INTO demo_jobs (id, state, source_path, ingest_root, retention_policy, provenance, created_at, updated_at) VALUES (?, 'DISCOVERED', ?, ?, ?, ?, ?, ?)",
        id,
        sourcePath,
        ingestRoot,
        retentionPolicy,
        JSON.stringify(provenance ?? null),
        at,
        at,
      );
      this.db.run("INSERT INTO demo_job_transitions (job_id, from_state, to_state, at, detail) VALUES (?, NULL, 'DISCOVERED', ?, NULL)", id, at);
    });
    return this.require(id);
  }

  get(id: string): DemoJob | undefined {
    const r = this.db.get<DemoJobRow>("SELECT * FROM demo_jobs WHERE id = ?", id);
    return r ? this.toJob(r) : undefined;
  }

  require(id: string): DemoJob {
    const j = this.get(id);
    if (!j) throw new NotFoundError(`demo job ${id} not found`);
    return j;
  }

  list(state?: DemoJobState, limit = 500): DemoJob[] {
    const rows = state
      ? this.db.all<DemoJobRow>("SELECT * FROM demo_jobs WHERE state = ? ORDER BY created_at LIMIT ?", state, limit)
      : this.db.all<DemoJobRow>("SELECT * FROM demo_jobs ORDER BY created_at DESC LIMIT ?", limit);
    return rows.map((r) => this.toJob(r));
  }

  findBySha(sha256: string): DemoJob | undefined {
    const r = this.db.get<DemoJobRow>("SELECT * FROM demo_jobs WHERE sha256 = ? AND state NOT IN ('DUPLICATE','FAILED') LIMIT 1", sha256);
    return r ? this.toJob(r) : undefined;
  }

  findByDataset(datasetDir: string): DemoJob | undefined {
    const r = this.db.get<DemoJobRow>("SELECT * FROM demo_jobs WHERE dataset_dir = ? LIMIT 1", datasetDir);
    return r ? this.toJob(r) : undefined;
  }

  transitions(id: string): { from: string | null; to: string; at: string; detail: unknown }[] {
    return this.db
      .all<{ from_state: string | null; to_state: string; at: string; detail: string | null }>("SELECT from_state, to_state, at, detail FROM demo_job_transitions WHERE job_id = ? ORDER BY seq", id)
      .map((r) => ({ from: r.from_state, to: r.to_state, at: r.at, detail: r.detail ? JSON.parse(r.detail) : null }));
  }

  /** State transition enforced against the contract state machine, with field updates, atomically. */
  transition(id: string, to: DemoJobState, fields: Partial<Omit<DemoJob, "id" | "state" | "createdAt" | "updatedAt">> = {}, detail: unknown = null): DemoJob {
    return this.db.transaction(() => {
      const cur = this.require(id);
      const allowed = DEMO_JOB_TRANSITIONS[cur.state];
      if (!allowed.includes(to)) throw new IllegalTransitionError(`demo job ${id}: ${cur.state} → ${to} is not allowed`);
      const at = nowIso();
      const map: Record<string, unknown> = {
        sha256: fields.sha256,
        size_bytes: fields.sizeBytes,
        map_name: fields.mapName,
        game_build: fields.gameBuild,
        dataset_dir: fields.datasetDir,
        parser: fields.parser,
        schema_version: fields.schemaVersion,
        attempts: fields.attempts,
        last_checkpoint: fields.lastCheckpoint,
        failure_reason: fields.failureReason,
        validation: fields.validation === undefined ? undefined : JSON.stringify(fields.validation),
        quarantine_until: fields.quarantineUntil,
        bytes_read: fields.bytesRead,
        bytes_written: fields.bytesWritten,
      };
      const sets: string[] = ["state = ?", "updated_at = ?"];
      const params: (string | number | null)[] = [to, at];
      for (const [col, v] of Object.entries(map)) {
        if (v === undefined) continue;
        sets.push(`${col} = ?`);
        params.push(v as string | number | null);
      }
      this.db.run(`UPDATE demo_jobs SET ${sets.join(", ")} WHERE id = ?`, ...params, id);
      this.db.run("INSERT INTO demo_job_transitions (job_id, from_state, to_state, at, detail) VALUES (?, ?, ?, ?, ?)", id, cur.state, to, at, detail === null ? null : JSON.stringify(detail));
      return this.require(id);
    });
  }

  counts(): Record<string, number> {
    const rows = this.db.all<{ state: string; n: number }>("SELECT state, COUNT(*) AS n FROM demo_jobs GROUP BY state");
    return Object.fromEntries(rows.map((r) => [r.state, r.n]));
  }
}
