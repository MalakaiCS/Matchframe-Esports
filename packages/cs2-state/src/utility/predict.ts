import type { UtilityPrediction, Vec3 } from "@matchframe/contracts";
import type { UtilityTypeProfile } from "./profiles.ts";

export const PREDICTOR_VERSION = "ballistic-floor-0.1";

/**
 * Effective grenade gravity in world units/s². Default assumes sv_gravity 800 × 0.4; marked as
 * an unmeasured default — the demo pipeline fits it from parsed projectile tracks.
 */
export interface BallisticParams {
  gravity: number;
  source: "default_unmeasured" | "measured_from_demos";
}

export const DEFAULT_BALLISTICS: BallisticParams = { gravity: 320, source: "default_unmeasured" };

export interface PredictionInput {
  position: Vec3;
  velocity: Vec3 | null;
  /** Seconds since the projectile was created, if supplied by the source. */
  lifetimeSec: number | null;
  nowMonotonicMs: number;
  profile: UtilityTypeProfile;
  /** Floor height estimate under a point (from map pack sample geometry), or null if unknown. */
  floorZAt?: ((p: Vec3) => number | null) | undefined;
  /** True if the map pack has calibrated prediction data for this map/type. */
  calibrated: boolean;
  ballistics?: BallisticParams;
}

function at(p: Vec3, v: Vec3, g: number, t: number): Vec3 {
  return { x: p.x + v.x * t, y: p.y + v.y * t, z: p.z + v.z * t - 0.5 * g * t * t };
}

/**
 * Short-horizon activation estimate. This is NOT a reproduction of game collisions: bounces and
 * wall impacts are ignored, so uncertainty grows quickly with horizon. Without floor geometry
 * an at-rest/impact estimate cannot be made and the function returns null.
 */
export function predictActivation(input: PredictionInput): UtilityPrediction | null {
  const { position, velocity, profile } = input;
  if (!velocity) return null;
  const g = (input.ballistics ?? DEFAULT_BALLISTICS).gravity;
  const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
  const baseUncertainty = input.calibrated ? 40 : 120;

  if (profile.activation === "fuse" && profile.fuse) {
    if (input.lifetimeSec === null) return null;
    const remainingMs = Math.max(0, profile.fuse.meanMs - input.lifetimeSec * 1000);
    const t = remainingMs / 1000;
    let pos = at(position, velocity, g, t);
    const floor = input.floorZAt?.(pos) ?? null;
    if (floor !== null && pos.z < floor) pos = { ...pos, z: floor };
    return {
      activationPosition: pos,
      activationInMs: remainingMs,
      positionUncertaintyUnits: baseUncertainty + speed * t * 0.35 + (profile.fuse.sdMs / 1000) * speed,
      timeUncertaintyMs: profile.fuse.sdMs,
      predictorVersion: PREDICTOR_VERSION,
      computedAtMonotonicMs: input.nowMonotonicMs,
      tier: input.calibrated ? "A" : "B",
    };
  }

  // at_rest / impact: need the first floor contact. Step the arc and stop at the floor.
  if (!input.floorZAt) return null;
  const maxT = profile.activation === "impact_or_fuse" && profile.fuse ? profile.fuse.meanMs / 1000 : 4;
  const dt = 0.02;
  for (let t = dt; t <= maxT + 1e-9; t += dt) {
    const p = at(position, velocity, g, t);
    const floor = input.floorZAt(p);
    if (floor !== null && p.z <= floor && velocity.z - g * t < 0) {
      const pos = { ...p, z: floor };
      // at_rest types keep rolling/bouncing after first contact: widen the estimate.
      const restPenalty = profile.activation === "at_rest" ? 1.8 : 1;
      return {
        activationPosition: pos,
        activationInMs: profile.activation === "at_rest" ? t * 1000 + 600 : t * 1000,
        positionUncertaintyUnits: (baseUncertainty + speed * t * 0.3) * restPenalty,
        timeUncertaintyMs: profile.activation === "at_rest" ? 900 : 250,
        predictorVersion: PREDICTOR_VERSION,
        computedAtMonotonicMs: input.nowMonotonicMs,
        tier: input.calibrated ? "A" : "B",
      };
    }
  }
  if (profile.activation === "impact_or_fuse" && profile.fuse && input.lifetimeSec !== null) {
    const remainingMs = Math.max(0, profile.fuse.meanMs - input.lifetimeSec * 1000);
    return {
      activationPosition: at(position, velocity, g, remainingMs / 1000),
      activationInMs: remainingMs,
      positionUncertaintyUnits: baseUncertainty + speed * (remainingMs / 1000) * 0.4,
      timeUncertaintyMs: profile.fuse.sdMs,
      predictorVersion: PREDICTOR_VERSION,
      computedAtMonotonicMs: input.nowMonotonicMs,
      tier: input.calibrated ? "A" : "B",
    };
  }
  return null;
}
