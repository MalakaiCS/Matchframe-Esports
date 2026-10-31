import { join } from "node:path";
import { z } from "zod";
import type { Engine } from "../app.ts";
import { HttpError } from "../http/router.ts";
import type { Router } from "../http/router.ts";
import { freeBytes } from "../storage.ts";

const Folder = z.string().trim().min(1).max(400).nullable();

/** Where replays and highlights are written: chosen folders (another drive, say), and the space left on each. */
export function registerStorageRoutes(r: Router, e: Engine): void {
  const overview = () => {
    const folders = e.storageFolders();
    const where = {
      replayClips: e.replayStorage("clips"),
      replayFeed: e.replayStorage("feed"),
      keptClips: folders.highlights ? join(folders.highlights, "Kept clips") : join(e.highlights.dir, "clips"),
      reels: e.reels.folder(),
    };
    return {
      folders,
      where,
      free: { replays: freeBytes(folders.replays ?? e.cfg.dataDir), highlights: freeBytes(folders.highlights ?? e.reels.folder()) },
      dataDir: e.cfg.dataDir,
    };
  };

  r.get("/api/v1/storage", { permission: "settings.manage" }, () => overview());
  r.put("/api/v1/storage", { permission: "settings.manage", body: z.object({ replays: Folder.optional(), highlights: Folder.optional() }) }, async (req) => {
    try {
      await e.setStorageFolders(req.body);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err), "bad_folder");
    }
    e.audit.record(req.principal!.label, "storage.folders", null, req.body);
    return overview();
  });
}
