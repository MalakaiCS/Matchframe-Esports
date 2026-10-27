import { z } from "zod";

export const HUD_VARIANTS = [
  "live",
  "compact",
  "replay",
  "veto",
  "pre-match",
  "break",
  "post-map",
  "post-series",
  "studio",
] as const;
export const HudVariant = z.enum(HUD_VARIANTS);
export type HudVariant = z.infer<typeof HudVariant>;

/** Data the HUD package may receive. Packages only get the public projection, never operator data. */
export const HudPermission = z.enum([
  "match.public",
  "players.public",
  "radar.public",
  "utility.public",
  "sponsors",
  "series",
  "event",
  "veto.public",
  "annotations",
]);
export type HudPermission = z.infer<typeof HudPermission>;

export const HudManifest = z.object({
  manifestVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9.-]{2,63}$/),
  name: z.string().min(1).max(80),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/),
  author: z.string().min(1).max(120),
  licence: z.string().min(1).max(80),
  description: z.string().max(500).default(""),
  game: z.literal("cs2"),
  /** Supported public HUD state schema versions. */
  schemaVersions: z.array(z.number().int()).min(1),
  /** Entry HTML per implemented variant; packages declare only the variants they implement. */
  entryPoints: z.partialRecord(HudVariant, z.string()).refine((r) => Object.keys(r).length > 0, "at least one entry point is required"),
  preview: z.string().nullable().default(null),
  /** Library card image (package-relative path to a PNG/JPEG/WebP/SVG); falls back to `preview`. */
  thumbnail: z.string().nullable().default(null),
  /** Free-text category shown and filtered in the HUD Library, e.g. "Broadcast" or "Scorebug". */
  category: z.string().max(40).nullable().default(null),
  tags: z.array(z.string().min(1).max(24)).max(12).default([]),
  /** Size the HUD is laid out for; outputs scale it uniformly (letterboxed, never stretched). Defaults to the first of `resolutions`. */
  designResolution: z.object({ width: z.number().int().min(320).max(7680), height: z.number().int().min(180).max(4320) }).nullable().default(null),
  permissions: z.array(HudPermission),
  presets: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
  settingsSchema: z.record(z.string(), z.unknown()).default({}),
  resolutions: z.array(z.enum(["1920x1080", "2560x1440", "3840x2160"])).default(["1920x1080"]),
  classification: z.enum(["builtin", "imported"]).default("imported"),
});
export type HudManifest = z.infer<typeof HudManifest>;

export const OverlayOutput = z.object({
  outputId: z.string(),
  name: z.string(),
  packageId: z.string(),
  variant: HudVariant,
  presetId: z.string().nullable(),
  matchId: z.string().nullable(),
  timelineProfile: z.enum(["live", "delayed"]),
  delayMs: z.number().nonnegative().default(0),
  profile: z.enum(["program", "clean", "caster", "preview"]),
  publishedRevision: z.number().int().nullable(),
});
export type OverlayOutput = z.infer<typeof OverlayOutput>;

/** Package ids that would clash with the overlay server's own paths under /hud/. */
export const RESERVED_HUD_IDS = ["assets", "sdk", "thumbnail.webp", "index.html"] as const;

/** One field of a HUD's settings form (manifest `settingsSchema` values). Unknown shapes are edited as JSON. */
export const HudSettingField = z.object({
  type: z.enum(["boolean", "number", "string", "color", "select"]),
  label: z.string().max(80).optional(),
  description: z.string().max(200).optional(),
  default: z.unknown().optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  group: z.string().max(40).optional(),
});
export type HudSettingField = z.infer<typeof HudSettingField>;

export const HUD_OUTPUT_MODES = ["obs", "desktop", "preview"] as const;
export type HudOutputMode = (typeof HUD_OUTPUT_MODES)[number];

/** A HUD installed in the local library (GET /api/v1/hud/library). */
export interface HudLibraryEntry {
  id: string;
  name: string;
  version: string;
  author: string;
  licence: string;
  description: string;
  category: string | null;
  tags: string[];
  game: "cs2";
  /** builtin: part of the program; sample: bundled sample installed into the library; imported: added by the user. */
  kind: "builtin" | "sample" | "imported";
  /** Absolute URL on the HUD server, or null. */
  thumbnailUrl: string | null;
  variants: HudVariant[];
  designResolution: { width: number; height: number };
  /** Folder on this computer (null for the built-in HUD). */
  folder: string | null;
  installedAt: string;
  lastUsedAt: string | null;
  previousVersion: string | null;
  /** Engine-side status; the manager adds Starting/Running from the desktop overlay. */
  status: "ready" | "running" | "stopped" | "error";
  error: string | null;
  /** The operator stopped this HUD's outputs: OBS sources stay connected but show nothing. */
  stopped: boolean;
  /** Connected runtime outputs by mode. */
  outputs: Record<HudOutputMode, number>;
  /** OBS browser source URL per implemented variant. */
  urls: Partial<Record<HudVariant, string>>;
  settings: Record<string, unknown>;
  settingsSchema: Record<string, HudSettingField>;
  presets: { id: string; name: string }[];
}

export interface HudLibrary {
  huds: HudLibraryEntry[];
  /** Folder that holds the installed HUDs (null in remote mode views). */
  hudsDir: string | null;
  overlayOrigin: string;
  /** Global "hide all HUD graphics" (desktop overlays, previews and OBS sources). */
  hiddenAll: boolean;
}

/** Control messages the HUD server sends to its output wrapper pages on /hud-runtime-ws. */
export interface HudRuntimeControl {
  type: "control";
  hudId: string;
  stopped: boolean;
  hidden: boolean;
  /** Increments when the operator reloads the HUD or installs a new version: wrappers reload the HUD frame. */
  reloadSeq: number;
  designResolution: { width: number; height: number };
}
