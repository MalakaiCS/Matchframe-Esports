import { useCallback, useEffect, useRef, useState } from "react";
import { describeError } from "../api/client.ts";

export interface Resource<T> {
  data: T | undefined;
  /** Readable message of the last failure (null when the last load succeeded). */
  error: string | null;
  /** The raw error, for code-specific handling. */
  cause: unknown;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (d: T | undefined) => void;
}

/**
 * Loads data with `load` whenever `key` changes (null key = disabled). Keeps the last good data
 * while reloading and ignores responses that arrive after a newer request started.
 */
export function useResource<T>(key: string | null, load: () => Promise<T>): Resource<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [cause, setCause] = useState<unknown>(null);
  const [loading, setLoading] = useState(key !== null);
  const loader = useRef(load);
  loader.current = load;
  const seq = useRef(0);
  const keyRef = useRef(key);
  keyRef.current = key;

  const run = useCallback(async () => {
    if (keyRef.current === null) return;
    const my = ++seq.current;
    setLoading(true);
    try {
      const d = await loader.current();
      if (my === seq.current) {
        setData(d);
        setCause(null);
      }
    } catch (e) {
      if (my === seq.current) setCause(e);
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setData(undefined);
    setCause(null);
    if (key === null) {
      setLoading(false);
      return;
    }
    void run();
  }, [key, run]);

  return { data, error: cause ? describeError(cause) : null, cause, loading, reload: run, setData };
}

/** Sets document.title to "<title> · Matchframe". */
export function useTitle(title: string): void {
  useEffect(() => {
    document.title = title ? `${title} · Matchframe` : "Matchframe";
  }, [title]);
}

/** Re-renders every `ms` (for countdowns); returns Date.now(). */
export function useNow(ms = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, enabled]);
  return now;
}
