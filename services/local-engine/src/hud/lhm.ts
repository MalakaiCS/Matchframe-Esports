import { z } from "zod";
import type { HudSettingField } from "@matchframe/contracts";

/**
 * LHM-format HUDs (the Lexogrine HUD template protocol): a folder with hud.json, index.html and
 * optionally panel.json (the HUD's control panel) and keybinds.json. On import Matchframe writes a
 * manifest.json (runtime "lhm") and turns panel.json into the HUD's settings form; at run time the
 * LHM compatibility layer (lhm-runtime.ts) gives the HUD what it expects from LHM.
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
export type LhmPanel = z.infer<typeof PanelJson>;

/** A settings key and the panel input it stands for. */
export interface LhmInputRef {
  key: string;
  section: string;
  input: string;
  type: string;
}

const decode = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b).replace(/^\uFEFF/, "") : null);

export function isLhmPackage(files: Map<string, Uint8Array>): boolean {
  return !files.has("manifest.json") && files.has("hud.json") && files.has("index.html");
}

export function parsePanel(raw: string | null): LhmPanel {
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
export function panelSettings(panel: LhmPanel): { schema: Record<string, HudSettingField>; refs: LhmInputRef[]; skipped: string[] } {
  const schema: Record<string, HudSettingField> = {};
  const refs: LhmInputRef[] = [];
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

/**
 * Adds a manifest.json (runtime "lhm") to an LHM-format package; other packages are returned as
 * they are. Throws a plain Error with the reason when hud.json is unusable.
 */
export function convertLhmPackage(files: Map<string, Uint8Array>): { files: Map<string, Uint8Array>; converted: boolean; skipped: string[] } {
  if (!isLhmPackage(files)) return { files, converted: false, skipped: [] };
  let hud: z.infer<typeof HudJson>;
  try {
    const r = HudJson.safeParse(JSON.parse(decode(files.get("hud.json")) ?? ""));
    if (!r.success) throw new Error(r.error.issues[0]?.message ?? "invalid");
    hud = r.data;
  } catch (e) {
    throw new Error(`hud.json is not a valid LHM HUD description (${e instanceof Error ? e.message : String(e)})`, { cause: e });
  }
  if (hud.game && hud.game !== "cs2" && hud.game !== "csgo") throw new Error(`this LHM HUD is for ${hud.game}; Matchframe runs CS2 HUDs`);
  const { schema, skipped } = panelSettings(parsePanel(decode(files.get("panel.json"))));
  const extras = [hud.radar ? "minimap" : null, hud.killfeed ? "killfeed" : null].filter(Boolean).join(" and ");
  const thumbnail = ["thumb.png", "thumb.jpg", "thumb.webp", "thumbnail.png"].find((f) => files.has(f)) ?? null;
  const manifest = {
    manifestVersion: 1,
    id: `lhm.${slug(hud.name)}`,
    name: clip(hud.name, 80),
    version: semver(hud.version),
    author: clip(hud.author?.trim() || "Unknown author", 120),
    licence: "As set by the HUD's author",
    description: clip(`LHM-format HUD${extras ? ` with its own ${extras}` : ""}, running in Matchframe's LHM compatibility mode.`, 500),
    game: "cs2",
    schemaVersions: [1],
    entryPoints: { live: "index.html" },
    thumbnail,
    category: "LHM",
    tags: ["lhm", ...(hud.radar ? ["minimap"] : []), ...(hud.killfeed ? ["killfeed"] : [])],
    designResolution: { width: 1920, height: 1080 },
    permissions: ["match.public", "players.public", "radar.public", "utility.public", "series", "event"],
    settingsSchema: schema,
    runtime: "lhm",
  };
  const out = new Map(files);
  out.set("manifest.json", new TextEncoder().encode(JSON.stringify(manifest, null, 2) + "\n"));
  return { files: out, converted: true, skipped };
}

/** Values LHM sends for a "player" or "team" input; Matchframe stores just the id. */
export interface LhmLookup {
  player(steamId: string): Record<string, unknown> | null;
  team(teamId: string): Record<string, unknown> | null;
}

/** The HUD's settings in LHM's hud_config shape: `{ [section]: { [input]: value } }`. */
export function hudConfig(panel: LhmPanel, settings: Record<string, unknown>, lookup: LhmLookup): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const ref of panelSettings(panel).refs) {
    if (ref.type === "action") continue;
    const v = settings[ref.key];
    let value: unknown = v ?? null;
    if (ref.type === "player") value = typeof v === "string" && v ? { type: "player", id: v, player: lookup.player(v) } : null;
    else if (ref.type === "team") value = typeof v === "string" && v ? { type: "team", id: v, team: lookup.team(v) } : null;
    if (value === null && ref.type !== "checkbox") continue;
    (out[ref.section] ??= {})[ref.input] = value ?? false;
  }
  return out;
}

/** Whether `action`/`value` is a button on this panel. */
export function isPanelAction(panel: LhmPanel, key: string, value: string): { section: string; input: string } | null {
  const ref = panelSettings(panel).refs.find((r) => r.key === key && r.type === "action");
  if (!ref) return null;
  const input = panel.find((s) => s.name === ref.section)?.inputs.find((i) => i.name === ref.input);
  return input?.values?.some((v) => v.name === value) ? { section: ref.section, input: ref.input } : null;
}
