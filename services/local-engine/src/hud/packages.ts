import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { extname, join, normalize, relative, sep } from "node:path";
import { unzipSync } from "fflate";
import type { HudManifest } from "@matchframe/contracts";
import { HudManifest as HudManifestSchema, RESERVED_HUD_IDS } from "@matchframe/contracts";
import type { Database } from "../db/database.ts";

export const PACKAGE_LIMITS = {
  maxTotalBytes: 60 * 1024 * 1024,
  maxFileBytes: 25 * 1024 * 1024,
  maxFiles: 2000,
  allowedExtensions: new Set([".html", ".js", ".mjs", ".css", ".json", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".woff", ".woff2", ".ttf", ".otf", ".webm", ".mp4", ".txt", ".md", ".ico"]),
};

export class PackageError extends Error {
  readonly status = 400;
}

export interface InstalledPackage {
  id: string;
  manifest: HudManifest;
  classification: "builtin" | "imported";
  installDir: string;
  checksums: Record<string, string>;
  installedAt: string;
  previous: { version: string; installDir: string } | null;
}

/** Validates an archive/directory entry path: relative, no traversal, no absolute or drive paths. */
export function safeEntryPath(p: string): string {
  const unix = p.replace(/\\/g, "/");
  if (unix.startsWith("/") || /^[a-zA-Z]:/.test(unix) || unix.includes("\0")) throw new PackageError(`absolute path not allowed: ${p}`);
  const norm = normalize(unix).replace(/\\/g, "/");
  if (norm.startsWith("../") || norm === ".." || norm.split("/").includes("..")) throw new PackageError(`path traversal not allowed: ${p}`);
  return norm;
}

function checkFile(path: string, size: number): void {
  const ext = extname(path).toLowerCase();
  if (!PACKAGE_LIMITS.allowedExtensions.has(ext)) throw new PackageError(`file type not allowed: ${path}`);
  if (size > PACKAGE_LIMITS.maxFileBytes) throw new PackageError(`file too large: ${path}`);
  // Packages are static web assets: nothing in a package is ever executed during install, and
  // executable/script file types (.exe, .bat, .sh, .ps1, .node, ...) are rejected by the allowlist.
}

function sha256(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}

/** Reads and validates the files of a package from a zip archive buffer. */
export function readArchive(buf: Uint8Array): Map<string, Uint8Array> {
  let total = 0;
  let count = 0;
  const files = new Map<string, Uint8Array>();
  const entries = unzipSync(buf, {
    filter: (f) => {
      count++;
      if (count > PACKAGE_LIMITS.maxFiles) throw new PackageError("too many files");
      if (f.originalSize > PACKAGE_LIMITS.maxFileBytes) throw new PackageError(`file too large: ${f.name}`);
      total += f.originalSize;
      if (total > PACKAGE_LIMITS.maxTotalBytes) throw new PackageError("package too large");
      return true;
    },
  });
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith("/")) continue;
    const p = safeEntryPath(name);
    checkFile(p, data.length);
    files.set(p, data);
  }
  return stripCommonRoot(files);
}

/** Reads a package directory, rejecting symlinks and anything outside the directory. */
export function readDirectory(dir: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let total = 0;
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) throw new PackageError(`symbolic links are not allowed: ${relative(dir, full)}`);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) {
        const rel = safeEntryPath(relative(dir, full).split(sep).join("/"));
        checkFile(rel, st.size);
        total += st.size;
        if (total > PACKAGE_LIMITS.maxTotalBytes) throw new PackageError("package too large");
        if (files.size >= PACKAGE_LIMITS.maxFiles) throw new PackageError("too many files");
        files.set(rel, readFileSync(full));
      }
    }
  };
  walk(dir);
  return files;
}

function stripCommonRoot(files: Map<string, Uint8Array>): Map<string, Uint8Array> {
  if (files.has("manifest.json")) return files;
  const roots = new Set([...files.keys()].map((k) => k.split("/")[0]));
  if (roots.size !== 1) return files;
  const root = [...roots][0]!;
  if (!files.has(`${root}/manifest.json`)) return files;
  return new Map([...files].map(([k, v]) => [k.slice(root.length + 1), v]));
}

export function validateManifest(files: Map<string, Uint8Array>): HudManifest {
  const raw = files.get("manifest.json");
  if (!raw) throw new PackageError("manifest.json missing");
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new PackageError("manifest.json is not valid JSON");
  }
  const r = HudManifestSchema.safeParse(json);
  if (!r.success) throw new PackageError(`invalid manifest: ${r.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const m = r.data;
  if ((RESERVED_HUD_IDS as readonly string[]).includes(m.id)) throw new PackageError(`HUD id "${m.id}" is reserved; choose another id in manifest.json`);
  if (!m.schemaVersions.includes(1)) throw new PackageError("package does not support HUD state schema version 1");
  for (const [variant, entry] of Object.entries(m.entryPoints)) {
    const p = safeEntryPath(entry);
    if (!files.has(p)) throw new PackageError(`entry point for ${variant} missing: ${entry}`);
    if (extname(p) !== ".html") throw new PackageError(`entry point must be an HTML file: ${entry}`);
  }
  return { ...m, classification: "imported" };
}

/**
 * Installs, versions and rolls back HUD packages. A failed import never touches the installed
 * version, so the live HUD keeps working.
 */
export class HudPackageManager {
  constructor(
    private readonly db: Database,
    private readonly rootDir: string,
  ) {
    mkdirSync(rootDir, { recursive: true });
  }

  list(): InstalledPackage[] {
    return this.db
      .all<{ id: string; manifest: string; classification: string; install_dir: string; checksums: string; installed_at: string; previous: string | null }>("SELECT * FROM hud_packages ORDER BY id")
      .map((r) => ({ id: r.id, manifest: JSON.parse(r.manifest), classification: r.classification as InstalledPackage["classification"], installDir: r.install_dir, checksums: JSON.parse(r.checksums), installedAt: r.installed_at, previous: r.previous ? JSON.parse(r.previous) : null }));
  }

  get(id: string): InstalledPackage | undefined {
    return this.list().find((p) => p.id === id);
  }

  /** Registers the built-in package served from the app's own HUD renderer build. */
  registerBuiltin(manifest: HudManifest, installDir: string): void {
    const m = { ...manifest, classification: "builtin" as const };
    this.db.run(
      "INSERT INTO hud_packages (id, manifest, classification, install_dir, checksums, installed_at, previous) VALUES (?, ?, 'builtin', ?, '{}', ?, NULL) ON CONFLICT(id) DO UPDATE SET manifest = excluded.manifest, install_dir = excluded.install_dir",
      m.id,
      JSON.stringify(m),
      installDir,
      new Date().toISOString(),
    );
  }

  install(files: Map<string, Uint8Array>): InstalledPackage {
    const manifest = validateManifest(files);
    const existing = this.get(manifest.id);
    if (existing?.classification === "builtin") throw new PackageError(`cannot replace built-in package ${manifest.id}`);
    const checksums: Record<string, string> = {};
    const target = join(this.rootDir, manifest.id, manifest.version);
    const staging = `${target}.staging-${Date.now()}`;
    mkdirSync(staging, { recursive: true });
    try {
      for (const [p, data] of files) {
        const out = join(staging, p);
        mkdirSync(join(out, ".."), { recursive: true });
        writeFileSync(out, data);
        checksums[p] = sha256(data);
      }
      if (existsSync(target)) rmSync(target, { recursive: true, force: true });
      renameSync(staging, target);
    } catch (e) {
      rmSync(staging, { recursive: true, force: true });
      throw e;
    }
    // Reinstalling the same version overwrites its folder, so the earlier rollback target stays.
    const previous = existing && existing.installDir !== target ? { version: existing.manifest.version, installDir: existing.installDir } : (existing?.previous ?? null);
    this.pruneVersions(manifest.id, [target, previous?.installDir ?? target]);
    this.db.run(
      "INSERT INTO hud_packages (id, manifest, classification, install_dir, checksums, installed_at, previous) VALUES (?, ?, 'imported', ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET manifest = excluded.manifest, install_dir = excluded.install_dir, checksums = excluded.checksums, installed_at = excluded.installed_at, previous = excluded.previous",
      manifest.id,
      JSON.stringify(manifest),
      target,
      JSON.stringify(checksums),
      new Date().toISOString(),
      previous ? JSON.stringify(previous) : null,
    );
    return this.get(manifest.id)!;
  }

  /** Keeps only the active and the rollback version folders of a package. */
  private pruneVersions(id: string, keep: string[]): void {
    const dir = join(this.rootDir, id);
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (!keep.includes(full) && !name.includes(".staging-")) rmSync(full, { recursive: true, force: true });
    }
  }

  /** Re-activates the previously installed version (instant rollback). */
  rollback(id: string): InstalledPackage {
    const cur = this.get(id);
    if (!cur?.previous) throw new PackageError("no previous version to roll back to");
    const prevFiles = readDirectory(cur.previous.installDir);
    const manifest = validateManifest(prevFiles);
    this.db.run(
      "UPDATE hud_packages SET manifest = ?, install_dir = ?, previous = ?, installed_at = ? WHERE id = ?",
      JSON.stringify(manifest),
      cur.previous.installDir,
      JSON.stringify({ version: cur.manifest.version, installDir: cur.installDir }),
      new Date().toISOString(),
      id,
    );
    return this.get(id)!;
  }

  /** Verifies installed files against recorded checksums. */
  verify(id: string): { ok: boolean; mismatches: string[] } {
    const p = this.get(id);
    if (!p || p.classification === "builtin") return { ok: true, mismatches: [] };
    const mismatches: string[] = [];
    for (const [file, sum] of Object.entries(p.checksums)) {
      const full = join(p.installDir, file);
      if (!existsSync(full) || sha256(readFileSync(full)) !== sum) mismatches.push(file);
    }
    return { ok: mismatches.length === 0, mismatches };
  }

  remove(id: string): void {
    const p = this.get(id);
    if (!p) return;
    if (p.classification === "builtin") throw new PackageError("built-in packages cannot be removed");
    this.db.run("DELETE FROM hud_packages WHERE id = ?", id);
    rmSync(join(this.rootDir, id), { recursive: true, force: true });
  }

  exportDir(id: string, dest: string): void {
    const p = this.get(id);
    if (!p) throw new PackageError("unknown package");
    cpSync(p.installDir, dest, { recursive: true });
  }
}
