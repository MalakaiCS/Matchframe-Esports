// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { liveStore } from "../../state/live.ts";
import { SessionContext } from "../../state/session.tsx";
import { ToastProvider } from "../../components/toasts.tsx";
import type { HighlightsOverview, ReelJob, ReelPlan } from "./HighlightReel.tsx";

// The canvas isn't there in jsdom: the lower thirds come from a stand-in.
const draw = vi.fn(async (clips: { id: string }[]) => Object.fromEntries(clips.map((c) => [c.id, `png:${c.id}`])));
vi.mock("../../lib/match-art/reel.ts", () => ({ drawReelGraphics: (clips: { id: string }[]) => draw(clips) }));
const { HighlightReelPanel } = await import("./HighlightReel.tsx");

function serve(routes: Record<string, unknown | ((body: unknown) => unknown)>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const path = decodeURIComponent(new URL(url, "http://x").pathname);
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      const route = routes[`${method} ${path}`];
      const r = typeof route === "function" ? (route as (b: unknown) => unknown)(body) : route;
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

const graphic = (name: string, multiKill: "3K" | null) => ({ id: name, roundNumber: 3, label: name, player: { steamId: "1", name }, team: null, side: "T" as const, weapon: null, headshot: false, victims: ["x"], kills: multiKill ? 3 : 1, multiKill, clutchVersus: null });
const plan: ReelPlan = {
  mapKey: "m2",
  mapName: "de_mirage",
  displayName: "Mirage",
  title: "Northern Lights vs Red Harbour",
  clips: [
    { id: "rp1", label: "3K: riot", roundNumber: 1, played: true, score: 50, reasons: ["3K"], startMs: 0, durationMs: 6000, graphic: graphic("riot", "3K") },
    { id: "rp2", label: "nova ▸ ember", roundNumber: 3, played: true, score: 13, reasons: ["headshot"], startMs: 1000, durationMs: 5000, graphic: graphic("nova", null) },
  ],
  fadeMs: 500,
  totalMs: 10500,
};
const job = (over: Partial<ReelJob>): ReelJob => ({ id: "reel_1", mapKey: "m2", title: "Mirage · Northern Lights vs Red Harbour", state: "running", step: "Encoding 1920×1080 at 60 fps", progress: 0.4, clips: 2, durationMs: 10500, file: null, folder: "/data/exports/highlights", bytes: null, error: null, startedAt: "2026-10-31T10:00:00Z", finishedAt: null, ...over });
const overview = (jobs: ReelJob[], ffmpeg: HighlightsOverview["ffmpeg"]["source"] = "path"): HighlightsOverview => ({
  maps: [
    { key: "m2", mapName: "de_mirage", displayName: "Mirage", title: "Northern Lights vs Red Harbour", startedAt: "2026-10-31T09:00:00Z", current: true, played: 7, unplayed: 12, bytes: 300e6 },
    { key: "m1", mapName: "de_nuke", displayName: "Nuke", title: null, startedAt: "2026-10-31T08:00:00Z", current: false, played: 9, unplayed: 3, bytes: 400e6 },
  ],
  settings: { keepGb: 3 },
  keptBytes: 700e6,
  folder: "/data/exports/highlights",
  ffmpeg: { source: ffmpeg, path: ffmpeg === "missing" ? null : "ffmpeg", version: "7.1", downloading: null, error: null, canDownload: true },
  jobs,
});

beforeEach(() => {
  liveStore.reset();
  draw.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete window.matchframe;
});

describe("Highlight reel panel", () => {
  it("plans the map's clips and exports them with the lower thirds burned in", async () => {
    const calls = serve({ "GET /api/v1/highlights": overview([]), "POST /api/v1/highlights/plan": plan, "POST /api/v1/highlights/reels": job({}) });
    wrap(<HighlightReelPanel />);
    expect(await screen.findByText(/2 clips, 0:11 with 0.5 s crossfades/)).toBeTruthy();
    expect(calls.find((c) => c.path === "/api/v1/highlights/plan")?.body).toEqual({ map: null, count: "all", unplayed: false, fadeMs: 500 });
    // The previous map, the best 5 with unplayed clips, a longer fade.
    fireEvent.change(screen.getByLabelText("Map"), { target: { value: "m1" } });
    fireEvent.change(screen.getByLabelText(/^Clips/), { target: { value: "5" } });
    fireEvent.click(screen.getByLabelText(/Also clips that weren't played/));
    fireEvent.change(screen.getByLabelText(/Crossfade/), { target: { value: "1" } });
    await waitFor(() => expect(calls.filter((c) => c.path === "/api/v1/highlights/plan").at(-1)?.body).toEqual({ map: "m1", count: 5, unplayed: true, fadeMs: 1000 }));
    fireEvent.click(screen.getByRole("button", { name: "Export highlight reel" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/v1/highlights/reels")).toBe(true));
    expect(draw).toHaveBeenCalledTimes(1);
    expect(calls.find((c) => c.path === "/api/v1/highlights/reels")!.body).toEqual({ map: "m1", count: 5, unplayed: true, fadeMs: 1000, clipIds: ["rp1", "rp2"], graphics: { rp1: "png:rp1", rp2: "png:rp2" } });
  });

  it("sends no graphics when they aren't burned in", async () => {
    const calls = serve({ "GET /api/v1/highlights": overview([]), "POST /api/v1/highlights/plan": plan, "POST /api/v1/highlights/reels": job({}) });
    wrap(<HighlightReelPanel />);
    await screen.findByText(/2 clips/);
    fireEvent.click(screen.getByLabelText(/Burn in the replay graphic/));
    fireEvent.click(screen.getByRole("button", { name: "Export highlight reel" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/v1/highlights/reels")).toBe(true));
    expect(draw).not.toHaveBeenCalled();
    expect(calls.find((c) => c.path === "/api/v1/highlights/reels")!.body).toEqual({ map: null, count: "all", unplayed: false, fadeMs: 500, clipIds: ["rp1", "rp2"] });
  });

  it("shows the reel being made with a way to stop it, then where it is with Open folder", async () => {
    let jobs = [job({})];
    const calls = serve({ "GET /api/v1/highlights": () => overview(jobs), "POST /api/v1/highlights/plan": plan, "POST /api/v1/highlights/reels/reel_1/cancel": job({ step: "Stopping" }) });
    const open = vi.fn(async () => "");
    window.matchframe = { connectionMode: "local", openHighlights: open };
    wrap(<HighlightReelPanel />);
    expect(await screen.findByText(/Encoding 1920×1080 at 60 fps \(40 %\)/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Export highlight reel" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/highlights/reels/reel_1/cancel")).toBe(true));
    jobs = [job({ state: "done", step: "Done", progress: 1, file: "/videos/Matchframe Highlights/Mirage - 2026-10-31 1002.mp4", bytes: 48e6 })];
    expect(await screen.findByText("/videos/Matchframe Highlights/Mirage - 2026-10-31 1002.mp4", {}, { timeout: 4000 })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open folder" }));
    expect(open).toHaveBeenCalled();
  });

  it("offers ffmpeg's download when it is missing", async () => {
    const calls = serve({ "GET /api/v1/highlights": overview([], "missing"), "POST /api/v1/highlights/plan": plan, "POST /api/v1/highlights/ffmpeg": { source: "downloaded" } });
    wrap(<HighlightReelPanel />);
    expect(await screen.findByText("ffmpeg is needed")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Export highlight reel" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Download ffmpeg" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/highlights/ffmpeg")).toBe(true));
  });
});
