import type { Vec3 } from "@matchframe/contracts";
import type { VisibilityGrid } from "./grid.ts";

/** A column of the walking graph is this many grid cells square (24 units with 12-unit cells). */
const COLUMN_CELLS = 2;
/** Free cells a floor needs above it: 60 units, room for a crouching player (54 tall). */
const HEAD_CELLS = 5;
/** Floors of one column within this many cells of each other are one floor (a slope, a step). */
const MERGE_CELLS = 2;
/** A floor counts in a column when at least this many of its sub-columns stand on it. */
const MIN_SUBCOLUMNS = 2;
/** Highest step up between neighbouring columns (a crouch jump), and the furthest drop down. */
const STEP_UP = 64;
const DROP = 260;
/** Height above the floor of the line tested between neighbouring columns (a body's middle). */
const BODY = 36;
/**
 * A position snaps to a floor this far below or above its feet (a jump is about 55 units high),
 * within this many columns round it; a player falling lands on the floor under them, up to DROP below.
 */
const SNAP_BELOW = 72;
const SNAP_ABOVE = 40;
const SNAP_RING = 2;

/**
 * Walking distance on a map, from its free-space grid (CS2's collision geometry, see VisibilityGrid).
 * The floor of every 24-unit column is where a solid cell has 60 units of free space above it; two
 * neighbouring floors (eight directions) are joined when a body-height line between them is clear and
 * the second is at most a crouch jump (64 units) higher, or up to 260 units lower (a drop, one way).
 * Distances follow the floors round walls, up stairs and over crates, not straight lines.
 *
 * What it can't know: ladders (no floor joins them), boosts, and see-through or non-solid props
 * (glass, fences, foliage), which aren't in collision geometry. A position it can't place, or a goal
 * it can't reach, gives null: callers fall back to a straight line.
 */
export class WalkGraph {
  private readonly cellSize: number;
  private readonly ox: number;
  private readonly oy: number;
  private readonly ncx: number;
  private readonly ncy: number;
  /** Nodes sorted by column, then height: column c holds nodes colStart[c] .. colStart[c+1]-1. */
  private readonly colStart: Int32Array;
  private readonly nodeX: Float32Array;
  private readonly nodeY: Float32Array;
  private readonly nodeZ: Float32Array;
  /** Reverse adjacency (who can walk into each node), compressed: inStart[n] .. inStart[n+1]-1. */
  private readonly inStart: Int32Array;
  private readonly inFrom: Int32Array;
  private readonly inCost: Float32Array;
  // Search buffers, reused between queries.
  private readonly dist: Float64Array;
  private readonly stamp: Int32Array;
  private readonly settled: Int32Array;
  private epoch = 0;
  private heapD = new Float64Array(1024);
  private heapN = new Int32Array(1024);

  private constructor(parts: {
    cellSize: number;
    ox: number;
    oy: number;
    ncx: number;
    ncy: number;
    colStart: Int32Array;
    nodeX: Float32Array;
    nodeY: Float32Array;
    nodeZ: Float32Array;
    inStart: Int32Array;
    inFrom: Int32Array;
    inCost: Float32Array;
  }) {
    this.cellSize = parts.cellSize;
    this.ox = parts.ox;
    this.oy = parts.oy;
    this.ncx = parts.ncx;
    this.ncy = parts.ncy;
    this.colStart = parts.colStart;
    this.nodeX = parts.nodeX;
    this.nodeY = parts.nodeY;
    this.nodeZ = parts.nodeZ;
    this.inStart = parts.inStart;
    this.inFrom = parts.inFrom;
    this.inCost = parts.inCost;
    this.dist = new Float64Array(parts.nodeX.length);
    this.stamp = new Int32Array(parts.nodeX.length);
    this.settled = new Int32Array(parts.nodeX.length);
  }

  get nodeCount(): number {
    return this.nodeX.length;
  }

  get edgeCount(): number {
    return this.inFrom.length;
  }

  /** Builds the graph from a map's free-space grid (about 0.1–0.3 s for an active-duty map). */
  static build(grid: VisibilityGrid): WalkGraph {
    const { cell } = grid.header;
    const [ox, oy, oz] = grid.header.origin;
    const [nx, ny, nz] = grid.header.dims;
    const cw = COLUMN_CELLS;
    const ncx = Math.ceil(nx / cw);
    const ncy = Math.ceil(ny / cw);
    const colStart = new Int32Array(ncx * ncy + 1);
    const xs: number[] = [];
    const ys: number[] = [];
    const zs: number[] = [];
    const solid = new Uint8Array(nz);
    const found: { f: number; ix: number; iy: number }[] = [];
    for (let cy = 0; cy < ncy; cy++) {
      for (let cx = 0; cx < ncx; cx++) {
        colStart[cy * ncx + cx] = xs.length;
        found.length = 0;
        for (let iy = cy * cw; iy < Math.min(ny, cy * cw + cw); iy++) {
          for (let ix = cx * cw; ix < Math.min(nx, cx * cw + cw); ix++) {
            for (let k = 0; k < nz; k++) solid[k] = grid.solidCell(ix, iy, k) ? 1 : 0;
            // A floor: a solid cell with HEAD_CELLS free cells above it (above the grid counts as free).
            let freeAbove = 0;
            for (let k = nz - 1; k >= 0; k--) {
              if (solid[k]) {
                if (freeAbove >= HEAD_CELLS || k + freeAbove === nz - 1) found.push({ f: k + 1, ix, iy });
                freeAbove = 0;
              } else freeAbove++;
            }
          }
        }
        if (found.length === 0) continue;
        found.sort((a, b) => a.f - b.f);
        // One node per floor (found is in height order, so the column's nodes are too).
        let i = 0;
        while (i < found.length) {
          let j = i + 1;
          while (j < found.length && found[j]!.f - found[j - 1]!.f <= MERGE_CELLS) j++;
          const members = found.slice(i, j);
          const subs = new Set(members.map((m) => m.ix * 100003 + m.iy));
          if (subs.size >= MIN_SUBCOLUMNS) {
            const top = Math.max(...members.map((m) => m.f));
            xs.push(ox + (members.reduce((s, m) => s + m.ix, 0) / members.length + 0.5) * cell);
            ys.push(oy + (members.reduce((s, m) => s + m.iy, 0) / members.length + 0.5) * cell);
            zs.push(oz + top * cell);
          }
          i = j;
        }
      }
    }
    colStart[ncx * ncy] = xs.length;
    const n = xs.length;
    const nodeX = Float32Array.from(xs);
    const nodeY = Float32Array.from(ys);
    const nodeZ = Float32Array.from(zs);

    const quarter = cell / 4;
    const clear = (ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean => {
      const dx = bx - ax;
      const dy = by - ay;
      const dz = bz - az;
      const steps = Math.floor(Math.hypot(dx, dy, dz) / quarter) + 1;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        if (grid.solidCell(Math.floor((ax + dx * t - ox) / cell), Math.floor((ay + dy * t - oy) / cell), Math.floor((az + dz * t - oz) / cell))) return false;
      }
      return true;
    };

    // Edges into each node: from u to v when v is walkable from u (see the class comment).
    const from: number[] = [];
    const to: number[] = [];
    const cost: number[] = [];
    for (let cy = 0; cy < ncy; cy++) {
      for (let cx = 0; cx < ncx; cx++) {
        const c = cy * ncx + cx;
        for (let u = colStart[c]!; u < colStart[c + 1]!; u++) {
          const ux = nodeX[u]!;
          const uy = nodeY[u]!;
          const uz = nodeZ[u]!;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nxc = cx + dx;
              const nyc = cy + dy;
              if (nxc < 0 || nyc < 0 || nxc >= ncx || nyc >= ncy) continue;
              const d = nyc * ncx + nxc;
              for (let v = colStart[d]!; v < colStart[d + 1]!; v++) {
                const vx = nodeX[v]!;
                const vy = nodeY[v]!;
                const vz = nodeZ[v]!;
                const rise = vz - uz;
                if (rise > STEP_UP || -rise > DROP) continue;
                const ok = rise >= -STEP_UP ? clear(ux, uy, uz + BODY, vx, vy, vz + BODY) : clear(ux, uy, uz + BODY, vx, vy, uz + BODY) && clear(vx, vy, uz + BODY, vx, vy, vz + BODY);
                if (!ok) continue;
                from.push(u);
                to.push(v);
                cost.push(Math.hypot(vx - ux, vy - uy, Math.max(0, rise)));
              }
            }
          }
        }
      }
    }
    const inStart = new Int32Array(n + 1);
    for (const v of to) inStart[v + 1]!++;
    for (let i = 0; i < n; i++) inStart[i + 1]! += inStart[i]!;
    const fill = inStart.slice(0, n);
    const inFrom = new Int32Array(from.length);
    const inCost = new Float32Array(from.length);
    for (let e = 0; e < from.length; e++) {
      const slot = fill[to[e]!]!++;
      inFrom[slot] = from[e]!;
      inCost[slot] = cost[e]!;
    }
    return new WalkGraph({ cellSize: cell * cw, ox, oy, ncx, ncy, colStart, nodeX, nodeY, nodeZ, inStart, inFrom, inCost });
  }

  /** The floor node a position stands on (or the nearest within two columns), and how far off it is. */
  private snap(p: Vec3): { node: number; offset: number } | null {
    const cx = Math.floor((p.x - this.ox) / this.cellSize);
    const cy = Math.floor((p.y - this.oy) / this.cellSize);
    for (let r = 0; r <= SNAP_RING; r++) {
      let best: { node: number; offset: number; score: number } | null = null;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= this.ncx || y >= this.ncy) continue;
          const c = y * this.ncx + x;
          for (let v = this.colStart[c]!; v < this.colStart[c + 1]!; v++) {
            const dz = this.nodeZ[v]! - p.z;
            if (dz < -SNAP_BELOW || dz > SNAP_ABOVE) continue;
            const offset = Math.hypot(this.nodeX[v]! - p.x, this.nodeY[v]! - p.y);
            const score = offset + Math.abs(dz);
            if (!best || score < best.score) best = { node: v, offset, score };
          }
        }
      }
      // The ring a node was found in holds the nearest one well enough.
      if (best) return { node: best.node, offset: best.offset };
    }
    // In the air (a drop): the highest floor under them.
    if (cx >= 0 && cy >= 0 && cx < this.ncx && cy < this.ncy) {
      const c = cy * this.ncx + cx;
      for (let v = this.colStart[c + 1]! - 1; v >= this.colStart[c]!; v--) {
        const dz = this.nodeZ[v]! - p.z;
        if (dz <= 0 && dz >= -DROP) return { node: v, offset: Math.hypot(this.nodeX[v]! - p.x, this.nodeY[v]! - p.y) };
      }
    }
    return null;
  }

  /**
   * How far each of `from` has to walk to reach `goal` (units along the floors): Infinity when it
   * doesn't get there within `maxUnits` (or at all), null when the goal or that position can't be
   * placed on the graph. One search from the goal, along the edges backwards, answers all of them.
   */
  distancesTo(goal: Vec3, from: readonly Vec3[], maxUnits = 6000): (number | null)[] {
    const g = this.snap(goal);
    return this.search(g ? [{ node: g.node, d: 0 }] : [], g?.offset ?? 0, from, maxUnits);
  }

  /**
   * How far each of `from` has to walk to reach the nearest of `goals` (an area, such as a bombsite's
   * cells): as distancesTo, in one search from all of them. Goals that can't be placed are left out;
   * with none placed, every answer is null.
   */
  distancesToNearest(goals: readonly Vec3[], from: readonly Vec3[], maxUnits = 6000): (number | null)[] {
    const seeds = new Map<number, number>();
    for (const p of goals) {
      const g = this.snap(p);
      const had = g ? seeds.get(g.node) : undefined;
      if (g && (had === undefined || g.offset < had)) seeds.set(g.node, g.offset);
    }
    return this.search([...seeds].map(([node, d]) => ({ node, d })), 0, from, maxUnits);
  }

  /** One search back from `seeds` (each node with its start distance); `extra` is added to every answer. */
  private search(seeds: readonly { node: number; d: number }[], extra: number, from: readonly Vec3[], maxUnits: number): (number | null)[] {
    const sources = from.map((p) => this.snap(p));
    const out: (number | null)[] = sources.map((s) => (s && seeds.length ? Infinity : null));
    if (!seeds.length) return out;
    let waiting = 0;
    const want = new Map<number, number[]>();
    sources.forEach((s, i) => {
      if (!s) return;
      const list = want.get(s.node);
      if (list) list.push(i);
      else {
        want.set(s.node, [i]);
        waiting++;
      }
    });
    if (waiting === 0) return out;
    this.epoch++;
    if (this.epoch === 0x7fffffff) {
      this.stamp.fill(0);
      this.settled.fill(0);
      this.epoch = 1;
    }
    const ep = this.epoch;
    let size = 0;
    const push = (node: number, d: number) => {
      if (size === this.heapD.length) {
        const nd = new Float64Array(size * 2);
        nd.set(this.heapD);
        const nn = new Int32Array(size * 2);
        nn.set(this.heapN);
        this.heapD = nd;
        this.heapN = nn;
      }
      let i = size++;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (this.heapD[parent]! <= d) break;
        this.heapD[i] = this.heapD[parent]!;
        this.heapN[i] = this.heapN[parent]!;
        i = parent;
      }
      this.heapD[i] = d;
      this.heapN[i] = node;
    };
    const pop = (): number => {
      const top = this.heapN[0]!;
      const lastD = this.heapD[--size]!;
      const lastN = this.heapN[size]!;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= size) break;
        const r = l + 1;
        const c = r < size && this.heapD[r]! < this.heapD[l]! ? r : l;
        if (this.heapD[c]! >= lastD) break;
        this.heapD[i] = this.heapD[c]!;
        this.heapN[i] = this.heapN[c]!;
        i = c;
      }
      this.heapD[i] = lastD;
      this.heapN[i] = lastN;
      return top;
    };
    for (const sd of seeds) {
      this.dist[sd.node] = sd.d;
      this.stamp[sd.node] = ep;
      push(sd.node, sd.d);
    }
    while (size > 0 && waiting > 0) {
      const d0 = this.heapD[0]!;
      const u = pop();
      if (this.settled[u] === ep || d0 > this.dist[u]!) continue;
      if (d0 > maxUnits) break;
      this.settled[u] = ep;
      const hit = want.get(u);
      if (hit) {
        for (const i of hit) out[i] = d0 + extra + sources[i]!.offset;
        waiting--;
      }
      for (let e = this.inStart[u]!; e < this.inStart[u + 1]!; e++) {
        const w = this.inFrom[e]!;
        const nd = d0 + this.inCost[e]!;
        if (this.stamp[w] !== ep || nd < this.dist[w]!) {
          this.stamp[w] = ep;
          this.dist[w] = nd;
          push(w, nd);
        }
      }
    }
    return out;
  }

  /** How far `a` has to walk to reach `b`: Infinity beyond `maxUnits`, null off the graph (see distancesTo). */
  distance(a: Vec3, b: Vec3, maxUnits = 6000): number | null {
    return this.distancesTo(b, [a], maxUnits)[0] ?? null;
  }
}

const graphs = new WeakMap<VisibilityGrid, WalkGraph>();

/** The walking graph of a free-space grid, built the first time it is asked for and kept with the grid. */
export function walkGraphFor(grid: VisibilityGrid): WalkGraph {
  let g = graphs.get(grid);
  if (!g) {
    g = WalkGraph.build(grid);
    graphs.set(grid, g);
  }
  return g;
}
