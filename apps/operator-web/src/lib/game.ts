import { useCallback, useEffect, useState } from "react";
import type { HlaeInfo } from "../api/auth.ts";
import { api } from "../api/index.ts";
import { useApi } from "./hooks.ts";
import { perLocale, t } from "../i18n/index.ts";

/** Start CS2 launch modes (services/local-engine/src/game/console.ts). */
export type GameLaunchMode = "standard" | "tools" | "hlae";

export interface ConsoleOptions {
  hideGameHud: boolean;
  xray: boolean;
  clutchXrayOff: boolean;
  retakeXrayOff: boolean;
  runInBackground: boolean;
  /** `fps_max` sent to CS2; null leaves CS2's own setting alone. */
  frameCap: number | null;
  noFlash: boolean;
  killfeedTeamColours: boolean;
  /** HLAE: the X-ray glow, the names above the players and grenade trails in the CT and T colours. */
  xrayColours: boolean;
  /** HLAE: smokes in the CT and T colours. */
  smokeColours: boolean;
  /** The CT and T colours chosen here, or each team's own (Teams → colour). */
  colourSource: "sides" | "teams";
  ctColour: string;
  tColour: string;
  hideEndOfMatch: boolean;
  hideGameKillfeed: boolean;
}

export interface GameLaunchProfile {
  mode: GameLaunchMode;
  netconPort: number;
  extraArgs: string;
  insecureAcknowledgedAt: string | null;
}

export interface GameConsoleStatus {
  profile: GameLaunchProfile;
  options: ConsoleOptions;
  console: "off" | "stopped" | "connecting" | "connected";
  port: number | null;
  connectedAt: string | null;
  lastError: string | null;
  lastApplyError: string | null;
  lastAppliedAt: string | null;
}

export const GAME_CONSOLE_PATH = "/api/v1/game/console";

export const LAUNCH_MODES: { id: GameLaunchMode; label: string; short: string; detail: string }[] = perLocale(() =>
  (["standard", "tools", "hlae"] as const).map((id) => ({ id, label: t(`game.mode.${id}.label`), short: t(`game.mode.${id}.short`), detail: t(`game.mode.${id}.detail`) })),
);

export const HLAE_WARNING: string[] = perLocale(() => [1, 2, 3, 4].map((n) => t(`game.hlaeWarning.w${n}`)));

export function useGameConsole(refreshMs = 3000) {
  return useApi<GameConsoleStatus>(GAME_CONSOLE_PATH, { refreshMs });
}

export function setLaunchProfile(p: { mode: GameLaunchMode; netconPort: number; extraArgs: string; acknowledgeInsecure?: boolean }): Promise<GameConsoleStatus> {
  return api.put<GameConsoleStatus>("/api/v1/game/launch-profile", p);
}

export function setConsoleOptions(patch: Partial<ConsoleOptions>): Promise<GameConsoleStatus> {
  return api.put<GameConsoleStatus>("/api/v1/game/console-options", patch);
}

/** HLAE.exe chosen on this computer (program only). */
export function useHlae(): { info: HlaeInfo | null; choose: (() => Promise<void>) | null } {
  const bridge = window.matchframe?.hlae;
  const [info, setInfo] = useState<HlaeInfo | null>(null);
  useEffect(() => {
    if (bridge) void bridge.info().then(setInfo);
  }, [bridge]);
  const choose = useCallback(async () => {
    if (!bridge) return;
    const r = await bridge.choose();
    if (r) setInfo(r);
  }, [bridge]);
  return { info, choose: bridge ? choose : null };
}

/** Why Start CS2 can't run here, or null. */
export function launchUnavailableReason(): string | null {
  if (!window.matchframe?.launchCs2) return t("game.needsProgram");
  if (window.matchframe.connectionMode === "remote") return t("game.remote");
  return null;
}
