import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { VisibilityGrid } from "../src/index.ts";

const MAPS = ["de_ancient", "de_anubis", "de_dust2", "de_inferno", "de_mirage", "de_nuke", "de_overpass", "de_train", "de_vertigo"];
const load = (m: string) => VisibilityGrid.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "assets", "map-packs", `${m}.grid`)), (b) => inflateSync(b));

describe("built-in free-space grids", () => {
  it("exist for every active-duty map, from the same CS2 build as the cameras", () => {
    for (const m of MAPS) {
      const g = load(m);
      expect(g.header).toMatchObject({ map: m, build: "26144732", cell: 12 });
      expect(g.header.dims.every((d) => d > 50 && d < 1000)).toBe(true);
    }
  });

  it("sees A site from its built-in camera, and not through the map from T spawn to CT spawn", () => {
    const g = load("de_dust2");
    // cs2-dust2-bombsite_a-1 to the middle of A site (checked against the collision mesh when placed).
    expect(g.lineOfSight({ x: 1512, y: 3048, z: 386.6 }, { x: 1056, y: 2656, z: 194.7 })).toBe(true);
    // T spawn to CT spawn: the whole map in between.
    expect(g.lineOfSight({ x: -680, y: -790, z: 140 }, { x: 260, y: 2290, z: -60 })).toBe(false);
  });

  it("answers outside the grid as free space, and checks clearance around a point", () => {
    const g = load("de_dust2");
    expect(g.solidAt({ x: 1e6, y: 1e6, z: 1e6 })).toBe(false);
    expect(g.clearAround({ x: 1281.5, y: 2302.5, z: 390 }, 20)).toBe(true);
  });

  it("refuses files that aren't grids", () => {
    expect(() => VisibilityGrid.parse(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), (b) => b)).toThrow(/not a Matchframe grid/);
  });
});
