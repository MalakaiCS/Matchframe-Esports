import type { Vec3 } from "@matchframe/contracts";

/** What a `.grid` file says about itself (scripts/generate-map-grids.py). */
export interface GridHeader {
  map: string;
  build: string;
  /** Cell edge in Hammer units. */
  cell: number;
  origin: [number, number, number];
  dims: [number, number, number];
}

/** Two players see each other when a sightline between their eyes is clear, or one 8 units higher (a head over low cover). */
const HEAD_RAISE = 8;

/**
 * Free-space grid of a map, derived from CS2's collision geometry: a cell is solid when a collision
 * triangle passes through it. Checked against the exact geometry on 1,500 eye-to-eye sightlines per
 * map: it misses 5–13 % of the clear ones and almost never sees through a wall (at most 1 of ~1,350).
 * See-through and non-solid props (glass, fences, foliage) are not in collision geometry, so not in
 * the grid either.
 */
export class VisibilityGrid {
  private readonly cell: number;
  private readonly ox: number;
  private readonly oy: number;
  private readonly oz: number;
  private readonly nx: number;
  private readonly ny: number;
  private readonly nz: number;

  constructor(
    readonly header: GridHeader,
    private readonly bits: Uint8Array,
  ) {
    this.cell = header.cell;
    [this.ox, this.oy, this.oz] = header.origin;
    [this.nx, this.ny, this.nz] = header.dims;
    const need = Math.ceil((this.nx * this.ny * this.nz) / 8);
    if (bits.length < need) throw new Error(`grid for ${header.map} has ${bits.length} bytes of cells, needs ${need}`);
  }

  /**
   * Reads a `.grid` file: b"MFGR", u32 header length, the header JSON, then the zlib-compressed
   * bitset (inflated by the caller's zlib, so this package needs no Node APIs).
   */
  static parse(file: Uint8Array, inflate: (compressed: Uint8Array) => Uint8Array): VisibilityGrid {
    if (file.length < 8 || String.fromCharCode(file[0]!, file[1]!, file[2]!, file[3]!) !== "MFGR") throw new Error("not a Matchframe grid file");
    const len = new DataView(file.buffer, file.byteOffset + 4, 4).getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(file.subarray(8, 8 + len))) as GridHeader;
    if (!(header.cell > 0) || header.origin?.length !== 3 || header.dims?.length !== 3) throw new Error("grid header is incomplete");
    return new VisibilityGrid(header, inflate(file.subarray(8 + len)));
  }

  get map(): string {
    return this.header.map;
  }

  /** Whether the cell holding this point is solid (outside the grid counts as free). */
  solidAt(p: Vec3): boolean {
    const x = Math.floor((p.x - this.ox) / this.cell);
    const y = Math.floor((p.y - this.oy) / this.cell);
    const z = Math.floor((p.z - this.oz) / this.cell);
    if (x < 0 || y < 0 || z < 0 || x >= this.nx || y >= this.ny || z >= this.nz) return false;
    const i = (z * this.ny + y) * this.nx + x;
    return (this.bits[i >> 3]! & (1 << (i & 7))) !== 0;
  }

  /** No solid cell along the segment, sampled a quarter cell apart; `skipEnds` units at each end are not checked. */
  segmentClear(a: Vec3, b: Vec3, skipEnds = this.cell): boolean {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dy, dz);
    const n = Math.floor(length / (this.cell / 4)) + 1;
    for (let i = 1; i < n; i++) {
      const t = i / n;
      if (t * length <= skipEnds || (1 - t) * length <= skipEnds) continue;
      if (this.solidAt({ x: a.x + dx * t, y: a.y + dy * t, z: a.z + dz * t })) return false;
    }
    return true;
  }

  /** Whether two eye positions see each other (eye to eye, or a head's height over low cover). */
  lineOfSight(a: Vec3, b: Vec3): boolean {
    if (this.segmentClear(a, b)) return true;
    return this.segmentClear({ x: a.x, y: a.y, z: a.z + HEAD_RAISE }, { x: b.x, y: b.y, z: b.z + HEAD_RAISE });
  }

  /** Free space of `radius` around a point: its cell and six axis directions clear. */
  clearAround(p: Vec3, radius: number): boolean {
    if (this.solidAt(p)) return false;
    for (const [x, y, z] of [[radius, 0, 0], [-radius, 0, 0], [0, radius, 0], [0, -radius, 0], [0, 0, radius], [0, 0, -radius]] as const) {
      if (!this.segmentClear(p, { x: p.x + x, y: p.y + y, z: p.z + z }, 0)) return false;
    }
    return true;
  }
}
