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
  "MatchFrame Esports is a Windows program for Counter-Strike 2 broadcasts: the Stage HUD and four more HUDs, an Auto Director with manual takeover, replays of every kill, map intros, Team Comms and match administration.";

const HOME_TITLE = "MatchFrame — Broadcast-grade CS2 production for Windows";

/** Sets (or adds) a <meta name=…> or, for Open Graph, <meta property=…>. */
function setMeta(name: string, content: string, attr: "name" | "property" = "name"): void {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${name}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, name);
    document.head.appendChild(el);
  }
  el.content = content;
}

/** Sets document.title to "<title> · MatchFrame", the page's meta description and its sharing title and description. */
export function useTitle(title: string, description: string = DEFAULT_DESCRIPTION): void {
  useEffect(() => {
    document.title = title ? `${title} · MatchFrame` : HOME_TITLE;
    setMeta("description", description);
    setMeta("og:title", document.title, "property");
    setMeta("og:description", description, "property");
    setMeta("twitter:title", document.title);
    setMeta("twitter:description", description);
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
