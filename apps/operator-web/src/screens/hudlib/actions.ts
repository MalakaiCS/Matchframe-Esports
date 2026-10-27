import { useCallback } from "react";
import type { HudLibraryEntry, HudVariant } from "@matchframe/contracts";
import { api, describeError, seg } from "../../api/index.ts";
import type { DesktopHudBridge } from "../../api/desktop.ts";
import { useToast } from "../../components/toasts.tsx";
import { saveBlob } from "../../lib/format.ts";
import { defaultVariant } from "../../lib/hudLibrary.ts";

export const LIBRARY_PATH = "/api/v1/hud/library";
export const hudPath = (id: string) => `${LIBRARY_PATH}/${seg(id)}`;

/** Launch Transparent HUD: clear the stopped flag (engine), then open the desktop overlay window. */
export async function launchHud(bridge: DesktopHudBridge | null, e: HudLibraryEntry, variant?: HudVariant): Promise<void> {
  await api.post(`${hudPath(e.id)}/start`);
  if (bridge) await bridge.launch(e.id, { variant: variant ?? defaultVariant(e) });
}

/** Start the HUD's outputs (OBS sources and previews show it again) without opening a desktop window. */
export async function startHud(e: HudLibraryEntry): Promise<void> {
  await api.post(`${hudPath(e.id)}/start`);
}

/**
 * Stop: close the desktop overlay and preview windows, then stop the HUD on the engine (OBS sources
 * stay connected but show nothing). The engine stop runs even if a window fails to close.
 */
export async function stopHud(bridge: DesktopHudBridge | null, e: HudLibraryEntry): Promise<void> {
  const windows: PromiseSettledResult<void>[] = bridge?.available ? await Promise.allSettled([bridge.close(e.id), bridge.closePreviews(e.id)]) : [];
  await api.post(`${hudPath(e.id)}/stop`);
  const failed = windows.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw new Error(`Stopped on the engine, but a desktop window did not close: ${describeError(failed.reason)}`);
}

export async function reloadHud(e: HudLibraryEntry): Promise<void> {
  await api.post(`${hudPath(e.id)}/reload`);
}

/** Export ZIP: authenticated download, saved through the program's save dialog or as a browser download. */
export async function exportHud(bridge: DesktopHudBridge | null, e: HudLibraryEntry): Promise<string | null> {
  const { blob, filename } = await api.download(`${hudPath(e.id)}/export`);
  const name = filename ?? `${e.id}-${e.version}.zip`;
  if (bridge) {
    const saved = await bridge.saveFile(name, new Uint8Array(await blob.arrayBuffer()));
    return saved ? name : null;
  }
  saveBlob(blob, name);
  return name;
}

/** Reasons the built-in HUD (part of the program) cannot do package things. */
export const BUILTIN_REASON = {
  duplicate: "The built-in HUD is part of the program and cannot be duplicated",
  export: "The built-in HUD is part of the program and cannot be exported",
  folder: "The built-in HUD is part of the program and has no folder",
  remove: "The built-in HUD is part of the program and cannot be removed",
} as const;

/** Runs an async action with a toast for success (optional) and failure. */
export function useRun() {
  const toast = useToast();
  return useCallback(
    async <T>(label: string, fn: () => Promise<T>, success?: string | ((r: T) => string | null)): Promise<T | undefined> => {
      try {
        const r = await fn();
        const msg = typeof success === "function" ? success(r) : success;
        if (msg) toast.push("ok", msg);
        return r;
      } catch (err) {
        toast.push("danger", `${label} failed`, describeError(err));
        return undefined;
      }
    },
    [toast],
  );
}
