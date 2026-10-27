import { existsSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ObsManager } from "../src/index.ts";

/**
 * Real-integration test against a running OBS with obs-websocket v5. Skipped unless
 * MF_OBS_URL (e.g. ws://127.0.0.1:4455) and MF_OBS_PASSWORD are set.
 */
const url = process.env.MF_OBS_URL;
const password = process.env.MF_OBS_PASSWORD;
const run = url && password ? describe : describe.skip;

run("ObsManager against a real OBS instance", () => {
  it("rejects a wrong password", async () => {
    const m = new ObsManager();
    await m.connect({ id: "p", name: "test", url: url!, hasPassword: true }, "wrong-password");
    expect(m.state.connected).toBe(false);
    expect(m.state.lastError).toBeTruthy();
    await m.disconnect();
  });

  it("connects, discovers requests, provisions without replacing, cuts program and toggles a source with confirmation", async () => {
    const m = new ObsManager();
    await m.connect({ id: "p", name: "test", url: url!, hasPassword: true }, password);
    expect(m.state.connected).toBe(true);
    expect(m.state.obsVersion).toMatch(/^\d+\./);
    expect(m.supports("SetCurrentProgramScene")).toBe(true);
    const before = [...m.state.scenes];

    let source = "Matchframe HUD";
    if (m.state.inputKinds.includes("browser_source")) {
      const p1 = await m.provisionBrowserSource({ sceneName: "Matchframe Live", sourceName: source, url: "http://127.0.0.1:37212/overlay/main/live", width: 1920, height: 1080 });
      expect(p1.createdInput || p1.updatedUrl).toBe(true);
      const p2 = await m.provisionBrowserSource({ sceneName: "Matchframe Live", sourceName: source, url: "http://127.0.0.1:37212/overlay/main/live?v=2", width: 1920, height: 1080 });
      expect(p2.createdInput).toBe(false);
      expect(p2.updatedUrl).toBe(true);
    } else {
      // This OBS build lacks Browser Source: provisioning must fail clearly, not half-create.
      await expect(m.provisionBrowserSource({ sceneName: "Matchframe Live", sourceName: source, url: "http://x", width: 10, height: 10 })).rejects.toThrow(/no Browser Source/);
      source = "Matchframe Test Color";
      const kind = m.state.inputKinds.find((k) => k.startsWith("color_source")) ?? "color_source_v3";
      await m.ensureInput({ sceneName: "Matchframe Live", inputName: source, inputKind: kind, settings: { color: 4278190335, width: 320, height: 180 } });
    }
    for (const s of before) expect(m.state.scenes).toContain(s);

    const cut = await m.setProgram("Matchframe Live");
    expect(cut.confirmed).toBe(true);
    expect(m.state.programScene).toBe("Matchframe Live");

    const hide = await m.setSourceVisible("Matchframe Live", source, false);
    expect(hide.confirmed).toBe(true);
    const show = await m.setSourceVisible("Matchframe Live", source, true);
    expect(show.confirmed).toBe(true);

    // Refuse to replace a non-browser input that happens to share the name.
    const other = m.state.inputs.find((i) => i.name === source)!;
    await expect(m.ensureInput({ sceneName: "Matchframe Live", inputName: source, inputKind: other.kind === "text_ft2_source_v2" ? "color_source_v3" : "text_ft2_source_v2", settings: {} })).rejects.toThrow(/refusing to replace|does not support/);

    if (before[0]) await m.setProgram(before[0]);
    await m.disconnect();
  }, 30000);

  it("starts the replay buffer, saves a clip and plays it back through a media source", async (ctx) => {
    const m = new ObsManager();
    await m.connect({ id: "p", name: "test", url: url!, hasPassword: true }, password);
    try {
      await m.setOutput("replay", true);
    } catch (e) {
      // The replay buffer needs an output configuration in OBS: report as skipped, never as passed.
      await m.disconnect();
      ctx.skip(`replay buffer could not start: ${String(e)}`);
    }
    expect(m.state.replayBuffer).toBe(true); // setOutput confirms by read-back
    await new Promise((r) => setTimeout(r, 2500));
    const saved = await m.saveReplayBuffer();
    // OBS confirmed a written file; when OBS runs on this machine the file must exist.
    expect(saved.savedPath).toMatch(/\.(mkv|mp4|mov|flv)$/);
    if (/^ws:\/\/(127\.0\.0\.1|localhost)/.test(url!)) {
      expect(existsSync(saved.savedPath)).toBe(true);
      expect(statSync(saved.savedPath).size).toBeGreaterThan(1000);
    }
    await m.setOutput("replay", false);

    // Playout: load the saved clip into a media source on a replay scene, restart it and confirm
    // from OBS's own media status that it plays (not just that the request was accepted).
    if (!m.state.inputKinds.includes("ffmpeg_source")) {
      await m.disconnect();
      ctx.skip("this OBS build has no media source (ffmpeg_source)");
    }
    await m.ensureInput({ sceneName: "Matchframe Replay", inputName: "Matchframe Replay Media", inputKind: "ffmpeg_source", settings: { local_file: saved.savedPath, is_local_file: true, restart_on_activate: false } });
    await m.setMediaFile("Matchframe Replay Media", saved.savedPath!);
    await m.mediaAction("Matchframe Replay Media", "restart");
    let status = await m.mediaStatus("Matchframe Replay Media");
    for (let i = 0; i < 30 && status.state !== "OBS_MEDIA_STATE_PLAYING" && status.state !== "OBS_MEDIA_STATE_ENDED"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      status = await m.mediaStatus("Matchframe Replay Media");
    }
    expect(["OBS_MEDIA_STATE_PLAYING", "OBS_MEDIA_STATE_ENDED"]).toContain(status.state);
    expect(status.durationMs ?? 0).toBeGreaterThan(500);
    await m.disconnect();
  }, 40000);
});
