// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { OwnershipState } from "@matchframe/contracts";
import type { OperatorSnapshot } from "../api/types.ts";
import { liveStore } from "../state/live.ts";
import { SessionContext } from "../state/session.tsx";
import { ToastProvider } from "./toasts.tsx";
import { TopBar } from "./TopBar.tsx";

const own: OwnershipState = { owner: "operator", generation: 2, holder: "local-operator", acquiredAtMonotonicMs: 0, leaseExpiresAtMonotonicMs: null, manualSticky: true, emergencyStopped: false };

function snapshot(over: Partial<OperatorSnapshot> = {}): OperatorSnapshot {
  return {
    state: null,
    director: null,
    opportunities: [],
    candidates: [],
    mode: "advisory",
    observerMode: "off",
    controls: { hold: null, pin: null, oneSide: null, cinematicsDisabled: { round: null, map: null, match: false }, autoReplaysDisabled: false, assistedActions: ["pov_cut"], followActionRequested: false, cinematicRequested: false },
    ownership: own,
    resumeInMs: null,
    pending: null,
    currentShot: null,
    capabilities: {} as OperatorSnapshot["capabilities"],
    program: { mode: "LIVE", owner: { kind: "operator", holder: "local-operator" }, activeReplay: null },
    obs: { connected: false, programScene: null, previewScene: null, studioMode: null, replayBuffer: null, recording: null, streaming: null, lastError: null },
    simulated: false,
    metrics: {},
    ...over,
  };
}

function renderBar(role = "owner") {
  return render(
    <ToastProvider>
      <SessionContext.Provider value={{ me: { role } }}>
        <TopBar onToggleNav={() => undefined} />
      </SessionContext.Provider>
    </ToastProvider>,
  );
}

beforeEach(() => liveStore.reset());
afterEach(cleanup);

describe("top bar ownership banner", () => {
  it("shows sticky MANUAL with Resume automation", () => {
    act(() => liveStore.set({ status: "open", snapshot: snapshot(), snapshotAt: Date.now() }));
    renderBar();
    expect(screen.getByText("MANUAL")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume automation" })).toBeTruthy();
    expect(screen.queryByText("SIMULATION")).toBeNull();
  });

  it("keeps Resume automation unavailable while the Observer is Off", () => {
    act(() => liveStore.set({ status: "open", snapshot: snapshot({ observerMode: "off" }), snapshotAt: Date.now() }));
    renderBar();
    expect((screen.getByRole("button", { name: "Resume automation" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    act(() => liveStore.set({ status: "open", snapshot: snapshot({ observerMode: "observer_cinematics" }), snapshotAt: Date.now() }));
    renderBar();
    expect((screen.getByRole("button", { name: "Resume automation" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows the resume countdown with Cancel", () => {
    act(() => liveStore.set({ status: "open", snapshot: snapshot({ resumeInMs: 1800 }), snapshotAt: Date.now() }));
    renderBar();
    expect(screen.getByText("RESUMING IN 1.8 s")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resume automation" })).toBeNull();
  });

  it("shows EMERGENCY STOP with Clear stop and never offers resume", () => {
    act(() => liveStore.set({ status: "open", snapshot: snapshot({ ownership: { ...own, emergencyStopped: true } }), snapshotAt: Date.now() }));
    renderBar();
    expect(screen.getByText("EMERGENCY STOP")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear stop" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resume automation" })).toBeNull();
  });

  it("shows AUTOMATION with Take over and the SIMULATION badge when simulated", () => {
    act(() => liveStore.set({ status: "open", snapshot: snapshot({ simulated: true, ownership: { ...own, owner: "director", manualSticky: false } }), snapshotAt: Date.now() }));
    renderBar();
    expect(screen.getByText("AUTOMATION")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Take over" })).toBeTruthy();
    expect(screen.getByText("SIMULATION")).toBeTruthy();
  });

  it("explains a disabled STOP AUTOMATION for roles without camera control", () => {
    act(() => liveStore.set({ status: "open", snapshot: snapshot(), snapshotAt: Date.now() }));
    renderBar("viewer");
    const stop = screen.getByRole("button", { name: /STOP AUTOMATION/ }) as HTMLButtonElement;
    expect(stop.disabled).toBe(true);
    expect(stop.title).toBe("Your role (viewer) lacks camera.control");
  });

  it("reports an offline console link", () => {
    act(() => liveStore.set({ status: "reconnecting", info: { attempt: 2, nextRetryInMs: 2000, lastError: "closed (1006)" } }));
    renderBar();
    expect(screen.getByText("RETRY IN 2 s")).toBeTruthy();
    expect(screen.getByText("NO DATA")).toBeTruthy();
  });
});
