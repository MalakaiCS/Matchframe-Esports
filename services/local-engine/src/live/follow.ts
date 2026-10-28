import type { MatchState, Vec3 } from "@matchframe/contracts";
import type { CameraPose } from "@matchframe/director-policy";
import type { VisibilityGrid } from "@matchframe/map-runtime";

/**
 * Follow cam: a free camera behind and a little above a player, a touch to one side (over the
 * shoulder), looking a little ahead of where they are going. Each frame the camera wants a spot
 * behind the player's direction of travel; the first spot that has room around it and a clear line
 * to the player's eyes in the map's free-space grid wins (closer and higher ones when a wall is
 * behind them). Position and aim follow it smoothly. When no spot works, or the player dies, the
 * shot ends (the stream returns null) and the director cuts back to a POV.
 */

const EYE = 64;
/** Behind, above, to the side (units), in order of preference. */
const OFFSETS: readonly [number, number, number][] = [
  [170, 80, 32],
  [170, 80, -32],
  [130, 95, 24],
  [100, 105, 0],
  [70, 110, 0],
];
/** Room the camera needs around it. */
const ROOM = 14;
/** Seconds for the camera to cover most of the way to where it wants to be. */
const POS_TAU = 0.28;
const AIM_TAU = 0.18;
/** How far ahead of the player the camera looks. */
const LOOK_AHEAD = 140;
/** Below this speed (units/s) the player's view direction is used instead of their movement. */
const MOVING = 60;

const angleDiff = (a: number, b: number) => ((((b - a) % 360) + 540) % 360) - 180;

export class FollowCam {
  private pos: Vec3 | null = null;
  private yaw = 0;
  private pitch = 0;
  private heading: { x: number; y: number } | null = null;
  private lastT = 0;
  private lastPlayer: Vec3 | null = null;
  private lastPlayerAt = 0;
  private velocity = { x: 0, y: 0 };

  constructor(
    private readonly state: () => MatchState | null,
    readonly steamId: string,
    private readonly grid: VisibilityGrid,
  ) {}

  /** The pose `elapsedMs` into the shot, or null when the shot should end. */
  pose(elapsedMs: number): CameraPose | null {
    const s = this.state();
    const p = s?.players.find((x) => x.steamId === this.steamId);
    if (!s || s.mapName !== this.grid.map || !p || p.lifeState !== "alive" || !p.position) return null;
    const dt = this.lastT === 0 && elapsedMs === 0 ? 0 : Math.max(0, (elapsedMs - this.lastT) / 1000);
    this.lastT = elapsedMs;
    this.track(p.position, elapsedMs);
    const eye = { x: p.position.x, y: p.position.y, z: p.position.z + EYE };
    const dir = this.direction(p.forward);
    const want = this.spot(eye, dir);
    if (!want) {
      // Nowhere behind them has room: hold the current spot while it still sees the player, else end.
      if (!this.pos || !this.grid.segmentClear(eye, this.pos, 6)) return null;
    } else if (!this.pos || dt === 0) {
      this.pos = want;
    } else {
      const k = 1 - Math.exp(-dt / POS_TAU);
      const next = { x: this.pos.x + (want.x - this.pos.x) * k, y: this.pos.y + (want.y - this.pos.y) * k, z: this.pos.z + (want.z - this.pos.z) * k };
      // Smoothing must not carry the camera into a wall or behind one.
      this.pos = this.grid.clearAround(next, ROOM * 0.6) && this.grid.segmentClear(eye, next, 6) ? next : want;
    }
    const aim = { x: eye.x + dir.x * LOOK_AHEAD, y: eye.y + dir.y * LOOK_AHEAD, z: eye.z - 8 };
    const dx = aim.x - this.pos.x;
    const dy = aim.y - this.pos.y;
    const dz = aim.z - this.pos.z;
    const yaw = (Math.atan2(dy, dx) * 180) / Math.PI;
    const pitch = (-Math.atan2(dz, Math.hypot(dx, dy)) * 180) / Math.PI;
    if (dt === 0) {
      this.yaw = yaw;
      this.pitch = pitch;
    } else {
      const k = 1 - Math.exp(-dt / AIM_TAU);
      this.yaw += angleDiff(this.yaw, yaw) * k;
      this.pitch += (pitch - this.pitch) * k;
    }
    return { position: { ...this.pos }, pitch: round(this.pitch), yaw: round(((this.yaw + 540) % 360) - 180) };
  }

  /** Velocity from successive positions (game data positions arrive every ~20 ms). */
  private track(at: Vec3, t: number): void {
    if (this.lastPlayer && t > this.lastPlayerAt) {
      const dt = (t - this.lastPlayerAt) / 1000;
      if (dt >= 0.05) {
        const vx = (at.x - this.lastPlayer.x) / dt;
        const vy = (at.y - this.lastPlayer.y) / dt;
        this.velocity = { x: this.velocity.x * 0.5 + vx * 0.5, y: this.velocity.y * 0.5 + vy * 0.5 };
        this.lastPlayer = at;
        this.lastPlayerAt = t;
      }
    } else {
      this.lastPlayer = at;
      this.lastPlayerAt = t;
    }
  }

  /** Where the player is heading: their movement when running, else where they look; smoothed. */
  private direction(forward: Vec3 | null): { x: number; y: number } {
    const speed = Math.hypot(this.velocity.x, this.velocity.y);
    let d = speed >= MOVING ? { x: this.velocity.x / speed, y: this.velocity.y / speed } : forward ? normalize({ x: forward.x, y: forward.y }) : null;
    if (!d) d = this.heading ?? { x: 1, y: 0 };
    this.heading = this.heading ? normalize({ x: this.heading.x * 0.85 + d.x * 0.15, y: this.heading.y * 0.85 + d.y * 0.15 }) ?? d : d;
    return this.heading;
  }

  private spot(eye: Vec3, dir: { x: number; y: number }): Vec3 | null {
    const side = { x: -dir.y, y: dir.x };
    for (const [back, up, across] of OFFSETS) {
      const c = { x: eye.x - dir.x * back + side.x * across, y: eye.y - dir.y * back + side.y * across, z: eye.z - EYE + up };
      if (this.grid.clearAround(c, ROOM) && this.grid.segmentClear(eye, c, 6)) return c;
    }
    return null;
  }
}

function normalize(v: { x: number; y: number }): { x: number; y: number } | null {
  const l = Math.hypot(v.x, v.y);
  return l > 1e-6 ? { x: v.x / l, y: v.y / l } : null;
}

const round = (n: number) => Math.round(n * 100) / 100;
