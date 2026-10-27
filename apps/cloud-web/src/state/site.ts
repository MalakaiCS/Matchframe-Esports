import { useCallback, useEffect, useState } from "react";
import { api, describeError } from "../api/index.ts";
import type { SiteInfo } from "../api/types.ts";

/**
 * Public company details (GET /v1/site), loaded once per page load and shared by the footer, the
 * contact page and the legal documents. Company name, address and emails are never hard-coded.
 */
interface Entry {
  promise: Promise<SiteInfo>;
  value?: SiteInfo;
  error?: unknown;
}

let entry: Entry | null = null;

function load(): Entry {
  if (entry) return entry;
  const e: Entry = { promise: api.site() };
  e.promise.then(
    (v) => {
      e.value = v;
    },
    (err: unknown) => {
      e.error = err;
    },
  );
  entry = e;
  return e;
}

/** Forgets the cached details (tests, and "try again" after a failure). */
export function resetSiteCache(): void {
  entry = null;
}

export interface SiteState {
  site: SiteInfo | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

export function useSite(): SiteState {
  const [, force] = useState(0);
  const [e, setE] = useState<Entry>(() => load());
  useEffect(() => {
    let live = true;
    e.promise.then(
      () => live && force((n) => n + 1),
      () => live && force((n) => n + 1),
    );
    return () => {
      live = false;
    };
  }, [e]);
  const reload = useCallback(() => {
    resetSiteCache();
    setE(load());
  }, []);
  return { site: e.value ?? null, error: e.error ? describeError(e.error) : null, loading: !e.value && !e.error, reload };
}

/** Wording used in legal text while (or if) the company details can't be loaded. */
export const SITE_FALLBACK: SiteInfo = {
  companyName: "the operator of this website",
  websiteName: "Matchframe",
  supportEmail: null,
  address: null,
  jurisdiction: "the country in which the operator is established",
  legalEffectiveDate: "",
};
