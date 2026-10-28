/** Shot keys identify what the observer shows: "pov:<steamId>", "camera:<id>", "path:<id>", "follow:<steamId>", "roaming". */
export type ShotKey = string;

export const povShot = (steamId: string): ShotKey => `pov:${steamId}`;
export const cameraShot = (cameraId: string): ShotKey => `camera:${cameraId}`;
export const pathShot = (pathId: string): ShotKey => `path:${pathId}`;
export const followShot = (steamId: string): ShotKey => `follow:${steamId}`;
export const ROAMING: ShotKey = "roaming";

export function parseShot(key: ShotKey | null): { kind: "pov" | "camera" | "path" | "follow" | "roaming" | "none"; id: string | null } {
  if (!key) return { kind: "none", id: null };
  if (key === ROAMING) return { kind: "roaming", id: null };
  const i = key.indexOf(":");
  if (i < 0) return { kind: "none", id: null };
  const kind = key.slice(0, i);
  const id = key.slice(i + 1);
  if (kind === "pov" || kind === "camera" || kind === "path" || kind === "follow") return { kind, id };
  return { kind: "none", id: null };
}

export function isCinematic(key: ShotKey | null): boolean {
  const k = parseShot(key).kind;
  return k === "camera" || k === "path" || k === "follow";
}
