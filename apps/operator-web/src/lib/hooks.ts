import { useCallback, useEffect, useRef, useState } from "react";
import { api, describeError } from "../api/index.ts";

export interface ApiState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  /** Re-fetches; resolves when done. */
  reload: () => Promise<void>;
  setData: (d: T | undefined) => void;
}

/**
 * GET a path (optionally polling). Keeps the last good data while refreshing; `path === null`
 * disables the request.
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
