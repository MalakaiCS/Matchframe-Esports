import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SyntheticPlayer } from "../../../packages/cs2-state/src/testing/gsi-builder.ts";
import { buildSyntheticGsiPayload, syntheticRoster } from "../../../packages/cs2-state/src/testing/gsi-builder.ts";
import { Engine } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { startServers } from "../src/servers.ts";

/**
 * Real integration: the main PC and the replay PC (two engines) against a running OBS
 * (obs-websocket v5) with a replay buffer configured. Both use the same OBS here. Opt-in: set
 * MF_OBS_URL and MF_OBS_PASSWORD.
 */
const url = process.env.MF_OBS_URL;
const password = process.env.MF_OBS_PASSWORD;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

const waitFor = async (fn: () => boolean | Promise<boolean>, ms = 15000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
};

describe.skipIf(!url || !password)("Replay PC → main PC automatic replay against real OBS", () => {
  const pcs: { e: Engine; servers: Awaited<ReturnType<typeof startServers>>; ports: { gsi: number; api: number }; ts: number }[] = [];
  const roster = syntheticRoster();
  const [T1, , , T4] = roster.filter((p) => p.side === "T");
  const CT9 = roster.find((p) => p.side === "CT" && p.slot === 9)!;
  const api = async (i: number, path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const res = await fetch(`http://127.0.0.1:${pcs[i]!.ports.api}${path}`, { method, headers: { authorization: `Bearer ${pcs[i]!.e.secrets.operatorToken}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const feed = async (i: number, observed: string, players: SyntheticPlayer[], roundPhase: "live" | "over" = "live") => {
    const p = pcs[i]!;
    const payload = buildSyntheticGsiPayload({ mapName: "de_dust2", round: 7, players, observed, roundPhase, phase: roundPhase, phaseEndsIn: roundPhase === "live" ? 60 : 7, token: p.e.secrets.gsiToken, timestamp: p.ts++ });
    await fetch(`http://127.0.0.1:${p.ports.gsi}/gsi`, { method: "POST", body: JSON.stringify(payload) });
  };

  beforeAll(async () => {
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    for (const name of ["main", "replay"]) {
      const ports = { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
      const e = new Engine(loadConfig({ dataDir: mkdtempSync(join(tmpdir(), `mf-rpobs-${name}-`)), gsiPort: ports.gsi, apiPort: ports.api, overlayPort: ports.overlay, host: "127.0.0.1", captainUiDir: null, hudRendererDir: null, mapPackDir: null, workersDir: null, pythonPath: null, sampleHudsDirs: [], cloudEnforcement: "off" }));
      await e.init();
      pcs.push({ e, servers: await startServers(e), ports, ts: 1_700_000_000 });
    }
  });

  afterAll(async () => {
    await pcs[1]?.e.obs.setOutput("replay", false).catch(() => undefined);
    for (const p of [...pcs].reverse()) {
      await p.servers.close();
      await p.e.shutdown();
    }
  });

  it("saves the missed kill on the replay PC, and the main PC plays it on its replay scene after the round", async () => {
    for (const i of [0, 1]) expect((await api(i, "/api/v1/obs/connect", { url, password, remember: false })).status).toBe(200);
    // Main PC: a live scene, then the one-click replay scene.
    await pcs[0]!.e.obs.ensureInput({ sceneName: "MF Live", inputName: "MF Live Colour", inputKind: "color_source_v3", settings: { color: 4278255360 } });
    await pcs[0]!.e.obs.setProgram("MF Live");
    await pcs[0]!.e.obs.refresh();
    const setup = await api(0, "/api/v1/replays/obs-setup", {});
    expect(setup.status, JSON.stringify(setup.json)).toBe(200);
    expect(setup.json).toMatchObject({ scene: "Matchframe Replay", input: "Matchframe Replay Clip", scenes: { LIVE: "MF Live", REPLAY: "Matchframe Replay" } });
    expect((await api(0, "/api/v1/replays/auto", { enabled: true, startDelayMs: 0, ownBigPlays: false }, "PUT")).status).toBe(200);

    // Replay PC: linked with a replay code; it starts OBS's replay buffer itself.
    const code = (await api(0, "/api/v1/tokens", { role: "replay", label: "Replay PC" })).json as { token: string };
    expect((await api(1, "/api/v1/replay-pc", { enabled: true, mainUrl: `127.0.0.1:${pcs[0]!.ports.api}`, token: code.token, postRollMs: 1000 }, "PUT")).status).toBe(200);
    await feed(0, T1!.steamId, roster);
    await feed(1, T4!.steamId, roster);
    await waitFor(async () => ((await api(1, "/api/v1/replay-pc")).json.status as { obsReady: boolean; state: string }).obsReady);
    // Let the buffer record a few seconds.
    await new Promise((r) => setTimeout(r, 4000));

    const after = roster.map((p) => (p.steamId === T4!.steamId ? { ...p, kills: 1, roundKills: 1 } : p.steamId === CT9.steamId ? { ...p, health: 0, deaths: 1 } : p));
    await feed(0, T1!.steamId, after);
    await feed(1, T4!.steamId, after);
    await waitFor(async () => ((await api(0, "/api/v1/replays")).json.items as { origin: string }[]).some((i) => i.origin === "replay_pc"), 20000);
    const item = ((await api(0, "/api/v1/replays")).json.items as { id: string; origin: string; clip: { media: { path: string; durationMs: number | null } } }[]).find((i) => i.origin === "replay_pc")!;
    expect(item.clip.media.durationMs).toBeGreaterThan(2000);

    // Round over: the main PC cuts to the replay scene, OBS plays the clip, then back to the live scene.
    await feed(0, T1!.steamId, after, "over");
    await waitFor(() => pcs[0]!.e.program.mode === "REPLAY_PLAYING");
    expect((await pcs[0]!.e.obs.refresh()).programScene).toBe("Matchframe Replay");
    const media = await pcs[0]!.e.obs.mediaStatus("Matchframe Replay Clip");
    expect(["OBS_MEDIA_STATE_PLAYING", "OBS_MEDIA_STATE_ENDED"]).toContain(media.state);
    await waitFor(() => pcs[0]!.e.program.mode === "LIVE", 20000);
    expect((await pcs[0]!.e.obs.refresh()).programScene).toBe("MF Live");
    expect(((await api(0, "/api/v1/replays")).json.items as { id: string; state: string }[]).find((i) => i.id === item.id)?.state).toBe("played");
  });
});
