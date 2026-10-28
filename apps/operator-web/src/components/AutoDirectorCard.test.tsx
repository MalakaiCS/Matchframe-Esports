// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AutoDirectorStatus } from "../api/types.ts";
import { liveStore } from "../state/live.ts";
import { SessionContext } from "../state/session.tsx";
import { AutoDirectorCard } from "./AutoDirectorCard.tsx";
import { ToastProvider } from "./toasts.tsx";

const off: AutoDirectorStatus = { on: false, phase: "off", headline: "The Auto Director is off.", settings: { cinematic: true, nadeCams: false, returnAfterSec: 8, chase: true }, observerMode: "off", checks: [], resumesInMs: null, startedAt: null };
const running: AutoDirectorStatus = {
  ...off,
  on: true,
  phase: "running",
  headline: "Directing the match: Observer & Cinematics.",
  observerMode: "observer_cinematics",
  checks: [
    { id: "console", label: "CS2 console", status: "ok", detail: "Connected on port 2121." },
    { id: "cameras", label: "Cinematic cameras", status: "ok", detail: "12 cameras and 6 camera paths on de_dust2." },
  ],
};

function serve(responses: Record<string, AutoDirectorStatus>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  let current = responses["GET /api/v1/director/auto"]!;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const path = new URL(url, "http://x").pathname;
      calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const r = responses[`${method} ${path}`];
      if (r && method !== "GET") current = r;
      return new Response(JSON.stringify(method === "GET" ? current : (r ?? current)), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}

const renderCard = (role = "owner") =>
  render(
    <ToastProvider>
      <SessionContext.Provider value={{ me: { role } }}>
        <AutoDirectorCard />
      </SessionContext.Provider>
    </ToastProvider>,
  );

beforeEach(() => liveStore.reset());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Auto Director card", () => {
  it("starts with one button and shows the checks", async () => {
    const calls = serve({ "GET /api/v1/director/auto": off, "POST /api/v1/director/auto/start": running });
    renderCard();
    // The button is re-rendered once the status has loaded.
    await waitFor(() => expect((screen.getByRole("button", { name: /Start Auto Director/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: /Start Auto Director/ }));
    expect(await screen.findByText("Directing the match: Observer & Cinematics.")).toBeTruthy();
    expect(screen.getByText("Connected on port 2121.")).toBeTruthy();
    expect(screen.getByText("On air").className).toContain("tone-ok");
    expect(screen.getByRole("button", { name: /Stop/ })).toBeTruthy();
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/director/auto/start")).toBe(true);
  });

  it("saves what it films; nade cams bring the cinematic cameras along", async () => {
    const calls = serve({ "GET /api/v1/director/auto": off, "PUT /api/v1/director/auto/settings": { ...off, settings: { cinematic: true, nadeCams: true, returnAfterSec: 8, chase: true } } });
    renderCard();
    const nade = await screen.findByLabelText("Nade cams");
    await waitFor(() => expect((nade as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(nade);
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ nadeCams: true, cinematic: true }));
  });

  it("switches the chase cam off and keeps it off", async () => {
    const calls = serve({ "GET /api/v1/director/auto": off, "PUT /api/v1/director/auto/settings": { ...off, settings: { ...off.settings, chase: false } } });
    renderCard();
    await waitFor(() => expect((screen.getByLabelText("Chase cam") as HTMLInputElement).disabled).toBe(false));
    expect((screen.getByLabelText("Chase cam") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByLabelText("Chase cam"));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ chase: false }));
    await waitFor(() => expect((screen.getByLabelText("Chase cam") as HTMLInputElement).checked).toBe(false));
  });

  it("can't be started without director control", async () => {
    serve({ "GET /api/v1/director/auto": off });
    renderCard("viewer");
    const start = await screen.findByRole("button", { name: /Start Auto Director/ });
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(true));
  });
});
