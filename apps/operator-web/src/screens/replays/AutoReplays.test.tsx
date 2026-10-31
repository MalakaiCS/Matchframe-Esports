// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AutoReplayResponse, ReplayFeedResponse, ReplayPcResponse } from "../../api/types.ts";
import { liveStore } from "../../state/live.ts";
import { SessionContext } from "../../state/session.tsx";
import { ToastProvider } from "../../components/toasts.tsx";
import { AutoReplaysPanel, ReplayPcPanel } from "./AutoReplays.tsx";

const auto: AutoReplayResponse = {
  settings: { enabled: false, perBreak: 4, order: "round", speedPercent: 100, startDelayMs: 3500, otherAngles: true, ownBigPlays: true, mixer: "obs", vmixUrl: "http://127.0.0.1:8088", vmixTransition: "CutDirect" },
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
        ],
      },
    };
    serve({ "GET /api/v1/replays/auto": ranked });
    wrap(<AutoReplaysPanel />);
    expect(await screen.findByText("Round 7: its clips, best first")).toBeTruthy();
    const items = screen.getByLabelText("Clips of the round, best first").querySelectorAll("li");
    expect([...items].map((li) => li.textContent)).toEqual(["Played3K: saber ▸ a, b, c (AK47)50 · 3K, not seen live", "Same kills3K: saber ▸ a, b, c42 · 3K", "On airnova ▸ zeal (KNIFE)30 · knife", "Not playedhaze ▸ kite (AK47)10"]);
    expect((screen.getByLabelText(/Replays per break/) as HTMLSelectElement).value).toBe("4");
  });

  it("plays in vMix: its address, transition and a test", async () => {
    const vmix: AutoReplayResponse = { ...auto, settings: { ...auto.settings, mixer: "vmix" }, status: { ...auto.status, vmix: { connected: true, version: "27.0.0.49", error: null } } };
    const calls = serve({ "GET /api/v1/replays/auto": vmix, "PUT /api/v1/replays/auto": vmix, "POST /api/v1/replays/vmix/test": { connected: true, version: "27.0.0.49", error: null } });
    wrap(<AutoReplaysPanel />);
    expect(await screen.findByText("vMix 27.0.0.49")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Set up OBS replay scene" })).toBeNull();
    fireEvent.change(screen.getByLabelText(/Transition/), { target: { value: "Stinger1" } });
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ vmixTransition: "Stinger1" }));
    fireEvent.click(screen.getByRole("button", { name: "Test vMix" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/replays/vmix/test")).toBe(true));
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
