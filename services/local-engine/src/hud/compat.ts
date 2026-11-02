import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { HudSettingField } from "@matchframe/contracts";
import { currentHudId, IMPORTED_HUD_PREFIX, LEGACY_COMPAT_RUNTIME } from "@matchframe/contracts";

/**
 * Imported HUDs in the hud.json format (a widely used community HUD template protocol): a folder
 * with hud.json, index.html and optionally panel.json (the HUD's control panel) and keybinds.json.
 * On import MatchFrame writes a manifest.json (runtime "compat") and turns panel.json into the
 * HUD's settings form; at run time the HUD compatibility layer (compat-runtime.ts) gives the HUD the
 * data and endpoints its template protocol expects.
 *
 * The file names hud.json, panel.json and keybinds.json are part of that format and stay as they are.
 */

const HudJson = z
  .object({
    name: z.string().trim().min(1).max(80),
    version: z.string().max(40).optional(),
    author: z.string().max(120).optional(),
    game: z.string().optional(),
    radar: z.boolean().optional(),
    killfeed: z.boolean().optional(),
    variants: z.array(z.string()).optional(),
  })
  .passthrough();

const PanelInput = z
  .object({
    type: z.string(),
    name: z.string().min(1).max(40),
    label: z.string().optional(),
    values: z.array(z.object({ name: z.string(), label: z.string().optional() }).passthrough()).optional(),
  })
  .passthrough();
const PanelSection = z.object({ label: z.string().optional(), name: z.string().min(1).max(40), inputs: z.array(PanelInput) }).passthrough();
const PanelJson = z.array(PanelSection);
export type CompatPanel = z.infer<typeof PanelJson>;

/** A settings key and the panel input it stands for. */
export interface CompatInputRef {
  key: string;
  section: string;
  input: string;
  type: string;
}

const decode = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b).replace(/^\uFEFF/, "") : null);

export function isHudJsonPackage(files: Map<string, Uint8Array>): boolean {
  return !files.has("manifest.json") && files.has("hud.json") && files.has("index.html");
}

export function parsePanel(raw: string | null): CompatPanel {
  if (!raw) return [];
  try {
    const r = PanelJson.safeParse(JSON.parse(raw));
    return r.success ? r.data : [];
  } catch {
    return [];
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** panel.json → settings form fields (`<section>.<input>`); unsupported inputs are listed. */
export function panelSettings(panel: CompatPanel): { schema: Record<string, HudSettingField>; refs: CompatInputRef[]; skipped: string[] } {
  const schema: Record<string, HudSettingField> = {};
  const refs: CompatInputRef[] = [];
  const skipped: string[] = [];
  for (const section of panel) {
    const group = clip(section.label || section.name, 40);
    for (const input of section.inputs) {
      const key = `${section.name}.${input.name}`;
      if (key.length > 64) {
        skipped.push(key);
        continue;
      }
      const label = clip(input.label || input.name, 80);
      const options = (input.values ?? []).map((v) => ({ value: v.name, label: clip(v.label || v.name, 80) }));
      let field: HudSettingField | null = null;
      switch (input.type) {
        case "text":
          field = { type: "string", label, group, default: "" };
          break;
        case "checkbox":
          field = { type: "boolean", label, group, default: false };
          break;
        case "color":
          field = { type: "color", label, group };
          break;
        case "select":
          if (options.length) field = { type: "select", label, group, options };
          break;
        case "player":
          field = { type: "player", label, group };
          break;
        case "team":
          field = { type: "team", label, group };
          break;
        case "action":
          if (options.length) field = { type: "action", label, group, options };
          break;
        case "images":
          field = { type: "images", label, group, default: [] };
          break;
      }
      if (!field) {
        skipped.push(`${key} (${input.type})`);
        continue;
      }
      schema[key] = field;
      refs.push({ key, section: section.name, input: input.name, type: input.type });
    }
  }
  return { schema, refs, skipped };
}

function slug(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 58)
    .replace(/-+$/, "");
  return s.length >= 2 ? s : `hud-${s || "x"}`;
}

function semver(v: string | undefined): string {
  const m = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v ?? "");
  return m ? `${Number(m[1])}.${Number(m[2] ?? 0)}.${Number(m[3] ?? 0)}` : "1.0.0";
}

/** Longest slug in an imported HUD's id (`imported.<slug>` is at most 64 characters). */
const SLUG_MAX = 64 - IMPORTED_HUD_PREFIX.length;

/** The manifest description of an imported hud.json-format HUD. */
const describe = (extras: string) => clip(`Imported HUD (hud.json format)${extras ? ` with its own ${extras}` : ""}, running in MatchFrame's HUD compatibility layer.`, 500);

/**
 * Adds a manifest.json (runtime "compat") to a hud.json-format package; other packages are returned
 * as they are. Throws a plain Error with the reason when hud.json is unusable.
 */
export function convertHudJsonPackage(files: Map<string, Uint8Array>): { files: Map<string, Uint8Array>; converted: boolean; skipped: string[] } {
  if (!isHudJsonPackage(files)) return { files, converted: false, skipped: [] };
  let hud: z.infer<typeof HudJson>;
  try {
    const r = HudJson.safeParse(JSON.parse(decode(files.get("hud.json")) ?? ""));
    if (!r.success) throw new Error(r.error.issues[0]?.message ?? "invalid");
    hud = r.data;
  } catch (e) {
    throw new Error(`hud.json is not a valid HUD description (${e instanceof Error ? e.message : String(e)})`, { cause: e });
  }
  if (hud.game && hud.game !== "cs2" && hud.game !== "csgo") throw new Error(`this HUD is for ${hud.game}; MatchFrame runs CS2 HUDs`);
  const { schema, skipped } = panelSettings(parsePanel(decode(files.get("panel.json"))));
  const extras = [hud.radar ? "minimap" : null, hud.killfeed ? "killfeed" : null].filter(Boolean).join(" and ");
  const thumbnail = ["thumb.png", "thumb.jpg", "thumb.webp", "thumbnail.png"].find((f) => files.has(f)) ?? null;
  const manifest = {
    manifestVersion: 1,
    id: `${IMPORTED_HUD_PREFIX}${slug(hud.name).slice(0, SLUG_MAX).replace(/-+$/, "")}`,
    name: clip(hud.name, 80),
    version: semver(hud.version),
    author: clip(hud.author?.trim() || "Unknown author", 120),
    licence: "As set by the HUD's author",
    description: describe(extras),
    game: "cs2",
    schemaVersions: [1],
    entryPoints: { live: "index.html" },
    thumbnail,
    category: IMPORTED_CATEGORY,
    tags: [IMPORTED_TAG, ...(hud.radar ? ["minimap"] : []), ...(hud.killfeed ? ["killfeed"] : [])],
    designResolution: { width: 1920, height: 1080 },
    permissions: ["match.public", "players.public", "radar.public", "utility.public", "series", "event"],
    settingsSchema: schema,
    runtime: "compat",
  };
  const out = new Map(files);
  out.set("manifest.json", new TextEncoder().encode(JSON.stringify(manifest, null, 2) + "\n"));
  return { files: out, converted: true, skipped };
}

/** Library category and tag of imported hud.json-format HUDs. */
export const IMPORTED_CATEGORY = "Imported";
export const IMPORTED_TAG = "imported";

/** The category the converter of 0.11.0 and earlier wrote (the legacy runtime value in capitals). */
const LEGACY_CATEGORY = LEGACY_COMPAT_RUNTIME.toUpperCase();
/** The description it wrote ("<category>-format HUD with its own …, running in …'s <category> compatibility mode."). */
const LEGACY_DESCRIPTION = new RegExp(`^${LEGACY_CATEGORY}-format HUD(?: with its own (.+?))?, running in \\w+'s ${LEGACY_CATEGORY} compatibility mode\\.$`);

/**
 * A manifest.json written by 0.11.0 and earlier for an imported hud.json-format HUD, as it is
 * written now: the legacy id prefix and runtime value replaced (currentHudId), and the category, tag
 * and description MatchFrame generated for it on import brought up to date. Null when nothing
 * changes (any other manifest, or one already up to date).
 */
export function migrateLegacyManifest(raw: Record<string, unknown>): Record<string, unknown> | null {
  const id = typeof raw.id === "string" ? raw.id : null;
  const legacyRuntime = raw.runtime === LEGACY_COMPAT_RUNTIME;
  const newId = id ? currentHudId(id) : null;
  if (!legacyRuntime && newId === id) return null;
  const out: Record<string, unknown> = { ...raw };
  if (newId) out.id = newId;
  if (legacyRuntime) {
    out.runtime = "compat";
    // Only what the converter generated then; anything the HUD's author wrote stays.
    if (raw.category === LEGACY_CATEGORY) out.category = IMPORTED_CATEGORY;
    if (Array.isArray(raw.tags)) out.tags = raw.tags.map((t) => (t === LEGACY_COMPAT_RUNTIME ? IMPORTED_TAG : t));
    const d = typeof raw.description === "string" ? LEGACY_DESCRIPTION.exec(raw.description) : null;
    if (d) out.description = describe(d[1] ?? "");
  }
  return out;
}

/**
 * A package's files with a manifest of 0.11.0 or earlier brought up to date (migrateLegacyManifest):
 * how a HUD exported or shared by an older version is installed.
 */
export function migrateLegacyPackage(files: Map<string, Uint8Array>): Map<string, Uint8Array> {
  const raw = files.get("manifest.json");
  if (!raw) return files;
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(raw).replace(/^\uFEFF/, ""));
  } catch {
    return files;
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return files;
  const next = migrateLegacyManifest(json as Record<string, unknown>);
  if (!next) return files;
  const out = new Map(files);
  out.set("manifest.json", new TextEncoder().encode(JSON.stringify(next, null, 2) + "\n"));
  return out;
}

/** Values the HUD gets for a "player", "team" or "images" input; MatchFrame stores just the ids. */
export interface CompatLookup {
  player(steamId: string): Record<string, unknown> | null;
  team(teamId: string): Record<string, unknown> | null;
  /** An uploaded image as base64 without a data: prefix (how the format sends image inputs), or null. */
  image(assetId: string): string | null;
}

/** A page name an imported HUD declares in hud.json `variants` (used in a URL query). */
const VIEW_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;

/**
 * An imported HUD's own pages: hud.json `variants` (for example player-stats, match-stats,
 * match-preview, veto, baseboard). The HUD reads the page name from its `variant` query parameter.
 */
export function compatViews(installDir: string | null): { id: string; label: string }[] {
  if (!installDir) return [];
  const file = join(installDir, "hud.json");
  if (!existsSync(file)) return [];
  try {
    const r = HudJson.safeParse(JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")));
    const names = r.success ? (r.data.variants ?? []) : [];
    return [...new Set(names.filter((v) => VIEW_RE.test(v) && v !== "default"))].slice(0, 20).map((id) => ({ id, label: viewLabel(id) }));
  } catch {
    return [];
  }
}

/** "player-stats" → "Player stats". */
export function viewLabel(id: string): string {
  const words = id.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The HUD's settings in the format's hud_config shape: `{ [section]: { [input]: value } }`. */
export function hudConfig(panel: CompatPanel, settings: Record<string, unknown>, lookup: CompatLookup): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const ref of panelSettings(panel).refs) {
    if (ref.type === "action") continue;
    const v = settings[ref.key];
    let value: unknown = v ?? null;
    if (ref.type === "player") value = typeof v === "string" && v ? { type: "player", id: v, player: lookup.player(v) } : null;
    else if (ref.type === "team") value = typeof v === "string" && v ? { type: "team", id: v, team: lookup.team(v) } : null;
    else if (ref.type === "images") {
      const images = Array.isArray(v) ? v.filter((id): id is string => typeof id === "string").map((id) => lookup.image(id)).filter((b): b is string => !!b) : [];
      value = images.length ? images : null;
    }
    if (value === null && ref.type !== "checkbox") continue;
    (out[ref.section] ??= {})[ref.input] = value ?? false;
  }
  return out;
}

/** Whether `action`/`value` is a button on this panel. */
export function isPanelAction(panel: CompatPanel, key: string, value: string): { section: string; input: string } | null {
  const ref = panelSettings(panel).refs.find((r) => r.key === key && r.type === "action");
  if (!ref) return null;
  const input = panel.find((s) => s.name === ref.section)?.inputs.find((i) => i.name === ref.input);
  return input?.values?.some((v) => v.name === value) ? { section: ref.section, input: ref.input } : null;
}
