import { useEffect, useState } from "react";

/** Automatic update state from the program (apps/desktop/src/updater.ts). */
export interface UpdateState {
  status: "disabled" | "idle" | "checking" | "available" | "downloading" | "ready" | "up-to-date" | "error";
  currentVersion: string;
  version: string | null;
  percent: number | null;
  releaseNotesUrl: string | null;
  checkedAt: string | null;
  error: string | null;
  disabledReason: string | null;
  autoDownload: boolean;
}

const bridge = () => window.matchframe?.updates ?? null;

/** Current update state (null in a browser or in tests), kept up to date by the program's pushes. */
export function useUpdates(): UpdateState | null {
  const [st, setSt] = useState<UpdateState | null>(null);
  useEffect(() => {
    const b = bridge();
    if (!b) return;
    let alive = true;
    void b
      .state()
      .then((s) => alive && setSt(s as UpdateState | null))
      .catch(() => undefined);
    const off = b.onChange((s) => alive && setSt(s as UpdateState));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return st;
}

export const updates = {
  check: () => bridge()?.check() as Promise<UpdateState | null> | undefined,
  download: () => bridge()?.download() as Promise<UpdateState | null> | undefined,
  installNow: () => bridge()?.installNow(),
  setAutoDownload: (on: boolean) => bridge()?.setAutoDownload(on) as Promise<UpdateState | null> | undefined,
};

export function updateSummary(st: UpdateState): string {
  switch (st.status) {
    case "disabled":
      return st.disabledReason ?? "Updates are off";
    case "checking":
      return "Checking for updates…";
    case "available":
      return `Version ${st.version} is available`;
    case "downloading":
      return `Downloading version ${st.version}${st.percent !== null ? ` (${st.percent} %)` : ""}…`;
    case "ready":
      return `Version ${st.version} is ready: it installs when you quit, or restart now`;
    case "up-to-date":
      return `Up to date (version ${st.currentVersion})`;
    case "error":
      return `Update check failed: ${st.error ?? "unknown error"}`;
    default:
      return `Version ${st.currentVersion}`;
  }
}
