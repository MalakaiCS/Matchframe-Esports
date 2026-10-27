import type { Vec3 } from "@matchframe/contracts";

/**
 * Parses a GSI vector string ("x, y, z"). Returns null for anything that is not exactly
 * three finite numbers — a missing or malformed vector must stay unknown, never (0,0,0).
 */
export function parseVec3(value: unknown): Vec3 | null {
  if (typeof value !== "string") return null;
  const parts = value.split(",").map((p) => p.trim());
  if (parts.length !== 3 || parts.some((p) => p === "")) return null;
  const [x, y, z] = parts.map(Number);
  if (x === undefined || y === undefined || z === undefined) return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x, y, z };
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function distance2d(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function length(a: Vec3): number {
  return Math.hypot(a.x, a.y, a.z);
}

export function normalize(a: Vec3): Vec3 | null {
  const l = length(a);
  if (l < 1e-9) return null;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function centroid(points: readonly Vec3[]): Vec3 | null {
  if (points.length === 0) return null;
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
    z += p.z;
  }
  return { x: x / points.length, y: y / points.length, z: z / points.length };
}
