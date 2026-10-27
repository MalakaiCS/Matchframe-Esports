import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MapPack } from "@matchframe/contracts";
import { MapRuntime } from "../src/index.ts";

const root = join(import.meta.dirname, "..", "..", "..");
const MAPS = ["de_ancient", "de_anubis", "de_dust2", "de_inferno", "de_mirage", "de_nuke", "de_overpass", "de_train", "de_vertigo"];
const pack = (m: string) => MapPack.parse(JSON.parse(readFileSync(join(root, "assets", "map-packs", `${m}.json`), "utf8")));

/**
 * The built-in cameras and paths shipped for the active-duty maps (scripts/generate-map-cameras.py,
 * ADR-025): placed on CS2's walkable floor and checked against CS2's collision geometry. The meshes
 * are not in the repository, so this checks what the generator recorded, and that every map has them.
 */
describe("built-in cameras and paths on the active-duty maps", () => {
  it.each(MAPS)("%s: cameras for both sites, checked against CS2's geometry, usable by default", (m) => {
    const p = pack(m);
    const rt = new MapRuntime(p);
    const cams = p.cameras.filter((c) => c.capturedFrom === "derived_navmesh");
    expect(cams.length).toBeGreaterThanOrEqual(9);
    for (const b of p.bombsites) expect(cams.filter((c) => c.targetRegionIds.includes(b.regionId)).length).toBe(3);
    for (const c of cams) {
      expect(c.id).toMatch(new RegExp(`^cs2-${m.slice(3)}-`));
      expect(c.mapRevision).toBe(p.mapRevision);
      expect(c.occlusionValidation).toBe("validated");
      expect(c.validation).toBe("unvalidated");
      expect(c.notes).toMatch(/collision geometry \(build \d+\)/);
      expect(rt.cameraUsable(c)).toBe(true);
    }
    rt.builtInCameras = false;
    expect(cams.some((c) => rt.cameraUsable(c))).toBe(false);
  });

  it.each(MAPS)("%s: camera paths with a checked flight curve that fit in freeze time", (m) => {
    const p = pack(m);
    const paths = p.paths.filter((x) => x.source === "derived_navmesh");
    expect(paths.length).toBeGreaterThanOrEqual(7);
    for (const x of paths) {
      expect(x.id).toMatch(new RegExp(`^cs2-${m.slice(3)}-`));
      expect(x.collisionValidated).toBe(true);
      const dur = x.keyframes[x.keyframes.length - 1]!.tMs;
      expect(dur).toBeGreaterThanOrEqual(3000);
      expect(dur).toBeLessThanOrEqual(10000);
      expect(x.keyframes.every((k, i) => i === 0 || k.tMs > x.keyframes[i - 1]!.tMs)).toBe(true);
    }
  });
});
