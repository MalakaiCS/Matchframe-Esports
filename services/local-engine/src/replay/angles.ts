import type { CameraRecord, Vec3 } from "@matchframe/contracts";
import type { FramedPlayer, FreeSpace } from "@matchframe/director-policy";
import { frameTeam, teamCamera } from "@matchframe/director-policy";

/**
 * The free camera of a multi-angle replay (ADR-081): a still camera placed for one kill from the
 * players' positions and the map's free-space grid, with the framing the Observer's team shots use
 * (director-policy framing.ts): room around the lens, floor below it, a clear line to the players,
 * nothing filling the picture. Killer and victim close together are framed together; far apart (an
 * AWP across the map), the player who died is framed with the line the shot came along.
 */

/** Two players this close (units, and on one floor) are framed together. */
const TOGETHER = 800;
const TOGETHER_DZ = 150;
/** Far apart: a point this far from the player who died, toward the killer, is framed with them (so the camera looks along the shot). */
const TOWARD = 140;
export const KILL_CAMERA_ID = "replay-angle-free";

const player = (steamId: string, position: Vec3): FramedPlayer => ({ steamId, position, forward: null });

/** The free camera for a kill, or null when the grid has no spot for it (or the player who died's position isn't known). */
export function killCamera(mapName: string, killer: Vec3 | null, victim: Vec3 | null, space: FreeSpace, plannedDurationMs: number): CameraRecord | null {
  if (!victim) return null;
  let players: FramedPlayer[];
  if (killer && Math.hypot(killer.x - victim.x, killer.y - victim.y) <= TOGETHER && Math.abs(killer.z - victim.z) <= TOGETHER_DZ) players = [player("killer", killer), player("victim", victim)];
  else {
    const dx = killer ? killer.x - victim.x : 1;
    const dy = killer ? killer.y - victim.y : 0;
    const len = Math.hypot(dx, dy) || 1;
    players = [player("victim", victim), player("toward", { x: victim.x + (dx / len) * TOWARD, y: victim.y + (dy / len) * TOWARD, z: victim.z })];
  }
  const shot = frameTeam(players, space, { still: true, look: "eye" });
  if (!shot) return null;
  const cam = teamCamera("T", mapName, shot, plannedDurationMs, true, KILL_CAMERA_ID);
  return { ...cam, displayName: "Replay angle: free camera", allowedPhases: ["live", "over", "freezetime"], actionClasses: ["tactical"], notes: "Placed for a replay's extra angle from the players' positions and the map's free-space grid." };
}
