import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api, client, describeError, isApiError } from "../api/index.ts";
import type { Me } from "../api/index.ts";
import { sessionHint } from "../lib/storage.ts";

export interface Session {
  /** "idle" = not asked yet (public page, no signed-in hint); "loading" = probing /v1/auth/me. */
  status: "idle" | "loading" | "ready";
  me: Me | null;
  /** The session probe failed for a reason other than "signed out" (offline, server error). */
  probeError: string | null;
  /** True after a signed-in call answered 401 (session expired or signed out elsewhere). */
  expired: boolean;
  /** Reloads /v1/auth/me (after sign-in, verification, org changes). */
  refresh: () => Promise<Me | null>;
  /** Marks the browser as signed out without a request (after logout or a password reset). */
  clear: () => void;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children, initial }: { children: ReactNode; initial?: Me | null }) {
  const [me, setMe] = useState<Me | null>(initial ?? null);
  const [status, setStatus] = useState<Session["status"]>(initial !== undefined ? "ready" : sessionHint.get() ? "loading" : "idle");
  const [probeError, setProbeError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const meRef = useRef(me);
  meRef.current = me;

  const refresh = useCallback(async () => {
    setStatus((s) => (s === "idle" ? "loading" : s));
    try {
      const m = await api.me();
      setMe(m);
      setProbeError(null);
      setExpired(false);
      sessionHint.set(true);
      return m;
    } catch (e) {
      if (isApiError(e) && e.status === 401) {
        setMe(null);
        setProbeError(null);
        sessionHint.set(false);
        return null;
      }
      setProbeError(describeError(e));
      return meRef.current;
    } finally {
      setStatus("ready");
    }
  }, []);

  const clear = useCallback(() => {
    setMe(null);
    setExpired(false);
    sessionHint.set(false);
  }, []);

  useEffect(() => {
    client.setUnauthenticatedHandler(() => {
      if (meRef.current) setExpired(true);
      setMe(null);
      sessionHint.set(false);
    });
    if (initial === undefined && sessionHint.get()) void refresh();
    return () => client.setUnauthenticatedHandler(undefined);
  }, [initial, refresh]);

  const value = useMemo<Session>(() => ({ status, me, probeError, expired, refresh, clear }), [status, me, probeError, expired, refresh, clear]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
}
