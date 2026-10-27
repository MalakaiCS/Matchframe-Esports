import { app } from "electron";
import { autoUpdater } from "electron-updater";
import type { ProgressInfo, UpdateInfo } from "electron-updater";

/**
 * Automatic updates from the project's GitHub releases (electron-updater reads `latest.yml`, which
 * the release workflow attaches next to the installer). Updates download in the background and
 * install when the program quits, or straight away when the operator chooses Restart and update.
 * The program never restarts on its own: a broadcast is never interrupted by an update.
 * Development runs (not packaged) never update.
 */

export type UpdateStatus = "disabled" | "idle" | "checking" | "available" | "downloading" | "ready" | "up-to-date" | "error";

export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  /** Version being downloaded or ready to install. */
  version: string | null;
  /** Download progress 0–100 while downloading. */
  percent: number | null;
  releaseNotesUrl: string | null;
  checkedAt: string | null;
  error: string | null;
  /** Why updates are off (development build), or null. */
  disabledReason: string | null;
  /** Download updates automatically (the operator can turn this off). */
  autoDownload: boolean;
}

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 15_000;
const RELEASES = "https://github.com/MalakaiCS/Matchframe-Esports/releases";

export interface Updater {
  state(): UpdateState;
  check(): Promise<UpdateState>;
  download(): Promise<UpdateState>;
  /** Quits, installs the downloaded update and starts the new version. */
  installNow(): void;
  setAutoDownload(on: boolean): UpdateState;
  dispose(): void;
}

export function createUpdater(opts: { onChange(state: UpdateState): void; log(msg: string): void; autoDownload: boolean; saveAutoDownload(on: boolean): void; beforeInstall(): void }): Updater {
  const disabledReason = !app.isPackaged ? "Development builds don't update themselves." : process.env.MATCHFRAME_DISABLE_UPDATES === "1" ? "Updates are turned off on this computer (MATCHFRAME_DISABLE_UPDATES)." : null;
  let st: UpdateState = {
    status: disabledReason ? "disabled" : "idle",
    currentVersion: app.getVersion(),
    version: null,
    percent: null,
    releaseNotesUrl: null,
    checkedAt: null,
    error: null,
    disabledReason,
    autoDownload: opts.autoDownload,
  };
  const set = (patch: Partial<UpdateState>) => {
    st = { ...st, ...patch };
    opts.onChange(st);
  };
  const notes = (info: UpdateInfo) => `${RELEASES}/tag/v${info.version}`;
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 300);

  if (disabledReason) {
    return {
      state: () => st,
      check: async () => st,
      download: async () => st,
      installNow: () => undefined,
      setAutoDownload: (on) => {
        opts.saveAutoDownload(on);
        set({ autoDownload: on });
        return st;
      },
      dispose: () => undefined,
    };
  }

  autoUpdater.autoDownload = opts.autoDownload;
  // A downloaded update installs on the next quit, silently (per-user install, no prompt).
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = { info: (m: unknown) => opts.log(`[update] ${String(m)}`), warn: (m: unknown) => opts.log(`[update] ${String(m)}`), error: (m: unknown) => opts.log(`[update] ${String(m)}`), debug: () => undefined };

  autoUpdater.on("checking-for-update", () => set({ status: "checking", error: null }));
  autoUpdater.on("update-available", (info: UpdateInfo) => set({ status: autoUpdater.autoDownload ? "downloading" : "available", version: info.version, percent: autoUpdater.autoDownload ? 0 : null, releaseNotesUrl: notes(info), checkedAt: new Date().toISOString() }));
  autoUpdater.on("update-not-available", () => set({ status: "up-to-date", version: null, percent: null, checkedAt: new Date().toISOString() }));
  autoUpdater.on("download-progress", (p: ProgressInfo) => set({ status: "downloading", percent: Math.round(p.percent) }));
  autoUpdater.on("update-downloaded", (info: UpdateInfo) => set({ status: "ready", version: info.version, percent: 100, releaseNotesUrl: notes(info) }));
  autoUpdater.on("error", (e: unknown) => set({ status: "error", error: message(e), checkedAt: new Date().toISOString() }));

  const check = async (): Promise<UpdateState> => {
    if (st.status === "downloading" || st.status === "ready") return st;
    try {
      await autoUpdater.checkForUpdates();
    } catch (e) {
      set({ status: "error", error: message(e), checkedAt: new Date().toISOString() });
    }
    return st;
  };
  const first = setTimeout(() => void check(), FIRST_CHECK_MS);
  const every = setInterval(() => void check(), CHECK_EVERY_MS);

  return {
    state: () => st,
    check,
    download: async () => {
      if (st.status !== "available") return st;
      set({ status: "downloading", percent: 0 });
      try {
        await autoUpdater.downloadUpdate();
      } catch (e) {
        set({ status: "error", error: message(e) });
      }
      return st;
    },
    installNow: () => {
      if (st.status !== "ready") return;
      opts.beforeInstall();
      // Silent install, then start the new version.
      autoUpdater.quitAndInstall(true, true);
    },
    setAutoDownload: (on) => {
      autoUpdater.autoDownload = on;
      opts.saveAutoDownload(on);
      set({ autoDownload: on });
      return st;
    },
    dispose: () => {
      clearTimeout(first);
      clearInterval(every);
    },
  };
}
