import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The product name as people see it, and how 0.11.0 and earlier spelled it. What the program made
 * then and finds again by name (OBS scenes, sources and transitions, folders) can carry the old
 * spelling: it is found under either spelling, and what is made new gets the current one, so an
 * update never makes a second copy of something the operator already has.
 */
export const PRODUCT_NAME = "MatchFrame";
/** The old spelling: a compatibility identifier for names made by 0.11.0 and earlier, never written for new things. */
export const LEGACY_PRODUCT_NAME = "Matchframe";

/** A name the program gives things, as 0.11.0 and earlier spelled it ("MatchFrame Replay" → "Matchframe Replay"). */
export const legacySpelling = (name: string): string => name.split(PRODUCT_NAME).join(LEGACY_PRODUCT_NAME);

/**
 * The name to use for something the program makes and finds again by name: the current spelling
 * when it exists (or nothing exists yet), else the old spelling when only that exists.
 */
export function existingName(name: string, has: (candidate: string) => boolean, legacy: string = legacySpelling(name)): string {
  if (has(name)) return name;
  return legacy !== name && has(legacy) ? legacy : name;
}

/**
 * A folder the program makes inside `parent` (its data folder, "MatchFrame Highlights" in Videos,
 * ...): the folder that is there under either spelling, exactly as it is named on disk, else the
 * current spelling. On Windows and macOS (names that differ only in case are the same folder) this
 * keeps the path text the program already stored in its database and settings; on a case-sensitive
 * file system it keeps using the folder an earlier version made instead of starting an empty one.
 */
export function brandedFolder(parent: string, name: string, legacy: string = legacySpelling(name)): string {
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return join(parent, name);
  }
  if (entries.includes(name)) return join(parent, name);
  if (legacy !== name && entries.includes(legacy)) return join(parent, legacy);
  // Another case of the same name (a folder renamed by hand on a case-insensitive file system).
  const other = entries.find((e) => e.toLowerCase() === name.toLowerCase());
  return join(parent, other ?? name);
}
