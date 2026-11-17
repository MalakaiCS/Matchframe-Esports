import { useEffect, useState } from "react";
import { t } from "../i18n/index.ts";

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
    if (!b) throw new Error(t("settings.updates.needsProgram"));
    return (await b.list()) as RollbackOption[];
  },
  start: async (version: string, opts?: { toStable?: boolean }): Promise<RollbackResult> => {
    const b = rollbackBridge();
    if (!b) throw new Error(t("settings.updates.needsProgram"));
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
      return t("settings.rollback.checking", { version: p.version });
    case "downloading":
      return p.percent !== null ? t("settings.rollback.downloadingPct", { version: p.version, percent: p.percent }) : t("settings.rollback.downloading", { version: p.version });
    case "verifying":
      return t("settings.rollback.verifying");
    case "confirming":
      return t("settings.rollback.confirming");
    case "installing":
      return t("settings.rollback.installing", { version: p.version });
  }
}

export function updateSummary(st: UpdateState): string {
  switch (st.status) {
    case "disabled":
      return st.disabledReason ?? t("settings.updates.off");
    case "checking":
      return t("settings.updates.checking");
    case "available":
      return st.downgrade ? t("settings.updates.availableStable", { version: st.version, current: st.currentVersion }) : t("settings.updates.available", { version: st.version });
    case "downloading":
      return st.percent !== null ? t("settings.updates.downloadingPct", { version: st.version, percent: st.percent }) : t("settings.updates.downloading", { version: st.version });
    case "ready":
      return t("settings.updates.ready", { version: st.version });
    case "up-to-date":
      return t("settings.updates.upToDate", { version: st.currentVersion });
    case "error":
      return t("settings.updates.failed", { error: st.error ?? t("settings.updates.unknownError") });
    default:
      return t("settings.updates.version", { version: st.currentVersion });
  }
}
