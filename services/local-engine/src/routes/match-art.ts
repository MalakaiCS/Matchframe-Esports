import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { Engine } from "../app.ts";
import { ART_KINDS, ART_MAX_BYTES, ArtKind, ArtSettings, OBS_STINGERS, STINGER_CUT_MS } from "../domain/match-art.ts";
import { HttpError } from "../http/router.ts";
import type { Router } from "../http/router.ts";
import { storeAsset } from "./domain.ts";

export function registerMatchArtRoutes(r: Router, e: Engine): void {
  /** What has been made for a match, where the files are, and the OBS transitions they go in. */
  r.get("/api/v1/matches/:id/art", { permission: "metadata.read" }, (req) => {
    const id = req.params.id!;
    const items = e.matchArt.list(id);
    return { folder: dirname(e.matchArt.path(id, "stinger")), items, settings: e.matchArt.settings(id), kinds: Object.entries(ART_KINDS).map(([kind, k]) => ({ kind, label: k.label, file: k.file })), obs: { transitions: OBS_STINGERS, cutMs: STINGER_CUT_MS } };
  });

  r.put("/api/v1/matches/:id/art/settings", { permission: "metadata.write", body: ArtSettings.partial() }, (req) => {
    const id = req.params.id!;
    if (req.body.backgroundAssetId) {
      // Only an uploaded picture.
      if (!/^[a-f0-9]{24}\.(png|jpe?g|webp)$/.test(req.body.backgroundAssetId)) throw new HttpError(400, "the background must be an uploaded PNG, JPG or WebP picture", "bad_asset");
    }
    return e.matchArt.setSettings(id, req.body);
  });

  /** The match's stingers into OBS's "Matchframe Stinger" / "Matchframe Replay Stinger" transitions. */
  r.post("/api/v1/matches/:id/art/obs", { permission: "program.control", body: z.object({ useStinger: z.boolean().default(false) }) }, (req) => e.matchArt.obsSetup(req.params.id!, { useStinger: req.body.useStinger }));

  /** A frame of the OBS program as a background picture (stored as an asset). */
  r.post("/api/v1/matches/:id/art/background-from-obs", { permission: "metadata.write" }, async (req) => {
    const id = req.params.id!;
    e.matches.require(id);
    if (!e.obs.state.connected) throw new HttpError(409, "OBS is not connected (Settings → Devices)", "obs_not_connected");
    const scene = e.obs.state.programScene;
    if (!scene) throw new HttpError(409, "OBS has no program scene", "no_scene");
    const data = await e.obs.screenshot(scene, 1920);
    const png = Buffer.from(data.replace(/^data:image\/\w+;base64,/, ""), "base64");
    const assetId = storeAsset(e, png, ".png");
    e.audit.record(req.principal!.label, "match_art.background_obs", id, { assetId });
    return e.matchArt.setSettings(id, { backgroundAssetId: assetId });
  });

  /** (After the fixed paths above: `:kind` would match them too.) One file made by the program (PNG or WebM), stored for the match. */
  r.post("/api/v1/matches/:id/art/:kind", { permission: "metadata.write", maxBodyBytes: ART_MAX_BYTES }, (req) => {
    const kind = ArtKind.safeParse(req.params.kind);
    if (!kind.success) throw new HttpError(400, `unknown graphic ${req.params.kind}`, "bad_kind");
    if (req.rawBody.length === 0) throw new HttpError(400, "empty file", "bad_size");
    const item = e.matchArt.save(req.params.id!, kind.data, req.rawBody);
    e.audit.record(req.principal!.label, "match_art.save", req.params.id!, { kind: kind.data, bytes: req.rawBody.length });
    return item;
  });

  /** The files themselves (public, like team logos under /assets/: OBS and <img> fetch them). */
  r.get("/api/v1/match-art/:id/:file", { permission: "public" }, (req) => {
    const f = e.matchArt.file(req.params.id!, req.params.file!);
    if (!f) throw new HttpError(404, "not found", "not_found");
    return { body: readFileSync(f.path), contentType: f.type, headers: { "cache-control": "no-cache" } };
  });
}
