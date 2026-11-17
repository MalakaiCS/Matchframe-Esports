import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { Engine } from "../app.ts";
import { HttpError } from "../http/router.ts";
import type { Router } from "../http/router.ts";
import { INTRO_MAX_BYTES, isIntroSlot, type MapIntroSlot, type StoredIntro } from "../replay/map-intro-store.ts";
import { MapIntroPatch } from "../replay/map-intro.ts";

/** Map intros (ADR-079): the videos per map, when they start, playing and stopping them. */
export function registerMapIntroRoutes(r: Router, e: Engine): void {
  const m = e.mapIntros;
  const view = (it: StoredIntro | null) => (it ? { ...it, previewUrl: it.preview ? `/api/v1/map-intros/${it.slot}/preview.jpg?v=${encodeURIComponent(it.preview)}` : null } : null);
  const overview = async () => {
    await e.ffmpeg.locate();
    return {
      settings: m.settings(),
      status: m.status(),
      slots: m.slots().map((s) => ({ ...s, intro: view(s.intro) })),
      setup: m.setup(),
      folder: m.store.dir,
      ffmpeg: e.ffmpeg.status(),
      maxBytes: INTRO_MAX_BYTES,
      /** Map intros aren't shared by account sync (video files are large): each computer keeps its own. */
      shared: false,
    };
  };
  const slotOf = (s: string | undefined): MapIntroSlot => {
    if (!s || !isIntroSlot(s)) throw new HttpError(404, `no map intro slot “${s ?? ""}”`, "not_found");
    return s;
  };

  r.get("/api/v1/map-intros", { permission: "state.read" }, () => overview());

  r.put("/api/v1/map-intros/settings", { permission: "replay.control", body: MapIntroPatch }, async (req) => {
    m.setSettings(req.body);
    e.audit.record(req.principal!.label, "map_intro.settings", null, req.body);
    return overview();
  });

  /** Play map intro (`{}`: the map in the game data; `{ map }`: that map's), on the program now. 409 with why. */
  r.post("/api/v1/map-intros/play", { permission: "replay.control", body: z.object({ map: z.string().min(1).max(64).optional() }) }, async (req) => {
    const status = await m.play({ who: req.principal!.label, which: req.body.map ? { map: req.body.map } : "current" });
    return { status };
  });

  /** Play next map's intro: the active match's next map, before the server changes to it. */
  r.post("/api/v1/map-intros/play-next", { permission: "replay.control" }, async (req) => ({ status: await m.play({ who: req.principal!.label, which: "next" }) }));

  r.post("/api/v1/map-intros/stop", { permission: "replay.control" }, (req) => ({ status: m.stop(req.principal!.label) }));

  /** The "MatchFrame Map Intro" scene in OBS now (it is also made when an intro first plays). */
  r.post("/api/v1/map-intros/obs-setup", { permission: "settings.manage" }, async (req) => {
    const res = await m.ensureScene();
    e.audit.record(req.principal!.label, "map_intro.obs_setup", res.scene, { input: res.input, created: res.created });
    return { ...res, setup: m.setup() };
  });

  /**
   * Add or Replace a map's intro (or the default's): the MP4 or MOV file as the body (streamed to
   * disk), its name in `?name=`. Checked with ffprobe/ffmpeg first: 422 with why when it can't be one.
   */
  r.post("/api/v1/map-intros/:slot", { permission: "settings.manage", streamBody: true, maxBodyBytes: INTRO_MAX_BYTES }, async (req) => {
    const slot = slotOf(req.params.slot);
    if (m.slotOnAir(slot)) {
      req.raw.resume();
      throw new HttpError(409, "That intro is on air: replace it once it has ended.", "on_air");
    }
    const name = (req.query.get("name") ?? "").replace(/[\\/]/g, "_").slice(0, 200) || `${slot}.mp4`;
    const intro = await m.store.save(slot, req.raw, name);
    e.audit.record(req.principal!.label, "map_intro.save", slot, { file: intro.file, bytes: intro.bytes, durationMs: intro.durationMs, codec: intro.videoCodec, originalName: intro.originalName });
    return { intro: view(intro), ...(await overview()) };
  });

  r.delete("/api/v1/map-intros/:slot", { permission: "settings.manage" }, async (req) => {
    const slot = slotOf(req.params.slot);
    if (m.slotOnAir(slot)) throw new HttpError(409, "That intro is on air: remove it once it has ended.", "on_air");
    if (!m.store.remove(slot)) throw new HttpError(404, "That map has no intro.", "not_found");
    e.audit.record(req.principal!.label, "map_intro.remove", slot);
    return overview();
  });

  /** An intro's preview frame (public, like the match graphics: <img> fetches it). */
  r.get("/api/v1/map-intros/:slot/preview.jpg", { permission: "public" }, (req) => {
    const it = m.store.get(slotOf(req.params.slot));
    const file = it?.preview ? m.store.path(it.preview) : null;
    if (!file || !existsSync(file)) throw new HttpError(404, "not found", "not_found");
    return { body: readFileSync(file), contentType: "image/jpeg", headers: { "cache-control": "no-cache" } };
  });
}
