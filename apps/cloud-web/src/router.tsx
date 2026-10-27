import { useEffect, useState } from "react";
import type { AnchorHTMLAttributes, MouseEvent } from "react";

/**
 * Tiny pushState router. The API serves index.html for every extension-less path (SPA fallback),
 * so client-side paths survive reloads and direct links.
 */
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of [...listeners]) l();
}

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const current = window.location.pathname + window.location.search + window.location.hash;
  if (to !== current) {
    if (opts.replace) window.history.replaceState(null, "", to);
    else window.history.pushState(null, "", to);
  }
  notify();
  if (!to.includes("#")) window.scrollTo?.(0, 0);
}

export interface Location {
  path: string;
  query: URLSearchParams;
  /** path + search, for ?next= redirects. */
  href: string;
}

export function currentLocation(): Location {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  return { path, query: new URLSearchParams(window.location.search), href: path + window.location.search };
}

export function useLocation(): Location {
  const [, force] = useState(0);
  useEffect(() => {
    const on = () => force((n) => n + 1);
    listeners.add(on);
    window.addEventListener("popstate", on);
    return () => {
      listeners.delete(on);
      window.removeEventListener("popstate", on);
    };
  }, []);
  return currentLocation();
}

/** Matches "/orgs/:orgId/billing" against a path; returns decoded params or null. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/").filter(Boolean);
  const s = path.split("/").filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const want = p[i]!;
    const got = s[i]!;
    if (want.startsWith(":")) {
      try {
        params[want.slice(1)] = decodeURIComponent(got);
      } catch {
        return null;
      }
    } else if (want !== got) return null;
  }
  return params;
}

/**
 * A ?next= target is only followed when it is a same-site path ("/orgs/x"), never a protocol-
 * relative or absolute URL ("//evil.example", "https://…", "/\\evil.example").
 */
export function safeNext(next: string | null | undefined, fallback = "/"): string {
  if (!next) return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\") || /[\r\n\t]/.test(next)) return fallback;
  try {
    const u = new URL(next, "http://same.origin");
    if (u.origin !== "http://same.origin") return fallback;
    return u.pathname + u.search + u.hash;
  } catch {
    return fallback;
  }
}

/** /login?next=<where you were> */
export function loginHref(next?: string): string {
  const n = next ?? currentLocation().href;
  return n && n !== "/" && !n.startsWith("/login") ? `/login?next=${encodeURIComponent(n)}` : "/login";
}

export function Link({ to, children, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return (
    <a
      href={to}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || rest.target === "_blank") return;
        e.preventDefault();
        navigate(to);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}

/** Client-side redirect rendered as a component (runs after commit). */
export function Redirect({ to }: { to: string }) {
  useEffect(() => navigate(to, { replace: true }), [to]);
  return null;
}
