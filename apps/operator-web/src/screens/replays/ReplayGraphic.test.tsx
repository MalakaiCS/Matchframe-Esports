// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { liveStore } from "../../state/live.ts";
import { SessionContext } from "../../state/session.tsx";
import { ToastProvider } from "../../components/toasts.tsx";
import type { ReplayGraphicView } from "./ReplayGraphic.tsx";
import { describeClip, ReplayGraphicPanel } from "./ReplayGraphic.tsx";

function serve(routes: Record<string, unknown>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const path = decodeURIComponent(new URL(url, "http://x").pathname);
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      const r = routes[`${method} ${path}`];
      return new Response(JSON.stringify(r ?? { error: "not_found" }), { status: r ? 200 : 404, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}
const wrap = (ui: React.ReactNode) =>
  render(
    <ToastProvider>
      <SessionContext.Provider value={{ me: { role: "owner" } }}>{ui}</SessionContext.Provider>
    </ToastProvider>,
  );

const url = "http://127.0.0.1:37212/hud/matchframe.vector/replay?t=abc";
const view: ReplayGraphicView = {
  settings: { enabled: true, hudId: "auto" },
  output: { hudId: "matchframe.vector", hudName: "Vector HUD", forHudId: "matchframe.vector", forHudName: "Vector HUD", style: "own", url, why: "Vector HUD has its own replay graphic." },
  source: "Matchframe Replay Graphic",
  replayScene: "Matchframe Replay",
  obsConnected: true,
  onAir: null,
};
const library = { huds: [{ id: "matchframe.vector", name: "Vector HUD" }, { id: "lhm.kaihud", name: "KaiHUD" }], hudsDir: null, overlayOrigin: "", hiddenAll: false };

beforeEach(() => liveStore.reset());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Replay graphic panel", () => {
  it("shows the HUD's replay page, turns the graphic off, picks a HUD and adds it to the OBS replay scene", async () => {
    const kai = { ...view, settings: { enabled: true, hudId: "lhm.kaihud" }, output: { ...view.output!, hudId: "matchframe-default", hudName: "Matchframe Broadcast HUD", forHudId: "lhm.kaihud", forHudName: "KaiHUD", style: "builtin" as const, why: "KaiHUD is an LHM-format HUD without a replay graphic: Matchframe's built-in style." } };
    const calls = serve({
      "GET /api/v1/replay-graphic": view,
      "GET /api/v1/hud/library": library,
      "PUT /api/v1/replay-graphic": kai,
      "POST /api/v1/replay-graphic/obs": { scene: "Matchframe Replay", source: "Matchframe Replay Graphic", created: true, onTop: true, output: view.output },
    });
    wrap(<ReplayGraphicPanel />);
    expect(await screen.findByText(url)).toBeTruthy();
    expect(screen.getByText(/Vector HUD has its own replay graphic/)).toBeTruthy();
    const box = screen.getByLabelText(/Show the replay graphic/) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    fireEvent.click(box);
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ enabled: false }));
    await waitFor(() => expect(screen.getByRole("option", { name: "KaiHUD" })).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/^HUD/), { target: { value: "lhm.kaihud" } });
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT").at(-1)?.body).toEqual({ hudId: "lhm.kaihud" }));
    expect(await screen.findByText(/built-in style/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add replay graphic to the OBS replay scene" }));
    expect(await screen.findByText(/added on top of “Matchframe Replay”/)).toBeTruthy();
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/replay-graphic/obs")).toBe(true);
  });

  it("says what is missing before it can go into OBS, and what is on air", async () => {
    serve({
      "GET /api/v1/replay-graphic": { ...view, obsConnected: false, onAir: { id: "rp1", roundNumber: 14, label: "3K", player: { steamId: "1", name: "riot" }, team: null, side: "T", weapon: { name: "weapon_ak47", displayName: "AK-47" }, headshot: true, victims: ["a", "b", "c"], kills: 3, multiKill: "3K", clutchVersus: null } },
      "GET /api/v1/hud/library": library,
    });
    wrap(<ReplayGraphicPanel />);
    expect(await screen.findByText("On air: riot · 3K · AK-47 · headshot · round 14")).toBeTruthy();
    const button = screen.getByRole("button", { name: "Add replay graphic to the OBS replay scene" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.closest("[title]")?.getAttribute("title") ?? button.title).toMatch(/Connect OBS first/);
  });

  it("describes a clutch", () => {
    expect(describeClip({ id: "x", roundNumber: 9, label: "", player: { steamId: null, name: "kestrel" }, team: null, side: null, weapon: null, headshot: false, victims: [], kills: null, multiKill: null, clutchVersus: 3 })).toBe("kestrel · 1v3 clutch · round 9");
  });
});
