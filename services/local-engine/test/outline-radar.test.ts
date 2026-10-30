import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MapRegistry } from "@matchframe/map-runtime";
import { outlineRadar } from "../src/hud/outline-radar.ts";

const packs = join(import.meta.dirname, "..", "..", "..", "assets", "map-packs");

describe("radar images from map-pack outlines (maps with no radar drawing)", () => {
  it("draws Anubis where players were seen, with a calibration that puts them there", () => {
    const reg = new MapRegistry();
    const file = join(packs, "de_anubis.json");
    const pack = JSON.parse(readFileSync(file, "utf8")) as { regions: { kind: string; shapes: { kind: string; cellSize: number; cells: [number, number][] }[] }[] };
    const rt = reg.registerRaw(pack, file)!;
    const r = outlineRadar(rt)!;
    expect(r.svg).toMatch(/^<svg [^>]*width="1024" height="1024"/);
    expect(r.svg.length).toBeLessThan(40_000);
    // Both bombsites lettered.
    expect([...r.svg.matchAll(/<text [^>]*>([AB])<\/text>/g)].map((m) => m[1]).sort()).toEqual(["A", "B"]);
    // Every region's cell centres land inside a drawn rectangle at the calibration's pixel.
    const rects = [...r.svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"\/>/g)].map((m) => m.slice(1, 5).map(Number) as [number, number, number, number]);
    const drawn = (px: number, py: number) => rects.some(([x, y, w, h]) => px >= x && px <= x + w && py >= y && py <= y + h);
    let checked = 0;
    for (const reg of pack.regions) {
      for (const sh of reg.shapes) {
        if (sh.kind !== "cells") continue;
        for (const [ix, iy] of sh.cells.filter((_, i) => i % 7 === 0)) {
          const wx = (ix + 0.5) * sh.cellSize;
          const wy = (iy + 0.5) * sh.cellSize;
          expect(drawn(r.config.origin.x + wx * r.config.pxPerUX, r.config.origin.y + wy * r.config.pxPerUY)).toBe(true);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(200);
    // North is up: a point further north is higher on the image.
    expect(r.config.pxPerUY).toBeLessThan(0);
  });
});
