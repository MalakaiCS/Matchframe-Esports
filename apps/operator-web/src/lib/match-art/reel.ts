import type { HudReplayClip } from "@matchframe/hud-sdk";
import { drawReelGraphic, REEL_GRAPHIC } from "./highlight.ts";
import { FAMILY, loadFonts, loadImage } from "./make.ts";

/** PNG bytes as base64 (what the reel request carries). */
async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Each planned clip's lower third as a PNG (base64), by clip id, drawn on one canvas in turn. The
 * team logos are loaded once each.
 */
export async function drawReelGraphics(clips: { id: string; graphic: HudReplayClip }[], onProgress?: (done: number) => void): Promise<Record<string, string>> {
  await loadFonts();
  const canvas = new OffscreenCanvas(REEL_GRAPHIC.width, REEL_GRAPHIC.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("This computer can't draw the graphics (no 2D canvas).");
  const logos = new Map<string, Promise<HTMLImageElement | null>>();
  const out: Record<string, string> = {};
  for (const [i, c] of clips.entries()) {
    if (!c.graphic.player) continue;
    const url = c.graphic.team?.logoUrl ?? null;
    if (url && !logos.has(url)) logos.set(url, loadImage(url));
    drawReelGraphic(ctx, c.graphic, url ? await logos.get(url)! : null, FAMILY);
    out[c.id] = await base64(await canvas.convertToBlob({ type: "image/png" }));
    onProgress?.(i + 1);
  }
  return out;
}
