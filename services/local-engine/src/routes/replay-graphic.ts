import type { Engine } from "../app.ts";
import type { Router } from "../http/router.ts";
import { libraryOutputId } from "../hud/library.ts";
import { GRAPHIC_SOURCE, ReplayGraphicPatch } from "../replay/graphic.ts";

/** The replay graphic (ADR-061): its settings, the page that shows it, and that page in OBS's replay scene. */
export function registerReplayGraphicRoutes(r: Router, e: Engine): void {
  const view = () => {
    const out = e.replayGraphic.output();
    return {
      settings: e.replayGraphic.settings(),
      output: out,
      source: GRAPHIC_SOURCE,
      replayScene: e.program.sceneMap.REPLAY,
      obsConnected: e.obs.state.connected,
      /** The clip on air as the HUDs get it (null when none). */
      onAir: e.hudState(libraryOutputId(out?.hudId ?? "matchframe-default"), "replay")?.replay.clip ?? null,
    };
  };

  r.get("/api/v1/replay-graphic", { permission: "state.read" }, () => view());

  r.put("/api/v1/replay-graphic", { permission: "hud.publish", body: ReplayGraphicPatch }, async (req) => {
    const before = e.replayGraphic.output()?.url;
    e.replayGraphic.setSettings(req.body);
    e.audit.record(req.principal!.label, "replay.graphic_settings", null, req.body);
    // The source Matchframe put in OBS follows a new choice of HUD.
    if (e.replayGraphic.output()?.url !== before) await e.replayGraphic.repointObs().catch((err) => e.logger.warn("replay graphic: OBS source not re-pointed", { error: String(err) }));
    return view();
  });

  /** One click: the replay graphic as a 1920×1080 browser source on top of the mapped replay scene. */
  r.post("/api/v1/replay-graphic/obs", { permission: "settings.manage" }, async (req) => {
    const res = await e.replayGraphic.setupObs();
    e.audit.record(req.principal!.label, "replay.graphic_obs", res.scene, { source: res.source, hud: res.output.hudId, created: res.created });
    return res;
  });
}
