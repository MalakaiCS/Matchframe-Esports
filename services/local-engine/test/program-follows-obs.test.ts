import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Engine } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";

/**
 * The owner's replays: the main PC said "The program isn't on the live scene" while OBS showed the
 * live scene, after a replay played by hand (left in REPLAY_PLAYING) or an OBS reconnect
 * (DEGRADED), so automatic replays never played. The program now follows OBS to the live scene.
 */
describe("the program follows OBS to the live scene", () => {
  let e: Engine;
  const obs = () => e.obs as unknown as { state: { connected: boolean; programScene: string | null }; emit(ev: string, ...a: unknown[]): boolean; setProgram(scene: string): Promise<{ confirmed: boolean; programScene: string }> };
  const showScene = (scene: string) => {
    obs().state.programScene = scene;
    obs().emit("state", obs().state);
  };

  beforeAll(async () => {
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    e = new Engine(loadConfig({ dataDir: mkdtempSync(join(tmpdir(), "mf-prog-")), gsiPort: 47901, apiPort: 47902, overlayPort: 47903, host: "127.0.0.1", captainUiDir: null, hudRendererDir: null, mapPackDir: null, radarDir: null, workersDir: null, pythonPath: null, sampleHudsDirs: [] }));
    await e.init();
    e.program.setScenes({ LIVE: "Live", REPLAY: "Matchframe Replay", STUDIO: null, BREAK: null });
    obs().state.connected = true;
    // OBS puts the requested scene on program and says so.
    obs().setProgram = async (scene) => {
      showScene(scene);
      return { confirmed: true, programScene: scene };
    };
    showScene("Live");
  });
  afterAll(async () => {
    obs().state.connected = false;
    await e.shutdown();
  });

  it("goes back to live when OBS is put on the live scene after a replay played by hand", async () => {
    const item = e.replays.bookmark("hand", "manual", 3);
    await e.program.request("REPLAY_PREPARED", "operator", "op", { replayItemId: item.id });
    await e.program.request("REPLAY_PLAYING", "operator", "op", { replayItemId: item.id });
    expect(e.program.mode).toBe("REPLAY_PLAYING");
    showScene("Live");
    expect(e.program.mode).toBe("LIVE");
    expect(e.autoReplay.getStatus().detail).not.toMatch(/isn't live/);
  });

  it("goes back to live when OBS reconnects showing the live scene", () => {
    obs().state.connected = false;
    obs().emit("disconnected");
    expect(e.program.mode).toBe("DEGRADED");
    obs().state.connected = true;
    obs().emit("connected");
    expect(e.program.mode).toBe("LIVE");
  });

  it("stays out of live while OBS shows another scene", async () => {
    showScene("Matchframe Replay");
    await e.program.request("MANUAL", "operator", "op");
    showScene("Some other scene");
    expect(e.program.mode).toBe("MANUAL");
    showScene("Live");
    expect(e.program.mode).toBe("LIVE");
  });
});
