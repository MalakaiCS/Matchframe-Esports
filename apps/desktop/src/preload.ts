import { contextBridge, ipcRenderer } from "electron";

/**
 * Narrow, read-mostly bridge. No Node APIs, filesystem or arbitrary IPC reach the renderer. The main
 * process answers only frames from the program's own `app://matchframe` origin.
 */
const boot = (ipcRenderer.sendSync("mf:bootstrap") ?? null) as { engineOrigin: string; connectionMode: "local" | "remote" } | null;
const hudAvailability = (ipcRenderer.sendSync("mf:hud-availability") ?? { available: false, reason: null }) as { available: boolean; reason: string | null };

/** `mf:hud-*` replies are `{ ok, value | error }`; errors become plain Error messages. */
async function hudCall<T>(channel: string, ...args: unknown[]): Promise<T> {
  const r = (await ipcRenderer.invoke(channel, ...args)) as { ok: true; value: T } | { ok: false; error: string };
  if (!r || typeof r !== "object") throw new Error("The program did not answer.");
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

contextBridge.exposeInMainWorld("matchframe", {
  engineOrigin: boot?.engineOrigin,
  connectionMode: boot?.connectionMode,
  platform: process.platform,
  /** The window has no system title bar: the console's header is the drag region (window buttons drawn over its right end). */
  customTitleBar: true,
  /** Start CS2 with the launch mode set in the engine (Steam, or HLAE). */
  launchCs2: (): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke("mf:launch-cs2"),
  /** HLAE.exe for the HLAE launch mode, chosen with a file dialog on this computer. */
  hlae: {
    info: (): Promise<{ path: string | null; ok: boolean; problem: string | null } | null> => ipcRenderer.invoke("mf:hlae-info"),
    choose: (): Promise<{ path: string | null; ok: boolean; problem: string | null } | null> => ipcRenderer.invoke("mf:hlae-choose"),
  },
  /** Automatic updates (apps/desktop/src/updater.ts). */
  updates: {
    state: (): Promise<unknown> => ipcRenderer.invoke("mf:update-state"),
    check: (): Promise<unknown> => ipcRenderer.invoke("mf:update-check"),
    download: (): Promise<unknown> => ipcRenderer.invoke("mf:update-download"),
    installNow: (): Promise<void> => ipcRenderer.invoke("mf:update-install"),
    setAutoDownload: (on: boolean): Promise<unknown> => ipcRenderer.invoke("mf:update-auto", on),
    onChange: (fn: (s: unknown) => void) => {
      const h = (_: unknown, s: unknown) => fn(s);
      ipcRenderer.on("mf:update", h);
      return () => ipcRenderer.removeListener("mf:update", h);
    },
  },
  getOperatorToken: (): Promise<string | null> => ipcRenderer.invoke("mf:token"),
  info: (): Promise<unknown> => ipcRenderer.invoke("mf:info"),
  openDataDir: (): Promise<string> => ipcRenderer.invoke("mf:open-data-dir"),
  /** The folder highlight reels go in, on this computer. */
  openHighlights: (): Promise<string> => ipcRenderer.invoke("mf:open-highlights"),
  restartEngine: (): Promise<boolean> => ipcRenderer.invoke("mf:restart-engine"),
  network: {
    get: (): Promise<{ networkAccess: boolean; local: boolean } | null> => ipcRenderer.invoke("mf:network-get"),
    set: (on: boolean): Promise<{ networkAccess: boolean; local: boolean } | null> => ipcRenderer.invoke("mf:network-set", on),
  },
  openConnection: (): Promise<void> => ipcRenderer.invoke("mf:open-connection"),
  onEngineStatus: (fn: (s: unknown) => void) => {
    const h = (_: unknown, s: unknown) => fn(s);
    ipcRenderer.on("mf:engine-status", h);
    return () => ipcRenderer.removeListener("mf:engine-status", h);
  },
  onEmergencyStop: (fn: (s: unknown) => void) => {
    const h = (_: unknown, s: unknown) => fn(s);
    ipcRenderer.on("mf:emergency-stop", h);
    return () => ipcRenderer.removeListener("mf:emergency-stop", h);
  },
  /** Desktop HUD windows and native dialogs (apps/operator-web/src/api/desktop.ts, DesktopHudBridge). */
  hud: {
    available: hudAvailability.available,
    unavailableReason: hudAvailability.reason,
    displays: () => hudCall("mf:hud-displays"),
    overlays: () => hudCall("mf:hud-overlay-list"),
    launch: (hudId: string, opts?: { variant?: string }) => hudCall("mf:hud-launch", hudId, opts ?? {}),
    close: (hudId: string) => hudCall("mf:hud-close", hudId),
    setVisible: (hudId: string, visible: boolean) => hudCall("mf:hud-set-visible", hudId, visible),
    configure: (hudId: string, patch: unknown) => hudCall("mf:hud-configure", hudId, patch),
    setEditing: (hudId: string, editing: boolean) => hudCall("mf:hud-set-editing", hudId, editing),
    openPreview: (hudId: string, opts: { variant: string; checker: boolean }) => hudCall("mf:hud-open-preview", hudId, opts),
    closePreviews: (hudId: string) => hudCall("mf:hud-close-previews", hudId),
    hideAll: () => hudCall("mf:hud-hide-all"),
    showAll: () => hudCall("mf:hud-show-all"),
    stopAll: () => hudCall("mf:hud-stop-all"),
    hotkeys: () => hudCall("mf:hud-hotkeys"),
    setHotkeys: (patch: unknown) => hudCall("mf:hud-set-hotkeys", patch),
    pickZip: () => hudCall("mf:hud-pick-zip"),
    pickFolder: () => hudCall("mf:hud-pick-folder"),
    openHudsFolder: () => hudCall("mf:hud-open-huds-folder"),
    openHudFolder: (hudId: string) => hudCall("mf:hud-open-hud-folder", hudId),
    saveFile: (name: string, bytes: Uint8Array) => hudCall("mf:hud-save-file", name, bytes),
    onOverlays: (fn: (overlays: unknown) => void) => {
      const h = (_: unknown, s: unknown) => fn(s);
      ipcRenderer.on("mf:hud-overlays", h);
      return () => ipcRenderer.removeListener("mf:hud-overlays", h);
    },
  },
  /** Connection settings page only (the main process refuses other pages). */
  connection: {
    get: (): Promise<unknown> => ipcRenderer.invoke("mf:connection-get"),
    test: (url: string, token: string): Promise<unknown> => ipcRenderer.invoke("mf:connection-test", { url, token }),
    save: (settings: { mode: "local" } | { mode: "remote"; url: string; token: string }): Promise<boolean> => ipcRenderer.invoke("mf:connection-save", settings),
    cancel: (): Promise<void> => ipcRenderer.invoke("mf:connection-cancel"),
  },
});
