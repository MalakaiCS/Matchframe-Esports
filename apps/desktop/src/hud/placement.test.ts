import { describe, expect, it } from "vitest";
import {
  applyPlacementPatch,
  boundsForScale,
  boundsPasses,
  clampScale,
  clampToArea,
  designToDip,
  dipToCapturePixel,
  dipToScreenPixel,
  displayForRect,
  fitToArea,
  MAX_SCALE,
  MIN_SCALE,
  nativeInArea,
  pickDisplay,
  placementAfterDisplayChange,
  remapToArea,
  resolvePlacement,
  scaleOf,
  sizeForScale,
  toDisplayInfo,
} from "./placement.ts";
import type { DisplayLike } from "./placement.ts";

const HD = { width: 1920, height: 1080 };
const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const display = (id: number, x: number, y: number, width: number, height: number, scaleFactor = 1, nativeOrigin?: { x: number; y: number }): DisplayLike => ({ id, bounds: rect(x, y, width, height), scaleFactor, ...(nativeOrigin ? { nativeOrigin } : {}) });

// A primary 1920×1080 at 100 %, a 2560×1440 at 125 % to its left (2048×1152 DIP), a portrait
// 1080×1920 at 150 % above it (720×1280 DIP), and a 3440×1440 ultrawide at 100 % to its right.
const primary = display(1, 0, 0, 1920, 1080, 1);
const left = display(2, -2048, 0, 2048, 1152, 1.25, { x: -2560, y: 0 });
const above = display(3, 600, -1280, 720, 1280, 1.5, { x: 600, y: -1920 });
const ultrawide = display(4, 1920, 0, 3440, 1440, 1);
const all = [primary, left, above, ultrawide];

describe("fitting the design into a display", () => {
  it("fills a 16:9 display exactly", () => {
    expect(fitToArea(HD, primary.bounds)).toEqual(rect(0, 0, 1920, 1080));
    expect(fitToArea(HD, rect(0, 0, 3840, 2160))).toEqual(rect(0, 0, 3840, 2160));
  });
  it("letterboxes a 16:10 display (bars top and bottom, centred)", () => {
    expect(fitToArea(HD, rect(0, 0, 1920, 1200))).toEqual(rect(0, 60, 1920, 1080));
    expect(fitToArea(HD, rect(0, 0, 2560, 1600))).toEqual(rect(0, 80, 2560, 1440));
  });
  it("pillarboxes an ultrawide display (bars left and right, centred)", () => {
    expect(fitToArea(HD, rect(0, 0, 3440, 1440))).toEqual(rect(440, 0, 2560, 1440));
    expect(fitToArea(HD, rect(0, 0, 5120, 1440))).toEqual(rect(1280, 0, 2560, 1440));
  });
  it("fits a portrait display by width, centred vertically", () => {
    const r = fitToArea(HD, rect(0, 0, 1080, 1920));
    expect(r.width).toBe(1080);
    expect(r.height).toBe(608); // 607.5 rounded
    expect(r.y).toBe(656);
    expect(r.x).toBe(0);
  });
  it("keeps the aspect ratio for other design sizes", () => {
    const r = fitToArea({ width: 1280, height: 720 }, rect(0, 0, 1920, 1200));
    expect(r).toEqual(rect(0, 60, 1920, 1080));
    const square = fitToArea({ width: 1000, height: 1000 }, rect(0, 0, 1920, 1080));
    expect(square).toEqual(rect(420, 0, 1080, 1080));
  });
  it("never exceeds the area", () => {
    for (const area of [rect(0, 0, 1366, 768), rect(0, 0, 1707, 960), rect(0, 0, 1093, 614), rect(0, 0, 801, 1301)]) {
      const r = fitToArea(HD, area);
      expect(r.width).toBeLessThanOrEqual(area.width);
      expect(r.height).toBeLessThanOrEqual(area.height);
      expect(Math.abs(r.width / r.height - 16 / 9)).toBeLessThan(0.01);
    }
  });
  it("works on displays with negative origins", () => {
    expect(fitToArea(HD, left.bounds)).toEqual(rect(-2048, 0, 2048, 1152));
    const r = fitToArea(HD, above.bounds);
    expect(r).toEqual(rect(600, -1280 + Math.round((1280 - 405) / 2), 720, 405));
  });
});

describe("native 100 %", () => {
  it("is the design size, centred", () => {
    expect(nativeInArea(HD, rect(0, 0, 2560, 1440))).toEqual(rect(320, 180, 1920, 1080));
    expect(nativeInArea(HD, left.bounds)).toEqual(rect(-2048 + 64, 36, 1920, 1080));
  });
  it("overflows a smaller display equally on both sides", () => {
    // 1920×1080 pixels at 150 % is 1280×720 DIP.
    expect(nativeInArea(HD, rect(0, 0, 1280, 720))).toEqual(rect(-320, -180, 1920, 1080));
  });
  it("has scale 1", () => {
    expect(scaleOf(HD, nativeInArea(HD, primary.bounds))).toBe(1);
  });
});

describe("scale and bounds", () => {
  it("converts scale to a size and back", () => {
    expect(sizeForScale(HD, 0.5)).toEqual({ width: 960, height: 540 });
    expect(sizeForScale(HD, 1.25)).toEqual({ width: 2400, height: 1350 });
    expect(scaleOf(HD, rect(0, 0, 960, 540))).toBe(0.5);
  });
  it("clamps the scale", () => {
    expect(clampScale(0)).toBe(MIN_SCALE);
    expect(clampScale(100)).toBe(MAX_SCALE);
    expect(clampScale(Number.NaN)).toBe(1);
    expect(sizeForScale(HD, 0.01)).toEqual({ width: 192, height: 108 });
  });
  it("resizes around the centre", () => {
    expect(boundsForScale(HD, 0.5, rect(0, 0, 1920, 1080))).toEqual(rect(480, 270, 960, 540));
    expect(boundsForScale(HD, 1, rect(480, 270, 960, 540))).toEqual(rect(0, 0, 1920, 1080));
  });
  it("maps design coordinates into the window (letterboxed)", () => {
    expect(designToDip({ x: 960, y: 540 }, HD, rect(100, 100, 960, 540))).toEqual({ x: 580, y: 370 });
    expect(designToDip({ x: 0, y: 0 }, HD, rect(0, 0, 1920, 1200))).toEqual({ x: 0, y: 60 });
  });
});

describe("clamping to the display", () => {
  const area = rect(0, 0, 1920, 1080);
  it("leaves a rectangle that fits alone", () => {
    expect(clampToArea(rect(100, 100, 960, 540), area)).toEqual(rect(100, 100, 960, 540));
  });
  it("moves a rectangle back from the right and bottom edges", () => {
    expect(clampToArea(rect(1500, 900, 960, 540), area)).toEqual(rect(960, 540, 960, 540));
  });
  it("moves a rectangle back from the left and top edges", () => {
    expect(clampToArea(rect(-300, -50, 960, 540), area)).toEqual(rect(0, 0, 960, 540));
  });
  it("brings back a rectangle that is entirely off the display", () => {
    expect(clampToArea(rect(5000, -4000, 960, 540), area)).toEqual(rect(960, 0, 960, 540));
  });
  it("centres along an axis where the rectangle is larger", () => {
    expect(clampToArea(rect(0, 0, 2400, 540), area)).toEqual(rect(-240, 0, 2400, 540));
  });
  it("clamps on displays with negative origins", () => {
    expect(clampToArea(rect(-100, 0, 960, 540), left.bounds)).toEqual(rect(-960, 0, 960, 540));
    expect(clampToArea(rect(600, -2000, 720, 405), above.bounds)).toEqual(rect(600, -1280, 720, 405));
  });
});

describe("choosing a display", () => {
  it("picks the display by id", () => {
    expect(pickDisplay(all, 2, 1).id).toBe(2);
    expect(pickDisplay(all, 4, 1).id).toBe(4);
  });
  it("falls back to the primary when the display is gone or none is given", () => {
    expect(pickDisplay(all, 99, 1).id).toBe(1);
    expect(pickDisplay(all, null, 1).id).toBe(1);
    expect(pickDisplay([left, primary], undefined, 1).id).toBe(1);
  });
  it("falls back to the first display when the primary is unknown", () => {
    expect(pickDisplay([left, ultrawide], 99, 1).id).toBe(2);
  });
  it("fails clearly with no displays", () => {
    expect(() => pickDisplay([], 1, 1)).toThrow(/No display/);
  });
  it("finds the display a rectangle is mostly on", () => {
    expect(displayForRect(all, rect(-1000, 100, 960, 540))?.id).toBe(2);
    expect(displayForRect(all, rect(1800, 100, 960, 540))?.id).toBe(4); // mostly on the ultrawide
    expect(displayForRect(all, rect(700, -900, 300, 200))?.id).toBe(3);
    expect(displayForRect(all, rect(-9000, 200, 100, 100))?.id).toBe(2); // off-screen: nearest
  });
});

describe("display info with mixed scale factors", () => {
  it("reports pixels as bounds × scale factor", () => {
    const at = (d: DisplayLike, i: number) => toDisplayInfo({ ...d, workArea: d.bounds, label: "" }, 1, i);
    expect(at(primary, 0)).toMatchObject({ id: 1, primary: true, label: "Display 1", scaleFactor: 1, pixels: { width: 1920, height: 1080 } });
    expect(at(left, 1)).toMatchObject({ primary: false, scaleFactor: 1.25, pixels: { width: 2560, height: 1440 } });
    expect(at(above, 2)).toMatchObject({ scaleFactor: 1.5, pixels: { width: 1080, height: 1920 } });
  });
  it("uses the platform's exact pixel size and label when given", () => {
    const info = toDisplayInfo({ ...display(5, 0, 0, 1707, 960, 1.5), workArea: rect(0, 0, 1707, 920), label: " DELL U2720Q " }, 1, 0, { width: 2560, height: 1440 });
    expect(info.label).toBe("DELL U2720Q");
    expect(info.pixels).toEqual({ width: 2560, height: 1440 });
    expect(info.workArea).toEqual(rect(0, 0, 1707, 920));
  });
  it("sets bounds twice only across scale factors", () => {
    expect(boundsPasses(primary, ultrawide)).toBe(1);
    expect(boundsPasses(primary, left)).toBe(2);
    expect(boundsPasses(left, above)).toBe(2);
    expect(boundsPasses(null, primary)).toBe(2);
  });
  it("converts DIP points to screen and capture pixels per display", () => {
    expect(dipToScreenPixel({ x: 960, y: 540 }, primary)).toEqual({ x: 960, y: 540 });
    // Left display: DIP -2048 is physical -2560; 1 DIP = 1.25 px.
    expect(dipToScreenPixel({ x: -1024, y: 576 }, left)).toEqual({ x: -1280, y: 720 });
    expect(dipToScreenPixel({ x: 960, y: -640 }, above)).toEqual({ x: 1140, y: -960 });
    expect(dipToCapturePixel({ x: -1024, y: 576 }, left)).toEqual({ x: 1280, y: 720 });
    expect(dipToCapturePixel({ x: 960, y: -640 }, above)).toEqual({ x: 540, y: 960 });
  });
});

describe("resolving a saved placement", () => {
  it("fits the primary display by default", () => {
    expect(resolvePlacement(null, HD, all, 1)).toEqual({ displayId: 1, bounds: rect(0, 0, 1920, 1080), scale: 1 });
  });
  it("restores a placement on its display", () => {
    const p = resolvePlacement({ displayId: 2, bounds: rect(-1800, 100, 960, 540), scale: 0.5 }, HD, all, 1);
    expect(p).toEqual({ displayId: 2, bounds: rect(-1800, 100, 960, 540), scale: 0.5 });
  });
  it("keeps the centre and scale when the HUD's design size changed", () => {
    const p = resolvePlacement({ displayId: 1, bounds: rect(480, 270, 960, 540), scale: 0.5 }, { width: 1280, height: 720 }, all, 1);
    expect(p.bounds).toEqual(rect(640, 360, 640, 360));
  });
  it("falls back to the primary display when the saved display is gone", () => {
    const p = resolvePlacement({ displayId: 42, bounds: rect(-1800, 100, 960, 540), scale: 0.5 }, HD, all, 1);
    expect(p).toEqual({ displayId: 1, bounds: rect(0, 0, 1920, 1080), scale: 1 });
  });
  it("keeps a restored placement on a display that became smaller", () => {
    const p = resolvePlacement({ displayId: 1, bounds: rect(2000, 900, 960, 540), scale: 0.5 }, HD, [display(1, 0, 0, 1600, 900)], 1);
    expect(p.bounds).toEqual(rect(640, 360, 960, 540));
  });
  it("fits a portrait primary", () => {
    const p = resolvePlacement(null, HD, [display(7, 0, 0, 1080, 1920)], 7);
    expect(p.bounds).toEqual(rect(0, 656, 1080, 608));
    expect(p.scale).toBeCloseTo(0.5625);
  });
});

describe("display changes", () => {
  it("does nothing when the display is unchanged", () => {
    expect(placementAfterDisplayChange({ displayId: 2, bounds: rect(-1800, 100, 960, 540) }, all, all, 1, HD)).toBeNull();
  });
  it("moves an overlay off a removed display onto the primary, keeping its relative place and size", () => {
    const p = placementAfterDisplayChange({ displayId: 2, bounds: rect(-2048, 0, 2048, 1152) }, all, [primary, ultrawide], 1, HD);
    expect(p).toEqual({ displayId: 1, bounds: rect(0, 0, 1920, 1080), scale: 1 });
  });
  it("re-places an overlay whose display changed resolution or scaling", () => {
    // 1920×1080 at 100 % → 150 %: 1280×720 DIP. A fitted overlay stays fitted.
    const p = placementAfterDisplayChange({ displayId: 1, bounds: rect(0, 0, 1920, 1080) }, all, [display(1, 0, 0, 1280, 720, 1.5)], 1, HD);
    expect(p).toEqual({ displayId: 1, bounds: rect(0, 0, 1280, 720), scale: 1280 / 1920 });
  });
  it("remaps relative centre and size between areas", () => {
    expect(remapToArea(rect(960, 540, 960, 540), rect(0, 0, 1920, 1080), rect(-2560, 0, 2560, 1440))).toEqual(rect(-1280, 720, 1280, 720));
    expect(remapToArea(rect(0, 0, 1920, 1080), rect(0, 0, 1920, 1080), rect(0, 0, 1080, 1920))).toEqual(rect(0, 656, 1080, 608));
  });
  it("brings an overlay back on when its display moved", () => {
    const moved = [display(1, 0, 0, 1920, 1080), display(2, 1920, 0, 2048, 1152, 1.25)];
    const p = placementAfterDisplayChange({ displayId: 2, bounds: rect(-2048, 0, 1024, 576) }, all, moved, 1, HD);
    expect(p).toEqual({ displayId: 2, bounds: rect(1920, 0, 1024, 576), scale: 1024 / 1920 });
  });
});

describe("configure patches", () => {
  const cur = { displayId: 1, bounds: rect(0, 0, 1920, 1080) };
  it("moves to another display at the same scale, centred", () => {
    expect(applyPlacementPatch({ displayId: 1, bounds: rect(0, 0, 960, 540) }, { displayId: 2 }, HD, all, 1)).toEqual({ displayId: 2, bounds: rect(-1504, 306, 960, 540), scale: 0.5 });
  });
  it("fits or goes native on the chosen display", () => {
    expect(applyPlacementPatch(cur, { displayId: 4, fit: "display" }, HD, all, 1)).toEqual({ displayId: 4, bounds: rect(2360, 0, 2560, 1440), scale: 2560 / 1920 });
    expect(applyPlacementPatch(cur, { displayId: 4, fit: "native" }, HD, all, 1)).toEqual({ displayId: 4, bounds: rect(2680, 180, 1920, 1080), scale: 1 });
    expect(applyPlacementPatch(cur, { displayId: 3, fit: "display" }, HD, all, 1).bounds).toEqual(rect(600, -842, 720, 405));
  });
  it("scales around the centre and stays on the display", () => {
    expect(applyPlacementPatch(cur, { scale: 0.5 }, HD, all, 1).bounds).toEqual(rect(480, 270, 960, 540));
    expect(applyPlacementPatch({ displayId: 1, bounds: rect(960, 540, 960, 540) }, { scale: 0.75 }, HD, all, 1).bounds).toEqual(rect(480, 270, 1440, 810));
  });
  it("sets bounds with the aspect ratio kept", () => {
    expect(applyPlacementPatch(cur, { bounds: { x: 10, y: 20, width: 960, height: 999 } }, HD, all, 1).bounds).toEqual(rect(10, 20, 960, 540));
    expect(applyPlacementPatch(cur, { bounds: { height: 540 } }, HD, all, 1).bounds).toEqual(rect(0, 0, 960, 540));
  });
  it("follows bounds onto another display", () => {
    expect(applyPlacementPatch({ displayId: 1, bounds: rect(0, 0, 960, 540) }, { bounds: { x: -1000, y: 100 } }, HD, all, 1)).toEqual({ displayId: 2, bounds: rect(-1000, 100, 960, 540), scale: 0.5 });
  });
  it("keeps explicit bounds on the given display", () => {
    expect(applyPlacementPatch({ displayId: 1, bounds: rect(0, 0, 960, 540) }, { displayId: 1, bounds: { x: -1000, y: 100 } }, HD, all, 1).bounds).toEqual(rect(0, 100, 960, 540));
  });
  it("falls back to the primary for an unknown display id", () => {
    expect(applyPlacementPatch({ displayId: 2, bounds: rect(-2048, 0, 960, 540) }, { displayId: 77, fit: "display" }, HD, all, 1)).toEqual({ displayId: 1, bounds: rect(0, 0, 1920, 1080), scale: 1 });
  });
});
