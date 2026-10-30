// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DemoConfigResponse } from "../api/types.ts";
import { ToastProvider } from "../components/toasts.tsx";
import { SessionContext } from "../state/session.tsx";
import { ConfigPanel } from "./Demos.tsx";

const response = (over: Partial<DemoConfigResponse["config"]> = {}): DemoConfigResponse => ({
  config: {
    datasetRoot: "C:\\mf\\datasets",
    quarantineDir: "C:\\mf\\demo-quarantine",
    ingestRoots: ["C:\\mf\\demo-ingest"],
    watch: true,
    retention: { policy: "quarantine_then_remove", quarantineDays: 7, auditSampleRate: 0.05 },
    concurrency: 1,
    pauseDuringLive: true,
    minFreeBytes: 20e9,
    quotas: {},
    ...over,
  },
  workersAvailable: true,
  paused: false,
});

function serve() {
  const puts: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit = {}) => {
      if (init.method === "PUT") puts.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return puts;
}

const panel = (data: DemoConfigResponse, reload = () => undefined) => (
  <ToastProvider>
    <SessionContext.Provider value={{ me: { role: "owner" } }}>
      <ConfigPanel data={data} reload={reload} />
    </SessionContext.Provider>
  </ToastProvider>
);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Demo library settings", () => {
  it("keeps what is being edited when the settings are fetched again, and saves it", async () => {
    const puts = serve();
    const reload = vi.fn();
    const view = render(panel(response(), reload));
    const roots = screen.getByLabelText(/Ingest roots/) as HTMLTextAreaElement;
    fireEvent.change(roots, { target: { value: "C:\\mf\\demo-ingest\nD:\\Demos" } });
    fireEvent.change(screen.getByLabelText(/Retention policy/), { target: { value: "keep_originals" } });
    // The 10-second refresh: the same saved configuration, as a new object.
    view.rerender(panel(response(), reload));
    expect(roots.value).toBe("C:\\mf\\demo-ingest\nD:\\Demos");
    expect((screen.getByLabelText(/Retention policy/) as HTMLSelectElement).value).toBe("keep_originals");
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toMatchObject({ ingestRoots: ["C:\\mf\\demo-ingest", "D:\\Demos"], retention: { policy: "keep_originals" } });
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it("shows a configuration saved elsewhere when nothing is being edited", () => {
    serve();
    const view = render(panel(response()));
    view.rerender(panel(response({ ingestRoots: ["C:\\mf\\demo-ingest", "E:\\HLTV"] })));
    expect((screen.getByLabelText(/Ingest roots/) as HTMLTextAreaElement).value).toBe("C:\\mf\\demo-ingest\nE:\\HLTV");
  });
});
