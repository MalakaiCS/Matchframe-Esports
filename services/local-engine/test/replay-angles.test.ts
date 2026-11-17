import { describe, expect, it } from "vitest";
import type { Vec3 } from "@matchframe/contracts";
import type { FreeSpace } from "@matchframe/director-policy";
import { KILL_CAMERA_ID, killCamera } from "../src/replay/angles.ts";

/** Flat open ground at z = 0 (solid below), with optional solid boxes (as the framing tests build it). */
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

/** The camera's aim reaches `p` (within the picture: 50° either side, the CS2 spectator's view is about 106° wide). */
const sees = (cam: { position: Vec3; yaw: number }, p: Vec3) => {
  const toward = (Math.atan2(p.y - cam.position.y, p.x - cam.position.x) * 180) / Math.PI;
  const off = Math.abs(((toward - cam.yaw + 540) % 360) - 180);
  return off < 50;
};

describe("the free camera of a multi-angle replay (ADR-081)", () => {
  it("frames the killer and the player who died together when they are close, from a clear spot above the floor", () => {
    const killer = { x: 0, y: 0, z: 0 };
    const victim = { x: 400, y: 100, z: 0 };
    const cam = killCamera("de_test", killer, victim, ground(), 6000)!;
    expect(cam).toMatchObject({ id: KILL_CAMERA_ID, mapName: "de_test", observerMode: "roaming_static", allowedPhases: ["live", "over", "freezetime"] });
    expect(cam.position.z).toBeGreaterThan(40);
    expect(sees(cam, killer)).toBe(true);
    expect(sees(cam, victim)).toBe(true);
  });

  it("far apart (an AWP across the map): the player who died, looking along the line the shot came from", () => {
    const killer = { x: -2500, y: 0, z: 0 };
    const victim = { x: 0, y: 0, z: 0 };
    const cam = killCamera("de_test", killer, victim, ground(), 6000)!;
    expect(cam).not.toBeNull();
    expect(sees(cam, victim)).toBe(true);
    // Near the player who died, not the killer.
    expect(Math.hypot(cam.position.x - victim.x, cam.position.y - victim.y)).toBeLessThan(1200);
  });

  it("never puts the camera inside a wall: with walls all round, a spot in the open or none", () => {
    const victim = { x: 0, y: 0, z: 0 };
    // A tight box around the player who died: no spot for a camera.
    const walls = [
      { min: { x: -60, y: -2000, z: 0 }, max: { x: -40, y: 2000, z: 500 } },
      { min: { x: 40, y: -2000, z: 0 }, max: { x: 60, y: 2000, z: 500 } },
      { min: { x: -2000, y: -60, z: 0 }, max: { x: 2000, y: -40, z: 500 } },
      { min: { x: -2000, y: 40, z: 0 }, max: { x: 2000, y: 60, z: 500 } },
      { min: { x: -2000, y: -2000, z: 100 }, max: { x: 2000, y: 2000, z: 120 } },
    ];
    const space = ground(walls);
    const cam = killCamera("de_test", { x: 30, y: 0, z: 0 }, victim, space, 6000);
    if (cam) expect(space.solidAt(cam.position)).toBe(false);
    // Without the player who died's position, none.
    expect(killCamera("de_test", { x: 0, y: 0, z: 0 }, null, ground(), 6000)).toBeNull();
  });
});
