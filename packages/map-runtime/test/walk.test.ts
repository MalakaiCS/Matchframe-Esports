import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { Vec3 } from "@matchframe/contracts";
import { VisibilityGrid, WalkGraph, walkGraphFor } from "../src/index.ts";

const root = join(import.meta.dirname, "..", "..", "..");
const load = (m: string) => VisibilityGrid.parse(readFileSync(join(root, "assets", "map-packs", `${m}.grid`)), (b) => inflateSync(b));

/** A 12-unit grid of nx × ny × 20 cells over a flat floor (the bottom layer solid: floor at z 12), with `solid` cells added. */
function flat(nx: number, ny: number, solid: (x: number, y: number, z: number) => boolean = () => false): VisibilityGrid {
  const nz = 20;
  const bits = new Uint8Array(Math.ceil((nx * ny * nz) / 8));
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        if (z !== 0 && !solid(x, y, z)) continue;
        const i = (z * ny + y) * nx + x;
        bits[i >> 3]! |= 1 << (i & 7);
      }
  return new VisibilityGrid({ map: "test", build: "test", cell: 12, origin: [0, 0, 0], dims: [nx, ny, nz] }, bits);
}
const at = (x: number, y: number, z = 12): Vec3 => ({ x, y, z });

describe("walking distance on a free-space grid", () => {
  it("is about the straight line on open floor", () => {
    const w = WalkGraph.build(flat(100, 100));
    const d = w.distance(at(100, 100), at(1000, 700))!;
    const straight = Math.hypot(900, 600);
    expect(d).toBeGreaterThanOrEqual(straight - 30);
    // Eight directions between 24-unit columns: at most ~8 % longer than the straight line.
    expect(d).toBeLessThan(straight * 1.09);
  });

  it("goes round a wall through its gap, and not at all through a closed one", () => {
    // A wall 120 units high along x = 600 (cells 50), with a gap at y 1000–1100.
    const gap = WalkGraph.build(flat(100, 100, (x, y, z) => x === 50 && z <= 10 && !(y >= 84 && y <= 91)));
    const a = at(500, 300);
    const b = at(700, 300);
    const d = gap.distance(a, b)!;
    // Up to the gap and back down the other side: about 2 × 760 units, against 200 in a straight line.
    expect(d).toBeGreaterThan(1450);
    expect(d).toBeLessThan(1750);
    const closed = WalkGraph.build(flat(100, 100, (x, _y, z) => x === 50 && z <= 10));
    expect(closed.distance(a, b)).toBe(Infinity);
    expect(closed.distance(a, b, 300)).toBe(Infinity);
  });

  it("climbs a step a player can jump, not a higher one, and drops down one way", () => {
    // A block 48 units high (cells 1–4) and one 96 units high (cells 1–8), both 240 units wide.
    const low = WalkGraph.build(flat(60, 60, (x, y, z) => x >= 20 && x < 40 && y >= 20 && y < 40 && z <= 4));
    expect(low.distance(at(100, 360), at(360, 360, 60))).not.toBe(Infinity);
    const high = WalkGraph.build(flat(60, 60, (x, y, z) => x >= 20 && x < 40 && y >= 20 && y < 40 && z <= 8));
    const top = at(360, 360, 108);
    expect(high.distance(at(100, 360), top)).toBe(Infinity);
    // Down from it is a drop: walked.
    expect(high.distance(top, at(100, 360))).toBeLessThan(400);
  });

  it("answers null for a position it can't place, and many at once from one search", () => {
    const w = WalkGraph.build(flat(60, 60));
    expect(w.distance(at(100, 100, 400), at(300, 300))).toBeNull();
    const many = w.distancesTo(at(300, 300), [at(100, 300), at(300, 500), at(300, 300)]);
    expect(many[0]).toBeCloseTo(200, -1);
    expect(many[1]).toBeCloseTo(200, -1);
    expect(many[2]!).toBeLessThan(30);
  });
});

describe("walking distance on CS2's maps", () => {
  /** Where pro players stood at the end of freeze time (the framing tests' demo spawns). */
  const SPAWNS: Record<string, [Vec3, Vec3]> = {
    de_ancient: [{ x: -456, y: -2288, z: -163 }, { x: -352, y: 1728, z: 29 }],
    de_anubis: [{ x: -328, y: -1528, z: -12 }, { x: -476, y: 2216, z: 25 }],
    de_cache: [{ x: 3078, y: 136, z: 1616 }, { x: -1524, y: 795, z: 1614 }],
    de_dust2: [{ x: -493, y: -808, z: 109 }, { x: 160, y: 2370, z: -120 }],
    de_mirage: [{ x: 1230, y: -300, z: -167 }, { x: -1650, y: -1950, z: -295 }],
  };

  it("walks from T spawn to CT spawn on every map, a little further than the straight line", () => {
    for (const [m, [t, ct]] of Object.entries(SPAWNS)) {
      const w = walkGraphFor(load(m));
      const d = w.distance(t, ct, 20000)!;
      const straight = Math.hypot(t.x - ct.x, t.y - ct.y);
      expect(Number.isFinite(d), m).toBe(true);
      expect(d / straight, m).toBeGreaterThan(1.0);
      expect(d / straight, m).toBeLessThan(1.5);
    }
  });

  it("knows that two spots 260 units apart on Mirage are a long walk apart, with a wall between", () => {
    const w = walkGraphFor(load("de_mirage"));
    // Either side of the wall between the ladder room and the underpass, on the same floor.
    const a = { x: -1080, y: -144, z: -156 };
    const b = { x: -1080, y: -404, z: -156 };
    expect(load("de_mirage").segmentClear({ ...a, z: a.z + 40 }, { ...b, z: b.z + 40 }, 0)).toBe(false);
    expect(w.distance(a, b)!).toBeGreaterThan(2000);
    expect(w.distance(b, a)!).toBeGreaterThan(2000);
  });

  it("follows where pro players really walked: nearly every step of their routes is reached, at about its length", () => {
    const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "demo-routes.json"), "utf8")) as { maps: Record<string, [number, number, number][][]> };
    for (const [m, routes] of Object.entries(fixture.maps)) {
      const w = walkGraphFor(load(m));
      let steps = 0;
      let placed = 0;
      let reached = 0;
      const ratios: number[] = [];
      for (const r of routes) {
        const pts = r.map(([x, y, z]) => ({ x, y, z }));
        // A second of running at a time (four samples).
        for (let i = 0; i + 4 < pts.length; i += 4) {
          let len = 0;
          for (let j = i; j < i + 4; j++) len += Math.hypot(pts[j + 1]!.x - pts[j]!.x, pts[j + 1]!.y - pts[j]!.y, pts[j + 1]!.z - pts[j]!.z);
          const d = w.distance(pts[i]!, pts[i + 4]!, len * 3 + 600);
          steps++;
          if (d === null) continue;
          placed++;
          if (!Number.isFinite(d)) continue;
          reached++;
          ratios.push(d / Math.max(1, len));
        }
      }
      ratios.sort((x, y) => x - y);
      expect(placed / steps, m).toBeGreaterThan(0.98);
      expect(reached / placed, m).toBeGreaterThan(0.98);
      expect(ratios[Math.floor(ratios.length / 2)]!, m).toBeLessThan(1.25);
    }
  }, 60000);
});
