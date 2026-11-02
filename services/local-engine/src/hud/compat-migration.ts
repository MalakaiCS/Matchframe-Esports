import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { IMPORTED_HUD_PREFIX, LEGACY_IMPORTED_HUD_PREFIX } from "@matchframe/contracts";
import type { Database } from "../db/database.ts";
import type { Logger } from "../logger.ts";
import { migrateLegacyManifest } from "./compat.ts";

/**
 * Brings imported hud.json-format HUDs installed by 0.11.0 and earlier up to date, once, when the
 * engine starts (before the HUD Library reads them):
 *
 * - the id: the legacy prefix (LEGACY_IMPORTED_HUD_PREFIX) becomes IMPORTED_HUD_PREFIX
 *   (currentHudId), with the HUD's folder, its library row (token, settings, stopped state), the
 *   outputs, program settings and other HUDs' settings that name it, and its account sync record;
 * - the manifest (the database's copy and manifest.json in each installed version folder): the
 *   runtime "compat" instead of its legacy value, and the category, tag and description MatchFrame
 *   generated on import; the recorded checksum of manifest.json follows.
 *
 * Nothing else of the HUD's files changes. A HUD whose new id is taken (or would be too long) keeps
 * its legacy id; its manifest is brought up to date all the same. Old addresses keep working: the
 * HUD server resolves a legacy id to the HUD's id (HudLibraryService.resolveId). Running it again
 * changes nothing.
 */

export interface LegacyHudMigration {
  /** HUDs whose id changed. */
  renamed: { from: string; to: string }[];
  /** HUDs whose manifest changed but whose id stayed (and why). */
  kept: { id: string; reason: string }[];
}

interface PackageRow {
  id: string;
  manifest: string;
  classification: string;
  install_dir: string;
  checksums: string;
  previous: string | null;
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** A value with every reference to HUD `from` pointed at `to`: the id itself, its output id (`hud:<id>`) and its addresses (`/hud/<id>/`, `/huds/<id>/`). */
export function swapHudId(v: unknown, from: string, to: string): unknown {
  if (typeof v === "string") {
    if (v === from) return to;
    if (v === `hud:${from}`) return `hud:${to}`;
    if (v.includes(`/${from}/`)) return v.split(`/hud/${from}/`).join(`/hud/${to}/`).split(`/huds/${from}/`).join(`/huds/${to}/`);
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => swapHudId(x, from, to));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [swapHudId(k, from, to) as string, swapHudId(x, from, to)]));
  return v;
}

/** Rewrites manifest.json in a version folder; returns its bytes before and after, or null when it is missing or already up to date. */
function rewriteManifestFile(versionDir: string): { file: string; before: Buffer; after: Buffer } | null {
  const file = join(versionDir, "manifest.json");
  if (!existsSync(file)) return null;
  const before = readFileSync(file);
  let raw: unknown;
  try {
    raw = JSON.parse(before.toString("utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const next = migrateLegacyManifest(raw as Record<string, unknown>);
  if (!next) return null;
  const after = Buffer.from(JSON.stringify(next, null, 2) + "\n");
  writeFileSync(file, after);
  return { file, before, after };
}

export function migrateLegacyHuds(d: { db: Database; logger: Logger }): LegacyHudMigration {
  const out: LegacyHudMigration = { renamed: [], kept: [] };
  const rows = d.db.all<PackageRow>("SELECT id, manifest, classification, install_dir, checksums, previous FROM hud_packages WHERE classification != 'builtin' ORDER BY id");
  const ids = new Set(rows.map((r) => r.id));
  for (const row of rows) {
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(row.manifest) as Record<string, unknown>;
    } catch {
      continue;
    }
    const next = migrateLegacyManifest({ ...manifest, id: row.id });
    if (!next) continue;
    let to = String(next.id);
    const oldPkgDir = dirname(row.install_dir);
    let newPkgDir = join(dirname(oldPkgDir), to);
    let reason: string | null = null;
    if (to === row.id) reason = row.id.startsWith(LEGACY_IMPORTED_HUD_PREFIX) ? `its id would be too long with the prefix ${IMPORTED_HUD_PREFIX}` : "its id has no legacy prefix";
    else if (ids.has(to)) reason = `another HUD has the id ${to}`;
    else if (basename(oldPkgDir) !== row.id) reason = "its folder is not where this program keeps it";
    else if (existsSync(newPkgDir) && existsSync(oldPkgDir)) reason = `the folder ${newPkgDir} exists already`;
    if (reason !== null) {
      to = row.id;
      next.id = row.id;
      newPkgDir = oldPkgDir;
    }

    // Files first: the package folder (a run that stopped after this finds it moved), then each version's manifest.json.
    const moved = to !== row.id && existsSync(oldPkgDir);
    const rewritten: { file: string; before: Buffer; after: Buffer }[] = [];
    try {
      if (moved) renameSync(oldPkgDir, newPkgDir);
      const versions = existsSync(newPkgDir) ? readdirSync(newPkgDir).filter((n) => !n.includes(".staging-") && statSync(join(newPkgDir, n)).isDirectory()) : [];
      for (const v of versions) {
        const r = rewriteManifestFile(join(newPkgDir, v));
        if (r) rewritten.push(r);
      }
      const installDir = join(newPkgDir, basename(row.install_dir));
      const checksums = JSON.parse(row.checksums) as Record<string, string>;
      const current = join(installDir, "manifest.json");
      if (checksums["manifest.json"] && existsSync(current)) checksums["manifest.json"] = sha256(readFileSync(current));
      let previous: { version: string; installDir: string } | null = null;
      try {
        previous = row.previous ? (JSON.parse(row.previous) as { version: string; installDir: string }) : null;
      } catch {
        previous = null;
      }
      if (previous && dirname(previous.installDir) === oldPkgDir) previous = { ...previous, installDir: join(newPkgDir, basename(previous.installDir)) };
      const from = row.id;
      d.db.transaction(() => {
        d.db.run(
          "UPDATE hud_packages SET id = ?, manifest = ?, install_dir = ?, checksums = ?, previous = ? WHERE id = ?",
          to,
          JSON.stringify({ ...next, classification: row.classification }),
          installDir,
          JSON.stringify(checksums),
          previous ? JSON.stringify(previous) : null,
          from,
        );
        if (to !== from) repointReferences(d.db, from, to);
      });
    } catch (err) {
      // Put the files back as they were: the HUD keeps working under its legacy id and is tried again at the next start.
      for (const r of rewritten) {
        try {
          writeFileSync(r.file, r.before);
        } catch {
          // reported below
        }
      }
      if (moved && existsSync(newPkgDir) && !existsSync(oldPkgDir)) {
        try {
          renameSync(newPkgDir, oldPkgDir);
        } catch {
          // reported below
        }
      }
      d.logger.error("imported HUD could not be brought up to date; it keeps working as it was", { id: row.id, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    ids.delete(row.id);
    ids.add(to);
    if (to !== row.id) out.renamed.push({ from: row.id, to });
    else out.kept.push({ id: row.id, reason: reason! });
  }
  if (out.renamed.length || out.kept.length) d.logger.info("imported HUDs brought up to date", { renamed: out.renamed, manifestOnly: out.kept });
  return out;
}

/** Points every stored reference to HUD `from` at `to` (inside the caller's transaction). */
function repointReferences(db: Database, from: string, to: string): void {
  const swap = (json: string) => JSON.stringify(swapHudId(JSON.parse(json), from, to));
  db.run("UPDATE hud_library SET id = ? WHERE id = ?", to, from);
  for (const r of db.all<{ id: string; settings: string }>("SELECT id, settings FROM hud_library WHERE instr(settings, ?) > 0", from)) {
    db.run("UPDATE hud_library SET settings = ? WHERE id = ?", swap(r.settings), r.id);
  }
  // Outputs (packageId) and any other record naming the HUD; edit times stay (nothing was edited).
  for (const r of db.all<{ kind: string; id: string; data: string }>("SELECT kind, id, data FROM documents WHERE instr(data, ?) > 0", from)) {
    db.run("UPDATE documents SET data = ? WHERE kind = ? AND id = ?", swap(r.data), r.kind, r.id);
  }
  for (const r of db.all<{ output_id: string; revision: number; data: string }>("SELECT output_id, revision, data FROM output_revisions WHERE instr(data, ?) > 0", from)) {
    db.run("UPDATE output_revisions SET data = ? WHERE output_id = ? AND revision = ?", swap(r.data), r.output_id, r.revision);
  }
  // Program settings: the replay graphic's and the HUD pages' HUD, HUDs kept on this computer only, ...
  for (const r of db.all<{ key: string; value: string }>("SELECT key, value FROM settings WHERE instr(value, ?) > 0 OR instr(key, ?) > 0", from, from)) {
    const key = swapHudId(r.key, from, to) as string;
    const value = swap(r.value);
    if (key === r.key) db.run("UPDATE settings SET value = ? WHERE key = ?", value, r.key);
    else {
      db.run("DELETE FROM settings WHERE key = ?", r.key);
      db.run("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value, new Date().toISOString());
    }
  }
  // Account sync: the record this computer shares the HUD as (the organisation gets it under the new id next).
  if (db.get("SELECT 1 FROM sync_state WHERE kind = 'hud' AND id = ?", to)) db.run("DELETE FROM sync_state WHERE kind = 'hud' AND id = ?", from);
  else db.run("UPDATE sync_state SET id = ? WHERE kind = 'hud' AND id = ?", to, from);
}
