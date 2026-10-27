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
