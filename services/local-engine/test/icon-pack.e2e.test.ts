import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HudState } from "@matchframe/hud-sdk";
import { Engine } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { IconPackStatus } from "../src/hud/icon-pack.ts";
import { startServers } from "../src/servers.ts";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createNetServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

/** Small test icons written here; never Valve's. */
const svg = (w: number) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 4"><path d="M0 0h${w}v4H0z" fill="#fff"/></svg>`;

/**
 * The icon pack end to end: a ZIP import through the API, the icons served by the overlay server as
 * images only, `state.art.iconPack` for the HUDs, Get CS2 icons from a stand-in collection (listing,
 * downloads with progress, a broken icon refused), an unreachable collection, and removal.
 */
describe("icon pack through the engine", () => {
  let e: Engine;
  let servers: Awaited<ReturnType<typeof startServers>>;
  let ports: { gsi: number; api: number; overlay: number };
  let stand: Server;
  let standPort = 0;
  let listings = 0;

  const api = async <T>(method: string, path: string, body?: unknown, raw?: Uint8Array): Promise<{ status: number; json: T }> => {
    const r = await fetch(`http://127.0.0.1:${ports.api}${path}`, { method, headers: { authorization: `Bearer ${e.secrets.operatorToken}`, "content-type": raw ? "application/zip" : "application/json" }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const text = await r.text();
    return { status: r.status, json: (text ? JSON.parse(text) : null) as T };
  };
  const art = () => (e.hudState("hud:matchframe-default") as HudState).art.iconPack ?? null;

  beforeAll(async () => {
    // A stand-in for the public icon collection: a listing of the equipment folder and a few SVGs.
    stand = createServer((req, res) => {
      const u = req.url ?? "";
      if (u === "/list") {
        listings++;
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify([{ name: "ak47.svg", type: "file" }, { name: "awp.svg", type: "file" }, { name: "bad.svg", type: "file" }, { name: "README.md", type: "file" }]));
      }
      const files: Record<string, string> = { "/icons/equipment/ak47.svg": svg(30), "/icons/equipment/awp.svg": svg(40), "/icons/equipment/bad.svg": "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", "/icons/ui/kill.svg": svg(8) };
      if (files[u]) {
        res.writeHead(200, { "content-type": "image/svg+xml" });
        return res.end(files[u]);
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => stand.listen(0, "127.0.0.1", r));
    standPort = (stand.address() as { port: number }).port;
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    ports = { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
    e = new Engine(loadConfig({ dataDir: mkdtempSync(join(tmpdir(), "mf-iconpack-")), gsiPort: ports.gsi, apiPort: ports.api, overlayPort: ports.overlay, host: "127.0.0.1", captainUiDir: null, hudRendererDir: null, mapPackDir: null, workersDir: null, pythonPath: null, sampleHudsDirs: [], cloudEnforcement: "off", iconPackSource: { rawBase: `http://127.0.0.1:${standPort}/icons`, listUrl: `http://127.0.0.1:${standPort}/list` } }));
    await e.init();
    servers = await startServers(e);
  });

  afterAll(async () => {
    await servers?.close();
    await e?.shutdown();
    await new Promise((r) => stand.close(r));
  });

  it("imports a ZIP, serves the icons as images only, and tells the HUDs", async () => {
    expect(art()).toBeNull();
    const zip = zipSync({ "icons/cs2/panorama/images/icons/equipment/deagle.svg": strToU8(svg(20)), "icons/cs2/panorama/images/icons/ui/elimination.svg": strToU8(svg(6)) });
    const imported = await api<IconPackStatus>("POST", "/api/v1/hud/icon-pack/import", undefined, zip);
    expect(imported.status).toBe(200);
    expect(imported.json).toMatchObject({ count: 2, names: ["deagle", "elimination"], source: "zip" });
    expect(art()).toEqual({ names: ["deagle", "elimination"], base: "/icon-pack/" });
    const res = await fetch(`http://127.0.0.1:${ports.overlay}/icon-pack/deagle.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(await res.text()).toBe(svg(20));
    expect((await fetch(`http://127.0.0.1:${ports.overlay}/icon-pack/..%2Fpack.json`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${ports.overlay}/icon-pack/awp.svg`)).status).toBe(404);
    // A folder that is not there is an error (remote callers are refused folders altogether).
    expect((await api("POST", "/api/v1/hud/icon-pack/import-folder", { path: "/nonexistent-folder" })).status).toBe(400);
  });

  it("gets CS2 icons from the collection with progress, refusing a bad icon", async () => {
    const started = await api<IconPackStatus>("POST", "/api/v1/hud/icon-pack/download");
    expect(started.status).toBe(200);
    expect(started.json.job).toMatchObject({ state: "downloading" });
    let status = started.json;
    for (let i = 0; i < 100 && status.job?.state === "downloading"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      status = (await api<IconPackStatus>("GET", "/api/v1/hud/icon-pack")).json;
    }
    expect(listings).toBe(1);
    expect(status.job).toEqual({ state: "done", count: 3 });
    expect(status).toMatchObject({ names: ["ak47", "awp", "kill"], source: "download" });
    expect(status.refused).toEqual([{ name: "bad", reason: "<script> is not allowed in an icon" }]);
    expect(art()?.names).toEqual(["ak47", "awp", "kill"]);
  });

  it("says to import a ZIP when the collection can't be reached, keeping the pack it had", async () => {
    const dead = await freePort();
    const status = await e.iconPack.download({ rawBase: `http://127.0.0.1:${dead}/icons`, listUrl: `http://127.0.0.1:${dead}/list` }, { timeoutMs: 1000 }).catch((err: Error) => err.message);
    expect(status).toMatch(/use Import ZIP… instead/);
    expect(e.iconPack.status().job).toMatchObject({ state: "error" });
    expect(art()?.names).toEqual(["ak47", "awp", "kill"]);
  });

  it("removes the pack", async () => {
    expect((await api("DELETE", "/api/v1/hud/icon-pack")).status).toBe(200);
    expect(art()).toBeNull();
    expect((await fetch(`http://127.0.0.1:${ports.overlay}/icon-pack/ak47.svg`)).status).toBe(404);
  });
});
