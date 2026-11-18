import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeSettingsSchema, validateSettings } from "../src/hud/library.ts";
import { readDirectory, validateManifest } from "../src/hud/packages.ts";

const repo = join(import.meta.dirname, "..", "..", "..");

/** The HUD packages installed into the library on first start: Vector, Lineup and Stage (the Pro CS2 and Sample CS2 HUDs left in 0.13.3, ADR-085). */
const folders = [
  join(repo, "apps", "hud-designs", "package-files", "vector"),
  join(repo, "apps", "hud-designs", "package-files", "lineup"),
  join(repo, "apps", "hud-designs", "package-files", "stage"),
];

describe("bundled HUD packages", () => {
  it.each(folders)("%s has a valid manifest whose settings form and defaults validate", (folder) => {
    const files = new Map<string, Uint8Array>([["manifest.json", readFileSync(join(folder, "manifest.json"))]]);
    // The page is built into dist/; the manifest check only needs the entry file to exist.
    files.set("index.html", existsSync(join(folder, "index.html")) ? readFileSync(join(folder, "index.html")) : new TextEncoder().encode("<!doctype html>"));
    const m = validateManifest(files);
    const raw = (m as { settingsSchema?: Record<string, unknown> }).settingsSchema ?? {};
    const schema = normalizeSettingsSchema(raw);
    expect(Object.keys(schema).sort()).toEqual(Object.keys(raw).sort());
    const defaults = Object.fromEntries(Object.entries(schema).map(([k, f]) => [k, f.default]));
    expect(validateSettings(schema, defaults)).toEqual(defaults);
    expect(m.designResolution).toEqual({ width: 1920, height: 1080 });
    expect(existsSync(join(folder, "thumbnail.webp"))).toBe(true);
  });

  it("the program bundles no other HUD folders: the Pro CS2 and Sample CS2 HUDs are gone", () => {
    expect(existsSync(join(repo, "apps", "hud-template"))).toBe(false);
    expect(existsSync(join(repo, "assets", "hud-packages"))).toBe(false);
    expect(readFileSync(join(repo, "apps", "desktop", "electron-builder.yml"), "utf8")).not.toMatch(/hud-template|hud-packages/);
  });

  for (const hud of ["vector", "lineup", "stage"])
    it.skipIf(!existsSync(join(repo, "apps", "hud-designs", "dist", hud, "manifest.json")))(`the built ${hud} HUD package (apps/hud-designs/dist) installs as is`, () => {
      const files = readDirectory(join(repo, "apps", "hud-designs", "dist", hud));
      const m = validateManifest(files);
      expect(m.id).toBe(`matchframe.${hud}`);
      for (const name of ["index.html", "thumbnail.webp", "third-party-licenses/weapon-icons-MIT.txt", "OFL-fonts.txt", "README.md"]) expect(files.has(name)).toBe(true);
      const html = new TextDecoder().decode(files.get("index.html"));
      expect(html).toMatch(/src="\.\/assets\//);
    });

  it.skipIf(!existsSync(join(repo, "apps", "hud-designs", "dist", "stage", "manifest.json")))("the built Stage HUD carries the owner's icon set, and no CS2 icon files", () => {
    const files = [...readDirectory(join(repo, "apps", "hud-designs", "dist", "stage")).keys()];
    const pngs = files.filter((f) => /^assets\/[a-z0-9_]+-[\w-]+\.png$/.test(f));
    expect(pngs.length).toBeGreaterThanOrEqual(60);
    for (const name of ["ak47", "m4a1_silencer", "kills", "deaths", "bomb_planted", "timeout"]) expect(pngs.some((f) => f.startsWith(`assets/${name}-`))).toBe(true);
    expect(files.filter((f) => f.endsWith(".svg") && !f.startsWith("assets/"))).toEqual([]);
    // Its own font's licence (Antonio, SIL OFL 1.1).
    expect(files).toContain("OFL-Antonio.txt");
  });

  it("the Stage HUD's manifest and page: id, name, author, variants, sponsors permission and player cams", () => {
    const folder = join(repo, "apps", "hud-designs", "package-files", "stage");
    const m = validateManifest(new Map([["manifest.json", readFileSync(join(folder, "manifest.json"))], ["index.html", new TextEncoder().encode("<!doctype html>")]]));
    expect(m).toMatchObject({ id: "matchframe.stage", name: "Stage HUD", author: "MatchFrame", version: "1.0.0", category: "Broadcast" });
    expect(Object.keys(m.entryPoints).sort()).toEqual(["compact", "live", "replay"]);
    // The top bar and scoreboard sponsor slots read state.sponsors.
    expect(m.permissions).toContain("sponsors");
    const schema = normalizeSettingsSchema((m as { settingsSchema?: Record<string, unknown> }).settingsSchema ?? {});
    for (const key of ["ctColor", "tColor", "showRadar", "showKillfeed", "killfeedRows", "showSponsors", "showScoreboard", "showMvp", "mvpLiveSeconds", "showTrophy"]) expect(schema[key]).toBeDefined();
    // Out-of-range killfeed rows are refused by the settings form.
    expect(() => validateSettings(schema, { killfeedRows: 9 })).toThrow();
    // The page loads the HUD server's player cams script before its own (the observed player's cam).
    const page = readFileSync(join(repo, "apps", "hud-designs", "designs", "stage", "index.html"), "utf8");
    expect(page).toMatch(/<script src="\/hud-runtime\/cams\.js"><\/script>[\s\S]*type="module"/);
    // No other organisation's names in what ships.
    const text = readFileSync(join(folder, "manifest.json"), "utf8") + readFileSync(join(folder, "README.md"), "utf8");
    expect(text).not.toMatch(/\b(ESL|IEM|DHL|Intel|Predator|Zowie)\b/i);
  });
});
