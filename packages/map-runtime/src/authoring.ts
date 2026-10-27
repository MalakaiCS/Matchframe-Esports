import type { CameraPath, CameraRecord, Vec3 } from "@matchframe/contracts";

export interface CapturedPose {
  position: Vec3;
  pitch: number;
  yaw: number;
  roll: number;
}

/**
 * Parses the console output of CS2 `getpos` ("setpos x y z;setang pitch yaw roll").
 * Cameras are authored from real captured coordinates only; this is the operator's capture path.
 */
export function parseGetpos(text: string): CapturedPose | null {
  const m = /setpos(?:_exact)?\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*;\s*setang\s+(-?[\d.]+)\s+(-?[\d.]+)(?:\s+(-?[\d.]+))?/i.exec(text);
  if (!m) return null;
  const nums = m.slice(1, 7).map((x) => (x === undefined ? 0 : Number(x)));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const [x, y, z, pitch, yaw, roll] = nums as [number, number, number, number, number, number];
  return { position: { x, y, z }, pitch, yaw, roll };
}

/** What a static camera is used for: nade cameras (utility), fight overviews (tactical), the bomb, establishing shots in freeze time. */
export type CameraUse = "utility" | "tactical" | "bomb" | "establishing";
export const CAMERA_USES: readonly CameraUse[] = ["utility", "tactical", "bomb", "establishing"];

/** Establishing shots run in freeze time; every other use during the live round. */
export function phasesForUses(uses: readonly CameraUse[]): CameraRecord["allowedPhases"] {
  const phases: CameraRecord["allowedPhases"] = [];
  if (uses.includes("establishing")) phases.push("freezetime");
  if (uses.some((u) => u !== "establishing")) phases.push("live");
  return phases;
}

export interface CameraDraftInput {
  id: string;
  displayName: string;
  mapName: string;
  mapRevision: string;
  pose: CapturedPose;
  /** World point the camera is meant to show (e.g. an effect landing area), captured or chosen on the radar. */
  focus: Vec3;
  coverageRadiusUnits: number;
  levelId: string | null;
  targetRegionIds: string[];
  fov?: number | null;
  capturedFrom?: CameraRecord["capturedFrom"];
  /** Defaults to nade camera + fight overview. */
  uses?: CameraUse[];
}

/** Creates an UNVALIDATED camera record from a captured pose; it stays preview-only until qualified. */
export function draftCamera(input: CameraDraftInput): CameraRecord {
  return {
    id: input.id,
    displayName: input.displayName,
    mapName: input.mapName,
    mapRevision: input.mapRevision,
    position: input.pose.position,
    pitch: input.pose.pitch,
    yaw: input.pose.yaw,
    fov: input.fov ?? null,
    observerMode: "roaming_static",
    targetRegionIds: input.targetRegionIds,
    coverage: {
      center: input.focus,
      radiusUnits: input.coverageRadiusUnits,
      zMin: input.focus.z - 160,
      zMax: input.focus.z + 220,
      levelId: input.levelId,
    },
    allowedPhases: phasesForUses(input.uses ?? ["utility", "tactical"]),
    actionClasses: [...(input.uses ?? ["utility", "tactical"])],
    grenadeTypes: [],
    minAcquisitionMs: 400,
    normalDurationMs: 2000,
    maxDurationMs: 3000,
    occlusionValidation: "unvalidated",
    validation: "unvalidated",
    exitStrategy: "most_relevant_player",
    lastTestedGameBuild: null,
    lastTestedMapVersion: null,
    capturedFrom: input.capturedFrom ?? "getpos_paste",
    notes: null,
  };
}

/** Angle between the camera's view direction and the direction to a target point (degrees). */
export function viewAngleTo(camera: Pick<CameraRecord, "position" | "pitch" | "yaw">, target: Vec3): number {
  const pitch = (camera.pitch * Math.PI) / 180;
  const yaw = (camera.yaw * Math.PI) / 180;
  // Source engine: pitch positive looks down; yaw 0 = +X, 90 = +Y.
  const fwd = { x: Math.cos(pitch) * Math.cos(yaw), y: Math.cos(pitch) * Math.sin(yaw), z: -Math.sin(pitch) };
  const d = { x: target.x - camera.position.x, y: target.y - camera.position.y, z: target.z - camera.position.z };
  const len = Math.hypot(d.x, d.y, d.z);
  if (len < 1e-6) return 0;
  const dot = (fwd.x * d.x + fwd.y * d.y + fwd.z * d.z) / len;
  return (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
}

/** True when the target falls inside the camera's horizontal FOV (default 90°) with a margin. */
export function targetInFrame(camera: Pick<CameraRecord, "position" | "pitch" | "yaw" | "fov">, target: Vec3, marginDeg = 8): boolean {
  const fov = camera.fov ?? 90;
  return viewAngleTo(camera, target) <= fov / 2 - marginDeg;
}

export interface PathCheck {
  ok: boolean;
  problems: string[];
  durationMs: number;
  maxSpeedUnitsPerSec: number;
}

/**
 * Static checks for a camera path: ordered keyframes, bounded duration and speed.
 * Collision validation needs verified geometry and preview playback; it is never assumed.
 */
export function checkCameraPath(path: CameraPath): PathCheck {
  const problems: string[] = [];
  let maxSpeed = 0;
  for (let i = 1; i < path.keyframes.length; i++) {
    const a = path.keyframes[i - 1]!;
    const b = path.keyframes[i]!;
    const dt = (b.tMs - a.tMs) / 1000;
    if (dt <= 0) {
      problems.push(`keyframe ${i} is not after keyframe ${i - 1}`);
      continue;
    }
    const d = Math.hypot(b.position.x - a.position.x, b.position.y - a.position.y, b.position.z - a.position.z);
    maxSpeed = Math.max(maxSpeed, d / dt);
  }
  const durationMs = path.keyframes[path.keyframes.length - 1]!.tMs - path.keyframes[0]!.tMs;
  if (durationMs > path.maxDurationMs) problems.push(`duration ${durationMs} ms exceeds maximum ${path.maxDurationMs} ms`);
  if (maxSpeed > path.maxSpeedUnitsPerSec) problems.push(`speed ${maxSpeed.toFixed(0)} u/s exceeds maximum ${path.maxSpeedUnitsPerSec} u/s`);
  if (!path.collisionValidated) problems.push("collision not validated (requires preview playback on verified geometry)");
  return { ok: problems.length === 0, problems, durationMs, maxSpeedUnitsPerSec: maxSpeed };
}
