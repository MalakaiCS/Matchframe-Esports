import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { brandedFolder, existingName, legacySpelling } from "../src/brand.ts";

const parent = (...folders: string[]) => {
  const dir = mkdtempSync(join(tmpdir(), "mf-brand-"));
  for (const f of folders) mkdirSync(join(dir, f));
  return dir;
};

describe("names under either spelling of the product name (0.11.0 wrote Matchframe)", () => {
  it("spells a name as 0.11.0 did", () => {
    expect(legacySpelling("MatchFrame Highlights")).toBe("Matchframe Highlights");
    expect(legacySpelling("MatchFrame Comms Recording Scene")).toBe("Matchframe Comms Recording Scene");
    expect(legacySpelling("Game")).toBe("Game");
  });

  it("uses the new name when it exists or nothing does, else the old one", () => {
    const has = (...names: string[]) => (n: string) => names.includes(n);
    expect(existingName("MatchFrame Replay", has())).toBe("MatchFrame Replay");
    expect(existingName("MatchFrame Replay", has("Matchframe Replay"))).toBe("Matchframe Replay");
    expect(existingName("MatchFrame Replay", has("Matchframe Replay", "MatchFrame Replay"))).toBe("MatchFrame Replay");
    expect(existingName("MatchFrame Comms Recording Scene", has("Matchframe Comms Recording"), "Matchframe Comms Recording")).toBe("Matchframe Comms Recording");
  });

  // This runs on a case-sensitive file system (Linux), where "Matchframe Esports" and "MatchFrame
  // Esports" are two folders; on Windows and macOS they are one folder and the name on disk is used.
  it("folders: the one an earlier version made, exactly as named on disk, else the new name", () => {
    expect(brandedFolder(parent(), "MatchFrame Esports")).toMatch(/[/\\]MatchFrame Esports$/);
    const old = parent("Matchframe Esports");
    expect(brandedFolder(old, "MatchFrame Esports")).toBe(join(old, "Matchframe Esports"));
    const both = parent("Matchframe Esports", "MatchFrame Esports");
    expect(brandedFolder(both, "MatchFrame Esports")).toBe(join(both, "MatchFrame Esports"));
    const renamed = parent("MATCHFRAME ESPORTS");
    expect(brandedFolder(renamed, "MatchFrame Esports")).toBe(join(renamed, "MATCHFRAME ESPORTS"));
    const videos = parent("Matchframe Highlights", "Matchframe Comms Recordings");
    expect(brandedFolder(videos, "MatchFrame Highlights")).toBe(join(videos, "Matchframe Highlights"));
    expect(brandedFolder(videos, "MatchFrame Comms Recordings")).toBe(join(videos, "Matchframe Comms Recordings"));
    // No parent folder (yet): the new name in it.
    expect(brandedFolder(join(old, "missing"), "MatchFrame Highlights")).toBe(join(old, "missing", "MatchFrame Highlights"));
  });
});
