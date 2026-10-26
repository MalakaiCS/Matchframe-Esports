import type { MapPhase } from "@matchframe/contracts";

export interface EpochSignals {
  mapName: string | null;
  roundNumber: number | null;
  mapPhase: MapPhase;
  providerSteamId: string | null;
  scoreCT: number | null;
  scoreT: number | null;
  receivedAtMonotonicMs: number;
}

export type EpochChangeReason =
  | "first_packet"
  | "map_change"
  | "round_regression"
  | "score_regression"
  | "provider_change"
  | "phase_restart"
  | "reconnect_discontinuity";

/**
 * Detects timeline discontinuities: map change, round restore/restart, demo seek backwards,
 * score regression, observer client change, and reconnects that skip state. Every detected
 * discontinuity starts a new epoch, and pending actions from older epochs must be rejected.
 */
export function detectEpochChange(prev: EpochSignals | null, next: EpochSignals, reconnectGapMs = 10000): EpochChangeReason | null {
  if (!prev) return "first_packet";
  if (prev.mapName !== null && next.mapName !== null && prev.mapName !== next.mapName) return "map_change";
  if (prev.providerSteamId !== null && next.providerSteamId !== null && prev.providerSteamId !== next.providerSteamId) {
    return "provider_change";
  }
  if (prev.roundNumber !== null && next.roundNumber !== null && next.roundNumber < prev.roundNumber) return "round_regression";
  if (
    (prev.scoreCT !== null && next.scoreCT !== null && next.scoreCT < prev.scoreCT) ||
    (prev.scoreT !== null && next.scoreT !== null && next.scoreT < prev.scoreT)
  ) {
    // Scores swap sides at halftime: CT/T totals exchanged is not a regression.
    const swapped = prev.scoreCT === next.scoreT && prev.scoreT === next.scoreCT;
    if (!swapped) return "score_regression";
  }
  if ((prev.mapPhase === "live" || prev.mapPhase === "gameover") && next.mapPhase === "warmup") return "phase_restart";
  const gap = next.receivedAtMonotonicMs - prev.receivedAtMonotonicMs;
  if (gap > reconnectGapMs && prev.roundNumber !== null && next.roundNumber !== null && next.roundNumber > prev.roundNumber + 1) {
    return "reconnect_discontinuity";
  }
  return null;
}
