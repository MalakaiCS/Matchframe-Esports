import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { vi } from "vitest";
import type { Me, OrgView } from "../api/types.ts";
import { SessionProvider } from "../state/session.tsx";

// jsdom doesn't implement scrolling; the router scrolls to the top on navigation.
if (typeof window !== "undefined") window.scrollTo = (() => undefined) as typeof window.scrollTo;

export interface FakeReply {
  status?: number;
  body?: unknown;
}
export type FakeHandler = FakeReply | ((call: FakeCall) => FakeReply);
export interface FakeCall {
  method: string;
  url: string;
  body: unknown;
  init: RequestInit;
}

/**
 * Stubs global fetch with "METHOD /path" handlers (the full URL with query string is tried first).
 * Unhandled requests answer 404 not_found and are recorded, so tests can assert nothing unexpected ran.
 */
export function fakeFetch(routes: Record<string, FakeHandler>) {
  const calls: FakeCall[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const call: FakeCall = { method, url, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined, init };
    calls.push(call);
    const h = routes[`${method} ${url}`] ?? routes[`${method} ${url.split("?")[0]}`];
    const r: FakeReply = !h ? { status: 404, body: { error: "not_found", message: `no fake for ${method} ${url}`, detail: null } } : typeof h === "function" ? h(call) : h;
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls, count: (method: string, path: string) => calls.filter((c) => c.method === method && c.url.split("?")[0] === path).length };
}

export function makeMe(over: { user?: Partial<Me["user"]>; orgs?: OrgView[]; billingConfigured?: boolean } = {}): Me {
  return {
    user: { id: "usr_1", email: "owner@example.com", displayName: "Riley Park", emailVerified: true, staff: false, createdAt: "2026-10-01T00:00:00.000Z", ...over.user },
    orgs: over.orgs ?? [{ id: "org_1", name: "Northside Broadcast", role: "owner", planId: "free", planName: "Free", subscriptionStatus: "none" }],
    billingConfigured: over.billingConfigured ?? true,
  };
}

/** Puts the router at a URL before rendering. */
export function at(url: string): void {
  window.history.replaceState(null, "", url);
}

export function renderWithSession(ui: ReactNode, me: Me | null) {
  return render(<SessionProvider initial={me}>{ui}</SessionProvider>);
}

export const err = (status: number, error: string, message: string, detail: unknown = null): FakeReply => ({ status, body: { error, message, detail } });
