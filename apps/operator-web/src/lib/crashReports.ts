import { useCallback, useEffect, useState } from "react";

/** Crash reports from the program (apps/desktop/src/crash/reporter.ts, ADR-077). */
export interface CrashReportsState {
  enabled: boolean;
  /** Reports waiting to be sent (crash reports on), and waiting for the next start's question (off). */
  queued: number;
  waiting: number;
  /** Sent lately, newest first: the ids to quote to support. */
  recent: { id: string; process: string; sentAt: string }[];
  lastError: string | null;
}

export interface CrashReportSent {
  id: string;
  process: string;
}

const bridge = () => window.matchframe?.crashReports ?? null;

/** The program's crash report state (null in a browser or in tests), refreshed when a report is sent. */
export function useCrashReports(): { state: CrashReportsState | null; setEnabled: (on: boolean) => Promise<void> } {
  const [state, setState] = useState<CrashReportsState | null>(null);
  useEffect(() => {
    const b = bridge();
    if (!b) return;
    let alive = true;
    const load = () =>
      void b
        .state()
        .then((s) => alive && setState(s as CrashReportsState | null))
        .catch(() => undefined);
    load();
    const off = b.onSent(load);
    return () => {
      alive = false;
      off();
    };
  }, []);
  const setEnabled = useCallback(async (on: boolean) => {
    const s = (await bridge()?.setEnabled(on)) as CrashReportsState | null | undefined;
    if (s) setState(s);
  }, []);
  return { state, setEnabled };
}

/** Calls `fn` with each "Crash report sent (ID …)" from the program. */
export function onCrashReportSent(fn: (r: CrashReportSent) => void): () => void {
  return bridge()?.onSent((r) => fn(r as CrashReportSent)) ?? (() => undefined);
}
