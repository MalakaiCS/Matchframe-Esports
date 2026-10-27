import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { OverlayOutput as OverlayOutputT } from "@matchframe/contracts";
import { HudVariant, OverlayOutput } from "@matchframe/contracts";
import type { Database } from "../db/database.ts";
import type { SettingsRepo } from "../db/store.ts";
import { DocumentRepo, NotFoundError } from "../db/store.ts";

export const OutputDraft = OverlayOutput.extend({
  id: z.string(),
  settings: z.record(z.string(), z.unknown()).default({}),
});
export type OutputDraft = z.infer<typeof OutputDraft>;

export interface PublishedOutput {
  revision: number;
  data: OutputDraft;
  publishedAt: string;
  publishedBy: string;
}

/**
 * Browser-source outputs. Operators edit a draft; on-air rendering uses the published revision
 * only. Each output has its own read-only token (rotatable) that grants nothing but the public
 * HUD projection for that output.
 */
export class OutputService {
  readonly drafts: DocumentRepo<typeof OutputDraft>;

  constructor(
    private readonly db: Database,
    private readonly settings: SettingsRepo,
  ) {
    this.drafts = new DocumentRepo(db, "output", OutputDraft);
  }

  ensureDefaults(packageId: string): void {
    const defaults: Partial<OverlayOutputT>[] = [
      { outputId: "main", name: "Main program HUD", variant: "live", profile: "program", timelineProfile: "live" },
      { outputId: "clean", name: "Clean feed", variant: "live", profile: "clean", timelineProfile: "live" },
      { outputId: "preview", name: "Preview", variant: "live", profile: "preview", timelineProfile: "live" },
    ];
    for (const d of defaults) {
      if (this.drafts.get(d.outputId!)) continue;
      this.drafts.create({ id: d.outputId, ...d, packageId, presetId: "classic", matchId: null, delayMs: 0, publishedRevision: null, settings: {} });
      this.publish(d.outputId!, "system");
    }
  }

  list(): { draft: OutputDraft; published: PublishedOutput | null; dirty: boolean }[] {
    return this.drafts.list().map((d) => {
      const pub = this.published(d.id);
      return { draft: d.data, published: pub, dirty: !pub || JSON.stringify(pub.data) !== JSON.stringify({ ...d.data, publishedRevision: pub.revision }) };
    });
  }

  published(outputId: string): PublishedOutput | null {
    const row = this.db.get<{ revision: number; data: string; published_at: string; published_by: string }>(
      "SELECT revision, data, published_at, published_by FROM output_revisions WHERE output_id = ? ORDER BY revision DESC LIMIT 1",
      outputId,
    );
    return row ? { revision: row.revision, data: JSON.parse(row.data) as OutputDraft, publishedAt: row.published_at, publishedBy: row.published_by } : null;
  }

  /** Atomic publication of the current draft as a new revision. */
  publish(outputId: string, by: string): PublishedOutput {
    return this.db.transaction(() => {
      const d = this.drafts.require(outputId);
      const cur = this.published(outputId);
      const revision = (cur?.revision ?? 0) + 1;
      const data = { ...d.data, publishedRevision: revision };
      this.db.run("INSERT INTO output_revisions (output_id, revision, data, published_at, published_by) VALUES (?, ?, ?, ?, ?)", outputId, revision, JSON.stringify(data), new Date().toISOString(), by);
      return this.published(outputId)!;
    });
  }

  /** Instant rollback: republishes an earlier revision's content as a new revision. */
  rollback(outputId: string, toRevision: number, by: string): PublishedOutput {
    return this.db.transaction(() => {
      const row = this.db.get<{ data: string }>("SELECT data FROM output_revisions WHERE output_id = ? AND revision = ?", outputId, toRevision);
      if (!row) throw new NotFoundError(`revision ${toRevision} not found`);
      const cur = this.published(outputId)!;
      const data = { ...(JSON.parse(row.data) as OutputDraft), publishedRevision: cur.revision + 1 };
      this.db.run("INSERT INTO output_revisions (output_id, revision, data, published_at, published_by) VALUES (?, ?, ?, ?, ?)", outputId, cur.revision + 1, JSON.stringify(data), new Date().toISOString(), by);
      return this.published(outputId)!;
    });
  }

  revisions(outputId: string): { revision: number; publishedAt: string; publishedBy: string }[] {
    return this.db
      .all<{ revision: number; published_at: string; published_by: string }>("SELECT revision, published_at, published_by FROM output_revisions WHERE output_id = ? ORDER BY revision DESC LIMIT 50", outputId)
      .map((r) => ({ revision: r.revision, publishedAt: r.published_at, publishedBy: r.published_by }));
  }

  private tokens(): Record<string, string> {
    return this.settings.get<Record<string, string>>("overlay.tokens", {});
  }

  token(outputId: string): string {
    const all = this.tokens();
    if (!all[outputId]) {
      all[outputId] = randomBytes(12).toString("hex");
      this.settings.set("overlay.tokens", all);
    }
    return all[outputId]!;
  }

  rotateToken(outputId: string): string {
    const all = this.tokens();
    all[outputId] = randomBytes(12).toString("hex");
    this.settings.set("overlay.tokens", all);
    return all[outputId]!;
  }

  checkToken(outputId: string, token: string | null): boolean {
    if (!token) return false;
    const expected = this.tokens()[outputId];
    if (!expected) return false;
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  url(base: string, outputId: string, variant?: string): string {
    const pub = this.published(outputId);
    const v = HudVariant.parse(variant ?? pub?.data.variant ?? "live");
    return `${base}/overlay/${encodeURIComponent(outputId)}/${v}?t=${this.token(outputId)}`;
  }
}
