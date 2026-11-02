import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Engine } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { startServers } from "../src/servers.ts";
import { makePng } from "./helpers/images.ts";

/**
 * The owner: "the active match which has the teams isn't showing the logos in game". The labelled
 * simulation's players are on no roster (no SteamID64 saved), as at an event before the players are
 * entered: the HUDs still show the active match's teams, names and logos, and Swap teams flips them.
 */

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

describe("the active match's teams and logos in the HUD without rostered players", () => {
  let engine: Engine;
  let servers: Awaited<ReturnType<typeof startServers>>;
  let port = 0;
  const call = async <T>(method: string, path: string, body?: unknown, raw?: Buffer): Promise<{ status: number; json: T }> => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { authorization: `Bearer ${engine.secrets.operatorToken}`, "content-type": raw ? "image/png" : "application/json" },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : null) as T };
  };

  beforeAll(async () => {
    const p = { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    engine = new Engine(loadConfig({ dataDir: mkdtempSync(join(tmpdir(), "mf-sides-")), gsiPort: p.gsi, apiPort: p.api, overlayPort: p.overlay, host: "127.0.0.1", captainUiDir: null, hudRendererDir: null, mapPackDir: null, workersDir: null, pythonPath: null }));
    await engine.init();
    servers = await startServers(engine);
    port = p.api;
  });

  afterAll(async () => {
    await call("POST", "/api/v1/simulation/stop");
    await servers?.close();
    await engine?.shutdown();
  });

  it("shows both teams' names and logos, says how they were placed, and swaps them", async () => {
    const team = async (name: string, shortName: string, size: number) => {
      const up = await call<{ stagedId: string }>("POST", "/api/v1/uploads/images", undefined, makePng(size, size));
      return (await call<{ id: string; logoAssetId: string }>("POST", "/api/v1/teams", { name, shortName, logoStagedId: up.json.stagedId })).json;
    };
    const lite = await team("LITE Esports", "LITE", 200);
    const nl = await team("Northern Lights", "NL", 220);
    expect(lite.logoAssetId).toBeTruthy();
    const m = await call<{ id: string }>("POST", "/api/v1/matches", { teamAId: lite.id, teamBId: nl.id });
    expect((await call("POST", `/api/v1/matches/${m.json.id}/activate`)).status).toBeLessThan(300);
    await call("POST", "/api/v1/simulation/start", { startOffsetSec: 30 });
    let hud = engine.hudState("hud:matchframe-default");
    for (let i = 0; i < 40 && !hud?.left.players.length; i++) {
      await new Promise((r) => setTimeout(r, 100));
      hud = engine.hudState("hud:matchframe-default");
    }
    expect(hud?.left.players.length).toBeGreaterThan(0);
    // Without any rostered player: Team 1 on CT, both logos shown.
    const placed = (h: typeof hud) => ({ [h!.left.side!]: h!.left.teamId, [h!.right.side!]: h!.right.teamId });
    expect(placed(hud)).toEqual({ CT: lite.id, T: nl.id });
    const logos = [hud!.left, hud!.right].map((t) => [t.name, t.logoUrl]);
    expect(logos).toContainEqual(["LITE Esports", `/assets/${lite.logoAssetId}`]);
    expect(logos).toContainEqual(["Northern Lights", `/assets/${nl.logoAssetId}`]);
    const status = await call<{ ctName: string; tName: string; how: string; canSwap: boolean }>("GET", "/api/v1/live/side-teams");
    expect(status.json).toMatchObject({ ctName: "LITE Esports", tName: "Northern Lights", how: "assumed", canSwap: true });
    // Swap teams: Northern Lights on CT.
    const swapped = await call<{ ctName: string; how: string }>("POST", "/api/v1/live/side-teams/swap");
    expect(swapped.json).toMatchObject({ ctName: "Northern Lights", how: "swapped" });
    expect(placed(engine.hudState("hud:matchframe-default"))).toEqual({ CT: nl.id, T: lite.id });

    // "A team has these players": save the in-game players to the teams on screen. Previewed first.
    const preview = await call<{ applied: boolean; create: { team: string }[]; move: unknown[]; already: number }>("POST", "/api/v1/live/side-teams/save-players", { apply: false });
    expect(preview.json.applied).toBe(false);
    expect(preview.json.create.length).toBeGreaterThanOrEqual(8);
    expect(new Set(preview.json.create.map((c) => c.team))).toEqual(new Set(["LITE Esports", "Northern Lights"]));
    expect((await call<unknown[]>("GET", "/api/v1/players")).json).toHaveLength(0);
    const saved = await call<{ applied: boolean; create: unknown[]; already: number }>("POST", "/api/v1/live/side-teams/save-players", { apply: true });
    expect(saved.json.applied).toBe(true);
    expect((await call<unknown[]>("GET", "/api/v1/players")).json).toHaveLength(saved.json.create.length);
    // The game data now places the teams by their players (the swap is no longer needed and is cleared).
    let how = "";
    for (let i = 0; i < 50 && how !== "roster"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      engine.hudState("hud:matchframe-default");
      how = (await call<{ how: string }>("GET", "/api/v1/live/side-teams")).json.how;
    }
    expect(how).toBe("roster");
    expect(placed(engine.hudState("hud:matchframe-default"))).toEqual({ CT: nl.id, T: lite.id });
    // Saving again changes nothing.
    const again = await call<{ create: unknown[]; move: unknown[]; already: number }>("POST", "/api/v1/live/side-teams/save-players", { apply: true });
    expect(again.json.create.length + again.json.move.length).toBe(0);

    // Swap teams from the Stream Deck / hotkey action works on recognised teams too.
    const action = await call<{ ctName: string; how: string }>("POST", "/api/v1/devices/actions/teams_swap", {});
    expect(action.status).toBe(200);
    expect(placed(engine.hudState("hud:matchframe-default"))).toEqual({ CT: lite.id, T: nl.id });
  });
});
