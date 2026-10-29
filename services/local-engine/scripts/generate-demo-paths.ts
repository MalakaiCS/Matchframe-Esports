/**
 * Camera paths from real play: 200-300 per map, built where players walked and fought in read
 * demos (scripts/demo-path-anchors.py) and flown through the map's free-space grid before keeping.
 *
 * Run: pnpm exec tsx services/local-engine/scripts/generate-demo-paths.ts --anchors DIR --out DIR [--maps de_mirage,de_nuke]
 * Writes DIR/<map>.json ({ map, matches, paths: CameraPath[] }) and a report;
 * scripts/merge-demo-paths.py puts them in the map packs.
 *
 * Shots:
 * - route: flies along a stretch players really ran (smoothed), a little behind and above them,
 *   looking 1.5 s ahead down the route (rotations, entries, the way out of spawn);
 * - orbit / push-in / pull-out / crane / slide: round, towards, away from, up over or across a place
 *   where fights happened (kills, plants) or where a team stands in freeze time, looking at it.
 * Every candidate is sampled the way the program flies it (samplePath, every 60 ms) and kept only
 * when, in the grid, the camera has room around it, floor somewhere below, nothing between one
 * sample and the next, no wall filling the picture, and the place it looks at in view; speed and
 * turning are capped. The grid is CS2's collision geometry: foliage, glass and other non-solid props
 * are not in it, so the camera walkthrough (Keep/Hide) is where those get caught.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { inflateSync } from "node:zlib";
import { MapPack, type CameraPath, type Vec3 } from "@matchframe/contracts";
import { MapRuntime, VisibilityGrid } from "@matchframe/map-runtime";
import { samplePath } from "@matchframe/observer-agent";

type P3 = [number, number, number];
interface Anchors {
  map: string;
  matches: number;
  routes: { side: "T" | "CT"; t: number; pts: P3[] }[];
  kills: { v: P3; a: P3 | null }[];
  plants: P3[];
  freeze: { side: "T" | "CT"; p: P3 }[];
  /** 64-unit cells: cx, cy, floor z, samples of a living player there. */
  floor: [number, number, number, number][];
}
type Style = "route" | "orbit" | "push" | "pull" | "crane" | "slide";
interface Spot {
  x: number;
  y: number;
  z: number;
  w: number;
  kind: "fight" | "busy" | "spawn_T" | "spawn_CT";
}
interface Candidate {
  style: Style;
  spot: number; // index into spots, -1 for routes
  keys: CameraPath["keyframes"];
  focus: Vec3 | null;
  score: number;
  sig: Vec3[]; // start, middle, end (similarity)
  angle: number; // around the spot (deg), for spreading
  maxSpeed: number;
  regions: string[];
  label: string;
}

const EYE = 48; // look at chest height
const ROOM = 20; // free space around the camera
const OVER_FLOOR_CELLS = 1; // the camera over walkable floor or the cell next to it (64 units)
const STEP_MS = 60; // samples when checking a path
const KEY_MS = 500; // keyframes this far apart
const FLOOR_BELOW = 900; // something solid within this far under the camera
const MAX_SPEED = { route: 320, orbit: 230, push: 230, pull: 230, crane: 230, slide: 230 } as const;
const MAX_YAW_RATE = { route: 60, orbit: 40, push: 40, pull: 40, crane: 40, slide: 40 } as const; // degrees a second
/** Share of a shot's samples that may have a wall near the lens' view (never right at it) or the target hidden. */
const SOFT = 0.15;
const QUOTA: Record<Style, number> = { route: 90, orbit: 70, push: 30, pull: 25, crane: 25, slide: 30 };
const PER_SPOT: Record<Exclude<Style, "route">, number> = { orbit: 5, push: 3, pull: 2, crane: 2, slide: 3 };
const MIN_PATHS = 200;
const MAX_PATHS = 300;
const LABEL: Record<Style, string> = { route: "Route", orbit: "Orbit", push: "Push-in", pull: "Pull-out", crane: "Crane", slide: "Slide" };

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const wrap = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
function aim(from: Vec3, to: Vec3): { pitch: number; yaw: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return { pitch: deg(Math.atan2(from.z - to.z, Math.hypot(dx, dy))), yaw: deg(Math.atan2(dy, dx)) };
}
const forward = (pitch: number, yaw: number): Vec3 => ({ x: Math.cos(rad(pitch)) * Math.cos(rad(yaw)), y: Math.cos(rad(pitch)) * Math.sin(rad(yaw)), z: -Math.sin(rad(pitch)) });

/** Why shots were turned down (diagnostics, in the report). */
export const REJECTED: Record<string, number> = {};
const no = (why: string): null => {
  REJECTED[why] = (REJECTED[why] ?? 0) + 1;
  return null;
};

class Checker {
  private readonly top: number;
  private readonly lo: Vec3;
  private readonly hi: Vec3;
  /**
   * @param overFloor 64-unit cells (`ix,iy`) over or near walkable floor: the camera stays above the
   * map, never out over the roofs and the scenery beyond it (unfinished in places).
   */
  constructor(
    private readonly g: VisibilityGrid,
    private readonly overFloor: ReadonlySet<string>,
  ) {
    const h = g.header;
    this.lo = { x: h.origin[0], y: h.origin[1], z: h.origin[2] };
    this.hi = { x: h.origin[0] + h.dims[0] * h.cell, y: h.origin[1] + h.dims[1] * h.cell, z: h.origin[2] + h.dims[2] * h.cell };
    this.top = this.hi.z - 48;
  }
  private inside(p: Vec3): boolean {
    return p.x > this.lo.x + 32 && p.y > this.lo.y + 32 && p.x < this.hi.x - 32 && p.y < this.hi.y - 32 && p.z < this.top && p.z > this.lo.z + 32;
  }
  /** Distance to the first solid cell along `dir` (up to `max`). */
  ray(p: Vec3, dir: Vec3, max: number): number {
    for (let d = 8; d <= max; d += 6) if (this.g.solidAt({ x: p.x + dir.x * d, y: p.y + dir.y * d, z: p.z + dir.z * d })) return d;
    return max;
  }
  floor(p: Vec3, max = FLOOR_BELOW): number | null {
    for (let d = 0; d <= max; d += 6) if (this.g.solidAt({ x: p.x, y: p.y, z: p.z - d })) return p.z - d;
    return null;
  }
  /** Flies the path as the program does; null when it fails, else how much of it sees `look`. */
  fly(path: Pick<CameraPath, "keyframes">, look: (t: number) => Vec3, maxSpeed: number, minVis: number, maxYawRate: number): { vis: number; open: number; maxSpeed: number } | null {
    const dur = path.keyframes[path.keyframes.length - 1]!.tMs;
    let prev: { p: Vec3; yaw: number } | null = null;
    let seen = 0;
    let n = 0;
    let open = 0;
    let fastest = 0;
    let soft = 0;
    const times: number[] = [];
    for (let t = 0; t < dur; t += STEP_MS) times.push(t);
    times.push(dur); // the last pose is held
    let prevT = 0;
    for (const t of times) {
      const pose = samplePath(path, t);
      const p = pose.position;
      if (!this.inside(p)) return no("outside the map");
      if (!this.overFloor.has(`${Math.floor(p.x / 64)},${Math.floor(p.y / 64)}`)) return no("off the playable area");
      if (!this.g.clearAround(p, ROOM)) return no("no room");
      if (pose.pitch < -15 || pose.pitch > 65) return no("pitch");
      if (prev) {
        const dt = (t - prevT) / 1000;
        // Room between samples too: the program draws every frame.
        if (!this.g.clearAround(samplePath(path, (prevT + t) / 2).position, ROOM)) return no("no room");
        if (!this.g.segmentClear(prev.p, p, 0)) return no("through geometry");
        const v = dist(prev.p, p) / dt;
        fastest = Math.max(fastest, v);
        if (v > maxSpeed) return no("too fast");
        if (Math.abs(wrap(pose.yaw - prev.yaw)) / dt > maxYawRate) return no("turns too fast");
      }
      prevT = t;
      if (n % 4 === 0 && this.floor(p) === null) return no("no floor below");
      // No wall filling the picture: never right at the lens, and only for a moment close ahead or at the edges.
      const f = forward(pose.pitch, pose.yaw);
      const ahead = this.ray(p, f, 160);
      if (ahead < 70) return no("wall at the lens");
      let edges = 0;
      for (const [dy, dp] of [[32, 0], [-32, 0], [0, 18], [0, -18]] as const) if (this.ray(p, forward(pose.pitch + dp, pose.yaw + dy), 110) >= 110) edges++;
      if (ahead < 160 || edges < 3) soft++;
      open += edges / 4;
      if (this.g.lineOfSight(p, look(t))) seen++;
      n++;
      prev = { p, yaw: pose.yaw };
    }
    const vis = seen / Math.max(1, n);
    if (soft / Math.max(1, n) > SOFT) return no("walls in the picture");
    return vis >= minVis ? { vis, open: open / Math.max(1, n), maxSpeed: fastest } : no("target hidden");
  }
}

/** Greedy clusters: the heaviest neighbourhood first. */
function cluster(points: { p: P3; w: number }[], radius: number, minW: number, kind: Spot["kind"], maxN: number): Spot[] {
  const left = points.map((q) => ({ ...q, used: false }));
  const out: Spot[] = [];
  const near = (a: P3, b: P3) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= radius && Math.abs(a[2] - b[2]) <= 160;
  while (out.length < maxN) {
    let best: { i: number; w: number } | null = null;
    for (let i = 0; i < left.length; i++) {
      if (left[i]!.used) continue;
      let w = 0;
      for (const q of left) if (!q.used && near(left[i]!.p, q.p)) w += q.w;
      if (!best || w > best.w) best = { i, w };
    }
    if (!best || best.w < minW) break;
    const members = left.filter((q) => !q.used && near(left[best!.i]!.p, q.p));
    for (const q of members) q.used = true;
    const W = members.reduce((s, q) => s + q.w, 0);
    const zs = members.map((q) => q.p[2]).sort((a, b) => a - b);
    out.push({ x: members.reduce((s, q) => s + q.p[0] * q.w, 0) / W, y: members.reduce((s, q) => s + q.p[1] * q.w, 0) / W, z: zs[Math.floor(zs.length / 2)]!, w: W, kind });
  }
  return out;
}

function keysFrom(points: Vec3[], looks: Vec3[], durMs: number): CameraPath["keyframes"] {
  return points.map((p, i) => {
    const a = aim(p, looks[i]!);
    return { tMs: Math.round((durMs * i) / (points.length - 1)), position: { x: r1(p.x), y: r1(p.y), z: r1(p.z) }, pitch: r2(a.pitch), yaw: r2(a.yaw) };
  });
}

function spotShots(c: Checker, spot: Spot, si: number, rt: MapRuntime): Candidate[] {
  const focus: Vec3 = { x: spot.x, y: spot.y, z: spot.z + EYE };
  const spawn = spot.kind !== "fight";
  const radii = spawn ? [300, 420, 560] : [300, 420, 560, 720];
  const out: Candidate[] = [];
  const at = (angle: number, d: number, h: number): Vec3 => ({ x: spot.x + Math.cos(rad(angle)) * d, y: spot.y + Math.sin(rad(angle)) * d, z: spot.z + h });
  const regions = rt.regionsAt(focus);
  const weight = Math.log2(1 + spot.w);
  const add = (style: Style, pts: Vec3[], durMs: number, angle: number, distIdeal: number) => {
    const keys = keysFrom(pts, pts.map(() => focus), durMs);
    const res = c.fly({ keyframes: keys }, () => focus, MAX_SPEED[style], 1 - SOFT, MAX_YAW_RATE[style]);
    if (!res) return;
    const mid = pts[Math.floor(pts.length / 2)]!;
    const dFocus = Math.hypot(mid.x - focus.x, mid.y - focus.y);
    const score = weight + 2 * res.vis + res.open - Math.abs(dFocus - distIdeal) / 600;
    out.push({ style, spot: si, keys, focus, score, sig: [pts[0]!, mid, pts[pts.length - 1]!], angle, maxSpeed: res.maxSpeed, regions, label: "" });
  };
  const n = (durMs: number) => Math.max(3, Math.round(durMs / KEY_MS) + 1);
  for (let a0 = 0; a0 < 360; a0 += 20) {
    for (const R of radii) {
      for (const H of [140, 210, 290, 380]) {
        for (const arc of [45, 70]) {
          for (const dir of [1, -1]) {
            const durMs = Math.min(9000, Math.max(5000, ((rad(arc) * R) / 110) * 1000));
            const k = n(durMs);
            add("orbit", Array.from({ length: k }, (_, i) => at(a0 + dir * arc * (i / (k - 1)), R, H)), durMs, a0, spawn ? 460 : 560);
          }
        }
      }
    }
  }
  for (let a0 = 0; a0 < 360; a0 += 15) {
    const k = n(6000);
    for (const [d0, d1, h0, h1] of [[950, 520, 280, 180], [800, 420, 220, 150], [620, 320, 180, 130]] as const) {
      add("push", Array.from({ length: k }, (_, i) => at(a0, d0 + (d1 - d0) * (i / (k - 1)), h0 + (h1 - h0) * (i / (k - 1)))), 6000, a0, 650);
    }
    add("pull", Array.from({ length: k }, (_, i) => at(a0, 380 + 440 * (i / (k - 1)), 150 + 170 * (i / (k - 1)))), 6500, a0, 600);
    add("pull", Array.from({ length: k }, (_, i) => at(a0, 260 + 300 * (i / (k - 1)), 130 + 120 * (i / (k - 1)))), 6000, a0, 420);
    add("crane", Array.from({ length: k }, (_, i) => at(a0, 480 + 120 * (i / (k - 1)), 90 + 300 * (i / (k - 1)))), 6000, a0, 540);
    add("crane", Array.from({ length: k }, (_, i) => at(a0, 320 + 80 * (i / (k - 1)), 80 + 220 * (i / (k - 1)))), 6000, a0, 380);
    for (const D of [380, 520, 680]) {
      for (const side of [1, -1]) {
        const base = at(a0, D, 210);
        const px = -Math.sin(rad(a0)) * side;
        const py = Math.cos(rad(a0)) * side;
        add("slide", Array.from({ length: k }, (_, i) => ({ x: base.x + px * (-220 + 440 * (i / (k - 1))), y: base.y + py * (-220 + 440 * (i / (k - 1))), z: base.z })), 6000, a0, D);
      }
    }
  }
  return out;
}

function smooth(pts: P3[]): Vec3[] {
  return pts.map((_, i) => {
    let x = 0;
    let y = 0;
    let z = 0;
    let w = 0;
    for (let j = -2; j <= 2; j++) {
      const q = pts[Math.min(pts.length - 1, Math.max(0, i + j))]!;
      const k = 3 - Math.abs(j);
      x += q[0] * k;
      y += q[1] * k;
      z += q[2] * k;
      w += k;
    }
    return { x: x / w, y: y / w, z: z / w };
  });
}

function routeShots(c: Checker, routes: Anchors["routes"], rt: MapRuntime): Candidate[] {
  const out: Candidate[] = [];
  const variants = [
    { back: 150, h: 130, lat: 0, lead: 6 },
    { back: 120, h: 165, lat: 50, lead: 6 },
    { back: 120, h: 165, lat: -50, lead: 6 },
    { back: 200, h: 110, lat: 0, lead: 5 },
    { back: 60, h: 280, lat: 0, lead: 4 }, // high, looking down the route
    { back: 0, h: 120, lat: 0, lead: 5 }, // right above the route (corridors)
    { back: 80, h: 100, lat: 30, lead: 5 },
    { back: 80, h: 100, lat: -30, lead: 5 },
  ];
  const slow = 1.5; // slower than the players ran: a glide, not a sprint
  for (const r of routes) {
    const s = smooth(r.pts);
    const len = s.reduce((acc, p, i) => (i ? acc + Math.hypot(p.x - s[i - 1]!.x, p.y - s[i - 1]!.y) : 0), 0);
    if (len < 450) continue; // barely moved
    for (const v of variants) {
      const idx = Array.from({ length: Math.floor((s.length - 1) / 2) + 1 }, (_, i) => Math.min(s.length - 1, i * 2));
      if (idx[idx.length - 1] !== s.length - 1) idx.push(s.length - 1);
      const pts: Vec3[] = [];
      const looks: Vec3[] = [];
      for (const i of idx) {
        const a = s[Math.max(0, i - 1)]!;
        const b = s[Math.min(s.length - 1, i + 1)]!;
        const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const dx = (b.x - a.x) / l;
        const dy = (b.y - a.y) / l;
        pts.push({ x: s[i]!.x - dx * v.back - dy * v.lat, y: s[i]!.y - dy * v.back + dx * v.lat, z: s[i]!.z + v.h });
        const j = i + v.lead;
        const ahead = j < s.length ? s[j]! : { x: s[s.length - 1]!.x + dx * 60 * (j - s.length + 1), y: s[s.length - 1]!.y + dy * 60 * (j - s.length + 1), z: s[s.length - 1]!.z };
        looks.push({ x: ahead.x, y: ahead.y, z: ahead.z + 56 });
      }
      const durMs = Math.round((s.length - 1) * 250 * slow);
      const keys = keysFrom(pts, looks, durMs);
      // The look-ahead point the samples see: the nearest keyframe's.
      const look = (t: number) => looks[Math.min(looks.length - 1, Math.round((t / durMs) * (looks.length - 1)))]!;
      const res = c.fly({ keyframes: keys }, look, MAX_SPEED.route, 0.8, MAX_YAW_RATE.route);
      if (!res) continue;
      const startR = rt.regionsAt(s[0]!);
      const endR = rt.regionsAt(s[s.length - 1]!);
      const midR = rt.regionsAt(s[Math.floor(s.length / 2)]!);
      out.push({
        style: "route",
        spot: -1,
        keys,
        focus: null,
        score: 2 * res.vis + res.open + Math.min(1, len / 1200) + (r.t < 25 ? 0.3 : 0),
        sig: [pts[0]!, pts[Math.floor(pts.length / 2)]!, pts[pts.length - 1]!],
        angle: deg(Math.atan2(s[s.length - 1]!.y - s[0]!.y, s[s.length - 1]!.x - s[0]!.x)),
        maxSpeed: res.maxSpeed,
        regions: [...new Set([...startR, ...midR, ...endR])],
        label: `${r.side}`,
      });
      break; // one shot per route: the first variant that flies
    }
  }
  return out;
}

function select(cands: Candidate[]): Candidate[] {
  const chosen: Candidate[] = [];
  const perSpot = new Map<string, number>();
  const similar = (a: Candidate, b: Candidate) => {
    if (a.style !== b.style) return false;
    if (a.style === "route") return a.sig.every((p, i) => dist(p, b.sig[i]!) < 260);
    return a.spot === b.spot && Math.abs(wrap(a.angle - b.angle)) < 40;
  };
  const pick = (style: Style, quota: number, spotLimit: number) => {
    const pool = cands.filter((c) => c.style === style && !chosen.includes(c)).sort((a, b) => b.score - a.score);
    let taken = chosen.filter((c) => c.style === style).length;
    for (const c of pool) {
      if (taken >= quota || chosen.length >= MAX_PATHS) break;
      const key = `${style}:${c.spot}`;
      if (style !== "route" && (perSpot.get(key) ?? 0) >= spotLimit) continue;
      if (chosen.some((x) => similar(x, c))) continue;
      chosen.push(c);
      perSpot.set(key, (perSpot.get(key) ?? 0) + 1);
      taken++;
    }
  };
  // The shots of places first, best first (the spawns score highest: freeze time is where paths fly most), then the routes.
  for (const style of ["orbit", "push", "pull", "crane", "slide"] as const) pick(style, QUOTA[style], PER_SPOT[style]);
  pick("route", QUOTA.route, Infinity);
  // Short of 200: let each place have more.
  for (let extra = 1; chosen.length < MIN_PATHS && extra <= 6; extra++) {
    for (const style of ["route", "orbit", "slide", "push", "pull", "crane"] as const) pick(style, QUOTA[style] + extra * 15, style === "route" ? Infinity : PER_SPOT[style] + extra);
  }
  return chosen;
}

const PLACE: Record<string, string> = { bombsite_a: "A site", bombsite_b: "B site", t_spawn: "T spawn", ct_spawn: "CT spawn" };

function human(name: string): string {
  return name
    .replace(/_/g, " ")
    .replace(/([a-z])of(?=[A-Z])/g, "$1 of ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .replace(/\bct\b/gi, "CT")
    .replace(/\bt\b/g, "T")
    .replace(/^./, (c) => c.toUpperCase());
}

function main(): void {
  const { values } = parseArgs({ options: { anchors: { type: "string" }, out: { type: "string" }, maps: { type: "string" } } });
  const root = join(import.meta.dirname, "..", "..", "..");
  const packs = join(root, "assets", "map-packs");
  const anchorsDir = values.anchors!;
  const outDir = values.out!;
  mkdirSync(outDir, { recursive: true });
  const maps = values.maps ? values.maps.split(",") : ["de_ancient", "de_anubis", "de_cache", "de_dust2", "de_inferno", "de_mirage", "de_nuke"];
  const report: string[] = [];
  for (const map of maps) {
    const t0 = performance.now();
    const pack = MapPack.parse(JSON.parse(readFileSync(join(packs, `${map}.json`), "utf8")));
    const grid = VisibilityGrid.parse(readFileSync(join(packs, `${map}.grid`)), (b) => inflateSync(b));
    const rt = new MapRuntime(pack);
    const anchors = JSON.parse(readFileSync(join(anchorsDir, `${map}.json`), "utf8")) as Anchors;
    // Walkable floor (navigation mesh, and where players stood in the demos), widened by a cell.
    const floorCells = [...(pack.floorGrid && pack.floorGrid.cellSize === 64 ? pack.floorGrid.cells.map((r) => [r[0], r[1]]) : []), ...anchors.floor.map((f) => [f[0], f[1]])];
    const overFloor = new Set<string>();
    for (const [ix, iy] of floorCells) for (let dx = -OVER_FLOOR_CELLS; dx <= OVER_FLOOR_CELLS; dx++) for (let dy = -OVER_FLOOR_CELLS; dy <= OVER_FLOOR_CELLS; dy++) overFloor.add(`${ix! + dx},${iy! + dy}`);
    const c = new Checker(grid, overFloor);
    const fights = cluster([...anchors.kills.map((k) => ({ p: k.v, w: 1 })), ...anchors.kills.filter((k) => k.a).map((k) => ({ p: k.a!, w: 0.6 })), ...anchors.plants.map((p) => ({ p, w: 2.5 }))], 380, 2.5, "fight", 30);
    const spawns = (["T", "CT"] as const).flatMap((side) => cluster(anchors.freeze.filter((f) => f.side === side).map((f) => ({ p: f.p, w: 1 })), 600, 10, side === "T" ? "spawn_T" : "spawn_CT", 2));
    // Busy places: where living players spent the most time, away from the fights already there.
    const busy = cluster(
      anchors.floor.filter((f) => f[3] >= 8).map((f) => ({ p: [(f[0] + 0.5) * 64, (f[1] + 0.5) * 64, f[2]] as P3, w: f[3] })),
      450,
      200,
      "busy",
      40,
    ).filter((b) => [...fights, ...spawns].every((s) => Math.hypot(s.x - b.x, s.y - b.y) > 380 || Math.abs(s.z - b.z) > 160));
    const spots = [...spawns, ...fights, ...busy.slice(0, 25)];
    const cands: Candidate[] = [];
    spots.forEach((s, i) => cands.push(...spotShots(c, s, i, rt)));
    cands.push(...routeShots(c, anchors.routes, rt));
    const chosen = select(cands);
    const label = (id: string) => PLACE[id] ?? human(pack.regions.find((x) => x.id === id)?.name ?? id);
    const name = (r: string[]) => (r[0] ? label(r[0]) : null);
    // Outside every named area: the nearest one (its nearest cell, on about the same floor).
    const cells = pack.regions.flatMap((r) =>
      r.shapes.flatMap((sh) =>
        sh.kind === "cells"
          ? sh.cells.map(([ix, iy, iz]) => ({ id: r.id, x: (ix + 0.5) * sh.cellSize, y: (iy + 0.5) * sh.cellSize, z: (iz + 0.5) * sh.zCellSize }))
          : [{ id: r.id, x: sh.points.reduce((a, q) => a + q[0], 0) / sh.points.length, y: sh.points.reduce((a, q) => a + q[1], 0) / sh.points.length, z: (sh.zMin + sh.zMax) / 2 }],
      ),
    );
    const near = (p: Vec3) => {
      let best: { id: string; d: number } | null = null;
      for (const m of cells) {
        const d = Math.hypot(m.x - p.x, m.y - p.y, 3 * (m.z - p.z));
        if (!best || d < best.d) best = { id: m.id, d };
      }
      return best ? `near ${label(best.id)}` : "the map";
    };
    const short = map.replace(/^de_/, "");
    const counts = new Map<Style, number>();
    const titles = chosen.map((cand) => {
      if (cand.style === "route") {
        const k = cand.keys;
        const from = name(rt.regionsAt(k[0]!.position)) ?? near(k[0]!.position);
        const to = name(rt.regionsAt(k[k.length - 1]!.position)) ?? near(k[k.length - 1]!.position);
        return `${LABEL.route}: ${from === to ? from : `${from} to ${to}`} (${cand.label})`;
      }
      const s = spots[cand.spot]!;
      const where = s.kind === "spawn_T" ? "T spawn" : s.kind === "spawn_CT" ? "CT spawn" : (name(cand.regions) ?? near(s));
      return `${LABEL[cand.style]}: ${where}`;
    });
    // The same title more than once: numbered.
    const total = new Map<string, number>();
    for (const t of titles) total.set(t, (total.get(t) ?? 0) + 1);
    const nth = new Map<string, number>();
    const paths: CameraPath[] = chosen.map((cand, i) => {
      const n = (counts.get(cand.style) ?? 0) + 1;
      counts.set(cand.style, n);
      const t = titles[i]!;
      const k = (nth.get(t) ?? 0) + 1;
      nth.set(t, k);
      const dur = cand.keys[cand.keys.length - 1]!.tMs;
      return {
        id: `demo-${short}-${cand.style}-${String(n).padStart(3, "0")}`,
        displayName: total.get(t)! > 1 ? `${t} ${k}` : t,
        mapName: map,
        mapRevision: pack.mapRevision,
        keyframes: cand.keys,
        maxDurationMs: dur + 1500,
        maxSpeedUnitsPerSec: Math.ceil(cand.maxSpeed * 1.1),
        collisionValidated: true,
        validation: "unvalidated",
        targetRegionIds: cand.regions,
        source: "derived_demos",
      };
    });
    writeFileSync(join(outDir, `${map}.json`), JSON.stringify({ map, matches: anchors.matches, paths }));
    const byStyle = [...counts].map(([s, n]) => `${s} ${n}`).join(", ");
    const line = `${map}: ${spots.length} places (${spawns.length} spawn, ${fights.length} fight, ${spots.length - spawns.length - fights.length} busy), ${cands.length} shots flew, ${paths.length} kept (${byStyle}) in ${Math.round(performance.now() - t0)} ms`;
    report.push(line);
    console.log(line);
    console.log("  turned down:", JSON.stringify(REJECTED));
    for (const k of Object.keys(REJECTED)) delete REJECTED[k];
  }
  writeFileSync(join(outDir, "report.txt"), report.join("\n") + "\n");
}

main();
