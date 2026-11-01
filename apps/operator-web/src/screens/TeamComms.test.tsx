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
import type { CalibrationStatus, CommsParticipant, CommsView, ListenInView, RecorderStatus, StripStatus } from "./comms/types.ts";

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

const recorder = (patch: Partial<RecorderStatus> = {}): RecorderStatus => ({
  state: "idle",
  label: "NOT RECORDING",
  detail: "Not recording. Start Recording is independent of the public listen-in.",
  team: { id: "team-A", name: "Alpha Wolves", inMatch: true },
  heardTeamId: "team-A",
  startedAt: null,
  elapsedMs: null,
  file: null,
  last: null,
  folder: "D:\\Comms",
  freeBytes: 500 * 1024 ** 3,
  warnings: [],
  errors: [],
  settings: { teamId: "team-A", folder: "D:\\Comms", format: "mkv", encoder: "", bitrateKbps: 16000, audioBitrateKbps: 192, splitMinutes: 0, gameLevelDb: 0, commsLevelDb: 0, warnFreeGB: 20, obs: { scene: "Matchframe Comms Recording", gameSource: "Game Capture", hudSource: "Matchframe HUD", gameAudioSource: "Game audio" } },
  teamspeakSignal: false,
  obs: { connected: true, scene: "Matchframe Comms Recording", sceneExists: true, sourceRecord: { available: true, install: ["Close OBS.", "Download Source Record from the OBS forum."], kind: "source_record_filter" }, filter: { name: "MatchFrame Recorder", recordMode: 0 }, track1: { inUse: true, detail: "OBS is streaming: track 1 is mixed." }, lastSetup: null },
  actions: { start: { disabledReason: null }, stop: { disabledReason: "Not recording" } },
  ...patch,
});

const STRIP_SETTINGS = { anchor: "bottom-center" as const, offsetX: 0, offsetY: 40, cardPx: 132, gapPx: 8, borderPx: 6, activeColor: "#20FF00", idleColor: "#808086", insetColor: "#0D0F12", attackMs: 30, releaseMs: 350, labels: false, useHudDefaults: true, placeholderAssetId: null, crops: {}, timingOffsetMs: 0 };
const stripStatus = (patch: Partial<StripStatus> = {}): StripStatus => ({
  url: "http://127.0.0.1:37212/comms/recording?t=strip-token",
  source: "MatchFrame Speaker Strip",
  pages: 1,
  team: "team-A",
  cards: [
    { id: "c1", name: "Alpha 1", picture: "own", pictureUrl: "/assets/a1.png", crop: { x: 50, y: 30, zoom: 1 }, cropKey: "player:pl-A1" },
    { id: "c2", name: "Alpha 2", picture: "silhouette", pictureUrl: "data:image/svg+xml,x", crop: { x: 50, y: 30, zoom: 1 }, cropKey: "person:c2" },
  ],
  speaking: ["Alpha 2"],
  overLimit: 0,
  warning: null,
  settings: STRIP_SETTINGS,
  ...patch,
});

const calibration = (patch: Partial<CalibrationStatus> = {}): CalibrationStatus => ({ settings: { reactionMs: 200, onsetDb: -40 }, armed: null, live: null, marks: [], suggestion: null, sendLatencyMs: 60, ...patch });

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
  recorder: recorder(),
  strip: stripStatus(),
  calibration: calibration(),
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

describe("the dedicated comms recording", () => {
  const sources = { liveScene: "Game", sources: [{ name: "Game Capture", kind: "game_capture" }, { name: "Matchframe HUD", kind: "browser_source" }, { name: "Game audio", kind: "wasapi_process_output_capture" }, { name: "Casters", kind: "wasapi_input_capture" }], suggested: { gameSource: "Game Capture", hudSource: "Matchframe HUD", gameAudioSource: "Game audio" }, sourceRecord: true, error: null };

  it("its own Start/Stop and state in words with the elapsed time; the team by team id; game and comms levels; the folder", async () => {
    let current = view();
    const calls = serve({
      "GET /api/v1/comms": () => current,
      "GET /api/v1/comms/obs/inputs": { inputs: [], error: null },
      "GET /api/v1/comms/recording/obs/sources": sources,
      "POST /api/v1/comms/recording/start": () => {
        current = view({ recorder: recorder({ state: "recording", label: "RECORDING — ALPHA WOLVES", elapsedMs: 83_000, teamspeakSignal: true, file: { path: "D:\\Comms\\MatchFrame Comms ALP 2026-11-01 10-00-00.mkv", bytes: 52_000_000, growing: true, files: [] }, actions: { start: { disabledReason: "Recording" }, stop: { disabledReason: null } } }) });
        return current.recorder;
      },
      "POST /api/v1/comms/recording/stop": () => (current = view({ recorder: recorder({ last: { path: "D:\\Comms\\x.mkv", bytes: 1, durationMs: 90_000, endedAt: "2026-11-01T10:01:30Z", reason: "stopped by the operator" } }) })).recorder,
      "POST /api/v1/comms/recording/team": (b: unknown) => ({ ...current.recorder, body: b }),
      "PUT /api/v1/comms/recording": (b: unknown) => ({ ...current.recorder, body: b }),
    });
    wrap(<TeamCommsScreen />);
    const banner = await screen.findByRole("status", { name: "Comms recording: NOT RECORDING" });
    expect(within(banner).getByText("○")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start Recording" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/comms/recording/start")).toBe(true));
    const rec = await screen.findByRole("status", { name: "Comms recording: RECORDING — ALPHA WOLVES" });
    // Not colour alone: the word, the shape and the elapsed time.
    expect(within(rec).getByText("Recording")).toBeTruthy();
    expect(within(rec).getByText("●")).toBeTruthy();
    expect(within(rec).getByText(/1:23/)).toBeTruthy();
    expect(screen.getByText("Shows recording on both listener tabs")).toBeTruthy();
    expect(screen.getByText(/MatchFrame Comms ALP 2026-11-01 10-00-00.mkv/)).toBeTruthy();
    // The recording team, by team id.
    fireEvent.change(screen.getByRole("combobox", { name: "Recording team" }), { target: { value: "team-B" } });
    await waitFor(() => expect(calls.find((c) => c.path === "/api/v1/comms/recording/team")?.body).toEqual({ teamId: "team-B" }));
    // Levels.
    fireEvent.change(screen.getByRole("spinbutton", { name: "Game level" }), { target: { value: "-6" } });
    fireEvent.click(screen.getByRole("button", { name: "Set game level" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT" && c.path === "/api/v1/comms/recording")?.body).toEqual({ gameLevelDb: -6 }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Comms level" }), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Set comms level" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT" && c.path === "/api/v1/comms/recording").at(-1)?.body).toEqual({ commsLevelDb: 3 }));
    // Stop asks first.
    fireEvent.click(screen.getByRole("button", { name: "Stop Recording" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Stop Recording" }).length).toBe(2));
    fireEvent.click(screen.getAllByRole("button", { name: "Stop Recording" }).at(-1)!);
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/comms/recording/stop")).toBe(true));
  });

  it("the folder (typed or chosen), Source Record missing with its install steps, and the scene set up in OBS from the live scene's sources", async () => {
    const steps = [{ id: "gameplay", ok: true, title: "Gameplay “Game Capture”", detail: "Shared with the live scene." }, { id: "comms", ok: false, title: "Recording comms “MatchFrame Comms Recording”", detail: "OBS has no NDI source: install DistroAV." }];
    const calls = serve({
      "GET /api/v1/comms": view({ recorder: recorder({ obs: { ...recorder().obs, sourceRecord: { available: false, install: ["Close OBS.", "Download Source Record (by exeldro) from the OBS forum."], kind: "source_record_filter" } }, actions: { start: { disabledReason: "Source Record isn't installed in OBS" }, stop: { disabledReason: "Not recording" } } }) }),
      "GET /api/v1/comms/obs/inputs": { inputs: [], error: null },
      "GET /api/v1/comms/recording/obs/sources": { ...sources, sourceRecord: false },
      "PUT /api/v1/comms/recording": (b: unknown) => ({ ...recorder(), body: b }),
      "POST /api/v1/comms/recording/obs": { scene: "Matchframe Comms Recording", ok: false, steps },
    });
    wrap(<TeamCommsScreen />);
    expect((await screen.findAllByText("Source Record isn't installed in OBS")).length).toBeGreaterThan(0);
    expect(screen.getByText(/Download Source Record \(by exeldro\)/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Start Recording" }) as HTMLButtonElement).disabled).toBe(true);
    const folder = screen.getByRole("textbox", { name: "Destination folder" }) as HTMLInputElement;
    fireEvent.change(folder, { target: { value: "E:\\Recordings" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Save" }).find((b) => b.closest("label, .field")?.textContent?.includes("Destination folder"))!);
    await waitFor(() => expect(calls.find((c) => c.method === "PUT" && c.path === "/api/v1/comms/recording")?.body).toEqual({ folder: "E:\\Recordings" }));
    await waitFor(() => expect((screen.getByRole("combobox", { name: "Gameplay (from the live scene)" }) as HTMLSelectElement).value).toBe("Game Capture"));
    fireEvent.change(screen.getByRole("combobox", { name: "HUD (from the live scene)" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Set up the recording scene in OBS" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/api/v1/comms/recording/obs")?.body).toEqual({ gameSource: "Game Capture", hudSource: null, gameAudioSource: "Game audio" }));
    expect(await screen.findByText(/OBS has no NDI source: install DistroAV/)).toBeTruthy();
    expect(screen.getByText("Fix")).toBeTruthy();
  });

  it("the speaker strip: who is lit now, its settings and each portrait's crop", async () => {
    const calls = serve({
      "GET /api/v1/comms": view(),
      "GET /api/v1/comms/obs/inputs": { inputs: [], error: null },
      "GET /api/v1/comms/recording/obs/sources": sources,
      "PUT /api/v1/comms/strip": (b: unknown) => ({ ...stripStatus(), body: b }),
      "PUT /api/v1/comms/strip/crop": (b: unknown) => ({ ...stripStatus(), body: b }),
    });
    wrap(<TeamCommsScreen />);
    // The preview says who speaks in words (not only by colour).
    expect(await screen.findByRole("img", { name: "Alpha 2: speaking (colour, active frame)" })).toBeTruthy();
    expect(screen.getAllByRole("img", { name: "Alpha 1: silent (grayscale, grey frame)" }).length).toBeGreaterThan(0);
    expect((screen.getByRole("textbox", { name: "Speaker strip address" }) as HTMLInputElement).value).toContain("/comms/recording?t=");
    fireEvent.change(screen.getByRole("combobox", { name: "Anchor" }), { target: { value: "top-right" } });
    await waitFor(() => expect(calls.find((c) => c.path === "/api/v1/comms/strip")?.body).toEqual({ anchor: "top-right" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Names under the portraits/ }));
    await waitFor(() => expect(calls.filter((c) => c.path === "/api/v1/comms/strip").at(-1)?.body).toEqual({ labels: true }));
    const zoom = screen.getByRole("slider", { name: "Alpha 1: Zoom" });
    fireEvent.change(zoom, { target: { value: "1.5" } });
    fireEvent.mouseUp(zoom);
    await waitFor(() => expect(calls.find((c) => c.path === "/api/v1/comms/strip/crop")?.body).toEqual({ key: "player:pl-A1", crop: { x: 50, y: 30, zoom: 1.5 } }));
  });

  it("calibration: arm for a team, Seen once the call was heard, then use the suggested delay", async () => {
    let current = view({ calibration: calibration() });
    const calls = serve({
      "GET /api/v1/comms": () => current,
      "GET /api/v1/comms/obs/inputs": { inputs: [], error: null },
      "GET /api/v1/comms/recording/obs/sources": sources,
      "POST /api/v1/comms/calibration/arm": () => (current = view({ calibration: calibration({ live: { who: "Alpha 4", teamId: "team-B", agoMs: 1200 } }) })).calibration,
      "POST /api/v1/comms/calibration/seen": () => (current = view({ calibration: calibration({ marks: [{ who: "Alpha 4", offsetMs: 90_210, agoMs: 0 }], suggestion: { n: 1, medianOffsetMs: 90_210, spreadMs: 0, delayMs: 89_950, delaySec: 89, fineMs: 950 } }) })).calibration,
      "POST /api/v1/comms/calibration/apply": { delaySec: 89, fineMs: 950 },
    });
    wrap(<TeamCommsScreen />);
    expect(((await screen.findByRole("button", { name: "Seen in gameplay" })) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("combobox", { name: "Calibration team" }), { target: { value: "team-B" } });
    fireEvent.click(screen.getByRole("button", { name: "Arm: listen for the call" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/api/v1/comms/calibration/arm")?.body).toEqual({ teamId: "team-B" }));
    expect(await screen.findByText(/Heard Alpha 4 1.2 s ago/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Seen in gameplay" }));
    expect(await screen.findByText("Suggested delay: 89.950 s")).toBeTruthy();
    expect(screen.getByText(/Take a few more marks/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use this delay" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Use this delay" }).at(-1)!);
    await waitFor(() => expect(calls.some((c) => c.path === "/api/v1/comms/calibration/apply")).toBe(true));
  });

  it("the live room card: the recording's state and its own Start; a viewer can't start it", async () => {
    const calls = serve({ "GET /api/v1/comms": view({ recorder: recorder({ state: "fault", label: "RECORDING FAULT", detail: "The file hasn't grown for 12 s.", elapsedMs: 5000 }) }), "POST /api/v1/comms/recording/start": recorder() });
    wrap(<TeamCommsCard />);
    const b = await screen.findByRole("status", { name: "Comms recording: RECORDING FAULT" });
    expect(within(b).getByText("The file hasn't grown for 12 s.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start Recording" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/v1/comms/recording/start")).toBe(true));
    cleanup();
    serve({ "GET /api/v1/comms": view(), "GET /api/v1/comms/obs/inputs": { inputs: [], error: null } });
    wrap(<TeamCommsCard />, "viewer");
    expect(((await screen.findByRole("button", { name: "Start Recording" })) as HTMLButtonElement).disabled).toBe(true);
  });
});
