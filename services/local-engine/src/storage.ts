import { mkdirSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

/**
 * Where replays and highlights are written, when not in the data folder (on another drive, say):
 * `replays` holds the replay clips and the replay feed's recording; `highlights` the clips kept for
 * highlight reels and the reels themselves. Null: the defaults (the data folder; reels in Videos).
 */
export const StorageFolders = z.object({
  replays: z.string().max(400).nullable().default(null),
  highlights: z.string().max(400).nullable().default(null),
});
export type StorageFolders = z.infer<typeof StorageFolders>;

/** A folder Matchframe can write to: made if missing, a test file written and removed. Throws with why not. */
export function checkFolder(dir: string): void {
  if (!isAbsolute(dir)) throw Object.assign(new Error(`not a full folder path: ${dir}`), { status: 400 });
  const probe = join(dir, `.matchframe-write-test-${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, "ok");
    rmSync(probe, { force: true });
  } catch (err) {
    throw Object.assign(new Error(`Matchframe can't write to ${dir}: ${err instanceof Error ? err.message : String(err)}`), { status: 400 });
  }
}

/** Free space on the folder's drive in bytes, or null when it can't be read (or the folder isn't there yet). */
export function freeBytes(dir: string): number | null {
  try {
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}
