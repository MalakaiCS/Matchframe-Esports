import type { PlayerState, Vec3 } from "@matchframe/contracts";

export interface ReadinessResult {
  score: number;
  /** Fraction of readiness inputs that were actually available (0..1). */
  coverage: number;
  missing: string[];
  flags: { flashed: boolean; reloading: boolean; lowAmmo: boolean; utilityInHand: boolean };
}

const PRIMARY_TYPES = new Set(["Rifle", "SniperRifle", "Submachine Gun", "Machine Gun", "Shotgun"]);

function weaponReadiness(p: PlayerState): number | null {
  const w = p.activeWeapon;
  if (!w) return null;
  if (w.state === "reloading") return 0.25;
  const type = w.type ?? "";
  let base = PRIMARY_TYPES.has(type) ? 1 : type === "Pistol" ? 0.75 : type === "Knife" ? 0.25 : type === "Grenade" || type === "C4" ? 0.35 : 0.6;
  if (w.ammoClip !== null && w.ammoClipMax !== null && w.ammoClipMax > 0) {
    const frac = w.ammoClip / w.ammoClipMax;
    if (w.ammoClip === 0) base *= 0.2;
    else if (frac < 0.25) base *= 0.7;
  }
  return base;
}

/**
 * Readiness of a player to take or show a fight, from available evidence only.
 * Missing inputs use a neutral prior (0.5) — never perfect readiness — and lower coverage.
 * A flashed player is penalized but not excluded: recovery and narrative can still make them
 * the right shot.
 */
export function playerReadiness(p: PlayerState, threatDirection: Vec3 | null): ReadinessResult {
  const missing: string[] = [];
  const parts: number[] = [];
  let available = 0;
  const total = 4;

  if (p.lifeState !== "alive") {
    return { score: 0, coverage: 1, missing: [], flags: { flashed: false, reloading: false, lowAmmo: false, utilityInHand: false } };
  }

  const wr = weaponReadiness(p);
  if (wr === null) {
    missing.push("weapon");
    parts.push(0.5);
  } else {
    parts.push(wr);
    available++;
  }

  if (p.flashed === null) {
    missing.push("flash");
    parts.push(0.5);
  } else {
    parts.push(1 - 0.85 * p.flashed);
    available++;
  }

  if (p.health === null) {
    missing.push("health");
    parts.push(0.5);
  } else {
    parts.push(0.4 + 0.6 * Math.min(1, p.health / 100));
    available++;
  }

  if (!threatDirection || !p.forward) {
    missing.push("facing");
    parts.push(0.5);
  } else {
    const len = Math.hypot(threatDirection.x, threatDirection.y) || 1;
    const fl = Math.hypot(p.forward.x, p.forward.y) || 1;
    const cos = (threatDirection.x * p.forward.x + threatDirection.y * p.forward.y) / (len * fl);
    parts.push(0.35 + 0.65 * Math.max(0, cos));
    available++;
  }

  const score = parts.reduce((a, b) => a + b, 0) / parts.length;
  const w = p.activeWeapon;
  return {
    score,
    coverage: available / total,
    missing,
    flags: {
      flashed: (p.flashed ?? 0) > 0.5,
      reloading: w?.state === "reloading",
      lowAmmo: !!w && w.ammoClip !== null && w.ammoClipMax !== null && w.ammoClipMax > 0 && w.ammoClip / w.ammoClipMax < 0.25,
      utilityInHand: w?.type === "Grenade",
    },
  };
}
