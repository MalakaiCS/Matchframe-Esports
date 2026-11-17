// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { LowSpecStatus } from "../api/types.ts";
import { liveStore } from "../state/live.ts";
import { mount, serve } from "../screens/testkit.tsx";
import { PerformancePanel } from "./LowSpec.tsx";

const status = (over: Partial<LowSpecStatus> = {}): LowSpecStatus => ({
  lowSpec: false,
  frameCap: null,
  suggestion: null,
  cs2OnThisComputer: true,
  deferring: false,
  engine: { heapLimitMb: 4144, heapCapMb: null, heapUsedMb: 88, rssMb: 240 },
  obs: { connected: true, sources: [], error: null },
  ...over,
});

beforeEach(() => liveStore.reset());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as { matchframe?: unknown }).matchframe;
});

describe("Settings → General → Performance", () => {
  it("is off by default; turning it on saves the setting and shows what it did", async () => {
    let current = status();
    const calls = serve({
      "GET /api/v1/performance": () => current,
      "PUT /api/v1/performance": (body: unknown) => {
        current = status({ lowSpec: (body as { lowSpec: boolean }).lowSpec, frameCap: 30, obs: { connected: true, sources: ["MatchFrame HUD"], error: null } });
        return current;
      },
    });
    mount(<PerformancePanel />);
    const panel = await screen.findByTestId("performance-panel");
    const box = within(panel).getByRole("checkbox", { name: /Low-spec mode \(one PC\)/ }) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    expect(box.checked).toBe(false);
    expect(within(panel).getByText(/88 MB in use \(no cap\)/)).toBeTruthy();
    fireEvent.click(box);
    await waitFor(() => expect(box.checked).toBe(true));
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ lowSpec: true });
    expect(within(panel).getByText("30 fps on MatchFrame HUD")).toBeTruthy();
    // Started before it was on: the memory cap comes with the engine's next start (and, in the program, a restart button).
    expect(within(panel).getByText(/Set by the MatchFrame program when it starts the engine/)).toBeTruthy();
  });

  it("offers a restart for the memory cap in the program, and shows the cap once applied", async () => {
    const restartEngine = vi.fn(async () => true);
    (window as { matchframe?: unknown }).matchframe = { connectionMode: "local", restartEngine };
    serve({ "GET /api/v1/performance": status({ lowSpec: true, frameCap: 30 }) });
    mount(<PerformancePanel />);
    const panel = await screen.findByTestId("performance-panel");
    await within(panel).findByText(/The cap applies from the engine's next start/);
    fireEvent.click(within(panel).getByRole("button", { name: "Restart engine now" }));
    fireEvent.click(await screen.findByRole("button", { name: "Restart engine" }));
    await waitFor(() => expect(restartEngine).toHaveBeenCalled());
    cleanup();
    serve({ "GET /api/v1/performance": status({ lowSpec: true, frameCap: 30, engine: { heapLimitMb: 1072, heapCapMb: 1024, heapUsedMb: 90, rssMb: 230 }, deferring: true }) });
    mount(<PerformancePanel />);
    const after = await screen.findByTestId("performance-panel");
    expect(await within(after).findByText(/Capped at 1024 MB \(90 MB in use\)/)).toBeTruthy();
    expect(within(after).getByText("Waiting for the live round to end")).toBeTruthy();
    expect(within(after).queryByRole("button", { name: "Restart engine now" })).toBeNull();
  });
});
