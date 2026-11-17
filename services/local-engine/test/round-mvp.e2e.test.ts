import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSyntheticGsiPayload, syntheticRoster } from "../../../packages/cs2-state/src/testing/gsi-builder.ts";
import type { SyntheticPayloadSpec, SyntheticPlayer } from "../../../packages/cs2-state/src/testing/gsi-builder.ts";
import type { HudState } from "@matchframe/hud-sdk";
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
 * The Stage HUD's round MVP card and coach names: the previous round's key player kept from the
 * round's end (CS2 resets round kills and damage at the next freeze time), on the live and a delayed
 * output's own timeline, and each team's roster coach.
 */
describe("round MVP and coaches in the HUD state", () => {
  let e: Engine;
  let servers: Awaited<ReturnType<typeof startServers>>;
  let ports: { gsi: number; api: number; overlay: number };
  let ts = 1_700_000_000;
  const roster = syntheticRoster();
  const ct = roster.filter((p) => p.side === "CT");

  const send = async (spec: Partial<SyntheticPayloadSpec>, players: SyntheticPlayer[]) => {
    const payload = buildSyntheticGsiPayload({ mapName: "de_mirage", players, observed: players[0]!.steamId, phaseEndsIn: 40, token: e.secrets.gsiToken, timestamp: ts++, ...spec });
    expect((await fetch(`http://127.0.0.1:${ports.gsi}/gsi`, { method: "POST", body: JSON.stringify(payload) })).status).toBe(200);
  };
  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await fetch(`http://127.0.0.1:${ports.api}${path}`, { method, headers: { authorization: `Bearer ${e.secrets.operatorToken}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    expect(r.status, `${method} ${path}: ${await r.clone().text()}`).toBeLessThan(300);
    return (await r.json()) as T;
  };

  beforeAll(async () => {
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    ports = { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
    e = new Engine(loadConfig({ dataDir: mkdtempSync(join(tmpdir(), "mf-mvp-")), gsiPort: ports.gsi, apiPort: ports.api, overlayPort: ports.overlay, host: "127.0.0.1", captainUiDir: null, hudRendererDir: null, mapPackDir: null, workersDir: null, pythonPath: null, sampleHudsDirs: [], cloudEnforcement: "off" }));
    await e.init();
    servers = await startServers(e);
  });

  afterAll(async () => {
    await servers?.close();
    await e?.shutdown();
  });

  it("keeps the round's MVP from its end for live and delayed outputs, and names each team's coach", async () => {
    // Two teams, one with a coach on its roster; the active match puts them on the HUD.
    const a = await api<{ id: string }>("POST", "/api/v1/teams", { name: "Northern Lights", shortName: "NRL" });
    const b = await api<{ id: string }>("POST", "/api/v1/teams", { name: "Red Harbour", shortName: "RHB" });
    const coach = await api<{ id: string }>("POST", "/api/v1/players", { displayName: "Meridian" });
    await api("POST", `/api/v1/teams/${a.id}/roster`, { playerId: coach.id, role: "coach" });
    const m = await api<{ id: string }>("POST", "/api/v1/matches", { teamAId: a.id, teamBId: b.id });
    await api("POST", `/api/v1/matches/${m.id}/activate`, {});
    // A delayed output (as for a CSTV-delayed broadcast).
    await api("POST", "/api/v1/hud/outputs", { outputId: "mvp-delayed", name: "Delayed", variant: "live", timelineProfile: "delayed", delayMs: 700 });
    await api("POST", "/api/v1/hud/outputs/mvp-delayed/publish", {});

    // Round 5 live, then its end: a CT gets the MVP star with 3 kills and 300 damage, at 64 HP.
    let players: SyntheticPlayer[] = roster.map((p) => ({ ...p, mvps: 1 }));
    await send({ round: 4, roundPhase: "live", phase: "live" }, players);
    players = players.map((p) => (p.steamId === ct[0]!.steamId ? { ...p, roundKills: 3, roundDamage: 300, kills: 3, health: 64, armor: 40, mvps: 2 } : p.side === "T" ? { ...p, health: 0 } : p));
    await send({ round: 5, roundPhase: "over", phase: "over", winTeam: "CT", roundWins: { "5": "ct_win_elimination" } }, players);
    // The next round's freeze time: CS2 resets round kills and damage.
    await send({ round: 5, roundPhase: "freezetime", phase: "freezetime" }, roster.map((p) => ({ ...p, mvps: p.steamId === ct[0]!.steamId ? 2 : 1 })));

    const live = e.hudState("hud:matchframe-default") as HudState;
    expect(live.lastRound).toEqual({ roundNumber: 5, winnerSide: "CT", mvp: { steamId: ct[0]!.steamId, kills: 3, damage: 300, health: 64, armor: 40, helmet: true } });
    const teamA = live.left.teamId === a.id ? live.left : live.right;
    const teamB = teamA === live.left ? live.right : live.left;
    expect(teamA.coach).toEqual({ name: "Meridian", avatarUrl: null });
    expect(teamB.coach).toBeNull();

    // The delayed output reaches round 5's end only after its delay.
    const delayed = async () => (await api<HudState>("GET", "/api/v1/hud/outputs/mvp-delayed/state")).lastRound ?? null;
    expect(await delayed()).toBeNull();
    await new Promise((r) => setTimeout(r, 900));
    expect((await delayed())?.mvp?.steamId).toBe(ct[0]!.steamId);
  });
});
