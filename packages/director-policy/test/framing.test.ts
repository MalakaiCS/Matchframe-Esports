import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { Vec3 } from "@matchframe/contracts";
import { VisibilityGrid } from "@matchframe/map-runtime";
import type { FramedPlayer, FreeSpace } from "../src/framing.ts";
import { aimAt, arcPoint, frameTeam, teamGroup } from "../src/framing.ts";
import { glideMotion, panMotion } from "../src/motion.ts";

/** Flat open ground at z = 0 (solid below), with optional solid boxes. */
function ground(boxes: { min: Vec3; max: Vec3 }[] = []): FreeSpace {
  const solidAt = (p: Vec3) => p.z < 0 || boxes.some((b) => p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y && p.z >= b.min.z && p.z <= b.max.z);
  const segmentClear = (a: Vec3, b: Vec3, skip = 12) => {
    const l = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    const n = Math.floor(l / 3) + 1;
    for (let i = 1; i < n; i++) {
      const t = i / n;
      if (t * l <= skip || (1 - t) * l <= skip) continue;
      if (solidAt({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t })) return false;
    }
    return true;
  };
  return {
    solidAt,
    segmentClear,
    clearAround: (p, r) => !solidAt(p) && [[r, 0, 0], [-r, 0, 0], [0, r, 0], [0, -r, 0], [0, 0, r], [0, 0, -r]].every(([x, y, z]) => segmentClear(p, { x: p.x + x!, y: p.y + y!, z: p.z + z! }, 0)),
  };
}

const team = (pts: [number, number, number][], forward: Vec3 | null = null): FramedPlayer[] => pts.map((p, i) => ({ steamId: `p${i}`, position: { x: p[0], y: p[1], z: p[2] }, forward }));
const five = team([
  [0, 0, 0],
  [60, 20, 0],
  [-50, 40, 0],
  [20, -70, 0],
  [-40, -50, 0],
]);

describe("team shots on open ground", () => {
  it("frames all five from a few hundred units, a little above their heads, looking gently down at them", () => {
    const shot = frameTeam(five, ground())!;
    expect(shot).not.toBeNull();
    expect(shot.inView).toBe(5);
    expect(shot.steamIds).toHaveLength(5);
    const d = Math.hypot(shot.from.x - shot.focus.x, shot.from.y - shot.focus.y);
    expect(d).toBeGreaterThan(250);
    expect(d).toBeLessThan(1000);
    expect(shot.from.z).toBeGreaterThanOrEqual(75);
    expect(shot.from.z).toBeLessThanOrEqual(220);
    const pitch = aimAt(shot.from, shot.focus).pitch;
    expect(pitch).toBeGreaterThan(0);
    expect(pitch).toBeLessThan(30);
    // Glides: about 10° round them and a little closer, at the same height.
    const turn = Math.abs(aimAt(shot.focus, shot.from).yaw - aimAt(shot.focus, shot.to).yaw);
    expect(Math.min(turn, 360 - turn)).toBeCloseTo(10, 0);
    expect(Math.hypot(shot.to.x - shot.focus.x, shot.to.y - shot.focus.y)).toBeLessThan(d);
    expect(shot.to.z).toBe(shot.from.z);
  });

  it("sees their faces: from the side they look towards", () => {
    const east = frameTeam(team([[0, 0, 0], [60, 20, 0], [-50, 40, 0], [20, -70, 0]], { x: 1, y: 0, z: 0 }), ground())!;
    const west = frameTeam(team([[0, 0, 0], [60, 20, 0], [-50, 40, 0], [20, -70, 0]], { x: -1, y: 0, z: 0 }), ground())!;
    expect(east.from.x).toBeGreaterThan(east.focus.x);
    expect(west.from.x).toBeLessThan(west.focus.x);
  });

  it("is still for a pause", () => {
    const shot = frameTeam(five, ground(), { still: true })!;
    expect(shot.to).toEqual(shot.from);
  });

  it("never looks through a wall, and keeps the lens clear", () => {
    // A wall all round the team but for a gap to the east.
    const walls = [
      { min: { x: -400, y: -400, z: 0 }, max: { x: -380, y: 400, z: 300 } },
      { min: { x: -400, y: 380, z: 0 }, max: { x: 400, y: 400, z: 300 } },
      { min: { x: -400, y: -400, z: 0 }, max: { x: 400, y: -380, z: 300 } },
    ];
    const space = ground(walls);
    const shot = frameTeam(five, space)!;
    expect(shot.from.x).toBeGreaterThan(0);
    for (const p of five) expect(space.segmentClear(shot.from, { ...p.position, z: 40 }, 6)).toBe(true);
    // Along the whole glide, too.
    for (let u = 0; u <= 1; u += 0.1) expect(space.clearAround(arcPoint(shot.from, shot.to, shot.focus, u), 14)).toBe(true);
  });

  it("keeps everyone else out of the foreground", () => {
    const shot = frameTeam(five, ground(), { others: [] })!;
    // Someone standing where that camera was: it goes elsewhere.
    const moved = frameTeam(five, ground(), { others: [{ x: (shot.from.x + shot.focus.x) / 2, y: (shot.from.y + shot.focus.y) / 2, z: 0 }] })!;
    expect(Math.hypot(moved.from.x - shot.from.x, moved.from.y - shot.from.y)).toBeGreaterThan(50);
  });

  it("leaves out a player who walked off or is on another floor", () => {
    const g = teamGroup(team([[0, 0, 0], [60, 20, 0], [-50, 40, 0], [2000, 0, 0], [0, 50, 300]]));
    expect(g.map((p) => p.steamId)).toEqual(["p0", "p1", "p2"]);
    expect(frameTeam(team([[0, 0, 0], [3000, 0, 0]]), ground())).toBeNull();
  });
});

describe("camera motion", () => {
  it("a pan turns about the camera's aim: half each side", () => {
    const m = panMotion({ position: { x: 1, y: 2, z: 3 }, pitch: 10, yaw: 90 }, 3, 10000);
    expect(m.pose(0)!.yaw).toBe(75);
    expect(m.pose(5000)!.yaw).toBe(90);
    expect(m.pose(10000)!.yaw).toBe(105);
    expect(m.pose(10000)!.position).toEqual({ x: 1, y: 2, z: 3 });
  });

  it("a glide keeps the team in the middle of the picture all the way", () => {
    const shot = frameTeam(five, ground())!;
    const m = glideMotion(shot, 9000);
    expect(m.durationMs).toBe(9000);
    for (let t = 0; t <= 9000; t += 1500) {
      const p = m.pose(t)!;
      const aim = aimAt(p.position, shot.focus);
      expect(Math.abs(((p.yaw - aim.yaw + 540) % 360) - 180)).toBeLessThan(0.02);
      expect(p.pitch).toBeCloseTo(aim.pitch, 1);
    }
    expect(m.pose(9000)!.position.x).toBeCloseTo(shot.to.x, 1);
    expect(glideMotion({ ...shot, to: shot.from }, 9000).durationMs).toBe(0);
  });
});

/** Five players standing in each spawn (navigation areas inside the map's spawn areas). */
const SPAWNS: Record<string, [number, number, number][]> = {
  "de_ancient:ct_spawn": [[-629, 1250, 74], [-632, 1323, 32], [-621, 1176, 68], [-534, 1308, 32], [-526, 1230, 48]],
  "de_ancient:t_spawn": [[-414, -1991, -158], [-517, -1929, -166], [-342, -2004, -160], [-357, -2079, -156], [-633, -1975, -156]],
  "de_anubis:ct_spawn": [[-323, 2629, -92], [-278, 2691, -92], [-294, 2518, -92], [-220, 2534, -92], [-292, 2756, -84]],
  "de_anubis:t_spawn": [[-318, -1382, 6], [-244, -1456, -1], [-179, -1356, 6], [-232, -1552, -8], [-14, -1352, 6]],
  "de_dust2:ct_spawn": [[130, 2230, -121], [195, 2300, -117], [87, 2301, -26], [177, 2168, -120], [52, 2238, -26]],
  "de_dust2:t_spawn": [[-860, -733, 126], [-928, -746, 122], [-777, -690, 129], [-994, -734, 125], [-1037, -672, 131]],
  "de_inferno:ct_spawn": [[2082, 2241, 162], [2005, 2365, 128], [2082, 2363, 132], [2158, 2240, 139], [1811, 2392, 134]],
  "de_inferno:t_spawn": [[-1406, 236, -60], [-1315, 241, -60], [-1368, 184, -60], [-1314, 326, -31], [-1492, 258, -60]],
  "de_mirage:ct_spawn": [[-1534, -1414, -258], [-1557, -1506, -260], [-1654, -1504, -260], [-1542, -1575, -260], [-1453, -1586, -252]],
  "de_mirage:t_spawn": [[1186, -136, -162], [1314, -118, -164], [1345, -191, -161], [1144, -218, -162], [1261, -289, -163]],
  "de_nuke:ct_spawn": [[2988, -670, -340], [2922, -648, -340], [2976, -579, -348], [2860, -677, -292], [3041, -589, -348]],
  "de_nuke:t_spawn": [[-1984, -1076, -412], [-2039, -977, -412], [-2140, -1119, -412], [-1928, -1124, -412], [-1938, -990, -412]],
  "de_overpass:t_spawn": [[-654, -2390, 152], [-721, -2405, 153], [-558, -2358, 155], [-602, -2288, 155], [-657, -2543, 158]],
  "de_train:ct_spawn": [[1630, -1344, -324], [1742, -1367, -324], [1593, -1229, -325], [1745, -1456, -324], [1572, -1446, -324]],
  "de_train:t_spawn": [[-1368, 1342, -170], [-1443, 1388, -170], [-1342, 1406, -169], [-1289, 1282, -181], [-1408, 1473, -170]],
  "de_vertigo:ct_spawn": [[-1061, 771, 11780], [-1038, 681, 11780], [-1126, 745, 11780], [-1130, 660, 11780], [-908, 740, 11780]],
  "de_vertigo:t_spawn": [[-1992, -1176, 11617], [-1952, -1021, 11492], [-2084, -1026, 11492], [-2064, -1186, 11617], [-2122, -1114, 11651]],
};

describe("team shots in CS2's own geometry (the maps' free-space grids)", () => {
  const grids = new Map<string, VisibilityGrid>();
  const grid = (map: string) => {
    if (!grids.has(map)) grids.set(map, VisibilityGrid.parse(readFileSync(resolve(__dirname, `../../../assets/map-packs/${map}.grid`)), (b) => inflateSync(b)));
    return grids.get(map)!;
  };
  for (const [key, pts] of Object.entries(SPAWNS)) {
    it(`frames the team in ${key.replace(":", " ")}`, () => {
      const map = key.split(":")[0]!;
      const g = grid(map);
      const players = team(pts);
      const t0 = performance.now();
      const shot = frameTeam(players, g)!;
      expect(performance.now() - t0).toBeLessThan(500);
      expect(shot, key).not.toBeNull();
      expect(shot.inView).toBeGreaterThanOrEqual(3);
      const floor = [...pts.map((p) => p[2])].sort((a, b) => a - b)[2]!;
      expect(shot.from.z - floor).toBeGreaterThanOrEqual(60);
      expect(shot.from.z - floor).toBeLessThanOrEqual(240);
      // The camera has room and sees the players it frames, all along its glide.
      for (let u = 0; u <= 1.001; u += 0.125) {
        const at = arcPoint(shot.from, shot.to, shot.focus, u);
        expect(g.clearAround(at, 14), `${key} u=${u}`).toBe(true);
        const seen = players.filter((p) => shot.steamIds.includes(p.steamId) && (g.segmentClear(at, { ...p.position, z: p.position.z + 40 }, 6) || g.segmentClear(at, { ...p.position, z: p.position.z + 64 }, 6)));
        expect(seen.length, `${key} u=${u}`).toBeGreaterThanOrEqual(Math.min(3, shot.inView - 1));
      }
    });
  }
});
