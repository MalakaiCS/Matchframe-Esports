import { z } from "zod";
import type { CameraRecord } from "@matchframe/contracts";
import { CameraRecord as CameraRecordSchema, DirectorMode, ObserverMode, Side } from "@matchframe/contracts";
import { applyMapRevision, checkCameraPath, draftCamera, parseGetpos, phasesForUses } from "@matchframe/map-runtime";
import type { Engine } from "../app.ts";
import { HttpError } from "../http/router.ts";
import type { Router } from "../http/router.ts";

const PinBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("player"), steamId: z.string() }),
  z.object({ kind: z.literal("side"), side: Side }),
  z.object({ kind: z.literal("team"), teamId: z.string() }),
  z.object({ kind: z.literal("cluster"), steamIds: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal("none") }),
]);

export function registerLiveRoutes(r: Router, e: Engine): void {
  const s = e.session;

  r.get("/api/v1/matches/current/state", { permission: "state.read" }, () => ({ state: s.state() ? s.stateAt(e.now()) : null, simulated: e.simulationRunning }));
  r.get("/api/v1/matches/:id/state", { permission: "state.read" }, (req) => {
    if (req.params.id !== "current" && e.activeMatch()?.id !== req.params.id) throw new HttpError(404, "match is not the active live match", "not_active");
    return { state: s.state() ? s.stateAt(e.now()) : null, simulated: e.simulationRunning };
  });
  r.get("/api/v1/live/events", { permission: "state.read" }, (req) => ({ events: s.recentEvents(Number(req.query.get("limit") ?? 200)), utility: s.recentUtilityEvents(200) }));
  r.get("/api/v1/live/metrics", { permission: "state.read" }, () => s.metrics());

  // ---- director -------------------------------------------------------------------------
  r.get("/api/v1/director/status", { permission: "state.read" }, () => {
    const out = s.output();
    return {
      mode: s.director.currentMode,
      config: s.director.config,
      controls: { ...s.director.controls, assistedActions: [...s.director.controls.assistedActions] },
      ownership: s.arbiter.state(),
      resumeInMs: s.arbiter.resumePendingInMs(),
      pendingCommand: s.arbiter.pending(),
      decision: out?.decision ?? null,
      opportunities: out?.opportunities.slice(0, 10) ?? [],
      clusters: out?.interactions.clusters ?? [],
      mainStory: out?.interactions.mainStory ?? null,
      currentShot: s.currentShotKey(),
      cinematic: s.director.shotPlanner.activeCinematic,
      cinematicsUsedThisRound: s.director.shotPlanner.cinematicsUsedThisRound,
      scenarios: s.director.scenarioRules,
    };
  });
  r.get("/api/v1/director/decisions", { permission: "state.read" }, (req) => s.decisionLog.slice(-Number(req.query.get("limit") ?? 100)));
  r.post("/api/v1/director/observer-mode", { permission: "director.control", body: z.object({ mode: ObserverMode }) }, (req) => {
    s.setObserverMode(req.body.mode);
    // A mode chosen here while the Auto Director runs becomes what it films.
    if (e.autoDirector.status().on && req.body.mode !== "off") e.autoDirector.setSettings({ cinematic: req.body.mode !== "observer", nadeCams: req.body.mode === "full_action" });
    e.audit.record(req.principal!.label, "director.observer_mode", req.body.mode);
    return { observerMode: s.observerMode, mode: s.director.currentMode };
  });
  r.post("/api/v1/director/mode", { permission: "director.control", body: z.object({ mode: DirectorMode }) }, (req) => {
    s.setMode(req.body.mode);
    e.audit.record(req.principal!.label, "director.mode", req.body.mode);
    return { mode: s.director.currentMode, observerMode: s.observerMode };
  });
  r.post("/api/v1/director/hold", { permission: "director.control", body: z.object({ durationMs: z.number().int().positive().max(600000).nullable().default(null) }) }, (req) => {
    s.hold(req.body.durationMs);
    e.audit.record(req.principal!.label, "director.hold", null, req.body);
    return { hold: s.director.controls.hold };
  });
  r.post("/api/v1/director/release-hold", { permission: "director.control" }, (req) => {
    s.releaseHold();
    e.audit.record(req.principal!.label, "director.release_hold", null);
    return { hold: null };
  });
  r.post("/api/v1/director/pin", { permission: "director.control", body: PinBody }, (req) => {
    s.pin(req.body.kind === "none" ? null : req.body);
    e.audit.record(req.principal!.label, "director.pin", null, req.body);
    return { pin: s.director.controls.pin };
  });
  r.post("/api/v1/director/one-side", { permission: "director.control", body: z.object({ side: Side.nullable() }) }, (req) => {
    s.setOneSide(req.body.side);
    e.audit.record(req.principal!.label, "director.one_side", req.body.side);
    return { oneSide: req.body.side };
  });
  r.post("/api/v1/director/follow-action", { permission: "director.control" }, (req) => {
    s.followAction();
    e.audit.record(req.principal!.label, "director.follow_action", null);
    return { ok: true, decision: s.output()?.decision ?? null };
  });
  r.post("/api/v1/director/request-cinematic", { permission: "director.control", body: z.object({ cameraId: z.string().optional() }) }, async (req) => {
    e.audit.record(req.principal!.label, "director.request_cinematic", req.body.cameraId ?? null);
    if (req.body.cameraId) return { result: await s.manualCamera(req.body.cameraId, req.principal!.label) };
    s.requestCinematic();
    return { ok: true, decision: s.output()?.decision ?? null };
  });
  r.post("/api/v1/director/cinematics", { permission: "director.control", body: z.object({ scope: z.enum(["round", "map", "match"]), disabled: z.boolean() }) }, (req) => {
    s.disableCinematics(req.body.scope, req.body.disabled);
    e.audit.record(req.principal!.label, "director.cinematics", req.body.scope, req.body);
    return { cinematicsDisabled: s.director.controls.cinematicsDisabled };
  });
  r.post("/api/v1/director/assisted-actions", { permission: "director.control", body: z.object({ actions: z.array(z.enum(["pov_cut", "cinematic", "replay_suggestion", "mixer_cue"])) }) }, (req) => {
    s.director.controls.assistedActions = new Set(req.body.actions);
    e.audit.record(req.principal!.label, "director.assisted_actions", null, req.body.actions);
    return { assistedActions: req.body.actions };
  });
  r.post("/api/v1/director/auto-replays", { permission: "director.control", body: z.object({ disabled: z.boolean() }) }, (req) => {
    s.director.controls.autoReplaysDisabled = req.body.disabled;
    e.audit.record(req.principal!.label, "director.auto_replays", null, req.body);
    return { autoReplaysDisabled: req.body.disabled };
  });

  // ---- Auto Director (one button) --------------------------------------------------------
  const AutoPatch = z.object({ cinematic: z.boolean().optional(), nadeCams: z.boolean().optional(), returnAfterSec: z.number().int().min(0).max(120).optional(), chase: z.boolean().optional(), clutch: z.boolean().optional(), variety: z.boolean().optional(), winnerShots: z.enum(["every_round", "big_rounds", "off"]).optional(), bigMoments: z.boolean().optional(), hlaeCamera: z.boolean().optional() });
  r.get("/api/v1/director/auto", { permission: "state.read" }, () => e.autoDirector.status());
  r.post("/api/v1/director/auto/start", { permission: "director.control", body: AutoPatch }, async (req) => {
    e.audit.record(req.principal!.label, "director.auto_start_requested", null, req.body);
    return e.autoDirector.start(req.body);
  });
  r.post("/api/v1/director/auto/stop", { permission: "director.control" }, (req) => {
    e.audit.record(req.principal!.label, "director.auto_stop", null);
    return e.autoDirector.stop();
  });
  r.put("/api/v1/director/auto/settings", { permission: "director.control", body: AutoPatch }, (req) => {
    e.autoDirector.setSettings(req.body);
    e.audit.record(req.principal!.label, "director.auto_settings", null, req.body);
    return e.autoDirector.status();
  });

  // ---- observer ownership / commands ----------------------------------------------------
  r.post("/api/v1/observer/takeover", { permission: "camera.control" }, (req) => {
    s.takeover(req.principal!.label);
    e.autoDirector.holdManual();
    e.audit.record(req.principal!.label, "observer.takeover", null);
    return { ownership: s.arbiter.state() };
  });
  r.post("/api/v1/observer/resume", { permission: "director.control", body: z.object({ countdownMs: z.number().int().min(0).max(30000).default(3000) }) }, (req) => {
    s.resume(req.body.countdownMs);
    e.audit.record(req.principal!.label, "observer.resume", null, req.body);
    return { ownership: s.arbiter.state(), resumeInMs: s.arbiter.resumePendingInMs() };
  });
  r.post("/api/v1/observer/cancel-resume", { permission: "director.control" }, (req) => {
    s.cancelResume();
    e.audit.record(req.principal!.label, "observer.cancel_resume", null);
    return { ownership: s.arbiter.state() };
  });
  r.post("/api/v1/observer/emergency-stop", { permission: "camera.control" }, async (req) => {
    await s.emergencyStop();
    e.audit.record(req.principal!.label, "observer.emergency_stop", null);
    return { ownership: s.arbiter.state() };
  });
  r.post("/api/v1/observer/clear-emergency-stop", { permission: "director.control" }, (req) => {
    s.clearEmergencyStop();
    e.audit.record(req.principal!.label, "observer.clear_emergency_stop", null);
    return { ownership: s.arbiter.state() };
  });
  r.post(
    "/api/v1/observer/commands",
    {
      permission: "camera.control",
      body: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("select_player"), steamId: z.string(), view: z.enum(["in_eye", "chase"]).optional() }),
        z.object({ kind: z.literal("activate_static_camera"), cameraId: z.string(), durationMs: z.number().int().positive().max(10000).default(3000) }),
        z.object({ kind: z.literal("return_to_pov") }),
      ]),
    },
    async (req) => {
      const holder = req.principal!.label;
      const owner = req.principal!.role === "observer" || req.principal!.role === "owner" ? "operator" : "remote";
      const b = req.body;
      e.audit.record(holder, "observer.command", b.kind, b);
      if (b.kind === "select_player") return s.manualSelectPlayer(b.steamId, holder, owner, b.view);
      if (b.kind === "activate_static_camera") return s.manualCamera(b.cameraId, holder, b.durationMs);
      return s.returnToPov(holder);
    },
  );
  r.get("/api/v1/observer/log", { permission: "state.read" }, () => s.arbiter.log.slice(-200));

  // ---- program / production -------------------------------------------------------------
  r.get("/api/v1/program", { permission: "state.read" }, () => ({ mode: e.program.mode, owner: e.program.owner, scenes: e.program.sceneMap, activeReplay: e.program.activeReplay, history: e.program.history.slice(-50) }));
  r.post("/api/v1/program/cues", { permission: "program.control", body: z.object({ mode: z.enum(["LIVE", "REPLAY_PREPARED", "REPLAY_PLAYING", "STUDIO", "BREAK", "MANUAL"]), replayItemId: z.string().optional() }) }, async (req) => {
    const t = await e.program.request(req.body.mode, "operator", req.principal!.label, req.body.replayItemId ? { replayItemId: req.body.replayItemId } : {});
    e.audit.record(req.principal!.label, "program.cue", req.body.mode, t);
    return t;
  });
  r.post("/api/v1/program/return-live", { permission: "program.control" }, async (req) => {
    const playing = e.program.activeReplay;
    const t = await e.program.request("LIVE", "operator", req.principal!.label);
    if (playing) e.replays.markPlayed(playing);
    e.audit.record(req.principal!.label, "program.return_live", null, t);
    return t;
  });

  // ---- replays ----------------------------------------------------------------------------
  r.get("/api/v1/replays", { permission: "state.read" }, async () => {
    const p = e.replayProviderInstance;
    return { items: e.replays.list(), provider: p ? { id: p.id, kind: p.kind, health: await p.health(), capabilities: await p.capabilities().catch(() => null) } : null };
  });
  r.post("/api/v1/replays/bookmarks", { permission: "replay.control", body: z.object({ label: z.string().default("Manual bookmark"), preRollMs: z.number().int().min(0).max(60000).default(8000), postRollMs: z.number().int().min(0).max(10000).default(2000), capture: z.boolean().default(true) }) }, async (req) => {
    const st = s.state();
    const item = e.replays.bookmark(req.body.label, "manual", st?.roundNumber ?? null);
    e.audit.record(req.principal!.label, "replay.bookmark", item.id);
    if (req.body.capture) {
      void e.replays.capture(item.id, {
        preRollMs: req.body.preRollMs,
        postRollMs: req.body.postRollMs,
        sourceIds: null,
        matchTimeMs: st?.time.matchTimeMs ?? null,
        timeUncertaintyMs: st?.time.timeUncertaintyMs ?? null,
        epoch: st?.epoch ?? null,
        roundNumber: st?.roundNumber ?? null,
      });
    }
    return item;
  });
  r.post("/api/v1/replays/:id/approve", { permission: "replay.control" }, (req) => {
    const it = e.replays.approve(req.params.id!);
    e.audit.record(req.principal!.label, "replay.approve", it.id);
    return it;
  });
  r.post("/api/v1/replays/:id/reject", { permission: "replay.control" }, (req) => {
    const it = e.replays.reject(req.params.id!);
    e.audit.record(req.principal!.label, "replay.reject", it.id);
    return it;
  });
  r.post("/api/v1/replays/:id/trim", { permission: "replay.control", body: z.object({ startMs: z.number().int().min(0), durationMs: z.number().int().positive() }) }, (req) => e.replays.setTrim(req.params.id!, req.body.startMs, req.body.durationMs));
  /** Approved clip → replay media source → REPLAY scene; the live observer is never moved. */
  r.post("/api/v1/replays/:id/play", { permission: "replay.control" }, async (req) => {
    const it = e.replays.get(req.params.id!);
    if (!it) throw new HttpError(404, "replay not found", "not_found");
    if (it.state !== "approved") throw new HttpError(409, "only approved clips can be played", "not_approved");
    const mediaInput = e.settings.get<string | null>("replay.mediaInput", null);
    if (!it.clip?.media.path) throw new HttpError(409, "clip has no playable media file", "no_media");
    if (!mediaInput) throw new HttpError(409, "configure the OBS media source for replays (replay.mediaInput)", "no_media_input");
    await e.obs.setMediaFile(mediaInput, it.clip.media.path);
    if (e.program.mode === "LIVE") await e.program.request("REPLAY_PREPARED", "operator", req.principal!.label, { replayItemId: it.id });
    const t = await e.program.request("REPLAY_PLAYING", "operator", req.principal!.label, { replayItemId: it.id });
    await e.obs.mediaAction(mediaInput, "restart");
    e.replays.markPlaying(it.id);
    // Confirm from OBS's media status that the clip actually plays; otherwise return live.
    let media = await e.obs.mediaStatus(mediaInput).catch(() => null);
    for (let i = 0; i < 20 && media?.state !== "OBS_MEDIA_STATE_PLAYING" && media?.state !== "OBS_MEDIA_STATE_ENDED"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      media = await e.obs.mediaStatus(mediaInput).catch(() => null);
    }
    if (media?.state !== "OBS_MEDIA_STATE_PLAYING" && media?.state !== "OBS_MEDIA_STATE_ENDED") {
      e.replays.markPlaybackFailed(it.id, `OBS did not report playback (media state ${media?.state ?? "unknown"})`);
      const back = await e.program.request("LIVE", "operator", req.principal!.label);
      e.audit.record(req.principal!.label, "replay.play_failed", it.id, { media, back });
      throw new HttpError(502, "replay did not start in OBS; program returned to LIVE", "replay_not_playing", { media });
    }
    e.audit.record(req.principal!.label, "replay.play", it.id, { transition: t, media });
    return { item: e.replays.get(it.id), transition: t, media };
  });
  r.get("/api/v1/replays/playlist", { permission: "state.read" }, (req) => e.replays.playlist(req.query.get("from") ? Number(req.query.get("from")) : undefined, req.query.get("to") ? Number(req.query.get("to")) : undefined));

  // ---- OBS ----------------------------------------------------------------------------------
  r.get("/api/v1/obs", { permission: "state.read" }, () => ({ state: e.obs.state, profiles: e.settings.get("obs.profiles", []) }));
  r.post("/api/v1/obs/connect", { permission: "program.control", body: z.object({ url: z.string().regex(/^wss?:\/\//), password: z.string().optional(), name: z.string().default("OBS"), remember: z.boolean().default(true) }) }, async (req) => {
    const profile = { id: "obs-default", name: req.body.name, url: req.body.url, hasPassword: !!req.body.password };
    if (req.body.remember) {
      e.settings.set("obs.profiles", [profile]);
      e.secrets.setSecret("obs.password.obs-default", req.body.password ?? null);
    }
    await e.obs.connect(profile, req.body.password ?? e.secrets.getSecret("obs.password.obs-default"));
    e.audit.record(req.principal!.label, "obs.connect", req.body.url, { connected: e.obs.state.connected });
    return { state: e.obs.state };
  });
  r.post("/api/v1/obs/disconnect", { permission: "program.control" }, async (req) => {
    await e.obs.disconnect();
    e.audit.record(req.principal!.label, "obs.disconnect", null);
    return { state: e.obs.state };
  });
  r.post("/api/v1/obs/refresh", { permission: "program.control" }, async () => ({ state: await e.obs.refresh() }));
  r.get("/api/v1/obs/scenes/:scene/items", { permission: "state.read" }, (req) => e.obs.sceneItems(req.params.scene!));
  r.post("/api/v1/obs/program", { permission: "program.control", body: z.object({ scene: z.string(), viaTransition: z.boolean().default(false) }) }, async (req) => {
    const res = await e.obs.setProgram(req.body.scene, { viaTransition: req.body.viaTransition });
    e.audit.record(req.principal!.label, "obs.program", req.body.scene, res);
    return res;
  });
  r.post("/api/v1/obs/preview", { permission: "program.control", body: z.object({ scene: z.string() }) }, async (req) => {
    const res = await e.obs.setPreview(req.body.scene);
    e.audit.record(req.principal!.label, "obs.preview", req.body.scene, res);
    return res;
  });
  r.post("/api/v1/obs/source-visibility", { permission: "program.control", body: z.object({ scene: z.string(), source: z.string(), visible: z.boolean() }) }, async (req) => {
    const res = await e.obs.setSourceVisible(req.body.scene, req.body.source, req.body.visible);
    e.audit.record(req.principal!.label, "obs.visibility", `${req.body.scene}/${req.body.source}`, { ...req.body, ...res });
    return res;
  });
  r.post("/api/v1/obs/audio", { permission: "program.control", body: z.object({ input: z.string(), muted: z.boolean().optional(), volumeDb: z.number().min(-100).max(26).optional() }) }, async (req) => {
    const out: Record<string, unknown> = {};
    if (req.body.muted !== undefined) out.mute = await e.obs.setMute(req.body.input, req.body.muted);
    if (req.body.volumeDb !== undefined) out.volume = await e.obs.setVolumeDb(req.body.input, req.body.volumeDb);
    e.audit.record(req.principal!.label, "obs.audio", req.body.input, req.body);
    return out;
  });
  r.post("/api/v1/obs/output", { permission: "program.control", body: z.object({ kind: z.enum(["record", "stream", "replay"]), active: z.boolean() }) }, async (req) => {
    await e.obs.setOutput(req.body.kind, req.body.active);
    e.audit.record(req.principal!.label, "obs.output", req.body.kind, req.body);
    return { state: e.obs.state };
  });
  r.post("/api/v1/obs/provision", { permission: "program.control", body: z.object({ outputId: z.string().default("main"), sceneName: z.string().default("Matchframe Live"), sourceName: z.string().default("Matchframe HUD"), width: z.number().int().default(1920), height: z.number().int().default(1080) }) }, async (req) => {
    const url = e.outputs.url(`http://127.0.0.1:${e.cfg.overlayPort}`, req.body.outputId);
    const res = await e.obs.provisionBrowserSource({ sceneName: req.body.sceneName, sourceName: req.body.sourceName, url, width: req.body.width, height: req.body.height });
    e.audit.record(req.principal!.label, "obs.provision", req.body.sceneName, res);
    return res;
  });
  r.post("/api/v1/obs/screenshot", { permission: "state.read", body: z.object({ source: z.string(), width: z.number().int().min(64).max(1920).default(640) }) }, async (req) => ({ image: await e.obs.screenshot(req.body.source, req.body.width) }));

  // ---- simulation (labelled) ----------------------------------------------------------------
  r.post("/api/v1/simulation/start", { permission: "settings.manage", body: z.object({ startOffsetSec: z.number().min(0).max(80).default(0) }) }, async (req) => {
    await e.startSimulation({ startOffsetSec: req.body.startOffsetSec });
    e.audit.record(req.principal!.label, "simulation.start", null);
    return { running: true, note: "SIMULATION: synthetic data on a synthetic test map; does not certify any real integration." };
  });
  r.post("/api/v1/simulation/stop", { permission: "settings.manage" }, async (req) => {
    await e.stopSimulation();
    e.audit.record(req.principal!.label, "simulation.stop", null);
    return { running: false };
  });
  r.post("/api/v1/session/restart", { permission: "director.control" }, (req) => {
    s.restart(e.simulationRunning);
    e.audit.record(req.principal!.label, "session.restart", s.sessionId);
    return { sessionId: s.sessionId };
  });

  // ---- cues / annotations ---------------------------------------------------------------
  r.get("/api/v1/hud/cues", { permission: "state.read" }, () => e.listCues());
  r.post("/api/v1/hud/cues", { permission: "hud.publish", body: z.object({ kind: z.string(), title: z.string(), subtitle: z.string().nullable().default(null), data: z.record(z.string(), z.unknown()).default({}), durationMs: z.number().int().positive().nullable().default(8000), outputs: z.array(z.string()).nullable().default(null) }) }, (req) => {
    const c = e.showCue(req.body);
    e.audit.record(req.principal!.label, "hud.cue", c.id, req.body);
    return c;
  });
  r.delete("/api/v1/hud/cues/:id", { permission: "hud.publish" }, (req) => {
    e.clearCue(req.params.id!);
    return { cleared: true };
  });
  r.put("/api/v1/hud/annotations", { permission: "hud.publish", body: z.object({ annotations: z.array(z.object({ id: z.string(), kind: z.enum(["pencil", "arrow"]), points: z.array(z.tuple([z.number(), z.number()])).max(500), color: z.string().regex(/^#[0-9a-fA-F]{6}$/), expiresAtMs: z.number().nullable() })).max(50), onAir: z.boolean().default(false) }) }, (req) => {
    e.setAnnotations(req.body.onAir ? req.body.annotations : []);
    e.settings.set("hud.annotationsDraft", req.body.annotations);
    return { onAir: req.body.onAir, count: req.body.annotations.length };
  });

  // ---- camera walkthrough: every camera of the map being played, Keep / Hide ---------------
  const walk = e.cameraWalkthrough;
  r.get("/api/v1/cameras/walkthrough", { permission: "state.read" }, () => walk.status());
  r.post("/api/v1/cameras/walkthrough/start", { permission: "camera.control", body: z.object({ secondsPer: z.number().int().min(2).max(10).optional(), onlyUnreviewed: z.boolean().optional() }) }, (req) => {
    e.audit.record(req.principal!.label, "cameras.walkthrough_start", null, req.body);
    return walk.start(req.body);
  });
  r.post("/api/v1/cameras/walkthrough/next", { permission: "camera.control" }, () => walk.next());
  r.post("/api/v1/cameras/walkthrough/previous", { permission: "camera.control" }, () => walk.previous());
  r.post("/api/v1/cameras/walkthrough/stop", { permission: "camera.control" }, () => walk.stop());
  r.get("/api/v1/cameras/review", { permission: "state.read" }, () => walk.reviews());
  r.put("/api/v1/cameras/review", { permission: "metadata.write", body: z.object({ mapName: z.string().min(1), cameraId: z.string().min(1), verdict: z.enum(["keep", "hide"]).nullable() }) }, (req) => {
    e.audit.record(req.principal!.label, "cameras.review", req.body.cameraId, { mapName: req.body.mapName, verdict: req.body.verdict });
    return walk.review(req.body.mapName, req.body.cameraId, req.body.verdict);
  });

  // ---- maps & cameras -------------------------------------------------------------------
  r.get("/api/v1/maps", { permission: "metadata.read" }, () =>
    e.maps.list().map((m) => ({ mapName: m.mapName, displayName: m.pack.displayName, revision: m.pack.mapRevision, regions: m.pack.regions.length, cameras: m.pack.cameras.map((c) => ({ id: c.id, displayName: c.displayName, validation: c.validation, mapRevision: c.mapRevision })), radar: m.pack.radar, floorGrid: !!m.pack.floorGrid, synthetic: m.mapName === "de_synthetic", provenance: m.pack.provenance })),
  );
  /** Built-in cameras and paths (placed from map data, see scripts/generate-map-cameras.py): on or off for every map. */
  const builtIn = () => ({
    on: e.maps.builtInCameras,
    maps: e.maps.list().map((m) => ({ mapName: m.mapName, cameras: m.pack.cameras.filter((c) => c.capturedFrom === "derived_navmesh").length, paths: m.pack.paths.filter((p) => p.source === "derived_navmesh").length })),
  });
  r.get("/api/v1/cameras/built-in", { permission: "metadata.read" }, () => builtIn());
  // A coach listed with a team: left out of the HUDs and never spectated. null: detect it again.
  r.put("/api/v1/live/players/:steamId/coach", { permission: "metadata.write", body: z.object({ coach: z.boolean().nullable() }) }, (req) => {
    const steamId = req.params.steamId!;
    if (!/^\d{17}$/.test(steamId)) throw new HttpError(400, "not a SteamID64", "invalid");
    const all = { ...e.settings.get<Record<string, boolean>>("players.coaches", {}) };
    if (req.body.coach === null) delete all[steamId];
    else all[steamId] = req.body.coach;
    e.settings.set("players.coaches", all);
    e.audit.record(req.principal!.label, "players.coach", steamId, req.body);
    return { steamId, coach: req.body.coach };
  });
  r.put("/api/v1/cameras/built-in", { permission: "metadata.write", body: z.object({ on: z.boolean() }) }, (req) => {
    e.settings.set("cameras.builtIn", req.body.on);
    e.maps.setBuiltInCameras(req.body.on);
    e.audit.record(req.principal!.label, "cameras.built_in", null, req.body);
    return builtIn();
  });
  r.get("/api/v1/maps/:map", { permission: "metadata.read" }, (req) => {
    const m = e.maps.get(req.params.map!);
    if (!m) throw new HttpError(404, "no map pack", "not_found");
    return { ...m.pack, regions: m.pack.regions.map((x) => ({ id: x.id, name: x.name, kind: x.kind, source: x.source, validated: x.validated, sampleCount: x.sampleCount, tags: x.tags })) };
  });
  r.get("/api/v1/maps/:map/outline", { permission: "metadata.read" }, (req) => {
    const m = e.maps.get(req.params.map!);
    if (!m) throw new HttpError(404, "no map pack", "not_found");
    const outline = m.schematicOutline();
    if (!outline) throw new HttpError(404, "map pack has no geometry for an outline", "no_outline");
    return outline;
  });
  /** Save this view: where the camera is in CS2 now becomes one of your cameras (the desktop hotkey calls this). */
  r.post("/api/v1/cameras/capture", { permission: "metadata.write", body: z.object({ displayName: z.string().min(1).max(80).optional(), uses: z.array(z.enum(["utility", "tactical", "bomb", "establishing"])).min(1).optional() }) }, async (req) => {
    const cam = await e.cameraCapture.capture(req.body);
    e.audit.record(req.principal!.label, "camera.capture", cam.id, { mapName: cam.mapName, position: cam.position, pitch: cam.pitch, yaw: cam.yaw });
    return cam;
  });
  /** Camera authoring from real captured coordinates (CS2 `getpos` output). */
  r.post("/api/v1/maps/:map/cameras/from-getpos", { permission: "metadata.write", body: z.object({ id: z.string().regex(/^[a-z0-9-]{3,64}$/), displayName: z.string().min(1), getpos: z.string(), focus: z.object({ x: z.number(), y: z.number(), z: z.number() }), coverageRadiusUnits: z.number().positive().max(3000).default(600), targetRegionIds: z.array(z.string()).default([]), uses: z.array(z.enum(["utility", "tactical", "bomb", "establishing"])).min(1).optional() }) }, (req) => {
    const m = e.maps.get(req.params.map!);
    if (!m) throw new HttpError(404, "no map pack", "not_found");
    const pose = parseGetpos(req.body.getpos);
    if (!pose) throw new HttpError(400, "could not parse getpos output (expected 'setpos x y z;setang p y r')", "bad_getpos");
    const cam = draftCamera({ id: req.body.id, displayName: req.body.displayName, mapName: m.mapName, mapRevision: m.pack.mapRevision, pose, focus: req.body.focus, coverageRadiusUnits: req.body.coverageRadiusUnits, levelId: m.levelAt(req.body.focus), targetRegionIds: req.body.targetRegionIds, ...(req.body.uses ? { uses: [...new Set(req.body.uses)] } : {}) });
    const cams = e.settings.get<CameraRecord[]>(`cameras.${m.mapName}`, []).filter((c) => c.id !== cam.id);
    e.settings.set(`cameras.${m.mapName}`, [...cams, cam]);
    e.applyCameraOverrides(m.mapName);
    e.audit.record(req.principal!.label, "camera.capture", cam.id, cam);
    return cam;
  });
  r.post("/api/v1/maps/:map/cameras/:id/validation", { permission: "metadata.write", body: z.object({ validation: z.enum(["unvalidated", "preview_only", "validated", "invalidated"]), occlusion: z.enum(["unvalidated", "preview_only", "validated", "invalidated"]).optional(), grenadeTypes: z.array(z.enum(["he", "flashbang", "smoke", "molotov", "incendiary", "decoy"])).optional(), notes: z.string().optional(), uses: z.array(z.enum(["utility", "tactical", "bomb", "establishing"])).min(1).optional() }) }, (req) => {
    const m = e.maps.get(req.params.map!);
    if (!m) throw new HttpError(404, "no map pack", "not_found");
    const cams = e.settings.get<CameraRecord[]>(`cameras.${m.mapName}`, []);
    const cam = cams.find((c) => c.id === req.params.id) ?? m.pack.cameras.find((c) => c.id === req.params.id);
    if (!cam) throw new HttpError(404, "camera not found", "not_found");
    if (req.body.validation === "validated" && e.simulationRunning) throw new HttpError(409, "cameras cannot be validated from simulation", "simulated");
    const build = s.state()?.sources[0]?.gameBuild ?? null;
    const uses = req.body.uses ? [...new Set(req.body.uses)] : null;
    const updated = CameraRecordSchema.parse({ ...cam, ...(uses ? { actionClasses: uses, allowedPhases: phasesForUses(uses) } : {}), validation: req.body.validation, occlusionValidation: req.body.occlusion ?? cam.occlusionValidation, grenadeTypes: req.body.grenadeTypes ?? cam.grenadeTypes, notes: req.body.notes ?? cam.notes, lastTestedGameBuild: req.body.validation === "validated" ? build : cam.lastTestedGameBuild, lastTestedMapVersion: req.body.validation === "validated" ? m.pack.mapRevision : cam.lastTestedMapVersion });
    e.settings.set(`cameras.${m.mapName}`, [...cams.filter((c) => c.id !== updated.id), updated]);
    e.applyCameraOverrides(m.mapName);
    e.audit.record(req.principal!.label, "camera.validation", updated.id, req.body);
    return updated;
  });
  r.delete("/api/v1/maps/:map/cameras/:id", { permission: "metadata.write" }, (req) => {
    const cams = e.settings.get<CameraRecord[]>(`cameras.${req.params.map}`, []);
    e.settings.set(`cameras.${req.params.map}`, cams.filter((c) => c.id !== req.params.id));
    e.applyCameraOverrides(req.params.map!);
    e.audit.record(req.principal!.label, "camera.delete", req.params.id!);
    return { deleted: true };
  });
  r.post("/api/v1/maps/:map/revision", { permission: "metadata.write", body: z.object({ revision: z.string().min(1) }) }, (req) => {
    const m = e.maps.get(req.params.map!);
    if (!m) throw new HttpError(404, "no map pack", "not_found");
    const res = applyMapRevision(m.pack, req.body.revision);
    e.registerBasePack({ ...res.pack, cameras: res.pack.cameras.filter((c) => !e.settings.get<CameraRecord[]>(`cameras.${m.mapName}`, []).some((x) => x.id === c.id)) });
    const cams = e.settings.get<CameraRecord[]>(`cameras.${m.mapName}`, []).map((c) => (c.mapRevision === req.body.revision ? c : { ...c, validation: "invalidated" as const, occlusionValidation: "invalidated" as const }));
    e.settings.set(`cameras.${m.mapName}`, cams);
    e.applyCameraOverrides(m.mapName);
    e.audit.record(req.principal!.label, "map.revision", m.mapName, { revision: req.body.revision, invalidated: res.invalidated });
    return { invalidated: res.invalidated };
  });
  r.post("/api/v1/maps/:map/paths/check", { permission: "metadata.read" }, (req) => checkCameraPath(req.body as never));
}
