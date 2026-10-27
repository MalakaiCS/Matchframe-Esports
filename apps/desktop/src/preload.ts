import { contextBridge, ipcRenderer } from "electron";

/**
 * Narrow, read-mostly bridge. No Node APIs, filesystem or arbitrary IPC reach the renderer. The main
 * process answers only frames from the program's own `app://matchframe` origin.
 */
const boot = (ipcRenderer.sendSync("mf:bootstrap") ?? null) as { engineOrigin: string; connectionMode: "local" | "remote" } | null;

contextBridge.exposeInMainWorld("matchframe", {
  engineOrigin: boot?.engineOrigin,
  connectionMode: boot?.connectionMode,
  getOperatorToken: (): Promise<string | null> => ipcRenderer.invoke("mf:token"),
  info: (): Promise<unknown> => ipcRenderer.invoke("mf:info"),
  openDataDir: (): Promise<string> => ipcRenderer.invoke("mf:open-data-dir"),
  restartEngine: (): Promise<boolean> => ipcRenderer.invoke("mf:restart-engine"),
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
  /** Connection settings page only (the main process refuses other pages). */
  connection: {
    get: (): Promise<unknown> => ipcRenderer.invoke("mf:connection-get"),
    test: (url: string, token: string): Promise<unknown> => ipcRenderer.invoke("mf:connection-test", { url, token }),
    save: (settings: { mode: "local" } | { mode: "remote"; url: string; token: string }): Promise<boolean> => ipcRenderer.invoke("mf:connection-save", settings),
    cancel: (): Promise<void> => ipcRenderer.invoke("mf:connection-cancel"),
  },
});
