/** Per-browser conveniences only (never authority): remembered organisation. */
const LAST_ORG = "matchframe.lastOrgId";

export function getLastOrg(): string | null {
  try {
    return window.localStorage.getItem(LAST_ORG);
  } catch {
    return null;
  }
}

export function setLastOrg(orgId: string): void {
  try {
    window.localStorage.setItem(LAST_ORG, orgId);
  } catch {
    // storage blocked (private mode); the site still works, it just forgets
  }
}

/** The organisation to open: the remembered one if still a member, else the first. */
export function pickOrg(orgs: { id: string }[]): string | null {
  const last = getLastOrg();
  if (last && orgs.some((o) => o.id === last)) return last;
  return orgs[0]?.id ?? null;
}

/**
 * "This browser was signed in last time" hint. The session cookie is HttpOnly, so the site can't
 * see it; without the hint, public pages skip the /v1/auth/me probe (which answers 401 to every
 * anonymous visitor). Signed-in pages always probe.
 */
const SIGNED_IN = "matchframe.signedIn";

export const sessionHint = {
  get(): boolean {
    try {
      return window.localStorage.getItem(SIGNED_IN) === "1";
    } catch {
      return false;
    }
  },
  set(on: boolean): void {
    try {
      if (on) window.localStorage.setItem(SIGNED_IN, "1");
      else window.localStorage.removeItem(SIGNED_IN);
    } catch {
      // storage blocked: public pages just won't show the signed-in header
    }
  },
};

/** Full-page navigation to Stripe Checkout / Portal (indirection so tests can observe it). */
export const external = {
  assign(url: string): void {
    window.location.assign(url);
  },
};
