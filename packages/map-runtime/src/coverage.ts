import type { GrenadeType, SourceCapabilities, Support, UtilityCoverageCell } from "@matchframe/contracts";
import { GRENADE_TYPES } from "@matchframe/contracts";
import type { MapRuntime } from "./runtime.ts";

export interface MapCoverageRow {
  mapName: string;
  mapPackPresent: boolean;
  regionCount: number;
  regionSource: string;
  floorGrid: boolean;
  radarCalibration: "verified" | "unverified" | "none";
  validatedCameras: number;
  unvalidatedCameras: number;
  cells: UtilityCoverageCell[];
}

/**
 * Builds the map × grenade-type × capability matrix. Telemetry support comes from the live source
 * capability report; camera coverage from validated cameras only. Nothing is upgraded by default.
 */
export function buildCoverageRow(mapName: string, runtime: MapRuntime | undefined, caps: SourceCapabilities | null): MapCoverageRow {
  const pack = runtime?.pack;
  const validated = pack?.cameras.filter((c) => c.validation === "validated") ?? [];
  const cells: UtilityCoverageCell[] = GRENADE_TYPES.map((t: GrenadeType) => {
    const telemetry: Support = caps ? caps.grenadeTypeSupport[t].support : "unverified";
    const effect: Support = caps ? (caps.utilityEffects.support === "unverified" ? "unverified" : caps.utilityEffects.support) : "unverified";
    const typeCams = validated.filter((c) => c.grenadeTypes.length === 0 || c.grenadeTypes.includes(t));
    const declared = pack?.coverage.find((c) => c.grenadeType === t);
    return {
      grenadeType: t,
      telemetry,
      activationEffect: effect,
      prediction: declared?.prediction ?? (pack?.floorGrid ? "uncalibrated" : "unavailable"),
      testedRegions: declared?.testedRegions ?? [],
      cameraCoverage: typeCams.length > 0 ? "validated" : (pack?.cameras.length ?? 0) > 0 ? "unvalidated" : "none",
      fallback: typeCams.length > 0 ? "validated static camera, else POV/radar/hold" : "POV of most relevant player, radar, or hold current shot",
      evidence: declared?.evidence ?? [],
    };
  });
  return {
    mapName,
    mapPackPresent: !!pack,
    regionCount: pack?.regions.length ?? 0,
    regionSource: pack ? [...new Set(pack.regions.map((r) => r.source))].join(", ") || "none" : "none",
    floorGrid: !!pack?.floorGrid,
    radarCalibration: pack?.radar ? (pack.radar.verified ? "verified" : "unverified") : "none",
    validatedCameras: validated.length,
    unvalidatedCameras: (pack?.cameras.length ?? 0) - validated.length,
    cells,
  };
}
