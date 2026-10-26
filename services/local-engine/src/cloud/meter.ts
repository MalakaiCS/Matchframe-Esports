import { randomUUID } from "node:crypto";
import type { DirectorMode } from "@matchframe/contracts";
import type { UsageRecord } from "@matchframe/cloud-contracts";
import type { Database } from "../db/database.ts";

/** Local ledger of auto-director usage (SQLite) until it is accepted by the cloud. */
export class UsageLedger {
  constructor(private readonly db: Database) {}

  add(r: UsageRecord): void {
    this.db.run(
      "INSERT OR IGNORE INTO cloud_usage (record_id, started_at, ended_at, seconds, session_id, match_ref, map_name, app_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      r.recordId,
      r.startedAt,
      r.endedAt,
      r.seconds,
      r.sessionId,
      r.matchRef,
      r.mapName,
      r.appVersion,
    );
  }

  pending(limit = 500): UsageRecord[] {
    return this.db
      .all<{ record_id: string; started_at: string; ended_at: string; seconds: number; session_id: string; match_ref: string | null; map_name: string | null; app_version: string }>(
        "SELECT record_id, started_at, ended_at, seconds, session_id, match_ref, map_name, app_version FROM cloud_usage WHERE uploaded_at IS NULL AND rejected_reason IS NULL ORDER BY started_at LIMIT ?",
        limit,
      )
      .map((r) => ({ recordId: r.record_id, kind: "auto_director", startedAt: r.started_at, endedAt: r.ended_at, seconds: r.seconds, sessionId: r.session_id, matchRef: r.match_ref, mapName: r.map_name, appVersion: r.app_version }));
  }

  markUploaded(ids: string[], at: string): void {
    for (const id of ids) this.db.run("UPDATE cloud_usage SET uploaded_at = ? WHERE record_id = ?", at, id);
  }

  /** Records that can no longer be uploaded to the account they were recorded under. */
  abandonPending(reason: string): number {
    return Number(this.db.run("UPDATE cloud_usage SET rejected_reason = ? WHERE uploaded_at IS NULL AND rejected_reason IS NULL", reason).changes);
  }

  markRejected(id: string, reason: string): void {
    this.db.run("UPDATE cloud_usage SET rejected_reason = ? WHERE record_id = ?", reason.slice(0, 300), id);
  }

  /** Most recent records first, with their upload state (Account screen). */
  recent(limit = 100): (UsageRecord & { uploadedAt: string | null; rejectedReason: string | null })[] {
    return this.db
      .all<{ record_id: string; started_at: string; ended_at: string; seconds: number; session_id: string; match_ref: string | null; map_name: string | null; app_version: string; uploaded_at: string | null; rejected_reason: string | null }>(
        "SELECT * FROM cloud_usage ORDER BY started_at DESC LIMIT ?",
        limit,
      )
      .map((r) => ({ recordId: r.record_id, kind: "auto_director", startedAt: r.started_at, endedAt: r.ended_at, seconds: r.seconds, sessionId: r.session_id, matchRef: r.match_ref, mapName: r.map_name, appVersion: r.app_version, uploadedAt: r.uploaded_at, rejectedReason: r.rejected_reason }));
  }

  /**
   * Seconds the website had not been told about when a licence was requested at `localIso` (this
   * computer's clock on both sides, so clock skew does not matter): still pending, or uploaded later.
   */
  secondsNotUploadedBefore(localIso: string): number {
    return this.db.get<{ s: number | null }>("SELECT sum(seconds) AS s FROM cloud_usage WHERE rejected_reason IS NULL AND (uploaded_at IS NULL OR uploaded_at >= ?)", localIso)?.s ?? 0;
  }

  stats(): { pendingRecords: number; pendingSeconds: number; rejected: number; totalSeconds: number } {
    const r = this.db.get<{ pr: number; ps: number | null; rj: number; ts: number | null }>(
      "SELECT sum(CASE WHEN uploaded_at IS NULL AND rejected_reason IS NULL THEN 1 ELSE 0 END) AS pr, sum(CASE WHEN uploaded_at IS NULL AND rejected_reason IS NULL THEN seconds ELSE 0 END) AS ps, sum(CASE WHEN rejected_reason IS NOT NULL THEN 1 ELSE 0 END) AS rj, sum(seconds) AS ts FROM cloud_usage",
    );
    return { pendingRecords: r?.pr ?? 0, pendingSeconds: r?.ps ?? 0, rejected: r?.rj ?? 0, totalSeconds: r?.ts ?? 0 };
  }
}

export interface MeterInput {
  /** The control arbiter lets the director write to the observer (armed, no manual ownership). */
  automationActive: boolean;
  /** This computer is linked to an account (usage while unlinked is never charged later). */
  accountLinked: boolean;
  /** A real (non-simulated) observer control adapter is connected, so automation can move the camera. */
  controlAvailable: boolean;
  mode: DirectorMode;
  simulated: boolean;
  telemetryLive: boolean;
  sessionId: string;
  mapName: string | null;
  matchRef: string | null;
}

/**
 * Billable: automation actually owns a real camera on live, non-simulated telemetry. Advisory,
 * shadow, manual control, simulation, stale telemetry, "no control adapter" and unlinked use are free.
 */
export function isBillable(i: MeterInput): boolean {
  return i.accountLinked && i.automationActive && i.controlAvailable && (i.mode === "automatic" || i.mode === "assisted") && !i.simulated && i.telemetryLive;
}

interface Segment {
  recordId: string;
  startMono: number;
  lastMono: number;
  startWall: number;
  sessionId: string;
  mapName: string | null;
  matchRef: string | null;
}

/**
 * Turns continuous billable time into usage records: a record closes when billing stops, the map
 * or session changes, every `maxSegmentMs` (so long matches upload progressively), or when ticks
 * stop arriving (sleep/suspend is never billed).
 */
export class AutoDirectorMeter {
  private seg: Segment | null = null;

  constructor(
    private readonly ledger: UsageLedger,
    private readonly opts: { appVersion: string; monoNow: () => number; wallNow: () => number; maxSegmentMs?: number; maxGapMs?: number },
  ) {}

  tick(i: MeterInput): void {
    const t = this.opts.monoNow();
    const s = this.seg;
    if (s && t - s.lastMono > (this.opts.maxGapMs ?? 5000)) this.close(s.lastMono);
    const billable = isBillable(i);
    const cur = this.seg;
    // Billing stopped: bill only up to the last tick that was seen billable.
    if (cur && !billable) this.close(cur.lastMono);
    // Continuous billing that changes map/session or rolls over: the next segment starts at this tick.
    else if (cur && (cur.sessionId !== i.sessionId || cur.mapName !== i.mapName || t - cur.startMono >= (this.opts.maxSegmentMs ?? 300_000))) this.close(t);
    if (billable && !this.seg) this.seg = { recordId: randomUUID(), startMono: t, lastMono: t, startWall: this.opts.wallNow(), sessionId: i.sessionId, mapName: i.mapName, matchRef: i.matchRef };
    if (this.seg) this.seg.lastMono = t;
  }

  /** Seconds in the open (not yet recorded) segment. */
  openSeconds(): number {
    return this.seg ? Math.floor((this.seg.lastMono - this.seg.startMono) / 1000) : 0;
  }

  get active(): boolean {
    return this.seg !== null;
  }

  /** Close the open segment now (before sync or shutdown). */
  flush(): void {
    if (this.seg) this.close(this.seg.lastMono);
  }

  private close(endMono: number): void {
    const s = this.seg!;
    this.seg = null;
    const ms = Math.max(0, endMono - s.startMono);
    const seconds = Math.floor(ms / 1000);
    if (seconds < 1) return;
    this.ledger.add({
      recordId: s.recordId,
      kind: "auto_director",
      startedAt: new Date(s.startWall).toISOString(),
      endedAt: new Date(s.startWall + ms).toISOString(),
      seconds: Math.min(seconds, 6 * 3600),
      sessionId: s.sessionId.slice(0, 80),
      matchRef: s.matchRef,
      mapName: s.mapName,
      appVersion: this.opts.appVersion,
    });
  }
}
