import { z } from "zod";
import { Vec3 } from "./common.ts";
import { GrenadeType, Support } from "./capabilities.ts";

/** World → radar image transform. Values must come from game overview files or calibration, never guessed. */
export const RadarCalibration = z.object({
  /** World X at radar image left edge. */
  posX: z.number(),
  /** World Y at radar image top edge. */
  posY: z.number(),
  /** World units per radar pixel. */
  scale: z.number().positive(),
  rotationDeg: z.number().default(0),
  imageSizePx: z.number().int().positive().default(1024),
  source: z.enum(["game_overview_file", "operator_calibration", "recalled_unverified"]),
  verified: z.boolean(),
  notes: z.string().nullable().default(null),
});
export type RadarCalibration = z.infer<typeof RadarCalibration>;

/** Vertical level band (e.g. Nuke upper/lower). */
export const MapLevel = z.object({
  id: z.string(),
  name: z.string(),
  zMin: z.number(),
  zMax: z.number(),
  /** Optional radar override for multi-level overviews. */
  radar: RadarCalibration.nullable().default(null),
});
export type MapLevel = z.infer<typeof MapLevel>;

export const RegionKind = z.enum([
  "bombsite",
  "entrance",
  "choke",
  "corridor",
  "mid",
  "connector",
  "spawn",
  "rotation",
  "retake_route",
  "elevated",
  "open_area",
  "other",
]);
export type RegionKind = z.infer<typeof RegionKind>;

export const RegionShape = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("polygon"),
    /** World XY polygon vertices. */
    points: z.array(z.tuple([z.number(), z.number()])).min(3),
    zMin: z.number(),
    zMax: z.number(),
  }),
  z.object({
    kind: z.literal("cells"),
    /** Voxel cell size in world units. */
    cellSize: z.number().positive(),
    zCellSize: z.number().positive(),
    /** Cell indices [ix, iy, iz]; built from real positional samples (e.g. demo place names). */
    cells: z.array(z.tuple([z.number().int(), z.number().int(), z.number().int()])),
  }),
]);
export type RegionShape = z.infer<typeof RegionShape>;

export const Region = z.object({
  id: z.string(),
  name: z.string(),
  kind: RegionKind,
  levelId: z.string().nullable(),
  shapes: z.array(RegionShape),
  /** Where the geometry came from. */
  source: z.enum(["demo_place_names", "authored", "imported"]),
  sampleCount: z.number().int().nullable().default(null),
  validated: z.boolean(),
  tags: z.array(z.string()).default([]),
});
export type Region = z.infer<typeof Region>;

export const CameraValidation = z.enum(["unvalidated", "preview_only", "validated", "invalidated"]);
export type CameraValidation = z.infer<typeof CameraValidation>;

/** Static camera record (spec §12.4). Coordinates must be captured in-game, never invented. */
export const CameraRecord = z.object({
  id: z.string(),
  displayName: z.string(),
  mapName: z.string(),
  mapRevision: z.string(),
  position: Vec3,
  pitch: z.number(),
  yaw: z.number(),
  fov: z.number().nullable(),
  observerMode: z.enum(["roaming_static"]),
  targetRegionIds: z.array(z.string()),
  /** World-space coverage volume for matching action regions anywhere on the map. */
  coverage: z.object({
    center: Vec3,
    radiusUnits: z.number().positive(),
    zMin: z.number(),
    zMax: z.number(),
    levelId: z.string().nullable(),
  }),
  allowedPhases: z.array(z.enum(["freezetime", "live", "over"])),
  actionClasses: z.array(z.enum(["utility", "tactical", "bomb", "establishing"])),
  grenadeTypes: z.array(GrenadeType),
  minAcquisitionMs: z.number().nonnegative(),
  normalDurationMs: z.number().positive(),
  maxDurationMs: z.number().positive(),
  occlusionValidation: CameraValidation,
  validation: CameraValidation,
  exitStrategy: z.enum(["most_relevant_player", "previous_pov", "closest_alive_to_region"]),
  lastTestedGameBuild: z.string().nullable(),
  lastTestedMapVersion: z.string().nullable(),
  capturedFrom: z.enum(["getpos_paste", "netcon_readback", "imported"]),
  notes: z.string().nullable().default(null),
});
export type CameraRecord = z.infer<typeof CameraRecord>;

export const CameraPathKeyframe = z.object({
  tMs: z.number().nonnegative(),
  position: Vec3,
  pitch: z.number(),
  yaw: z.number(),
});

export const CameraPath = z.object({
  id: z.string(),
  displayName: z.string(),
  mapName: z.string(),
  mapRevision: z.string(),
  keyframes: z.array(CameraPathKeyframe).min(2),
  maxDurationMs: z.number().positive(),
  maxSpeedUnitsPerSec: z.number().positive(),
  collisionValidated: z.boolean(),
  validation: CameraValidation,
  targetRegionIds: z.array(z.string()),
});
export type CameraPath = z.infer<typeof CameraPath>;

export const UtilityCoverageCell = z.object({
  grenadeType: GrenadeType,
  telemetry: Support,
  activationEffect: Support,
  prediction: z.enum(["calibrated", "uncalibrated", "unavailable"]),
  testedRegions: z.array(z.string()),
  cameraCoverage: z.enum(["validated", "unvalidated", "none"]),
  fallback: z.string(),
  evidence: z.array(z.string()),
});
export type UtilityCoverageCell = z.infer<typeof UtilityCoverageCell>;

export const MapPack = z.object({
  schemaVersion: z.literal(1),
  mapName: z.string(),
  displayName: z.string(),
  mapRevision: z.string(),
  radar: RadarCalibration.nullable(),
  levels: z.array(MapLevel),
  regions: z.array(Region),
  cameras: z.array(CameraRecord),
  paths: z.array(CameraPath),
  bombsites: z
    .array(z.object({ site: z.enum(["A", "B"]), regionId: z.string() }))
    .default([]),
  /** Per-map utility scenario overrides (e.g. Inferno Bottom Banana). */
  scenarios: z.array(z.record(z.string(), z.unknown())).default([]),
  coverage: z.array(UtilityCoverageCell).default([]),
  provenance: z.object({
    createdBy: z.string(),
    createdAt: z.string(),
    sources: z.array(z.string()),
  }),
});
export type MapPack = z.infer<typeof MapPack>;
