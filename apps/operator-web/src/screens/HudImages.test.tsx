// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { HudLibrary } from "@matchframe/contracts";
import { ToastProvider } from "../components/toasts.tsx";
import { liveStore } from "../state/live.ts";
import { SessionContext } from "../state/session.tsx";
import type { HudArtResponse, HudArtSetting } from "./HudImages.tsx";
import { HudImagesScreen } from "./HudImages.tsx";
import { HudLibraryScreen } from "./HudLibrary.tsx";

const ID = (n: number, ext = "png") => `${String(n).repeat(24).slice(0, 24)}.${ext}`;
const MAPS = [
  { mapName: "de_dust2", displayName: "Dust II" },
  { mapName: "de_mirage", displayName: "Mirage" },
];
const empty = (): HudArtSetting => ({ defaultPlayers: { ct: [], t: [] }, maps: {}, icons: { dead: null } });

type Handler = (method: string, path: string, init: RequestInit) => { status: number; json: unknown } | undefined;

function serve(handler: Handler) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      calls.push({ method, path: url, body: typeof init.body === "string" ? JSON.parse(init.body) : init.body });
      const r = handler(method, url, init) ?? { status: 404, json: { error: "not_found", message: `${method} ${url}` } };
      return new Response(JSON.stringify(r.json), { status: r.status, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}

/** An engine that keeps the setting: GET returns it, PUT replaces it, uploads get the next id. */
function engine(start: HudArtSetting = empty()) {
  let art = start;
  let next = 7;
  const calls = serve((m, p, init) => {
    if (m === "GET" && p === "/api/v1/hud/art") return { status: 200, json: { art, maps: MAPS } satisfies HudArtResponse };
    if (m === "PUT" && p === "/api/v1/hud/art") {
      art = JSON.parse(String(init.body)) as HudArtSetting;
      return { status: 200, json: { art, maps: MAPS } };
    }
    if (m === "POST" && p.startsWith("/api/v1/assets?name=")) return { status: 200, json: { assetId: ID(next++), url: "" } };
    return undefined;
  });
  return { calls, art: () => art };
}

function renderScreen(role = "owner", ui = <HudImagesScreen />) {
  return render(
    <ToastProvider>
      <SessionContext.Provider value={{ me: { role } }}>{ui}</SessionContext.Provider>
    </ToastProvider>,
  );
}

function picture(name: string) {
  const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: "image/png" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer });
  return file;
}

const slot = (label: string) => document.querySelector(`[data-slot="${label}"]`) as HTMLElement;

beforeEach(() => {
  liveStore.reset();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("HUD images screen", () => {
  it("shows the note, five slots per side, the dead-player icon and each map's logo and picture", async () => {
    engine({ defaultPlayers: { ct: [ID(1)], t: [] }, maps: { de_mirage: { logo: ID(2), image: null } }, icons: { dead: null } });
    renderScreen();
    expect(await screen.findByText("Every Matchframe HUD uses these when a player, map or mark has no picture of its own. Add only images you have the right to use.")).toBeTruthy();
    const ct = screen.getByRole("region", { name: "CT player pictures" });
    expect(ct.querySelectorAll(".hudimg-slot")).toHaveLength(5);
    expect(screen.getByRole("region", { name: "T player pictures" }).querySelectorAll(".hudimg-slot")).toHaveLength(5);
    expect((within(slot("CT player 1")).getByRole("img") as HTMLImageElement).getAttribute("src")).toBe(`/assets/${ID(1)}`);
    expect(within(slot("CT player 1")).getByRole("button", { name: "Replace" })).toBeTruthy();
    // The next free slot takes the next picture; later ones wait for it.
    expect((within(slot("CT player 2")).getByRole("button", { name: "Upload" }) as HTMLButtonElement).disabled).toBe(false);
    const third = within(slot("CT player 3")).getByRole("button", { name: "Upload" }) as HTMLButtonElement;
    expect(third.disabled).toBe(true);
    expect(third.title).toBe("Add CT player 2's picture first");
    expect(screen.getByLabelText("Upload Dead player icon")).toBeTruthy();
    expect(screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual(expect.arrayContaining(["Dust II", "Mirage"]));
    expect((within(slot("Mirage logo")).getByRole("img") as HTMLImageElement).getAttribute("src")).toBe(`/assets/${ID(2)}`);
    expect(within(slot("Mirage picture")).queryByRole("img")).toBeNull();
  });

  it("uploads a picture into a slot and saves it straight away (order kept)", async () => {
    const e = engine({ defaultPlayers: { ct: [ID(1)], t: [] }, maps: {}, icons: { dead: null } });
    renderScreen();
    await screen.findByRole("region", { name: "CT player pictures" });
    fireEvent.change(screen.getByLabelText("Upload CT player 2"), { target: { files: [picture("second.png")] } });
    await waitFor(() => expect(e.art().defaultPlayers.ct).toEqual([ID(1), ID(7)]));
    expect(e.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /api/v1/hud/art", "POST /api/v1/assets?name=second.png", "PUT /api/v1/hud/art"]);
    expect(await within(slot("CT player 2")).findByRole("img")).toBeTruthy();
    // Replacing the first keeps it first.
    fireEvent.change(screen.getByLabelText("Upload CT player 1"), { target: { files: [picture("first.png")] } });
    await waitFor(() => expect(e.art().defaultPlayers.ct).toEqual([ID(8), ID(7)]));
    // A map picture and the dead-player icon.
    fireEvent.change(screen.getByLabelText("Upload Dust II picture"), { target: { files: [picture("dust2.jpg")] } });
    await waitFor(() => expect(e.art().maps).toEqual({ de_dust2: { logo: null, image: ID(9) } }));
    fireEvent.change(screen.getByLabelText("Upload Dead player icon"), { target: { files: [picture("skull.svg")] } });
    await waitFor(() => expect(e.art().icons.dead).toBe(ID(10)));
  });

  it("removes a picture (the next ones move up) and refuses files that are not pictures", async () => {
    const e = engine({ defaultPlayers: { ct: [], t: [ID(1), ID(2), ID(3)] }, maps: { de_mirage: { logo: ID(4), image: ID(5) } }, icons: { dead: ID(6) } });
    renderScreen();
    await screen.findByRole("region", { name: "T player pictures" });
    fireEvent.click(screen.getByRole("button", { name: "Remove T player 2" }));
    await waitFor(() => expect(e.art().defaultPlayers.t).toEqual([ID(1), ID(3)]));
    fireEvent.click(screen.getByRole("button", { name: "Remove Mirage logo" }));
    await waitFor(() => expect(e.art().maps.de_mirage).toEqual({ logo: null, image: ID(5) }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Dead player icon" }));
    await waitFor(() => expect(e.art().icons.dead).toBeNull());
    const before = e.calls.length;
    fireEvent.change(screen.getByLabelText("Upload T player 3"), { target: { files: [new File(["x"], "clip.mp4", { type: "video/mp4" })] } });
    expect(await screen.findByText("clip.mp4 is not a picture")).toBeTruthy();
    expect(e.calls.length).toBe(before);
  });

  it("shows why a viewer cannot change them", async () => {
    engine();
    renderScreen("viewer");
    await screen.findByRole("region", { name: "CT player pictures" });
    const up = within(slot("CT player 1")).getByRole("button", { name: "Upload" }) as HTMLButtonElement;
    expect(up.disabled).toBe(true);
    expect(up.title).toBe("Your role (viewer) lacks hud.publish");
  });

  it("is opened from the HUD Library's toolbar", async () => {
    serve((m, p) => (m === "GET" && p === "/api/v1/hud/library" ? { status: 200, json: { huds: [], hudsDir: "/data/huds", overlayOrigin: "http://127.0.0.1:37212", hiddenAll: false } satisfies HudLibrary } : undefined));
    renderScreen("owner", <HudLibraryScreen />);
    const link = await screen.findByRole("link", { name: /HUD images/ });
    expect(link.getAttribute("href")).toBe("/hud/images");
  });
});
