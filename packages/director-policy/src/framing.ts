import type { CameraRecord, Vec3 } from "@matchframe/contracts";

/** What framing needs from a map's free-space grid (map-runtime's VisibilityGrid has all three). */
export interface FreeSpace {
  solidAt(p: Vec3): boolean;
  segmentClear(a: Vec3, b: Vec3, skipEnds?: number): boolean;
  clearAround(p: Vec3, radius: number): boolean;
}

export interface FramedPlayer {
  steamId: string;
  /** Feet (the game data's position). */
  position: Vec3;
  /** Where they look, when known. */
  forward: Vec3 | null;
}

/**
 * A shot of a team: the camera glides from `from` to `to` over the shot (a slow arc around the team
 * with a slight push in; `from` equals `to` for a still shot), always looking at `focus`.
 */
export interface TeamShot {
  from: Vec3;
  to: Vec3;
  focus: Vec3;
  /** The players the shot is of (they stand together), and how many of them the camera sees. */
  steamIds: string[];
  inView: number;
  /** How far the middle one of them is from the camera (units). */
  range: number;
  score: number;
}

/** CS2's spectator field of view: 90 degrees at 4:3, so about 106 x 74 degrees on a 16:9 picture. */
const TAN_H = Math.tan((106.26 / 2) * (Math.PI / 180));
const TAN_V = (TAN_H * 9) / 16;
/** Players stand about this tall; their chest and eyes are what the camera must see. */
const BODY = 72;
const CHEST = 40;
const EYE = 64;
/** Players further than this from the team's middle (or a floor away) are left out of its shot. */
const GROUP_RADIUS = 900;
const GROUP_DZ = 160;
/** Camera heights above the team's floor, and how much each is liked (a little above head height reads best). */
const HEIGHTS: readonly [number, number][] = [
  [110, 1],
  [160, 0.95],
  [75, 0.7],
  [220, 0.75],
  [300, 0.55],
];
const AZIMUTHS = 48;
/** Room the camera needs around it, and above it. */
const ROOM = 20;
const HEADROOM = 28;
/** Bodies stay this far inside the picture's edges (1 = the edge). */
const EDGE_X = 0.86;
const EDGE_Y = 0.88;
/** The glide: an arc of this many degrees around the team and a push in of this share of the distance. */
const ARC_DEG = 10;
const PUSH_IN = 0.08;
/** Nobody else stands this close to the camera, or in the picture nearer than this share of the way to the team. */
const FOREGROUND_GAP = 120;
const FOREGROUND_SHARE = 0.7;
/** What leaving a player out of a team shot costs its score (see frameTeam). */
const LEFT_OUT = 0.8;
/** Players look best this far from the camera (units): big enough to read, the group still in the picture. */
const BEST_RANGE = 380;
/** At most this share of the picture's upper two thirds may be blocked before the team. */
const MAX_BLOCKED = 0.45;

const dist2 = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

interface Basis {
  f: Vec3;
  r: Vec3;
  u: Vec3;
}

/** The camera's axes looking from `from` at `at` (Source angles: pitch down is positive). */
function basisTo(from: Vec3, at: Vec3): Basis {
  const dx = at.x - from.x;
  const dy = at.y - from.y;
  const dz = at.z - from.z;
  const yaw = Math.atan2(dy, dx);
  const pitch = -Math.atan2(dz, Math.hypot(dx, dy));
  const f = { x: Math.cos(pitch) * Math.cos(yaw), y: Math.cos(pitch) * Math.sin(yaw), z: -Math.sin(pitch) };
  const r = { x: Math.sin(yaw), y: -Math.cos(yaw), z: 0 };
  const u = { x: r.y * f.z - r.z * f.y, y: r.z * f.x - r.x * f.z, z: r.x * f.y - r.y * f.x };
  return { f, r, u };
}

/** Where a point lands in the picture: -1..1 across and up, null when behind the camera. */
function project(from: Vec3, b: Basis, p: Vec3): { x: number; y: number } | null {
  const v = { x: p.x - from.x, y: p.y - from.y, z: p.z - from.z };
  const zf = v.x * b.f.x + v.y * b.f.y + v.z * b.f.z;
  if (zf < 1) return null;
  return { x: (v.x * b.r.x + v.y * b.r.y + v.z * b.r.z) / zf / TAN_H, y: (v.x * b.u.x + v.y * b.u.y + v.z * b.u.z) / zf / TAN_V };
}

/** A direction through the picture at (sx, sy), -1..1. */
function rayDir(b: Basis, sx: number, sy: number): Vec3 {
  const d = { x: b.f.x + sx * TAN_H * b.r.x + sy * TAN_V * b.u.x, y: b.f.y + sx * TAN_H * b.r.y + sy * TAN_V * b.u.y, z: b.f.z + sx * TAN_H * b.r.z + sy * TAN_V * b.u.z };
  const l = Math.hypot(d.x, d.y, d.z);
  return { x: d.x / l, y: d.y / l, z: d.z / l };
}

/** The camera's aim (yaw, pitch in degrees, Source convention) from one point to another. */
export function aimAt(from: Vec3, at: Vec3): { yaw: number; pitch: number } {
  const dx = at.x - from.x;
  const dy = at.y - from.y;
  return { yaw: (Math.atan2(dy, dx) * 180) / Math.PI, pitch: (-Math.atan2(at.z - from.z, Math.hypot(dx, dy)) * 180) / Math.PI };
}

/** The players of one team who stand together (the rest walked off or are on another floor). */
export function teamGroup(players: FramedPlayer[]): FramedPlayer[] {
  if (players.length < 2) return players;
  const mx = median(players.map((p) => p.position.x));
  const my = median(players.map((p) => p.position.y));
  const mz = median(players.map((p) => p.position.z));
  return players.filter((p) => Math.hypot(p.position.x - mx, p.position.y - my) <= GROUP_RADIUS && Math.abs(p.position.z - mz) <= GROUP_DZ);
}

interface Placed {
  at: Vec3;
  focus: Vec3;
  visible: number;
  fill: number;
}

/**
 * A broadcast shot of a team standing together (in their spawn in freeze time): the camera a little
 * above head height, a few hundred units from them, seeing their chests or heads, with all of them in
 * the picture and nothing between the lens and them, preferring to see them from the front (their
 * faces) and a gentle downward look. Every spot is checked in the map's free-space grid: room around
 * the camera and above it, floor somewhere below it, a clear line to the players, and the picture
 * open (no wall filling it). The camera glides slowly round the team while on air when the whole
 * glide passes the same checks; otherwise the shot is still. Null when no spot works.
 */
export function frameTeam(players: FramedPlayer[], space: FreeSpace, opts: FrameOptions = {}): TeamShot | null {
  let group = teamGroup(players);
  const least = Math.max(2, Math.min(3, players.length), Math.ceil(players.length / 2));
  // The whole group, and without the one furthest out, and so on down to three of five: a good-sized
  // shot of four beats five far away (one standing well apart pushes the camera back), and each
  // player left out costs the shot LEFT_OUT.
  let best: { shot: TeamShot; value: number } | null = null;
  while (group.length >= least) {
    const left = players.filter((p) => !group.includes(p)).map((p) => p.position);
    const shot = frameGroup(group, space, { ...opts, others: [...(opts.others ?? []), ...left] });
    const value = shot ? shot.score - LEFT_OUT * (players.length - group.length) : -Infinity;
    if (shot && (!best || value > best.value)) best = { shot, value };
    // Close enough already: no need to leave anyone out.
    if (best && best.shot.range <= BEST_RANGE + 200) break;
    const cx = group.reduce((s, p) => s + p.position.x, 0) / group.length;
    const cy = group.reduce((s, p) => s + p.position.y, 0) / group.length;
    const far = group.reduce((a, p) => (Math.hypot(p.position.x - cx, p.position.y - cy) > Math.hypot(a.position.x - cx, a.position.y - cy) ? p : a));
    group = group.filter((p) => p !== far);
  }
  return best?.shot ?? null;
}

export interface FrameOptions {
  /** No glide (a pause shot). */
  still?: boolean;
  /** Counts of spots turned down, by reason (diagnostics). */
  rejected?: Record<string, number>;
  /** Other players (feet): none may stand in the foreground of the shot, between the camera and the team. */
  others?: Vec3[];
}

function frameGroup(group: FramedPlayer[], space: FreeSpace, opts: FrameOptions): TeamShot | null {
  const reject = (why: string) => {
    if (opts.rejected) opts.rejected[why] = (opts.rejected[why] ?? 0) + 1;
  };
  const n = group.length;
  const need = Math.max(2, n - 1);
  const cx = group.reduce((s, p) => s + p.position.x, 0) / n;
  const cy = group.reduce((s, p) => s + p.position.y, 0) / n;
  const floor = median(group.map((p) => p.position.z));
  const spread = Math.max(...group.map((p) => Math.hypot(p.position.x - cx, p.position.y - cy)));
  const distances = [160, 220, 320, 450, 600, 800].map((d) => Math.min(1100, Math.max(260, spread + d)));

  /** How many players the camera sees, and whether they all fit in the picture looking at `focus`. */
  const place = (at: Vec3, focus: Vec3): Placed | null => {
    const b = basisTo(at, focus);
    const range = Math.hypot(focus.x - at.x, focus.y - at.y, focus.z - at.z);
    for (const o of opts.others ?? []) {
      if (Math.hypot(o.x - at.x, o.y - at.y) < FOREGROUND_GAP) return null;
      for (const z of [o.z, o.z + BODY]) {
        const s = project(at, b, { x: o.x, y: o.y, z });
        if (s && Math.abs(s.x) < 1 && Math.abs(s.y) < 1 && Math.hypot(o.x - at.x, o.y - at.y, z - at.z) < FOREGROUND_SHARE * range) return null;
      }
    }
    let minX = Infinity;
    let maxX = -Infinity;
    for (const p of group) {
      for (const z of [p.position.z, p.position.z + BODY]) {
        const s = project(at, b, { x: p.position.x, y: p.position.y, z });
        if (!s || Math.abs(s.x) > EDGE_X || Math.abs(s.y) > EDGE_Y) return null;
        minX = Math.min(minX, s.x);
        maxX = Math.max(maxX, s.x);
      }
    }
    let visible = 0;
    for (const p of group) {
      const chest = { x: p.position.x, y: p.position.y, z: p.position.z + CHEST };
      const eye = { x: p.position.x, y: p.position.y, z: p.position.z + EYE };
      if (space.segmentClear(at, chest, 6) || space.segmentClear(at, eye, 6)) visible++;
    }
    return visible >= need ? { at, focus, visible, fill: (maxX - minX) / 2 } : null;
  };

  /** Room around the camera, headroom, and floor somewhere below it (not floating off the map). */
  const roomy = (at: Vec3, below: number) =>
    space.clearAround(at, ROOM) && space.segmentClear(at, { x: at.x, y: at.y, z: at.z + HEADROOM }, 0) && !space.segmentClear(at, { x: at.x, y: at.y, z: at.z - below }, 0);

  /**
   * How much of the picture's upper two thirds is blocked before the team: 1 when anything is right
   * at the lens or between the camera and the middle of the picture (walls at the sides frame a shot
   * and only lower its score), otherwise the share of rays blocked.
   */
  const blocked = (at: Vec3, focus: Vec3): number => {
    const b = basisTo(at, focus);
    const reach = Math.min(700, 0.8 * Math.hypot(focus.x - at.x, focus.y - at.y, focus.z - at.z));
    let hits = 0;
    let rays = 0;
    let middle = 0;
    for (const sy of [0, 0.3, 0.6]) {
      for (const sx of [-0.8, -0.53, -0.27, 0, 0.27, 0.53, 0.8]) {
        const d = rayDir(b, sx, sy);
        rays++;
        if (!space.segmentClear(at, { x: at.x + d.x * 90, y: at.y + d.y * 90, z: at.z + d.z * 90 }, 0)) return 1;
        if (space.segmentClear(at, { x: at.x + d.x * reach, y: at.y + d.y * reach, z: at.z + d.z * reach }, 0)) continue;
        hits++;
        if (Math.abs(sx) < 0.6 && sy < 0.5) middle++;
      }
    }
    return middle > 1 ? 1 : hits / rays;
  };

  /** How much each player faces the camera (0 back to it .. 1 facing it). */
  const facing = (at: Vec3) => {
    let s = 0;
    let k = 0;
    for (const p of group) {
      if (!p.forward) continue;
      const fl = Math.hypot(p.forward.x, p.forward.y);
      const tl = Math.hypot(at.x - p.position.x, at.y - p.position.y);
      if (fl < 1e-6 || tl < 1e-6) continue;
      s += Math.max(0, (p.forward.x * (at.x - p.position.x) + p.forward.y * (at.y - p.position.y)) / (fl * tl));
      k++;
    }
    return k ? s / k : 0.5;
  };

  /** Aims at the middle of the group as it lands in the picture (two passes). */
  const centre = (at: Vec3): Vec3 => {
    let focus = { x: cx, y: cy, z: floor + CHEST };
    for (let pass = 0; pass < 2; pass++) {
      const b = basisTo(at, focus);
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const p of group) {
        for (const z of [p.position.z, p.position.z + BODY]) {
          const s = project(at, b, { x: p.position.x, y: p.position.y, z });
          if (!s) return focus;
          minX = Math.min(minX, s.x);
          maxX = Math.max(maxX, s.x);
          minY = Math.min(minY, s.y);
          maxY = Math.max(maxY, s.y);
        }
      }
      const d = rayDir(b, (minX + maxX) / 2, (minY + maxY) / 2);
      const range = Math.hypot(focus.x - at.x, focus.y - at.y, focus.z - at.z);
      focus = { x: at.x + d.x * range, y: at.y + d.y * range, z: at.z + d.z * range };
    }
    return focus;
  };

  let best: { shot: TeamShot; score: number } | null = null;
  for (const [h, hLike] of HEIGHTS) {
    for (const d of distances) {
      for (let i = 0; i < AZIMUTHS; i++) {
        const a = (2 * Math.PI * i) / AZIMUTHS;
        const at = { x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d, z: floor + h };
        if (!roomy(at, h + 200)) {
          reject("room");
          continue;
        }
        const focus = centre(at);
        const pitch = aimAt(at, focus).pitch;
        if (pitch < -5 || pitch > 40) {
          reject("pitch");
          continue;
        }
        const placed = place(at, focus);
        if (!placed) {
          reject("framing or sight");
          continue;
        }
        const sVis = placed.visible / n;
        const sFill = 1 - Math.min(1, Math.abs(placed.fill - 0.55) / 0.45);
        const sPitch = 1 - Math.min(1, Math.abs(pitch - 12) / 18);
        const sDist = 1 - Math.min(1, Math.abs(d - 480) / 450);
        const sFace = facing(at);
        // How big they look: the middle player's distance from the camera.
        const range = median(group.map((p) => Math.hypot(p.position.x - at.x, p.position.y - at.y, p.position.z + CHEST - at.z)));
        const sSize = 1 - Math.min(1, Math.abs(range - BEST_RANGE) / 350);
        // Cheap parts first: the openness rays only for a spot that could still win.
        const partial = 3 * sVis + 1.2 * sFill + 0.8 * sPitch + 0.6 * hLike + 0.8 * sFace + 0.5 * sDist + sSize;
        if (best && partial + 1 <= best.score) continue;
        const blk = blocked(at, focus);
        if (blk > MAX_BLOCKED) {
          reject("blocked");
          continue;
        }
        const score = partial + (1 - blk);
        if (best && score <= best.score) continue;
        best = { score, shot: { from: at, to: at, focus, steamIds: group.map((p) => p.steamId), inView: placed.visible, range: Math.round(range), score } };
      }
    }
  }
  if (!best || opts.still) return best?.shot ?? null;
  return { ...best.shot, to: glide(best.shot, place, roomy, blocked) ?? best.shot.from };
}

/** The end of the glide: an arc round the team with a slight push in, whichever way stays clear. */
function glide(
  shot: TeamShot,
  place: (at: Vec3, focus: Vec3) => Placed | null,
  roomy: (at: Vec3, below: number) => boolean,
  blocked: (at: Vec3, focus: Vec3) => number,
): Vec3 | null {
  const f = shot.focus;
  const from = shot.from;
  const rx = from.x - f.x;
  const ry = from.y - f.y;
  const below = from.z - f.z + 300;
  for (const deg of [ARC_DEG, -ARC_DEG, ARC_DEG / 2, -ARC_DEG / 2]) {
    const a = (deg * Math.PI) / 180;
    const k = 1 - PUSH_IN;
    const end = { x: f.x + (rx * Math.cos(a) - ry * Math.sin(a)) * k, y: f.y + (rx * Math.sin(a) + ry * Math.cos(a)) * k, z: from.z };
    const steps = Math.max(8, Math.ceil(dist2(from, end) / 12));
    let ok = true;
    for (let s = 1; s <= steps && ok; s++) {
      const p = arcPoint(from, end, f, s / steps);
      const placed = place(p, f);
      ok = roomy(p, below) && !!placed && placed.visible >= shot.inView - 1;
    }
    if (ok && blocked(end, f) <= MAX_BLOCKED) return end;
  }
  return null;
}

/** A point `u` (0..1) along the glide: round the focus from `from`'s bearing to `to`'s, the distance and height eased between. */
export function arcPoint(from: Vec3, to: Vec3, focus: Vec3, u: number): Vec3 {
  const a0 = Math.atan2(from.y - focus.y, from.x - focus.x);
  const a1 = Math.atan2(to.y - focus.y, to.x - focus.x);
  let da = a1 - a0;
  while (da > Math.PI) da -= 2 * Math.PI;
  while (da < -Math.PI) da += 2 * Math.PI;
  const r0 = Math.hypot(from.x - focus.x, from.y - focus.y);
  const r1 = Math.hypot(to.x - focus.x, to.y - focus.y);
  const a = a0 + da * u;
  const r = r0 + (r1 - r0) * u;
  return { x: focus.x + Math.cos(a) * r, y: focus.y + Math.sin(a) * r, z: from.z + (to.z - from.z) * u };
}

/**
 * The camera id of a team shot ("team-T", "team-CT"; a pause's still one "team-T-still"): its shot
 * key is cameraShot(id). The still one has its own, so a pause cuts to it from the same team's glide.
 */
export const teamCameraId = (side: "T" | "CT", still = false): string => `team-${side}${still ? "-still" : ""}`;

/** The side of a team shot's camera id, or null for any other camera. */
export function teamShotSide(cameraId: string | null): "T" | "CT" | null {
  const m = /^team-(T|CT)(-still)?$/.exec(cameraId ?? "");
  return m ? (m[1] as "T" | "CT") : null;
}

/** The camera record a team shot is shown with (its first pose; the glide comes with the shot). */
export function teamCamera(side: "T" | "CT", mapName: string, shot: Pick<TeamShot, "from" | "focus">, plannedDurationMs: number, still = false): CameraRecord {
  const aim = aimAt(shot.from, shot.focus);
  return {
    id: teamCameraId(side, still),
    displayName: side === "T" ? "Team shot: Terrorists" : "Team shot: Counter-Terrorists",
    mapName,
    mapRevision: "live",
    position: shot.from,
    pitch: aim.pitch,
    yaw: aim.yaw,
    fov: null,
    observerMode: "roaming_static",
    targetRegionIds: [],
    coverage: { center: shot.focus, radiusUnits: Math.max(1, Math.hypot(shot.from.x - shot.focus.x, shot.from.y - shot.focus.y)), zMin: shot.focus.z - 100, zMax: shot.focus.z + 200, levelId: null },
    allowedPhases: ["freezetime"],
    actionClasses: ["establishing"],
    grenadeTypes: [],
    minAcquisitionMs: 150,
    normalDurationMs: plannedDurationMs,
    maxDurationMs: plannedDurationMs,
    occlusionValidation: "validated",
    validation: "unvalidated",
    exitStrategy: "most_relevant_player",
    lastTestedGameBuild: null,
    lastTestedMapVersion: null,
    capturedFrom: "framed_live",
    notes: "Placed on air from the players' positions and the map's free-space grid.",
  };
}
