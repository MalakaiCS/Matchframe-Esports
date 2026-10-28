import { describe, expect, it } from "vitest";
import type { MatchState } from "@matchframe/contracts";
import { VisibilityGrid } from "@matchframe/map-runtime";
import { FollowCam } from "../src/live/follow.ts";

/** An open 12-unit grid around the origin, with optional solid cells. */
function grid(solid: (x: number, y: number, z: number) => boolean = () => false): VisibilityGrid {
  const dims: [number, number, number] = [200, 200, 60];
  const origin: [number, number, number] = [-1200, -1200, -200];
  const bits = new Uint8Array(Math.ceil((dims[0] * dims[1] * dims[2]) / 8));
  for (let z = 0; z < dims[2]; z++)
    for (let y = 0; y < dims[1]; y++)
      for (let x = 0; x < dims[0]; x++) {
        const wx = origin[0] + (x + 0.5) * 12;
        const wy = origin[1] + (y + 0.5) * 12;
        const wz = origin[2] + (z + 0.5) * 12;
        if (solid(wx, wy, wz)) {
          const i = (z * dims[1] + y) * dims[0] + x;
          bits[i >> 3]! |= 1 << (i & 7);
        }
      }
  return new VisibilityGrid({ map: "de_test", build: "t", cell: 12, origin, dims }, bits);
}

const player = (x: number, alive = true) => ({ steamId: "p1", lifeState: alive ? "alive" : "dead", position: { x, y: 0, z: 0 }, forward: { x: 1, y: 0, z: 0 } });
const stateWith = (p: ReturnType<typeof player>) => ({ mapName: "de_test", players: [p] }) as unknown as MatchState;

describe("follow cam", () => {
  it("flies behind and above a running player, looking ahead, and keeps up smoothly", () => {
    let x = 0;
    const cam = new FollowCam(() => stateWith(player(x)), "p1", grid());
    const first = cam.pose(0)!;
    expect(first.position.x).toBeCloseTo(-170, 0);
    expect(first.position.z).toBeCloseTo(80, 0);
    expect(Math.abs(first.yaw)).toBeLessThan(30);
    expect(first.pitch).toBeGreaterThan(0);
    // The player runs +x at 250 u/s; after 2 s the camera is behind them again.
    let pose = first;
    for (let t = 16; t <= 2000; t += 16) {
      x = (t / 1000) * 250;
      pose = cam.pose(t)!;
    }
    expect(pose.position.x).toBeGreaterThan(x - 260);
    expect(pose.position.x).toBeLessThan(x - 100);
  });

  it("glides between game-data updates: positions every 100 ms, camera frames every 15.6 ms, no steps", () => {
    let x = 0;
    const cam = new FollowCam(() => stateWith(player(x)), "p1", grid());
    const xs: number[] = [];
    // The player runs +x at 250 u/s; the game data brings their position every 100 ms.
    for (let t = 0; t <= 3000; t += 15.6) {
      x = Math.floor(t / 100) * 25;
      xs.push(cam.pose(t)!.position.x);
    }
    // Once the camera has caught up (after 1.5 s), each frame moves it about the same distance (within
    // 10 %). Without carrying positions forward, the frame after each update jumps ~18 % above average.
    const steps = xs.slice(96).map((v, i, a) => (i ? v - a[i - 1]! : 0)).slice(1);
    const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
    expect(mean).toBeGreaterThan(3);
    expect(Math.max(...steps)).toBeLessThan(mean * 1.1);
    expect(Math.min(...steps)).toBeGreaterThan(mean * 0.9);
  });

  it("comes in closer when a wall is right behind the player, never through it", () => {
    const wall = (wx: number) => wx > -130 && wx < -110;
    const cam = new FollowCam(() => stateWith(player(0)), "p1", grid(wall));
    const pose = cam.pose(0)!;
    expect(pose.position.x).toBeGreaterThan(-110);
    expect(pose.position.x).toBeLessThan(0);
  });

  it("ends the shot when the player dies", () => {
    let alive = true;
    const cam = new FollowCam(() => stateWith(player(0, alive)), "p1", grid());
    expect(cam.pose(0)).not.toBeNull();
    alive = false;
    expect(cam.pose(100)).toBeNull();
  });
});
