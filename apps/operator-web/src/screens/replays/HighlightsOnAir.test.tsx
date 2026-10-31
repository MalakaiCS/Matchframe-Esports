// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { HighlightsAirResponse, ObsAutoResponse } from "../../api/types.ts";
import { liveStore } from "../../state/live.ts";
import { SessionContext } from "../../state/session.tsx";
import { ToastProvider } from "../../components/toasts.tsx";
import { useReplayShortcuts } from "../../lib/replay-keys.ts";
import { HighlightsOnAirPanel } from "./HighlightsOnAir.tsx";
import { ObsAutomationPanel } from "./ProductionAutomation.tsx";

function serve(routes: Record<string, unknown>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const path = decodeURIComponent(new URL(url, "http://x").pathname);
      calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const r = routes[`${method} ${path}`] ?? (method === "GET" ? undefined : routes[`GET ${path}`]);
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

const clips = [
  { id: "a", label: "2K alpha", roundNumber: 2, played: true, score: 27, reasons: ["2K", "headshot"], playMs: 5000 },
  { id: "b", label: "ACE bravo", roundNumber: 4, played: true, score: 90, reasons: ["ace"], playMs: 6000 },
  { id: "c", label: "3K charlie", roundNumber: 9, played: false, score: 64, reasons: ["3K"], playMs: 5500 },
];
const ready: HighlightsAirResponse = {
  settings: { what: "map", count: 5, unplayed: false, noHalftime: true, autoHalftime: false, autoMapEnd: false, vmixIn: null, vmixOut: null },
  status: { state: "ready", detail: "Play: 3 clips, 0:16.", running: false, held: false, position: null, playing: null, blocked: null, halftime: false, plan: { mapKey: "m2", mapName: "de_dust2", title: "Northern Lights vs Red Harbour", what: "map", rounds: null, clips, totalMs: 15500 }, last: null, auto: null },
  setup: { mixer: "obs", obsConnected: true, scene: "Matchframe Highlights", input: "Matchframe Highlights Clip", sceneReady: true, sameAsReplay: false, twin: { scene: "Matchframe Highlights B", input: "Matchframe Highlights Clip B", ready: true, detail: "ok", checkedAt: null }, graphic: { source: "Matchframe Replay Graphic", inScene: true, onTop: true }, detail: "Ready, with the replay graphic on top." },
};
const obsAuto: ObsAutoResponse = {
  settings: { timeouts: true, mapEnd: true, replayIn: "Opener", replayOut: null, otherScenes: "", highlightsIn: null, highlightsOut: null },
  scenes: { LIVE: "Game", REPLAY: "Matchframe Replay", STUDIO: null, BREAK: null, HIGHLIGHTS: "Matchframe Highlights" },
  transitions: { current: "Fade", names: ["Fade", "Opener"], kinds: [{ name: "Fade", kind: "fade_transition" }, { name: "Opener", kind: "obs_stinger_transition" }] },
};
const obs = { state: { connected: true, scenes: ["Game", "Analysis", "Matchframe Replay", "Matchframe Highlights"], inputs: [] } };

beforeEach(() => liveStore.reset());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Highlights on air panel", () => {
  it("shows what plays (label, round, length, running time) and plays it; What, How many and Unplayed change it", async () => {
    const calls = serve({ "GET /api/v1/highlights/air": ready, "GET /api/v1/obs/auto": obsAuto, "GET /api/v1/obs": obs, "POST /api/v1/highlights/air/play": { ...ready, status: { ...ready.status, state: "playing", running: true, detail: "Highlight 1 of 3: 2K alpha", position: { n: 1, of: 3 }, playing: { id: "a", label: "2K alpha" } } }, "PUT /api/v1/highlights/air": ready });
    wrap(<HighlightsOnAirPanel />);
    const list = await screen.findByLabelText("Highlights that will play");
    expect(within(list).getByText("3 clips, 0:16 · Northern Lights vs Red Harbour")).toBeTruthy();
    expect([...list.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["R2 · 2K alpha · 5.0 s", "R4 · ACE bravo · 6.0 s", "R9 · 3K charlie · 5.5 s · not played"]);
    const play = screen.getByRole("button", { name: "Play highlights" }) as HTMLButtonElement;
    await waitFor(() => expect(play.disabled).toBe(false));
    fireEvent.click(play);
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/highlights/air/play")).toBe(true));
    fireEvent.change(screen.getByLabelText(/^What/), { target: { value: "half" } });
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT").at(-1)?.body).toEqual({ what: "half" }));
    const many = screen.getByLabelText(/How many/) as HTMLSelectElement;
    expect([...many.options].map((o) => o.textContent)).toEqual(["The best 5 (recommended)", "The best 8", "The best 10", "The best 15", "All played clips"]);
    fireEvent.change(many, { target: { value: "10" } });
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT").at(-1)?.body).toEqual({ count: 10 }));
    fireEvent.click(screen.getByLabelText(/Also clips that weren't played/));
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT").at(-1)?.body).toEqual({ unplayed: true }));
    expect(screen.getByRole("option", { name: "The previous map" })).toBeTruthy();
  });

  it("Don't show highlights at halftime: on by default, Play disabled at halftime with its hint; off, the automatic halftime start appears under it", async () => {
    const half: HighlightsAirResponse = { ...ready, status: { ...ready.status, state: "blocked", halftime: true, blocked: "Highlights at halftime are off (Don't show highlights at halftime).", detail: "Highlights at halftime are off (Don't show highlights at halftime)." } };
    const off: HighlightsAirResponse = { ...ready, settings: { ...ready.settings, noHalftime: false }, status: { ...ready.status, halftime: true } };
    const calls = serve({ "GET /api/v1/highlights/air": half, "GET /api/v1/obs/auto": obsAuto, "GET /api/v1/obs": obs, "PUT /api/v1/highlights/air": off });
    wrap(<HighlightsOnAirPanel />);
    const box = (await screen.findByLabelText("Don't show highlights at halftime")) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    expect(box.checked).toBe(true);
    const play = screen.getByRole("button", { name: "Play highlights" }) as HTMLButtonElement;
    expect(play.disabled).toBe(true);
    // The hint shows next to the button.
    expect(screen.getByText("Highlights at halftime are off").className).toContain("disabled-reason");
    expect(screen.queryByLabelText(/Start by themselves at halftime/)).toBeNull();
    fireEvent.click(box);
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT").at(-1)?.body).toEqual({ noHalftime: false }));
    const auto = (await screen.findByLabelText(/Start by themselves at halftime/)) as HTMLInputElement;
    expect(auto.checked).toBe(false);
    await waitFor(() => expect((screen.getByRole("button", { name: "Play highlights" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(auto);
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT").at(-1)?.body).toEqual({ autoHalftime: true }));
    fireEvent.click(screen.getByLabelText(/Start by themselves when a map ends/));
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT").at(-1)?.body).toEqual({ autoMapEnd: true }));
  });

  it("while they play: Highlight n of N, Skip and Hold (the replays' controls) and Stop", async () => {
    const playing: HighlightsAirResponse = { ...ready, status: { ...ready.status, state: "playing", running: true, detail: "Highlight 2 of 3: ACE bravo", position: { n: 2, of: 3 }, playing: { id: "b", label: "ACE bravo" } } };
    const calls = serve({ "GET /api/v1/highlights/air": playing, "GET /api/v1/obs/auto": obsAuto, "GET /api/v1/obs": obs, "POST /api/v1/replays/auto/skip": {}, "POST /api/v1/replays/auto/hold": {}, "POST /api/v1/highlights/air/stop": ready });
    wrap(<HighlightsOnAirPanel />);
    const group = await screen.findByRole("group", { name: "Highlights controls" });
    expect(within(group).getByText("Highlight 2 of 3")).toBeTruthy();
    expect(screen.getByText("Highlight 2 of 3: ACE bravo")).toBeTruthy();
    expect(screen.getByText(/· on air/)).toBeTruthy();
    fireEvent.click(within(group).getByRole("button", { name: "Skip" }));
    fireEvent.click(within(group).getByRole("button", { name: "Hold" }));
    fireEvent.click(within(group).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST").map((c) => [c.path, c.body])).toEqual([["/api/v1/replays/auto/skip", {}], ["/api/v1/replays/auto/hold", { held: true }], ["/api/v1/highlights/air/stop", {}]]));
  });

  it("sets up the highlights scene, or uses your own scene and its media source; shows what's ready; picks Highlights in and out", async () => {
    const none: HighlightsAirResponse = { ...ready, status: { ...ready.status, state: "blocked", blocked: "Set up the highlights scene: Set up OBS highlights scene, or pick your own scene and its media source." }, setup: { ...ready.setup, scene: null, input: null, sceneReady: false, twin: null, graphic: null, detail: "No highlights scene yet." } };
    const calls = serve({
      "GET /api/v1/highlights/air": none,
      "GET /api/v1/obs/auto": obsAuto,
      "GET /api/v1/obs": obs,
      "POST /api/v1/highlights/air/obs-setup": { scene: "Matchframe Highlights", input: "Matchframe Highlights Clip", created: true, graphic: { created: false, onTop: true }, graphicError: null, setup: ready.setup },
      "GET /api/v1/obs/scenes/Analysis/items": [
        { sourceName: "Backdrop", inputKind: "color_source_v3" },
        { sourceName: "Clips", inputKind: "ffmpeg_source" },
      ],
      "PUT /api/v1/highlights/air/scene": ready,
      "PUT /api/v1/obs/auto": obsAuto,
    });
    wrap(<HighlightsOnAirPanel />);
    expect((await screen.findAllByText("Set up the highlights scene: Set up OBS highlights scene, or pick your own scene and its media source.")).length).toBeGreaterThan(0);
    const setup = screen.getByRole("button", { name: "Set up OBS highlights scene" }) as HTMLButtonElement;
    await waitFor(() => expect(setup.disabled).toBe(false));
    fireEvent.click(setup);
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/highlights/air/obs-setup")).toBe(true));
    // Your own scene: its Media Sources to choose from.
    await waitFor(() => expect((screen.getByLabelText(/Your highlights scene/) as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText(/Your highlights scene/), { target: { value: "Analysis" } });
    await waitFor(() => expect(screen.getByRole("option", { name: "Clips" })).toBeTruthy());
    expect(screen.queryByRole("option", { name: "Backdrop" })).toBeNull();
    fireEvent.change(screen.getByLabelText(/Its media source/), { target: { value: "Clips" } });
    fireEvent.click(screen.getByRole("button", { name: "Use this scene" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/api/v1/highlights/air/scene")?.body).toEqual({ scene: "Analysis", input: "Clips" }));
    // What is ready (the answer of Use this scene).
    const status = await screen.findByLabelText("Highlights scene status");
    expect(within(status).getByText("Scene ready")).toBeTruthy();
    expect(within(status).getByText("Twin ready")).toBeTruthy();
    expect(within(status).getByText("Graphic on top")).toBeTruthy();
    // Highlights in and out: the same as Replay in and out until chosen.
    const into = screen.getByLabelText(/Highlights in/) as HTMLSelectElement;
    await waitFor(() => expect(into.disabled).toBe(false));
    expect(into.selectedOptions[0]!.textContent).toBe("Same as Replay in");
    expect((screen.getByLabelText(/Highlights out/) as HTMLSelectElement).selectedOptions[0]!.textContent).toBe("Same as Replay out");
    fireEvent.change(into, { target: { value: "Opener" } });
    await waitFor(() => expect(calls.find((c) => c.method === "PUT" && c.path === "/api/v1/obs/auto")?.body).toEqual({ highlightsIn: "Opener" }));
  });

  it("with vMix: its own Highlights in and out; no OBS scene", async () => {
    const vmix: HighlightsAirResponse = { ...ready, setup: { ...ready.setup, mixer: "vmix", detail: "Highlights play in vMix." } };
    const calls = serve({ "GET /api/v1/highlights/air": vmix, "GET /api/v1/obs/auto": obsAuto, "GET /api/v1/obs": obs, "PUT /api/v1/highlights/air": vmix });
    wrap(<HighlightsOnAirPanel />);
    expect(await screen.findByText(/Highlights play in vMix, as automatic replays do/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Set up OBS highlights scene" })).toBeNull();
    const into = screen.getByLabelText(/Highlights in/) as HTMLSelectElement;
    await waitFor(() => expect(into.disabled).toBe(false));
    fireEvent.change(into, { target: { value: "Stinger1" } });
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT").at(-1)?.body).toEqual({ vmixIn: "Stinger1" }));
  });

  it("console shortcuts: Ctrl+Shift+F9 plays the highlights, Ctrl+Shift+F10 stops them (not F8: Stop automation)", async () => {
    const calls = serve({ "POST /api/v1/highlights/air/play": ready, "POST /api/v1/highlights/air/stop": ready });
    function Keys() {
      useReplayShortcuts();
      return null;
    }
    wrap(<Keys />);
    fireEvent.keyDown(window, { key: "F9", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "F10", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "F9" });
    await waitFor(() => expect(calls.map((c) => c.path)).toEqual(["/api/v1/highlights/air/play", "/api/v1/highlights/air/stop"]));
  });
});

describe("OBS scenes panel: highlights", () => {
  it("lists Highlights in and Highlights out with the other transitions, and the highlights scene", async () => {
    const calls = serve({ "GET /api/v1/obs/auto": obsAuto, "GET /api/v1/obs": obs, "PUT /api/v1/obs/auto": obsAuto });
    wrap(<ObsAutomationPanel />);
    const out = (await screen.findByLabelText(/Highlights out/)) as HTMLSelectElement;
    await waitFor(() => expect(out.disabled).toBe(false));
    expect([...out.options].map((o) => o.textContent)).toEqual(["Same as Replay out", "OBS's current transition", "Fade", "Opener (Stinger)"]);
    fireEvent.change(out, { target: { value: "Fade" } });
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT").at(-1)?.body).toEqual({ highlightsOut: "Fade" }));
    expect(screen.getByText(/Highlights scene: Matchframe Highlights/)).toBeTruthy();
  });
});
