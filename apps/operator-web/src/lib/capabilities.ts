import type { Capability, SourceCapabilities, Support } from "@matchframe/contracts";

export interface CapabilityMeta {
  label: string;
  /** What the operator should do to verify or enable it. */
  setupHint: string;
  group: "telemetry" | "control" | "utility" | "time";
}

export const CAPABILITY_META: Record<string, CapabilityMeta> = {
  allPlayerState: { label: "All-player state", setupHint: "use a spectator/observer client with the allplayers GSI components", group: "telemetry" },
  playerPositions: { label: "Player positions", setupHint: "enable allplayers_position in the GSI config (Setup → write GSI config)", group: "telemetry" },
  viewDirections: { label: "View directions", setupHint: "enable player forward vectors in the GSI config", group: "telemetry" },
  weaponReadiness: { label: "Weapon readiness", setupHint: "weapon/ammo components in the GSI config", group: "telemetry" },
  exactDamageEvents: { label: "Exact damage events", setupHint: "requires an authorized server-event adapter", group: "telemetry" },
  exactKillEvents: { label: "Exact kill events", setupHint: "requires an authorized server-event adapter", group: "telemetry" },
  grenadeEntities: { label: "Grenade entities", setupHint: "enable the grenades GSI component and wait for a grenade to be thrown", group: "utility" },
  grenadeLifecycle: { label: "Grenade lifecycle", setupHint: "observe grenades on a real feed", group: "utility" },
  utilityEffects: { label: "Utility effects", setupHint: "observe smokes/fires on a real feed", group: "utility" },
  grenadeDamageAttribution: { label: "Grenade damage attribution", setupHint: "requires exact damage events", group: "utility" },
  playerSelectionControl: { label: "Player selection", setupHint: "press Start Auto Director, or pick a player: it is confirmed when CS2 shows that player", group: "control" },
  observerModeControl: { label: "Observer mode control", setupHint: "confirmed with the first camera (getpos); press Start Auto Director", group: "control" },
  staticCameraControl: { label: "Static cameras", setupHint: "press Start Auto Director: it shows a camera and checks it with getpos", group: "control" },
  cameraPathControl: { label: "Camera paths", setupHint: "confirmed with the first static camera (the same console command)", group: "control" },
  cameraReadback: { label: "Camera readback", setupHint: "needs the CS2 console: Start CS2 in Tools mode", group: "control" },
  matchTimelineTime: { label: "Match timeline time", setupHint: "derived from ingest timing; no action needed", group: "time" },
};

const GRENADE_LABEL: Record<string, string> = { he: "HE grenade", flashbang: "Flashbang", smoke: "Smoke", molotov: "Molotov", incendiary: "Incendiary", decoy: "Decoy" };

export function capabilityMeta(key: string): CapabilityMeta {
  if (key.startsWith("grenadeTypeSupport.")) {
    const t = key.slice("grenadeTypeSupport.".length);
    return { label: `${GRENADE_LABEL[t] ?? t} telemetry`, setupHint: `wait for a ${GRENADE_LABEL[t] ?? t} to be thrown on a real feed`, group: "utility" };
  }
  return CAPABILITY_META[key] ?? { label: key, setupHint: "see Setup", group: "telemetry" };
}

/** Flattens the capability report (including per-grenade-type entries) into [key, capability] rows. */
export function flattenCapabilities(caps: SourceCapabilities | null | undefined): [string, Capability][] {
  if (!caps) return [];
  const rows: [string, Capability][] = [];
  for (const [k, v] of Object.entries(caps)) {
    if (k === "grenadeTypeSupport") {
      for (const [t, c] of Object.entries(v as Record<string, Capability>)) rows.push([`grenadeTypeSupport.${t}`, c]);
    } else rows.push([k, v as Capability]);
  }
  return rows;
}

export const SUPPORT_TEXT: Record<Support, { text: string; icon: string; tone: "ok" | "info" | "warn" | "danger" }> = {
  supported: { text: "SUPPORTED", icon: "✓", tone: "ok" },
  partial: { text: "PARTIAL", icon: "◐", tone: "info" },
  unverified: { text: "UNVERIFIED", icon: "?", tone: "warn" },
  unsupported: { text: "UNSUPPORTED", icon: "✕", tone: "danger" },
};

export interface Gate {
  enabled: boolean;
  /** Why the control is disabled (or a caveat when enabled with partial support). */
  reason: string | null;
  support: Support | "unknown";
}

/**
 * Maps a capability to an enable/disable decision with an operator-facing explanation, e.g.
 * "Static cameras: unverified — run the camera test in Setup".
 */
export function capabilityGate(key: string, cap: Capability | null | undefined, opts: { allowPartial?: boolean; allowUnverified?: boolean; simulated?: boolean } = {}): Gate {
  const meta = capabilityMeta(key);
  if (!cap) return { enabled: false, reason: `${meta.label}: unknown — no capability report yet (waiting for the engine)`, support: "unknown" };
  const firstLimitation = cap.limitations[0];
  switch (cap.support) {
    case "supported":
      return { enabled: true, reason: opts.simulated ? `${meta.label}: supported by the SIMULATION adapter only — does not certify live control` : null, support: "supported" };
    case "partial":
      if (opts.allowPartial === false) return { enabled: false, reason: `${meta.label}: partial — ${firstLimitation ?? meta.setupHint}`, support: "partial" };
      return { enabled: true, reason: `${meta.label}: partial${firstLimitation ? ` — ${firstLimitation}` : ""}`, support: "partial" };
    case "unverified":
      // A manual request is itself the check: the engine confirms it from the game's feedback.
      if (opts.allowUnverified) return { enabled: true, reason: `${meta.label}: not confirmed on this CS2 build yet — your first request confirms it`, support: "unverified" };
      return { enabled: false, reason: `${meta.label}: unverified — ${meta.setupHint}`, support: "unverified" };
    case "unsupported":
      return { enabled: false, reason: `${meta.label}: unsupported — ${firstLimitation ?? meta.setupHint}`, support: "unsupported" };
  }
}
