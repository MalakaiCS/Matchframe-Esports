// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AutoReplayResponse, ReplayPcResponse } from "../../api/types.ts";
import { liveStore } from "../../state/live.ts";
import { SessionContext } from "../../state/session.tsx";
import { ToastProvider } from "../../components/toasts.tsx";
import { AutoReplaysPanel, ReplayPcPanel } from "./AutoReplays.tsx";

const auto: AutoReplayResponse = {
  settings: { enabled: false, maxPerBreak: 2, speedPercent: 100, startDelayMs: 3500, otherAngles: true, ownBigPlays: true },
  status: { enabled: false, state: "off", detail: "Automatic replays are off.", waiting: 0, playing: null, lastPlayed: null },
};
const link: ReplayPcResponse = {
  settings: { enabled: false, mainUrl: "", preRollMs: 5000, postRollMs: 2000, sameCstv: "stay_behind", behindMs: 7000 },
  hasToken: false,
  status: { enabled: false, state: "off", detail: "This computer is not a replay PC.", main: null, mainObserved: null, obsReady: false, timing: { state: "measuring", delayMs: null, detail: "" }, rewind: { state: "off", detail: "", count: 0 }, filming: null, planned: 0, sent: 0, failed: 0, skipped: 0, last: null, lastSkip: null },
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
