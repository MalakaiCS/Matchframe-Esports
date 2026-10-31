import { useEffect } from "react";
import { api, describeError } from "../api/index.ts";
import { useToast } from "../components/toasts.tsx";
import { isTypingTarget } from "./hooks.ts";

/**
 * The operator's controls of the replays playing, by key (ADR-062):
 * - in the console, while it has the focus: Ctrl+Shift+F5 Skip, Ctrl+Shift+F6 Hold / Resume,
 *   Ctrl+Shift+F7 Stop and go live (useReplayShortcuts, on every screen);
 * - from any program, in the Matchframe program on Windows: global hotkeys, off until set (the
 *   desktop bridge, replayHotkeys()). The same three keys are suggested, so one set of keys works
 *   whichever program is in front.
 */

export type ReplayKeyAction = "skip" | "hold" | "stop";

export const REPLAY_KEYS: { id: ReplayKeyAction; label: string; key: string; path: string }[] = [
  { id: "skip", label: "Skip", key: "F5", path: "/api/v1/replays/auto/skip" },
  { id: "hold", label: "Hold / Resume", key: "F6", path: "/api/v1/replays/auto/hold" },
  { id: "stop", label: "Stop and go live", key: "F7", path: "/api/v1/replays/auto/stop" },
];

/** As the console shows a console shortcut. */
export const shortcutLabel = (key: string) => `Ctrl+Shift+${key}`;

/** The console shortcuts, while the console has the focus (not while typing in a field). */
export function useReplayShortcuts(enabled = true): void {
  const toast = useToast();
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey || isTypingTarget(e.target)) return;
      const k = REPLAY_KEYS.find((x) => x.key === e.key);
      if (!k) return;
      e.preventDefault();
      api.post(k.path).then(
        () => toast.push("ok", `Replays: ${k.label}`),
        (err) => toast.push("warn", `Replays: ${k.label}`, describeError(err)),
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

/** The Matchframe program's global replay hotkeys (apps/desktop/src/replay-hotkeys.ts); null in a browser. */
export interface ReplayHotkeysBridge {
  get(): Promise<ReplayHotkeyState>;
  set(patch: Partial<Record<ReplayKeyAction, string | null>>): Promise<ReplayHotkeyState>;
}

export function replayHotkeys(): ReplayHotkeysBridge | null {
  return (window as unknown as { matchframe?: { replayHotkeys?: ReplayHotkeysBridge } }).matchframe?.replayHotkeys ?? null;
}
