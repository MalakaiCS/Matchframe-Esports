// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { OperatorSnapshot } from "../api/types.ts";
import { liveStore } from "../state/live.ts";
import { isSyncedPath, useApi } from "./hooks.ts";

function List({ path }: { path: string }) {
  const s = useApi<{ n: number }>(path);
  return <span data-testid="n">{s.data?.n ?? "-"}</span>;
}

const snapshot = (dataVersion: number) => ({ dataVersion }) as unknown as OperatorSnapshot;

beforeEach(() => liveStore.reset());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("lists account sync changes", () => {
  it("reload when another computer's changes arrive (the engine's dataVersion), and only then", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ n: ++n }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    act(() => liveStore.set({ snapshot: snapshot(5) }));
    render(<List path="/api/v1/teams" />);
    await waitFor(() => expect(screen.getByTestId("n").textContent).toBe("1"));
    // A snapshot with the same version (sent every second) does not reload.
    act(() => liveStore.set({ snapshot: snapshot(5) }));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    act(() => liveStore.set({ snapshot: snapshot(6) }));
    await waitFor(() => expect(screen.getByTestId("n").textContent).toBe("2"));
  });

  it("covers teams, players, events, matches, veto, stages and the HUD Library, not other screens", () => {
    for (const p of ["/api/v1/teams?archived=1", "/api/v1/players", "/api/v1/events", "/api/v1/matches/m1", "/api/v1/veto/m1", "/api/v1/stages", "/api/v1/hud/library"]) expect(isSyncedPath(p)).toBe(true);
    for (const p of ["/api/v1/sponsors", "/api/v1/cloud/status", "/api/v1/settings/live.activeMatchId"]) expect(isSyncedPath(p)).toBe(false);
  });
});
