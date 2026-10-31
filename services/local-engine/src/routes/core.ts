import { hostname, platform, release } from "node:os";
import { APP_VERSION } from "../config.ts";
import { z } from "zod";
import { discoverCs2, GSI_COMPONENTS, renderGsiConfig, writeGsiConfig } from "@matchframe/game-adapters";
import { EXPANSION_GAMES } from "@matchframe/game-adapters";
import { buildCoverageRow, REQUESTED_MAP_TARGETS } from "@matchframe/map-runtime";
import { ROLES } from "../auth.ts";
import type { Engine } from "../app.ts";
import { ObserverAdapterSettings, SetupProfile } from "../app.ts";
import { HUD_ART_KEY } from "../hud/art.ts";
import { HttpError } from "../http/router.ts";
import type { Router } from "../http/router.ts";
import { redact } from "../logger.ts";

async function waitFor(pred: () => boolean, timeoutMs: number, stepMs = 50): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return pred();
}

export function registerCoreRoutes(r: Router, e: Engine): void {
  r.get("/api/v1/health", { permission: "public" }, () => ({ ok: true, version: APP_VERSION }));
  r.get("/api/v1/status", { permission: "state.read" }, () => e.health());

  r.get("/api/v1/capabilities", { permission: "state.read" }, () => ({
    capabilities: e.session.capabilities(),
    telemetrySummary: e.session.samplerSummary(),
    simulated: e.simulationRunning,
    requestedGsiComponents: GSI_COMPONENTS,
    note: "Requested components are not proof of arrival; telemetry capabilities are sampled from the actual feed. Control capabilities come from the observer adapter and real setup tests.",
  }));

  r.get("/api/v1/coverage/maps", { permission: "state.read" }, () => {
    const caps = e.session.state() && !e.simulationRunning ? e.session.capabilities() : null;
    return REQUESTED_MAP_TARGETS.map((t) => ({ ...t, ...buildCoverageRow(t.mapName, e.maps.get(t.mapName), caps) }));
  });

  r.get("/api/v1/games", { permission: "metadata.read" }, () => ({
    supported: [{ gameId: "cs2", displayName: "Counter-Strike 2", status: "core" }],
    expansion: EXPANSION_GAMES,
  }));

  // ---- setup / first run --------------------------------------------------------------------
  r.post("/api/v1/setup/detect-cs2", { permission: "settings.manage", body: z.object({ manualInstallDir: z.string().optional() }) }, (req) => {
    const result = discoverCs2(undefined, req.body.manualInstallDir);
    if (result.install) e.settings.set("cs2.install", result.install);
    return result;
  });

  r.get("/api/v1/setup/gsi-config", { permission: "settings.manage" }, () => {
    const uri = `http://127.0.0.1:${e.cfg.gsiPort}/gsi`;
    const preview = renderGsiConfig({ uri, token: "0".repeat(32) }).replace(/"token" "0+"/, '"token" "<hidden>"');
    return { uri, preview, components: GSI_COMPONENTS };
  });

  r.post("/api/v1/setup/write-gsi-config", { permission: "settings.manage", body: z.object({ cfgDir: z.string().optional(), host: z.string().default("127.0.0.1") }) }, (req) => {
    const install = e.settings.get<{ cfgDir: string } | null>("cs2.install", null);
    const cfgDir = req.body.cfgDir ?? install?.cfgDir;
    if (!cfgDir) throw new HttpError(400, "CS2 cfg directory unknown: run detection or pass cfgDir", "no_cfg_dir");
    const uri = `http://${req.body.host}:${e.cfg.gsiPort}/gsi`;
    const res = writeGsiConfig(cfgDir, renderGsiConfig({ uri, token: e.secrets.gsiToken }));
    e.audit.record(req.principal!.label, "setup.write_gsi_config", res.path, { backup: res.backup, unchanged: res.unchanged });
    return { ...res, uri, restartRequired: !res.unchanged, note: "CS2 reads GSI configs at startup: restart the observer client after writing." };
  });

  r.post("/api/v1/setup/rotate-gsi-token", { permission: "settings.manage" }, (req) => {
    e.secrets.rotateGsiToken();
    e.audit.record(req.principal!.label, "setup.rotate_gsi_token", null);
    return { rotated: true, note: "Rewrite the GSI config and restart CS2 to apply the new token." };
  });

  r.get("/api/v1/setup/status", { permission: "state.read" }, () => {
    const s = e.session.state();
    const caps = e.session.capabilities();
    const real = !!s && s.sequence > 0 && !s.simulated;
    return {
      cs2Install: e.settings.get("cs2.install", null),
      realPayloadReceived: real,
      simulated: e.simulationRunning,
      packets: s?.sources[0]?.packetsReceived ?? 0,
      gameBuild: s?.sources[0]?.gameBuild ?? null,
      telemetry: { allPlayerState: caps.allPlayerState.support, playerPositions: caps.playerPositions.support, grenadeEntities: caps.grenadeEntities.support },
      control: { adapter: e.session.arbiter.getAdapter()?.kind ?? "none", playerSelection: caps.playerSelectionControl.support, staticCamera: caps.staticCameraControl.support },
      verifiedControl: e.settings.get("observer.verifiedControl", {}),
      obs: { connected: e.obs.state.connected, scenes: e.obs.state.scenes.length, programScenes: e.program.sceneMap },
      hudUrl: e.outputs.url(`http://127.0.0.1:${e.cfg.overlayPort}`, "main"),
    };
  });

  /**
   * Real player-selection test: issues a manual POV change and records capability evidence only if
   * telemetry feedback shows the requested player within the timeout (spec: test control separately).
   */
  r.post("/api/v1/setup/test-player-selection", { permission: "camera.control", body: z.object({ steamId: z.string() }) }, async (req) => {
    const s = e.session.state();
    if (!s || s.sequence === 0) throw new HttpError(409, "no telemetry yet: receive a GSI payload first", "no_telemetry");
    const before = e.session.state()?.observer.observedSteamId ?? null;
    const result = await e.session.manualSelectPlayer(req.body.steamId, req.principal!.label);
    const confirmed = await waitFor(() => e.session.state()?.observer.observedSteamId === req.body.steamId, 3000);
    const evidence = {
      requested: req.body.steamId,
      observedBefore: before,
      observedAfter: e.session.state()?.observer.observedSteamId ?? null,
      transport: result.status,
      confirmed,
      simulated: e.simulationRunning,
      build: s.sources[0]?.gameBuild ?? null,
      at: new Date().toISOString(),
    };
    if (confirmed && !e.simulationRunning && before !== req.body.steamId) {
      const v = e.settings.get<Record<string, unknown>>("observer.verifiedControl", {});
      v.playerSelectionControl = { support: "supported", build: evidence.build, at: evidence.at };
      e.settings.set("observer.verifiedControl", v);
      await e.session.refreshControlCapabilities();
    }
    e.audit.record(req.principal!.label, "setup.test_player_selection", req.body.steamId, evidence);
    return { ...evidence, recorded: confirmed && !e.simulationRunning && before !== req.body.steamId, note: before === req.body.steamId ? "Pick a player who is not already spectated so the change is observable." : null };
  });

  /** Static camera test: telemetry can only show consistency (free camera); the operator confirms the view. */
  r.post("/api/v1/setup/test-static-camera", { permission: "camera.control", body: z.object({ cameraId: z.string() }) }, async (req) => {
    const s = e.session.state();
    if (!s || s.sequence === 0) throw new HttpError(409, "no telemetry yet", "no_telemetry");
    const result = await e.session.manualCamera(req.body.cameraId, req.principal!.label, 5000);
    const consistent = await waitFor(() => e.session.state()?.observer.cameraMode === "roaming", 3000);
    e.audit.record(req.principal!.label, "setup.test_static_camera", req.body.cameraId, { transport: result.status, consistent });
    return { transport: result.status, telemetryConsistent: consistent, nextStep: "Look at the observer client: confirm with /api/v1/setup/confirm-static-camera whether the expected view is shown." };
  });

  r.post("/api/v1/setup/confirm-static-camera", { permission: "camera.control", body: z.object({ cameraId: z.string(), visible: z.boolean() }) }, async (req) => {
    if (e.simulationRunning) throw new HttpError(409, "simulation cannot certify real camera control", "simulated");
    const s = e.session.state();
    const at = new Date().toISOString();
    if (req.body.visible) {
      const v = e.settings.get<Record<string, unknown>>("observer.verifiedControl", {});
      v.staticCameraControl = { support: "partial", build: s?.sources[0]?.gameBuild ?? null, at };
      e.settings.set("observer.verifiedControl", v);
      await e.session.refreshControlCapabilities();
    }
    e.audit.record(req.principal!.label, "setup.confirm_static_camera", req.body.cameraId, { visible: req.body.visible, at });
    return { recorded: req.body.visible, support: req.body.visible ? "partial" : "unchanged", note: "Operator-confirmed visual check; telemetry gives consistency only, so support is 'partial'." };
  });

  r.post("/api/v1/setup/reset-verification", { permission: "settings.manage" }, async (req) => {
    e.settings.set("observer.verifiedControl", {});
    await e.session.refreshControlCapabilities();
    e.audit.record(req.principal!.label, "setup.reset_verification", null);
    return { reset: true };
  });

  r.get("/api/v1/setup/profiles", { permission: "metadata.read" }, () => e.setupProfiles.list().map((d) => d.data));
  r.post("/api/v1/setup/profiles", { permission: "settings.manage" }, (req) => e.setupProfiles.create(req.body as Record<string, unknown>, "setup").data);
  r.get("/api/v1/setup/profiles/:id", { permission: "metadata.read" }, (req) => e.setupProfiles.require(req.params.id!).data);
  r.post("/api/v1/setup/profiles/:id/apply", { permission: "settings.manage" }, async (req) => {
    const p = SetupProfile.parse(e.setupProfiles.require(req.params.id!).data);
    if (Object.keys(p.observerAdapter).length > 0) e.settings.set("observer.adapter", ObserverAdapterSettings.parse(p.observerAdapter));
    if (Object.keys(p.programScenes).length > 0) {
      const scenes = { LIVE: null, REPLAY: null, STUDIO: null, BREAK: null, ...p.programScenes };
      e.settings.set("program.scenes", scenes);
      e.program.setScenes(scenes as never);
    }
    await e.applyObserverAdapter();
    e.audit.record(req.principal!.label, "setup.apply_profile", p.id);
    return { applied: p.id };
  });

  // ---- observer adapter settings ---------------------------------------------------------------
  r.get("/api/v1/observer/adapter", { permission: "state.read" }, async () => ({
    settings: e.observerSettings(),
    active: e.session.arbiter.getAdapter()?.id ?? null,
    capabilities: await e.session.arbiter.getAdapter()?.getCapabilities(),
  }));
  r.put("/api/v1/observer/adapter", { permission: "settings.manage", body: ObserverAdapterSettings }, async (req) => {
    if (req.body.kind === "netcon" && !["127.0.0.1", "localhost", "::1"].includes(req.body.host)) {
      throw new HttpError(400, "the console channel accepts arbitrary commands; only loopback hosts are allowed", "unsafe_host");
    }
    e.settings.set("observer.adapter", req.body);
    await e.applyObserverAdapter();
    e.audit.record(req.principal!.label, "observer.adapter.set", req.body.kind, req.body);
    return { settings: e.observerSettings(), active: e.session.arbiter.getAdapter()?.id ?? null };
  });

  // ---- tokens / roles -----------------------------------------------------------------------
  r.get("/api/v1/tokens", { permission: "settings.manage" }, () => ({ roles: ROLES, tokens: e.secrets.listTokens() }));
  r.post(
    "/api/v1/tokens",
    { permission: "settings.manage", body: z.object({ role: z.enum(ROLES), label: z.string().min(1).max(80), matchId: z.string().optional(), teamId: z.string().optional(), ttlHours: z.number().positive().max(24 * 30).optional() }) },
    (req) => {
      const scope = req.body.matchId || req.body.teamId ? { ...(req.body.matchId ? { matchId: req.body.matchId } : {}), ...(req.body.teamId ? { teamId: req.body.teamId } : {}) } : null;
      if (req.body.role === "captain" && (!req.body.matchId || !req.body.teamId)) throw new HttpError(400, "captain tokens require matchId and teamId", "scope_required");
      const t = e.secrets.issue(req.body.role, req.body.label, scope, req.body.ttlHours ? req.body.ttlHours * 3600_000 : req.body.role === "captain" ? 6 * 3600_000 : null);
      e.audit.record(req.principal!.label, "token.issue", t.id, { role: req.body.role, label: req.body.label, scope });
      return t;
    },
  );
  r.delete("/api/v1/tokens/:id", { permission: "settings.manage" }, (req) => {
    e.secrets.revoke(req.params.id!);
    e.audit.record(req.principal!.label, "token.revoke", req.params.id!);
    return { revoked: true };
  });
  r.get("/api/v1/me", { permission: "public" }, (req) => (req.principal ? { role: req.principal.role, label: req.principal.label, scope: req.principal.scope } : { role: null }));

  // ---- audit, logs, diagnostics ---------------------------------------------------------------
  r.get("/api/v1/audit", { permission: "settings.manage" }, (req) => e.audit.recent(Number(req.query.get("limit") ?? 200)));
  r.get("/api/v1/logs/recent", { permission: "settings.manage" }, () => e.logger.recent.slice(-300));
  r.get("/api/v1/diagnostics/bundle", { permission: "settings.manage" }, () => {
    const s = e.session.state();
    return {
      json: {
        generatedAt: new Date().toISOString(),
        app: { version: APP_VERSION, startedAt: e.startedAt },
        host: { platform: platform(), release: release(), hostnameHash: Buffer.from(hostname()).toString("base64url").slice(0, 8), node: process.versions.node },
        config: redact({ ...e.cfg, dataDir: "[local]" }),
        health: e.health(),
        capabilities: e.session.capabilities(),
        // The console commands in use (spec_mode numbering, camera command) as saved or learned.
        observerAdapter: e.observerSettings(),
        hlaeCamera: e.hlaeCamera.status(),
        telemetrySummary: e.session.samplerSummary(),
        metrics: e.session.metrics(),
        // Gaps in CS2's game data and stalls of the engine (a frozen HUD: which side stopped).
        feed: e.feed.summary(),
        // How smoothly each running HUD draws where it is shown (frames a second, longest pause, last minute).
        hudOutputs: e.hudLibrary
          .list()
          .huds.filter((h) => Object.values(h.outputs).some((n) => n > 0))
          .map((h) => ({ id: h.id, runtime: h.runtime, outputs: h.outputs, smoothness: h.smoothness })),
        state: s ? { mapName: s.mapName, round: s.roundNumber, epoch: s.epoch, sequence: s.sequence, sources: s.sources, simulated: s.simulated } : null,
        recentDecisions: e.session.decisionLog.slice(-50).map((d) => ({ at: d.decidedAtMonotonicMs, action: d.action, desired: d.desiredShot, reasons: d.reasonCodes, mode: d.mode, health: d.controlHealth })),
        arbiter: e.session.arbiter.log.slice(-100),
        directorLog: e.directorLog.recent.slice(-400),
        program: e.program.history.slice(-50),
        mapPackIssues: e.maps.issues,
        logs: e.logger.recent.slice(-300),
        migration: e.migration,
      },
      headers: { "content-disposition": `attachment; filename="matchframe-support-${Date.now()}.json"` },
    };
  });

  r.get("/api/v1/settings/:key", { permission: "settings.manage" }, (req) => {
    if (!/^(hud|program|replay|observer|director|demos|ui|live)\./.test(req.params.key!)) throw new HttpError(403, "setting not readable", "forbidden");
    return { key: req.params.key, value: e.settings.get(req.params.key!, null) };
  });
  r.put("/api/v1/settings/:key", { permission: "settings.manage", body: z.object({ value: z.unknown() }) }, (req) => {
    if (!/^(hud|program|replay|director|demos|ui)\./.test(req.params.key!)) throw new HttpError(403, "setting not writable here", "forbidden");
    // HUD images are checked (uploaded pictures only) by their own route.
    if (req.params.key === HUD_ART_KEY) throw new HttpError(403, "set HUD images with PUT /api/v1/hud/art", "forbidden");
    e.settings.set(req.params.key!, req.body.value);
    if (req.params.key === "program.scenes") e.program.setScenes(req.body.value as never);
    if (req.params.key === "replay.provider") e.configureReplay();
    e.audit.record(req.principal!.label, "settings.set", req.params.key!, req.body.value);
    return { key: req.params.key, value: req.body.value };
  });
}
