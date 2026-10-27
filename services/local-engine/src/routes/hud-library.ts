import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { HUD_VARIANTS } from "@matchframe/contracts";
import type { Engine } from "../app.ts";
import type { OnConflict } from "../hud/library.ts";
import { libraryOutputId, ON_CONFLICT } from "../hud/library.ts";
import { PACKAGE_LIMITS, PackageError, readArchive, readDirectory } from "../hud/packages.ts";
import { HttpError } from "../http/router.ts";
import type { Router } from "../http/router.ts";

const isLoopbackAddress = (a: string | undefined) => a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";

/** The package folder: the folder itself, or its only subfolder when manifest.json is one level down. */
function packageFolder(dir: string): string {
  if (existsSync(join(dir, "manifest.json"))) return dir;
  const subs = readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory());
  return subs.length === 1 && existsSync(join(dir, subs[0]!, "manifest.json")) ? join(dir, subs[0]!) : dir;
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

  r.get("/api/v1/hud/library/:id/export", { permission: "metadata.read" }, (req) => {
    const { filename, bytes } = lib.exportZip(req.params.id!);
    return { body: Buffer.from(bytes), contentType: "application/zip", headers: { "content-disposition": `attachment; filename="${filename}"`, "cache-control": "no-store" } };
  });

  r.delete("/api/v1/hud/library/:id", { permission: "hud.publish" }, (req) => {
    lib.remove(req.params.id!);
    e.audit.record(req.principal!.label, "hud.library.remove", req.params.id!);
    return { removed: true };
  });

  /** Settings are pushed live to every output of the HUD. */
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
