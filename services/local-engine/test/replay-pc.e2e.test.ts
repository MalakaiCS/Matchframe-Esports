import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SyntheticPlayer } from "../../../packages/cs2-state/src/testing/gsi-builder.ts";
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

const waitFor = async (fn: () => boolean | Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

interface Pc {
  e: Engine;
  servers: Awaited<ReturnType<typeof startServers>>;
  ports: { gsi: number; api: number; overlay: number };
  api: (path: string, init?: { method?: string; body?: unknown }) => Promise<{ status: number; json: Record<string, unknown> }>;
  ts: number;
}

async function pc(name: string): Promise<Pc> {
  const ports = { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
  const e = new Engine(loadConfig({ dataDir: mkdtempSync(join(tmpdir(), `mf-${name}-`)), gsiPort: ports.gsi, apiPort: ports.api, overlayPort: ports.overlay, host: "127.0.0.1", captainUiDir: null, hudRendererDir: null, mapPackDir: null, workersDir: null, pythonPath: null, sampleHudsDirs: [], cloudEnforcement: "off" }));
  await e.init();
  const servers = await startServers(e);
  const token = e.secrets.operatorToken;
  return {
    e,
    servers,
    ports,
    ts: 1_700_000_000,
    api: async (path, init = {}) => {
      const res = await fetch(`http://127.0.0.1:${ports.api}${path}`, { method: init.method ?? "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    },
  };
}

const roster = syntheticRoster();
const [T1, , , T4] = roster.filter((p) => p.side === "T");
const CT9 = roster.find((p) => p.side === "CT" && p.slot === 9)!;

async function feed(p: Pc, observed: string, players: SyntheticPlayer[], roundPhase: "live" | "over" | "freezetime" = "live", extra: { round?: number; roundWins?: Record<string, string> } = {}) {
  const payload = buildSyntheticGsiPayload({ mapName: "de_dust2", round: extra.round ?? 7, players, observed, roundPhase, phase: roundPhase, phaseEndsIn: roundPhase === "live" ? 60 : 15, token: p.e.secrets.gsiToken, timestamp: p.ts++, ...(extra.roundWins ? { roundWins: extra.roundWins } : {}) });
  const r = await fetch(`http://127.0.0.1:${p.ports.gsi}/gsi`, { method: "POST", body: JSON.stringify(payload) });
  expect(r.status).toBe(200);
}

describe("Replay PC: catches the kills the main camera misses, the main PC replays them", () => {
  let main: Pc;
  let replay: Pc;
  const clipFile = join(mkdtempSync(join(tmpdir(), "mf-clip-")), "Replay 2026-10-28.mkv");
  const programScenes: string[] = [];
  /** The stand-in OBS media source: a clip plays for 500 ms from when it is loaded; its cursor follows seeks. */
  let loadedAt = 0;
  let seek = { to: 0, at: 0 };

  beforeAll(async () => {
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    main = await pc("main");
    replay = await pc("replay");
    writeFileSync(clipFile, Buffer.alloc(64 * 1024, 7));
    // Stand-in OBS on both computers (the real-OBS run is replay-pc-obs.integration.test.ts).
    Object.assign(replay.e.obs.state, { connected: true, replayBuffer: true });
    replay.e.obs.saveReplayBuffer = async () => ({ savedPath: clipFile });
    Object.assign(main.e.obs.state, { connected: true });
    main.e.obs.setProgram = async (scene: string) => {
      programScenes.push(scene);
      return { confirmed: true, programScene: scene };
    };
    main.e.obs.setMediaFile = async () => {
      loadedAt = Date.now();
      seek = { to: 0, at: loadedAt };
    };
    main.e.obs.mediaAction = async () => undefined;
    main.e.obs.setMediaCursor = async (_input: string, ms: number) => {
      seek = { to: ms, at: Date.now() };
    };
    main.e.obs.mediaStatus = async () => ({ state: Date.now() - loadedAt < 500 ? "OBS_MEDIA_STATE_PLAYING" : "OBS_MEDIA_STATE_ENDED", durationMs: 20000, cursorMs: seek.to + Date.now() - seek.at });
  });

  afterAll(async () => {
    for (const p of [replay, main]) {
      await p?.servers.close();
      await p?.e.shutdown();
    }
  });

  it("links the replay PC to the main PC with a replay code", async () => {
    const code = (await main.api("/api/v1/tokens", { method: "POST", body: { role: "replay", label: "Replay PC" } })).json as { token: string };
    const r = await replay.api("/api/v1/replay-pc", { method: "PUT", body: { enabled: true, mainUrl: `127.0.0.1:${main.ports.api}`, token: code.token, postRollMs: 500 } });
    expect(r.status).toBe(200);
    expect((r.json.settings as { mainUrl: string }).mainUrl).toBe(`http://127.0.0.1:${main.ports.api}`);
    await feed(main, T1!.steamId, roster);
    await feed(replay, T4!.steamId, roster);
    await waitFor(async () => ((await replay.api("/api/v1/replay-pc")).json.status as { mainObserved: string | null }).mainObserved === T1!.steamId);
    const st = (await replay.api("/api/v1/replay-pc")).json.status as { state: string; main: { computer: string } };
    expect(st.state).toBe("connected");
    // The replay PC's director prefers anyone but the main PC's player.
    expect(replay.e.session.director.controls.avoid?.steamIds).toEqual([T1!.steamId]);
  });

  it("refuses a wrong code", async () => {
    const res = await fetch(`http://127.0.0.1:${main.ports.api}/api/v1/replay-link/on-air`, { headers: { authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
  });

  it("sends a kill the main camera missed, labelled, with how much of the clip to show", async () => {
    // T4 kills CT9 on the replay PC's camera; the main PC shows T1.
    const after = roster.map((p) => (p.steamId === T4!.steamId ? { ...p, kills: 1, roundKills: 1 } : p.steamId === CT9.steamId ? { ...p, health: 0, deaths: 1 } : p));
    await feed(main, T1!.steamId, after);
    await feed(replay, T4!.steamId, after);
    await waitFor(async () => ((await main.api("/api/v1/replays")).json.items as unknown[]).length > 0);
    const item = ((await main.api("/api/v1/replays")).json.items as { label: string; state: string; origin: string; priority: number; playMs: number; roundNumber: number; play: { kind: string; kills: number } }[])[0]!;
    expect(item).toMatchObject({ state: "prepared", origin: "replay_pc", roundNumber: main.e.session.state()!.roundNumber, play: { kind: "missed", kills: 1 } });
    expect(item.label).toBe(`${T4!.name} ▸ ${CT9.name} (AK47)`);
    expect(item.playMs).toBe(5500);
    expect(((await replay.api("/api/v1/replay-pc")).json.status as { sent: number }).sent).toBe(1);
  });

  it("does not send a kill the main camera showed", async () => {
    const ct6 = roster.find((p) => p.side === "CT" && p.slot === 6)!;
    const before = ((await main.api("/api/v1/replays")).json.items as unknown[]).length;
    const prev = roster.map((p) => (p.steamId === T4!.steamId ? { ...p, kills: 1, roundKills: 1 } : p.steamId === CT9.steamId ? { ...p, health: 0, deaths: 1 } : p));
    // Both cameras on T1, who kills CT6.
    await feed(main, T1!.steamId, prev);
    await feed(replay, T1!.steamId, prev);
    const after = prev.map((p) => (p.steamId === T1!.steamId ? { ...p, kills: 1, roundKills: 1 } : p.steamId === ct6.steamId ? { ...p, health: 0, deaths: 1 } : p));
    await feed(main, T1!.steamId, after);
    await feed(replay, T1!.steamId, after);
    await new Promise((r) => setTimeout(r, 900));
    expect(((await main.api("/api/v1/replays")).json.items as unknown[]).length).toBe(before);
  });

  it("plays the clip after the round, on the replay scene, then goes back live", async () => {
    await main.api("/api/v1/settings/program.scenes", { method: "PUT", body: { value: { LIVE: "Game", REPLAY: "Replay", STUDIO: null, BREAK: null } } });
    await main.api("/api/v1/settings/replay.mediaInput", { method: "PUT", body: { value: "Replay Clip" } });
    const auto = await main.api("/api/v1/replays/auto", { method: "PUT", body: { enabled: true, startDelayMs: 0 } });
    expect(auto.json.settings).toMatchObject({ enabled: true, startDelayMs: 0, perBreak: 4 });
    // Still live: nothing plays.
    await new Promise((r) => setTimeout(r, 400));
    expect(programScenes).toEqual([]);
    // The round ends.
    await feed(main, T1!.steamId, roster, "over");
    await waitFor(() => programScenes.includes("Replay"));
    await waitFor(() => programScenes[programScenes.length - 1] === "Game");
    expect(main.e.program.mode).toBe("LIVE");
    const items = (await main.api("/api/v1/replays")).json.items as { origin: string; state: string }[];
    expect(items.find((i) => i.origin === "replay_pc")?.state).toBe("played");
    const status = (await main.api("/api/v1/replays/auto")).json.status as { lastPlayed: { label: string } };
    expect(status.lastPlayed.label).toContain(T4!.name);
  });

  it("replays a won 1v2 clutch the main camera showed, before anything else", async () => {
    // The main PC's own replay buffer (stand-in).
    Object.assign(main.e.obs.state, { replayBuffer: true });
    main.e.obs.saveReplayBuffer = async () => ({ savedPath: clipFile });
    const before = programScenes.length;
    const dead = (p: SyntheticPlayer) => ({ ...p, health: 0, deaths: 1 });
    const cts = roster.filter((p) => p.side === "CT");
    // Round 9: T1 alone against two CTs, on the main camera.
    const clutch = roster.map((p) => (p.side === "T" && p.steamId !== T1!.steamId ? dead(p) : p.side === "CT" && p !== cts[0] && p !== cts[1] ? dead(p) : p));
    await feed(main, T1!.steamId, clutch, "live", { round: 8 });
    await new Promise((r) => setTimeout(r, 500));
    const won = clutch.map((p) => (p === cts[0] || p === cts[1] ? dead(p) : p.steamId === T1!.steamId ? { ...p, kills: 2, roundKills: 2 } : p));
    await feed(main, T1!.steamId, won, "live", { round: 8 });
    await new Promise((r) => setTimeout(r, 300));
    await feed(main, T1!.steamId, won, "over", { round: 8, roundWins: { "9": "t_win_elimination" } });
    await waitFor(async () => ((await main.api("/api/v1/replays")).json.items as { label: string }[]).some((i) => i.label === `Clutch 1v2: ${T1!.name}`));
    await waitFor(() => programScenes.slice(before).includes("Replay"));
    await waitFor(() => programScenes[programScenes.length - 1] === "Game");
    const clip = ((await main.api("/api/v1/replays")).json.items as { label: string; state: string; priority: number; origin: string }[]).find((i) => i.label === `Clutch 1v2: ${T1!.name}`)!;
    expect(clip).toMatchObject({ state: "played", priority: 4, origin: "main" });
  });
});
