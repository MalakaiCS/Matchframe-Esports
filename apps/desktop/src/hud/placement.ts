import type { DisplayInfo, OverlayConfigPatch, Rect, Size } from "./types.ts";

/**
 * Desktop overlay placement math (pure; no Electron). All rectangles are in DIP (device-independent
 * pixels, Electron's screen coordinates): displays left of or above the primary have negative
 * origins, and a display's DIP size is its pixel size ÷ its scale factor. An overlay keeps the HUD's
 * aspect ratio; scale = window width ÷ the HUD's design width, so 100 % (native) is the design size in
 * DIP, the same size a browser shows the page at 100 % zoom on that display.
 *
 * Overlays are placed against the display's full bounds, not its work area: the game they sit over
 * is borderless and covers the taskbar too.
 */

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 4;

/** The parts of an Electron Display (or DisplayInfo) placement needs. */
export interface DisplayLike {
  id: number;
  bounds: Rect;
  scaleFactor: number;
  /** Top-left in physical screen pixels (Electron's Display.nativeOrigin). */
  nativeOrigin?: { x: number; y: number };
}

export interface Placed {
  displayId: number;
  bounds: Rect;
  scale: number;
}

export const clampScale = (scale: number): number => (Number.isFinite(scale) ? Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale)) : 1);

export function sizeForScale(design: Size, scale: number): Size {
  const s = clampScale(scale);
  return { width: Math.max(1, Math.round(design.width * s)), height: Math.max(1, Math.round(design.height * s)) };
}

export const scaleOf = (design: Size, bounds: Rect): number => bounds.width / design.width;

/** Centres a size in an area (an oversized rectangle overflows equally on both sides). */
export function centreIn(size: Size, area: Rect): Rect {
  return { x: area.x + Math.round((area.width - size.width) / 2), y: area.y + Math.round((area.height - size.height) / 2), width: size.width, height: size.height };
}

/** The largest design-aspect rectangle that fits the area, centred (letterboxed, never stretched). */
export function fitToArea(design: Size, area: Rect): Rect {
  const s = Math.min(area.width / design.width, area.height / design.height);
  const size = { width: Math.min(area.width, Math.max(1, Math.round(design.width * s))), height: Math.min(area.height, Math.max(1, Math.round(design.height * s))) };
  return centreIn(size, area);
}

/** 100 % of the design size, centred on the area (it may overflow a small display). */
export const nativeInArea = (design: Size, area: Rect): Rect => centreIn({ width: design.width, height: design.height }, area);

/** Resizes to a scale around the rectangle's centre. */
export function boundsForScale(design: Size, scale: number, around: Rect): Rect {
  const size = sizeForScale(design, scale);
  return { x: Math.round(around.x + around.width / 2 - size.width / 2), y: Math.round(around.y + around.height / 2 - size.height / 2), width: size.width, height: size.height };
}

/**
 * Moves a rectangle inside the area. Along an axis where it is larger than the area it is centred
 * instead, so equal parts overflow on both sides.
 */
export function clampToArea(rect: Rect, area: Rect): Rect {
  const axis = (pos: number, len: number, start: number, size: number) => (len >= size ? start + Math.round((size - len) / 2) : Math.min(Math.max(pos, start), start + size - len));
  return { x: axis(rect.x, rect.width, area.x, area.width), y: axis(rect.y, rect.height, area.y, area.height), width: rect.width, height: rect.height };
}

export function intersectionArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** The display a rectangle is mostly on; when it is on none, the display nearest to its centre. */
export function displayForRect<D extends DisplayLike>(displays: readonly D[], rect: Rect): D | null {
  let best: D | null = null;
  let bestArea = 0;
  for (const d of displays) {
    const a = intersectionArea(d.bounds, rect);
    if (a > bestArea) [best, bestArea] = [d, a];
  }
  if (best) return best;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  let bestDist = Infinity;
  for (const d of displays) {
    const dx = Math.max(d.bounds.x - cx, 0, cx - (d.bounds.x + d.bounds.width));
    const dy = Math.max(d.bounds.y - cy, 0, cy - (d.bounds.y + d.bounds.height));
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) [best, bestDist] = [d, dist];
  }
  return best;
}

/** The display with that id; the primary when it is gone (or no id is given); the first display otherwise. */
export function pickDisplay<D extends DisplayLike>(displays: readonly D[], id: number | null | undefined, primaryId: number | null): D {
  const found = (id !== null && id !== undefined ? displays.find((d) => d.id === id) : undefined) ?? displays.find((d) => d.id === primaryId) ?? displays[0];
  if (!found) throw new Error("No display is connected.");
  return found;
}

/** Electron display → bridge DisplayInfo. `physical` is the exact pixel rectangle when the platform reports it. */
export function toDisplayInfo(d: DisplayLike & { label?: string; workArea: Rect }, primaryId: number | null, index: number, physical?: Size): DisplayInfo {
  return {
    id: d.id,
    label: d.label?.trim() || `Display ${index + 1}`,
    primary: d.id === primaryId,
    bounds: { ...d.bounds },
    workArea: { ...d.workArea },
    scaleFactor: d.scaleFactor,
    pixels: physical ? { width: physical.width, height: physical.height } : { width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor) },
  };
}

/**
 * How many times to set the bounds when moving a window between displays. Windows re-scales a window
 * that crosses to a display with another scale factor after the first move (WM_DPICHANGED), so the
 * size is set again once the window is on the target display.
 */
export const boundsPasses = (from: DisplayLike | null | undefined, to: DisplayLike): 1 | 2 => (!from || from.scaleFactor !== to.scaleFactor ? 2 : 1);

const placed = (display: DisplayLike, bounds: Rect, design: Size): Placed => ({ displayId: display.id, bounds, scale: scaleOf(design, bounds) });

/**
 * Where an overlay opens: its saved placement on its saved display (same centre and scale, kept on
 * the display), or fitted to the primary display when there is none or that display is gone.
 */
export function resolvePlacement(saved: { displayId: number | null; bounds: Rect; scale: number } | null, design: Size, displays: readonly DisplayLike[], primaryId: number | null): Placed {
  const onSaved = saved && saved.displayId !== null ? displays.find((d) => d.id === saved.displayId) : undefined;
  if (saved && onSaved) {
    const scale = saved.scale > 0 ? saved.scale : scaleOf(design, saved.bounds);
    return placed(onSaved, clampToArea(boundsForScale(design, scale, saved.bounds), onSaved.bounds), design);
  }
  const d = pickDisplay(displays, null, primaryId);
  return placed(d, fitToArea(design, d.bounds), design);
}

/**
 * Carries a rectangle from one display area to another (a display that changed resolution or
 * scaling, or a removed display → the primary): same relative centre, size scaled with the area
 * (aspect kept), then kept inside the new area.
 */
export function remapToArea(rect: Rect, from: Rect, to: Rect): Rect {
  if (from.x === to.x && from.y === to.y && from.width === to.width && from.height === to.height) return clampToArea(rect, to);
  const k = Math.min(to.width / from.width, to.height / from.height);
  const width = Math.max(1, Math.round(rect.width * k));
  const height = Math.max(1, Math.round(rect.height * k));
  const cx = to.x + ((rect.x + rect.width / 2 - from.x) / from.width) * to.width;
  const cy = to.y + ((rect.y + rect.height / 2 - from.y) / from.height) * to.height;
  return clampToArea({ x: Math.round(cx - width / 2), y: Math.round(cy - height / 2), width, height }, to);
}

/**
 * After displays change: null when the overlay's display is unchanged; otherwise its new placement
 * (remapped on its display when that changed, moved to the primary when it was removed).
 */
export function placementAfterDisplayChange(cur: { displayId: number | null; bounds: Rect }, previous: readonly DisplayLike[], displays: readonly DisplayLike[], primaryId: number | null, design: Size): Placed | null {
  const before = previous.find((d) => d.id === cur.displayId) ?? displayForRect(previous, cur.bounds);
  const now = cur.displayId !== null ? displays.find((d) => d.id === cur.displayId) : undefined;
  if (now) {
    const b = before?.bounds;
    if (b && b.x === now.bounds.x && b.y === now.bounds.y && b.width === now.bounds.width && b.height === now.bounds.height) {
      const kept = clampToArea(cur.bounds, now.bounds);
      return kept.x === cur.bounds.x && kept.y === cur.bounds.y ? null : placed(now, kept, design);
    }
    return placed(now, b ? remapToArea(cur.bounds, b, now.bounds) : clampToArea(cur.bounds, now.bounds), design);
  }
  const target = pickDisplay(displays, null, primaryId);
  return placed(target, before ? remapToArea(cur.bounds, before.bounds, target.bounds) : fitToArea(design, target.bounds), design);
}

type GeometryPatch = Pick<OverlayConfigPatch, "displayId" | "bounds" | "scale" | "fit">;

/**
 * Applies the geometry part of a configure patch. Order: display → fit → scale → bounds; the result
 * keeps the design aspect ratio and stays on its display.
 *  - displayId alone: same scale, centred on that display;
 *  - fit "display" / "native": fitted or 100 %, centred;
 *  - scale: resized around the current centre;
 *  - bounds: x/y move the window (the display follows unless displayId is given); width or height
 *    set the scale (width wins), anchored at the top-left.
 */
export function applyPlacementPatch(cur: { displayId: number | null; bounds: Rect }, patch: GeometryPatch, design: Size, displays: readonly DisplayLike[], primaryId: number | null): Placed {
  let display = pickDisplay(displays, patch.displayId ?? cur.displayId, primaryId);
  let bounds = { ...cur.bounds };
  const movedDisplay = patch.displayId !== undefined && display.id === patch.displayId && patch.displayId !== cur.displayId;
  if (patch.fit === "display") bounds = fitToArea(design, display.bounds);
  else if (patch.fit === "native") bounds = nativeInArea(design, display.bounds);
  else if (movedDisplay) bounds = centreIn(sizeForScale(design, scaleOf(design, cur.bounds)), display.bounds);
  if (patch.scale !== undefined) bounds = boundsForScale(design, patch.scale, bounds);
  if (patch.bounds) {
    const b = patch.bounds;
    const scale = b.width !== undefined ? b.width / design.width : b.height !== undefined ? b.height / design.height : scaleOf(design, bounds);
    const size = b.width !== undefined || b.height !== undefined ? sizeForScale(design, scale) : { width: bounds.width, height: bounds.height };
    bounds = { x: Math.round(b.x ?? bounds.x), y: Math.round(b.y ?? bounds.y), ...size };
    if ((b.x !== undefined || b.y !== undefined) && patch.displayId === undefined) display = displayForRect(displays, bounds) ?? display;
  }
  return placed(display, clampToArea(bounds, display.bounds), design);
}

/** A DIP point → physical screen pixels (for input injection on Windows). */
export function dipToScreenPixel(point: { x: number; y: number }, display: DisplayLike): { x: number; y: number } {
  const origin = display.nativeOrigin ?? { x: display.bounds.x, y: display.bounds.y };
  return { x: Math.round(origin.x + (point.x - display.bounds.x) * display.scaleFactor), y: Math.round(origin.y + (point.y - display.bounds.y) * display.scaleFactor) };
}

/** A DIP point → the pixel in a capture of that display taken at its pixel size. */
export function dipToCapturePixel(point: { x: number; y: number }, display: DisplayLike): { x: number; y: number } {
  return { x: Math.round((point.x - display.bounds.x) * display.scaleFactor), y: Math.round((point.y - display.bounds.y) * display.scaleFactor) };
}

/** A point in HUD design coordinates → a DIP point inside an overlay window with these bounds. */
export function designToDip(point: { x: number; y: number }, design: Size, bounds: Rect): { x: number; y: number } {
  const s = Math.min(bounds.width / design.width, bounds.height / design.height);
  const ox = bounds.x + (bounds.width - design.width * s) / 2;
  const oy = bounds.y + (bounds.height - design.height * s) / 2;
  return { x: ox + point.x * s, y: oy + point.y * s };
}
