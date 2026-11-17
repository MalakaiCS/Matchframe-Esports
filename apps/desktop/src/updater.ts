import { app } from "electron";
import { autoUpdater } from "electron-updater";
import type { ProgressInfo, UpdateInfo } from "electron-updater";
import { compareVersions, fitsChannel, updaterSettings, type UpdateChannel } from "./versions.ts";

/**
 * Automatic updates from the project's GitHub releases (electron-updater reads `latest.yml`, which
 * the release workflow attaches next to the installer). Updates download in the background and
 * install when the program quits, or straight away when the operator chooses Restart and update.
 * The program never restarts on its own: a broadcast is never interrupted by an update.
 * Development runs (not packaged) never update.
 *
 * Update channel (ADR-076): Stable (default) or Beta (GitHub prereleases such as 0.13.0-beta.1, read
 * from beta.yml). Back on Stable while running a beta, the latest Stable version can be older: it is
 * offered (`downgrade`) and installs only through Go back to a previous version (rollback.ts), which
 * checks the installer, keeps the data safe and asks first. It is never downloaded here.
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
  channel: UpdateChannel;
  /** `version` is older than this one (back to Stable from a beta). */
  downgrade: boolean;
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
  setChannel(channel: UpdateChannel): Promise<UpdateState>;
  /** A downloaded update must not install when the program quits (another version is being installed). */
  skipInstallOnQuit(): void;
  dispose(): void;
}

export function createUpdater(opts: {
  onChange(state: UpdateState): void;
  log(msg: string): void;
  autoDownload: boolean;
  saveAutoDownload(on: boolean): void;
  channel: UpdateChannel;
  saveChannel(channel: UpdateChannel): void;
  beforeInstall(): void;
}): Updater {
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
    channel: opts.channel,
    downgrade: false,
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
      setChannel: async (channel) => {
        opts.saveChannel(channel);
        set({ channel });
        return st;
      },
      skipInstallOnQuit: () => undefined,
      dispose: () => undefined,
    };
  }

  const current = st.currentVersion;
  const apply = () => {
    const s = updaterSettings(st.channel, current);
    // Setting the channel turns allowDowngrade on, so allowDowngrade is set after it.
    autoUpdater.channel = s.channel;
    autoUpdater.allowPrerelease = s.allowPrerelease;
    autoUpdater.allowDowngrade = s.allowDowngrade;
    // An older version (found only on Stable while running a beta) is never downloaded by itself.
    autoUpdater.autoDownload = st.autoDownload && !s.allowDowngrade;
  };
  apply();
  // A downloaded update installs on the next quit, silently (per-user install, no prompt).
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: (m: unknown) => opts.log(`[update] ${String(m)}`), warn: (m: unknown) => opts.log(`[update] ${String(m)}`), error: (m: unknown) => opts.log(`[update] ${String(m)}`), debug: () => undefined };

  autoUpdater.on("checking-for-update", () => set({ status: "checking", error: null }));
  autoUpdater.on("update-available", (info: UpdateInfo) => {
    const downgrade = compareVersions(info.version, current) < 0;
    const downloading = !downgrade && st.autoDownload;
    set({ status: downloading ? "downloading" : "available", version: info.version, percent: downloading ? 0 : null, downgrade, releaseNotesUrl: notes(info), checkedAt: new Date().toISOString() });
    // On Stable while running a beta electron-updater doesn't download by itself; a newer version still downloads.
    if (downloading && !autoUpdater.autoDownload) autoUpdater.downloadUpdate().catch((e: unknown) => set({ status: "error", error: message(e) }));
  });
  autoUpdater.on("update-not-available", () => set({ status: "up-to-date", version: null, percent: null, downgrade: false, checkedAt: new Date().toISOString() }));
  autoUpdater.on("download-progress", (p: ProgressInfo) => set({ status: "downloading", percent: Math.round(p.percent) }));
  autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
    // A download for the channel the operator has just left (a beta, now on Stable) is not installed.
    if (!fitsChannel(info.version, st.channel)) {
      autoUpdater.autoInstallOnAppQuit = false;
      set({ status: "idle", version: null, percent: null });
      return;
    }
    autoUpdater.autoInstallOnAppQuit = true;
    set({ status: "ready", version: info.version, percent: 100, downgrade: false, releaseNotesUrl: notes(info) });
  });
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
      if (st.status !== "available" || st.downgrade) return st;
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
      opts.saveAutoDownload(on);
      set({ autoDownload: on });
      apply();
      return st;
    },
    setChannel: async (channel) => {
      if (channel === st.channel) return st;
      opts.saveChannel(channel);
      const keep = st.status === "ready" && st.version !== null && fitsChannel(st.version, channel);
      // A beta already downloaded doesn't install on quit once the operator is back on Stable.
      if (st.status === "ready" && !keep) autoUpdater.autoInstallOnAppQuit = false;
      set(keep ? { channel } : { channel, status: "idle", version: null, percent: null, downgrade: false, error: null });
      apply();
      return keep ? st : check();
    },
    skipInstallOnQuit: () => {
      autoUpdater.autoInstallOnAppQuit = false;
    },
    dispose: () => {
      clearTimeout(first);
      clearInterval(every);
    },
  };
}
