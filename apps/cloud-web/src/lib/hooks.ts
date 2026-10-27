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

export const DEFAULT_DESCRIPTION =
  "Matchframe is a Windows program for Counter-Strike 2 broadcasts: HUDs for OBS, an automatic director with manual takeover, observer camera control, replays and match administration.";

function setMeta(name: string, content: string): void {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.name = name;
    document.head.appendChild(el);
  }
  el.content = content;
}

/** Sets document.title to "<title> · Matchframe" and the page's meta description. */
export function useTitle(title: string, description: string = DEFAULT_DESCRIPTION): void {
  useEffect(() => {
    document.title = title ? `${title} · Matchframe` : "Matchframe — CS2 broadcast production for Windows";
    setMeta("description", description);
  }, [title, description]);
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
