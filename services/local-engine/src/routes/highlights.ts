import { z } from "zod";
import type { Engine } from "../app.ts";
import { HttpError } from "../http/router.ts";
import type { Router } from "../http/router.ts";
import { mapDisplayName } from "../live/projection.ts";
import { HighlightsAirPatch } from "../replay/highlights-air.ts";

/** Lower thirds sent with a reel: up to 60 PNGs (a 1920×1080 one with a lower third is some 50–150 KB). */
const REEL_MAX_BYTES = 40 * 1024 * 1024;

const Choice = z.object({
  /** A kept map's key; null or absent: the current map. */
  map: z.string().max(40).nullable().default(null),
  count: z.union([z.literal("all"), z.number().int().min(1).max(60)]).default("all"),
  unplayed: z.boolean().default(false),
  fadeMs: z.number().int().min(0).max(2000).default(500),
});

/** Highlight reels (ADR-061): the kept clips per map, a reel's plan, and making it with ffmpeg. Highlights on air (ADR-063). */
export function registerHighlightRoutes(r: Router, e: Engine): void {
  const overview = () => {
    const h = e.highlights;
    const cur = h.current();
    return {
      maps: [...h.maps()].reverse().map((m) => ({
        key: m.key,
        mapName: m.mapName,
        displayName: mapDisplayName(m.mapName) ?? m.mapName,
        title: m.title,
        startedAt: m.startedAt,
        current: m === cur,
        played: m.clips.filter((c) => c.played).length,
        unplayed: m.clips.filter((c) => !c.played).length,
        bytes: m.clips.reduce((n, c) => n + c.bytes, 0),
      })),
      settings: h.settings(),
      keptBytes: h.totalBytes(),
      folder: e.reels.folder(),
      ffmpeg: e.ffmpeg.status(),
      jobs: e.reels.list(),
    };
  };

  r.get("/api/v1/highlights", { permission: "state.read" }, async () => {
    await e.ffmpeg.locate();
    return overview();
  });

  r.put("/api/v1/highlights/settings", { permission: "settings.manage", body: z.object({ keepGb: z.number().min(0.5).max(500) }) }, (req) => {
    e.highlights.setSettings(req.body);
    e.audit.record(req.principal!.label, "highlights.settings", null, req.body);
    return overview();
  });

  /** Which clips a reel would have, in order, with each one's lower third (for burning it in) and the reel's length. */
  r.post("/api/v1/highlights/plan", { permission: "state.read", body: Choice }, (req) => {
    const plan = e.highlights.plan(req.body);
    if (!plan) throw new HttpError(404, "no clips are kept for that map yet", "no_map");
    return plan;
  });

  r.get("/api/v1/highlights/reels", { permission: "state.read" }, () => e.reels.list());

  /** Makes the reel in the background; `graphics` are the lower thirds to burn in (PNG, base64) by clip id. */
  r.post(
    "/api/v1/highlights/reels",
    { permission: "replay.control", maxBodyBytes: REEL_MAX_BYTES, body: Choice.extend({ clipIds: z.array(z.string().max(80)).min(1).max(60), graphics: z.record(z.string().max(80), z.string().max(4_000_000)).optional() }) },
    async (req) => {
      const job = await e.reels.start(req.body);
      e.audit.record(req.principal!.label, "highlights.reel_start", job.id, { map: job.mapKey, clips: job.clips, graphics: Object.keys(req.body.graphics ?? {}).length, fadeMs: req.body.fadeMs });
      return job;
    },
  );

  r.post("/api/v1/highlights/reels/:id/cancel", { permission: "replay.control" }, (req) => {
    const job = e.reels.cancel(req.params.id!);
    e.audit.record(req.principal!.label, "highlights.reel_cancel", job.id);
    return job;
  });

  /** ffmpeg for reels: downloads the program's Windows build (elsewhere, install it with the system's package manager). */
  r.post("/api/v1/highlights/ffmpeg", { permission: "settings.manage" }, async (req) => {
    if (!e.ffmpeg.status().canDownload) throw new HttpError(409, "the download is for Windows: install ffmpeg with this system's package manager", "ffmpeg_no_download");
    const status = await e.ffmpeg.download();
    e.audit.record(req.principal!.label, "highlights.ffmpeg_download", null, { ok: !status.error });
    if (status.error) throw new HttpError(502, status.error, "ffmpeg_download_failed");
    return status;
  });

  // ---- highlights on air (ADR-063) -----------------------------------------------------------
  const air = async () => ({ settings: e.highlightsAir.settings(), status: e.highlightsAir.status(), setup: await e.highlightsAir.setup() });

  /** What Play plays now (the clips in order, the running time), why it can't, the highlights scene in OBS. */
  r.get("/api/v1/highlights/air", { permission: "state.read" }, () => air());

  r.put("/api/v1/highlights/air", { permission: "replay.control", body: HighlightsAirPatch }, async (req) => {
    e.highlightsAir.setSettings(req.body);
    e.audit.record(req.principal!.label, "highlights.on_air_settings", null, req.body);
    return air();
  });

  /** Play: the highlights on the program now, then back to where it came from. 409 with why when they can't. */
  r.post("/api/v1/highlights/air/play", { permission: "replay.control" }, async (req) => {
    await e.highlightsAir.play({ owner: "operator", who: req.principal!.label });
    return air();
  });

  /** Stop: the highlights end now, back to where the program came from (Highlights out). Skip and Hold: /api/v1/replays/auto/skip, /hold. */
  r.post("/api/v1/highlights/air/stop", { permission: "replay.control" }, async (req) => {
    e.highlightsAir.stop(req.principal!.label);
    return air();
  });

  /** One click: the "Matchframe Highlights" scene with its media source and twin, mapped, the replay graphic on top. */
  r.post("/api/v1/highlights/air/obs-setup", { permission: "settings.manage" }, async (req) => {
    const res = await e.highlightsAir.setupObs();
    e.audit.record(req.principal!.label, "highlights.obs_setup", res.scene, { input: res.input, created: res.created, graphic: res.graphic, twin: res.setup.twin?.scene ?? null });
    return res;
  });

  /** Your own scene for highlights, and its media source (scene null: none). */
  r.put("/api/v1/highlights/air/scene", { permission: "settings.manage", body: z.object({ scene: z.string().min(1).max(200).nullable(), input: z.string().min(1).max(200).nullable() }) }, async (req) => {
    const setup = await e.highlightsAir.mapScene(req.body.scene, req.body.input);
    e.audit.record(req.principal!.label, "highlights.scene", req.body.scene, { input: req.body.input });
    return { settings: e.highlightsAir.settings(), status: e.highlightsAir.status(), setup };
  });

  /** The replay graphic's browser source on top of the highlights scene (the same source as the replay scene's). */
  r.post("/api/v1/highlights/air/graphic", { permission: "settings.manage" }, async (req) => {
    const scene = e.program.sceneMap.HIGHLIGHTS;
    if (!scene) throw new HttpError(409, "set up the highlights scene first", "no_highlights_scene");
    const res = await e.replayGraphic.setupObs(scene);
    e.audit.record(req.principal!.label, "highlights.graphic_obs", res.scene, { source: res.source, created: res.created });
    return res;
  });
}
