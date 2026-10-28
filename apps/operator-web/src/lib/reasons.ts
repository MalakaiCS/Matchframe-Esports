import type { ReasonCode } from "@matchframe/contracts";

export type ReasonTone = "neutral" | "info" | "warn" | "danger" | "ok";

interface ReasonInfo {
  label: string;
  tone: ReasonTone;
  /** One-line explanation for tooltips and the hold-vs-cut panel. */
  hint: string;
}

/**
 * Human-readable labels for every director reason code. The Record type makes the compiler reject
 * a missing code when the contracts gain a new one.
 */
export const REASON_INFO: Record<ReasonCode, ReasonInfo> = {
  CURRENT_SHOT_VALID: { label: "Current shot still valid", tone: "neutral", hint: "The shot on air still shows relevant action." },
  CURRENT_SHOT_LOW_ACTION: { label: "Current shot low action", tone: "info", hint: "Little is happening on the current shot." },
  CURRENT_SHOT_INVALID: { label: "Current shot invalid", tone: "warn", hint: "The current shot can no longer be used (target gone or invalid)." },
  CURRENT_POV_DEAD: { label: "Current POV dead", tone: "warn", hint: "The spectated player died." },
  MIN_SHOT_DURATION: { label: "Minimum shot duration", tone: "neutral", hint: "Holding until the minimum shot length has elapsed." },
  ADVANTAGE_BELOW_THRESHOLD: { label: "Advantage below threshold", tone: "neutral", hint: "The best alternative is not enough better than the current shot to justify a cut." },
  ADVANTAGE_NOT_PERSISTENT: { label: "Advantage not yet persistent", tone: "neutral", hint: "The alternative must stay better across several updates before cutting." },
  CONTACT_LIKELY_SOON: { label: "Contact likely soon", tone: "info", hint: "Players are converging; a fight is likely within a few seconds." },
  CONTACT_IMMINENT: { label: "Contact imminent", tone: "info", hint: "A fight is expected within about a second." },
  CT_PUSH_BEFORE_T_EXECUTE: { label: "CT push before T execute", tone: "info", hint: "CTs are pushing before the Ts commit." },
  T_GROUP_DEVELOPING: { label: "T group developing", tone: "info", hint: "Terrorists are grouping for a hit." },
  EXECUTE_DEVELOPING: { label: "Execute developing", tone: "info", hint: "A site execute is forming." },
  CROSSFIRE_SETUP: { label: "Crossfire setup", tone: "info", hint: "Defenders are set up in a crossfire." },
  TRADE_OPPORTUNITY: { label: "Trade opportunity", tone: "info", hint: "A teammate is in position to trade." },
  POST_EVENT_HOLD: { label: "Post-event hold", tone: "neutral", hint: "Holding briefly after a kill/event so viewers can follow it." },
  SECOND_CONTACT_LIKELY: { label: "Second contact likely", tone: "info", hint: "Another fight is likely right after this one." },
  BOMB_PLANT_PRESSURE: { label: "Bomb plant pressure", tone: "info", hint: "The bomb plant is in progress or about to happen." },
  BOMB_DEFUSE_PRESSURE: { label: "Bomb defuse pressure", tone: "info", hint: "A defuse is in progress or about to happen." },
  BOMB_CRITICAL: { label: "Bomb critical", tone: "warn", hint: "Bomb timer is in its critical window." },
  CLUTCH: { label: "Clutch", tone: "info", hint: "A clutch situation (1vX)." },
  RETAKE: { label: "Retake", tone: "info", hint: "Defenders are retaking a site." },
  PLAYER_FLASHED: { label: "Player flashed", tone: "warn", hint: "The target is flashed; their POV is a poor shot." },
  PLAYER_RELOADING: { label: "Player reloading", tone: "neutral", hint: "The target is reloading." },
  PLAYER_READY: { label: "Player ready", tone: "neutral", hint: "The target is ready to fight (weapon ready, not flashed)." },
  ISOLATED_AGGRESSOR: { label: "Isolated aggressor", tone: "info", hint: "A lone player is pushing aggressively." },
  UTILITY_INCOMING: { label: "Utility incoming", tone: "info", hint: "Grenade(s) about to take effect." },
  UTILITY_CLUSTER_TARGET: { label: "Utility hits a group", tone: "info", hint: "Utility is landing on a group of players." },
  UTILITY_VOLLEY: { label: "Utility volley", tone: "info", hint: "Several grenades land together." },
  UTILITY_LOW_VALUE: { label: "Utility low value", tone: "neutral", hint: "The utility is unlikely to matter on screen." },
  UTILITY_NO_CAMERA: { label: "No camera for utility", tone: "warn", hint: "No validated static camera covers the utility; falling back to POV/radar/hold." },
  CINEMATIC_BUDGET_EXHAUSTED: { label: "Cinematic budget used", tone: "neutral", hint: "The per-round cinematic budget is used up." },
  CINEMATIC_DISABLED: { label: "Cinematics disabled", tone: "neutral", hint: "Cinematics are disabled for this round/map/match." },
  CINEMATIC_ELIGIBLE: { label: "Cinematic eligible", tone: "info", hint: "A cinematic camera shot is available." },
  CINEMATIC_INTERRUPTED: { label: "Cinematic interrupted", tone: "warn", hint: "A cinematic was cut short by more important action." },
  OBSERVER_MODE_EXCLUDES: { label: "Not in this Observer mode", tone: "neutral", hint: "This shot type is not part of the selected Observer mode (nade cameras need Full Action Observer; cinematics need Observer & Cinematics)." },
  CAMERA_UNVERIFIED: { label: "Camera unverified", tone: "warn", hint: "The camera has not been validated on this map revision/build." },
  COOLDOWN_ACTIVE: { label: "Cooldown active", tone: "neutral", hint: "A recently abandoned shot is cooling down." },
  STALE_DATA: { label: "Stale data", tone: "danger", hint: "Telemetry is stale; automated decisions are unsafe." },
  LOW_CONFIDENCE: { label: "Low confidence", tone: "warn", hint: "The decision confidence is low." },
  MANUAL_OWNERSHIP: { label: "Manual ownership", tone: "warn", hint: "The operator owns the camera; the director only recommends." },
  EMERGENCY_STOP: { label: "Emergency stop", tone: "danger", hint: "Automation is emergency-stopped." },
  PINNED: { label: "Pinned", tone: "info", hint: "The operator pinned a player/side; candidates are restricted." },
  HOLD_REQUESTED: { label: "Hold requested", tone: "info", hint: "The operator asked the director to hold the current shot." },
  WALL_SEPARATED: { label: "Wall separated", tone: "neutral", hint: "Players are separated by geometry; contact is less likely." },
  DISTANCE_CLOSING: { label: "Distance closing", tone: "info", hint: "Opponents are closing distance." },
  MAIN_STORY: { label: "Main story", tone: "info", hint: "Part of the round's main storyline." },
  ESTABLISHING: { label: "Establishing shot", tone: "neutral", hint: "An establishing shot to orient viewers." },
  NO_VALID_CANDIDATE: { label: "No valid candidate", tone: "warn", hint: "No usable shot was found; holding." },
  MAIN_OBSERVER_ON_IT: { label: "Main camera has them", tone: "neutral", hint: "Replay PC: the main PC already shows this player, so this computer films someone else." },
};

export function reasonInfo(code: string): ReasonInfo {
  return (REASON_INFO as Record<string, ReasonInfo | undefined>)[code] ?? { label: `Unrecognised reason (${code})`, tone: "neutral", hint: "This reason code is newer than this console." };
}

export function reasonLabel(code: string): string {
  return reasonInfo(code).label;
}
