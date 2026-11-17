import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { collectIcons, iconFor, iconsFromFolder, iconsFromZip, ICON_PACK_LIMITS, IconPack, sanitizeSvg } from "../src/hud/icon-pack.ts";

/** Small test icons written here (never anyone's artwork). */
const svg = (inner = '<path d="M0 0h10v4H0z"/>') => `<?xml version="1.0" encoding="utf-8"?>\n<!-- test -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 4" fill="#fff">${inner}</svg>\n`;
const tree = "repo-main/cs2/panorama/images/icons";

describe("icon pack: checking SVGs", () => {
  it("keeps a plain icon, without the declaration and comments", () => {
    expect(sanitizeSvg(svg())).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 4" fill="#fff"><path d="M0 0h10v4H0z"/></svg>');
    // Internal references and a style sheet are fine.
    expect(() => sanitizeSvg(svg('<defs><linearGradient id="g"/></defs><style>.a{fill:url(#g)}</style><use href="#g"/>'))).not.toThrow();
  });

  it.each([
    ["a script", svg("<script>alert(1)</script>")],
    ["a foreign object", svg('<foreignObject width="10" height="4"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>')],
    ["an event attribute", svg('<path onclick="alert(1)" d="M0 0"/>')],
    ["a javascript: link", svg('<use href="javascript:alert(1)"/>')],
    ["an external reference", svg('<use xlink:href="https://example.com/x.svg#a"/>')],
    ["an external style reference", svg('<path style="fill:url(https://example.com/a)" d="M0 0"/>')],
    ["an embedded image", svg('<image href="data:image/png;base64,AAAA"/>')],
    ["entities", '<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg xmlns="http://www.w3.org/2000/svg">&a;</svg>'],
    ["unclosed markup", '<svg xmlns="http://www.w3.org/2000/svg"><g><path d="M0 0"/></svg>'],
    ["not an SVG", "<html><body>hi</body></html>"],
    ["not markup", "hello"],
  ])("refuses %s", (_what, text) => {
    expect(() => sanitizeSvg(text)).toThrow();
  });

  it("knows which files are HUD icons", () => {
    expect(iconFor(`${tree}/equipment/ak47.svg`)).toMatchObject({ name: "ak47" });
    expect(iconFor(`${tree}/ui/kill_headshot.svg`)).toMatchObject({ name: "kill_headshot" });
    // ui icons the HUDs don't use, and other folders, are left out.
    expect(iconFor(`${tree}/ui/xpshop_star.svg`)).toBeNull();
    expect(iconFor(`${tree}/flags/de.svg`)).toBeNull();
    // Straight in the chosen folder: known names only.
    expect(iconFor("awp.svg")).toMatchObject({ name: "awp" });
    expect(iconFor("holiday.svg")).toBeNull();
    // CS2's tree wins over another game's in the same repository.
    expect(iconFor(`${tree}/equipment/ak47.svg`)!.priority).toBeGreaterThan(iconFor("repo-main/csgo/panorama/images/icons/equipment/ak47.svg")!.priority);
  });
});

describe("icon pack: importing", () => {
  const files = {
    [`${tree}/equipment/ak47.svg`]: svg(),
    [`${tree}/equipment/knife_karambit.svg`]: svg(),
    [`${tree}/ui/kill.svg`]: svg(),
    [`${tree}/ui/unused_icon.svg`]: svg(),
    [`${tree}/ui/health.svg`]: svg('<script>alert(1)</script>'),
    "repo-main/README.md": "readme",
  };

  it("reads a ZIP: the HUD's icons, each checked; a bad one is refused, not the pack", () => {
    const zip = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
    const r = iconsFromZip(zip);
    expect([...r.icons.keys()].sort()).toEqual(["ak47", "kill", "knife_karambit"]);
    expect(r.refused).toEqual([{ name: "health", reason: "<script> is not allowed in an icon" }]);
    expect(() => iconsFromZip(zipSync({ "notes.txt": strToU8("x") }))).toThrow(/no CS2 icons/);
    expect(() => iconsFromZip(new Uint8Array([1, 2, 3]))).toThrow(/not a valid ZIP/);
  });

  it("reads a folder: CS2's tree anywhere in it, or icons straight in it", () => {
    const dir = mkdtempSync(join(tmpdir(), "mf-icons-"));
    for (const [p, v] of Object.entries(files)) {
      mkdirSync(join(dir, p, ".."), { recursive: true });
      writeFileSync(join(dir, p), v);
    }
    expect([...iconsFromFolder(dir).icons.keys()].sort()).toEqual(["ak47", "kill", "knife_karambit"]);
    const flat = mkdtempSync(join(tmpdir(), "mf-icons-flat-"));
    writeFileSync(join(flat, "awp.svg"), svg());
    writeFileSync(join(flat, "elimination.svg"), svg());
    writeFileSync(join(flat, "logo.svg"), svg());
    expect([...iconsFromFolder(flat).icons.keys()].sort()).toEqual(["awp", "elimination"]);
  });

  it("caps sizes: an SVG over 512 KB is refused; a ZIP over 200 MB is not read", () => {
    const big = svg(`<path d="M0 0${"h1".repeat(ICON_PACK_LIMITS.svgBytes / 2)}"/>`);
    const r = collectIcons([
      ["ak47.svg", () => strToU8(svg())],
      ["awp.svg", () => strToU8(big)],
    ]);
    expect([...r.icons.keys()]).toEqual(["ak47"]);
    expect(r.refused[0]).toMatchObject({ name: "awp" });
    expect(() => iconsFromZip({ length: ICON_PACK_LIMITS.zipBytes + 1 } as Uint8Array)).toThrow(/larger than 200 MB/);
  });

  it("stores the pack on this computer, tells HUDs what's there, and removes it", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mf-pack-"));
    let changes = 0;
    const pack = new IconPack(dataDir, () => changes++);
    expect(pack.hudState()).toBeNull();
    const status = pack.install(collectIcons([["ak47.svg", () => strToU8(svg())]]), "folder");
    expect(status).toMatchObject({ count: 1, names: ["ak47"], source: "folder" });
    expect(pack.hudState()).toEqual({ names: ["ak47"], base: "/icon-pack/" });
    expect(pack.file("ak47")).toMatch(/icon-pack[\\/]ak47\.svg$/);
    expect(pack.file("../secrets")).toBeNull();
    // A restart finds it again.
    expect(new IconPack(dataDir, () => {}).hudState()).toEqual({ names: ["ak47"], base: "/icon-pack/" });
    pack.remove();
    expect(pack.hudState()).toBeNull();
    expect(changes).toBe(2);
  });
});
