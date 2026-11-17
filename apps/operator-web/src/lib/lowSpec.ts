import type { LowSpecSummary } from "../api/types.ts";
import { useLive } from "../state/live.ts";

/**
 * Low-spec mode (one PC, ADR-078) as the engine's operator snapshot says: on or off, the frame cap,
 * the one-time suggestion and whether background work is waiting. Null before the first snapshot (or
 * from an older engine). While on, the console shows no animated previews or thumbnails.
 */
export function useLowSpec(): LowSpecSummary | null {
  return useLive(selectLowSpec);
}

const selectLowSpec = (s: { snapshot: { performance?: LowSpecSummary } | null }): LowSpecSummary | null => s.snapshot?.performance ?? null;
