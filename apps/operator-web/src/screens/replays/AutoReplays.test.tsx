// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AutoReplayResponse, ReplayFeedResponse, ReplayPcResponse } from "../../api/types.ts";
import { liveStore } from "../../state/live.ts";
import { SessionContext } from "../../state/session.tsx";
import { ToastProvider } from "../../components/toasts.tsx";
import { useReplayShortcuts } from "../../lib/replay-keys.ts";
import { AutoReplaysPanel, ReplayPcPanel } from "./AutoReplays.tsx";

const auto: AutoReplayResponse = {
  settings: { enabled: false, perBreak: 4, order: "round", speedPercent: 100, startDelayMs: 3500, otherAngles: true, ownBigPlays: true, mixer: "obs", vmixUrl: "http://127.0.0.1:8088", vmixTransition: "CutDirect", vmixTransitionOut: null, cutBack: "clock", cutBackClockSec: 110, between: "fade", fadeMs: 500 },
  status: { enabled: false, state: "off", detail: "Automatic replays are off.", waiting: 0, playing: null, lastPlayed: null },
};
const link: ReplayPcResponse = {
  settings: { enabled: false, mainUrl: "", preRollMs: 5000, postRollMs: 2000, sameCstv: "stay_behind", behindMs: 7000 },
  hasToken: false,
  status: { enabled: false, state: "off", detail: "This computer is not a replay PC.", main: null, mainObserved: null, obsReady: false, timing: { state: "measuring", delayMs: null, detail: "" }, rewind: { state: "off", detail: "", count: 0 }, filming: null, planned: 0, sent: 0, failed: 0, skipped: 0, last: null, lastSkip: null },
};

const feedOff: ReplayFeedResponse = {
  settings: { enabled: false, source: null, latencyMs: 100, keepSeconds: 240, encoder: "auto", bitrateMbps: 20 },
  status: { enabled: false, state: "off", detail: "The replay feed is off.", source: null, width: null, height: null, fps: null, receivingFps: 0, dropped: 0, bufferedSec: 0, ndi: { available: null, version: null, error: null }, ffmpeg: { source: "missing", path: null, version: null, encoder: null, downloading: null, error: null, canDownload: true }, clips: 0 },
};

function serve(routes: Record<string, unknown>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const path = new URL(url, "http://x").pathname;
      calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const r = routes[`${method} ${path}`] ?? routes[`GET ${path}`];
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

beforeEach(() => liveStore.reset());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Automatic replays panel", () => {
  it("switches automatic replays on and sets slow motion", async () => {
    const on = { ...auto, settings: { ...auto.settings, enabled: true }, status: { ...auto.status, enabled: true, state: "waiting" as const, detail: "Waiting for the round to end." } };
    const calls = serve({ "GET /api/v1/replays/auto": auto, "PUT /api/v1/replays/auto": on });
    wrap(<AutoReplaysPanel />);
    const box = await screen.findByLabelText(/Play replays by themselves/);
    await waitFor(() => expect((box as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(box);
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ enabled: true }));
    expect(await screen.findByText("Waiting for the round to end.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Speed"), { target: { value: "50" } });
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT").at(-1)?.body).toEqual({ speedPercent: 50 }));
  });

  it("plays the chosen clips in round order by default, or best first", async () => {
    const calls = serve({ "GET /api/v1/replays/auto": auto, "PUT /api/v1/replays/auto": { ...auto, settings: { ...auto.settings, order: "best" } } });
    wrap(<AutoReplaysPanel />);
    const order = (await screen.findByLabelText(/Order/)) as HTMLSelectElement;
    await waitFor(() => expect(order.disabled).toBe(false));
    expect(order.value).toBe("round");
    expect([...order.options].map((o) => o.textContent)).toEqual(["Round order", "Best first"]);
    expect(screen.getByText(/The chosen clips play back to back/)).toBeTruthy();
    fireEvent.change(order, { target: { value: "best" } });
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ order: "best" }));
    await waitFor(() => expect(order.value).toBe("best"));
  });

  it("goes back to live by 1:50 on the next round's clock by default, or another time, or before the round starts; fades between replays", async () => {
    const calls = serve({ "GET /api/v1/replays/auto": { ...auto, status: { ...auto.status, twin: { scene: "Matchframe Replay B", input: "Matchframe Replay Clip B", ready: true, detail: "", checkedAt: null } } } });
    wrap(<AutoReplaysPanel />);
    const back = (await screen.findByLabelText(/Back to live/)) as HTMLSelectElement;
    await waitFor(() => expect(back.disabled).toBe(false));
    expect(back.selectedOptions[0]!.textContent).toBe("By 1:50 on the round clock (recommended)");
    expect([...back.options].map((o) => o.textContent).at(-1)).toBe("Before the round starts");
    fireEvent.change(back, { target: { value: "105" } });
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT").at(-1)?.body).toEqual({ cutBack: "clock", cutBackClockSec: 105 }));
    fireEvent.change(back, { target: { value: "before_round" } });
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT").at(-1)?.body).toEqual({ cutBack: "before_round" }));
    const between = screen.getByLabelText(/Between replays/) as HTMLSelectElement;
    expect(between.selectedOptions[0]!.textContent).toBe("Fade, 0.5 s (recommended)");
    fireEvent.change(between, { target: { value: "cut" } });
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT").at(-1)?.body).toEqual({ between: "cut" }));
    fireEvent.change(between, { target: { value: "1000" } });
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT").at(-1)?.body).toEqual({ between: "fade", fadeMs: 1000 }));
    expect(screen.getByText(/Fades between replays through “Matchframe Replay B”/)).toBeTruthy();
    expect(screen.queryByText(/Never while a round is live/)).toBeNull();
  });
});

describe("Automatic replays: the round's clips, ranked, and vMix", () => {
  it("lists the round's clips best first with why, and what was played", async () => {
    const ranked: AutoReplayResponse = {
      ...auto,
      status: {
        ...auto.status,
        round: 7,
        ranked: [
          { id: "a", label: "3K: saber ▸ a, b, c (AK47)", score: 50, reasons: ["3K", "not seen live"], state: "played" },
          { id: "b", label: "3K: saber ▸ a, b, c", score: 42, reasons: ["3K"], state: "duplicate" },
          { id: "c", label: "nova ▸ zeal (KNIFE)", score: 30, reasons: ["knife"], state: "picked" },
          { id: "d", label: "haze ▸ kite (AK47)", score: 10, reasons: [], state: "left" },
          { id: "e", label: "rain ▸ zeal (AWP)", score: 13, reasons: ["AWP"], state: "left", note: "from before the round started (a restart or a backup)" },
        ],
      },
    };
    serve({ "GET /api/v1/replays/auto": ranked });
    wrap(<AutoReplaysPanel />);
    expect(await screen.findByText("Round 7: its clips, best first")).toBeTruthy();
    const items = screen.getByLabelText("Clips of the round, best first").querySelectorAll("li");
    expect([...items].map((li) => li.textContent)).toEqual([
      "Played3K: saber ▸ a, b, c (AK47)50 · 3K, not seen live",
      "Same kills3K: saber ▸ a, b, c42 · 3KExcludePin first",
      "On airnova ▸ zeal (KNIFE)30 · knife",
      "Not playedhaze ▸ kite (AK47)10ExcludePin first",
      "Not playedrain ▸ zeal (AWP)13 · AWPfrom before the round started (a restart or a backup)",
    ]);
    expect((screen.getByLabelText(/Replays per break/) as HTMLSelectElement).value).toBe("4");
  });

  it("plays in vMix: its address, transition and a test", async () => {
    const vmix: AutoReplayResponse = { ...auto, settings: { ...auto.settings, mixer: "vmix" }, status: { ...auto.status, vmix: { connected: true, version: "27.0.0.49", error: null } } };
    const calls = serve({ "GET /api/v1/replays/auto": vmix, "PUT /api/v1/replays/auto": vmix, "POST /api/v1/replays/vmix/test": { connected: true, version: "27.0.0.49", error: null } });
    wrap(<AutoReplaysPanel />);
    expect(await screen.findByText("vMix 27.0.0.49")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Set up OBS replay scene" })).toBeNull();
    fireEvent.change(screen.getByLabelText(/Replay in/), { target: { value: "Stinger1" } });
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ vmixTransition: "Stinger1" }));
    const out = screen.getByLabelText(/Replay out/) as HTMLSelectElement;
    expect(out.selectedOptions[0]!.textContent).toBe("Same as Replay in");
    fireEvent.change(out, { target: { value: "CutDirect" } });
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT").at(-1)?.body).toEqual({ vmixTransitionOut: "CutDirect" }));
    fireEvent.click(screen.getByRole("button", { name: "Test vMix" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/replays/vmix/test")).toBe(true));
  });
});

describe("Automatic replays: the operator's controls, sound, Test replays and hotkeys", () => {
  const playing: AutoReplayResponse = {
    ...auto,
    settings: { ...auto.settings, enabled: true },
    status: {
      ...auto.status,
      enabled: true,
      state: "playing",
      detail: "Replay 1 of 3: saber ▸ a (AK47)",
      playing: { id: "a", label: "saber ▸ a (AK47)" },
      running: true,
      held: false,
      position: { n: 1, of: 3 },
      round: 7,
      ranked: [
        { id: "a", label: "saber ▸ a (AK47)", score: 18, reasons: [], state: "picked", excluded: false, pinned: false },
        { id: "b", label: "nova ▸ zeal (KNIFE)", score: 30, reasons: ["knife"], state: "waiting", excluded: false, pinned: false },
        { id: "c", label: "haze ▸ kite (AK47)", score: 10, reasons: [], state: "left", note: "excluded by the operator", excluded: true, pinned: false },
      ],
    },
  };

  it("while a break's replays play: Skip, Hold then Resume, and Stop and go live", async () => {
    const held = { ...playing, status: { ...playing.status, held: true } };
    const calls = serve({ "GET /api/v1/replays/auto": playing, "POST /api/v1/replays/auto/skip": playing, "POST /api/v1/replays/auto/hold": held, "POST /api/v1/replays/auto/stop": auto });
    wrap(<AutoReplaysPanel />);
    const group = await screen.findByRole("group", { name: "Replays playing now" });
    expect(group.textContent).toContain("Ctrl+Shift+F5 Skip");
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/replays/auto/skip")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Hold" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/api/v1/replays/auto/hold")?.body).toEqual({ held: true }));
    expect(await screen.findByRole("button", { name: "Resume" })).toBeTruthy();
    expect(screen.getByText(/Held: nothing plays on until Resume. The round clock still cuts back to live./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop and go live" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/v1/replays/auto/stop")).toBe(true));
    await waitFor(() => expect(screen.queryByRole("group", { name: "Replays playing now" })).toBeNull());
  });

  it("excludes a clip of the round, lets an excluded one play again, and pins one to play first", async () => {
    const calls = serve({ "GET /api/v1/replays/auto": playing, "PUT /api/v1/replays/auto/clips/b": playing, "PUT /api/v1/replays/auto/clips/c": playing });
    wrap(<AutoReplaysPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Exclude nova ▸ zeal (KNIFE)" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/api/v1/replays/auto/clips/b")?.body).toEqual({ excluded: true }));
    fireEvent.click(screen.getByRole("button", { name: "Pin first nova ▸ zeal (KNIFE)" }));
    await waitFor(() => expect(calls.filter((c) => c.path === "/api/v1/replays/auto/clips/b").at(-1)?.body).toEqual({ pinned: true }));
    // The excluded one: Include, and no Pin; the one on air: neither.
    fireEvent.click(screen.getByRole("button", { name: "Include haze ▸ kite (AK47)" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/api/v1/replays/auto/clips/c")?.body).toEqual({ excluded: false }));
    expect(screen.queryByRole("button", { name: "Pin first haze ▸ kite (AK47)" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Exclude saber ▸ a (AK47)" })).toBeNull();
  });

  it("picks the live game audio (never a replay source), how far it goes down, and the replay volume", async () => {
    const withAudio: AutoReplayResponse = { ...auto, settings: { ...auto.settings, duckInputs: [], duckTo: -20, replayVolumeDb: null }, status: { ...auto.status, audio: { state: "off", detail: "No live game audio picked: nothing is turned down during replays.", lowered: [], lastRestore: null } } };
    const calls = serve({
      "GET /api/v1/replays/auto": withAudio,
      "PUT /api/v1/replays/auto": withAudio,
      "GET /api/v1/replays/audio-inputs": {
        mixer: "obs",
        error: null,
        inputs: [
          { id: "Game audio", name: "Game audio", kind: "wasapi_output_capture", volume: -1.9, muted: false, picked: false, replay: false },
          { id: "Caster mic", name: "Caster mic", kind: "wasapi_input_capture", volume: 0, muted: false, picked: false, replay: false },
          { id: "Matchframe Replay Clip", name: "Matchframe Replay Clip", kind: "ffmpeg_source", volume: 0, muted: false, picked: false, replay: true },
        ],
      },
    });
    wrap(<AutoReplaysPanel />);
    const game = (await screen.findByLabelText("Game audio")) as HTMLInputElement;
    await waitFor(() => expect(game.disabled).toBe(false));
    expect((screen.getByLabelText(/Matchframe Replay Clip \(a replay source/) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("No live game audio picked: nothing is turned down during replays.")).toBeTruthy();
    fireEvent.click(game);
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ duckInputs: ["Game audio"] }));
    fireEvent.change(screen.getByLabelText(/Live game audio during replays/), { target: { value: "mute" } });
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT").at(-1)?.body).toEqual({ duckTo: "mute" }));
    const volume = screen.getByLabelText(/Replay volume/) as HTMLSelectElement;
    expect(volume.selectedOptions[0]!.textContent).toBe("As set in OBS");
    fireEvent.change(volume, { target: { value: "-6" } });
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT").at(-1)?.body).toEqual({ replayVolumeDb: -6 }));
  });

  it("Test replays asks first (it plays on the program output), then reports each step and how to fix what failed", async () => {
    const report: AutoReplayResponse = {
      ...auto,
      status: {
        ...auto.status,
        test: {
          state: "failed",
          mixer: "obs",
          startedAt: "2026-10-31T10:00:00Z",
          finishedAt: "2026-10-31T10:00:10Z",
          steps: [
            { id: "ready", label: "Replay scene and twin ready", state: "ok", detail: "“Matchframe Replay” with “Matchframe Replay Clip”.", fix: null },
            { id: "in", label: "Transition in (Replay in)", state: "ok", detail: "Opener to “Matchframe Replay”.", fix: null },
            { id: "fade", label: "Fade (0.5 s) between the clips", state: "failed", detail: "The sample clip didn't play.", fix: "The replay media source must be a Media Source playing local files." },
            { id: "out", label: "Transition out (Replay out)", state: "ok", detail: "Fade back to “Game”.", fix: null },
            { id: "live", label: "Back live", state: "ok", detail: "OBS shows “Game”, the program is live.", fix: null },
            { id: "audio", label: "Live audio turned down and put back", state: "skipped", detail: "No live game audio picked.", fix: null },
          ],
        },
      },
    };
    const calls = serve({ "GET /api/v1/replays/auto": auto, "POST /api/v1/replays/auto/test": report });
    wrap(<AutoReplaysPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Test replays" }));
    expect(await screen.findByText(/This plays on your program output now/)).toBeTruthy();
    expect(calls.some((c) => c.path === "/api/v1/replays/auto/test")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Play the test now" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/replays/auto/test")).toBe(true));
    const steps = (await screen.findByLabelText("Test replays report")).querySelectorAll("li");
    expect([...steps].map((li) => li.textContent)).toEqual([
      "OKReplay scene and twin ready“Matchframe Replay” with “Matchframe Replay Clip”.",
      "OKTransition in (Replay in)Opener to “Matchframe Replay”.",
      "FailedFade (0.5 s) between the clipsThe sample clip didn't play.Fix: The replay media source must be a Media Source playing local files.",
      "OKTransition out (Replay out)Fade back to “Game”.",
      "OKBack liveOBS shows “Game”, the program is live.",
      "SkippedLive audio turned down and put backNo live game audio picked.",
    ]);
    expect(screen.getByText("Some steps failed: see Fix above, then test again.")).toBeTruthy();
  });

  it("sets global hotkeys in the program (the suggested ones, or off) and says clearly when a key is taken", async () => {
    const state = { keys: { skip: null, hold: null, stop: null }, registered: { skip: false, hold: false, stop: false }, errors: { skip: null, hold: null, stop: null }, suggested: { skip: "CommandOrControl+Shift+F5", hold: "CommandOrControl+Shift+F6", stop: "CommandOrControl+Shift+F7" } };
    const set = vi.fn(async (patch: Record<string, string | null>) => ({ ...state, keys: { ...state.keys, ...patch }, registered: { skip: false, hold: true, stop: true }, errors: { skip: "CommandOrControl+Shift+F5 is already taken by another program (or Windows): choose another key for Skip.", hold: null, stop: null } }));
    (window as { matchframe?: unknown }).matchframe = { replayHotkeys: { get: async () => state, set } };
    try {
      serve({ "GET /api/v1/replays/auto": auto });
      wrap(<AutoReplaysPanel />);
      // (Enabled once the program has said which keys are set.)
      await waitFor(() => expect((screen.getByRole("button", { name: "Use the suggested keys" }) as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(screen.getByRole("button", { name: "Use the suggested keys" }));
      await waitFor(() => expect(set).toHaveBeenCalledWith(state.suggested));
      expect((await screen.findAllByText("CommandOrControl+Shift+F5 is already taken by another program (or Windows): choose another key for Skip.")).length).toBeGreaterThan(0);
      expect((screen.getByLabelText(/Hold \/ Resume \(global\)/) as HTMLInputElement).value).toBe("CommandOrControl+Shift+F6");
      fireEvent.click(screen.getByRole("button", { name: "Turn them off" }));
      await waitFor(() => expect(set).toHaveBeenLastCalledWith({ skip: null, hold: null, stop: null }));
    } finally {
      delete (window as { matchframe?: unknown }).matchframe;
    }
  });

  it("console shortcuts: Ctrl+Shift+F5 skips, F6 holds, F7 stops; not while typing", async () => {
    const calls = serve({ "POST /api/v1/replays/auto/skip": auto, "POST /api/v1/replays/auto/hold": auto, "POST /api/v1/replays/auto/stop": auto });
    function Keys() {
      useReplayShortcuts();
      return <input aria-label="typing" />;
    }
    wrap(<Keys />);
    fireEvent.keyDown(window, { key: "F5", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "F6", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "F7", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "F5" });
    fireEvent.keyDown(screen.getByLabelText("typing"), { key: "F5", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(calls.map((c) => c.path)).toEqual(["/api/v1/replays/auto/skip", "/api/v1/replays/auto/hold", "/api/v1/replays/auto/stop"]));
  });
});

describe("Replay feed (NDI) on the main PC", () => {
  it("offers the ffmpeg download, finds the replay PC's NDI source and records it", async () => {
    const recording: ReplayFeedResponse = {
      settings: { ...feedOff.settings, enabled: true, source: { name: "REPLAY-PC (vMix Desktop Capture)" } },
      status: { ...feedOff.status, enabled: true, state: "recording", detail: "Recording REPLAY-PC (vMix Desktop Capture) (1920×1080, 60 fps, h264_nvenc).", width: 1920, height: 1080, fps: 60, receivingFps: 60, bufferedSec: 182, clips: 4, ndi: { available: true, version: "NDI SDK 6.1", error: null }, ffmpeg: { ...feedOff.status.ffmpeg, source: "downloaded", version: "7.1-essentials_build-www.gyan.dev", encoder: "h264_nvenc" } },
    };
    const calls = serve({
      "GET /api/v1/replay-pc": link,
      "GET /api/v1/network": { computer: "x", host: "127.0.0.1", apiPort: 37211, reachable: false, addresses: [] },
      "GET /api/v1/replays/feed": feedOff,
      "PUT /api/v1/replays/feed": recording,
      "POST /api/v1/replays/feed/sources": { sources: [{ name: "REPLAY-PC (vMix Desktop Capture)" }], error: null },
      "POST /api/v1/replays/feed/ffmpeg": recording.status.ffmpeg,
    });
    wrap(<ReplayPcPanel />);
    expect(await screen.findByRole("button", { name: "Download ffmpeg" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Find NDI sources" }));
    await waitFor(() => expect(screen.getByRole("option", { name: "REPLAY-PC (vMix Desktop Capture)" })).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/The replay PC's NDI source/), { target: { value: "REPLAY-PC (vMix Desktop Capture)" } });
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ source: { name: "REPLAY-PC (vMix Desktop Capture)" } }));
    expect(await screen.findByText(/Recording REPLAY-PC \(vMix Desktop Capture\) \(1920×1080/)).toBeTruthy();
    expect(screen.getByText(/182 s kept · 60 frames a second arriving · 4 clips cut/)).toBeTruthy();
  });

  it("tells the replay PC it needs no OBS when the main PC records its screen", async () => {
    const fed: ReplayPcResponse = { ...link, settings: { ...link.settings, enabled: true, mainUrl: "http://192.168.1.20:37211" }, hasToken: true, status: { ...link.status, enabled: true, state: "connected", detail: "Linked to STUDIO-PC.", transport: "feed" } };
    serve({ "GET /api/v1/replay-pc": fed });
    wrap(<ReplayPcPanel />);
    expect(await screen.findByText(/records this computer's screen over NDI: no OBS needed here/)).toBeTruthy();
    expect((screen.getByLabelText(/Kills to film/) as HTMLSelectElement).value).toBe("all");
  });
});

describe("Replay PC panel", () => {
  it("connects this computer to the main PC as the replay PC", async () => {
    const linked = { ...link, settings: { ...link.settings, enabled: true, mainUrl: "http://192.168.1.20:37211" }, hasToken: true, status: { ...link.status, enabled: true, state: "connected" as const, detail: "Linked to STUDIO-PC.", mainObserved: "765", obsReady: true } };
    const calls = serve({ "GET /api/v1/replay-pc": link, "PUT /api/v1/replay-pc": linked, "GET /api/v1/network": { computer: "x", host: "127.0.0.1", apiPort: 37211, reachable: false, addresses: [] } });
    wrap(<ReplayPcPanel />);
    // Loaded: this computer isn't a replay PC yet, so the main PC side shows first.
    await screen.findByText("Only this computer can connect right now.");
    fireEvent.click(screen.getByRole("tab", { name: /This is the replay PC/ }));
    fireEvent.change(screen.getByLabelText(/Main PC address/), { target: { value: "192.168.1.20:37211" } });
    fireEvent.change(screen.getByLabelText(/Replay PC code/), { target: { value: "abc123" } });
    fireEvent.click(screen.getByRole("button", { name: "Make this the replay PC" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ enabled: true, mainUrl: "192.168.1.20:37211", token: "abc123" }));
  });

  it("shows how far behind the main PC this computer is, what it films, and how it goes back on the same CSTV", async () => {
    const behind: ReplayPcResponse = {
      ...link,
      settings: { ...link.settings, enabled: true, mainUrl: "http://192.168.1.20:37211" },
      hasToken: true,
      status: {
        ...link.status,
        enabled: true,
        state: "connected",
        detail: "Linked to STUDIO-PC.",
        mainObserved: "765",
        obsReady: true,
        timing: { state: "behind", delayMs: 7040, detail: "7.0 s behind the main PC: this computer gets on the killer before each missed kill plays here." },
        rewind: { state: "holding", detail: "Went back 7.0 s and stays there: missed kills are known before they play here.", count: 1 },
        filming: "haze ▸ kite (AWP)",
        planned: 1,
        sent: 3,
        skipped: 1,
        lastSkip: { label: "saber ▸ blaze (AK47)", reason: "this computer is filming haze then", at: "2026-10-28T04:00:00Z" },
      },
    };
    const calls = serve({ "GET /api/v1/replay-pc": behind, "PUT /api/v1/replay-pc": behind });
    wrap(<ReplayPcPanel />);
    expect(await screen.findByText("7.0 s behind")).toBeTruthy();
    expect(screen.getByText(/gets on the killer before each missed kill/)).toBeTruthy();
    expect(screen.getByText("Filming now: haze ▸ kite (AWP) (1 more planned)")).toBeTruthy();
    expect(screen.getByText(/Not filmed: 1 · last: saber ▸ blaze \(AK47\) \(this computer is filming haze then\)/)).toBeTruthy();
    expect(screen.getByText("Best: this computer about 7 s behind the main PC")).toBeTruthy();
    expect(screen.getByText(/Going back: Went back 7.0 s and stays there/)).toBeTruthy();
    expect((screen.getByLabelText(/On the same CSTV as the main PC/) as HTMLSelectElement).value).toBe("stay_behind");
    fireEvent.change(screen.getByLabelText(/How far behind/), { target: { value: "10000" } });
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ behindMs: 10000 }));
    fireEvent.change(screen.getByLabelText(/On the same CSTV as the main PC/), { target: { value: "each_kill" } });
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toContainEqual({ sameCstv: "each_kill" }));
  });

  it("makes a replay PC code on the main PC", async () => {
    const calls = serve({ "GET /api/v1/replay-pc": link, "GET /api/v1/network": { computer: "STUDIO", host: "0.0.0.0", apiPort: 37211, reachable: true, addresses: ["192.168.1.20"] }, "POST /api/v1/tokens": { id: "tok_1", token: "f00dcafe" } });
    wrap(<ReplayPcPanel />);
    expect(await screen.findByText("192.168.1.20:37211")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Make a replay PC code" }));
    expect(await screen.findByText("f00dcafe")).toBeTruthy();
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({ role: "replay" });
  });
});
