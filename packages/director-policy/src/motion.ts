import type { Vec3 } from "@matchframe/contracts";
import type { CameraMotion, CameraPose } from "./control/adapter.ts";
import { aimAt, arcPoint } from "./framing.ts";

const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;
const round = (n: number) => Math.round(n * 100) / 100;

/** A still camera turning slowly about its aim (degrees a second, positive to the left): half the turn each side of its yaw. */
export function panMotion(camera: CameraPose, degPerSec: number, durationMs: number): CameraMotion {
  const start = camera.yaw - (degPerSec * durationMs) / 2000;
  return { durationMs, pose: (t) => ({ position: camera.position, pitch: camera.pitch, yaw: round(wrap180(start + (degPerSec * t) / 1000)) }) };
}

/**
 * A camera gliding round a point it keeps looking at (a team shot): from `from` to `to` along the
 * arc round `focus`, at an even pace over `durationMs`. Still when the two are the same.
 */
export function glideMotion(move: { from: Vec3; to: Vec3; focus: Vec3 }, durationMs: number): CameraMotion {
  const still = move.from.x === move.to.x && move.from.y === move.to.y && move.from.z === move.to.z;
  return {
    durationMs: still ? 0 : durationMs,
    pose: (t) => {
      const u = durationMs > 0 ? Math.min(1, Math.max(0, t / durationMs)) : 0;
      const p = still ? move.from : arcPoint(move.from, move.to, move.focus, u);
      const aim = aimAt(p, move.focus);
      return { position: { x: round(p.x), y: round(p.y), z: round(p.z) }, pitch: round(aim.pitch), yaw: round(wrap180(aim.yaw)) };
    },
  };
}
