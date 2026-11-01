// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { liveStore } from "../state/live.ts";
import { SessionContext } from "../state/session.tsx";
import { ToastProvider } from "../components/toasts.tsx";
import { TeamCommsScreen } from "./TeamComms.tsx";
import { TeamCommsCard } from "./live/TeamCommsCard.tsx";
import { PreviewPanel } from "./comms/PreviewPanel.tsx";
import type { CommsPreviewPlayer, PreviewStatus } from "../lib/commsPreview.ts";
import type { CommsParticipant, CommsView, ListenInView } from "./comms/types.ts";

function serve(routes: Record<string, unknown | ((body: unknown) => unknown)>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const path = decodeURIComponent(new URL(url, "http://x").pathname);
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      const r = routes[`${method} ${path}`];
      const out = typeof r === "function" ? (r as (b: unknown) => unknown)(body) : r;
      return new Response(JSON.stringify(out ?? { error: "not_found", message: "no route" }), { status: out ? 200 : 404, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}

const wrap = (ui: React.ReactNode, role: string = "owner") =>
  render(
    <ToastProvider>
      <SessionContext.Provider value={{ me: { role: role as never } }}>{ui}</SessionContext.Provider>
    </ToastProvider>,
  );

const person = (n: number, slot: "A" | "B", patch: Partial<CommsParticipant> = {}): CommsParticipant => ({
  key: `team-${slot}/srv/uid${slot}${n}`,
  slot,
  teamId: `team-${slot}`,
  uid: `uid${slot}${n}AAAAAAAAAAAA=`,
  nickname: `${slot === "A" ? "Alpha" : "Bravo"} ${n}`,
  clientId: n,
  present: true,
  saved: true,
  displayName: `${slot === "A" ? "Alpha" : "Bravo"} ${n}`,
  playerId: null,
  pictureUrl: null,
  includeBroadcast: false,
  includeRecording: false,
  levelDb: 0,
  preview: false,
  incoming: { db: -20, talking: true },
  delayed: { recording: null, preview: null, signal: { db: -24, speaking: true } },
  buffer: { heldMs: 2000, bytes: 1000, chunks: 3, lateMs: 0, reanchors: 0 },
  ...patch,
});

const listenIn = (patch: Partial<ListenInView> = {}): ListenInView => ({
  state: "listening",
  label: "LISTENING IN — ALPHA WOLVES",
  detail: "Alpha Wolves's permitted, delayed voices are on air.",
  team: { id: "team-A", slot: "A", name: "Alpha Wolves", shortName: "ALP", logoUrl: null, color: null },
  heardTeamId: "team-A",
  muted: false,
  fault: null,
  since: "2026-11-01T10:00:00.000Z",
  actions: [
    { teamId: "team-A", slot: "A", label: "Listen In — Alpha Wolves", ready: true, readyInMs: null, disabledReason: "Alpha Wolves is on air" },
    { teamId: "team-B", slot: "B", label: "Listen In — Bravo Hawks", ready: true, readyInMs: null, disabledReason: null },
  ],
  end: { disabledReason: null },
  muteAll: { disabledReason: null },
  ...patch,
});

const slot = (id: "A" | "B", name: string) => ({
  id,
  team: { id: `team-${id}`, name, shortName: name.slice(0, 3).toUpperCase(), logoUrl: null, color: null },
  roster: [{ id: `pl-${id}1`, displayName: `${name} player one`, pictureUrl: null }],
  config: { teamId: null, serverHost: "ts.example.org", serverPort: 9987, serverUid: "", channel: `Team ${name}`, nickname: "", identity: "" },
  serverPasswordSaved: true,
  channelPasswordSaved: false,
  state: "ready" as const,
  ready: true,
  readyInMs: null,
  issue: null,
  lost: null,
  tab: { key: "i#1", status: "established", error: null, server: { uid: "srv", name: "Scrims", host: "ts.example.org", port: 9987 }, channel: { id: 1, name: `Team ${name}` }, listener: { clientId: 2, nickname: "MF Listener", inputMuted: true, inputDeactivated: true, outputMuted: false, recording: false }, capturing: true, clients: 3 },
});

const view = (patch: Partial<CommsView> = {}, li: Partial<ListenInView> = {}): CommsView => ({
  enabled: true,
  settings: { enabled: true, bridgePort: 37213, delaySec: 90, fineMs: 250 },
  delay: { configuredMs: 90250, effectiveMs: 90250, pendingMs: null, floorMs: 150 },
  bridge: { state: "listening", port: 37213, error: null, sessions: 1, file: "C:\\Users\\op\\AppData\\Roaming\\Matchframe Esports\\team-comms\\bridge.json", plugins: [{ session: "s1", instance: "abcdef123456", plugin: { name: "Matchframe Team Comms", version: "1.0.0", apiVersion: 26 }, ts3: { clientLibVersion: "3.6.2" }, platform: "windows", connectedForMs: 1000 }] },
  slots: [slot("A", "Alpha Wolves"), slot("B", "Bravo Hawks")],
  participants: [person(1, "A", { includeBroadcast: true }), person(2, "A"), person(1, "B")],
  recording: { team: null, signal: false },
  onAir: {
    listenIn: listenIn(li),
    settings: { ndi: { enabled: true, latencyMs: 60, clockAudio: false }, duck: { enabled: true, inputs: ["Casters"], amountDb: -10, rampMs: 300 }, overlay: { anchor: "top", offsetPx: 140 } },
    outputs: {
      ndi: { enabled: true, state: "running", detail: "Sending.", version: "NDI 6", names: { public: "MatchFrame Comms", recording: "MatchFrame Comms Recording" }, stats: { frames: 100, underruns: 0, late: 0, resyncs: 0, publicSilent: 50, queue: 4, lagMs: 60.2, lagMinMs: 59.8, lagMaxMs: 61, sendMaxMs: 1, connections: { public: 1, recording: 0 } } },
      publicGuard: { blocksSilenced: 12 },
      preview: { listeners: 0, messages: 0, dropped: 0, connects: 0 },
    },
    ducking: { state: "lowered", detail: "Casters down 10 dB for the listen-in: Casters.", lowered: ["Casters"], lastRelease: null },
    overlay: { url: "http://127.0.0.1:37212/comms/public?t=abc123", source: "MatchFrame Team Comms", liveScene: "Game", obsConnected: true, pages: 1, onAir: true, placement: { anchor: "top", offsetPx: 140 } },
  },
  ...patch,
});

beforeEach(() => liveStore.reset());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Team Comms page", () => {
  it("shows the public state in words and runs the four actions by team id", async () => {
    let current = view();
    const calls = serve({
      "GET /api/v1/comms": () => current,
      "GET /api/v1/comms/obs/inputs": { inputs: [{ name: "Casters", kind: "wasapi_input_capture", db: 0, muted: false, picked: true }, { name: "Game audio", kind: "wasapi_process_output_capture", db: -3, muted: false, picked: false }], error: null },
      "POST /api/v1/comms/listen-in": (b: unknown) => {
        current = view({}, { label: "LISTENING IN — BRAVO HAWKS", team: { id: "team-B", slot: "B", name: "Bravo Hawks", shortName: "BRA", logoUrl: null, color: null } });
        return { ...current.onAir.listenIn, body: b };
      },
      "POST /api/v1/comms/listen-in/end": () => (current = view({}, { state: "off", label: "OFF", detail: "Ended by the operator.", team: null })).onAir.listenIn,
      "POST /api/v1/comms/mute-all": () => (current = view({}, { state: "off", label: "OFF — MUTED", muted: true, team: null })).onAir.listenIn,
    });
    wrap(<TeamCommsScreen />);
    const banner = await screen.findByRole("status", { name: /Public comms: LISTENING IN — ALPHA WOLVES/ });
    expect(within(banner).getByText("LISTENING IN — ALPHA WOLVES")).toBeTruthy();
    // Not colour alone: a word and a shape.
    expect(within(banner).getByText("On air")).toBeTruthy();
    expect(within(banner).getByText("●")).toBeTruthy();
    const alpha = screen.getByRole("button", { name: "Listen In — Alpha Wolves" }) as HTMLButtonElement;
    expect(alpha.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Listen In — Bravo Hawks" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST" && c.path === "/api/v1/comms/listen-in")?.body).toEqual({ teamId: "team-B" }));
    expect(await screen.findByText("LISTENING IN — BRAVO HAWKS")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mute All Comms" }));
    expect(await screen.findByText("OFF — MUTED")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "End Listen-In" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/comms/listen-in/end")).toBe(true));
  });

  it("each team: connection, readiness, delay and people with Broadcast / Recording / level / live and delayed meters / Solo", async () => {
    const calls = serve({ "GET /api/v1/comms": view(), "GET /api/v1/comms/obs/inputs": { inputs: [], error: null }, "PUT /api/v1/comms/participants/team-A/srv/uidA2": { ok: true } });
    wrap(<TeamCommsScreen />);
    expect(await screen.findAllByText("Ready: the buffer holds the delay")).toHaveLength(2);
    expect(screen.getAllByText("90.250 s (shared by both teams)")).toHaveLength(2);
    expect(screen.getAllByText(/MF Listener: microphone off, not deafened/)).toHaveLength(2);
    // Meters labelled: incoming (live) apart from delayed (output time).
    expect(screen.getByRole("meter", { name: "Alpha 2: incoming level, live, not on air" })).toBeTruthy();
    expect(screen.getByRole("meter", { name: "Alpha 2: delayed level at the outputs' time" })).toBeTruthy();
    expect(screen.getAllByText("Excluded until included").length).toBe(2);
    fireEvent.click(screen.getByRole("checkbox", { name: "Include Alpha 2 in Broadcast" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")).toMatchObject({ path: "/api/v1/comms/participants/team-A/srv/uidA2", body: { includeBroadcast: true } }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Include Alpha 2 in Recording" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT").at(-1)?.body).toEqual({ includeRecording: true }));
    fireEvent.change(screen.getByRole("combobox", { name: "Roster player for Alpha 2" }), { target: { value: "pl-A1" } });
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT").at(-1)?.body).toEqual({ playerId: "pl-A1" }));
    const solo = screen.getAllByRole("button", { name: "Solo" })[1]!;
    fireEvent.click(solo);
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT").at(-1)?.body).toEqual({ preview: true }));
  });

  it("delay in seconds plus fine ms; secrets never shown; the overlay goes into OBS; caster inputs picked from OBS", async () => {
    const calls = serve({
      "GET /api/v1/comms": view(),
      "PUT /api/v1/comms/settings": { ok: true },
      "PUT /api/v1/comms/public": { ok: true },
      "GET /api/v1/comms/obs/inputs": { inputs: [{ name: "Casters", kind: "wasapi_input_capture", db: 0, muted: false, picked: true }, { name: "Booth mic 2", kind: "wasapi_input_capture", db: -2, muted: false, picked: false }], error: null },
      "POST /api/v1/comms/overlay/obs": { scene: "Game", source: "MatchFrame Team Comms", created: true, onTop: true },
      "GET /api/v1/comms/obs/check": { connected: true, checks: [{ id: "desktop-audio", ok: false, title: "Desktop Audio off", detail: "Capturing everything: Desktop Audio." }] },
    });
    wrap(<TeamCommsScreen />);
    const secs = (await screen.findByLabelText("Seconds")) as HTMLInputElement;
    expect(secs.value).toBe("90");
    fireEvent.change(secs, { target: { value: "92" } });
    fireEvent.change(screen.getByLabelText("Fine (ms)"), { target: { value: "-120" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply delay" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT" && c.path === "/api/v1/comms/settings")?.body).toEqual({ delaySec: 92, fineMs: -120 }));
    // Passwords: "saved", never the value; the token never shown.
    expect(screen.getAllByText("Saved (not shown)").length).toBe(2);
    expect(document.body.textContent).not.toMatch(/s3cret/);
    expect(screen.getByText(/Never shown here/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add to the live scene in OBS" }));
    expect(await screen.findByText(/added on top of “Game”/)).toBeTruthy();
    fireEvent.click(await screen.findByRole("checkbox", { name: /Booth mic 2/ }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT" && c.path === "/api/v1/comms/public")?.body).toEqual({ duck: { inputs: ["Casters", "Booth mic 2"] } }));
    fireEvent.click(screen.getByRole("button", { name: "Check OBS routing" }));
    expect(await screen.findByText("Desktop Audio off")).toBeTruthy();
    expect(screen.getByText("Fix")).toBeTruthy();
  });

  it("a team not ready says why on its button; a viewer can't act", async () => {
    serve({ "GET /api/v1/comms": view({}, { state: "off", label: "OFF", team: null, actions: [{ teamId: "team-A", slot: "A", label: "Listen In — Alpha Wolves", ready: false, readyInMs: 42000, disabledReason: "Not ready: its buffer doesn't hold the delay yet (ready in about 42 s)" }, { teamId: "team-B", slot: "B", label: "Listen In — Bravo Hawks", ready: true, readyInMs: null, disabledReason: null }], end: { disabledReason: "No listen-in is open" } }), "GET /api/v1/comms/obs/inputs": { inputs: [], error: null } });
    wrap(<TeamCommsScreen />, "viewer");
    const a = (await screen.findByRole("button", { name: "Listen In — Alpha Wolves" })) as HTMLButtonElement;
    expect(a.disabled).toBe(true);
    // A viewer: every action disabled with the permission reason.
    expect((screen.getByRole("button", { name: "Listen In — Bravo Hawks" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Mute All Comms" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Live Control's Team Comms card", () => {
  it("shows FAULT in words with its reason, and Mute All from the live room", async () => {
    let current = view({}, { state: "fault", label: "FAULT", team: null, detail: "Closed by a fault: team A's TeamSpeak source was lost. Silent; press Listen In again once the team is ready.", fault: { reason: "team A's TeamSpeak source was lost", at: "2026-11-01T10:00:00Z" } });
    const calls = serve({ "GET /api/v1/comms": () => current, "POST /api/v1/comms/mute-all": () => (current = view({}, { state: "off", label: "OFF — MUTED", muted: true, team: null })).onAir.listenIn });
    wrap(<TeamCommsCard />);
    const banner = await screen.findByRole("status", { name: "Public comms: FAULT" });
    expect(within(banner).getByText("Fault: silent")).toBeTruthy();
    expect(within(banner).getByText(/TeamSpeak source was lost/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Listen In — Alpha Wolves" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mute All Comms" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/comms/mute-all")).toBe(true));
    expect(await screen.findByText("OFF — MUTED")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Team Comms" }).getAttribute("href")).toBe("/live/comms");
  });

  it("stays out of the way while Team Comms is off", async () => {
    serve({ "GET /api/v1/comms": view({ enabled: false }) });
    const { container } = wrap(<TeamCommsCard />);
    await waitFor(() => expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 30));
    expect(container.querySelector(".comms-card")).toBeNull();
  });
});

describe("Team Comms preview panel", () => {
  it("lists the outputs, starts on the chosen headphones, moves device on the fly, says who is soloed", async () => {
    const calls: string[] = [];
    let st: PreviewStatus = { state: "off", error: null, deviceId: "", sinkSupported: true, chunks: 0, underruns: 0, dropped: 0, levelDb: -100 };
    const fake = {
      status: () => st,
      onChange: () => () => undefined,
      start: async (id: string) => {
        calls.push(`start ${id}`);
        st = { ...st, state: "playing", deviceId: id, chunks: 5 };
      },
      stop: () => {
        calls.push("stop");
        st = { ...st, state: "off" };
      },
      setDevice: async (id: string) => void calls.push(`device ${id}`),
      setVolume: (v: number) => void calls.push(`volume ${v}`),
    } as unknown as CommsPreviewPlayer;
    const makePlayer = () => fake;
    const listDevices = async () => [
      { deviceId: "hp", label: "Headphones (USB)" },
      { deviceId: "spk", label: "Speakers" },
    ];
    wrap(<PreviewPanel people={[person(1, "A", { preview: true }), person(2, "A")]} makePlayer={makePlayer} listDevices={listDevices} />);
    expect(await screen.findByRole("option", { name: "Headphones (USB)" })).toBeTruthy();
    expect(screen.getByText("Alpha 1")).toBeTruthy();
    expect(screen.getByText(/never goes to OBS, the broadcast or the recording/)).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Headphones (output device)" }), { target: { value: "hp" } });
    fireEvent.click(screen.getByRole("button", { name: "Listen in headphones" }));
    await waitFor(() => expect(calls).toContain("start hp"));
    expect(await screen.findByRole("button", { name: "Stop listening" })).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Headphones (output device)" }), { target: { value: "spk" } });
    expect(calls).toContain("device spk");
    fireEvent.click(screen.getByRole("button", { name: "Stop listening" }));
    expect(calls).toContain("stop");
  });
});
