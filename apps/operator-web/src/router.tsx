import { useEffect, useState } from "react";
import type { AnchorHTMLAttributes, MouseEvent } from "react";

/** Tiny pushState router (the engine serves index.html for every extension-less path). */
const listeners = new Set<() => void>();

/**
 * A page with unsaved changes can hold navigation: the blocker gets a `proceed` callback and
 * returns true to stop the navigation (it calls proceed later if the person discards their changes).
 */
export type NavigationBlocker = (proceed: () => void) => boolean;
let blocker: NavigationBlocker | null = null;
let lastUrl = typeof window === "undefined" ? "/" : window.location.pathname + window.location.search;

/** Installs the blocker; returns a function that removes it. */
export function setNavigationBlocker(b: NavigationBlocker): () => void {
  blocker = b;
  return () => {
    if (blocker === b) blocker = null;
  };
}

function notify(): void {
  lastUrl = window.location.pathname + window.location.search;
  for (const l of listeners) l();
}

export function navigate(to: string, replace = false, opts: { force?: boolean } = {}): void {
  if (to === window.location.pathname + window.location.search) return;
  if (blocker && !opts.force && blocker(() => navigate(to, replace, { force: true }))) return;
  if (replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  notify();
  window.scrollTo?.(0, 0);
}

let popInstalled = false;
function installPop(): void {
  if (popInstalled || typeof window === "undefined") return;
  popInstalled = true;
  window.addEventListener("popstate", () => {
    const target = window.location.pathname + window.location.search;
    if (blocker && target !== lastUrl) {
      // Back/forward with unsaved changes: stay on the page until the person decides.
      const from = lastUrl;
      window.history.pushState(null, "", from);
      if (blocker(() => navigate(target, false, { force: true }))) return;
      window.history.replaceState(null, "", target);
    }
    notify();
  });
}

export function useLocation(): { path: string; query: URLSearchParams } {
  const [, force] = useState(0);
  useEffect(() => {
    installPop();
    const on = () => force((n) => n + 1);
    listeners.add(on);
    return () => {
      listeners.delete(on);
    };
  }, []);
  return { path: window.location.pathname.replace(/\/+$/, "") || "/", query: new URLSearchParams(window.location.search) };
}

export function Link({ to, children, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return (
    <a
      href={to}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
