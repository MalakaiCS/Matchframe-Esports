import type { CameraRecord, MapLevel, MapPack, RadarCalibration, Region, Vec3 } from "@matchframe/contracts";
import { cellKey, cellOf, pointInPolygon } from "./geometry.ts";

export interface RadarPoint {
  /** Normalized 0..1 radar coordinates (x right, y down). */
  u: number;
  v: number;
  levelId: string | null;
}

interface CellIndex {
  cellSize: number;
  zCellSize: number;
  map: Map<string, string[]>;
}

export interface CameraMatch {
  camera: CameraRecord;
  distanceUnits: number;
  /** Fraction of coverage radius used; lower is more central. */
  centrality: number;
}

/**
 * Runtime queries over a map pack. Named regions are authoring aids, not tracking boundaries:
 * any world position is valid and may belong to zero, one or several regions.
 */
export class MapRuntime {
  readonly pack: MapPack;
  private readonly cellIndexes: CellIndex[] = [];
  private readonly polygonRegions: Region[] = [];
  private readonly floors = new Map<string, number[]>();
  private readonly floorCell: number | null;

  constructor(pack: MapPack) {
    this.pack = pack;
    const byCellSize = new Map<string, CellIndex>();
    for (const region of pack.regions) {
      for (const shape of region.shapes) {
        if (shape.kind === "polygon") {
          if (!this.polygonRegions.includes(region)) this.polygonRegions.push(region);
          continue;
        }
        const k = `${shape.cellSize}/${shape.zCellSize}`;
        let idx = byCellSize.get(k);
        if (!idx) {
          idx = { cellSize: shape.cellSize, zCellSize: shape.zCellSize, map: new Map() };
          byCellSize.set(k, idx);
          this.cellIndexes.push(idx);
        }
        for (const [ix, iy, iz] of shape.cells) {
          const key = cellKey(ix, iy, iz);
          const list = idx.map.get(key);
          if (list) {
            if (!list.includes(region.id)) list.push(region.id);
          } else idx.map.set(key, [region.id]);
        }
      }
    }
    this.floorCell = pack.floorGrid?.cellSize ?? null;
    for (const row of pack.floorGrid?.cells ?? []) {
      const [ix, iy, ...zs] = row;
      if (ix === undefined || iy === undefined) continue;
      this.floors.set(`${ix},${iy}`, zs.slice().sort((a, b) => a - b));
    }
  }

  get mapName(): string {
    return this.pack.mapName;
  }

  region(id: string): Region | undefined {
    return this.pack.regions.find((r) => r.id === id);
  }

  /** All regions containing the point (may be empty). Cell regions tolerate one cell of slack. */
  regionsAt(p: Vec3): string[] {
    const out = new Set<string>();
    for (const r of this.polygonRegions) {
      for (const s of r.shapes) {
        if (s.kind === "polygon" && p.z >= s.zMin && p.z <= s.zMax && pointInPolygon(p.x, p.y, s.points)) out.add(r.id);
      }
    }
    for (const idx of this.cellIndexes) {
      const [ix, iy, iz] = cellOf(p, idx.cellSize, idx.zCellSize);
      const direct = idx.map.get(cellKey(ix, iy, iz));
      if (direct) {
        for (const id of direct) out.add(id);
        continue;
      }
      // Grenades fly above walkable cells: check the cell column slightly below as well.
      for (const dz of [-1, -2]) {
        const below = idx.map.get(cellKey(ix, iy, iz + dz));
        if (below) {
          for (const id of below) out.add(id);
          break;
        }
      }
    }
    return [...out];
  }

  levelAt(p: Vec3): string | null {
    const level = this.pack.levels.find((l) => p.z >= l.zMin && p.z < l.zMax);
    return level?.id ?? null;
  }

  levels(): readonly MapLevel[] {
    return this.pack.levels;
  }

  /** Nearest walkable floor at or below p (from sampled geometry), or null if unknown. */
  floorZAt(p: Vec3): number | null {
    if (this.floorCell === null) return null;
    const ix = Math.floor(p.x / this.floorCell);
    const iy = Math.floor(p.y / this.floorCell);
    const zs = this.floors.get(`${ix},${iy}`);
    if (!zs || zs.length === 0) return null;
    let best: number | null = null;
    for (const z of zs) if (z <= p.z + 16) best = z;
    return best;
  }

  private schematic: { minX: number; maxY: number; size: number } | null | undefined;

  /**
   * Square world-XY bounds of the pack's sampled geometry (region cells and floor grid). Used for
   * the Matchframe schematic radar, whose outline is drawn from the same cells, so markers are
   * placed with the same transform as the outline. Null when the pack has no cell geometry.
   */
  schematicTransform(): { minX: number; maxY: number; size: number } | null {
    if (this.schematic !== undefined) return this.schematic;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const r of this.pack.regions) {
      for (const sh of r.shapes) {
        if (sh.kind === "cells") {
          for (const [ix, iy] of sh.cells) {
            minX = Math.min(minX, ix * sh.cellSize);
            minY = Math.min(minY, iy * sh.cellSize);
            maxX = Math.max(maxX, (ix + 1) * sh.cellSize);
            maxY = Math.max(maxY, (iy + 1) * sh.cellSize);
          }
        } else {
          for (const [x, y] of sh.points) {
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
          }
        }
      }
    }
    if (!Number.isFinite(minX)) {
      this.schematic = null;
      return null;
    }
    const size = Math.max(maxX - minX, maxY - minY) * 1.04;
    const padX = (size - (maxX - minX)) / 2;
    const padY = (size - (maxY - minY)) / 2;
    this.schematic = { minX: minX - padX, maxY: maxY + padY, size };
    return this.schematic;
  }

  worldToSchematic(p: Vec3): { u: number; v: number } | null {
    const t = this.schematicTransform();
    if (!t) return null;
    return { u: (p.x - t.minX) / t.size, v: (t.maxY - p.y) / t.size };
  }

  /** Normalized outline cells [u, v, sizeU, regionIndex] for drawing the schematic radar. */
  schematicOutline(): {
    cells: [number, number, number, number][];
    polygons: { regionIndex: number; points: [number, number][] }[];
    regions: { id: string; name: string; kind: string }[];
  } | null {
    const t = this.schematicTransform();
    if (!t) return null;
    const cells: [number, number, number, number][] = [];
    const polygons: { regionIndex: number; points: [number, number][] }[] = [];
    const seen = new Set<string>();
    this.pack.regions.forEach((r, ri) => {
      for (const sh of r.shapes) {
        if (sh.kind === "polygon") {
          polygons.push({ regionIndex: ri, points: sh.points.map(([x, y]) => [Math.round(((x - t.minX) / t.size) * 1e4) / 1e4, Math.round(((t.maxY - y) / t.size) * 1e4) / 1e4]) });
          continue;
        }
        for (const [ix, iy] of sh.cells) {
          const k = `${sh.cellSize}:${ix}:${iy}`;
          if (seen.has(k)) continue;
          seen.add(k);
          const u = (ix * sh.cellSize - t.minX) / t.size;
          const v = (t.maxY - (iy + 1) * sh.cellSize) / t.size;
          cells.push([Math.round(u * 1e4) / 1e4, Math.round(v * 1e4) / 1e4, Math.round((sh.cellSize / t.size) * 1e4) / 1e4, ri]);
        }
      }
    });
    return { cells, polygons, regions: this.pack.regions.map((r) => ({ id: r.id, name: r.name, kind: r.kind })) };
  }

  siteAt(p: Vec3): "A" | "B" | null {
    const regions = new Set(this.regionsAt(p));
    for (const b of this.pack.bombsites) if (regions.has(b.regionId)) return b.site;
    return null;
  }

  radarCalibrationFor(levelId: string | null): RadarCalibration | null {
    const level = levelId ? this.pack.levels.find((l) => l.id === levelId) : undefined;
    return level?.radar ?? this.pack.radar ?? null;
  }

  /**
   * World → normalized radar coordinates. Returns null when the map has no calibration:
   * an uncalibrated radar must show an "uncalibrated" state, not misleading markers.
   */
  worldToRadar(p: Vec3, opts: { requireVerified?: boolean } = {}): RadarPoint | null {
    const levelId = this.levelAt(p);
    const cal = this.radarCalibrationFor(levelId);
    if (!cal) return null;
    if (opts.requireVerified && !cal.verified) return null;
    let px = (p.x - cal.posX) / cal.scale;
    let py = (cal.posY - p.y) / cal.scale;
    if (cal.rotationDeg) {
      const c = cal.imageSizePx / 2;
      const a = (cal.rotationDeg * Math.PI) / 180;
      const dx = px - c;
      const dy = py - c;
      px = c + dx * Math.cos(a) - dy * Math.sin(a);
      py = c + dx * Math.sin(a) + dy * Math.cos(a);
    }
    return { u: px / cal.imageSizePx, v: py / cal.imageSizePx, levelId };
  }

  /**
   * Cameras whose coverage volume includes the point on the correct level, sorted by centrality.
   * By default only validated cameras are returned; unvalidated poses are preview/operator-only.
   */
  camerasCovering(p: Vec3, opts: { includeUnvalidated?: boolean; grenadeType?: string; actionClass?: string } = {}): CameraMatch[] {
    const level = this.levelAt(p);
    const out: CameraMatch[] = [];
    for (const cam of this.pack.cameras) {
      if (!opts.includeUnvalidated && cam.validation !== "validated") continue;
      if (cam.validation === "invalidated") continue;
      if (cam.mapRevision !== this.pack.mapRevision) continue;
      const cov = cam.coverage;
      if (cov.levelId !== null && level !== null && cov.levelId !== level) continue;
      if (p.z < cov.zMin || p.z > cov.zMax) continue;
      if (opts.grenadeType && cam.grenadeTypes.length > 0 && !cam.grenadeTypes.includes(opts.grenadeType as never)) continue;
      if (opts.actionClass && !cam.actionClasses.includes(opts.actionClass as never)) continue;
      const d = Math.hypot(p.x - cov.center.x, p.y - cov.center.y, p.z - cov.center.z);
      if (d > cov.radiusUnits) continue;
      out.push({ camera: cam, distanceUnits: d, centrality: d / cov.radiusUnits });
    }
    return out.sort((a, b) => a.centrality - b.centrality);
  }
}

/**
 * Selectively invalidates cameras, paths and region validation when the map revision changes.
 * Untouched records keep their state only if their revision matches the new revision.
 */
export function applyMapRevision(pack: MapPack, newRevision: string): { pack: MapPack; invalidated: string[] } {
  if (pack.mapRevision === newRevision) return { pack, invalidated: [] };
  const invalidated: string[] = [];
  const cameras = pack.cameras.map((c) => {
    if (c.mapRevision === newRevision) return c;
    invalidated.push(`camera:${c.id}`);
    return { ...c, validation: "invalidated" as const, occlusionValidation: "invalidated" as const };
  });
  const paths = pack.paths.map((p) => {
    if (p.mapRevision === newRevision) return p;
    invalidated.push(`path:${p.id}`);
    return { ...p, validation: "invalidated" as const, collisionValidated: false };
  });
  const regions = pack.regions.map((r) => {
    if (!r.validated) return r;
    invalidated.push(`region:${r.id}`);
    return { ...r, validated: false };
  });
  const radar = pack.radar ? { ...pack.radar, verified: false } : null;
  if (pack.radar?.verified) invalidated.push("radar");
  return { pack: { ...pack, mapRevision: newRevision, cameras, paths, regions, radar }, invalidated };
}
