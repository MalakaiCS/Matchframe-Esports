// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CloudStatus, SignInState } from "../api/types.ts";
import { SignInGate } from "./SignIn.tsx";

const USER = { id: "usr_1", email: "producer@example.com", displayName: "Producer" };

function status(state: SignInState, over: Partial<CloudStatus> = {}): CloudStatus {
  const signedIn = state === "signed_in" || state === "offline_expired";
  return {
    url: "https://matchframe.example",
    urlFixed: true,
    enforcement: "required",
    keysPinned: true,
    linkState: signedIn ? "linked" : state === "revoked" ? "revoked" : "unlinked",
    signIn: { required: state !== "not_required", state, user: signedIn ? USER : null, method: signedIn ? "password" : null },
    linking: null,
    device: signedIn ? { deviceId: "dev_1", orgId: "org_1", orgName: "Night League", linkedAt: "2026-10-20T10:00:00.000Z" } : null,
    entitlement: null,
    gate: { ok: false, code: "not_linked", reason: "Sign in" },
    usage: { pendingRecords: 0, pendingSeconds: 0, rejected: 0, totalSeconds: 0, openSeconds: 0, metering: false },
    lastRefreshAt: null,
    lastSyncAt: null,
    lastError: null,
    ...over,
  };
}

type Handler = (method: string, path: string, body: Record<string, unknown> | null) => { status: number; json: unknown };

function serve(handler: Handler) {
  const calls: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      calls.push({ method: init.method ?? "GET", path: url, body });
      const r = handler(init.method ?? "GET", url, body);
      return new Response(JSON.stringify(r.json), { status: r.status, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}

const renderGate = (role = "owner") => render(<SignInGate role={role}>{(notice) => <div data-testid="console">CONSOLE{notice}</div>}</SignInGate>);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("sign-in gate when the program opens", () => {
  it("opens straight into the console when sign-in is not required (development builds)", async () => {
    serve(() => ({ status: 200, json: status("not_required") }));
    renderGate();
    expect(await screen.findByTestId("console")).toBeTruthy();
  });

  it("signs in with email and password, asks which organisation, then opens the console", async () => {
    let current = status("signed_out");
    const calls = serve((method, path, body) => {
      if (path === "/api/v1/cloud/status") return { status: 200, json: current };
      if (path === "/api/v1/cloud/login" && body?.password === "wrong") return { status: 400, json: { error: "invalid_credentials", message: "Email or password is incorrect" } };
      if (path === "/api/v1/cloud/login" && !body?.orgId) return { status: 200, json: { status: "choose_org", orgs: [{ id: "org_1", name: "Night League", role: "owner", planName: "Pro" }, { id: "org_2", name: "Weekend Cup", role: "member", planName: "Free" }], cloud: current } };
      if (path === "/api/v1/cloud/login") {
        current = status("signed_in");
        return { status: 200, json: { status: "signed_in", user: USER, orgName: "Weekend Cup", cloud: current } };
      }
      return { status: 404, json: { error: "not_found", message: method + " " + path } };
    });
    renderGate();
    expect(await screen.findByRole("heading", { name: "Sign in to Matchframe" })).toBeTruthy();
    expect(screen.queryByTestId("console")).toBeNull();
    expect(screen.getByRole("link", { name: "Forgot password?" }).getAttribute("href")).toBe("https://matchframe.example/forgot-password");
    expect(screen.getByRole("link", { name: "Create one on the website" }).getAttribute("href")).toBe("https://matchframe.example/signup");

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "producer@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Email or password is incorrect")).toBeTruthy();
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");

    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct horse battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.click(await screen.findByLabelText(/Weekend Cup/));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByTestId("console")).toBeTruthy();
    const logins = calls.filter((c) => c.path === "/api/v1/cloud/login").map((c) => c.body);
    expect(logins.at(-1)).toEqual({ email: "producer@example.com", password: "correct horse battery", orgId: "org_2" });
  });

  it("explains a sign-out from the website", async () => {
    serve(() => ({ status: 200, json: status("revoked", { lastError: "this computer is signed out: the account's password was changed" }) }));
    renderGate();
    expect(await screen.findByText("You were signed out")).toBeTruthy();
    expect(screen.getByText(/the account's password was changed/)).toBeTruthy();
  });

  it("asks to go online when the offline period has ended, and retries", async () => {
    let current = status("offline_expired", { lastError: "licence refresh failed: fetch failed" });
    const calls = serve((_m, path) => {
      if (path === "/api/v1/cloud/refresh") current = status("signed_in");
      return { status: 200, json: current };
    });
    renderGate();
    expect(await screen.findByRole("heading", { name: "Matchframe needs to go online" })).toBeTruthy();
    expect(screen.getByText(/Producer/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("console")).toBeTruthy();
    expect(calls.some((c) => c.path === "/api/v1/cloud/refresh" && c.method === "POST")).toBe(true);
  });

  it("an operator position without settings permission waits for the production computer to sign in", async () => {
    serve(() => ({ status: 200, json: status("signed_out") }));
    renderGate("observer");
    expect(await screen.findByRole("heading", { name: "The production computer is not signed in" })).toBeTruthy();
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  it("never locks the console once open: a sign-out on the website only shows a notice", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let current = status("signed_in");
    serve(() => ({ status: 200, json: current }));
    renderGate();
    expect(await screen.findByTestId("console")).toBeTruthy();
    current = status("revoked", { lastError: "this computer is signed out" });
    await act(() => vi.advanceTimersByTimeAsync(31_000));
    await waitFor(() => expect(screen.getByText("Signed out of Matchframe")).toBeTruthy());
    expect(screen.getByTestId("console").textContent).toContain("CONSOLE");
    expect(screen.queryByRole("heading", { name: "Sign in to Matchframe" })).toBeNull();
  });
});
