import { createHash } from "node:crypto";
import type { MapRuntime, VisibilityGrid } from "@matchframe/map-runtime";
import { pointInPolygon } from "@matchframe/map-runtime";
import { radarLayerFor, type BuiltinRadar } from "../live/builtin-radars.ts";

/**
 * Matchframe's clean radar: the map drawn from its map pack (navigation-mesh cells and floor grid,
 * bombsite regions) in a flat style: navy floor (a lighter navy for the lower level of two-level
 * maps), light wall outlines, bombsites tinted red, transparent around the map. It is drawn in the
 * frame of the radar background the HUD state uses, so the markers' u/v land on it:
 * - "builtin": the built-in radar image's calibration (assets/radars, one transform per layer);
 * - "calibrated": an operator-calibrated radar image (map pack calibration, per level);
 * - "schematic": Matchframe's outline frame (MapRuntime.schematicTransform).
 */
export const CLEAN_RADAR_FRAMES = ["builtin", "calibrated", "schematic"] as const;
export type CleanRadarFrame = (typeof CLEAN_RADAR_FRAMES)[number];

/** Bumped when the drawing changes, so HUDs fetch it again. */
const CLEAN_RADAR_VERSION = 1;
const SIZE = 1024;

const STYLE = {
  floor: "#262f40",
  floorLower: "#34405b",
  wall: "#e8ebf0",
  wallWidth: 6.5,
  site: "#a01e32",
  siteOpacity: 0.55,
  siteEdge: "#e2475f",
  siteEdgeWidth: 2,
  label: "#e8ebf0",
  labelSize: 44,
};

/**
 * Outlines are traced on a fine grid (world units) and smoothed (Gaussian, world units): lightly
 * when the map's collision grid placed the walls, more when only the 64-unit cells are known.
 */
const FINE = 8;
const SMOOTH_WALLS = 18;
const SMOOTH_CELLS = 26;
/** A wall at a floor: solid at both heights above it (low cover and crates stay floor). */
const WALL_HEIGHTS = [44, 72];
/** Slivers narrower than about twice this (world units) are dropped from refined outlines. */
const OPEN_RADIUS = 24;
/** Raster clean-up, in map-pack cells: islands under this are dropped, enclosed gaps up to this filled. */
const MIN_ISLAND = 3;
const MAX_HOLE = 6;
const MAX_SITE_HOLE = 24;
/** Outline simplification tolerance, image pixels (1024 frame). */
const SIMPLIFY_PX = 0.9;

type Pt = [number, number];
export type Ring = Pt[];

interface FrameLayer {
  id: string;
  /** Height used to order layers (top layer drawn last, in the darker navy). */
  rank: number;
  /** World XY to image pixels in a SIZE × SIZE frame; null when the layer cannot place it. */
  toPx: (x: number, y: number) => Pt | null;
}

interface Frame {
  layers: FrameLayer[];
  layerAt: (z: number) => FrameLayer | null;
}

export interface CleanRadarDrawing {
  size: number;
  /** Per layer, lower layers first: floor and bombsite outlines in image pixels (even-odd rings). */
  layers: { id: string; lower: boolean; floor: Ring[]; sites: Ring[] }[];
  labels: { text: string; x: number; y: number }[];
  svg: string;
}

const rankOf = (zMin: number | undefined, zMax: number | undefined): number =>
  zMin !== undefined && zMax !== undefined ? (zMin + zMax) / 2 : zMin !== undefined ? zMin + 1000 : zMax !== undefined ? zMax - 1000 : 0;

function builtinFrame(radar: BuiltinRadar): Frame {
  const k = SIZE / radar.size;
  const layers = radar.layers.map((l) => ({ id: l.id, rank: rankOf(l.zMin, l.zMax), toPx: (x: number, y: number): Pt => [(l.originX + x * l.pxPerUX) * k, (l.originY + y * l.pxPerUY) * k] }));
  return { layers, layerAt: (z) => layers[radar.layers.indexOf(radarLayerFor(radar, z))] ?? null };
}

function schematicFrame(rt: MapRuntime): Frame | null {
  const t = rt.schematicTransform();
  if (!t) return null;
  const k = SIZE / t.size;
  const toPx = (x: number, y: number): Pt => [(x - t.minX) * k, (t.maxY - y) * k];
  const levels = rt.levels();
  if (levels.length < 2) {
    const only = { id: levels[0]?.id ?? "main", rank: 0, toPx };
    return { layers: [only], layerAt: () => only };
  }
  // One frame for every level (like the markers); levels only change the floor colour.
  const layers = levels.map((l) => ({ id: l.id, rank: (l.zMin + l.zMax) / 2, toPx }));
  const layerAt = (z: number) => {
    const i = levels.findIndex((l) => z >= l.zMin && z < l.zMax);
    if (i >= 0) return layers[i]!;
    let best = 0;
    levels.forEach((l, j) => {
      if (Math.abs(z - (l.zMin + l.zMax) / 2) < Math.abs(z - (levels[best]!.zMin + levels[best]!.zMax) / 2)) best = j;
    });
    return layers[best]!;
  };
  return { layers, layerAt };
}

/** The markers' transform for an operator-calibrated image: MapRuntime.worldToRadar, per level. */
function calibratedFrame(rt: MapRuntime): Frame | null {
  const levels = rt.levels();
  const layer = (id: string | null, rank: number, zIn: number): FrameLayer | null => {
    if (!rt.radarCalibrationFor(id)) return null;
    return {
      id: id ?? "main",
      rank,
      toPx: (x, y) => {
        const r = rt.worldToRadar({ x, y, z: zIn });
        return r ? [r.u * SIZE, r.v * SIZE] : null;
      },
    };
  };
  const byLevel = new Map<string, FrameLayer>();
  for (const l of levels) {
    const fl = layer(l.id, (l.zMin + l.zMax) / 2, l.zMin);
    if (fl) byLevel.set(l.id, fl);
  }
  // Positions outside every level use the pack's own calibration (levelAt → null).
  const outside = rt.pack.radar ? layer(null, 0, levels.length ? Math.min(...levels.map((l) => l.zMin)) - 1e5 : 0) : null;
  const layers = [...byLevel.values(), ...(outside ? [outside] : [])];
  if (!layers.length) return null;
  return {
    layers,
    layerAt: (z) => {
      const id = rt.levelAt({ x: 0, y: 0, z });
      return id ? (byLevel.get(id) ?? null) : outside;
    },
  };
}

// ------------------------------------------------------------------------------ raster

interface Raster {
  /** Cell edge (world units) and the world position of cell (0, 0)'s corner. */
  cell: number;
  x0: number;
  y0: number;
  nx: number;
  ny: number;
}

const N8 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;

/** Connected components of cells equal to `value`; `diagonal` joins corner neighbours. */
function components(m: Uint8Array, r: Raster, value: number, diagonal: boolean): { cells: number[]; border: boolean }[] {
  const seen = new Uint8Array(m.length);
  const out: { cells: number[]; border: boolean }[] = [];
  const steps = diagonal ? N8 : N8.slice(0, 4);
  for (let s = 0; s < m.length; s++) {
    if (seen[s] || m[s] !== value) continue;
    const cells: number[] = [];
    let border = false;
    const stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      cells.push(c);
      const i = c % r.nx;
      const j = (c - i) / r.nx;
      if (i === 0 || j === 0 || i === r.nx - 1 || j === r.ny - 1) border = true;
      for (const [di, dj] of steps) {
        const a = i + di;
        const b = j + dj;
        if (a < 0 || b < 0 || a >= r.nx || b >= r.ny) continue;
        const n = b * r.nx + a;
        if (!seen[n] && m[n] === value) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    out.push({ cells, border });
  }
  return out;
}

/** Drops islands smaller than `minIsland` cells and fills enclosed gaps up to `maxHole` cells. */
function tidy(m: Uint8Array, r: Raster, minIsland: number, maxHole: number): void {
  for (const c of components(m, r, 1, true)) if (c.cells.length < minIsland) for (const i of c.cells) m[i] = 0;
  for (const c of components(m, r, 0, false)) if (!c.border && c.cells.length <= maxHole) for (const i of c.cells) m[i] = 1;
}

/** Morphological closing (8-neighbourhood): joins site patches one cell apart. */
function close(m: Uint8Array, r: Raster): Uint8Array {
  const grow = (src: Uint8Array, v: number) => {
    const out = src.slice();
    for (let j = 0; j < r.ny; j++)
      for (let i = 0; i < r.nx; i++) {
        if (src[j * r.nx + i] === v) continue;
        for (const [di, dj] of N8) {
          const a = i + di;
          const b = j + dj;
          if (a >= 0 && b >= 0 && a < r.nx && b < r.ny && src[b * r.nx + a] === v) {
            out[j * r.nx + i] = v;
            break;
          }
        }
      }
    return out;
  };
  return grow(grow(m, 1), 0);
}

// ------------------------------------------------------------------------------ outlines

/** Separable Gaussian blur of a fine field, in place. */
function blur(f: Float32Array, nx: number, ny: number, sigma: number): void {
  const rad = Math.ceil(sigma * 3);
  const k: number[] = [];
  for (let i = -rad; i <= rad; i++) k.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  const sum = k.reduce((a, b) => a + b, 0);
  for (let i = 0; i < k.length; i++) k[i]! /= sum;
  const tmp = new Float32Array(f.length);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      let s = 0;
      for (let t = -rad; t <= rad; t++) {
        const a = i + t;
        if (a >= 0 && a < nx) s += f[j * nx + a]! * k[t + rad]!;
      }
      tmp[j * nx + i] = s;
    }
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      let s = 0;
      for (let t = -rad; t <= rad; t++) {
        const b = j + t;
        if (b >= 0 && b < ny) s += tmp[b * nx + i]! * k[t + rad]!;
      }
      f[j * nx + i] = s;
    }
}

/**
 * Marching squares at 0.5 over a field sampled at fine-cell centres. Returns closed rings in world
 * units (the field is zero at its border, so every contour closes).
 */
function contours(f: Float32Array, nx: number, ny: number, x0: number, y0: number, step: number): Ring[] {
  const T = 0.5;
  const v = (i: number, j: number) => f[j * nx + i]!;
  // Edge ids: horizontal edge from sample (i, j) to (i+1, j) = 2·idx, vertical to (i, j+1) = 2·idx+1.
  const H = (i: number, j: number) => (j * nx + i) * 2;
  const V = (i: number, j: number) => (j * nx + i) * 2 + 1;
  const segA: number[] = [];
  const segB: number[] = [];
  for (let j = 0; j < ny - 1; j++)
    for (let i = 0; i < nx - 1; i++) {
      const a = v(i, j);
      const b = v(i + 1, j);
      const c = v(i + 1, j + 1);
      const d = v(i, j + 1);
      const idx = (a >= T ? 1 : 0) | (b >= T ? 2 : 0) | (c >= T ? 4 : 0) | (d >= T ? 8 : 0);
      if (idx === 0 || idx === 15) continue;
      const bottom = H(i, j);
      const top = H(i, j + 1);
      const left = V(i, j);
      const right = V(i + 1, j);
      const add = (p: number, q: number) => {
        segA.push(p);
        segB.push(q);
      };
      const centre = (a + b + c + d) / 4 >= T;
      switch (idx) {
        case 1:
        case 14:
          add(left, bottom);
          break;
        case 2:
        case 13:
          add(bottom, right);
          break;
        case 3:
        case 12:
          add(left, right);
          break;
        case 4:
        case 11:
          add(right, top);
          break;
        case 6:
        case 9:
          add(bottom, top);
          break;
        case 7:
        case 8:
          add(left, top);
          break;
        case 5:
          if (centre) {
            add(bottom, right);
            add(left, top);
          } else {
            add(left, bottom);
            add(right, top);
          }
          break;
        case 10:
          if (centre) {
            add(left, bottom);
            add(right, top);
          } else {
            add(bottom, right);
            add(left, top);
          }
          break;
      }
    }
  const at = new Map<number, number[]>();
  for (let s = 0; s < segA.length; s++) {
    for (const e of [segA[s]!, segB[s]!]) {
      const l = at.get(e);
      if (l) l.push(s);
      else at.set(e, [s]);
    }
  }
  const point = (e: number): Pt => {
    const idx = e >> 1;
    const i = idx % nx;
    const j = (idx - i) / nx;
    const p = v(i, j);
    if ((e & 1) === 0) {
      const q = v(i + 1, j);
      const t = (T - p) / (q - p);
      return [x0 + (i + 0.5 + t) * step, y0 + (j + 0.5) * step];
    }
    const q = v(i, j + 1);
    const t = (T - p) / (q - p);
    return [x0 + (i + 0.5) * step, y0 + (j + 0.5 + t) * step];
  };
  const used = new Uint8Array(segA.length);
  const rings: Ring[] = [];
  for (let s0 = 0; s0 < segA.length; s0++) {
    if (used[s0]) continue;
    const ring: Ring = [];
    let s = s0;
    let e = segA[s0]!;
    for (;;) {
      used[s] = 1;
      ring.push(point(e));
      const next = segA[s] === e ? segB[s]! : segA[s]!;
      e = next;
      const ns = at.get(e)?.find((x) => !used[x]);
      if (ns === undefined) break;
      s = ns;
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

const area = (r: Ring): number => {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j]![0] - r[i]![0]) * (r[j]![1] + r[i]![1]);
  return s / 2;
};

/** Douglas–Peucker on an open polyline: the points kept (first and last always). */
function simplifyLine(pts: Pt[], tol: number): Pt[] {
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a]!;
    const dx = pts[b]![0] - ax;
    const dy = pts[b]![1] - ay;
    const len = Math.hypot(dx, dy);
    let best = -1;
    let bi = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i]!;
      const d = len === 0 ? Math.hypot(px - ax, py - ay) : Math.abs(dy * (px - ax) - dx * (py - ay)) / len;
      if (d > best) {
        best = d;
        bi = i;
      }
    }
    if (bi >= 0 && best > tol) {
      keep[bi] = 1;
      stack.push([a, bi], [bi, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Douglas–Peucker on a closed ring, split at the point farthest from the first. */
function simplify(ring: Ring, tol: number): Ring {
  if (ring.length < 8) return ring;
  let far = 0;
  let fd = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = Math.hypot(ring[i]![0] - ring[0]![0], ring[i]![1] - ring[0]![1]);
    if (d > fd) {
      fd = d;
      far = i;
    }
  }
  const out = [...simplifyLine(ring.slice(0, far + 1), tol), ...simplifyLine([...ring.slice(far), ring[0]!], tol).slice(1, -1)];
  return out.length >= 3 ? out : ring;
}

/** Square erosion (v = 0) or dilation (v = 1) of a mask by `rad` cells, separable. */
function morph(m: Uint8Array, r: Raster, rad: number, v: 0 | 1): Uint8Array {
  const pass = (src: Uint8Array, horizontal: boolean) => {
    const out = new Uint8Array(src.length);
    for (let j = 0; j < r.ny; j++)
      for (let i = 0; i < r.nx; i++) {
        let hit = false;
        for (let t = -rad; t <= rad && !hit; t++) {
          const a = horizontal ? i + t : i;
          const b = horizontal ? j : j + t;
          const val = a < 0 || b < 0 || a >= r.nx || b >= r.ny ? 0 : src[b * r.nx + a]!;
          if (val === v) hit = true;
        }
        out[j * r.nx + i] = hit ? v : 1 - v;
      }
    return out;
  };
  return pass(pass(m, true), false);
}

/**
 * The cell mask on the fine grid. With the map's collision grid, fine cells inside walls are left
 * out (a wall stands at every floor height known for the cell), so outlines follow the real walls
 * instead of the 64-unit cell edges.
 */
function refine(m: Uint8Array, r: Raster, floorsAt: (idx: number) => number[] | undefined, grid: VisibilityGrid | null): { mask: Uint8Array; raster: Raster } {
  const k = Math.max(1, Math.round(r.cell / FINE));
  const f: Raster = { cell: r.cell / k, x0: r.x0, y0: r.y0, nx: r.nx * k, ny: r.ny * k };
  let mask = new Uint8Array(f.nx * f.ny);
  for (let j = 0; j < r.ny; j++)
    for (let i = 0; i < r.nx; i++) {
      const idx = j * r.nx + i;
      if (!m[idx]) continue;
      const zs = grid ? floorsAt(idx) : undefined;
      for (let b = 0; b < k; b++)
        for (let a = 0; a < k; a++) {
          const fi = i * k + a;
          const fj = j * k + b;
          if (zs?.length) {
            const x = f.x0 + (fi + 0.5) * f.cell;
            const y = f.y0 + (fj + 0.5) * f.cell;
            if (zs.every((z) => WALL_HEIGHTS.every((h) => grid!.solidAt({ x, y, z: z + h })))) continue;
          }
          mask[fj * f.nx + fi] = 1;
        }
    }
  if (grid) {
    const rad = Math.round(OPEN_RADIUS / f.cell);
    mask = morph(morph(mask, f, rad, 0), f, rad, 1);
    // Opening never adds floor; keep it inside the cells.
    for (let i = 0; i < mask.length; i++) {
      const fi = i % f.nx;
      const fj = (i - fi) / f.nx;
      if (!m[Math.floor(fj / k) * r.nx + Math.floor(fi / k)]) mask[i] = 0;
    }
  }
  return { mask, raster: f };
}

/** Smooth outlines (world units) of a fine mask. */
function outline(m: Uint8Array, r: Raster, smooth: number, minArea: number): Ring[] {
  const pad = Math.ceil((smooth * 3) / r.cell) + 2;
  const nx = r.nx + pad * 2;
  const ny = r.ny + pad * 2;
  const f = new Float32Array(nx * ny);
  for (let j = 0; j < r.ny; j++) for (let i = 0; i < r.nx; i++) if (m[j * r.nx + i]) f[(pad + j) * nx + pad + i] = 1;
  blur(f, nx, ny, smooth / r.cell);
  return contours(f, nx, ny, r.x0 - pad * r.cell, r.y0 - pad * r.cell, r.cell).filter((ring) => Math.abs(area(ring)) >= minArea);
}

// ------------------------------------------------------------------------------ drawing

interface Sample {
  x: number;
  y: number;
  /** Cell edge (world units), centred on x/y. */
  size: number;
  z: number;
  /** z is a measured floor height (floor grid), not the middle of a height band. */
  floor: boolean;
  regionIndex: number | null;
}

/** Walkable samples of the pack: region cells (with the floor height the floor grid gives), floor-grid cells, polygon regions. */
function samples(rt: MapRuntime): Sample[] {
  const pack = rt.pack;
  const out: Sample[] = [];
  const floorCell = pack.floorGrid?.cellSize ?? null;
  const floors = new Map<string, number[]>();
  for (const row of pack.floorGrid?.cells ?? []) {
    const [ix, iy, ...zs] = row;
    if (ix === undefined || iy === undefined) continue;
    floors.set(`${ix},${iy}`, zs);
    for (const z of zs) out.push({ x: (ix + 0.5) * floorCell!, y: (iy + 0.5) * floorCell!, size: floorCell!, z, floor: true, regionIndex: null });
  }
  pack.regions.forEach((region, ri) => {
    for (const sh of region.shapes) {
      if (sh.kind === "cells") {
        for (const [ix, iy, iz] of sh.cells) {
          const x = (ix + 0.5) * sh.cellSize;
          const y = (iy + 0.5) * sh.cellSize;
          const lo = iz * sh.zCellSize;
          const mid = lo + sh.zCellSize / 2;
          const zs = floorCell ? (floors.get(`${Math.floor(x / floorCell)},${Math.floor(y / floorCell)}`) ?? []).filter((z) => z >= lo - 24 && z < lo + sh.zCellSize + 24) : [];
          const z = zs.length ? zs.reduce((best, z) => (Math.abs(z - mid) < Math.abs(best - mid) ? z : best)) : mid;
          out.push({ x, y, size: sh.cellSize, z, floor: zs.length > 0, regionIndex: ri });
        }
        continue;
      }
      // Polygon regions: sampled every 32 units.
      const xs = sh.points.map((p) => p[0]);
      const ys = sh.points.map((p) => p[1]);
      for (let x = Math.floor(Math.min(...xs) / 32) * 32 + 16; x < Math.max(...xs); x += 32)
        for (let y = Math.floor(Math.min(...ys) / 32) * 32 + 16; y < Math.max(...ys); y += 32)
          if (pointInPolygon(x, y, sh.points)) out.push({ x, y, size: 32, z: (sh.zMin + sh.zMax) / 2, floor: false, regionIndex: ri });
    }
  });
  return out;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const pathData = (rings: Ring[]) => rings.map((ring) => `M${ring.map(([x, y]) => `${r1(x)} ${r1(y)}`).join("L")}Z`).join("");

/** Draws the clean radar of a map in a frame; null when the pack has no geometry for it. */
export function drawCleanRadar(rt: MapRuntime, frame: CleanRadarFrame, builtin?: BuiltinRadar): CleanRadarDrawing | null {
  const fr = frame === "builtin" ? (builtin ? builtinFrame(builtin) : null) : frame === "calibrated" ? calibratedFrame(rt) : schematicFrame(rt);
  if (!fr) return null;
  const all = samples(rt);
  if (!all.length) return null;
  const cell = Math.min(...all.map((s) => s.size));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of all) {
    minX = Math.min(minX, s.x - s.size / 2);
    minY = Math.min(minY, s.y - s.size / 2);
    maxX = Math.max(maxX, s.x + s.size / 2);
    maxY = Math.max(maxY, s.y + s.size / 2);
  }
  const r: Raster = { cell, x0: Math.floor(minX / cell) * cell - cell * 2, y0: Math.floor(minY / cell) * cell - cell * 2, nx: 0, ny: 0 };
  r.nx = Math.ceil((maxX - r.x0) / cell) + 2;
  r.ny = Math.ceil((maxY - r.y0) / cell) + 2;
  const isSite = (ri: number | null) => ri !== null && rt.pack.regions[ri]?.kind === "bombsite";
  const masks = new Map<FrameLayer, { floor: Uint8Array; site: Uint8Array; heights: Map<number, number[]> }>();
  const maskOf = (l: FrameLayer) => {
    let m = masks.get(l);
    if (!m) masks.set(l, (m = { floor: new Uint8Array(r.nx * r.ny), site: new Uint8Array(r.nx * r.ny), heights: new Map() }));
    return m;
  };
  for (const s of all) {
    const l = fr.layerAt(s.z);
    if (!l) continue;
    const m = maskOf(l);
    const n = Math.max(1, Math.round(s.size / cell));
    const i0 = Math.floor((s.x - s.size / 2 - r.x0) / cell + 1e-6);
    const j0 = Math.floor((s.y - s.size / 2 - r.y0) / cell + 1e-6);
    for (let b = 0; b < n; b++)
      for (let a = 0; a < n; a++) {
        const idx = (j0 + b) * r.nx + i0 + a;
        m.floor[idx] = 1;
        if (isSite(s.regionIndex)) m.site[idx] = 1;
        if (s.floor) {
          const hs = m.heights.get(idx);
          if (!hs) m.heights.set(idx, [s.z]);
          else if (!hs.includes(s.z)) hs.push(s.z);
        }
      }
  }
  const minArea = cell * cell * 1.5;
  const grid = rt.grid;
  const smooth = grid ? SMOOTH_WALLS : SMOOTH_CELLS;
  const tol = SIMPLIFY_PX;
  const toRings = (rings: Ring[], l: FrameLayer): Ring[] =>
    rings
      .map((ring) => ring.map(([x, y]) => l.toPx(x, y)).filter((p): p is Pt => p !== null))
      .filter((ring) => ring.length >= 3)
      .map((ring) => simplify(ring, tol));
  const ordered = [...masks.keys()].sort((a, b) => a.rank - b.rank);
  const topRank = ordered.length ? ordered[ordered.length - 1]!.rank : 0;
  const layers = ordered.map((l) => {
    const m = masks.get(l)!;
    tidy(m.floor, r, MIN_ISLAND, MAX_HOLE);
    let site = close(m.site, r);
    for (let i = 0; i < site.length; i++) site[i] = site[i]! & m.floor[i]!;
    tidy(site, r, MIN_ISLAND, MAX_SITE_HOLE);
    site = site.map((v, i) => v & m.floor[i]!);
    m.site = site;
    const floor = refine(m.floor, r, (idx) => m.heights.get(idx), grid);
    const k = floor.raster.nx / r.nx;
    tidy(floor.mask, floor.raster, MIN_ISLAND * k * k, MAX_HOLE * k * k);
    const fineSite = refine(site, r, () => undefined, null).mask.map((v, i) => v & floor.mask[i]!);
    return { layer: l, id: l.id, lower: l.rank < topRank, floor: toRings(outline(floor.mask, floor.raster, smooth, minArea), l), sites: toRings(outline(fineSite, floor.raster, smooth, minArea), l) };
  });
  // Bombsite letters: on the site cell nearest the middle of the region's cells.
  const labels: CleanRadarDrawing["labels"] = [];
  for (const b of rt.pack.bombsites) {
    const ri = rt.pack.regions.findIndex((x) => x.id === b.regionId);
    const cells = all.filter((s) => s.regionIndex === ri);
    if (ri < 0 || !cells.length) continue;
    const votes = new Map<FrameLayer, number>();
    for (const c of cells) {
      const l = fr.layerAt(c.z);
      if (l) votes.set(l, (votes.get(l) ?? 0) + 1);
    }
    const l = [...votes.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
    if (!l) continue;
    const mine = cells.filter((c) => fr.layerAt(c.z) === l);
    const cx = mine.reduce((s, c) => s + c.x, 0) / mine.length;
    const cy = mine.reduce((s, c) => s + c.y, 0) / mine.length;
    const site = masks.get(l)!.site;
    let best: Sample | null = null;
    let bd = Infinity;
    for (const c of mine) {
      const idx = Math.floor((c.y - r.y0) / cell) * r.nx + Math.floor((c.x - r.x0) / cell);
      const d = Math.hypot(c.x - cx, c.y - cy);
      if (site[idx] && d < bd) {
        bd = d;
        best = c;
      }
    }
    const p = best ? l.toPx(best.x, best.y) : null;
    if (p) labels.push({ text: b.site, x: p[0], y: p[1] });
  }
  const parts: string[] = [];
  for (const l of layers) {
    if (!l.floor.length) continue;
    const floor = pathData(l.floor);
    parts.push(`<path d="${floor}" fill="${l.lower ? STYLE.floorLower : STYLE.floor}"/>`);
    if (l.sites.length) parts.push(`<path d="${pathData(l.sites)}" fill="${STYLE.site}" fill-opacity="${STYLE.siteOpacity}" stroke="${STYLE.siteEdge}" stroke-width="${STYLE.siteEdgeWidth}" stroke-opacity="0.9"/>`);
    parts.push(`<path d="${floor}" fill="none" stroke="${STYLE.wall}" stroke-width="${STYLE.wallWidth}" stroke-linejoin="round"/>`);
  }
  const text = labels.map((t) => `<text x="${r1(t.x)}" y="${r1(t.y)}">${t.text}</text>`).join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">` +
    `<g fill-rule="evenodd">${parts.join("")}</g>` +
    (text ? `<g fill="${STYLE.label}" fill-opacity="0.92" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="${STYLE.labelSize}" text-anchor="middle" dominant-baseline="central">${text}</g>` : "") +
    `</svg>`;
  return { size: SIZE, layers: layers.map(({ id, lower, floor, sites }) => ({ id, lower, floor, sites })), labels, svg };
}

/** Even-odd point-in-rings test (image pixels). */
export function insideRings(rings: Ring[], x: number, y: number): boolean {
  let inside = false;
  for (const ring of rings) if (pointInPolygon(x, y, ring)) inside = !inside;
  return inside;
}

/**
 * Clean radars of the loaded maps, drawn on first request and kept while the map pack (and, for a
 * calibrated image, its calibration) stays the same.
 */
export class CleanRadars {
  /** Per map pack and frame: the drawing's version (its address) and, once drawn, the SVG. */
  private readonly cache = new WeakMap<MapRuntime, Map<CleanRadarFrame, { version: string; svg?: string | null }>>();

  constructor(private readonly builtin: (mapName: string) => BuiltinRadar | undefined) {}

  private entry(rt: MapRuntime, frame: CleanRadarFrame): { version: string; svg?: string | null } {
    let byFrame = this.cache.get(rt);
    if (!byFrame) this.cache.set(rt, (byFrame = new Map()));
    let hit = byFrame.get(frame);
    if (!hit) {
      const cal = frame === "calibrated" ? JSON.stringify([rt.pack.radar, rt.levels().map((l) => [l.id, l.zMin, l.zMax, l.radar])]) : "";
      const b = frame === "builtin" ? JSON.stringify(this.builtin(rt.mapName)?.layers ?? null) : "";
      const version = createHash("sha256").update(`${CLEAN_RADAR_VERSION}|${frame}|${rt.pack.mapRevision}|${cal}|${b}`).digest("hex").slice(0, 12);
      byFrame.set(frame, (hit = { version }));
    }
    return hit;
  }

  /** The overlay-server address of the map's clean radar in this frame; null when there is no geometry to draw. */
  url(rt: MapRuntime | undefined, frame: CleanRadarFrame): string | null {
    if (!rt || !rt.schematicTransform() || (frame === "builtin" && !this.builtin(rt.mapName))) return null;
    const e = this.entry(rt, frame);
    if (e.svg === null) return null;
    return `/overlay-api/radar-clean/${encodeURIComponent(rt.mapName)}/${frame}?v=${e.version}`;
  }

  svg(rt: MapRuntime | undefined, frame: CleanRadarFrame): string | null {
    if (!rt) return null;
    const e = this.entry(rt, frame);
    if (e.svg === undefined) e.svg = drawCleanRadar(rt, frame, this.builtin(rt.mapName))?.svg ?? null;
    return e.svg;
  }
}
