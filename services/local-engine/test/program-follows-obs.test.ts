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

  it("treats the replay scene's twin as the replay scene: a break showing it stays a replay, and live is followed from it", async () => {
    e.program.setReplayTwin("Matchframe Replay B", "Matchframe Replay");
    const item = e.replays.bookmark("twin", "manual", 4);
    await e.program.request("REPLAY_PREPARED", "automation", "auto-replay", { replayItemId: item.id });
    await e.program.request("REPLAY_PLAYING", "automation", "auto-replay", { replayItemId: item.id });
    const history = e.program.history.length;
    // The next clip of the break fades in on the twin.
    showScene("Matchframe Replay B");
    expect([e.program.mode, e.program.activeReplay, e.program.owner.holder]).toEqual(["REPLAY_PLAYING", item.id, "auto-replay"]);
    expect(e.program.history.length).toBe(history);
    // Back to live from the twin: by the break itself, one change (OBS reports the live scene during it).
    await e.program.request("LIVE", "automation", "auto-replay");
    expect(e.program.mode).toBe("LIVE");
    expect(e.program.history.slice(history).map((h) => [h.from, h.to, h.holder])).toEqual([["REPLAY_PLAYING", "LIVE", "auto-replay"]]);
    // Or by hand in OBS.
    await e.program.request("REPLAY_PREPARED", "automation", "auto-replay", { replayItemId: item.id });
    await e.program.request("REPLAY_PLAYING", "automation", "auto-replay", { replayItemId: item.id });
    showScene("Matchframe Replay B");
    showScene("Live");
    expect(e.program.mode).toBe("LIVE");
    e.program.setReplayTwin(null, null);
  });

  it("follows OBS to a scene the operator put on there (theirs, MANUAL), not to Matchframe's own, and back to live with OBS", async () => {
    showScene("Live");
    expect(e.program.mode).toBe("LIVE");
    showScene("Analysis");
    expect([e.program.mode, e.program.operatorScene, e.program.owner]).toEqual(["MANUAL", "Analysis", { kind: "operator", holder: "OBS: Analysis" }]);
    expect(e.program.history.at(-1)).toMatchObject({ from: "LIVE", to: "MANUAL", owner: "operator", detail: "the mixer shows “Analysis”, put on by the operator" });
    // Nothing automatic takes it from them.
    await expect(e.program.request("REPLAY_PREPARED", "automation", "auto-replay")).rejects.toThrow(/owned by operator/);
    showScene("Casters");
    expect(e.program.operatorScene).toBe("Casters");
    showScene("Live");
    expect([e.program.mode, e.program.operatorScene]).toEqual(["LIVE", null]);
    // Matchframe's own change to the replay scene isn't followed as theirs.
    const item = e.replays.bookmark("own", "manual", 5);
    await e.program.request("REPLAY_PREPARED", "automation", "auto-replay", { replayItemId: item.id });
    await e.program.request("REPLAY_PLAYING", "automation", "auto-replay", { replayItemId: item.id });
    showScene("Matchframe Replay");
    expect([e.program.mode, e.program.owner.holder]).toEqual(["REPLAY_PLAYING", "auto-replay"]);
    await e.program.request("LIVE", "automation", "auto-replay");
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
