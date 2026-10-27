// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { HudLibrary, HudLibraryEntry } from "@matchframe/contracts";
import type { DesktopHudBridge, OverlayState } from "../api/desktop.ts";
import { ToastProvider } from "../components/toasts.tsx";
import { liveStore } from "../state/live.ts";
import { SessionContext } from "../state/session.tsx";
import { HudLibraryScreen } from "./HudLibrary.tsx";

const ORIGIN = "http://127.0.0.1:37212";

function hud(over: Partial<HudLibraryEntry> & Pick<HudLibraryEntry, "id" | "name">): HudLibraryEntry {
  return {
    version: "1.0.0",
    author: "Matchframe Esports",
    licence: "MIT",
    description: "A HUD",
    category: null,
    tags: [],
    game: "cs2",
    kind: "imported",
    thumbnailUrl: null,
    variants: ["live"],
    designResolution: { width: 1920, height: 1080 },
    folder: `/data/huds/${over.id}/1.0.0`,
    installedAt: "2026-10-20T10:00:00.000Z",
    lastUsedAt: null,
    previousVersion: null,
    status: "ready",
    error: null,
    stopped: false,
    outputs: { obs: 0, desktop: 0, preview: 0 },
    urls: { live: `${ORIGIN}/hud/${over.id}/live?t=tok` },
    settings: {},
    settingsSchema: {},
    presets: [],
    presetId: null,
    ...over,
  };
}

function library(huds: HudLibraryEntry[], over: Partial<HudLibrary> = {}): HudLibrary {
  return { huds, hudsDir: "/data/huds", overlayOrigin: ORIGIN, hiddenAll: false, ...over };
}

type Handler = (method: string, path: string, init: RequestInit) => { status: number; json: unknown } | undefined;

function serve(handler: Handler) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      calls.push({ method, path: url, body: init.body });
      const r = handler(method, url, init) ?? { status: 404, json: { error: "not_found", message: `${method} ${url}` } };
      return new Response(JSON.stringify(r.json), { status: r.status, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}

function renderScreen(role = "owner") {
  return render(
    <ToastProvider>
      <SessionContext.Provider value={{ me: { role } }}>
        <HudLibraryScreen />
      </SessionContext.Provider>
    </ToastProvider>,
  );
}

const SAMPLE = hud({ id: "matchframe.sample-cs2", name: "Matchframe Sample CS2 HUD", kind: "sample", category: "Sample", tags: ["scorebug"], author: "Matchframe Esports" });
const PRO = hud({ id: "matchframe.pro-cs2", name: "Pro CS2 HUD", kind: "sample", category: "Broadcast", author: "Lexogrine (adapted)", outputs: { obs: 1, desktop: 0, preview: 0 }, status: "running" });
const BUILTIN = hud({ id: "matchframe-default", name: "Matchframe Broadcast HUD", kind: "builtin", folder: null, category: "Broadcast" });

beforeEach(() => {
  liveStore.reset();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as { matchframe?: unknown }).matchframe;
});

describe("HUD Library screen", () => {
  it("lists the installed HUDs with status, outputs and actions", async () => {
    serve((m, p) => (m === "GET" && p === "/api/v1/hud/library" ? { status: 200, json: library([SAMPLE, PRO, BUILTIN]) } : undefined));
    renderScreen();
    const card = await screen.findByRole("article", { name: "Pro CS2 HUD" });
    expect(within(card).getByText("Running")).toBeTruthy();
    expect(card.querySelector('[data-output="obs"]')?.className).toContain("is-on");
    expect(card.querySelector('[data-output="desktop"]')?.className).not.toContain("is-on");
    expect(screen.getAllByRole("article").map((a) => a.getAttribute("aria-label"))).toEqual(["Matchframe Broadcast HUD", "Matchframe Sample CS2 HUD", "Pro CS2 HUD"]);
    // In a browser (no program bridge) the desktop window cannot be launched; the reason is given.
    const launch = within(card).getByRole("button", { name: /Launch Transparent HUD/ }) as HTMLButtonElement;
    expect(launch.disabled).toBe(true);
    expect(launch.title).toMatch(/need the Matchframe program/);
    expect(screen.getByText("3 HUDs on this computer")).toBeTruthy();
  });

  it("searches by name, author or tag and filters by category and status", async () => {
    serve((m, p) => (m === "GET" && p === "/api/v1/hud/library" ? { status: 200, json: library([SAMPLE, PRO, BUILTIN]) } : undefined));
    renderScreen();
    await screen.findByRole("article", { name: "Pro CS2 HUD" });
    fireEvent.change(screen.getByPlaceholderText("Search by name, author or tag"), { target: { value: "lexogrine" } });
    expect(screen.getAllByRole("article").map((a) => a.getAttribute("aria-label"))).toEqual(["Pro CS2 HUD"]);
    fireEvent.change(screen.getByPlaceholderText("Search by name, author or tag"), { target: { value: "scorebug" } });
    expect(screen.getAllByRole("article").map((a) => a.getAttribute("aria-label"))).toEqual(["Matchframe Sample CS2 HUD"]);
    fireEvent.change(screen.getByPlaceholderText("Search by name, author or tag"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "Broadcast" } });
    expect(screen.getAllByRole("article")).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "running" } });
    expect(screen.getAllByRole("article").map((a) => a.getAttribute("aria-label"))).toEqual(["Pro CS2 HUD"]);
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "error" } });
    expect(screen.getByText("No HUDs match")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getAllByRole("article")).toHaveLength(3);
  });

  it("switches between grid and list", async () => {
    serve((m, p) => (m === "GET" && p === "/api/v1/hud/library" ? { status: 200, json: library([SAMPLE, PRO]) } : undefined));
    renderScreen();
    await screen.findByRole("article", { name: "Pro CS2 HUD" });
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(screen.queryAllByRole("article")).toHaveLength(0);
    expect(screen.getByRole("table", { name: "HUDs" })).toBeTruthy();
    expect(document.querySelectorAll(".hud-row[data-hud]")).toHaveLength(2);
  });

  it("imports a ZIP and asks what to do when the HUD id is already installed", async () => {
    let installed = [SAMPLE];
    const calls = serve((m, p) => {
      if (m === "GET" && p === "/api/v1/hud/library") return { status: 200, json: library(installed) };
      if (m === "POST" && p === "/api/v1/hud/library/import?onConflict=fail") return { status: 409, json: { error: "duplicate_id", message: "already installed", detail: { id: SAMPLE.id, installedVersion: "1.0.0", incomingVersion: "1.1.0", builtin: false } } };
      if (m === "POST" && p === "/api/v1/hud/library/import?onConflict=replace") {
        installed = [{ ...SAMPLE, version: "1.1.0", previousVersion: "1.0.0" }];
        return { status: 200, json: installed[0] };
      }
      return undefined;
    });
    renderScreen();
    await screen.findByRole("article", { name: SAMPLE.name });
    const input = screen.getByLabelText("HUD package ZIP") as HTMLInputElement;
    const file = new File([new Uint8Array([0x50, 0x4b, 3, 4])], "sample-1.1.0.zip", { type: "application/zip" });
    Object.defineProperty(file, "arrayBuffer", { value: async () => new Uint8Array([0x50, 0x4b, 3, 4]).buffer });
    fireEvent.change(input, { target: { files: [file] } });
    const dialog = await screen.findByRole("dialog", { name: "This HUD is already installed" });
    expect(within(dialog).getByText(/sample-1.1.0.zip/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Update to 1.1.0" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.filter((c) => c.path.startsWith("/api/v1/hud/library/import")).map((c) => c.path)).toEqual(["/api/v1/hud/library/import?onConflict=fail", "/api/v1/hud/library/import?onConflict=replace"]);
    expect(await screen.findByText(/updated to 1.1.0/)).toBeTruthy();
    expect(await screen.findByTestId("hud-details")).toBeTruthy();
  });

  it("opens the details panel with package info, variants and the settings form", async () => {
    const withSettings = { ...SAMPLE, settingsSchema: { accentColor: { type: "color" as const, label: "Accent colour", default: "#2f7cf6" }, showMoney: { type: "boolean" as const, label: "Show money", default: true } }, settings: { accentColor: "#2f7cf6", showMoney: true } };
    const calls = serve((m, p) => {
      if (m === "GET" && p === "/api/v1/hud/library") return { status: 200, json: library([withSettings]) };
      if (m === "PUT" && p === `/api/v1/hud/library/${SAMPLE.id}/settings`) return { status: 200, json: withSettings };
      return undefined;
    });
    renderScreen();
    fireEvent.click(await screen.findByRole("article", { name: SAMPLE.name }));
    const details = await screen.findByTestId("hud-details");
    expect(within(details).getByText(SAMPLE.id)).toBeTruthy();
    expect(within(details).getByTitle(`${SAMPLE.name} preview`).getAttribute("src")).toContain("mode=preview&embed=1&checker=1");
    fireEvent.click(within(details).getByRole("tab", { name: "Appearance" }));
    fireEvent.click(within(details).getByLabelText(/Show money/));
    fireEvent.click(within(details).getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.method === "PUT")!.body))).toEqual({ settings: { accentColor: "#2f7cf6", showMoney: false } });
    fireEvent.click(within(details).getByRole("tab", { name: "Outputs" }));
    expect(within(details).getByText(`${ORIGIN}/hud/${SAMPLE.id}/live?t=tok`)).toBeTruthy();
    expect(within(details).getByText("1920")).toBeTruthy();
  });

  it("launches the transparent desktop HUD through the program bridge", async () => {
    const launched: string[] = [];
    let listener: ((o: OverlayState[]) => void) | null = null;
    const bridge: Partial<DesktopHudBridge> = {
      available: true,
      unavailableReason: null,
      overlays: async () => [],
      onOverlays: (fn) => ((listener = fn), () => undefined),
      launch: async (id) => {
        launched.push(id);
        const st: OverlayState = { hudId: id, open: true, visible: true, editing: false, status: "running", error: null, previews: 0, displayId: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scale: 1, locked: false, variant: "live" };
        listener?.([st]);
        return st;
      },
    };
    (window as { matchframe?: unknown }).matchframe = { hud: bridge };
    const calls = serve((m, p) => {
      if (m === "GET" && p === "/api/v1/hud/library") return { status: 200, json: library([SAMPLE]) };
      if (m === "POST" && p === `/api/v1/hud/library/${SAMPLE.id}/start`) return { status: 200, json: SAMPLE };
      return undefined;
    });
    renderScreen();
    const card = await screen.findByRole("article", { name: SAMPLE.name });
    fireEvent.click(within(card).getByRole("button", { name: /Launch Transparent HUD/ }));
    await waitFor(() => expect(launched).toEqual([SAMPLE.id]));
    expect(calls.some((c) => c.method === "POST" && c.path === `/api/v1/hud/library/${SAMPLE.id}/start`)).toBe(true);
    expect(await within(card).findByRole("button", { name: "Close Desktop HUD" })).toBeTruthy();
    expect(card.querySelector('[data-output="desktop"]')?.className).toContain("is-on");
  });

  it("keeps package actions of the built-in HUD unavailable, with reasons", async () => {
    serve((m, p) => (m === "GET" && p === "/api/v1/hud/library" ? { status: 200, json: library([BUILTIN]) } : undefined));
    renderScreen();
    const card = await screen.findByRole("article", { name: BUILTIN.name });
    fireEvent.click(within(card).getByRole("button", { name: /More actions/ }));
    const remove = screen.getByRole("menuitem", { name: /Remove/ }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    expect(remove.title).toMatch(/part of the program/);
  });
});
