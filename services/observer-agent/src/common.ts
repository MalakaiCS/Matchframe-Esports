import type { Capability } from "@matchframe/contracts";
import type { ControlCapabilities } from "@matchframe/director-policy";

export function cap(key: string, support: Capability["support"], limitations: string[], sourceId: string | null, evidence?: { build: string | null; at: string | null }): Capability {
  return {
    key,
    support,
    sourceId,
    testedGameBuild: evidence?.build ?? null,
    lastVerifiedAt: evidence?.at ?? null,
    limitations,
    precision: null,
  };
}

export function noControl(reason: string, sourceId: string | null = null): ControlCapabilities {
  return {
    playerSelectionControl: cap("playerSelectionControl", "unsupported", [reason], sourceId),
    observerModeControl: cap("observerModeControl", "unsupported", [reason], sourceId),
    staticCameraControl: cap("staticCameraControl", "unsupported", [reason], sourceId),
    cameraPathControl: cap("cameraPathControl", "unsupported", [reason], sourceId),
    cameraReadback: cap("cameraReadback", "unsupported", [reason], sourceId),
  };
}

/** SteamID64 → 32-bit account id (string math via BigInt; never floating point). */
export function accountIdOf(steamId64: string): string {
  return (BigInt(steamId64) - 76561197960265728n).toString();
}
