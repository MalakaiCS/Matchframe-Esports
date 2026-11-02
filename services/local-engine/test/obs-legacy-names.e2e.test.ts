import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LEGACY_PRODUCT_NAME, PRODUCT_NAME } from "../src/brand.ts";
import { Engine } from "../src/app.ts";
import { LEGACY_RECORDING_SCENE, RECORDING_SCENE } from "../src/comms/recording.ts";
import { RECORDING_NDI_NAME } from "../src/comms/outputs.ts";
import { loadConfig } from "../src/config.ts";
import { GRAPHIC_SOURCE } from "../src/replay/graphic.ts";
import { HIGHLIGHTS_INPUT, HIGHLIGHTS_SCENE } from "../src/replay/highlights-air.ts";
import { PROVISION_SCENE, PROVISION_SOURCE } from "../src/routes/live.ts";
import { REPLAY_INPUT, REPLAY_SCENE } from "../src/routes/replay.ts";
import { startServers } from "../src/servers.ts";
import { StandInObs } from "./stand-in-obs.ts";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

/** How 0.11.0 and earlier spelled the names of what they made in OBS. */
const old = (name: string) => name.replace(PRODUCT_NAME, LEGACY_PRODUCT_NAME);

/**
 * An OBS that 0.11.0 set up keeps working after the update (the product name's spelling changed
 * from "Matchframe" to "MatchFrame"): the replay, highlights, HUD and Team Comms recording scenes and
 * sources it made under the old spelling are found and used, nothing is made a second time, and
 * an OBS without them gets them under the new spelling. A stand-in OBS at the obs-websocket level
 * (stand-in-obs.ts).
 */
describe("OBS scenes and sources made by 0.11.0 (old spelling)", () => {
  let e: Engine | null = null;
  let servers: Awaited<ReturnType<typeof startServers>> | null = null;

  afterEach(async () => {
    await servers?.close();
    await e?.shutdown();
    servers = null;
    e = null;
  });

  const start = async (setup: (o: StandInObs) => void) => {
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    const dir = mkdtempSync(join(tmpdir(), "mf-obs-legacy-"));
    const renderer = join(dir, "renderer");
    mkdirSync(renderer, { recursive: true });
    writeFileSync(join(renderer, "index.html"), "<!doctype html><title>renderer</title>");
    const ports = { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
    const engine = new Engine(loadConfig({ dataDir: join(dir, "data"), gsiPort: ports.gsi, apiPort: ports.api, overlayPort: ports.overlay, host: "127.0.0.1", captainUiDir: null, hudRendererDir: renderer, mapPackDir: null, workersDir: null, pythonPath: null, sampleHudsDirs: [], cloudEnforcement: "off" }));
    e = engine;
    await engine.init();
    servers = await startServers(engine);
    const obs = await StandInObs.attach(engine, (o) => {
      o.addScene("Game");
      o.program = "Game";
      setup(o);
    });
    engine.program.setScenes({ LIVE: "Game" });
    const api = async (path: string, body: unknown = {}) => {
      const r = await fetch(`http://127.0.0.1:${ports.api}${path}`, { method: "POST", headers: { authorization: `Bearer ${engine.secrets.operatorToken}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      const json = (await r.json()) as Record<string, unknown> & { message?: string };
      expect(r.status, json.message).toBe(200);
      return json;
    };
    return { engine, obs, api };
  };

  it("uses the replay, highlights and HUD scenes and sources under the old spelling: nothing made twice, no new-spelling copies", async () => {
    const { engine, obs, api } = await start((o) => {
      o.addScene(old(PROVISION_SCENE));
      o.addInput(old(PROVISION_SCENE), old(PROVISION_SOURCE), "browser_source", { url: "http://127.0.0.1:1/overlay/main/live?t=old", width: 1920, height: 1080 });
      o.addScene(old(REPLAY_SCENE));
      o.addInput(old(REPLAY_SCENE), old(REPLAY_INPUT), "ffmpeg_source", { is_local_file: true });
      o.addInput(old(REPLAY_SCENE), old(GRAPHIC_SOURCE), "browser_source", { url: "http://127.0.0.1:1/old-graphic", width: 1920, height: 1080 });
      o.addScene(old(HIGHLIGHTS_SCENE));
      o.addInput(old(HIGHLIGHTS_SCENE), old(HIGHLIGHTS_INPUT), "ffmpeg_source", { is_local_file: true });
    });
    expect(old(REPLAY_SCENE)).toBe("Matchframe Replay");
    const before = { scenes: [...obs.scenes.keys()], inputs: [...obs.inputs.keys()] };

    // Provision (the HUD's browser source): the old scene and source, pointed at the HUD.
    const hud = await api("/api/v1/obs/provision");
    expect(hud).toMatchObject({ sceneName: "Matchframe Live", sourceName: "Matchframe HUD" });
    expect(String(obs.inputs.get("Matchframe HUD")!.settings.url)).toMatch(/\/overlay\/main\/live\?t=/);
    expect(String(obs.inputs.get("Matchframe HUD")!.settings.url)).not.toContain("t=old");

    // Set up OBS replay scene: the old scene and media source, mapped; its twin next to it.
    const replay = await api("/api/v1/replays/obs-setup");
    expect(replay).toMatchObject({ scene: "Matchframe Replay", input: "Matchframe Replay Clip", created: false });
    expect(engine.program.sceneMap.REPLAY).toBe("Matchframe Replay");
    expect(engine.settings.get("replay.mediaInput", null)).toBe("Matchframe Replay Clip");
    expect(obs.scenes.has("Matchframe Replay B")).toBe(true);

    // The replay graphic's browser source: the old one, now showing the replay graphic page.
    const graphic = await api("/api/v1/replay-graphic/obs");
    expect(graphic).toMatchObject({ scene: "Matchframe Replay", source: "Matchframe Replay Graphic", created: false, onTop: true });
    expect(String(obs.inputs.get("Matchframe Replay Graphic")!.settings.url)).not.toContain("old-graphic");

    // Set up OBS highlights scene: the old scene and media source, the (old) graphic source shared into it.
    const hl = await api("/api/v1/highlights/air/obs-setup");
    expect(hl).toMatchObject({ scene: "Matchframe Highlights", input: "Matchframe Highlights Clip", created: false, graphicError: null });
    expect(obs.scenes.get("Matchframe Highlights")!.map((i) => i.source)).toEqual(["Matchframe Highlights Clip", "Matchframe Replay Graphic"]);
    expect(engine.program.sceneMap.HIGHLIGHTS).toBe("Matchframe Highlights");

    // Nothing under the new spelling was made, and every object 0.11.0 made is still there once.
    const all = [...obs.scenes.keys(), ...obs.inputs.keys()];
    expect(all.filter((n) => n.startsWith(PRODUCT_NAME))).toEqual([]);
    // What was added: the two twins (each scene and its media source, as for a new-spelling OBS).
    expect([...obs.inputs.keys()].sort()).toEqual([...before.inputs, "Matchframe Highlights Clip B", "Matchframe Replay Clip B"].sort());
    expect([...obs.scenes.keys()].sort()).toEqual([...before.scenes, "Matchframe Highlights B", "Matchframe Replay B"].sort());

    // Pressed again: still nothing new.
    await api("/api/v1/replays/obs-setup");
    await api("/api/v1/replay-graphic/obs");
    await api("/api/v1/highlights/air/obs-setup");
    await api("/api/v1/obs/provision");
    expect(obs.inputs.size).toBe(before.inputs.length + 2);
    expect(obs.scenes.size).toBe(before.scenes.length + 2);
  });

  it("makes them under the new spelling in an OBS without them, and prefers the new spelling when both are there", async () => {
    const { obs, api } = await start((o) => {
      o.addScene(old(REPLAY_SCENE));
      o.addInput(old(REPLAY_SCENE), old(REPLAY_INPUT), "ffmpeg_source", { is_local_file: true });
      o.addScene(REPLAY_SCENE);
      o.addInput(REPLAY_SCENE, REPLAY_INPUT, "ffmpeg_source", { is_local_file: true });
    });
    expect(await api("/api/v1/replays/obs-setup")).toMatchObject({ scene: "MatchFrame Replay", input: "MatchFrame Replay Clip", created: false });
    expect(await api("/api/v1/highlights/air/obs-setup")).toMatchObject({ scene: "MatchFrame Highlights", input: "MatchFrame Highlights Clip", created: true });
    expect(await api("/api/v1/obs/provision")).toMatchObject({ sceneName: "MatchFrame Live", sourceName: "MatchFrame HUD", createdInput: true });
    expect(obs.inputs.get("MatchFrame Replay Graphic")?.kind).toBe("browser_source");
    expect(obs.scenes.has("Matchframe Highlights")).toBe(false);
  });

  it("Team Comms recording: the recording scene 0.11.0 made is the scene used and set up (no second scene); a new OBS gets its own", async () => {
    const { engine, obs } = await start((o) => {
      o.addScene(LEGACY_RECORDING_SCENE);
      o.addInput(LEGACY_RECORDING_SCENE, RECORDING_NDI_NAME, "ndi_source", { ndi_source_name: `TESTPC (${RECORDING_NDI_NAME})` });
      o.addInput("Game", "Game Capture", "game_capture");
      o.filterKinds.clear();
    });
    // 0.11.0's scene and its NDI source differ only in case; the scene made now has a name of its own.
    expect(LEGACY_RECORDING_SCENE.toLowerCase()).toBe(RECORDING_NDI_NAME.toLowerCase());
    expect(RECORDING_SCENE).toBe("MatchFrame Comms Recording Scene");
    expect(engine.commsRecording.settings().obs.scene).toBe("Matchframe Comms Recording");
    const r = await engine.commsRecording.setupObs({ gameSource: "Game Capture" });
    expect(r.scene).toBe("Matchframe Comms Recording");
    expect(obs.scenes.has(RECORDING_SCENE)).toBe(false);
    expect(obs.scenes.get(LEGACY_RECORDING_SCENE)!.map((i) => i.source)).toContain("Game Capture");
    // The NDI source in it is the one 0.11.0 added, not a second.
    expect(obs.scenes.get(LEGACY_RECORDING_SCENE)!.filter((i) => i.source === RECORDING_NDI_NAME)).toHaveLength(1);
    // A scene the operator chose stays theirs.
    engine.settings.set("comms.recording", { ...(engine.settings.get<Record<string, unknown>>("comms.recording", {}) ?? {}), obs: { scene: "My Recording" } });
    expect(engine.commsRecording.settings().obs.scene).toBe("My Recording");
  });

  it("Team Comms recording in an OBS without 0.11.0's scene: the new scene name", async () => {
    const { engine } = await start(() => undefined);
    expect(engine.commsRecording.settings().obs.scene).toBe("MatchFrame Comms Recording Scene");
  });
});
