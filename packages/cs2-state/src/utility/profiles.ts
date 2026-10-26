import type { GrenadeType, ObservedGrenadeType } from "@matchframe/contracts";

export interface Distribution {
  meanMs: number;
  sdMs: number;
}

/**
 * Per-type lifecycle profile. Every type has its own profile — no shared detonation timer,
 * bounce model or effect radius is assumed (spec §13.2). The defaults below are initial
 * engineering values marked `default_unmeasured`; the demo pipeline measures replacements
 * (fuse, effect duration) from parsed demos and writes `measured_from_demos` profiles.
 */
export interface UtilityTypeProfile {
  type: GrenadeType;
  activation: "fuse" | "at_rest" | "impact_or_fuse";
  /** Time from throw to activation for fuse-based types. */
  fuse: Distribution | null;
  /** Duration of the persistent effect after activation; null for instantaneous effects. */
  effectDuration: Distribution | null;
  /** Nominal effect radius in world units, if meaningful for presentation. */
  effectRadiusUnits: number | null;
  /** Default editorial priority weight 0..1 (decoys are low by default). */
  editorialWeight: number;
  source: "default_unmeasured" | "measured_from_demos";
  sampleCount: number;
  measuredOn: string | null;
}

export const DEFAULT_PROFILES: Record<GrenadeType, UtilityTypeProfile> = {
  he: {
    type: "he",
    activation: "fuse",
    fuse: { meanMs: 1600, sdMs: 250 },
    effectDuration: null,
    effectRadiusUnits: 350,
    editorialWeight: 0.8,
    source: "default_unmeasured",
    sampleCount: 0,
    measuredOn: null,
  },
  flashbang: {
    type: "flashbang",
    activation: "fuse",
    fuse: { meanMs: 1600, sdMs: 250 },
    effectDuration: null,
    effectRadiusUnits: null,
    editorialWeight: 0.7,
    source: "default_unmeasured",
    sampleCount: 0,
    measuredOn: null,
  },
  smoke: {
    type: "smoke",
    activation: "at_rest",
    fuse: null,
    effectDuration: { meanMs: 20000, sdMs: 1500 },
    effectRadiusUnits: 144,
    editorialWeight: 0.5,
    source: "default_unmeasured",
    sampleCount: 0,
    measuredOn: null,
  },
  molotov: {
    type: "molotov",
    activation: "impact_or_fuse",
    fuse: { meanMs: 2000, sdMs: 300 },
    effectDuration: { meanMs: 7000, sdMs: 800 },
    effectRadiusUnits: 150,
    editorialWeight: 0.65,
    source: "default_unmeasured",
    sampleCount: 0,
    measuredOn: null,
  },
  incendiary: {
    type: "incendiary",
    activation: "impact_or_fuse",
    fuse: { meanMs: 2000, sdMs: 300 },
    effectDuration: { meanMs: 7000, sdMs: 800 },
    effectRadiusUnits: 150,
    editorialWeight: 0.65,
    source: "default_unmeasured",
    sampleCount: 0,
    measuredOn: null,
  },
  decoy: {
    type: "decoy",
    activation: "at_rest",
    fuse: null,
    effectDuration: { meanMs: 15000, sdMs: 1500 },
    effectRadiusUnits: null,
    editorialWeight: 0.1,
    source: "default_unmeasured",
    sampleCount: 0,
    measuredOn: null,
  },
};

export type ProfileSet = Record<GrenadeType, UtilityTypeProfile>;

/** Merge measured profiles over defaults; never drop a type. */
export function mergeProfiles(measured: Partial<ProfileSet>): ProfileSet {
  return { ...DEFAULT_PROFILES, ...measured };
}

/** Inventory weapon names for each grenade type (CS2 item class names). */
export const GRENADE_WEAPON_NAMES: Record<GrenadeType, string> = {
  he: "weapon_hegrenade",
  flashbang: "weapon_flashbang",
  smoke: "weapon_smokegrenade",
  molotov: "weapon_molotov",
  incendiary: "weapon_incgrenade",
  decoy: "weapon_decoy",
};

export interface RawTypeResolution {
  type: ObservedGrenadeType;
  /** true when this raw entity is the persistent fire area rather than a projectile. */
  isFireArea: boolean;
  confidence: number;
  evidence: string;
}

/**
 * Maps a raw source type string to a normalized grenade type.
 * GSI: "frag", "flashbang", "smoke", "decoy", "firebomb" (molotov OR incendiary projectile),
 * "inferno" (fire area). Parser/entity class names (CHEGrenadeProjectile, CMolotovProjectile...)
 * are also accepted. Unrecognized strings map to "unknown" and are preserved, not guessed.
 */
export function resolveRawType(raw: string): RawTypeResolution {
  const r = raw.toLowerCase();
  switch (r) {
    case "frag":
    case "hegrenade":
    case "he":
    case "chegrenadeprojectile":
    case "weapon_hegrenade":
      return { type: "he", isFireArea: false, confidence: 0.95, evidence: `raw type "${raw}"` };
    case "flashbang":
    case "cflashbangprojectile":
    case "weapon_flashbang":
      return { type: "flashbang", isFireArea: false, confidence: 0.95, evidence: `raw type "${raw}"` };
    case "smoke":
    case "smokegrenade":
    case "csmokegrenadeprojectile":
    case "weapon_smokegrenade":
      return { type: "smoke", isFireArea: false, confidence: 0.95, evidence: `raw type "${raw}"` };
    case "decoy":
    case "cdecoyprojectile":
    case "weapon_decoy":
      return { type: "decoy", isFireArea: false, confidence: 0.95, evidence: `raw type "${raw}"` };
    case "molotov":
    case "weapon_molotov":
      return { type: "molotov", isFireArea: false, confidence: 0.95, evidence: `raw type "${raw}"` };
    case "incgrenade":
    case "incendiary":
    case "weapon_incgrenade":
      return { type: "incendiary", isFireArea: false, confidence: 0.95, evidence: `raw type "${raw}"` };
    case "firebomb":
    case "cmolotovprojectile":
      return {
        type: "fire_unknown",
        isFireArea: false,
        confidence: 0.5,
        evidence: `raw type "${raw}" does not distinguish molotov from incendiary`,
      };
    case "inferno":
    case "cinferno":
      return { type: "fire_unknown", isFireArea: true, confidence: 0.5, evidence: `fire area "${raw}"` };
    case "cbasecsgrenadeprojectile":
      return {
        type: "unknown",
        isFireArea: false,
        confidence: 0.3,
        evidence: `raw class "${raw}" is shared by HE and flashbang in some builds`,
      };
    default:
      return { type: "unknown", isFireArea: false, confidence: 0.1, evidence: `unrecognized raw type "${raw}"` };
  }
}
