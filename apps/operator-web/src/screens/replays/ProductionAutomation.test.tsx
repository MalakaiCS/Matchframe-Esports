// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { liveStore } from "../../state/live.ts";
import { SessionContext } from "../../state/session.tsx";
import { ToastProvider } from "../../components/toasts.tsx";
import { GraphicsPanel, ObsAutomationPanel } from "./ProductionAutomation.tsx";

function serve(routes: Record<string, unknown>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const path = decodeURIComponent(new URL(url, "http://x").pathname);
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      const r = routes[`${method} ${path}`] ?? (method === "PUT" ? body : undefined);
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
const obs = { state: { connected: true, scenes: ["Game", "Break", "Desk", "Matchframe Replay", "Pages"], inputs: [] } };

beforeEach(() => liveStore.reset());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("OBS scenes panel", () => {
  it("maps the break scene and picks the transitions into and out of replays and to the other scenes", async () => {
    const calls = serve({
      "GET /api/v1/obs": obs,
      "GET /api/v1/obs/auto": {
        settings: { timeouts: true, mapEnd: true, replayIn: "", replayOut: null, otherScenes: "" },
        scenes: { LIVE: "Game", REPLAY: "Matchframe Replay", STUDIO: null, BREAK: null },
        transitions: { current: "Fade", names: ["Fade", "Opener", "Überblendung"], kinds: [{ name: "Fade", kind: "fade_transition" }, { name: "Opener", kind: "obs_stinger_transition" }, { name: "Überblendung", kind: "fade_transition" }] },
      },
    });
    wrap(<ObsAutomationPanel />);
    await waitFor(() => expect((screen.getByLabelText(/Break scene/) as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText(/Break scene/), { target: { value: "Break" } });
    fireEvent.click(screen.getByRole("button", { name: "Save scenes" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/api/v1/settings/program.scenes")?.body).toEqual({ value: { LIVE: "Game", REPLAY: "Matchframe Replay", STUDIO: null, BREAK: "Break" } }));
    const into = screen.getByLabelText(/Replay in/) as HTMLSelectElement;
    expect([...into.options].map((o) => o.textContent)).toEqual(["OBS's current transition", "Fade", "Opener (Stinger)", "Überblendung (Fade)"]);
    fireEvent.change(into, { target: { value: "Opener" } });
    await waitFor(() => expect(calls.find((c) => c.method === "PUT" && c.path === "/api/v1/obs/auto")?.body).toEqual({ replayIn: "Opener" }));
    // Replay out is the same as Replay in until chosen.
    const out = screen.getByLabelText(/Replay out/) as HTMLSelectElement;
    expect(out.selectedOptions[0]!.textContent).toBe("Same as Replay in");
    fireEvent.change(out, { target: { value: "" } });
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT" && c.path === "/api/v1/obs/auto").at(-1)?.body).toEqual({ replayOut: "" }));
    fireEvent.change(screen.getByLabelText(/Other scenes/), { target: { value: "Opener" } });
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT" && c.path === "/api/v1/obs/auto").at(-1)?.body).toEqual({ otherScenes: "Opener" }));
    expect(screen.getByText(/A Stinger has to be made once in OBS first \(Scene Transitions → \+ → Stinger/)).toBeTruthy();
  });
});

describe("HUD graphics panel", () => {
  it("turns off player cards and points kaiHUD's pages at their OBS sources", async () => {
    const g = { enabled: true, economy: true, mvp: true, playerCards: true, clutch: true, pages: { hudId: "", scene: "", playerSource: "", matchSource: "" } };
    const calls = serve({
      "GET /api/v1/graphics/auto": g,
      "GET /api/v1/obs": obs,
      "GET /api/v1/hud/library": { huds: [{ id: "lhm.kaihud", name: "KaiHUD", views: [{ id: "player-stats", label: "Player stats", url: "x" }] }], hudsDir: null, overlayOrigin: "", hiddenAll: false },
      "PUT /api/v1/graphics/auto": { ...g, playerCards: false },
    });
    wrap(<GraphicsPanel />);
    const cards = await screen.findByLabelText(/Player card on a long player view/);
    await waitFor(() => expect((cards as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(cards);
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ playerCards: false }));
    await waitFor(() => expect(screen.getByRole("option", { name: "KaiHUD" })).toBeTruthy());
    fireEvent.change(screen.getByLabelText("HUD"), { target: { value: "lhm.kaihud" } });
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT").at(-1)?.body).toEqual({ pages: { hudId: "lhm.kaihud" } }));
  });
});
