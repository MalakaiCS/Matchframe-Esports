// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { MapIntroFile, MapIntroStatus, MapIntrosResponse, ObsAutoResponse } from "../../api/types.ts";
import { liveStore } from "../../state/live.ts";
import { SessionContext } from "../../state/session.tsx";
import { ToastProvider } from "../../components/toasts.tsx";
import { useReplayShortcuts } from "../../lib/replay-keys.ts";
import { MapIntroCard } from "../live/MapIntroCard.tsx";
import { introFacts, MapIntrosPanel } from "./MapIntros.tsx";

function serve(routes: Record<string, unknown>, fail: Record<string, { status: number; message: string }> = {}) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const u = new URL(url, "http://x");
      const path = decodeURIComponent(u.pathname);
      const body = init.body instanceof Blob ? { file: (init.body as File).name ?? "blob", query: u.search, type: (init.headers as Record<string, string>)["content-type"] } : init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      const f = fail[`${method} ${path}`];
      if (f) return new Response(JSON.stringify({ error: "x", message: f.message }), { status: f.status, headers: { "content-type": "application/json" } });
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

const mirage: MapIntroFile = { slot: "de_mirage", file: "de_mirage-abc.mp4", preview: "de_mirage-abc.jpg", previewUrl: "/api/v1/map-intros/de_mirage/preview.jpg?v=de_mirage-abc.jpg", originalName: "Mirage intro v3.mp4", bytes: 18_400_000, durationMs: 8000, width: 1920, height: 1080, fps: 60, videoCodec: "h264", audioCodec: "aac", pixFmt: "yuv420p", uploadedAt: "2026-11-17T10:00:00Z", notes: [] };
const fallback: MapIntroFile = { ...mirage, slot: "default", file: "default-x.mov", preview: "default-x.jpg", previewUrl: "/api/v1/map-intros/default/preview.jpg?v=default-x.jpg", originalName: "logo sting.mov", bytes: 40_000_000, durationMs: 4500, videoCodec: "prores", audioCodec: null, pixFmt: "yuva444p12le", notes: ["No sound.", "See-through (it has an alpha channel): what is under it in the map intro scene shows through."] };
const SLOTS = ["de_ancient", "de_anubis", "de_dust2", "de_inferno", "de_mirage", "de_nuke", "de_overpass", "de_train", "de_vertigo", "de_cache", "default"] as const;
const LABELS = ["Ancient", "Anubis", "Dust II", "Inferno", "Mirage", "Nuke", "Overpass", "Train", "Vertigo", "Cache", "Default"];
const status: MapIntroStatus = {
  state: "ready",
  detail: "Next intro: Mirage, at pistol round start.",
  next: "Next intro: Mirage, at pistol round start.",
  running: false,
  playing: null,
  current: { map: "de_mirage", displayName: "Mirage", slot: "de_mirage", hasIntro: true, isDefault: false, durationMs: 8000, played: null },
  nextMap: { map: "de_inferno", displayName: "Inferno", slot: "de_inferno", hasIntro: true, isDefault: true, durationMs: 4500, played: null },
  blocked: null,
  blockedNext: null,
  waiting: null,
  last: null,
  auto: null,
};
const view = (over: Partial<MapIntrosResponse> = {}): MapIntrosResponse => ({
  settings: { trigger: "pistol", onLive: "cut", vmixIn: null, vmixOut: null },
  status,
  slots: SLOTS.map((slot, k) => ({ slot, label: LABELS[k]!, intro: slot === "de_mirage" ? mirage : slot === "default" ? fallback : null })),
  setup: { mixer: "obs", obsConnected: true, scene: "MatchFrame Map Intro", exists: true, detail: "“MatchFrame Map Intro” is ready." },
  folder: "C:\\data\\map-intros",
  ffmpeg: { source: "downloaded", path: "ffmpeg.exe", version: "7.1", encoder: null, downloading: null, error: null, canDownload: true },
  maxBytes: 1024 ** 3,
  shared: false,
  ...over,
});
const obsAuto: ObsAutoResponse = {
  settings: { timeouts: true, mapEnd: true, replayIn: "", replayOut: null, otherScenes: "", highlightsIn: null, highlightsOut: null, introIn: null, introOut: null },
  scenes: { LIVE: "Game", REPLAY: null, STUDIO: null, BREAK: null, MAP_INTRO: "MatchFrame Map Intro" },
  transitions: { current: "Fade", names: ["Fade", "MatchFrame Stinger"], kinds: [{ name: "Fade", kind: "fade_transition" }, { name: "MatchFrame Stinger", kind: "obs_stinger_transition" }] },
};

beforeEach(() => liveStore.reset());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Map intros panel", () => {
  it("lists every map's slot and the default, with each intro's length, codec, size, frame and notes; says it isn't shared by account sync", async () => {
    serve({ "GET /api/v1/map-intros": view(), "GET /api/v1/obs/auto": obsAuto });
    wrap(<MapIntrosPanel />);
    const table = await screen.findByLabelText("Map intro videos");
    const rows = [...table.querySelectorAll("tbody tr")];
    expect(rows.map((r) => r.querySelector("strong")?.textContent)).toEqual(LABELS);
    expect(within(rows[4] as HTMLElement).getByText("8.0 s · H.264 · 1920×1080 · 60 fps · 17.5 MB")).toBeTruthy();
    expect(within(rows[4] as HTMLElement).getByText("Mirage intro v3.mp4")).toBeTruthy();
    expect((within(rows[4] as HTMLElement).getByAltText("Mirage intro frame") as HTMLImageElement).getAttribute("src")).toBe(mirage.previewUrl);
    expect(within(rows[10] as HTMLElement).getByText("4.5 s · ProRes · 1920×1080 · 60 fps · no sound · 38.1 MB")).toBeTruthy();
    expect(within(rows[10] as HTMLElement).getByText("No sound.")).toBeTruthy();
    // Maps without their own: the default plays; Replace and Remove where there is one.
    expect(within(rows[0] as HTMLElement).getByText("The default plays")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByRole("button", { name: "Add" })).toBeTruthy();
    expect(within(rows[4] as HTMLElement).getByRole("button", { name: "Replace" })).toBeTruthy();
    expect(within(rows[4] as HTMLElement).getByRole("button", { name: "Remove" })).toBeTruthy();
    expect(screen.getByText("Map intros stay on this computer: account sync doesn't share them (video files are large). Add them on each computer that plays intros.")).toBeTruthy();
    expect(screen.getByText("Next intro: Mirage, at pistol round start.")).toBeTruthy();
    expect(introFacts({ ...mirage, durationMs: 75_000, fps: 29.97, bytes: 900_000 })).toBe("1:15 · H.264 · 1920×1080 · 29.97 fps · 879 KB");
  });

  it("Start the intro: the six choices with their hints; If the round goes live: cut back (default) or finish, which says viewers miss the round's start", async () => {
    const calls = serve({ "GET /api/v1/map-intros": view(), "GET /api/v1/obs/auto": obsAuto, "PUT /api/v1/map-intros/settings": view({ settings: { trigger: "knife", onLive: "cut", vmixIn: null, vmixOut: null } }) });
    wrap(<MapIntrosPanel />);
    const start = (await screen.findByLabelText(/Start the intro/)) as HTMLSelectElement;
    await waitFor(() => expect(start.disabled).toBe(false));
    expect([...start.options].map((o) => o.textContent)).toEqual(["Manual only", "When the map loads", "Knife round start", "Pistol round start", "Both pistol rounds", "When the match goes live"]);
    expect(start.value).toBe("pistol");
    fireEvent.change(start, { target: { value: "knife" } });
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT").at(-1)?.body).toEqual({ trigger: "knife" }));
    await screen.findByText(/A map without a knife round gets no intro by itself/);
    const onLive = screen.getByLabelText(/If the round goes live during the intro/) as HTMLSelectElement;
    expect([...onLive.options].map((o) => o.textContent)).toEqual(["Cut back to the game (recommended)", "Finish the intro (viewers miss the start of the round)"]);
    fireEvent.change(onLive, { target: { value: "finish" } });
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT").at(-1)?.body).toEqual({ onLive: "finish" }));
    // The intro transitions in OBS: the MatchFrame Stinger by default.
    const into = screen.getByLabelText(/Map intro in/) as HTMLSelectElement;
    expect(into.options[0]!.textContent).toBe("MatchFrame Stinger (when OBS has it)");
    fireEvent.change(into, { target: { value: "Fade" } });
    await waitFor(() => expect(calls.find((c) => c.method === "PUT" && c.path === "/api/v1/obs/auto")?.body).toEqual({ introIn: "Fade" }));
  });

  it("Add uploads the chosen file to its slot (streamed as the file itself), Remove deletes it; a refused file says why", async () => {
    const added = view({ slots: view().slots.map((s) => (s.slot === "de_nuke" ? { ...s, intro: { ...mirage, slot: "de_nuke", originalName: "nuke.mp4" } } : s)) });
    const calls = serve({ "GET /api/v1/map-intros": view(), "GET /api/v1/obs/auto": obsAuto, "POST /api/v1/map-intros/de_nuke": { ...added, intro: added.slots[5]!.intro }, "DELETE /api/v1/map-intros/de_mirage": view({ slots: view().slots.map((s) => (s.slot === "de_mirage" ? { ...s, intro: null } : s)) }) }, { "POST /api/v1/map-intros/de_train": { status: 422, message: "It is only 0.3 s long: an intro must be at least 0.5 s." } });
    wrap(<MapIntrosPanel />);
    const table = await screen.findByLabelText("Map intro videos");
    const row = (label: string) => [...table.querySelectorAll("tbody tr")].find((r) => r.querySelector("strong")?.textContent === label) as HTMLElement;
    const file = screen.getByLabelText("Intro video file") as HTMLInputElement;
    fireEvent.click(within(row("Nuke")).getByRole("button", { name: "Add" }));
    fireEvent.change(file, { target: { files: [new File([new Uint8Array(64)], "nuke.mp4", { type: "video/mp4" })] } });
    await waitFor(() => expect(calls.find((c) => c.method === "POST")).toMatchObject({ path: "/api/v1/map-intros/de_nuke", body: { file: "nuke.mp4", query: "?name=nuke.mp4", type: "video/mp4" } }));
    await screen.findByText("Nuke intro added");
    await waitFor(() => expect(within(row("Nuke")).getByText("nuke.mp4")).toBeTruthy());
    fireEvent.click(within(row("Train")).getByRole("button", { name: "Add" }));
    fireEvent.change(file, { target: { files: [new File([new Uint8Array(8)], "short.mp4", { type: "video/mp4" })] } });
    await screen.findByText("It is only 0.3 s long: an intro must be at least 0.5 s.");
    fireEvent.click(within(row("Mirage")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/v1/map-intros/de_mirage")).toBe(true));
    await screen.findByText("Mirage intro removed");
  });
});

describe("Map intro in Live Control", () => {
  it("shows the status line and plays the current map's intro, or the next map's from the veto; Stop while one is on air", async () => {
    const onAir: MapIntroStatus = { ...status, state: "playing", running: true, detail: "On air: Inferno's intro (the default).", playing: { map: "de_inferno", displayName: "Inferno", slot: "default", isDefault: true, by: "operator", durationMs: 4500, elapsedMs: 300 } };
    const calls = serve({ "GET /api/v1/map-intros": view(), "POST /api/v1/map-intros/play": { status: { ...onAir, playing: { ...onAir.playing!, map: "de_mirage", displayName: "Mirage", slot: "de_mirage", isDefault: false } } }, "POST /api/v1/map-intros/play-next": { status: onAir }, "POST /api/v1/map-intros/stop": { status } });
    wrap(<MapIntroCard />);
    await screen.findByText("Next intro: Mirage, at pistol round start.");
    const play = screen.getByRole("button", { name: "Play map intro" }) as HTMLButtonElement;
    await waitFor(() => expect(play.disabled).toBe(false));
    const next = screen.getByRole("button", { name: "Play next map's intro (Inferno)" });
    fireEvent.click(next);
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/map-intros/play-next")).toBe(true));
    await screen.findByText("Inferno intro on air");
    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/map-intros/stop")).toBe(true));
  });

  it("can't play during a live round (the engine's reason on the button); the console shortcut Ctrl+Shift+F4 plays the map intro", async () => {
    const live = { ...status, state: "blocked" as const, blocked: "A round is live: the intro plays between rounds (in the warmup, a freeze time, or after the round).", blockedNext: "A round is live: the intro plays between rounds (in the warmup, a freeze time, or after the round)." };
    const calls = serve({ "GET /api/v1/map-intros": view({ status: live }), "POST /api/v1/map-intros/play": { status } });
    function Keys() {
      useReplayShortcuts();
      return null;
    }
    wrap(
      <>
        <Keys />
        <MapIntroCard />
      </>,
    );
    const play = (await screen.findByRole("button", { name: "Play map intro" })) as HTMLButtonElement;
    await waitFor(() => expect(play.disabled).toBe(true));
    fireEvent.keyDown(window, { key: "F4", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/map-intros/play")).toBe(true));
  });
});
