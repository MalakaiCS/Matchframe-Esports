import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { MapPack } from "@matchframe/contracts";
import { MapRuntime, VisibilityGrid } from "@matchframe/map-runtime";
import { samplePath } from "@matchframe/observer-agent";

const packs = join(import.meta.dirname, "..", "..", "..", "assets", "map-packs");
/** The maps with read demos (one match each so far). */
const MAPS = ["de_ancient", "de_anubis", "de_cache", "de_dust2", "de_inferno", "de_mirage", "de_nuke"];

/**
 * The camera paths built from demos (scripts/demo-path-anchors.py, scripts/generate-demo-paths.ts,
 * scripts/merge-demo-paths.py, ADR-047): 200-300 a map, usable by default as built-in paths, and
 * flown again here through the map's free-space grid the way the program flies them.
 */
describe("camera paths built from demos", () => {
  it.each(MAPS)("%s: 200-300 paths, built in, each flying clear of CS2's geometry", (m) => {
    const pack = MapPack.parse(JSON.parse(readFileSync(join(packs, `${m}.json`), "utf8")));
    const grid = VisibilityGrid.parse(readFileSync(join(packs, `${m}.grid`)), (b) => inflateSync(b));
    const rt = new MapRuntime(pack);
    const paths = pack.paths.filter((p) => p.source === "derived_demos");
    expect(paths.length).toBeGreaterThanOrEqual(200);
    expect(paths.length).toBeLessThanOrEqual(300);
    expect(new Set(pack.paths.map((p) => p.id)).size).toBe(pack.paths.length);
    expect(new Set(paths.map((p) => p.id.split("-")[2])).size).toBeGreaterThanOrEqual(5); // routes, orbits, push-ins, ...
    const usable = new Set(rt.pathsFor().map((p) => p.id));
    for (const p of paths) {
      expect(p.id).toMatch(new RegExp(`^demo-${m.slice(3)}-(route|orbit|push|pull|crane|slide)-\\d{3}$`));
      expect(p.mapRevision).toBe(pack.mapRevision);
      expect(p.validation).toBe("unvalidated");
      expect(usable.has(p.id)).toBe(true);
      const dur = p.keyframes[p.keyframes.length - 1]!.tMs;
      expect(dur).toBeGreaterThanOrEqual(3000);
      expect(dur).toBeLessThanOrEqual(10_000);
      expect(dur).toBeLessThanOrEqual(p.maxDurationMs);
      let prev: { x: number; y: number; z: number } | null = null;
      for (let t = 0; t <= dur; t += 100) {
        const pose = samplePath(p, t);
        const q = pose.position;
        expect(grid.clearAround(q, 16), `${p.id} at ${t} ms`).toBe(true);
        expect(pose.pitch).toBeGreaterThanOrEqual(-15);
        expect(pose.pitch).toBeLessThanOrEqual(65);
        if (prev) {
          expect(grid.segmentClear(prev, q, 0), `${p.id} at ${t} ms`).toBe(true);
          expect(Math.hypot(q.x - prev.x, q.y - prev.y, q.z - prev.z) / 0.1).toBeLessThanOrEqual(p.maxSpeedUnitsPerSec);
        }
        prev = q;
      }
    }
    rt.builtInCameras = false;
    expect(rt.pathsFor().some((p) => p.source === "derived_demos")).toBe(false);
  });
});
