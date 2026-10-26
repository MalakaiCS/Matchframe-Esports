import { z } from "zod";

export const Support = z.enum(["supported", "partial", "unsupported", "unverified"]);
export type Support = z.infer<typeof Support>;

export const Capability = z.object({
  key: z.string(),
  support: Support,
  sourceId: z.string().nullable(),
  testedGameBuild: z.string().nullable(),
  lastVerifiedAt: z.string().nullable(),
  limitations: z.array(z.string()),
  /** Optional free-form precision description, e.g. "GSI ~10 Hz, 1 decimal unit". */
  precision: z.string().nullable().optional(),
});
export type Capability = z.infer<typeof Capability>;

export const GRENADE_TYPES = ["he", "flashbang", "smoke", "molotov", "incendiary", "decoy"] as const;
export const GrenadeType = z.enum(GRENADE_TYPES);
export type GrenadeType = z.infer<typeof GrenadeType>;

/** Grenade type as normalized, including an explicit unknown/future fallback. */
export const ObservedGrenadeType = z.enum([...GRENADE_TYPES, "fire_unknown", "unknown"]);
export type ObservedGrenadeType = z.infer<typeof ObservedGrenadeType>;

export const SOURCE_CAPABILITY_KEYS = [
  "allPlayerState",
  "playerPositions",
  "viewDirections",
  "weaponReadiness",
  "exactDamageEvents",
  "exactKillEvents",
  "grenadeEntities",
  "grenadeLifecycle",
  "utilityEffects",
  "grenadeDamageAttribution",
  "playerSelectionControl",
  "observerModeControl",
  "staticCameraControl",
  "cameraPathControl",
  "cameraReadback",
  "matchTimelineTime",
] as const;
export type SourceCapabilityKey = (typeof SOURCE_CAPABILITY_KEYS)[number];

export const SourceCapabilities = z.object({
  allPlayerState: Capability,
  playerPositions: Capability,
  viewDirections: Capability,
  weaponReadiness: Capability,
  exactDamageEvents: Capability,
  exactKillEvents: Capability,
  grenadeEntities: Capability,
  grenadeLifecycle: Capability,
  utilityEffects: Capability,
  grenadeTypeSupport: z.object({
    he: Capability,
    flashbang: Capability,
    smoke: Capability,
    molotov: Capability,
    incendiary: Capability,
    decoy: Capability,
  }),
  grenadeDamageAttribution: Capability,
  playerSelectionControl: Capability,
  observerModeControl: Capability,
  staticCameraControl: Capability,
  cameraPathControl: Capability,
  cameraReadback: Capability,
  matchTimelineTime: Capability,
});
export type SourceCapabilities = z.infer<typeof SourceCapabilities>;

export function unverifiedCapability(key: string, limitations: string[] = []): Capability {
  return {
    key,
    support: "unverified",
    sourceId: null,
    testedGameBuild: null,
    lastVerifiedAt: null,
    limitations,
    precision: null,
  };
}

export function unsupportedCapability(key: string, reason: string): Capability {
  return {
    key,
    support: "unsupported",
    sourceId: null,
    testedGameBuild: null,
    lastVerifiedAt: null,
    limitations: [reason],
    precision: null,
  };
}

/** A fully "unverified" capability set — the honest starting point before any real source is sampled. */
export function emptySourceCapabilities(): SourceCapabilities {
  const u = unverifiedCapability;
  return {
    allPlayerState: u("allPlayerState"),
    playerPositions: u("playerPositions"),
    viewDirections: u("viewDirections"),
    weaponReadiness: u("weaponReadiness"),
    exactDamageEvents: u("exactDamageEvents"),
    exactKillEvents: u("exactKillEvents"),
    grenadeEntities: u("grenadeEntities"),
    grenadeLifecycle: u("grenadeLifecycle"),
    utilityEffects: u("utilityEffects"),
    grenadeTypeSupport: {
      he: u("grenadeTypeSupport.he"),
      flashbang: u("grenadeTypeSupport.flashbang"),
      smoke: u("grenadeTypeSupport.smoke"),
      molotov: u("grenadeTypeSupport.molotov"),
      incendiary: u("grenadeTypeSupport.incendiary"),
      decoy: u("grenadeTypeSupport.decoy"),
    },
    grenadeDamageAttribution: u("grenadeDamageAttribution"),
    playerSelectionControl: u("playerSelectionControl"),
    observerModeControl: u("observerModeControl"),
    staticCameraControl: u("staticCameraControl"),
    cameraPathControl: u("cameraPathControl"),
    cameraReadback: u("cameraReadback"),
    matchTimelineTime: u("matchTimelineTime"),
  };
}
