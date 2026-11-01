import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSyntheticGsiPayload, syntheticRoster } from "../../../packages/cs2-state/src/testing/gsi-builder.ts";
import type { SyntheticPayloadSpec, SyntheticPlayer } from "../../../packages/cs2-state/src/testing/gsi-builder.ts";
import { Engine } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { KillfeedBuilder } from "../src/live/killfeed.ts";
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
 * The owner: the kill feed "doesn't always pop up for some kills". The round-winning kill comes in
 * the same game update as the round's end, where CS2's round counter moves on (a new round attempt):
 * the feed was cleared by that very update, just after the kill went in. It now stays up through the
 * end of the round and clears when the next round starts.
 */
describe("Kill feed at the end of a round", () => {
  let e: Engine;
  let servers: Awaited<ReturnType<typeof startServers>>;
  let gsiPort: number;
  let ts = 1_700_000_000;
  const roster = syntheticRoster();
  const ct = roster.filter((p) => p.side === "CT");
  const t = roster.filter((p) => p.side === "T");

  const send = async (spec: Partial<SyntheticPayloadSpec>, players: SyntheticPlayer[]) => {
    const payload = buildSyntheticGsiPayload({ mapName: "de_mirage", players, observed: players[0]!.steamId, phaseEndsIn: 40, token: e.secrets.gsiToken, timestamp: ts++, ctName: "Northern Lights", tName: "Red Harbour", ...spec });
    expect((await fetch(`http://127.0.0.1:${gsiPort}/gsi`, { method: "POST", body: JSON.stringify(payload) })).status).toBe(200);
  };
  // What the HUDs get as the kill feed.
  const feedVictims = () => (e as unknown as { killfeed: KillfeedBuilder }).killfeed.list().map((k) => k.victim.name);

  beforeAll(async () => {
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    const ports = { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
    gsiPort = ports.gsi;
    e = new Engine(loadConfig({ dataDir: mkdtempSync(join(tmpdir(), "mf-killfeed-")), gsiPort: ports.gsi, apiPort: ports.api, overlayPort: ports.overlay, host: "127.0.0.1", captainUiDir: null, hudRendererDir: null, mapPackDir: null, workersDir: null, pythonPath: null, sampleHudsDirs: [], cloudEnforcement: "off" }));
    await e.init();
    servers = await startServers(e);
  });

  afterAll(async () => {
    await servers?.close();
    await e?.shutdown();
  });

  it("keeps the round-winning kill, and the round's feed, until the next round starts", async () => {
    // Round 5 live: everyone alive, then a CT kills a T.
    let players: SyntheticPlayer[] = roster.map((p) => ({ ...p }));
    await send({ round: 4, roundPhase: "live", phase: "live" }, players);
    players = players.map((p) => (p.steamId === ct[0]!.steamId ? { ...p, kills: (p.kills ?? 0) + 1, roundKills: 1 } : p.steamId === t[0]!.steamId ? { ...p, health: 0 } : p));
    await send({ round: 4, roundPhase: "live", phase: "live" }, players);
    expect(feedVictims()).toEqual([t[0]!.name]);
    // The last T dies in the update that ends the round: CS2 counts the round as played (map.round 5).
    players = players.map((p) => (p.steamId === ct[1]!.steamId ? { ...p, kills: (p.kills ?? 0) + 1, roundKills: 1 } : t.slice(1).some((x) => x.steamId === p.steamId) ? { ...p, health: 0 } : p));
    await send({ round: 5, roundPhase: "over", phase: "over", winTeam: "CT", roundWins: { "5": "ct_win_elimination" } }, players);
    expect(feedVictims()).toEqual(expect.arrayContaining([t[0]!.name, t[4]!.name]));
    // Still up a moment later in the round's end.
    await send({ round: 5, roundPhase: "over", phase: "over", winTeam: "CT", roundWins: { "5": "ct_win_elimination" } }, players);
    expect(feedVictims()).toContain(t[4]!.name);
    // The next round's freeze time: a clear feed.
    players = roster.map((p) => ({ ...p }));
    await send({ round: 5, roundPhase: "freezetime", phase: "freezetime" }, players);
    expect(feedVictims()).toEqual([]);
  });
});
