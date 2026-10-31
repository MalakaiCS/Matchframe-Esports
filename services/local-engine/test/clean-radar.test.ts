import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { MapPack } from "@matchframe/contracts";
import type { MapRuntime } from "@matchframe/map-runtime";
import { MapRegistry, VisibilityGrid } from "@matchframe/map-runtime";
import { CleanRadars, drawCleanRadar, insideRings, type CleanRadarDrawing, type CleanRadarFrame } from "../src/hud/clean-radar.ts";
import { BuiltinRadars, builtinRadarUv } from "../src/live/builtin-radars.ts";

const assets = join(import.meta.dirname, "..", "..", "..", "assets");
const radars = BuiltinRadars.load(join(assets, "radars"));

function load(mapName: string, opts: { grid?: boolean; radar?: MapPack["radar"] } = {}): MapRuntime {
  const reg = new MapRegistry();
  if (opts.grid !== false) reg.setGrid(VisibilityGrid.parse(readFileSync(join(assets, "map-packs", `${mapName}.grid`)), (b) => inflateSync(b)));
  const file = join(assets, "map-packs", `${mapName}.json`);
  const raw = JSON.parse(readFileSync(file, "utf8")) as MapPack;
  return reg.registerRaw(opts.radar ? { ...raw, radar: opts.radar } : raw, file)!;
}

/** World points of a region: every cell centre at its floor height (floor grid), and the cell nearest the region's middle. */
function regionPoints(rt: MapRuntime, regionId: string) {
  const floors = new Map((rt.pack.floorGrid?.cells ?? []).map(([ix, iy, ...zs]) => [`${ix},${iy}`, zs]));
  const pts: { x: number; y: number; z: number }[] = [];
  for (const sh of rt.region(regionId)!.shapes) {
    if (sh.kind !== "cells") continue;
    for (const [ix, iy, iz] of sh.cells) {
      const mid = (iz + 0.5) * sh.zCellSize;
      const zs = (floors.get(`${ix},${iy}`) ?? []).filter((z) => z >= iz * sh.zCellSize - 24 && z < (iz + 1) * sh.zCellSize + 24);
      pts.push({ x: (ix + 0.5) * sh.cellSize, y: (iy + 0.5) * sh.cellSize, z: zs.length ? zs.reduce((a, b) => (Math.abs(b - mid) < Math.abs(a - mid) ? b : a)) : mid });
    }
  }
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const centre = pts.reduce((a, b) => (Math.hypot(b.x - cx, b.y - cy) < Math.hypot(a.x - cx, a.y - cy) ? b : a));
  return { pts, centre };
}

/** The markers' transform for the frame (projection.ts): image pixels and the drawing layer it lands on. */
function marker(rt: MapRuntime, frame: CleanRadarFrame, d: CleanRadarDrawing, p: { x: number; y: number; z: number }) {
  if (frame === "builtin") {
    const uv = builtinRadarUv(radars.get(rt.mapName)!, p)!;
    return { x: uv.u * d.size, y: uv.v * d.size, layer: d.layers.find((l) => l.id === uv.layerId)! };
  }
  const uv = frame === "schematic" ? rt.worldToSchematic(p)! : rt.worldToRadar(p)!;
  const level = rt.levelAt(p) ?? "main";
  return { x: uv.u * d.size, y: uv.v * d.size, layer: d.layers.find((l) => l.id === level) ?? d.layers.at(-1)! };
}

/** Share of the points that land inside the drawn bombsite (or floor) of their layer. */
function landing(rt: MapRuntime, frame: CleanRadarFrame, d: CleanRadarDrawing, regionId: string, what: "sites" | "floor") {
  const { pts, centre } = regionPoints(rt, regionId);
  const inside = (p: { x: number; y: number; z: number }) => {
    const m = marker(rt, frame, d, p);
    return insideRings(m.layer[what], m.x, m.y);
  };
  return { centre: inside(centre), share: pts.filter(inside).length / pts.length };
}

describe("clean radar (Matchframe's own drawing from map packs)", () => {
  const cases: [string, CleanRadarFrame][] = [
    ["de_mirage", "builtin"],
    ["de_dust2", "builtin"],
    ["de_inferno", "builtin"],
    ["de_ancient", "builtin"],
    ["de_overpass", "builtin"],
    ["de_train", "builtin"],
    ["de_nuke", "builtin"],
    ["de_vertigo", "builtin"],
    ["de_anubis", "schematic"],
    ["de_cache", "schematic"],
  ];

  it.each(cases)("%s (%s frame): bombsite centres placed by the markers' transform land inside the drawn bombsites", (mapName, frame) => {
    const rt = load(mapName);
    const d = drawCleanRadar(rt, frame, radars.get(mapName))!;
    expect(d.svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="1024" height="1024" viewBox="0 0 1024 1024">/);
    expect(d.svg.length).toBeLessThan(60_000);
    // Transparent around the map: nothing is drawn as a background.
    expect(d.svg).not.toMatch(/<rect/);
    expect(d.labels.map((l) => l.text).sort()).toEqual(["A", "B"]);
    for (const b of rt.pack.bombsites) {
      const site = landing(rt, frame, d, b.regionId, "sites");
      expect(site.centre, `${mapName} ${b.site} centre`).toBe(true);
      // Most of the site's cells too (obstacles such as Train's trains are left out of the floor).
      expect(site.share, `${mapName} ${b.site} cells`).toBeGreaterThan(0.8);
      // Each letter sits on its own site.
      const label = d.labels.find((l) => l.text === b.site)!;
      expect(d.layers.some((l) => insideRings(l.sites, label.x, label.y))).toBe(true);
    }
    // Spawns are on the drawn floor; their cells that are not also bombsite cells are off the sites.
    const siteCells = new Set(rt.pack.bombsites.flatMap((b) => regionPoints(rt, b.regionId).pts.map((p) => `${p.x},${p.y}`)));
    for (const region of rt.pack.regions.filter((r) => r.kind === "spawn")) {
      const floor = landing(rt, frame, d, region.id, "floor");
      expect(floor.centre, `${mapName} ${region.id}`).toBe(true);
      expect(floor.share).toBeGreaterThan(0.8);
      const off = regionPoints(rt, region.id).pts.filter((p) => !siteCells.has(`${p.x},${p.y}`));
      const onSite = off.filter((p) => {
        const m = marker(rt, frame, d, p);
        return insideRings(m.layer.sites, m.x, m.y);
      });
      expect(onSite.length / off.length, `${mapName} ${region.id} on a site`).toBeLessThan(0.1);
    }
  });

  it("draws Nuke's and Vertigo's levels where the built-in image does, the lower one in a lighter navy", () => {
    for (const mapName of ["de_nuke", "de_vertigo"]) {
      const d = drawCleanRadar(load(mapName), "builtin", radars.get(mapName))!;
      expect(d.layers.map((l) => [l.id, l.lower])).toEqual([
        ["lower", true],
        ["upper", false],
      ]);
      expect(d.svg).toContain('fill="#34405b"');
      expect(d.svg).toContain('fill="#262f40"');
    }
    // Nuke's B site is downstairs: on the lower drawing (the image's bottom half).
    const nuke = drawCleanRadar(load("de_nuke"), "builtin", radars.get("de_nuke"))!;
    const b = nuke.labels.find((l) => l.text === "B")!;
    expect(b.y).toBeGreaterThan(512);
    expect(insideRings(nuke.layers.find((l) => l.id === "lower")!.sites, b.x, b.y)).toBe(true);
  });

  it("follows an operator-calibrated image's calibration", () => {
    // Dust II's overview calibration (pos -2476, 3239, scale 4.4), as an operator would enter it.
    const rt = load("de_dust2", { radar: { posX: -2476, posY: 3239, scale: 4.4, rotationDeg: 0, imageSizePx: 1024, imageAssetId: "0123456789abcdef01234567.png", source: "operator_calibration", verified: true, notes: null } });
    const d = drawCleanRadar(rt, "calibrated")!;
    for (const b of rt.pack.bombsites) expect(landing(rt, "calibrated", d, b.regionId, "sites").centre).toBe(true);
    // The same calibration as the built-in image: the drawings agree within a few pixels.
    const builtin = drawCleanRadar(rt, "builtin", radars.get("de_dust2"))!;
    for (const t of ["A", "B"]) {
      const a = d.labels.find((l) => l.text === t)!;
      const c = builtin.labels.find((l) => l.text === t)!;
      expect(Math.hypot(a.x - c.x, a.y - c.y)).toBeLessThan(4);
    }
  });

  it("still draws from the 64-unit cells when the map has no collision grid", () => {
    const rt = load("de_mirage", { grid: false });
    const d = drawCleanRadar(rt, "builtin", radars.get("de_mirage"))!;
    for (const b of rt.pack.bombsites) expect(landing(rt, "builtin", d, b.regionId, "sites").centre).toBe(true);
  });

  it("gives versioned addresses only where there is geometry, and draws each once", () => {
    const clean = new CleanRadars((m) => radars.get(m));
    const mirage = load("de_mirage");
    const anubis = load("de_anubis");
    const url = clean.url(mirage, "builtin")!;
    expect(url).toMatch(/^\/overlay-api\/radar-clean\/de_mirage\/builtin\?v=[0-9a-f]{12}$/);
    expect(clean.url(mirage, "schematic")).toMatch(/^\/overlay-api\/radar-clean\/de_mirage\/schematic\?v=/);
    // No built-in image for Anubis; no pack at all; a pack without a calibration.
    expect(clean.url(anubis, "builtin")).toBeNull();
    expect(clean.url(undefined, "schematic")).toBeNull();
    expect(clean.svg(anubis, "calibrated")).toBeNull();
    expect(clean.url(anubis, "calibrated")).toBeNull();
    const svg = clean.svg(mirage, "builtin");
    expect(svg).toContain("<path");
    expect(clean.svg(mirage, "builtin")).toBe(svg);
    expect(clean.url(mirage, "builtin")).toBe(url);
    // A new calibration is a new address (HUDs fetch the new drawing).
    const cal = (scale: number) => load("de_dust2", { radar: { posX: -2476, posY: 3239, scale, rotationDeg: 0, imageSizePx: 1024, imageAssetId: null, source: "operator_calibration", verified: true, notes: null } });
    expect(clean.url(cal(4.4), "calibrated")).not.toBe(clean.url(cal(4.5), "calibrated"));
  });
});
