import type { Vec3 } from "@matchframe/contracts";

/** Ray-casting point-in-polygon test on the XY plane. */
export function pointInPolygon(x: number, y: number, pts: readonly (readonly [number, number])[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!;
    const [xj, yj] = pts[j]!;
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function cellKey(ix: number, iy: number, iz: number): string {
  return `${ix},${iy},${iz}`;
}

export function cellOf(p: Vec3, cellSize: number, zCellSize: number): [number, number, number] {
  return [Math.floor(p.x / cellSize), Math.floor(p.y / cellSize), Math.floor(p.z / zCellSize)];
}
