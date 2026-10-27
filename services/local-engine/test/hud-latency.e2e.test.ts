import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildSyntheticGsiPayload, syntheticRoster } from "../../../packages/cs2-state/src/testing/gsi-builder.ts";
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

/**
 * How fast a POV switch in CS2 reaches the HUDs: the HUD socket of a Matchframe HUD (two outputs
 * open) and the raw game data that LHM-format HUDs get. Before 0.4.0 the HUD socket pushed at most
 * every 100 ms, so a switch could wait that long.
 */
describe("HUD latency", () => {
  let engine: Engine;
  let servers: Awaited<ReturnType<typeof startServers>>;
  let ports: { gsi: number; api: number; overlay: number };

  beforeAll(async () => {
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    ports = { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
    engine = new Engine(loadConfig({ dataDir: mkdtempSync(join(tmpdir(), "mf-latency-")), gsiPort: ports.gsi, apiPort: ports.api, overlayPort: ports.overlay, host: "127.0.0.1", captainUiDir: null, hudRendererDir: null, mapPackDir: join(import.meta.dirname, "..", "..", "..", "assets", "map-packs"), workersDir: null, pythonPath: null, sampleHudsDirs: [] }));
    await engine.init();
    servers = await startServers(engine);
  });

  afterAll(async () => {
    await servers?.close();
    await engine?.shutdown();
  });

  it("a POV switch reaches the HUD socket and the raw game data within 50 ms, while CS2 sends 20 updates a second", async () => {
    const roster = syntheticRoster();
    roster.forEach((p, i) => (p.position = { x: -1500 + i * 120, y: 300 + i * 40, z: -160 }));
    const sockets = ["main", "clean"].map((o) => new WebSocket(`ws://127.0.0.1:${ports.overlay}/overlay-ws?output=${o}&t=${engine.outputs.token(o)}`));
    await Promise.all(sockets.map((ws) => new Promise((r) => ws.once("open", r))));
    let want = "";
    let sentAt = 0;
    let hudSeen = true;
    let rawSeen = true;
    const hud: number[] = [];
    const raw: number[] = [];
    sockets[0]!.on("message", (d) => {
      const m = JSON.parse(String(d)) as { payload?: { left?: { players: { steamId: string; observed: boolean }[] }; right?: { players: { steamId: string; observed: boolean }[] } } };
      const observed = [...(m.payload?.left?.players ?? []), ...(m.payload?.right?.players ?? [])].find((p) => p.observed);
      if (!hudSeen && observed?.steamId === want) {
        hudSeen = true;
        hud.push(performance.now() - sentAt);
      }
    });
    const off = engine.onRawGsi((p) => {
      if (!rawSeen && (p as { player?: { steamid?: string } }).player?.steamid === want) {
        rawSeen = true;
        raw.push(performance.now() - sentAt);
      }
    });
    let seq = 0;
    let observed = roster[0]!.steamId;
    for (let i = 0; i < 120; i++) {
      if (i % 12 === 6) {
        observed = roster[(i / 12) | 0]!.steamId;
        want = observed;
        sentAt = performance.now();
        hudSeen = rawSeen = false;
      }
      const payload = buildSyntheticGsiPayload({ mapName: "de_mirage", players: roster, observed, roundPhase: "live", phase: "live", phaseEndsIn: 90, token: engine.secrets.gsiToken, timestamp: 1_700_003_000 + seq++ });
      const res = await fetch(`http://127.0.0.1:${ports.gsi}/gsi`, { method: "POST", body: JSON.stringify(payload) });
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 50));
    }
    off();
    for (const ws of sockets) ws.close();
    expect(hud.length).toBe(10);
    expect(raw.length).toBe(10);
    expect(Math.max(...hud)).toBeLessThan(50);
    expect(Math.max(...raw)).toBeLessThan(50);
  }, 30000);
});
