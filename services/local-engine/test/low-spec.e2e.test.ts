import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { HudLibrary, LowSpecStatus } from "@matchframe/contracts";
import { Engine } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { startServers } from "../src/servers.ts";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

/** Collects JSON messages from a WebSocket; `next(pred)` resolves with the first matching one received from now on. */
function socket(url: string) {
  const ws = new WebSocket(url);
  const messages: Record<string, unknown>[] = [];
  const waiters: { pred: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void }[] = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw)) as Record<string, unknown>;
    messages.push(m);
    for (const w of [...waiters]) {
      if (!w.pred(m)) continue;
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(m);
    }
  });
  return {
    ws,
    messages,
    opened: new Promise<void>((resolve, reject) => (ws.once("open", () => resolve()), ws.once("error", reject))),
    next(pred: (m: Record<string, unknown>) => boolean, ms = 4000, from = 0): Promise<Record<string, unknown>> {
      const hit = messages.slice(from).find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timed out waiting for a message")), ms);
        waiters.push({ pred, resolve: (m) => (clearTimeout(t), resolve(m)) });
      });
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Low-spec mode through the engine's servers", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mf-lowspec-"));
  const samples = mkdtempSync(join(tmpdir(), "mf-lowspec-samples-"));
  const pkg = join(samples, "sample");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "manifest.json"), JSON.stringify({ manifestVersion: 1, id: "test.lowspec", name: "Low-spec test HUD", version: "1.0.0", author: "Tests", licence: "MIT", game: "cs2", schemaVersions: [1], entryPoints: { live: "index.html" }, permissions: ["match.public"] }));
  writeFileSync(join(pkg, "index.html"), "<!doctype html><html><body>HUD</body></html>");
  let engine: Engine;
  let servers: Awaited<ReturnType<typeof startServers>>;
  let api: (path: string, init?: RequestInit) => Promise<Response>;
  let overlay: string;
  const sockets: WebSocket[] = [];
  const json = async <T>(r: Response | Promise<Response>): Promise<T> => (await (await r).json()) as T;
  const open = (url: string) => {
    const s = socket(url);
    sockets.push(s.ws);
    return s;
  };

  beforeAll(async () => {
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    const ports = { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
    engine = new Engine(loadConfig({ dataDir, gsiPort: ports.gsi, apiPort: ports.api, overlayPort: ports.overlay, host: "127.0.0.1", captainUiDir: null, hudRendererDir: null, mapPackDir: null, workersDir: null, pythonPath: null, sampleHudsDirs: [samples] }));
    await engine.init();
    servers = await startServers(engine);
    overlay = `127.0.0.1:${ports.overlay}`;
    const token = engine.secrets.operatorToken;
    api = (path, init = {}) => fetch(`http://127.0.0.1:${ports.api}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  });

  afterAll(async () => {
    for (const ws of sockets) ws.terminate();
    await servers?.close();
    await engine?.shutdown();
  });

  it("turns on and off from Settings: the HUD state flag, the output pages' frame cap, the status and the audit", async () => {
    expect(await json<LowSpecStatus>(api("/api/v1/performance"))).toMatchObject({ lowSpec: false, frameCap: null, suggestion: null, deferring: false, engine: { heapCapMb: null }, obs: { connected: false, sources: [] } });
    const hud = (await json<HudLibrary>(api("/api/v1/hud/library"))).huds.find((h) => h.id === "test.lowspec")!;
    const t = new URL(hud.urls.live!).searchParams.get("t");
    const control = open(`ws://${overlay}/hud-runtime-ws?hud=test.lowspec&variant=live&mode=obs&t=${t}`);
    const state = open(`ws://${overlay}/overlay-ws?output=hud:test.lowspec&variant=live&t=${t}`);
    const isControl = (m: Record<string, unknown>) => m.type === "control";
    const isState = (m: Record<string, unknown>) => m.topic === "hud.snapshot";
    expect((await control.next(isControl)).frameCap).toBeNull();
    expect((await state.next(isState)).payload).toMatchObject({ lowSpec: false });

    let from = control.messages.length;
    let fromState = state.messages.length;
    const on = await json<LowSpecStatus>(api("/api/v1/performance", { method: "PUT", body: JSON.stringify({ lowSpec: true }) }));
    expect(on).toMatchObject({ lowSpec: true, frameCap: 30 });
    expect((await control.next((m) => isControl(m) && m.frameCap === 30, 4000, from)).frameCap).toBe(30);
    expect((await state.next((m) => isState(m) && (m.payload as { lowSpec?: boolean }).lowSpec === true, 4000, fromState)).payload).toMatchObject({ lowSpec: true });
    const audit = await json<{ action: string }[]>(api("/api/v1/audit?limit=20"));
    expect(audit.map((a) => a.action)).toContain("performance.low_spec.on");

    from = control.messages.length;
    fromState = state.messages.length;
    await api("/api/v1/performance", { method: "PUT", body: JSON.stringify({ lowSpec: false }) });
    expect((await control.next((m) => isControl(m) && m.frameCap === null, 4000, from)).frameCap).toBeNull();
    expect((await state.next((m) => isState(m) && (m.payload as { lowSpec?: boolean }).lowSpec === false, 4000, fromState)).payload).toMatchObject({ lowSpec: false });
  });

  it("frame reports under the cap keep their cap, and 30 fps under a 30 fps cap is not stuttering", async () => {
    await api("/api/v1/performance", { method: "PUT", body: JSON.stringify({ lowSpec: true }) });
    const hud = (await json<HudLibrary>(api("/api/v1/hud/library"))).huds.find((h) => h.id === "test.lowspec")!;
    const t = new URL(hud.urls.live!).searchParams.get("t");
    const page = open(`ws://${overlay}/hud-runtime-ws?hud=test.lowspec&variant=live&mode=desktop&t=${t}`);
    await page.next((m) => m.type === "control" && m.frameCap === 30);
    page.ws.send(JSON.stringify({ type: "perf", fps: 30, worstMs: 41, pauses: 0, lagMs: 2, frameCap: 30 }));
    await sleep(150);
    const lib = await json<HudLibrary>(api("/api/v1/hud/library"));
    expect(lib.huds.find((h) => h.id === "test.lowspec")!.smoothness.desktop).toEqual({ fps: 30, worstPauseMs: 41, pauses: 0, frameCap: 30 });
    // A stutter while low-spec mode is on is no reason to suggest it.
    expect((await json<LowSpecStatus>(api("/api/v1/performance"))).suggestion).toBeNull();
    await api("/api/v1/performance", { method: "PUT", body: JSON.stringify({ lowSpec: false }) });
  });

  it("skips HUD pushes that change nothing while on (the state is sent again at least every 5 s)", async () => {
    const hud = (await json<HudLibrary>(api("/api/v1/hud/library"))).huds.find((h) => h.id === "test.lowspec")!;
    const t = new URL(hud.urls.live!).searchParams.get("t");
    const state = open(`ws://${overlay}/overlay-ws?output=hud:test.lowspec&variant=live&t=${t}`);
    await state.opened;
    // Off: no game data, and the engine still pushes the same state every 500 ms.
    await sleep(300);
    let n = state.messages.length;
    await sleep(1600);
    expect(state.messages.length - n).toBeGreaterThanOrEqual(2);
    await api("/api/v1/performance", { method: "PUT", body: JSON.stringify({ lowSpec: true }) });
    await sleep(400);
    n = state.messages.length;
    await sleep(1600);
    expect(state.messages.length - n).toBe(0);
    // Something HUDs show changes: it goes out at once.
    await api("/api/v1/hud/library/test.lowspec/settings", { method: "PUT", body: JSON.stringify({ settings: { accent: "#00ff88" } }) });
    const changed = await state.next((m) => m.topic === "hud.snapshot" && (m.payload as { settings: Record<string, unknown> }).settings.accent === "#00ff88", 4000, n);
    expect(changed.payload).toMatchObject({ lowSpec: true, dataAgeMs: null });
    await api("/api/v1/performance", { method: "PUT", body: JSON.stringify({ lowSpec: false }) });
  });

  it("once low-spec mode has been used, the suggestion never comes back (dismissing it changes nothing)", async () => {
    const st = await json<LowSpecStatus>(api("/api/v1/performance/suggestion/dismiss", { method: "POST" }));
    expect(st.suggestion).toBeNull();
    expect(engine.settings.get<{ state: string } | null>("performance.lowSpecSuggestion", null)?.state).toBe("accepted");
  });
});
