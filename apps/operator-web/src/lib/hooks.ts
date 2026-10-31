import { useCallback, useEffect, useRef, useState } from "react";
import { api, describeError } from "../api/index.ts";
import { useLive } from "../state/live.ts";

export interface ApiState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  /** Re-fetches; resolves when done. */
  reload: () => Promise<void>;
  setData: (d: T | undefined) => void;
}

/** Lists account sync changes (teams, players, events, matches, veto, stages, the HUD Library). */
const SYNCED_PATHS = ["/api/v1/teams", "/api/v1/players", "/api/v1/events", "/api/v1/matches", "/api/v1/veto/", "/api/v1/stages", "/api/v1/hud/library"];
export const isSyncedPath = (path: string) => SYNCED_PATHS.some((p) => path.startsWith(p));

/**
 * GET a path (optionally polling). Keeps the last good data while refreshing; `path === null`
 * disables the request. Lists account sync changes reload when another computer's changes arrive.
 */
export function useApi<T>(path: string | null, opts: { refreshMs?: number } = {}): ApiState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(path !== null);
  const current = useRef(path);
  current.current = path;
  const seq = useRef(0);

  const load = useCallback(async () => {
    const p = current.current;
    if (p === null) return;
    const my = ++seq.current;
    setLoading(true);
    try {
      const d = await api.get<T>(p);
      if (my === seq.current && current.current === p) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (my === seq.current) setError(describeError(e));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (path === null) {
      setData(undefined);
      setLoading(false);
      return;
    }
    setData(undefined);
    void load();
    if (!opts.refreshMs) return;
    const t = setInterval(() => {
      if (document.visibilityState !== "hidden") void load();
    }, opts.refreshMs);
    return () => clearInterval(t);
  }, [path, opts.refreshMs, load]);

  const dataVersion = useLive((s) => (path !== null && isSyncedPath(path) ? (s.snapshot?.dataVersion ?? null) : null));
  const seenVersion = useRef<number | null>(null);
  useEffect(() => {
    if (dataVersion === null) return;
    if (seenVersion.current !== null && seenVersion.current !== dataVersion) void load();
    seenVersion.current = dataVersion;
  }, [dataVersion, load]);

  return { data, error, loading, reload: load, setData };
}

/** Local state persisted in localStorage (per-viewer UI conveniences only). */
export function usePersistentState<T>(key: string, fallback: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(`matchframe.ui.${key}`);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  });
  const set = useCallback(
    (nv: T) => {
      setV(nv);
      try {
        window.localStorage.setItem(`matchframe.ui.${key}`, JSON.stringify(nv));
      } catch {
        // ignore
      }
    },
    [key],
  );
  return [v, set];
}

/** True when keyboard focus is in a text-entry element (shortcuts must not fire there). */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (t as HTMLInputElement).type;
    return !["button", "checkbox", "radio", "submit", "reset", "range", "color", "file"].includes(type);
  }
  return false;
}
