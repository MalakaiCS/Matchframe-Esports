import { z } from "zod";
import type { Engine } from "../app.ts";
import { DEFAULT_ICON_PACK_SOURCE, ICON_PACK_LIMITS, iconsFromFolder, iconsFromZip } from "../hud/icon-pack.ts";
import { HttpError } from "../http/router.ts";
import type { Router } from "../http/router.ts";

const isLoopbackAddress = (a: string | undefined) => a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";

/**
 * The icon pack (HUD Library → HUD images → Icon pack): CS2's icons loaded on this computer from the
 * operator's own copy (a ZIP or a folder) or downloaded at their request. Every change is audited.
 */
export function registerIconPackRoutes(r: Router, e: Engine): void {
  r.get("/api/v1/hud/icon-pack", { permission: "metadata.read" }, () => e.iconPack.status());

  /** A ZIP of CS2's icons (raw body), e.g. a download of an icon repository. */
  r.post("/api/v1/hud/icon-pack/import", { permission: "hud.publish", maxBodyBytes: ICON_PACK_LIMITS.zipBytes }, (req) => {
    if (req.rawBody.length === 0) throw new HttpError(400, "send the ZIP as the request body", "empty");
    const status = e.iconPack.install(iconsFromZip(new Uint8Array(req.rawBody)), "zip");
    e.audit.record(req.principal!.label, "hud.icon_pack.import", null, { source: "zip", count: status.count, refused: status.refused.length });
    return status;
  });

  /** A folder on this computer (the engine reads it; refused for remote callers). */
  r.post("/api/v1/hud/icon-pack/import-folder", { permission: "hud.publish", body: z.object({ path: z.string().min(1).max(4096) }) }, (req) => {
    if (!isLoopbackAddress(req.raw.socket.remoteAddress)) throw new HttpError(403, "folders can be imported only on this computer; upload a ZIP instead", "local_only");
    const status = e.iconPack.install(iconsFromFolder(req.body.path), "folder");
    e.audit.record(req.principal!.label, "hud.icon_pack.import", null, { source: "folder", count: status.count, refused: status.refused.length });
    return status;
  });

  /** Get CS2 icons: downloads them in the background; GET reports the progress. */
  r.post("/api/v1/hud/icon-pack/download", { permission: "hud.publish" }, (req) => {
    if (e.iconPack.downloading) throw new HttpError(409, "a download is already running", "busy");
    const source = e.cfg.iconPackSource ?? DEFAULT_ICON_PACK_SOURCE;
    const who = req.principal!.label;
    e.audit.record(who, "hud.icon_pack.download", null, { from: new URL(source.rawBase).host });
    void e.iconPack.download(source).then(
      (s) => e.audit.record(who, "hud.icon_pack.downloaded", null, { count: s.count, refused: s.refused.length }),
      (err: unknown) => e.audit.record(who, "hud.icon_pack.download_failed", null, { message: err instanceof Error ? err.message : String(err) }),
    );
    return e.iconPack.status();
  });

  r.delete("/api/v1/hud/icon-pack", { permission: "hud.publish" }, (req) => {
    e.iconPack.remove();
    e.audit.record(req.principal!.label, "hud.icon_pack.remove", null);
    return e.iconPack.status();
  });
}
