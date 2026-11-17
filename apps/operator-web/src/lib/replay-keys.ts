import { useEffect } from "react";
import { api, describeError } from "../api/index.ts";
import { useToast } from "../components/toasts.tsx";
import { isTypingTarget } from "./hooks.ts";
import { perLocale, t } from "../i18n/index.ts";

/**
 * The operator's controls of the replays playing, by key (ADR-062):
 * - in the console, while it has the focus: Ctrl+Shift+F5 Skip, Ctrl+Shift+F6 Hold / Resume,
 *   Ctrl+Shift+F7 Stop and go live (useReplayShortcuts, on every screen);
 * - from any program, in the MatchFrame program on Windows: global hotkeys, off until set (the
 *   desktop bridge, replayHotkeys()). The same three keys are suggested, so one set of keys works
 *   whichever program is in front.
 *
 * Highlights on air (ADR-063) the same way: Ctrl+Shift+F9 Play highlights, Ctrl+Shift+F10 Stop
 * highlights; Skip and Hold are the replays' (F5, F6). Not F8: the console's own F8 stops automation.
 * Swap teams (Live Control): Ctrl+Shift+F11. Play map intro (ADR-079): Ctrl+Shift+F4.
 */

export type ReplayKeyAction = "skip" | "hold" | "stop" | "highlights" | "highlightsStop" | "swapTeams" | "mapIntro";

export interface ReplayKey {
  id: ReplayKeyAction;
  label: string;
  key: string;
  path: string;
}

export const REPLAY_KEYS: ReplayKey[] = perLocale(() => ([
  { id: "skip", label: t("lib.skip"), key: "F5", path: "/api/v1/replays/auto/skip" },
  { id: "hold", label: t("lib.holdResume"), key: "F6", path: "/api/v1/replays/auto/hold" },
  { id: "stop", label: t("lib.stopAndGoLive"), key: "F7", path: "/api/v1/replays/auto/stop" },
]));

/** Highlights on air: Play and Stop (Skip and Hold are the replays' keys). */
export const HIGHLIGHT_KEYS: ReplayKey[] = perLocale(() => ([
  { id: "highlights", label: t("lib.playHighlights"), key: "F9", path: "/api/v1/highlights/air/play" },
  { id: "highlightsStop", label: t("lib.stopHighlights"), key: "F10", path: "/api/v1/highlights/air/stop" },
]));

/** Swap teams: the active match's two teams change sides on the HUDs (Live Control). */
export const TEAM_KEYS: ReplayKey[] = perLocale(() => ([{ id: "swapTeams", label: t("lib.swapTeams"), key: "F11", path: "/api/v1/live/side-teams/swap" }]));

/** Map intros: Play map intro (the current map's intro). */
export const MAP_INTRO_KEYS: ReplayKey[] = perLocale(() => ([{ id: "mapIntro", label: t("lib.playMapIntro"), key: "F4", path: "/api/v1/map-intros/play" }]));

/** As the console shows a console shortcut. */
export const shortcutLabel = (key: string) => `Ctrl+Shift+${key}`;

/** The console shortcuts, while the console has the focus (not while typing in a field). */
export function useReplayShortcuts(enabled = true): void {
  const toast = useToast();
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey || isTypingTarget(e.target)) return;
      const k = REPLAY_KEYS.find((x) => x.key === e.key) ?? HIGHLIGHT_KEYS.find((x) => x.key === e.key) ?? TEAM_KEYS.find((x) => x.key === e.key) ?? MAP_INTRO_KEYS.find((x) => x.key === e.key);
      if (!k) return;
      e.preventDefault();
      const what = HIGHLIGHT_KEYS.includes(k) ? "Highlights" : TEAM_KEYS.includes(k) ? "Teams" : MAP_INTRO_KEYS.includes(k) ? t("lib.mapIntro") : "Replays";
      api.post(k.path).then(
        () => toast.push("ok", `${what}: ${k.label}`),
        (err) => toast.push("warn", `${what}: ${k.label}`, describeError(err)),
      );
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, toast]);
}

export interface ReplayHotkeyState {
  keys: Record<ReplayKeyAction, string | null>;
  registered: Record<ReplayKeyAction, boolean>;
  /** Why one isn't registered (another program holds it, …). */
  errors: Record<ReplayKeyAction, string | null>;
  suggested: Record<ReplayKeyAction, string>;
}

/** The MatchFrame program's global replay hotkeys (apps/desktop/src/replay-hotkeys.ts); null in a browser. */
export interface ReplayHotkeysBridge {
  get(): Promise<ReplayHotkeyState>;
  set(patch: Partial<Record<ReplayKeyAction, string | null>>): Promise<ReplayHotkeyState>;
}

export function replayHotkeys(): ReplayHotkeysBridge | null {
  return (window as unknown as { matchframe?: { replayHotkeys?: ReplayHotkeysBridge } }).matchframe?.replayHotkeys ?? null;
}
