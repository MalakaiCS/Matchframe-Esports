// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CloudSyncStatus } from "../api/types.ts";
import { ToastProvider } from "../components/toasts.tsx";
import { countsText, storageText, syncedAgo } from "../lib/sync.ts";
import { SessionContext } from "../state/session.tsx";
import { SharedPanel } from "./Account.tsx";

function status(over: Partial<CloudSyncStatus> = {}): CloudSyncStatus {
  return {
    enabled: true,
    linked: true,
    orgName: "Night League",
    state: "ok",
    lastPullAt: null,
    lastPushAt: null,
    lastSyncAt: new Date(Date.now() - 4000).toISOString(),
    pending: 0,
    pendingByKind: {},
    counts: { player: 12, team: 4, match: 3, hud: 2, roster: 12 },
    busy: null,
    storage: { usedBytes: 140 * 1024 * 1024, quotaBytes: 2 * 1024 ** 3 },
    orgItems: null,
    rejected: [],
    merged: 0,
    lastError: null,
    ...over,
  };
}

function serve(handler: (method: string, path: string, body: unknown) => { status: number; json: unknown } | undefined) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: url, body });
      const r = handler(method, url, body) ?? { status: 404, json: { error: "not_found", message: `${method} ${url}` } };
      return new Response(JSON.stringify(r.json), { status: r.status, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}

const renderPanel = (role = "owner") =>
  render(
    <ToastProvider>
      <SessionContext.Provider value={{ me: { role } }}>
        <SharedPanel />
      </SessionContext.Provider>
    </ToastProvider>,
  );

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("account sync wording", () => {
  it("says when it last synced, what is shared and how much storage is used", () => {
    const now = Date.parse("2026-10-31T12:00:00.000Z");
    expect(syncedAgo("2026-10-31T11:59:56.000Z", now)).toBe("Synced 4 s ago");
    expect(syncedAgo("2026-10-31T11:57:00.000Z", now)).toBe("Synced 3 min ago");
    expect(syncedAgo(null, now)).toBe("Not synced yet");
    expect(storageText(140 * 1024 * 1024, 2 * 1024 ** 3)).toBe("140 MB of 2 GB");
    expect(countsText({ player: 1, team: 4, match: 0 })).toBe("1 player · 4 teams · 0 matches · 0 HUDs");
  });
});

describe("Shared with <organisation> (Settings → Account)", () => {
  it("shows the switch, last sync, counts, storage and the last problem; Sync now shares", async () => {
    const calls = serve((m, p) => {
      if (m === "GET" && p === "/api/v1/cloud/sync") return { status: 200, json: status({ lastError: "Cannot reach the Matchframe website. Changes made here are kept and shared when it is back.", pending: 2 }) };
      if (m === "POST" && p === "/api/v1/cloud/sync/now") return { status: 200, json: status() };
      return undefined;
    });
    renderPanel();
    expect(await screen.findByText("Shared with Night League")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Share with the organisation" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/^Synced \d+ s ago$/)).toBeTruthy();
    expect(screen.getByText("12 players · 4 teams · 3 matches · 2 HUDs")).toBeTruthy();
    expect(screen.getByText("2 changes waiting to be shared")).toBeTruthy();
    expect(screen.getByText("140 MB of 2 GB")).toBeTruthy();
    expect(screen.getByText(/Cannot reach the Matchframe website/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/cloud/sync/now")).toBe(true));
    await waitFor(() => expect(screen.queryByText(/Cannot reach the Matchframe website/)).toBeNull());
  });

  it("shows what is moving while a HUD uploads", async () => {
    serve((m, p) => (m === "GET" && p === "/api/v1/cloud/sync" ? { status: 200, json: status({ busy: "Uploading HUD Vector", state: "syncing" }) } : undefined));
    renderPanel();
    expect(await screen.findByText("Uploading HUD Vector…")).toBeTruthy();
  });

  it("turns sharing off and on with the switch", async () => {
    let enabled = true;
    const calls = serve((m, p, body) => {
      if (m === "GET" && p === "/api/v1/cloud/sync") return { status: 200, json: status({ enabled, state: enabled ? "ok" : "off" }) };
      if (m === "POST" && p === "/api/v1/cloud/sync") {
        enabled = (body as { enabled: boolean }).enabled;
        return { status: 200, json: status({ enabled, state: enabled ? "ok" : "off" }) };
      }
      return undefined;
    });
    renderPanel();
    const sw = await screen.findByRole("switch", { name: "Share with the organisation" });
    fireEvent.click(sw);
    await waitFor(() => expect(screen.getByText(/Sharing is off on this computer/)).toBeTruthy());
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ enabled: false });
    expect(screen.queryByRole("button", { name: "Sync now" })).toBeNull();
    expect(screen.getByRole("switch", { name: "Share with the organisation" }).getAttribute("aria-checked")).toBe("false");
  });

  it("is hidden while signed out, and read-only for roles that cannot change settings", async () => {
    serve((m, p) => (m === "GET" && p === "/api/v1/cloud/sync" ? { status: 200, json: status({ linked: false, orgName: null }) } : undefined));
    const { container } = renderPanel();
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe("");
    cleanup();

    serve((m, p) => (m === "GET" && p === "/api/v1/cloud/sync" ? { status: 200, json: status() } : undefined));
    renderPanel("viewer");
    const sw = (await screen.findByRole("switch", { name: "Share with the organisation" })) as HTMLButtonElement;
    expect(sw.disabled).toBe(true);
  });
});
