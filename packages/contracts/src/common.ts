import { z } from "zod";

/** Schema version of the public contracts. Increment on breaking changes. */
export const CONTRACTS_SCHEMA_VERSION = 1;

/**
 * SteamID64 is always a decimal string. It must never be converted to a JS number:
 * 17-digit values exceed Number.MAX_SAFE_INTEGER and lose precision.
 * Bots and some test sources use short or zero IDs, so length is not fixed at 17.
 */
export const SteamId64 = z.string().regex(/^\d{1,20}$/, "SteamID64 must be a decimal string");
export type SteamId64 = z.infer<typeof SteamId64>;

/** Stable internal identifier (UUID-like or slug). */
export const EntityId = z.string().min(1).max(128);
export type EntityId = z.infer<typeof EntityId>;

export const Vec3 = z.object({ x: z.number(), y: z.number(), z: z.number() });
export type Vec3 = z.infer<typeof Vec3>;

export const Side = z.enum(["CT", "T"]);
export type Side = z.infer<typeof Side>;

/**
 * How a value came to be known. "measured" = taken directly from a source field;
 * "derived" = computed deterministically from measured fields (e.g. kill count delta);
 * "estimated" = model / heuristic output; "operator" = manual correction;
 * "unknown" = no supporting evidence.
 */
export const EvidenceType = z.enum(["measured", "derived", "estimated", "operator", "unknown"]);
export type EvidenceType = z.infer<typeof EvidenceType>;

export const Provenance = z.object({
  sourceId: z.string().nullable(),
  evidence: EvidenceType,
  /** Monotonic ingest time (ms) at which the supporting observation arrived. */
  observedAtMonotonicMs: z.number().nullable(),
  confidence: z.number().min(0).max(1),
});
export type Provenance = z.infer<typeof Provenance>;

export const IsoDateTime = z.string().datetime({ offset: true });
