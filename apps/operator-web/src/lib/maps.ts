import type { CoverageRow, MapSummary } from "../api/types.ts";
import { useApi } from "./hooks.ts";

/** Map name suggestions from the requested map targets (coverage endpoint) plus loaded map packs. */
export function useMapSuggestions(): string[] {
  const cov = useApi<CoverageRow[]>("/api/v1/coverage/maps");
  const maps = useApi<MapSummary[]>("/api/v1/maps");
  return [...new Set([...(cov.data ?? []).map((r) => r.mapName), ...(maps.data ?? []).filter((m) => !m.synthetic).map((m) => m.mapName)])];
}
