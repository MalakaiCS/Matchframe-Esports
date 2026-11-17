import { useEffect, useState } from "react";

export type UpdateChannel = "stable" | "beta";

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
  /** Missing from programs up to 0.12.4 (read as Stable). */
  channel?: UpdateChannel;
  /** `version` is older than this one: the latest Stable version while running a beta. */
  downgrade?: boolean;
}

/** An earlier Stable version (apps/desktop/src/rollback.ts) and what going back does to this computer's data. */
export interface RollbackOption {
  version: string;
  publishedAt: string | null;
  notesUrl: string;
  data: { kind: "fresh" | "keep" | "restore" | "refuse"; text: string };
}

export type RollbackProgress = { stage: "checking" | "verifying" | "confirming" | "installing"; version: string } | { stage: "downloading"; version: string; percent: number | null };

export interface RollbackResult {
  ok: boolean;
  cancelled?: boolean;
  message: string;
}

const bridge = () => window.matchframe?.updates ?? null;
const rollbackBridge = () => window.matchframe?.rollback ?? null;

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
  setChannel: (channel: UpdateChannel) => bridge()?.setChannel?.(channel) as Promise<UpdateState | null> | undefined,
};

/** Go back to a previous version: null when this program can't (a browser, or a program up to 0.12.4). */
export const rollback = {
  available: () => rollbackBridge() !== null,
  list: async (): Promise<RollbackOption[]> => {
    const b = rollbackBridge();
    if (!b) throw new Error("Going back to a previous version needs the MatchFrame program.");
    return (await b.list()) as RollbackOption[];
  },
  start: async (version: string, opts?: { toStable?: boolean }): Promise<RollbackResult> => {
    const b = rollbackBridge();
    if (!b) throw new Error("Going back to a previous version needs the MatchFrame program.");
    return (await b.start(version, opts)) as RollbackResult;
  },
};

/** Progress of a step back pushed by the program (null when nothing is happening). */
export function useRollbackProgress(): [RollbackProgress | null, (p: RollbackProgress | null) => void] {
  const [p, setP] = useState<RollbackProgress | null>(null);
  useEffect(() => rollbackBridge()?.onProgress((x) => setP(x as RollbackProgress)), []);
  return [p, setP];
}

export function rollbackProgressText(p: RollbackProgress): string {
  switch (p.stage) {
    case "checking":
      return `Checking version ${p.version}…`;
    case "downloading":
      return `Downloading version ${p.version}${p.percent !== null ? ` (${p.percent} %)` : ""}…`;
    case "verifying":
      return "Checking the download against the release's SHA-256…";
    case "confirming":
      return "Waiting for your answer in the dialog…";
    case "installing":
      return `Installing version ${p.version}…`;
  }
}

export function updateSummary(st: UpdateState): string {
  switch (st.status) {
    case "disabled":
      return st.disabledReason ?? "Updates are off";
    case "checking":
      return "Checking for updates…";
    case "available":
      return st.downgrade ? `Version ${st.version} is the latest Stable version. It's older than this beta (${st.currentVersion}); install it to go back to Stable` : `Version ${st.version} is available`;
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
