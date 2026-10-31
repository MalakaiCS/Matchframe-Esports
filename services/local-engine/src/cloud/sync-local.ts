import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { SyncItem, SyncKind } from "@matchframe/cloud-contracts";
import { EventRecord, MapInstance, Match, Player, RosterMembership, Team, VetoDecision } from "@matchframe/contracts";
import type { Database } from "../db/database.ts";
import type { DocumentRepo, SettingsRepo, SteamIndexRepo } from "../db/store.ts";
import type { HudLibraryService } from "../hud/library.ts";
import { packageFingerprint, readArchive, validateManifest } from "../hud/packages.ts";
import { ASSET_EXT, normalizeName } from "../routes/domain.ts";

/**
 * Account sync on this computer's side (the network side is sync.ts): which local records are
 * shared, what changed since they were last shared, and applying the organisation's changes,
 * including merging a computer's own players and teams into the organisation's on its first sync.
 */

/** sync_state.hash of a record never shared yet. */
export const NEVER = "";
/** sync_state.hash / pending of a deleted record. */
export const GONE = "-";

/** Push order: files first, then the records that use them. */
export const KIND_ORDER: readonly SyncKind[] = ["asset", "team", "player", "event", "roster", "match", "map", "veto", "hud"];

type DocKind = "team" | "player" | "event" | "match";

/** An asset id (POST /api/v1/assets): the first 24 hex digits of its SHA-256 and its extension. */
const ASSET_ID_RE = /^([0-9a-f]{24})(\.[a-z0-9]+)$/;
/** Image asset ids inside HUD settings. */
const IMAGE_ID_RE = /^[0-9a-f]{24}\.(png|jpe?g|webp|svg|gif)$/i;
const LOCAL_HUDS_KEY = "cloud.sync.localHuds";
const VETO_STEPS = "veto.steps.";

export const keyOf = (kind: string, id: string) => `${kind}:${id}`;

/** JSON with object keys sorted, so equal records hash the same whatever their key order. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) =>
    val && typeof val === "object" && !Array.isArray(val) ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : val,
  );
}

export function contentHash(data: Record<string, unknown> | null): string {
  return data === null ? GONE : createHash("sha256").update(canonicalJson(data)).digest("hex").slice(0, 40);
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export function parseBlobs(json: string | null | undefined): string[] {
  try {
    const v = JSON.parse(json ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);

/**
 * The organisation's record with what only this computer knew filled in: fields the organisation
 * left empty take the local value; a player's aliases are joined (with the local name when it differs).
 */
export function fillGaps(org: Record<string, unknown>, local: Record<string, unknown>): Record<string, unknown> {
  const out = { ...org };
  for (const [k, v] of Object.entries(local)) {
    if (k === "id" || k === "archived") continue;
    if (k === "aliases" && Array.isArray(out[k]) && Array.isArray(v)) out[k] = [...new Set([...(out[k] as unknown[]), ...v])];
    else if (isEmpty(out[k]) && !isEmpty(v)) out[k] = v;
  }
  if (typeof local.displayName === "string" && typeof out.displayName === "string" && local.displayName !== out.displayName) {
    const aliases = Array.isArray(out.aliases) ? (out.aliases as unknown[]) : [];
    if (!aliases.includes(local.displayName)) out.aliases = [...aliases, local.displayName];
  }
  return out;
}

export interface LocalItem {
  kind: SyncKind;
  id: string;
  data: Record<string, unknown>;
  hash: string;
  /** When it was last edited, where this computer knows (documents); null: when the change was noticed. */
  editedAt: string | null;
}

export interface SyncStateRow {
  kind: SyncKind;
  id: string;
  hash: string;
  seq: number | null;
  edited_at: string | null;
  blobs: string;
  blob_key: string | null;
  pending: string | null;
  pending_at: string | null;
  rejected: string | null;
  rejected_hash: string | null;
  rejected_at: string | null;
}

/** What to do with one of the organisation's items. */
export type Decision = { action: "skip" } | { action: "apply" } | { action: "keep"; pending: string; pendingAt: string | null };

export interface SyncLocalDeps {
  db: Database;
  settings: SettingsRepo;
  teams: DocumentRepo<typeof Team>;
  players: DocumentRepo<typeof Player>;
  events: DocumentRepo<typeof EventRecord>;
  matches: DocumentRepo<typeof Match>;
  steamIndex: SteamIndexRepo;
  /** The HUD Library (null: HUDs are not shared, as in tests of the records alone). */
  huds: HudLibraryService | null;
  assetsDir: string;
  now?: () => Date;
}

const HudData = z.object({
  settings: z.record(z.string(), z.unknown()).default({}),
  presetId: z.string().nullable().default(null),
  package: z.string().min(1),
});
const AssetData = z.object({ ext: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/) });

interface DocRow {
  kind: DocKind;
  id: string;
  data: string;
  archived: number;
  updated_at: string;
}

export class SyncLocal {
  /** Asset id → SHA-256 of its file (an asset never changes: its id is its content hash). */
  private readonly assetSha = new Map<string, string>();
  /** Players and teams merged into the organisation's since the engine started. */
  merged = 0;

  constructor(private readonly d: SyncLocalDeps) {}

  private get db(): Database {
    return this.d.db;
  }

  private nowIso(): string {
    return (this.d.now?.() ?? new Date()).toISOString();
  }

  private repo(kind: DocKind): DocumentRepo<z.ZodType<{ id: string }>> {
    return { team: this.d.teams, player: this.d.players, event: this.d.events, match: this.d.matches }[kind] as unknown as DocumentRepo<z.ZodType<{ id: string }>>;
  }

  // ---------------------------------------------------------------------------- state

  state(kind: string, id: string): SyncStateRow | undefined {
    return this.db.get<SyncStateRow>("SELECT * FROM sync_state WHERE kind = ? AND id = ?", kind, id);
  }

  allState(): SyncStateRow[] {
    return this.db.all<SyncStateRow>("SELECT * FROM sync_state");
  }

  /** Forgets what was shared (another organisation: everything here is new to it). */
  reset(): void {
    this.db.run("DELETE FROM sync_state");
  }

  /** Shared records on this computer per kind. */
  counts(): Record<string, number> {
    const rows = this.db.all<{ kind: string; n: number }>("SELECT kind, COUNT(*) AS n FROM sync_state WHERE hash NOT IN (?, ?) GROUP BY kind", NEVER, GONE);
    return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
  }

  /** Local changes not accepted yet, per kind. */
  pendingCounts(): Record<string, number> {
    const rows = this.db.all<{ kind: string; n: number }>("SELECT kind, COUNT(*) AS n FROM sync_state WHERE pending IS NOT NULL GROUP BY kind");
    return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
  }

  rejected(): { kind: string; id: string; reason: string; at: string | null }[] {
    return this.db
      .all<{ kind: string; id: string; rejected: string; rejected_at: string | null }>("SELECT kind, id, rejected, rejected_at FROM sync_state WHERE rejected IS NOT NULL AND pending IS NOT NULL AND pending = rejected_hash ORDER BY rejected_at DESC")
      .map((r) => ({ kind: r.kind, id: r.id, reason: r.rejected, at: r.rejected_at }));
  }

  /** Blobs the organisation has (named by records it accepted). */
  knownBlobs(): Set<string> {
    const out = new Set<string>();
    for (const r of this.db.all<{ blobs: string }>("SELECT blobs FROM sync_state WHERE seq IS NOT NULL AND hash != ? AND blobs != '[]'", GONE)) for (const b of parseBlobs(r.blobs)) out.add(b);
    return out;
  }

  /** HUDs kept on this computer only (deleted elsewhere while a published output here used them). */
  localHuds(): Set<string> {
    return new Set(this.d.settings.get<string[]>(LOCAL_HUDS_KEY, []));
  }

  // ---------------------------------------------------------------------------- local records

  private item(kind: SyncKind, id: string, data: Record<string, unknown>, editedAt: string | null): LocalItem {
    return { kind, id, data, hash: contentHash(data), editedAt };
  }

  private docItem(r: DocRow, vetoSteps: unknown): LocalItem {
    const data: Record<string, unknown> = { ...(JSON.parse(r.data) as Record<string, unknown>), id: r.id, archived: r.archived === 1 };
    if (r.kind === "match") data.vetoSteps = vetoSteps ?? null;
    return this.item(r.kind, r.id, data, r.updated_at);
  }

  private rosterItem(r: { id: string; team_id: string; player_id: string; role: string; valid_from: string; valid_to: string | null }): LocalItem {
    return this.item("roster", r.id, { teamId: r.team_id, playerId: r.player_id, role: r.role, validFrom: r.valid_from, validTo: r.valid_to }, null);
  }

  private vetoItem(r: { id: string; data: string; superseded_by: string | null; created_at: string }): LocalItem {
    return this.item("veto", r.id, { ...(JSON.parse(r.data) as Record<string, unknown>), supersededBy: r.superseded_by, createdAt: r.created_at }, null);
  }

  private hudItem(h: ReturnType<HudLibraryService["importedHuds"]>[number]): LocalItem {
    const m = h.manifest;
    return this.item("hud", h.id, { name: m.name, version: m.version, author: m.author, kind: "imported", runtime: m.runtime ?? "matchframe", settings: h.settings, presetId: h.presetId, package: packageFingerprint(h.checksums) }, null);
  }

  private importedHuds(): ReturnType<HudLibraryService["importedHuds"]> {
    if (!this.d.huds) return [];
    const kept = this.localHuds();
    return this.d.huds.importedHuds().filter((h) => !kept.has(h.id));
  }

  /** Every shared record except assets, as it is on this computer now. */
  private records(): Map<string, LocalItem> {
    const out = new Map<string, LocalItem>();
    const add = (it: LocalItem) => out.set(keyOf(it.kind, it.id), it);
    const steps = new Map(this.db.all<{ key: string; value: string }>("SELECT key, value FROM settings WHERE key LIKE 'veto.steps.%'").map((r) => [r.key.slice(VETO_STEPS.length), JSON.parse(r.value) as unknown]));
    for (const r of this.db.all<DocRow>("SELECT kind, id, data, archived, updated_at FROM documents WHERE kind IN ('team', 'player', 'event', 'match')")) add(this.docItem(r, steps.get(r.id)));
    for (const r of this.db.all<Parameters<SyncLocal["rosterItem"]>[0]>("SELECT * FROM roster_memberships")) add(this.rosterItem(r));
    for (const r of this.db.all<{ id: string; data: string }>("SELECT id, data FROM map_instances")) add(this.item("map", r.id, JSON.parse(r.data) as Record<string, unknown>, null));
    for (const r of this.db.all<Parameters<SyncLocal["vetoItem"]>[0]>("SELECT id, data, superseded_by, created_at FROM veto_decisions")) add(this.vetoItem(r));
    for (const h of this.importedHuds()) add(this.hudItem(h));
    return out;
  }

  /** Assets the shared records use: logos, photos and images in HUD settings. */
  private assetRefs(records: Map<string, LocalItem>): Set<string> {
    const out = new Set<string>();
    const images = (v: unknown): void => {
      if (typeof v === "string" && IMAGE_ID_RE.test(v) && ASSET_ID_RE.test(v)) out.add(v);
      else if (Array.isArray(v)) v.forEach(images);
      else if (v && typeof v === "object") Object.values(v).forEach(images);
    };
    for (const it of records.values()) {
      const ref = it.kind === "player" ? it.data.avatarAssetId : it.kind === "team" || it.kind === "event" ? it.data.logoAssetId : null;
      if (typeof ref === "string" && ASSET_ID_RE.test(ref)) out.add(ref);
      if (it.kind === "hud") images(it.data.settings);
    }
    return out;
  }

  private assetPath(id: string): string {
    return join(this.d.assetsDir, id);
  }

  /** Where an asset's file is kept here. */
  assetFile(id: string): string {
    if (!ASSET_ID_RE.test(id)) throw new Error(`not an asset id: ${id}`);
    return this.assetPath(id);
  }

  /** The asset's file hash: remembered, or from what was shared, or read from the file (synchronously; for one file). */
  private assetHash(id: string, readFile: boolean): string | null {
    const known = this.assetSha.get(id);
    if (known) return known;
    const shared = parseBlobs(this.state("asset", id)?.blobs)[0];
    if (shared?.startsWith(id.slice(0, 24))) {
      this.assetSha.set(id, shared);
      return shared;
    }
    if (!readFile) return null;
    try {
      const sha = sha256(readFileSync(this.assetPath(id)));
      if (!sha.startsWith(id.slice(0, 24))) return null;
      this.assetSha.set(id, sha);
      return sha;
    } catch {
      return null;
    }
  }

  private async hashAssetFile(id: string): Promise<void> {
    const hash = createHash("sha256");
    try {
      for await (const chunk of createReadStream(this.assetPath(id), { highWaterMark: 1024 * 1024 })) hash.update(chunk as Buffer);
    } catch {
      return;
    }
    const sha = hash.digest("hex");
    if (sha.startsWith(id.slice(0, 24))) this.assetSha.set(id, sha);
  }

  private assetItem(id: string, readFile: boolean): LocalItem | null {
    const m = ASSET_ID_RE.exec(id);
    if (!m || !existsSync(this.assetPath(id))) return null;
    const sha = this.assetHash(id, readFile);
    return sha ? this.item("asset", id, { ext: m[2]!, sha256: sha }, null) : null;
  }

  /** Every shared record on this computer now. Asset files not hashed yet are read in chunks first. */
  async collect(): Promise<Map<string, LocalItem>> {
    const out = this.records();
    const refs = this.assetRefs(out);
    for (const id of refs) if (!this.assetHash(id, false) && existsSync(this.assetPath(id))) await this.hashAssetFile(id);
    for (const id of refs) {
      const it = this.assetItem(id, false);
      if (it) out.set(keyOf("asset", id), it);
    }
    return out;
  }

  /** One shared record as it is on this computer now (null: not here). An asset counts as here when its file is. */
  current(kind: SyncKind, id: string): LocalItem | null {
    switch (kind) {
      case "team":
      case "player":
      case "event":
      case "match": {
        const r = this.db.get<DocRow>("SELECT kind, id, data, archived, updated_at FROM documents WHERE kind = ? AND id = ?", kind, id);
        return r ? this.docItem(r, kind === "match" ? this.d.settings.get<unknown>(`${VETO_STEPS}${id}`, null) : undefined) : null;
      }
      case "roster": {
        const r = this.db.get<Parameters<SyncLocal["rosterItem"]>[0]>("SELECT * FROM roster_memberships WHERE id = ?", id);
        return r ? this.rosterItem(r) : null;
      }
      case "map": {
        const r = this.db.get<{ data: string }>("SELECT data FROM map_instances WHERE id = ?", id);
        return r ? this.item("map", id, JSON.parse(r.data) as Record<string, unknown>, null) : null;
      }
      case "veto": {
        const r = this.db.get<Parameters<SyncLocal["vetoItem"]>[0]>("SELECT id, data, superseded_by, created_at FROM veto_decisions WHERE id = ?", id);
        return r ? this.vetoItem(r) : null;
      }
      case "asset":
        return this.assetItem(id, true);
      case "hud": {
        const h = this.importedHuds().find((x) => x.id === id);
        return h ? this.hudItem(h) : null;
      }
    }
  }

  /** An imported HUD's folder and name (for its package upload). */
  hudPackage(id: string): { installDir: string; name: string; fingerprint: string } | null {
    const h = this.importedHuds().find((x) => x.id === id);
    return h ? { installDir: h.installDir, name: h.manifest.name, fingerprint: packageFingerprint(h.checksums) } : null;
  }

  // ---------------------------------------------------------------------------- local changes

  /**
   * Compares the records here with what was last shared and notes each change and when it was
   * made: new and changed records, and shared records no longer here (deletions).
   */
  scan(items: Map<string, LocalItem>): void {
    const now = this.nowIso();
    const rows = new Map(this.allState().map((r) => [keyOf(r.kind, r.id), r]));
    this.db.transaction(() => {
      for (const [key, it] of items) {
        const st = rows.get(key);
        rows.delete(key);
        if (!st) {
          this.db.run("INSERT INTO sync_state (kind, id, hash, pending, pending_at) VALUES (?, ?, ?, ?, ?)", it.kind, it.id, NEVER, it.hash, it.editedAt);
        } else if (it.hash === st.hash) {
          if (st.pending !== null) this.db.run("UPDATE sync_state SET pending = NULL, pending_at = NULL WHERE kind = ? AND id = ?", st.kind, st.id);
        } else if (st.pending !== it.hash) {
          // A record never shared keeps its own edit time (none known: older than the organisation's).
          this.db.run("UPDATE sync_state SET pending = ?, pending_at = ? WHERE kind = ? AND id = ?", it.hash, it.editedAt ?? (st.hash === NEVER ? null : now), st.kind, st.id);
        }
      }
      for (const st of rows.values()) {
        if (st.hash === NEVER) this.db.run("DELETE FROM sync_state WHERE kind = ? AND id = ?", st.kind, st.id);
        else if (st.hash === GONE) {
          if (st.pending !== null) this.db.run("UPDATE sync_state SET pending = NULL, pending_at = NULL WHERE kind = ? AND id = ?", st.kind, st.id);
        } else if (st.pending !== GONE) this.db.run("UPDATE sync_state SET pending = ?, pending_at = ? WHERE kind = ? AND id = ?", GONE, now, st.kind, st.id);
      }
    });
  }

  /** Local changes to send: deletions first, then files before the records that use them. Refused ones wait until they change or `retryMs(reason)` passed. */
  pendingRows(retryMs: (reason: string) => number): SyncStateRow[] {
    const now = Date.now();
    return this.db
      .all<SyncStateRow>("SELECT * FROM sync_state WHERE pending IS NOT NULL")
      .filter((r) => !(r.rejected && r.rejected_hash === r.pending && r.rejected_at && now - Date.parse(r.rejected_at) < retryMs(r.rejected)))
      .sort((a, b) => (a.pending === GONE ? 0 : 1) - (b.pending === GONE ? 0 : 1) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  }

  /** The organisation took a change from here: it is the shared version now. */
  recordApplied(kind: SyncKind, id: string, hash: string, item: SyncItem, blobKey: string | null): void {
    this.db.run(
      `UPDATE sync_state SET hash = ?, seq = ?, edited_at = ?, blobs = ?, blob_key = ?, rejected = NULL, rejected_hash = NULL, rejected_at = NULL,
        pending = CASE WHEN pending = ? THEN NULL ELSE pending END, pending_at = CASE WHEN pending = ? THEN NULL ELSE pending_at END
       WHERE kind = ? AND id = ?`,
      hash,
      item.seq,
      item.editedAt,
      JSON.stringify(item.blobs),
      blobKey,
      hash,
      hash,
      kind,
      id,
    );
  }

  /** The organisation refused this content (or it cannot be sent): not sent again until it changes, or after a while. */
  recordRejected(kind: SyncKind, id: string, hash: string, reason: string): void {
    this.db.run("UPDATE sync_state SET rejected = ?, rejected_hash = ?, rejected_at = ? WHERE kind = ? AND id = ?", reason.slice(0, 300), hash, this.nowIso(), kind, id);
  }

  // ---------------------------------------------------------------------------- the organisation's changes

  /**
   * skip: this computer has it already. keep: this computer changed it later (its change is sent
   * next, over this one). apply: anything else (last edit wins; a record never shared from here
   * with no known edit time counts as older than the organisation's).
   */
  decide(item: SyncItem): Decision {
    const st = this.state(item.kind, item.id);
    if (st?.seq != null && st.seq >= item.seq) return { action: "skip" };
    if (item.kind === "asset") return { action: "apply" };
    let pending = st?.pending ?? null;
    let pendingAt = st?.pending_at ?? null;
    if (st && st.hash !== NEVER && pending === null) {
      // Changed here since the last scan (while this page was downloading).
      const local = this.current(item.kind, item.id)?.hash ?? GONE;
      if (local !== st.hash) {
        pending = local;
        pendingAt = this.nowIso();
      }
    } else if (!st) {
      const local = this.current(item.kind, item.id);
      if (local) {
        pending = local.hash;
        pendingAt = local.editedAt;
      }
    }
    if (pending === null || pending === contentHash(item.data)) return { action: "apply" };
    if (pendingAt && Date.parse(pendingAt) > Date.parse(item.editedAt)) return { action: "keep", pending, pendingAt };
    return { action: "apply" };
  }

  /** The organisation's version, seen and overruled by a later change here (sent next, based on this version). */
  keep(item: SyncItem, pending: string, pendingAt: string | null): void {
    this.db.run(
      `INSERT INTO sync_state (kind, id, hash, seq, edited_at, blobs, blob_key, pending, pending_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(kind, id) DO UPDATE SET hash = excluded.hash, seq = excluded.seq, edited_at = excluded.edited_at, blobs = excluded.blobs, blob_key = excluded.blob_key, pending = excluded.pending, pending_at = excluded.pending_at`,
      item.kind,
      item.id,
      contentHash(item.data),
      item.seq,
      item.editedAt,
      JSON.stringify(item.blobs),
      this.blobKeyOf(item),
      pending,
      pendingAt ?? this.nowIso(),
    );
  }

  /** What an item's blobs were made from: a HUD's package fingerprint. */
  private blobKeyOf(item: SyncItem): string | null {
    return item.kind === "hud" && item.data && typeof item.data.package === "string" ? item.data.package : null;
  }

  /** Files to download before the item can be applied (an asset not here yet, a HUD package that changed). */
  blobsNeeded(item: SyncItem): string[] {
    if (item.data === null) return [];
    if (item.kind === "asset") {
      const a = AssetData.safeParse(item.data);
      return a.success && !existsSync(this.assetPath(item.id)) ? [a.data.sha256] : [];
    }
    if (item.kind === "hud" && this.d.huds) {
      const h = HudData.safeParse(item.data);
      return h.success && this.installedFingerprint(item.id) !== h.data.package ? item.blobs.slice(0, 1) : [];
    }
    return [];
  }

  /** Fingerprint of the HUD installed here under this id (imported or a sample), null: none. */
  private installedFingerprint(id: string): string | null {
    const row = this.db.get<{ checksums: string; classification: string }>("SELECT checksums, classification FROM hud_packages WHERE id = ?", id);
    return row && row.classification !== "builtin" ? packageFingerprint(JSON.parse(row.checksums) as Record<string, string>) : null;
  }

  /** Applies one of the organisation's items here (its blobs downloaded) and records it as the shared version, in one transaction. */
  apply(item: SyncItem, blobs: ReadonlyMap<string, Uint8Array> = new Map()): void {
    this.db.transaction(() => {
      const orgHash = this.applyItem(item, blobs);
      const hash = item.data === null ? GONE : (orgHash ?? this.current(item.kind, item.id)?.hash ?? contentHash(item.data));
      this.record(item, hash, this.blobKeyOf(item));
      if (item.kind === "roster" || item.kind === "team" || item.kind === "player") this.dedupeRoster();
    });
  }

  /** An item that cannot be used here: noted as seen (this computer keeps what it has), so it is not fetched or overwritten again. */
  skip(item: SyncItem): void {
    this.record(item, this.current(item.kind, item.id)?.hash ?? GONE, null);
  }

  private record(item: SyncItem, hash: string, blobKey: string | null): void {
    this.db.run(
      `INSERT INTO sync_state (kind, id, hash, seq, edited_at, blobs, blob_key, pending, pending_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT(kind, id) DO UPDATE SET hash = excluded.hash, seq = excluded.seq, edited_at = excluded.edited_at, blobs = excluded.blobs, blob_key = excluded.blob_key,
         pending = NULL, pending_at = NULL, rejected = NULL, rejected_hash = NULL, rejected_at = NULL`,
      item.kind,
      item.id,
      hash,
      item.seq,
      item.editedAt,
      JSON.stringify(item.blobs),
      blobKey,
    );
  }

  /** Returns the organisation version's hash when local data was merged into it (so the merged record is sent back), else null. */
  private applyItem(item: SyncItem, blobs: ReadonlyMap<string, Uint8Array>): string | null {
    switch (item.kind) {
      case "team":
      case "player":
      case "event":
      case "match":
        return this.applyDoc(item.kind, item);
      case "roster":
        this.applyRoster(item);
        return null;
      case "map":
        this.applyMap(item);
        return null;
      case "veto":
        this.applyVeto(item);
        return null;
      case "asset":
        this.applyAsset(item, blobs);
        return null;
      case "hud":
        this.applyHud(item, blobs);
        return null;
    }
  }

  private applyDoc(kind: DocKind, item: SyncItem): string | null {
    const repo = this.repo(kind);
    if (item.data === null) {
      if (kind === "player") this.db.run("DELETE FROM players_steam WHERE player_id = ?", item.id);
      if (kind === "match") this.db.run("DELETE FROM settings WHERE key = ?", `${VETO_STEPS}${item.id}`);
      repo.delete(item.id);
      return null;
    }
    const { archived, vetoSteps, ...rest } = item.data;
    let body: Record<string, unknown> = { ...rest, id: item.id };
    const before = repo.get(item.id);
    const dups = before || (kind !== "team" && kind !== "player") ? [] : this.localDuplicates(kind, body);
    let orgHash: string | null = null;
    if (dups.length > 0) {
      orgHash = this.docHash(kind, item);
      for (const dup of dups) body = fillGaps(body, dup.data as Record<string, unknown>);
    }
    const saved = before ? repo.update(item.id, body) : repo.create(body);
    this.db.run("UPDATE documents SET archived = ? WHERE kind = ? AND id = ?", archived === true ? 1 : 0, kind, item.id);
    if (kind === "match") {
      if (vetoSteps === null || vetoSteps === undefined) this.db.run("DELETE FROM settings WHERE key = ?", `${VETO_STEPS}${item.id}`);
      else this.d.settings.set(`${VETO_STEPS}${item.id}`, vetoSteps);
    }
    if (kind === "player") {
      const was = (before?.data as { steamId?: string | null } | undefined)?.steamId ?? null;
      const now = (saved.data as { steamId?: string | null }).steamId ?? null;
      if (was && was !== now && this.d.steamIndex.lookup(was) === item.id) this.d.steamIndex.remove(was);
      if (now) this.d.steamIndex.set(now, item.id);
    }
    for (const dup of dups) {
      // The computer's own copy becomes the organisation's: its id is replaced everywhere.
      this.rewriteRefs(dup.id, item.id);
      repo.delete(dup.id);
      this.db.run("DELETE FROM sync_state WHERE kind = ? AND id = ?", kind, dup.id);
      this.merged++;
    }
    return orgHash;
  }

  /** The hash the organisation's version of a document has on this computer (its fields as this program stores them). */
  private docHash(kind: DocKind, item: SyncItem): string {
    const { archived, vetoSteps, ...rest } = item.data!;
    const schema = { team: Team, player: Player, event: EventRecord, match: Match }[kind];
    const parsed = schema.safeParse({ ...rest, id: item.id });
    const data: Record<string, unknown> = { ...(parsed.success ? (parsed.data as Record<string, unknown>) : rest), id: item.id, archived: archived === true };
    if (kind === "match") data.vetoSteps = vetoSteps ?? null;
    return contentHash(data);
  }

  /**
   * Local players and teams never shared that are the organisation's record under another id: a
   * player with the same SteamID, a team with the same name (ignoring case, spaces and symbols).
   */
  private localDuplicates(kind: "team" | "player", org: Record<string, unknown>): { id: string; data: unknown }[] {
    const unshared = (id: string) => {
      const st = this.state(kind, id);
      return !st || st.hash === NEVER;
    };
    if (kind === "player") {
      const steamId = typeof org.steamId === "string" ? org.steamId : null;
      if (!steamId) return [];
      return this.d.players
        .list({ includeArchived: true })
        .filter((p) => p.id !== org.id && p.data.steamId === steamId && unshared(p.id))
        .map((p) => ({ id: p.id, data: p.data }));
    }
    const name = typeof org.name === "string" ? normalizeName(org.name) : "";
    if (!name) return [];
    return this.d.teams
      .list({ includeArchived: true })
      .filter((t) => t.id !== org.id && normalizeName(t.data.name) === name && unshared(t.id))
      .map((t) => ({ id: t.id, data: t.data }));
  }

  /**
   * Points every local reference to `oldId` at `newId`: rosters, matches, maps, veto, stages and
   * other records, HUD settings and program settings. Ids are unique random strings, so string
   * values equal to the old id are references to it.
   */
  rewriteRefs(oldId: string, newId: string): void {
    const swap = (v: unknown): unknown => (v === oldId ? newId : Array.isArray(v) ? v.map(swap) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)])) : v);
    const now = this.nowIso();
    for (const r of this.db.all<{ kind: string; id: string; data: string }>("SELECT kind, id, data FROM documents WHERE instr(data, ?) > 0 AND id != ?", oldId, oldId)) {
      this.db.run("UPDATE documents SET data = ?, updated_at = ? WHERE kind = ? AND id = ?", JSON.stringify(swap(JSON.parse(r.data))), now, r.kind, r.id);
    }
    this.db.run("UPDATE roster_memberships SET team_id = ? WHERE team_id = ?", newId, oldId);
    this.db.run("UPDATE roster_memberships SET player_id = ? WHERE player_id = ?", newId, oldId);
    this.db.run("UPDATE players_steam SET player_id = ? WHERE player_id = ?", newId, oldId);
    for (const r of this.db.all<{ id: string; data: string }>("SELECT id, data FROM map_instances WHERE instr(data, ?) > 0", oldId)) {
      this.db.run("UPDATE map_instances SET data = ? WHERE id = ?", JSON.stringify(swap(JSON.parse(r.data))), r.id);
    }
    for (const r of this.db.all<{ id: string; data: string }>("SELECT id, data FROM veto_decisions WHERE instr(data, ?) > 0", oldId)) {
      this.db.run("UPDATE veto_decisions SET data = ? WHERE id = ?", JSON.stringify(swap(JSON.parse(r.data))), r.id);
    }
    for (const r of this.db.all<{ id: string; settings: string }>("SELECT id, settings FROM hud_library WHERE instr(settings, ?) > 0", oldId)) {
      this.db.run("UPDATE hud_library SET settings = ? WHERE id = ?", JSON.stringify(swap(JSON.parse(r.settings))), r.id);
    }
    for (const r of this.db.all<{ key: string; value: string }>("SELECT key, value FROM settings WHERE instr(value, ?) > 0 AND key NOT LIKE 'cloud.%'", oldId)) {
      this.db.run("UPDATE settings SET value = ?, updated_at = ? WHERE key = ?", JSON.stringify(swap(JSON.parse(r.value))), now, r.key);
    }
  }

  /** A current roster entry never shared that the organisation already has (same team and player): the organisation's is kept. */
  private dedupeRoster(): void {
    const dupes = this.db.all<{ id: string }>(
      `SELECT r.id FROM roster_memberships r LEFT JOIN sync_state s ON s.kind = 'roster' AND s.id = r.id
       WHERE r.valid_to IS NULL AND (s.hash IS NULL OR s.hash = '')
         AND EXISTS (SELECT 1 FROM roster_memberships o JOIN sync_state so ON so.kind = 'roster' AND so.id = o.id AND so.hash NOT IN ('', '-')
                     WHERE o.id != r.id AND o.team_id = r.team_id AND o.player_id = r.player_id AND o.valid_to IS NULL)`,
    );
    for (const d of dupes) {
      this.db.run("DELETE FROM roster_memberships WHERE id = ?", d.id);
      this.db.run("DELETE FROM sync_state WHERE kind = 'roster' AND id = ?", d.id);
    }
  }

  private applyRoster(item: SyncItem): void {
    if (item.data === null) {
      this.db.run("DELETE FROM roster_memberships WHERE id = ?", item.id);
      return;
    }
    const m = RosterMembership.parse({ ...item.data, id: item.id });
    this.db.run(
      `INSERT INTO roster_memberships (id, team_id, player_id, role, valid_from, valid_to) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET team_id = excluded.team_id, player_id = excluded.player_id, role = excluded.role, valid_from = excluded.valid_from, valid_to = excluded.valid_to`,
      m.id,
      m.teamId,
      m.playerId,
      m.role,
      m.validFrom,
      m.validTo,
    );
  }

  private applyMap(item: SyncItem): void {
    if (item.data === null) {
      this.db.run("DELETE FROM map_instances WHERE id = ?", item.id);
      return;
    }
    const mi = MapInstance.parse({ ...item.data, id: item.id });
    // Another map in the same place of the match was replaced there (its deletion follows, or loses to this one).
    this.db.run("DELETE FROM map_instances WHERE match_id = ? AND ord = ? AND id != ?", mi.matchId, mi.order, mi.id);
    this.db.run("INSERT INTO map_instances (id, match_id, ord, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET match_id = excluded.match_id, ord = excluded.ord, data = excluded.data", mi.id, mi.matchId, mi.order, JSON.stringify(mi));
  }

  private applyVeto(item: SyncItem): void {
    if (item.data === null) {
      this.db.run("DELETE FROM veto_decisions WHERE id = ?", item.id);
      return;
    }
    const { supersededBy, createdAt, ...rest } = item.data;
    const d = VetoDecision.parse({ ...rest, id: item.id });
    const superseded = typeof supersededBy === "string" ? supersededBy : null;
    // One active decision per step: a revision supersedes the one it replaced (that row's own change follows).
    if (superseded === null) this.db.run("UPDATE veto_decisions SET superseded_by = ? WHERE match_id = ? AND step_order = ? AND superseded_by IS NULL AND id != ?", d.id, d.matchId, d.stepOrder, d.id);
    this.db.run(
      `INSERT INTO veto_decisions (id, match_id, step_order, data, superseded_by, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET match_id = excluded.match_id, step_order = excluded.step_order, data = excluded.data, superseded_by = excluded.superseded_by, created_at = excluded.created_at`,
      d.id,
      d.matchId,
      d.stepOrder,
      JSON.stringify(d),
      superseded,
      typeof createdAt === "string" ? createdAt : d.decidedAt,
    );
  }

  private applyAsset(item: SyncItem, blobs: ReadonlyMap<string, Uint8Array>): void {
    // Files stay when an asset is no longer shared (other records here may use them).
    if (item.data === null) return;
    const a = AssetData.parse(item.data);
    const m = ASSET_ID_RE.exec(item.id);
    if (!m || m[1] !== a.sha256.slice(0, 24) || m[2] !== a.ext || !ASSET_EXT.has(a.ext)) throw new Error(`asset ${item.id} does not match its file`);
    const path = this.assetPath(item.id);
    if (!existsSync(path)) {
      const bytes = blobs.get(a.sha256);
      if (!bytes) throw new Error(`the file of asset ${item.id} was not downloaded`);
      if (sha256(bytes) !== a.sha256) throw new Error(`the file of asset ${item.id} is damaged`);
      mkdirSync(this.d.assetsDir, { recursive: true });
      const tmp = `${path}.part`;
      writeFileSync(tmp, bytes);
      renameSync(tmp, path);
    }
    this.assetSha.set(item.id, a.sha256);
  }

  private applyHud(item: SyncItem, blobs: ReadonlyMap<string, Uint8Array>): void {
    const huds = this.d.huds;
    if (!huds) return;
    const kept = this.localHuds();
    if (item.data === null) {
      if (!huds.has(item.id) || kept.has(item.id)) return;
      try {
        huds.remove(item.id);
      } catch (e) {
        if ((e as { code?: string }).code !== "in_use") throw e;
        // Removed elsewhere but on air here: kept on this computer only.
        this.d.settings.set(LOCAL_HUDS_KEY, [...kept, item.id]);
      }
      return;
    }
    const h = HudData.parse(item.data);
    if (this.installedFingerprint(item.id) !== h.package) {
      const sha = item.blobs[0];
      const bytes = sha ? blobs.get(sha) : undefined;
      if (!bytes) throw new Error(`the package of HUD ${item.id} was not downloaded`);
      const files = readArchive(bytes);
      const manifest = validateManifest(files);
      if (manifest.id !== item.id) throw new Error(`the shared package is HUD ${manifest.id}, not ${item.id}`);
      huds.installShared(files);
    }
    huds.applySharedSettings(item.id, h.settings, h.presetId);
    if (kept.has(item.id)) this.d.settings.set(LOCAL_HUDS_KEY, [...kept].filter((x) => x !== item.id));
  }
}
