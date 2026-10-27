// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "./App.tsx";
import { SessionProvider } from "./state/session.tsx";
import { at, err, fakeFetch, makeMe, renderWithSession } from "./test/helpers.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("app routing and sessions", () => {
  it("sends signed-out visitors of signed-in pages to /login?next=… and keeps the link code", async () => {
    at("/link?code=BCDF-GHJK");
    fakeFetch({ "GET /v1/auth/me": err(401, "unauthenticated", "sign in first") });
    render(
      <SessionProvider>
        <App />
      </SessionProvider>,
    );
    await waitFor(() => expect(window.location.pathname).toBe("/login"));
    expect(new URLSearchParams(window.location.search).get("next")).toBe("/link?code=BCDF-GHJK");
    expect(await screen.findByText("Sign in to link your computer to your organisation.")).toBeTruthy();
  });

  it("doesn't ask who is signed in on public pages unless this browser was signed in before", async () => {
    at("/pricing");
    const f = fakeFetch({ "GET /v1/plans": { body: { plans: [], hourPacks: [], billingConfigured: false } } });
    render(
      <SessionProvider>
        <App />
      </SessionProvider>,
    );
    await screen.findByRole("heading", { name: "Pricing" });
    expect(f.count("GET", "/v1/auth/me")).toBe(0);
    expect(screen.getAllByRole("link", { name: "Sign in" }).length).toBeGreaterThan(0);
  });

  it("probes the session on public pages when the hint is set, and shows Dashboard", async () => {
    window.localStorage.setItem("matchframe.signedIn", "1");
    at("/");
    const f = fakeFetch({ "GET /v1/auth/me": { body: makeMe() } });
    render(
      <SessionProvider>
        <App />
      </SessionProvider>,
    );
    expect(await screen.findByRole("link", { name: "Open your dashboard" })).toBeTruthy();
    expect(f.count("GET", "/v1/auth/me")).toBe(1);
  });

  it("clears the hint when the session turns out to be gone", async () => {
    window.localStorage.setItem("matchframe.signedIn", "1");
    at("/");
    fakeFetch({ "GET /v1/auth/me": err(401, "unauthenticated", "sign in first") });
    render(
      <SessionProvider>
        <App />
      </SessionProvider>,
    );
    await waitFor(() => expect(window.localStorage.getItem("matchframe.signedIn")).toBeNull());
    expect(screen.getAllByRole("link", { name: "Create account" }).length).toBe(2);
  });

  it("opens the remembered organisation from /dashboard", async () => {
    window.localStorage.setItem("matchframe.lastOrgId", "org_2");
    at("/dashboard");
    fakeFetch({});
    const me = makeMe({ orgs: [
      { id: "org_1", name: "First", role: "owner", planId: "free", planName: "Free", subscriptionStatus: "none" },
      { id: "org_2", name: "Second", role: "admin", planId: "pro", planName: "Pro", subscriptionStatus: "active" },
    ] });
    renderWithSession(<App />, me);
    await waitFor(() => expect(window.location.pathname).toBe("/orgs/org_2"));
    expect((screen.getByRole("combobox", { name: "Organisation" }) as HTMLSelectElement).value).toBe("org_2");
  });

  it("refuses organisations you're not a member of (unless staff)", () => {
    at("/orgs/org_9/billing");
    fakeFetch({});
    renderWithSession(<App />, makeMe());
    expect(screen.getByRole("heading", { name: "Organisation not found" })).toBeTruthy();
  });

  it("keeps /admin for staff", () => {
    at("/admin");
    fakeFetch({});
    renderWithSession(<App />, makeMe());
    expect(screen.getByRole("heading", { name: "Staff only" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Admin console" })).toBeNull();
  });

  it("shows only account areas in the signed-in navigation", () => {
    at("/account");
    fakeFetch({ "GET /v1/downloads": { body: { windows: null, notesUrl: null, version: "0.1.0" } } });
    renderWithSession(<App />, makeMe({ user: { staff: true } }));
    const orgNav = within(screen.getByRole("navigation", { name: "Organisation" }));
    expect(orgNav.getAllByRole("link").map((a) => a.textContent)).toEqual(["Dashboard", "Usage", "Billing & Subscription", "Team", "Computers"]);
    expect(orgNav.getByRole("link", { name: "Billing & Subscription" }).getAttribute("href")).toBe("/orgs/org_1/billing");
    const accountNav = within(screen.getByRole("navigation", { name: "Account" }));
    expect(accountNav.getAllByRole("link").map((a) => a.textContent)).toEqual(["Account", "Admin console"]);
  });

  it("requires sign-in for the download page", async () => {
    at("/download");
    fakeFetch({ "GET /v1/auth/me": err(401, "unauthenticated", "sign in first") });
    render(
      <SessionProvider>
        <App />
      </SessionProvider>,
    );
    await waitFor(() => expect(window.location.pathname).toBe("/login"));
  });

  it("shows a not-found page for unknown paths", () => {
    at("/nope");
    fakeFetch({});
    renderWithSession(<App />, null);
    expect(screen.getByRole("heading", { name: "Page not found" })).toBeTruthy();
  });
});
