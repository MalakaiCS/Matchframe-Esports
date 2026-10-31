import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { HUD_VARIANTS } from "@matchframe/contracts";
import { REQUESTED_MAP_TARGETS } from "@matchframe/map-runtime";
import type { Engine } from "../app.ts";
import { HudArtSetting, hudArtAssets } from "../hud/art.ts";
import type { OnConflict } from "../hud/library.ts";
import { libraryOutputId, ON_CONFLICT } from "../hud/library.ts";
import { PACKAGE_LIMITS, PackageError, readArchive, readDirectory } from "../hud/packages.ts";
import { HttpError } from "../http/router.ts";
import type { Router } from "../http/router.ts";
import { mapDisplayName } from "../live/projection.ts";
import { assetDir } from "./domain.ts";

const isLoopbackAddress = (a: string | undefined) => a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";

/** The package folder: the folder itself, or its only subfolder when manifest.json (or an LHM HUD's hud.json) is one level down. */
function packageFolder(dir: string): string {
  const isPackage = (d: string) => existsSync(join(d, "manifest.json")) || existsSync(join(d, "hud.json"));
  if (isPackage(dir)) return dir;
  const subs = readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory());
  return subs.length === 1 && isPackage(join(dir, subs[0]!)) ? join(dir, subs[0]!) : dir;
}

/** HUD Library operator API (ADR-020). Every mutation is audited. */
export function registerHudLibraryRoutes(r: Router, e: Engine): void {
  const lib = e.hudLibrary;
  const onConflict = (v: string | null): OnConflict => {
    if (!v) return "fail";
    if ((ON_CONFLICT as readonly string[]).includes(v)) return v as OnConflict;
    throw new HttpError(400, "onConflict must be fail, replace or copy", "validation");
  };
  const known = (id: string) => {
    if (!lib.has(id)) throw new HttpError(404, `HUD ${id} is not installed`, "not_found");
  };

  r.get("/api/v1/hud/library", { permission: "metadata.read" }, () => lib.list());

  /**
   * HUD images for every Matchframe HUD (asset ids from POST /api/v1/assets), with the maps
   * Matchframe knows (map packs, built-in radars, the requested map pool and maps already set).
   */
  const hudArt = () => {
    const art = e.hudArtSetting();
    const names = new Set([...REQUESTED_MAP_TARGETS.map((t) => t.mapName), ...e.maps.list().map((m) => m.mapName), ...e.radars.maps, ...Object.keys(art.maps)]);
    names.delete("de_synthetic");
    const maps = [...names].map((mapName) => ({ mapName, displayName: e.maps.get(mapName)?.pack.displayName ?? mapDisplayName(mapName) ?? mapName })).sort((a, b) => a.displayName.localeCompare(b.displayName));
    return { art, maps };
  };
  r.get("/api/v1/hud/art", { permission: "metadata.read" }, () => hudArt());
  r.put("/api/v1/hud/art", { permission: "hud.publish", body: HudArtSetting }, (req) => {
    const missing = hudArtAssets(req.body).filter((id) => !existsSync(join(assetDir(e), id)));
    if (missing.length) throw new HttpError(400, `upload the picture first (unknown: ${missing.join(", ")})`, "unknown_asset");
    const saved = e.setHudArt(req.body);
    e.audit.record(req.principal!.label, "hud.art", null, { players: { ct: saved.defaultPlayers.ct.length, t: saved.defaultPlayers.t.length }, maps: Object.keys(saved.maps), dead: !!saved.icons.dead });
    return hudArt();
  });

  /** Import a ZIP (raw body). A failed import never touches the installed version. */
  r.post("/api/v1/hud/library/import", { permission: "hud.publish", maxBodyBytes: PACKAGE_LIMITS.maxTotalBytes }, (req) => {
    if (req.rawBody.length === 0) throw new HttpError(400, "send the HUD package ZIP as the request body", "empty");
    const mode = onConflict(req.query.get("onConflict"));
    let files: Map<string, Uint8Array>;
    try {
      files = readArchive(new Uint8Array(req.rawBody));
    } catch (err) {
      if (err instanceof PackageError) throw err;
      throw new HttpError(400, "the file is not a valid ZIP archive", "bad_archive");
    }
    const { entry, result } = lib.importFiles(files, mode);
    e.audit.record(req.principal!.label, "hud.library.import", entry.id, { version: entry.version, result });
    return entry;
  });

  /** Import a folder on this computer (the engine reads it; refused for remote callers). */
  r.post("/api/v1/hud/library/import-folder", { permission: "hud.publish", body: z.object({ path: z.string().min(1), onConflict: z.enum(ON_CONFLICT).optional() }) }, (req) => {
    if (!isLoopbackAddress(req.raw.socket.remoteAddress)) throw new HttpError(403, "folders can be imported only on this computer; upload a ZIP instead", "local_only");
    if (!existsSync(req.body.path) || !statSync(req.body.path).isDirectory()) throw new HttpError(400, "folder not found", "folder_not_found");
    const { entry, result } = lib.importFiles(readDirectory(packageFolder(req.body.path)), req.body.onConflict ?? "fail");
    e.audit.record(req.principal!.label, "hud.library.import", entry.id, { version: entry.version, result, folder: true });
    return entry;
  });

  r.post("/api/v1/hud/library/visibility", { permission: "hud.publish", body: z.object({ hidden: z.boolean() }) }, (req) => {
    const hiddenAll = lib.setHiddenAll(req.body.hidden);
    e.audit.record(req.principal!.label, "hud.library.visibility", null, { hiddenAll });
    return { hiddenAll };
  });

  r.post("/api/v1/hud/library/:id/duplicate", { permission: "hud.publish" }, (req) => {
    const entry = lib.duplicate(req.params.id!);
    e.audit.record(req.principal!.label, "hud.library.duplicate", entry.id, { from: req.params.id });
    return entry;
  });

  r.get("/api/v1/hud/library/:id/export", { permission: "metadata.read" }, async (req) => {
    const { filename, bytes } = await lib.exportZip(req.params.id!);
    return { body: Buffer.from(bytes), contentType: "application/zip", headers: { "content-disposition": `attachment; filename="${filename}"`, "cache-control": "no-store" } };
  });

  r.delete("/api/v1/hud/library/:id", { permission: "hud.publish" }, (req) => {
    lib.remove(req.params.id!);
    e.audit.record(req.principal!.label, "hud.library.remove", req.params.id!);
    return { removed: true };
  });

  /** Settings are pushed live to every output of the HUD. */
  r.post("/api/v1/hud/library/:id/action", { permission: "hud.publish", body: z.object({ key: z.string().min(1).max(64), value: z.string().min(1).max(64) }) }, (req) => {
    lib.action(req.params.id!, req.body.key, req.body.value);
    e.audit.record(req.principal!.label, "hud.library.action", req.params.id!, req.body);
    return { sent: true };
  });
  r.put("/api/v1/hud/library/:id/settings", { permission: "hud.publish", body: z.object({ settings: z.record(z.string(), z.unknown()), presetId: z.string().max(64).nullable().optional() }) }, (req) => {
    const entry = lib.setSettings(req.params.id!, req.body.settings, req.body.presetId);
    e.audit.record(req.principal!.label, "hud.library.settings", entry.id, { presetId: entry.presetId });
    return entry;
  });

  const control = (action: "start" | "stop" | "reload" | "rollback" | "rotate-token") =>
    r.post(`/api/v1/hud/library/:id/${action}`, { permission: "hud.publish" }, (req) => {
      const id = req.params.id!;
      const entry = action === "start" ? lib.start(id) : action === "stop" ? lib.stop(id) : action === "reload" ? lib.reload(id) : action === "rollback" ? lib.rollback(id) : lib.rotateToken(id);
      e.audit.record(req.principal!.label, `hud.library.${action.replace("-", "_")}`, id, action === "rollback" ? { version: entry.version } : undefined);
      return entry;
    });
  control("start");
  control("stop");
  control("reload");
  control("rollback");
  control("rotate-token");

  /** Public state the HUD's outputs receive (what the frame gets on /overlay-ws). */
  r.get("/api/v1/hud/library/:id/state", { permission: "state.read" }, (req) => {
    known(req.params.id!);
    const variant = req.query.get("variant");
    if (variant && !(HUD_VARIANTS as readonly string[]).includes(variant)) throw new HttpError(400, `unknown variant ${variant}`, "validation");
    return e.hudState(libraryOutputId(req.params.id!), variant ?? undefined);
  });
}
