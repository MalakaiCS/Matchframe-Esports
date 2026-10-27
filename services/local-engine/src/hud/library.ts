import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { zipSync } from "fflate";
import type { HudLibrary, HudLibraryEntry, HudManifest, HudOutputMode, HudRuntimeControl, HudVariant } from "@matchframe/contracts";
import { HUD_OUTPUT_MODES, HUD_VARIANTS, HudSettingField, RESERVED_HUD_IDS } from "@matchframe/contracts";
import type { Database } from "../db/database.ts";
import type { SettingsRepo } from "../db/store.ts";
import { HttpError } from "../http/router.ts";
import type { Logger } from "../logger.ts";
import type { OutputService } from "./outputs.ts";
import type { HudPackageManager, InstalledPackage } from "./packages.ts";
import { convertLhmPackage } from "./lhm.ts";
import { PackageError, readDirectory, safeEntryPath, validateManifest } from "./packages.ts";

export type LibraryKind = HudLibraryEntry["kind"];
export type OnConflict = "fail" | "replace" | "copy";
export const ON_CONFLICT = ["fail", "replace", "copy"] as const;

/** Output id a library HUD uses on the HUD state socket (`/overlay-ws?output=hud:<id>`). */
export const libraryOutputId = (hudId: string) => `hud:${hudId}`;
export const libraryHudId = (outputId: string): string | null => (outputId.startsWith("hud:") ? outputId.slice(4) : null);

/** What changed in the library; the HUD server pushes control messages, snapshots or closes sockets. */
export type LibraryEvent =
  | { type: "settings"; hudId: string }
  /** stopped / hidden / reloadSeq / design size; hudId null = every HUD (global hide-all). */
  | { type: "control"; hudId: string | null }
  | { type: "closed"; hudId: string; reason: "removed" | "token_rotated" };

/** Live output counts, provided by the HUD server while it runs. */
export interface LibraryRuntime {
  outputs(hudId: string): Record<HudOutputMode, number>;
  /** Sends a panel button press to an LHM-format HUD; false when it is not one of its buttons. */
  action?(hudId: string, key: string, value: string): boolean;
}

export interface HudLibraryDeps {
  db: Database;
  settings: SettingsRepo;
  packages: HudPackageManager;
  outputs: OutputService;
  logger: Logger;
  hudsDir: string;
  hudRendererDir: string | null;
  overlayPort: number;
}

interface LibraryRow {
  id: string;
  kind: LibraryKind;
  settings: Record<string, unknown>;
  presetId: string | null;
  token: string;
  stopped: boolean;
  reloadSeq: number;
  addedAt: string;
  lastUsedAt: string | null;
}

interface DbRow {
  id: string;
  kind: string;
  settings: string;
  preset_id: string | null;
  token: string;
  stopped: number;
  reload_seq: number;
  added_at: string;
  last_used_at: string | null;
}

const MAX_SETTINGS_BYTES = 64 * 1024;
const HIDDEN_ALL_KEY = "hud.library.hiddenAll";
const SAMPLES_KEY = "hud.library.samples";
const ID_RE = /^[a-z0-9][a-z0-9.-]{2,63}$/;
const COLOR_RE = /^(#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(rgb|rgba|hsl|hsla)\([0-9.,%\s/+-]+\)|transparent)$/i;

const newToken = () => randomBytes(12).toString("hex");
const zeroOutputs = (): Record<HudOutputMode, number> => ({ obs: 0, desktop: 0, preview: 0 });

/** Numeric semver comparison (major.minor.patch; a pre-release sorts before its release). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", pre] = v.split(/[-+]/, 2);
    return { nums: core.split(".").map((n) => Number(n) || 0), pre: v.includes("-") ? (pre ?? "") : null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export function designResolutionOf(m: HudManifest): { width: number; height: number } {
  if (m.designResolution) return m.designResolution;
  const [w, h] = (m.resolutions[0] ?? "1920x1080").split("x").map(Number);
  return { width: w || 1920, height: h || 1080 };
}

type Coerced = { ok: true; value: unknown } | { ok: false; message: string };

/** Coerces one settings value to its field type, or explains why it cannot be used. */
function coerceSetting(key: string, f: HudSettingField, v: unknown): Coerced {
  const name = f.label ? `"${f.label}" (${key})` : key;
  switch (f.type) {
    case "boolean":
      if (typeof v === "boolean") return { ok: true, value: v };
      if (v === "true" || v === 1 || v === "1") return { ok: true, value: true };
      if (v === "false" || v === 0 || v === "0") return { ok: true, value: false };
      return { ok: false, message: `${name} must be true or false` };
    case "number": {
      const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
      if (!Number.isFinite(n)) return { ok: false, message: `${name} must be a number` };
      if (f.min !== undefined && n < f.min) return { ok: false, message: `${name} must be at least ${f.min}` };
      if (f.max !== undefined && n > f.max) return { ok: false, message: `${name} must be at most ${f.max}` };
      return { ok: true, value: n };
    }
    case "string":
      if (typeof v === "number" || typeof v === "boolean") return { ok: true, value: String(v) };
      if (typeof v !== "string") return { ok: false, message: `${name} must be text` };
      if (v.length > 2000) return { ok: false, message: `${name} is too long (2000 characters at most)` };
      return { ok: true, value: v };
    case "color":
      if (typeof v === "string" && COLOR_RE.test(v.trim())) return { ok: true, value: v.trim() };
      return { ok: false, message: `${name} must be a colour such as #ff3300` };
    case "select": {
      const s = typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : null;
      const options = f.options ?? [];
      if (s !== null && options.some((o) => o.value === s)) return { ok: true, value: s };
      return { ok: false, message: `${name} must be one of: ${options.map((o) => o.value).join(", ")}` };
    }
    case "player":
    case "team":
      if (v === "") return { ok: true, value: "" };
      if (typeof v === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(v)) return { ok: true, value: v };
      return { ok: false, message: `${name} must be a ${f.type === "player" ? "player" : "team"} from Matchframe` };
    case "action":
      return { ok: false, message: `${name} is a button: it sends an action and stores nothing` };
  }
}

/**
 * Normalizes a manifest `settingsSchema` into form fields. Valid `HudSettingField`s are kept, a
 * bare default value (`"accent": "#ff3300"`) becomes a field of its type, select options may be
 * plain strings, and defaults that do not fit their field are dropped. Other shapes are left out
 * of the form; their values are still kept in the HUD's settings. Buttons ("action") are kept only
 * for LHM-format HUDs, the only HUDs they can be sent to.
 */
export function normalizeSettingsSchema(raw: Record<string, unknown> | undefined, runtime: "matchframe" | "lhm" = "matchframe"): Record<string, HudSettingField> {
  const out: Record<string, HudSettingField> = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (key.length === 0 || key.length > 64) continue;
    let field: HudSettingField | null = null;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const v = value as Record<string, unknown>;
      const options = Array.isArray(v.options) ? v.options.map((o) => (typeof o === "string" ? { value: o, label: o } : o)) : v.options;
      const r = HudSettingField.safeParse({ ...v, options });
      if (r.success && (r.data.type !== "action" || runtime === "lhm") && ((r.data.type !== "select" && r.data.type !== "action") || (r.data.options?.length ?? 0) > 0)) field = r.data;
    } else if (typeof value === "boolean") field = { type: "boolean", default: value };
    else if (typeof value === "number" && Number.isFinite(value)) field = { type: "number", default: value };
    else if (typeof value === "string") field = { type: COLOR_RE.test(value) && value.startsWith("#") ? "color" : "string", default: value };
    if (!field) continue;
    if (field.default !== undefined) {
      const d = coerceSetting(key, field, field.default);
      if (d.ok) field.default = d.value;
      else delete field.default;
    }
    out[key] = field;
  }
  return out;
}

/** Lenient settings validation: known fields are coerced (or rejected with a clear message), unknown keys are kept, null resets a key to its default. */
export function validateSettings(schema: Record<string, HudSettingField>, input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (value === null || value === undefined) continue;
    const f = schema[key];
    if (!f) {
      out[key] = value;
      continue;
    }
    // Buttons store nothing (the form never sends them; anything sent is dropped).
    if (f.type === "action") continue;
    const r = coerceSetting(key, f, value);
    if (r.ok) out[key] = r.value;
    else problems.push(r.message);
  }
  if (problems.length) throw new HttpError(400, `invalid settings: ${problems.join("; ")}`, "invalid_settings", { problems });
  if (Buffer.byteLength(JSON.stringify(out)) > MAX_SETTINGS_BYTES) throw new HttpError(400, `settings are too large (${MAX_SETTINGS_BYTES / 1024} KB at most)`, "settings_too_large");
  return out;
}

function defaultsOf(schema: Record<string, HudSettingField>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(schema)) if (f.default !== undefined) out[k] = f.default;
  return out;
}

/** Returns a copy of the package files with manifest.json's id and name rewritten (other fields kept as written). */
function rewriteManifest(files: Map<string, Uint8Array>, patch: { id: string; name: string }): Map<string, Uint8Array> {
  const raw = JSON.parse(new TextDecoder().decode(files.get("manifest.json"))) as Record<string, unknown>;
  const out = new Map(files);
  out.set("manifest.json", new TextEncoder().encode(JSON.stringify({ ...raw, id: patch.id, name: patch.name }, null, 2) + "\n"));
  return out;
}

function copyName(name: string): string {
  const suffix = " (copy)";
  return (name.length + suffix.length > 80 ? name.slice(0, 80 - suffix.length) : name) + suffix;
}

/**
 * The HUD Library (ADR-020): installed HUDs with per-HUD settings, token, stopped flag and reload
 * sequence. Files and versions are kept by HudPackageManager (`<data>/huds/<id>/<version>`); this
 * service adds the library metadata (`hud_library`), conflict handling, samples and the runtime
 * state the HUD server needs.
 */
export class HudLibraryService {
  private runtime: LibraryRuntime | null = null;
  private readonly listeners = new Set<(ev: LibraryEvent) => void>();
  private readonly verifyCache = new Map<string, { key: string; error: string | null }>();

  constructor(private readonly d: HudLibraryDeps) {
    this.sync();
  }

  get overlayOrigin(): string {
    return `http://127.0.0.1:${this.d.overlayPort}`;
  }

  /** The HUD server reports connected output wrappers while it runs. */
  attachRuntime(rt: LibraryRuntime | null): void {
    this.runtime = rt;
  }

  onChange(fn: (ev: LibraryEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(ev: LibraryEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(ev);
      } catch (err) {
        this.d.logger.warn("HUD library listener failed", { error: String(err) });
      }
    }
  }

  // ---------------------------------------------------------------------------- rows

  /** Gives every installed package a library row (built-in, packages added through the older package routes) and drops rows of removed packages. */
  sync(): void {
    const pkgs = this.d.packages.list();
    const rows = new Map(this.rows().map((r) => [r.id, r]));
    for (const p of pkgs) if (!rows.has(p.id)) this.insertRow(p.id, p.classification === "builtin" ? "builtin" : "imported");
    const ids = new Set(pkgs.map((p) => p.id));
    for (const id of rows.keys()) if (!ids.has(id)) this.d.db.run("DELETE FROM hud_library WHERE id = ?", id);
  }

  private toRow(r: DbRow): LibraryRow {
    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(r.settings) as Record<string, unknown>;
    } catch {
      // a damaged settings value falls back to the defaults
    }
    return { id: r.id, kind: r.kind as LibraryKind, settings, presetId: r.preset_id, token: r.token, stopped: r.stopped === 1, reloadSeq: r.reload_seq, addedAt: r.added_at, lastUsedAt: r.last_used_at };
  }

  private rows(): LibraryRow[] {
    return this.d.db.all<DbRow>("SELECT * FROM hud_library ORDER BY id").map((r) => this.toRow(r));
  }

  private row(id: string): LibraryRow | undefined {
    const r = this.d.db.get<DbRow>("SELECT * FROM hud_library WHERE id = ?", id);
    return r ? this.toRow(r) : undefined;
  }

  private insertRow(id: string, kind: LibraryKind, init: { settings?: Record<string, unknown>; presetId?: string | null } = {}): void {
    this.d.db.run(
      "INSERT INTO hud_library (id, kind, settings, preset_id, token, stopped, reload_seq, added_at, last_used_at) VALUES (?, ?, ?, ?, ?, 0, 0, ?, NULL) ON CONFLICT(id) DO NOTHING",
      id,
      kind,
      JSON.stringify(init.settings ?? {}),
      init.presetId ?? null,
      newToken(),
      new Date().toISOString(),
    );
  }

  private require(id: string): { pkg: InstalledPackage; row: LibraryRow } {
    const pkg = this.d.packages.get(id);
    if (!pkg) throw new HttpError(404, `HUD ${id} is not installed`, "not_found");
    let row = this.row(id);
    if (!row) {
      this.insertRow(id, pkg.classification === "builtin" ? "builtin" : "imported");
      row = this.row(id)!;
    }
    return { pkg, row };
  }

  /** True when the HUD is installed (creating its library row if a package route added it). */
  has(id: string): boolean {
    if (!this.d.packages.get(id)) return false;
    if (!this.row(id)) this.sync();
    return true;
  }

  // ---------------------------------------------------------------------------- views

  list(): HudLibrary {
    this.sync();
    const order: Record<LibraryKind, number> = { builtin: 0, sample: 1, imported: 2 };
    const rows = new Map(this.rows().map((r) => [r.id, r]));
    const huds = this.d.packages
      .list()
      .filter((p) => rows.has(p.id))
      .map((p) => this.toEntry(p, rows.get(p.id)!))
      .sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return { huds, hudsDir: this.d.hudsDir, overlayOrigin: this.overlayOrigin, hiddenAll: this.hiddenAll };
  }

  entry(id: string): HudLibraryEntry {
    const { pkg, row } = this.require(id);
    return this.toEntry(pkg, row);
  }

  private toEntry(pkg: InstalledPackage, row: LibraryRow): HudLibraryEntry {
    const m = pkg.manifest;
    const builtin = pkg.classification === "builtin";
    const schema = normalizeSettingsSchema(m.settingsSchema, m.runtime);
    const variants = HUD_VARIANTS.filter((v) => m.entryPoints[v]);
    const outputs = this.runtime?.outputs(pkg.id) ?? zeroOutputs();
    const error = this.problem(pkg);
    const connected = HUD_OUTPUT_MODES.reduce((n, mode) => n + outputs[mode], 0);
    const urls: Partial<Record<HudVariant, string>> = {};
    for (const v of variants) urls[v] = `${this.overlayOrigin}/hud/${encodeURIComponent(pkg.id)}/${v}?t=${row.token}`;
    return {
      id: pkg.id,
      name: m.name,
      version: m.version,
      author: m.author,
      licence: m.licence,
      description: m.description,
      category: m.category,
      tags: m.tags,
      game: m.game,
      kind: row.kind,
      runtime: m.runtime ?? "matchframe",
      thumbnailUrl: this.thumbnailUrl(pkg),
      variants,
      designResolution: designResolutionOf(m),
      folder: builtin ? null : pkg.installDir,
      installedAt: pkg.installedAt,
      lastUsedAt: row.lastUsedAt,
      previousVersion: pkg.previous?.version ?? null,
      status: error ? "error" : row.stopped ? "stopped" : connected > 0 ? "running" : "ready",
      error,
      stopped: row.stopped,
      outputs,
      urls,
      settings: { ...defaultsOf(schema), ...row.settings },
      settingsSchema: schema,
      presets: m.presets,
      presetId: this.presetOf(m, row),
    };
  }

  private presetOf(m: HudManifest, row: LibraryRow): string | null {
    if (row.presetId && (m.presets.length === 0 || m.presets.some((p) => p.id === row.presetId))) return row.presetId;
    return m.presets[0]?.id ?? null;
  }

  private thumbnailUrl(pkg: InstalledPackage): string | null {
    if (pkg.classification === "builtin") {
      const dir = this.d.hudRendererDir;
      return dir && existsSync(join(dir, "thumbnail.webp")) ? `${this.overlayOrigin}/hud/thumbnail.webp` : null;
    }
    const file = pkg.manifest.thumbnail ?? pkg.manifest.preview;
    if (!file) return null;
    try {
      const rel = safeEntryPath(file);
      if (!existsSync(join(pkg.installDir, rel))) return null;
      return `${this.overlayOrigin}/huds/${encodeURIComponent(pkg.id)}/${rel.split("/").map(encodeURIComponent).join("/")}`;
    } catch {
      return null;
    }
  }

  /** Why the HUD cannot run (missing entry file, files changed since install), or null. */
  private problem(pkg: InstalledPackage): string | null {
    if (pkg.classification === "builtin") {
      const dir = this.d.hudRendererDir;
      return dir && existsSync(join(dir, "index.html")) ? null : "HUD renderer build not found (run pnpm build)";
    }
    for (const entry of new Set(Object.values(pkg.manifest.entryPoints))) {
      if (entry && !existsSync(join(pkg.installDir, entry))) return `entry file missing: ${entry}; import the HUD again to repair it`;
    }
    // Checksums are recomputed only when a file's size or modification time changed.
    const key = [pkg.installDir, pkg.installedAt, ...Object.keys(pkg.checksums).map((f) => {
      try {
        const st = statSync(join(pkg.installDir, f));
        return `${f}:${st.size}:${st.mtimeMs}`;
      } catch {
        return `${f}:missing`;
      }
    })].join("|");
    const cached = this.verifyCache.get(pkg.id);
    if (cached?.key === key) return cached.error;
    const v = this.d.packages.verify(pkg.id);
    const error = v.ok ? null : `files changed or missing since install: ${v.mismatches.slice(0, 5).join(", ")}${v.mismatches.length > 5 ? ` (+${v.mismatches.length - 5} more)` : ""}; import the HUD again to repair it`;
    this.verifyCache.set(pkg.id, { key, error });
    return error;
  }

  get hiddenAll(): boolean {
    return this.d.settings.get<boolean>(HIDDEN_ALL_KEY, false);
  }

  /** What a library HUD's outputs render with (settings incl. defaults, preset, implemented variants). Null for an unknown HUD. */
  runtimeConfig(id: string): {
    settings: Record<string, unknown>;
    presetId: string | null;
    variants: HudVariant[];
    entryPoints: HudManifest["entryPoints"];
    builtin: boolean;
    designResolution: { width: number; height: number };
    name: string;
    runtime: HudManifest["runtime"];
    installDir: string | null;
  } | null {
    if (!this.has(id)) return null;
    const pkg = this.d.packages.get(id);
    const row = this.row(id);
    if (!pkg || !row) return null;
    const m = pkg.manifest;
    return {
      settings: { ...defaultsOf(normalizeSettingsSchema(m.settingsSchema)), ...row.settings },
      presetId: this.presetOf(m, row),
      variants: HUD_VARIANTS.filter((v) => m.entryPoints[v]),
      entryPoints: m.entryPoints,
      builtin: pkg.classification === "builtin",
      designResolution: designResolutionOf(m),
      name: m.name,
      runtime: m.runtime ?? "matchframe",
      installDir: pkg.classification === "builtin" ? null : pkg.installDir,
    };
  }

  checkToken(id: string, token: string | null): boolean {
    if (!token) return false;
    const expected = this.row(id)?.token;
    if (!expected) return false;
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** A settings-form button ("action" field) pressed for this HUD. */
  action(id: string, key: string, value: string): void {
    const { pkg } = this.require(id);
    const field = normalizeSettingsSchema(pkg.manifest.settingsSchema, pkg.manifest.runtime)[key];
    if (!field || field.type !== "action" || !field.options?.some((o) => o.value === value)) throw new HttpError(400, `${key} has no button ${value}`, "unknown_action");
    if (!this.runtime?.action?.(id, key, value)) throw new HttpError(409, "the HUD is not running: open it first", "not_running");
  }

  control(id: string): HudRuntimeControl | null {
    const pkg = this.d.packages.get(id);
    const row = pkg ? this.row(id) : undefined;
    if (!pkg || !row) return null;
    return { type: "control", hudId: id, stopped: row.stopped, hidden: this.hiddenAll, reloadSeq: row.reloadSeq, designResolution: designResolutionOf(pkg.manifest) };
  }

  // ---------------------------------------------------------------------------- import, copy, export, remove

  /**
   * Installs a validated package. An id that is already installed fails with 409 duplicate_id
   * unless onConflict says `replace` (install over it; the replaced version becomes the rollback
   * target; running outputs reload) or `copy` (install as `<id>-copy[-n]`, "<name> (copy)").
   */
  importFiles(input: Map<string, Uint8Array>, onConflict: OnConflict = "fail"): { entry: HudLibraryEntry; result: "installed" | "replaced" | "copied" } {
    // LHM-format HUDs (hud.json) get a manifest.json and run in the LHM compatibility layer.
    let files: Map<string, Uint8Array>;
    try {
      files = convertLhmPackage(input).files;
    } catch (e) {
      throw new PackageError(e instanceof Error ? e.message : String(e));
    }
    const manifest = validateManifest(files);
    this.sync();
    const existing = this.d.packages.get(manifest.id);
    if (!existing) {
      this.d.packages.install(files);
      this.insertRow(manifest.id, "imported");
      return { entry: this.entry(manifest.id), result: "installed" };
    }
    const detail = { id: manifest.id, installedVersion: existing.manifest.version, incomingVersion: manifest.version, builtin: existing.classification === "builtin" };
    if (onConflict === "replace") {
      if (detail.builtin) throw new HttpError(409, "the built-in HUD cannot be replaced; import the package as a copy instead", "builtin", detail);
      this.replace(files, "imported");
      return { entry: this.entry(manifest.id), result: "replaced" };
    }
    if (onConflict === "copy") {
      const id = this.copyId(manifest.id);
      this.d.packages.install(rewriteManifest(files, { id, name: copyName(manifest.name) }));
      this.insertRow(id, "imported");
      return { entry: this.entry(id), result: "copied" };
    }
    throw new HttpError(409, `${existing.manifest.name} (${manifest.id}) is already installed (version ${existing.manifest.version}); replace it or import a copy`, "duplicate_id", detail);
  }

  /** Installs over an existing HUD, keeping its settings and token; running outputs reload. */
  private replace(files: Map<string, Uint8Array>, kind: LibraryKind): void {
    const pkg = this.d.packages.install(files);
    if (!this.row(pkg.id)) this.insertRow(pkg.id, kind);
    else this.d.db.run("UPDATE hud_library SET kind = ?, reload_seq = reload_seq + 1 WHERE id = ?", kind, pkg.id);
    this.verifyCache.delete(pkg.id);
    this.emit({ type: "control", hudId: pkg.id });
    this.emit({ type: "settings", hudId: pkg.id });
  }

  /** Called after the older package routes installed or rolled back a package, so the library and its outputs follow. */
  packageChanged(id: string, opts: { userImport?: boolean } = {}): void {
    this.sync();
    const row = this.row(id);
    if (!row) return;
    this.d.db.run("UPDATE hud_library SET reload_seq = reload_seq + 1, kind = ? WHERE id = ?", opts.userImport && row.kind === "sample" ? "imported" : row.kind, id);
    this.verifyCache.delete(id);
    this.emit({ type: "control", hudId: id });
    this.emit({ type: "settings", hudId: id });
  }

  /** Called after the older package routes removed a package: drops its library row and disconnects its outputs. */
  packageRemoved(id: string): void {
    this.sync();
    this.verifyCache.delete(id);
    this.emit({ type: "closed", hudId: id, reason: "removed" });
  }

  /** First free `<id>-copy`, `<id>-copy-2`, ... that is a valid, unreserved id. */
  private copyId(id: string): string {
    for (let n = 1; n < 1000; n++) {
      const suffix = n === 1 ? "-copy" : `-copy-${n}`;
      const candidate = id.slice(0, 64 - suffix.length) + suffix;
      if (ID_RE.test(candidate) && !(RESERVED_HUD_IDS as readonly string[]).includes(candidate) && !this.d.packages.get(candidate)) return candidate;
    }
    throw new HttpError(409, "too many copies of this HUD", "too_many_copies");
  }

  /** Copies the installed files (manifest id and name rewritten, checksums recomputed) and the settings to a new HUD. */
  duplicate(id: string): HudLibraryEntry {
    const { pkg, row } = this.require(id);
    if (pkg.classification === "builtin") throw new HttpError(409, "the built-in HUD cannot be duplicated; change its settings instead", "builtin");
    const newId = this.copyId(id);
    this.d.packages.install(rewriteManifest(readDirectory(pkg.installDir), { id: newId, name: copyName(pkg.manifest.name) }));
    this.insertRow(newId, "imported", { settings: row.settings, presetId: row.presetId });
    return this.entry(newId);
  }

  /** ZIP of the installed folder (manifest.json at the root), re-importable as is. */
  exportZip(id: string): { filename: string; bytes: Uint8Array } {
    const { pkg } = this.require(id);
    if (pkg.classification === "builtin") throw new HttpError(409, "the built-in HUD is part of the program and cannot be exported", "builtin");
    const files = readDirectory(pkg.installDir);
    return { filename: `${pkg.id}-${pkg.manifest.version}.zip`, bytes: zipSync(Object.fromEntries(files), { level: 6 }) };
  }

  /** Removes the HUD, its files and settings. The built-in HUD and HUDs used by published broadcast outputs are refused. */
  remove(id: string): void {
    const { pkg } = this.require(id);
    if (pkg.classification === "builtin") throw new HttpError(409, "the built-in HUD cannot be removed", "builtin");
    const inUse = this.d.outputs.list().filter((o) => o.published?.data.packageId === id).map((o) => o.draft.outputId);
    if (inUse.length > 0) throw new HttpError(409, `HUD is used by published broadcast outputs: ${inUse.join(", ")}`, "in_use", { outputs: inUse });
    this.d.packages.remove(id);
    this.d.db.run("DELETE FROM hud_library WHERE id = ?", id);
    this.verifyCache.delete(id);
    this.emit({ type: "closed", hudId: id, reason: "removed" });
  }

  // ---------------------------------------------------------------------------- settings and runtime control

  setSettings(id: string, settings: Record<string, unknown>, presetId?: string | null): HudLibraryEntry {
    const { pkg } = this.require(id);
    const clean = validateSettings(normalizeSettingsSchema(pkg.manifest.settingsSchema), settings);
    const presets = pkg.manifest.presets;
    if (presetId && presets.length > 0 && !presets.some((p) => p.id === presetId)) {
      throw new HttpError(400, `unknown preset ${presetId}; this HUD has ${presets.map((p) => p.id).join(", ")}`, "unknown_preset");
    }
    if (presetId === undefined) this.d.db.run("UPDATE hud_library SET settings = ? WHERE id = ?", JSON.stringify(clean), id);
    else this.d.db.run("UPDATE hud_library SET settings = ?, preset_id = ? WHERE id = ?", JSON.stringify(clean), presetId, id);
    this.emit({ type: "settings", hudId: id });
    return this.entry(id);
  }

  start(id: string): HudLibraryEntry {
    this.require(id);
    this.d.db.run("UPDATE hud_library SET stopped = 0, last_used_at = ? WHERE id = ?", new Date().toISOString(), id);
    this.emit({ type: "control", hudId: id });
    return this.entry(id);
  }

  stop(id: string): HudLibraryEntry {
    this.require(id);
    this.d.db.run("UPDATE hud_library SET stopped = 1 WHERE id = ?", id);
    this.emit({ type: "control", hudId: id });
    return this.entry(id);
  }

  reload(id: string): HudLibraryEntry {
    this.require(id);
    this.d.db.run("UPDATE hud_library SET reload_seq = reload_seq + 1 WHERE id = ?", id);
    this.emit({ type: "control", hudId: id });
    return this.entry(id);
  }

  rollback(id: string): HudLibraryEntry {
    const { pkg } = this.require(id);
    if (pkg.classification === "builtin") throw new HttpError(409, "the built-in HUD has no previous version", "builtin");
    if (!pkg.previous) throw new HttpError(409, "no previous version to roll back to", "no_previous");
    this.d.packages.rollback(id);
    this.d.db.run("UPDATE hud_library SET reload_seq = reload_seq + 1 WHERE id = ?", id);
    this.verifyCache.delete(id);
    this.emit({ type: "control", hudId: id });
    this.emit({ type: "settings", hudId: id });
    return this.entry(id);
  }

  /** New token: old URLs stop working and connected outputs are disconnected. */
  rotateToken(id: string): HudLibraryEntry {
    this.require(id);
    this.d.db.run("UPDATE hud_library SET token = ? WHERE id = ?", newToken(), id);
    this.emit({ type: "closed", hudId: id, reason: "token_rotated" });
    return this.entry(id);
  }

  /** Global hide-all of HUD graphics (desktop overlays, previews and OBS sources). */
  setHiddenAll(hidden: boolean): boolean {
    this.d.settings.set(HIDDEN_ALL_KEY, hidden);
    this.emit({ type: "control", hudId: null });
    return hidden;
  }

  // ---------------------------------------------------------------------------- bundled samples

  /**
   * Installs each bundled sample package once. Each sample folder is a package (it has
   * manifest.json) or holds package folders; a missing or invalid folder is skipped with a
   * warning. Installed sample ids are remembered, so a removed sample is not installed again. A
   * newer bundled version updates the installed sample unless the user replaced it with their own
   * import.
   */
  installSamples(dirs: string[]): void {
    const folders: string[] = [];
    for (const dir of dirs) {
      try {
        if (!existsSync(dir) || !statSync(dir).isDirectory()) {
          this.d.logger.warn("sample HUD folder not found", { folder: dir });
          continue;
        }
        if (existsSync(join(dir, "manifest.json"))) folders.push(dir);
        else for (const name of readdirSync(dir)) if (existsSync(join(dir, name, "manifest.json")) && statSync(join(dir, name)).isDirectory()) folders.push(join(dir, name));
      } catch (err) {
        this.d.logger.warn("sample HUD folder skipped", { folder: dir, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (folders.length === 0) return;
    const record = this.d.settings.get<Record<string, { version: string }>>(SAMPLES_KEY, {});
    for (const folder of folders) {
      try {
        const files = readDirectory(folder);
        const m = validateManifest(files);
        const seen = record[m.id];
        const installed = this.d.packages.get(m.id);
        if (!seen) {
          // A HUD with this id that is already installed (the user's own) is left alone.
          if (!installed) {
            this.d.packages.install(files);
            this.insertRow(m.id, "sample");
            this.d.logger.info("sample HUD installed", { id: m.id, version: m.version });
          }
          record[m.id] = { version: m.version };
        } else if (installed && this.row(m.id)?.kind === "sample" && compareVersions(m.version, seen.version) > 0 && compareVersions(m.version, installed.manifest.version) > 0) {
          this.replace(files, "sample");
          record[m.id] = { version: m.version };
          this.d.logger.info("sample HUD updated", { id: m.id, from: installed.manifest.version, to: m.version });
        }
        // Seen but not installed: the user removed it, which is respected.
      } catch (err) {
        this.d.logger.warn("bundled sample HUD skipped", { folder, error: err instanceof Error ? err.message : String(err) });
      }
    }
    this.d.settings.set(SAMPLES_KEY, record);
  }
}
