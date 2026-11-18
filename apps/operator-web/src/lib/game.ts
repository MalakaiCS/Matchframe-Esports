import { useCallback, useEffect, useState } from "react";
import type { HlaeInfo, HlaeResult } from "../api/auth.ts";
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

/** HLAE on this computer (program only): the program's own, kept up to date (ADR-084), or one chosen. */
export function useHlae(): {
  info: HlaeInfo | null;
  choose: (() => Promise<void>) | null;
  /** Get HLAE: the latest release, downloaded and checked. Throws with the reason. */
  get: (() => Promise<HlaeInfo>) | null;
  /** Check for a newer HLAE now; resolves with what happened. */
  check: (() => Promise<string>) | null;
  setAutoUpdate: ((on: boolean) => Promise<void>) | null;
} {
  const bridge = window.matchframe?.hlae;
  const [info, setInfo] = useState<HlaeInfo | null>(null);
  const [working, setWorking] = useState(false);
  const refresh = useCallback(async () => {
    if (bridge) setInfo(await bridge.info());
  }, [bridge]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  // While a download runs (here or from Start CS2), follow its progress.
  const busy = working || !!info?.status?.busy;
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => void refresh(), 700);
    return () => clearInterval(id);
  }, [busy, refresh]);
  const choose = useCallback(async () => {
    if (!bridge) return;
    const r = await bridge.choose();
    if (r) setInfo(r);
  }, [bridge]);
  const act = useCallback(
    async (fn: () => Promise<HlaeResult>) => {
      setWorking(true);
      try {
        const r = await fn();
        await refresh();
        if (!r.ok) throw new Error(r.error);
        return r.value;
      } finally {
        setWorking(false);
      }
    },
    [refresh],
  );
  const get = useCallback(() => act(() => bridge!.get!()), [act, bridge]);
  const check = useCallback(async () => (await act(() => bridge!.check!())).result ?? "", [act, bridge]);
  const setAutoUpdate = useCallback(
    async (on: boolean) => {
      const r = await bridge?.setAutoUpdate?.(on);
      if (r) setInfo(r);
    },
    [bridge],
  );
  return {
    info,
    choose: bridge ? choose : null,
    get: bridge?.get ? get : null,
    check: bridge?.check ? check : null,
    setAutoUpdate: bridge?.setAutoUpdate ? setAutoUpdate : null,
  };
}

/** Why Start CS2 can't run here, or null. */
export function launchUnavailableReason(): string | null {
  if (!window.matchframe?.launchCs2) return t("game.needsProgram");
  if (window.matchframe.connectionMode === "remote") return t("game.remote");
  return null;
}
