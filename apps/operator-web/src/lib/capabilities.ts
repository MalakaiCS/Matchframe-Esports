import type { Capability, SourceCapabilities, Support } from "@matchframe/contracts";
import { perLocale, t } from "../i18n/index.ts";

export interface CapabilityMeta {
  label: string;
  /** What the operator should do to verify or enable it. */
  setupHint: string;
  group: "telemetry" | "control" | "utility" | "time";
}

export const CAPABILITY_META: Record<string, CapabilityMeta> = perLocale(() => ({
  allPlayerState: { label: t("lib.allPlayerState"), setupHint: t("lib.useASpectatorObserverClient"), group: "telemetry" },
  playerPositions: { label: t("lib.playerPositions"), setupHint: t("lib.enableAllplayersPosition"), group: "telemetry" },
  viewDirections: { label: t("lib.viewDirections"), setupHint: t("lib.enablePlayerForwardVectorsIn"), group: "telemetry" },
  weaponReadiness: { label: t("lib.weaponReadiness"), setupHint: t("lib.weaponAmmoComponentsInThe"), group: "telemetry" },
  exactDamageEvents: { label: t("lib.exactDamageEvents"), setupHint: t("lib.requiresAnAuthorizedServerEvent"), group: "telemetry" },
  exactKillEvents: { label: t("lib.exactKillEvents"), setupHint: t("lib.requiresAnAuthorizedServerEvent"), group: "telemetry" },
  grenadeEntities: { label: t("lib.grenadeEntities"), setupHint: t("lib.enableTheGrenadesGsiComponent"), group: "utility" },
  grenadeLifecycle: { label: t("lib.grenadeLifecycle"), setupHint: t("lib.observeGrenadesOnAReal"), group: "utility" },
  utilityEffects: { label: t("lib.utilityEffects"), setupHint: t("lib.observeSmokesFiresOnA"), group: "utility" },
  grenadeDamageAttribution: { label: t("lib.grenadeDamageAttribution"), setupHint: t("lib.requiresExactDamageEvents"), group: "utility" },
  playerSelectionControl: { label: t("lib.playerSelection"), setupHint: t("lib.pressStartAutoDirectorOr"), group: "control" },
  observerModeControl: { label: t("lib.observerModeControl"), setupHint: t("lib.confirmedWithFirstCamera"), group: "control" },
  staticCameraControl: { label: t("lib.staticCameras"), setupHint: t("lib.pressStartAutoDirectorIt"), group: "control" },
  cameraPathControl: { label: t("lib.cameraPaths"), setupHint: t("lib.confirmedWithTheFirstStatic"), group: "control" },
  cameraReadback: { label: t("lib.cameraReadback"), setupHint: t("lib.needsTheCs2ConsoleStart"), group: "control" },
  matchTimelineTime: { label: t("lib.matchTimelineTime"), setupHint: t("lib.derivedFromIngest"), group: "time" },
}));

const GRENADE_LABEL: Record<string, string> = perLocale(() => ({ he: t("lib.heGrenade"), flashbang: "Flashbang", smoke: "Smoke", molotov: "Molotov", incendiary: "Incendiary", decoy: "Decoy" }));

export function capabilityMeta(key: string): CapabilityMeta {
  if (key.startsWith("grenadeTypeSupport.")) {
    const tRow = key.slice("grenadeTypeSupport.".length);
    return { label: t("lib.vTelemetry", { v: GRENADE_LABEL[tRow] ?? tRow }), setupHint: t("lib.waitForAVTo", { v: GRENADE_LABEL[tRow] ?? tRow }), group: "utility" };
  }
  return CAPABILITY_META[key] ?? { label: key, setupHint: t("lib.seeSetup"), group: "telemetry" };
}

/** Flattens the capability report (including per-grenade-type entries) into [key, capability] rows. */
export function flattenCapabilities(caps: SourceCapabilities | null | undefined): [string, Capability][] {
  if (!caps) return [];
  const rows: [string, Capability][] = [];
  for (const [k, v] of Object.entries(caps)) {
    if (k === "grenadeTypeSupport") {
      for (const [tRow, c] of Object.entries(v as Record<string, Capability>)) rows.push([`grenadeTypeSupport.${tRow}`, c]);
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
  if (!cap) return { enabled: false, reason: t("lib.labelUnknownNoCapabilityReport", { label: meta.label }), support: "unknown" };
  const firstLimitation = cap.limitations[0];
  switch (cap.support) {
    case "supported":
      return { enabled: true, reason: opts.simulated ? t("lib.labelSupportedByTheSimulation", { label: meta.label }) : null, support: "supported" };
    case "partial":
      if (opts.allowPartial === false) return { enabled: false, reason: t("lib.labelPartialV2", { label: meta.label, v: firstLimitation ?? meta.setupHint }), support: "partial" };
      return { enabled: true, reason: (firstLimitation ? t("lib.labelPartialV2", { label: meta.label, v: firstLimitation }) : t("lib.labelPartial", { label: meta.label })), support: "partial" };
    case "unverified":
      // A manual request is itself the check: the engine confirms it from the game's feedback.
      if (opts.allowUnverified) return { enabled: true, reason: t("lib.labelNotConfirmedOnThis", { label: meta.label }), support: "unverified" };
      return { enabled: false, reason: t("lib.labelUnverifiedSetuphint", { label: meta.label, setupHint: meta.setupHint }), support: "unverified" };
    case "unsupported":
      return { enabled: false, reason: t("lib.labelUnsupportedV", { label: meta.label, v: firstLimitation ?? meta.setupHint }), support: "unsupported" };
  }
}
