/**
 * Client-side mirror of the engine's role → permission table (services/local-engine/src/auth.ts).
 * Used only to explain disabled controls; the engine remains the authority and enforces every call.
 */
export type Permission =
  | "metadata.read"
  | "metadata.write"
  | "hud.publish"
  | "camera.control"
  | "director.control"
  | "program.control"
  | "replay.control"
  | "demos.manage"
  | "training.manage"
  | "models.promote"
  | "settings.manage"
  | "veto.captain"
  | "state.read";

const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  owner: ["metadata.read", "metadata.write", "hud.publish", "camera.control", "director.control", "program.control", "replay.control", "demos.manage", "training.manage", "models.promote", "settings.manage", "state.read"],
  producer: ["metadata.read", "metadata.write", "hud.publish", "program.control", "replay.control", "director.control", "state.read"],
  observer: ["metadata.read", "camera.control", "director.control", "state.read"],
  graphics: ["metadata.read", "metadata.write", "hud.publish", "state.read"],
  replay: ["metadata.read", "replay.control", "state.read"],
  analyst: ["metadata.read", "demos.manage", "training.manage", "state.read"],
  viewer: ["metadata.read", "state.read"],
  captain: ["veto.captain"],
};

export function can(role: string | null | undefined, p: Permission): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role]?.includes(p) ?? false;
}

export function permissionReason(role: string | null | undefined, p: Permission): string | null {
  return can(role, p) ? null : `Your role (${role ?? "none"}) lacks ${p}`;
}

export const ROLE_DESCRIPTIONS: Record<string, string> = {
  owner: "Full control (local operator).",
  producer: "Metadata, HUD publishing, program, replays and director control.",
  observer: "Camera and director control (e.g. a Stream Deck / Companion on the observer desk).",
  graphics: "Metadata and HUD publishing.",
  replay: "Replay queue control.",
  analyst: "Demo library and training.",
  viewer: "Read-only state.",
  captain: "Scoped veto link for one team in one match. Never reads production telemetry.",
};
