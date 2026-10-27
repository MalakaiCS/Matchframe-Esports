import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeSettingsSchema, validateSettings } from "../src/hud/library.ts";
import { readDirectory, validateManifest } from "../src/hud/packages.ts";

const repo = join(import.meta.dirname, "..", "..", "..");

/** The HUD packages installed into the library on first start: the sample package and the Pro CS2 HUD. */
const folders = [
  ...readdirSync(join(repo, "assets", "hud-packages")).map((n) => join(repo, "assets", "hud-packages", n)),
  join(repo, "apps", "hud-template", "package-files"),
];

describe("bundled HUD packages", () => {
  it.each(folders)("%s has a valid manifest whose settings form and defaults validate", (folder) => {
    const files = new Map<string, Uint8Array>([["manifest.json", readFileSync(join(folder, "manifest.json"))]]);
    // The Pro CS2 HUD's page is built into dist/; the manifest check only needs the entry file to exist.
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

  it.skipIf(!existsSync(join(repo, "apps", "hud-template", "dist", "manifest.json")))("the built Pro CS2 HUD package (apps/hud-template/dist) installs as is", () => {
    const files = readDirectory(join(repo, "apps", "hud-template", "dist"));
    const m = validateManifest(files);
    expect(m.id).toBe("matchframe.pro-cs2");
    for (const name of ["index.html", "thumbnail.webp", "LICENSE-lexogrine.txt", "OFL-Montserrat.txt", "README.md"]) expect(files.has(name)).toBe(true);
    const html = new TextDecoder().decode(files.get("index.html"));
    // Relative asset paths: installed packages are served under /huds/<id>/.
    expect(html).toMatch(/src="\.\/assets\//);
  });
});
