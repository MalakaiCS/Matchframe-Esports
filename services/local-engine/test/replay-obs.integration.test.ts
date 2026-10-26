import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Engine } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { startServers } from "../src/servers.ts";

/**
 * Real integration: the engine's replay flow against a running OBS (obs-websocket v5) with a
 * replay buffer configured. Opt-in — set MF_OBS_URL and MF_OBS_PASSWORD.
 */
const url = process.env.MF_OBS_URL;
const password = process.env.MF_OBS_PASSWORD;

describe.skipIf(!url || !password)("engine replay flow against real OBS (A29)", () => {
  let e: Engine;
  let servers: Awaited<ReturnType<typeof startServers>>;
  let api: (path: string, init?: RequestInit) => Promise<Response>;

  beforeAll(async () => {
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    e = new Engine(loadConfig({ dataDir: mkdtempSync(join(tmpdir(), "mf-replay-obs-")), gsiPort: 47510, apiPort: 47511, overlayPort: 47512, operatorUiDir: null, hudRendererDir: null, mapPackDir: null, workersDir: null, pythonPath: null }));
    await e.init();
    servers = await startServers(e);
    api = (path, init = {}) => fetch(`http://127.0.0.1:47511${path}`, { ...init, headers: { authorization: `Bearer ${e.secrets.operatorToken}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  });

  afterAll(async () => {
    await e.obs.setOutput("replay", false).catch(() => undefined);
    await servers?.close();
    await e?.shutdown();
  });

  it("captures from the replay buffer, plays the approved clip in OBS (confirmed by media status) and returns live", async () => {
    expect((await api("/api/v1/obs/connect", { method: "POST", body: JSON.stringify({ url, password, remember: false }) })).status).toBe(200);
    // Scenes for the program state machine; a colour source stands in for the live game capture.
    await e.obs.ensureInput({ sceneName: "MF Test Live", inputName: "MF Test Live Colour", inputKind: "color_source_v3", settings: { color: 4278255360 } });
    await e.obs.ensureInput({ sceneName: "MF Test Replay", inputName: "MF Test Replay Media", inputKind: "ffmpeg_source", settings: { is_local_file: true } });
    await api("/api/v1/settings/program.scenes", { method: "PUT", body: JSON.stringify({ value: { LIVE: "MF Test Live", REPLAY: "MF Test Replay", STUDIO: "MF Test Live", BREAK: "MF Test Live" } }) });
    await api("/api/v1/settings/replay.mediaInput", { method: "PUT", body: JSON.stringify({ value: "MF Test Replay Media" }) });
    await e.obs.setProgram("MF Test Live");
    expect((await api("/api/v1/obs/output", { method: "POST", body: JSON.stringify({ kind: "replay", active: true }) })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 3000));

    const item = (await (await api("/api/v1/replays/bookmarks", { method: "POST", body: JSON.stringify({ label: "Integration bookmark", preRollMs: 2000, postRollMs: 300, capture: true }) })).json()) as { id: string };
    let state = "";
    for (let i = 0; i < 60 && state !== "prepared" && state !== "failed"; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const list = (await (await api("/api/v1/replays")).json()) as { items: { id: string; state: string; clip: { media: { path: string; durationMs: number | null } } | null }[] };
      state = list.items.find((x) => x.id === item.id)?.state ?? "";
    }
    expect(state).toBe("prepared");
    expect((await api(`/api/v1/replays/${item.id}/approve`, { method: "POST" })).status).toBe(200);

    const play = await api(`/api/v1/replays/${item.id}/play`, { method: "POST" });
    const body = (await play.json()) as { media: { state: string; durationMs: number } };
    expect(play.status, JSON.stringify(body)).toBe(200);
    expect(["OBS_MEDIA_STATE_PLAYING", "OBS_MEDIA_STATE_ENDED"]).toContain(body.media.state);
    expect(e.program.mode).toBe("REPLAY_PLAYING");
    await e.obs.refresh();
    expect(e.obs.state.programScene).toBe("MF Test Replay");

    expect((await api("/api/v1/program/return-live", { method: "POST" })).status).toBe(200);
    await e.obs.refresh();
    expect(e.obs.state.programScene).toBe("MF Test Live");
    expect(e.program.mode).toBe("LIVE");
    expect(e.replays.get(item.id)?.state).toBe("played");
  }, 60000);
});
