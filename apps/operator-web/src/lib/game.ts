import { useCallback, useEffect, useState } from "react";
import type { HlaeInfo } from "../api/auth.ts";
import { api } from "../api/index.ts";
import { useApi } from "./hooks.ts";

/** Start CS2 launch modes (services/local-engine/src/game/console.ts). */
export type GameLaunchMode = "standard" | "tools" | "hlae";

export interface ConsoleOptions {
  hideGameHud: boolean;
  xray: boolean;
  clutchXrayOff: boolean;
  runInBackground: boolean;
  noFlash: boolean;
  killfeedTeamColours: boolean;
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

export const LAUNCH_MODES: { id: GameLaunchMode; label: string; short: string; detail: string }[] = [
  {
    id: "standard",
    label: "Standard",
    short: "Standard",
    detail: "CS2 through Steam with the game data (GSI) config. Works on any server. No console: camera control uses the keyboard fallback, or none.",
  },
  {
    id: "tools",
    label: "Observer tools",
    short: "Observer tools",
    detail: "Adds -tools -netconport: Matchframe controls the camera and the game options below through CS2's console. Needs the free CS2 Workshop Tools (Steam → Counter-Strike 2 → DLC).",
  },
  {
    id: "hlae",
    label: "Observer tools + HLAE",
    short: "Tools + HLAE",
    detail: "Also loads HLAE (advancedfx) for no flash, team colours in the kill feed or no game kill feed at all, and no end-of-match scene. CS2 runs insecure: only LAN, demos, or servers with tv_secure_bypass 1.",
  },
];

export const HLAE_WARNING = [
  "HLAE (advancedfx) hooks into CS2, and CS2 then runs with -insecure.",
  "Insecure CS2 cannot join VAC-secured servers: the match server must allow insecure observers (tv_secure_bypass 1), or use LAN or demos.",
  "Never join matchmaking or a VAC-secured server while HLAE is loaded: HLAE's developers warn this can get the account VAC banned.",
  "CS2 updates often break HLAE until HLAE is updated. Standard and Observer tools keep working.",
];

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
  if (!window.matchframe?.launchCs2) return "Starting CS2 needs the Matchframe program";
  if (window.matchframe.connectionMode === "remote") return "CS2 starts on the production computer: use Start CS2 there";
  return null;
}
