import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { SyncChange, SyncItem, SyncKind } from "@matchframe/cloud-contracts";
import { SYNC_BLOB_MAX_BYTES, SYNC_ITEM_MAX_BYTES, SyncChanges, SyncPushResult } from "@matchframe/cloud-contracts";
import type { Database } from "../db/database.ts";
import type { SettingsRepo } from "../db/store.ts";
import { zipPackageDir } from "../hud/packages.ts";
import type { Logger } from "../logger.ts";
import type { CloudLink } from "./link.ts";
import type { SyncLocal, SyncStateRow } from "./sync-local.ts";
import { GONE, keyOf, parseBlobs } from "./sync-local.ts";

/**
 * Account sync (the website side is services/cloud-api): every computer linked to an organisation
 * shares its teams, players, rosters, events, matches (maps and veto), their logos and photos, and
 * the HUDs the user imported. Changes are found by comparing the records with what was last shared
 * (sync_state), so every way of changing them counts. The organisation's changes are fetched first,
 * then this computer's are sent; the last edit wins. Offline, everything works as before and
 * changes wait until the website is back.
 */

export interface SyncTiming {
  /** How often the loop wakes. */
  tickMs: number;
  /** Records are compared with what was shared this often, */
  scanMs: number;
  /** and this long after a change through the program's API. */
  debounceMs: number;
  /** The organisation's changes are fetched this often. */
  pullMs: number;
  /** The organisation's storage and item counts. */
  statusMs: number;
  /** After network trouble: the first wait, doubling up to the longest. */
  backoffMs: number;
  backoffMaxMs: number;
  /** A refused change is sent again after this long (sooner when it changes). */
  rejectRetryMs: number;
}

export const SYNC_TIMING: SyncTiming = { tickMs: 1000, scanMs: 3000, debounceMs: 1000, pullMs: 5000, statusMs: 60_000, backoffMs: 5000, backoffMaxMs: 5 * 60_000, rejectRetryMs: 10 * 60_000 };

const ENABLED_KEY = "cloud.sync.enabled";
const CURSOR_KEY = "cloud.sync.cursor";
const ORG_KEY = "cloud.sync.org";
const BATCH = 200;
/** A website without account sync is asked again after this long. */
const UNSUPPORTED_RETRY_MS = 10 * 60_000;
const MISSING_BLOB_RETRY_MS = 30_000;
const FULL_SCAN_MS = 60_000;
/** The website deletes files no record names after an hour: an upload older than this is not relied on. */
const UPLOAD_TRUST_MS = 45 * 60_000;

const KIND_NAMES: Record<SyncKind, string> = { team: "team", player: "player", roster: "roster entry", event: "event", match: "match", map: "map", veto: "veto step", asset: "image", hud: "HUD" };

/** The website could not answer now (offline, timeout, server trouble): tried again with backoff. */
class Unreachable extends Error {}

/** The website answered, but not with what was asked (no account sync, signed out, refused). */
class Refused extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const OrgStatus = z.object({ blobBytes: z.number(), quotaBytes: z.number(), items: z.record(z.string(), z.number()).default({}) });

interface Upload {
  sha: string;
  label: string;
  load: () => Promise<Uint8Array>;
}

interface Prepared {
  change: SyncChange;
  hash: string;
  blobKey: string | null;
  uploads: Upload[];
  problem: string | null;
}

export interface SyncView {
  enabled: boolean;
  linked: boolean;
  orgName: string | null;
  /** off · signed_out · starting (first sync not done) · syncing (moving files) · ok · offline · error */
  state: "off" | "signed_out" | "starting" | "syncing" | "ok" | "offline" | "error";
  lastPullAt: string | null;
  lastPushAt: string | null;
  lastSyncAt: string | null;
  pending: number;
  pendingByKind: Record<string, number>;
  /** Shared records on this computer per kind. */
  counts: Record<string, number>;
  busy: string | null;
  storage: { usedBytes: number; quotaBytes: number } | null;
  orgItems: Record<string, number> | null;
  rejected: { kind: string; id: string; reason: string }[];
  merged: number;
  lastError: string | null;
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Sizes as the website shows them (1 GB = 1024 MB). */
export function sizeText(bytes: number): string {
  const [v, unit] = bytes >= 1024 ** 3 ? [bytes / 1024 ** 3, "GB"] : bytes >= 1024 ** 2 ? [bytes / 1024 ** 2, "MB"] : [bytes / 1024, "KB"];
  return `${Math.round(v * 10) / 10} ${unit}`;
}

/** A refusal reason in plain words ("quota_exceeded <used> <quota>", "too_large <bytes>", "missing_blob <sha>", ...). */
export function plainReason(reason: string): string {
  const [code, a, b] = reason.split(" ");
  if (code === "quota_exceeded") return Number(a) >= 0 && Number(b) > 0 ? `Your organisation's shared storage is full: ${sizeText(Number(a))} of ${sizeText(Number(b))}` : "Your organisation's shared storage is full";
  if (code === "missing_blob") return "a file had not arrived yet (it is sent again)";
  if (code === "too_large") return "it is too large to share";
  if (code === "file_mismatch") return "a file changed while it was sent (it is sent again)";
  return reason;
}

export class CloudSync {
  timing: SyncTiming = { ...SYNC_TIMING };
  /** Bumped whenever the organisation's changes were applied here (the console reloads its lists). */
  version = 0;
  lastPullAt: string | null = null;
  lastPushAt: string | null = null;
  lastSyncAt: string | null = null;
  /** What is being moved now, in plain words ("Uploading HUD Vector"). */
  busy: string | null = null;
  private org: z.infer<typeof OrgStatus> | null = null;
  private error: { message: string; offline: boolean } | null = null;
  private applyProblem: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private stopped = true;
  private lastScanAt = 0;
  private lastFullScanAt = 0;
  private lastChanges = -1;
  private dirtyAt: number | null = null;
  private nextPullAt = 0;
  private nextTryAt = 0;
  private failures = 0;
  private pulledOnce = false;
  private statusAt = 0;
  private storageChanged = false;
  /** Blobs uploaded in this run (when), and blobs the website said it does not have. */
  private readonly uploaded = new Map<string, number>();
  private readonly missing = new Set<string>();
  /** HUD packages zipped for upload (dropped once shared). */
  private readonly zips = new Map<string, { fingerprint: string; sha: string; bytes: Buffer }>();

  constructor(
    private readonly d: {
      cloud: CloudLink;
      settings: SettingsRepo;
      db: Database;
      local: SyncLocal;
      logger: Logger;
    },
  ) {}

  get enabled(): boolean {
    return this.d.settings.get<boolean>(ENABLED_KEY, true);
  }

  /** Runs while this computer is linked to an organisation and sharing is on. */
  get active(): boolean {
    return this.enabled && this.d.cloud.deviceLinked;
  }

  private get cursor(): number {
    return this.d.settings.get<number>(CURSOR_KEY, 0);
  }

  private set cursor(v: number) {
    this.d.settings.set(CURSOR_KEY, v);
  }

  // ---------------------------------------------------------------------------- lifecycle

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => this.tick(), this.timing.tickMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.abort?.abort();
    if (this.running) await Promise.race([this.running, new Promise((r) => setTimeout(r, 3000))]);
  }

  /** A change through the program's API: compare soon (debounced). */
  noteLocalWrite(): void {
    this.dirtyAt = Date.now();
  }

  setEnabled(enabled: boolean): void {
    this.d.settings.set(ENABLED_KEY, enabled);
    this.error = null;
    this.failures = 0;
    this.nextTryAt = 0;
    if (!enabled) this.abort?.abort();
  }

  /** Shares now (fetches, then sends), and resolves when done. */
  async syncNow(): Promise<void> {
    if (!this.active) throw Object.assign(new Error(this.enabled ? "sign in to a Matchframe account to share data" : "sharing is off"), { status: 409 });
    this.failures = 0;
    this.nextTryAt = 0;
    // A record that could not be used was reported; asking again starts with a clean slate.
    this.applyProblem = null;
    if (this.running) await this.running;
    await this.run(true);
  }

  private tick(): void {
    if (this.stopped || this.running || !this.active) return;
    const now = Date.now();
    if (now < this.nextTryAt) return;
    const scanDue = now - this.lastScanAt >= this.timing.scanMs || (this.dirtyAt !== null && now - this.dirtyAt >= this.timing.debounceMs);
    if (!scanDue && now < this.nextPullAt) return;
    void this.run(false);
  }

  private run(force: boolean): Promise<void> {
    if (this.running) return this.running;
    this.running = this.cycle(force).finally(() => {
      this.running = null;
      this.busy = null;
    });
    return this.running;
  }

  private async cycle(force: boolean): Promise<void> {
    const ac = new AbortController();
    this.abort = ac;
    try {
      this.checkOrg();
      await this.scan(force);
      // The organisation's changes first (on a computer's first sync: before anything is sent).
      if (force || !this.pulledOnce || Date.now() >= this.nextPullAt) {
        const applied = await this.pull(ac.signal);
        this.pulledOnce = true;
        this.nextPullAt = Date.now() + this.timing.pullMs;
        if (applied > 0) await this.scan(true);
      }
      await this.push(ac.signal);
      if (force || this.storageChanged || Date.now() - this.statusAt >= this.timing.statusMs) await this.fetchStatus(ac.signal);
      this.failures = 0;
      this.nextTryAt = 0;
      this.error = null;
      this.lastSyncAt = new Date().toISOString();
    } catch (e) {
      if (this.stopped || ac.signal.aborted) return;
      this.onFailure(e);
    } finally {
      if (this.abort === ac) this.abort = null;
    }
  }

  private onFailure(e: unknown): void {
    const backoff = () => Math.min(this.timing.backoffMaxMs, this.timing.backoffMs * 2 ** Math.min(10, this.failures++));
    if (e instanceof Unreachable) {
      this.nextTryAt = Date.now() + backoff();
      this.error = { message: "Cannot reach the Matchframe website. Changes made here are kept and shared when it is back.", offline: true };
      return;
    }
    if (e instanceof Refused && e.status === 401) {
      this.error = { message: "This computer was signed out on the website. Sign in again to share data.", offline: false };
      return;
    }
    if (e instanceof Refused && e.status === 404) {
      this.nextTryAt = Date.now() + UNSUPPORTED_RETRY_MS;
      this.error = { message: "The Matchframe website does not offer shared data yet.", offline: false };
      return;
    }
    this.nextTryAt = Date.now() + backoff();
    this.error = { message: e instanceof Refused ? e.message.charAt(0).toUpperCase() + e.message.slice(1) : `Sharing stopped: ${errText(e)}`, offline: false };
    if (!(e instanceof Refused)) this.d.logger.warn("account sync failed", { error: errText(e) });
  }

  /** Another organisation than last time: everything here is new to it (merged into its records where they match). */
  private checkOrg(): void {
    const orgId = this.d.cloud.link?.orgId ?? null;
    if (!orgId || this.d.settings.get<string | null>(ORG_KEY, null) === orgId) return;
    this.d.db.transaction(() => {
      this.d.local.reset();
      this.d.settings.set(CURSOR_KEY, 0);
      this.d.settings.set(ORG_KEY, orgId);
    });
    this.pulledOnce = false;
    this.uploaded.clear();
    this.missing.clear();
    this.zips.clear();
    this.org = null;
    this.lastFullScanAt = 0;
  }

  // ---------------------------------------------------------------------------- HTTP

  private async request(method: string, path: string, opts: { json?: unknown; bytes?: Uint8Array; raw?: boolean; timeoutMs?: number; signal: AbortSignal }): Promise<{ status: number; data: unknown; bytes: Buffer | null }> {
    let r: { status: number; data: unknown; bytes: Buffer | null };
    try {
      r = await this.d.cloud.deviceRequest(method, path, opts);
    } catch (e) {
      if ((e as { status?: number }).status === 409) throw new Refused("this computer is not linked", 409);
      throw new Unreachable(errText(e));
    }
    if (r.status >= 500 || r.status === 429 || r.status === 408) throw new Unreachable(`HTTP ${r.status}`);
    if (r.status === 401) throw new Refused("signed out", 401);
    return r;
  }

  private message(r: { status: number; data: unknown }): string {
    const m = (r.data as { message?: unknown } | null)?.message;
    return typeof m === "string" && m ? m : `HTTP ${r.status}`;
  }

  // ---------------------------------------------------------------------------- local changes

  /** Notes what changed here since the records were last compared (skipped while the database has not changed, except once a minute). */
  private async scan(force: boolean): Promise<void> {
    const changes = () => this.d.db.get<{ n: number }>("SELECT total_changes() AS n")?.n ?? -1;
    const now = Date.now();
    this.dirtyAt = null;
    this.lastScanAt = now;
    if (!force && changes() === this.lastChanges && now - this.lastFullScanAt < FULL_SCAN_MS) return;
    const items = await this.d.local.collect();
    if (this.stopped) return;
    this.d.local.scan(items);
    this.lastChanges = changes();
    this.lastFullScanAt = Date.now();
  }

  // ---------------------------------------------------------------------------- the organisation's changes

  /** Fetches and applies the organisation's changes after the cursor (oldest first, page by page). Returns how many were applied. */
  private async pull(signal: AbortSignal): Promise<number> {
    let applied = 0;
    let problems = false;
    try {
      for (let page = 0; page < 10_000; page++) {
        const since = this.cursor;
        const r = await this.request("GET", `/v1/sync/changes?since=${since}&limit=${BATCH}`, { signal });
        if (r.status === 404) throw new Refused("no account sync", 404);
        if (r.status !== 200) throw new Refused(`the website did not send the shared changes (${this.message(r)})`, r.status);
        const parsed = SyncChanges.safeParse(r.data);
        if (!parsed.success) throw new Refused("the website sent shared changes this program cannot read; update the program", 502);
        for (const item of parsed.data.items) {
          if (this.stopped) return applied;
          const out = await this.applyRemote(item, false, signal);
          if (out === "applied") applied++;
          if (out === "problem") problems = true;
          if (item.seq > this.cursor) this.cursor = item.seq;
        }
        if (parsed.data.cursor > this.cursor) this.cursor = parsed.data.cursor;
        if (!parsed.data.more || parsed.data.items.length === 0) break;
      }
    } finally {
      if (applied > 0) this.version++;
    }
    if (!problems && applied > 0) this.applyProblem = null;
    this.lastPullAt = new Date().toISOString();
    return applied;
  }

  /** Applies one of the organisation's items (`force`: the website said it is newer than this computer's change). */
  private async applyRemote(item: SyncItem, force: boolean, signal: AbortSignal): Promise<"applied" | "kept" | "skipped" | "problem"> {
    const decision = force ? ({ action: "apply" } as const) : this.d.local.decide(item);
    if (decision.action === "skip") return "skipped";
    if (decision.action === "keep") {
      this.d.local.keep(item, decision.pending, decision.pendingAt);
      return "kept";
    }
    try {
      const blobs = new Map<string, Uint8Array>();
      for (const sha of this.d.local.blobsNeeded(item)) blobs.set(sha, await this.download(sha, item, signal));
      this.d.local.apply(item, blobs);
      return "applied";
    } catch (e) {
      // Network trouble: tried again from this item. Anything else: this computer keeps what it has.
      if (e instanceof Unreachable || (e instanceof Refused && e.status === 401)) throw e;
      this.d.local.skip(item);
      const name = typeof item.data?.name === "string" ? item.data.name : typeof item.data?.displayName === "string" ? item.data.displayName : item.id;
      this.applyProblem = `Could not use the shared ${KIND_NAMES[item.kind]} ${name}: ${errText(e)}`;
      this.d.logger.warn("account sync: a shared record was not applied", { kind: item.kind, id: item.id, error: errText(e) });
      return "problem";
    }
  }

  private async download(sha: string, item: SyncItem, signal: AbortSignal): Promise<Buffer> {
    this.busy = item.kind === "hud" ? `Downloading HUD ${String(item.data?.name ?? item.id)}` : "Downloading logos and photos";
    try {
      const r = await this.request("GET", `/v1/sync/blobs/${sha}`, { raw: true, timeoutMs: 10 * 60_000, signal });
      if (r.status !== 200 || !r.bytes) throw new Refused(`the website does not have its file (${this.message(r)})`, r.status);
      if (r.bytes.length > SYNC_BLOB_MAX_BYTES) throw new Refused("its file is too large", 413);
      if (sha256(r.bytes) !== sha) throw new Unreachable("a file arrived damaged");
      return r.bytes;
    } finally {
      this.busy = null;
    }
  }

  // ---------------------------------------------------------------------------- this computer's changes

  /** Sends local changes in batches: their files first (only ones the website does not have yet), then the records. */
  private async push(signal: AbortSignal): Promise<void> {
    const rows = this.d.local.pendingRows((reason) => (reason.startsWith("missing_blob") ? MISSING_BLOB_RETRY_MS : this.timing.rejectRetryMs));
    if (rows.length === 0) return;
    const known = this.d.local.knownBlobs();
    for (const [b, at] of this.uploaded) if (Date.now() - at < UPLOAD_TRUST_MS) known.add(b);
    for (const b of this.missing) known.delete(b);
    let applied = 0;
    for (let i = 0; i < rows.length && !this.stopped; i += BATCH) {
      const send: Prepared[] = [];
      for (const row of rows.slice(i, i + BATCH)) {
        const p = await this.prepare(row);
        if (!p) continue;
        if (p.problem) {
          this.d.local.recordRejected(p.change.kind, p.change.id, p.hash, p.problem);
          continue;
        }
        let refused: string | null = null;
        for (const blob of p.uploads) {
          if (known.has(blob.sha)) continue;
          refused = await this.upload(blob, signal);
          if (refused) break;
          known.add(blob.sha);
        }
        if (refused) this.d.local.recordRejected(p.change.kind, p.change.id, p.hash, refused);
        else send.push(p);
      }
      if (send.length === 0) continue;
      const r = await this.request("POST", "/v1/sync/push", { json: { changes: send.map((p) => p.change) }, timeoutMs: 60_000, signal });
      if (r.status === 404) throw new Refused("no account sync", 404);
      if (r.status !== 200) throw new Refused(`the website did not take the changes (${this.message(r)})`, r.status);
      const parsed = SyncPushResult.safeParse(r.data);
      if (!parsed.success) throw new Refused("the website answered the changes in a way this program cannot read; update the program", 502);
      const byKey = new Map(send.map((p) => [keyOf(p.change.kind, p.change.id), p]));
      for (const res of parsed.data.results) {
        const p = byKey.get(keyOf(res.kind, res.id));
        if (!p) continue;
        if (res.status === "applied" && res.item) {
          this.d.local.recordApplied(res.kind, res.id, p.hash, res.item, p.blobKey);
          if (res.kind === "hud") this.zips.delete(res.id);
        } else if (res.status === "stale" && res.item) {
          // Another computer changed it later: theirs is kept, here too.
          if ((await this.applyRemote(res.item, true, signal)) === "applied") applied++;
        } else {
          const reason = res.reason ?? "refused";
          this.d.local.recordRejected(res.kind, res.id, p.hash, reason);
          const missing = /^missing_blob ([0-9a-f]{64})/.exec(reason)?.[1];
          if (missing) {
            this.missing.add(missing);
            this.uploaded.delete(missing);
          }
        }
      }
    }
    if (applied > 0) this.version++;
    this.lastPushAt = new Date().toISOString();
  }

  /** The change to send for a row, with the files it needs. Null: nothing to send now (it changed again; the next scan sees it). */
  private async prepare(row: SyncStateRow): Promise<Prepared | null> {
    const now = new Date().toISOString();
    if (row.pending === GONE) return { change: { kind: row.kind, id: row.id, data: null, blobs: [], baseSeq: row.seq, editedAt: row.pending_at ?? now }, hash: GONE, blobKey: null, uploads: [], problem: null };
    const it = this.d.local.current(row.kind, row.id);
    if (!it) return null;
    const change: SyncChange = { kind: row.kind, id: row.id, data: it.data, blobs: [], baseSeq: row.seq, editedAt: (row.pending === it.hash ? row.pending_at : it.editedAt) ?? now };
    const out: Prepared = { change, hash: it.hash, blobKey: null, uploads: [], problem: null };
    const size = Buffer.byteLength(JSON.stringify(it.data));
    if (size > SYNC_ITEM_MAX_BYTES) return { ...out, problem: `too_large ${size}` };
    if (row.kind === "asset") {
      const sha = String(it.data.sha256);
      change.blobs = [sha];
      out.uploads.push({ sha, label: "Uploading logos and photos", load: () => readFile(this.d.local.assetFile(row.id)) });
    } else if (row.kind === "hud") {
      const pkg = this.d.local.hudPackage(row.id);
      if (!pkg) return null;
      // A settings change keeps the package: the same file, not uploaded again.
      let sha = row.blob_key === pkg.fingerprint ? parseBlobs(row.blobs)[0] : undefined;
      const cached = this.zips.get(row.id);
      if (!sha && cached?.fingerprint === pkg.fingerprint) sha = cached.sha;
      if (!sha) {
        this.busy = `Preparing HUD ${pkg.name}`;
        let bytes: Buffer;
        try {
          bytes = await zipPackageDir(pkg.installDir);
        } catch (e) {
          return { ...out, problem: `its files could not be read (${errText(e)})` };
        } finally {
          this.busy = null;
        }
        if (bytes.length > SYNC_BLOB_MAX_BYTES) return { ...out, problem: `too_large ${bytes.length}` };
        sha = sha256(bytes);
        this.zips.set(row.id, { fingerprint: pkg.fingerprint, sha, bytes });
      }
      const blobSha = sha;
      change.blobs = [blobSha];
      out.blobKey = pkg.fingerprint;
      out.uploads.push({
        sha: blobSha,
        label: `Uploading HUD ${pkg.name}`,
        load: async () => {
          const z = this.zips.get(row.id);
          if (z?.sha === blobSha) return z.bytes;
          const bytes = await zipPackageDir(pkg.installDir);
          if (sha256(bytes) !== blobSha) throw new Error("the HUD changed while it was being shared");
          return bytes;
        },
      });
    }
    return out;
  }

  /** Uploads one blob; returns null, or why this change cannot be sent now. */
  private async upload(blob: Upload, signal: AbortSignal): Promise<string | null> {
    this.busy = blob.label;
    try {
      let bytes: Uint8Array;
      try {
        bytes = await blob.load();
      } catch (e) {
        return `its file could not be read (${errText(e)})`;
      }
      const r = await this.request("PUT", `/v1/sync/blobs/${blob.sha}`, { bytes, timeoutMs: 10 * 60_000, signal });
      if (r.status === 404) throw new Refused("no account sync", 404);
      if (r.status === 413) {
        const body = r.data as { error?: string; detail?: { usedBytes?: unknown; quotaBytes?: unknown } } | null;
        const d = body?.detail;
        if (body?.error !== "quota_exceeded") return `too_large ${bytes.length}`;
        this.storageChanged = true;
        return typeof d?.usedBytes === "number" && typeof d.quotaBytes === "number" ? `quota_exceeded ${d.usedBytes} ${d.quotaBytes}` : "quota_exceeded";
      }
      if (r.status === 400) return "file_mismatch";
      if (r.status < 200 || r.status > 299) throw new Refused(`the website did not take a file (${this.message(r)})`, r.status);
      this.uploaded.set(blob.sha, Date.now());
      this.missing.delete(blob.sha);
      this.storageChanged = true;
      return null;
    } finally {
      this.busy = null;
    }
  }

  private async fetchStatus(signal: AbortSignal): Promise<void> {
    const r = await this.request("GET", "/v1/sync/status", { signal });
    if (r.status !== 200) return;
    const p = OrgStatus.safeParse(r.data);
    if (p.success) this.org = p.data;
    this.statusAt = Date.now();
    this.storageChanged = false;
  }

  // ---------------------------------------------------------------------------- status

  get lastError(): string | null {
    if (this.error) return this.error.message;
    if (this.applyProblem) return this.applyProblem;
    const rejected = this.d.local.rejected();
    const full = rejected.find((r) => r.reason.startsWith("quota_exceeded"));
    if (full) return `${plainReason(full.reason)}. Remove HUDs or pictures you no longer need; their space is freed about an hour later.`;
    if (rejected.length > 0) return `The website did not take ${rejected.length === 1 ? "a change" : `${rejected.length} changes`} from here: ${plainReason(rejected[0]!.reason)}.`;
    return null;
  }

  status(): SyncView {
    const enabled = this.enabled;
    const linked = this.d.cloud.deviceLinked;
    const pendingByKind = this.d.local.pendingCounts();
    const state: SyncView["state"] = !enabled ? "off" : !linked ? "signed_out" : this.busy ? "syncing" : this.error ? (this.error.offline ? "offline" : "error") : !this.pulledOnce ? "starting" : "ok";
    return {
      enabled,
      linked,
      orgName: linked ? (this.d.cloud.link?.orgName ?? null) : null,
      state,
      lastPullAt: this.lastPullAt,
      lastPushAt: this.lastPushAt,
      lastSyncAt: this.lastSyncAt,
      pending: Object.values(pendingByKind).reduce((a, b) => a + b, 0),
      pendingByKind,
      counts: this.d.local.counts(),
      busy: this.busy,
      storage: this.org ? { usedBytes: this.org.blobBytes, quotaBytes: this.org.quotaBytes } : null,
      orgItems: this.org?.items ?? null,
      rejected: this.d.local
        .rejected()
        .slice(0, 5)
        .map((r) => ({ kind: r.kind, id: r.id, reason: plainReason(r.reason) })),
      merged: this.d.local.merged,
      lastError: enabled && linked ? this.lastError : null,
    };
  }
}
