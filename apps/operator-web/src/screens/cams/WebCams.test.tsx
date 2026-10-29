// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CamStatusView } from "../../api/types.ts";
import { ToastProvider } from "../../components/toasts.tsx";
import { SessionContext } from "../../state/session.tsx";
import { WebCams } from "./WebCams.tsx";

const base: CamStatusView = {
  enabled: true,
  signedIn: true,
  websiteConnected: true,
  link: "https://matchframe.example/cam/abcdefghij0123456789",
  delayMs: 90_000,
  quality: "standard",
  autoApprove: false,
  error: null,
  players: [
    { steamId: "76561198000000001", name: "nova", team: "Alpha", state: "waiting_approval", onAir: false, camera: "Logitech C920", width: 640, height: 360, fps: 30, kbps: 650, bufferedSec: 0 },
    { steamId: "76561198000000002", name: "flux", team: "Alpha", state: "live", onAir: true, camera: "Razer Kiyo", width: 640, height: 360, fps: 30, kbps: 700, bufferedSec: 89.9 },
    { steamId: "76561198000000003", name: "zeal", team: "Bravo", state: "offline", onAir: false, camera: null, width: null, height: null, fps: null, kbps: 0, bufferedSec: 0 },
  ],
  outputs: { observed: "http://127.0.0.1:1350/cams/observed?t=tok", player: "http://127.0.0.1:1350/cams/player/STEAMID?t=tok" },
};

function serve(status: CamStatusView) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const path = new URL(url, "http://x").pathname;
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      return new Response(JSON.stringify(method === "PUT" && path === "/api/v1/cams/settings" ? { ...status, ...body } : status), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}

const renderIt = (role = "owner") =>
  render(
    <ToastProvider>
      <SessionContext.Provider value={{ me: { role } }}>
        <WebCams />
      </SessionContext.Provider>
    </ToastProvider>,
  );

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("player cams panel", () => {
  it("shows the link, the delay, each player's state, and the OBS address", async () => {
    serve(base);
    renderIt();
    expect(await screen.findByText(base.link!)).toBeTruthy();
    expect(screen.getByText("Open on the website")).toBeTruthy();
    expect((screen.getByLabelText(/Delay \(seconds\)/) as HTMLInputElement).value).toBe("90");
    expect(screen.getByText("Waiting for you")).toBeTruthy();
    expect(screen.getByText("On air")).toBeTruthy();
    expect(screen.getByText("No camera")).toBeTruthy();
    expect(screen.getByText(/Razer Kiyo · 640×360 · 700 kbit\/s · 89.9 s buffered/)).toBeTruthy();
    expect(screen.getByText("2 of 3 sending")).toBeTruthy();
    expect(screen.getByText(base.outputs!.observed)).toBeTruthy();
    expect(screen.getByText(/get each cam 90.0 s later/)).toBeTruthy();
  });

  it("puts a waiting cam on air, takes one off, and sets the delay", async () => {
    const calls = serve(base);
    renderIt();
    fireEvent.click(await screen.findByRole("button", { name: "Put on air" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/cams/players/76561198000000001/approve")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Take off air" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path === "/api/v1/cams/players/76561198000000002/hidden")).toBe(true));
    expect(calls.find((c) => c.path === "/api/v1/cams/players/76561198000000002/hidden")!.body).toEqual({ hidden: true });
    fireEvent.change(screen.getByLabelText(/Delay \(seconds\)/), { target: { value: "120.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Set delay" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path === "/api/v1/cams/settings")).toBe(true));
    expect(calls.find((c) => c.path === "/api/v1/cams/settings")!.body).toEqual({ delayMs: 120_500 });
  });

  it("says to sign in when the program isn't signed in to the website", async () => {
    serve({ ...base, signedIn: false, websiteConnected: false, link: null, players: [] });
    renderIt();
    expect(await screen.findByText("Sign in needed")).toBeTruthy();
    expect(screen.getByText(/sign this program in/)).toBeTruthy();
  });
});
