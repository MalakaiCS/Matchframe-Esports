import { contextBridge, ipcRenderer } from "electron";

/** Narrow, read-mostly bridge. No Node APIs, filesystem or arbitrary IPC reach the renderer. */
contextBridge.exposeInMainWorld("matchframe", {
  getOperatorToken: (): Promise<string | null> => ipcRenderer.invoke("mf:token"),
  info: (): Promise<unknown> => ipcRenderer.invoke("mf:info"),
  openDataDir: (): Promise<string> => ipcRenderer.invoke("mf:open-data-dir"),
  restartEngine: (): Promise<boolean> => ipcRenderer.invoke("mf:restart-engine"),
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
});
