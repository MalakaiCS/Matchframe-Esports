import { describe, expect, it } from "vitest";
import { rgbaToI420Pair } from "./encode.ts";
import type { EbmlNode } from "./webm.ts";
import { ID, readEbml, writeAlphaWebm } from "./webm.ts";

const find = (nodes: EbmlNode[] | undefined, id: number) => nodes?.find((n) => n.id === id);
const all = (nodes: EbmlNode[] | undefined, id: number) => nodes?.filter((n) => n.id === id) ?? [];
const uintOf = (n: EbmlNode | undefined) => (n ? [...n.data].reduce((v, b) => v * 256 + b, 0) : null);
const text = (n: EbmlNode | undefined) => (n ? new TextDecoder().decode(n.data) : null);

function frames(count: number, fps = 60) {
  return Array.from({ length: count }, (_, i) => ({ color: Uint8Array.from([0xc0, i, 1, 2, 3]), alpha: Uint8Array.from([0xa0, i, 9]), key: i % 30 === 0, timeMs: (i * 1000) / fps }));
}

describe("WebM with alpha (OBS Stinger format)", () => {
  it("marks a VP8 track with alpha and puts each frame's alpha in BlockAdditions (BlockAddID 1)", () => {
    const f = frames(64);
    const file = writeAlphaWebm({ width: 1920, height: 1080, fps: 60, frames: f });
    const [ebml, segment] = readEbml(file);
    expect(text(find(ebml!.children, ID.DocType))).toBe("webm");
    const tracks = find(segment!.children, ID.Tracks);
    const track = find(tracks!.children, ID.TrackEntry)!;
    expect(text(find(track.children, ID.CodecID))).toBe("V_VP8");
    expect(uintOf(find(track.children, ID.MaxBlockAdditionID))).toBe(1);
    const video = find(track.children, ID.Video)!;
    expect([uintOf(find(video.children, ID.PixelWidth)), uintOf(find(video.children, ID.PixelHeight)), uintOf(find(video.children, ID.AlphaMode))]).toEqual([1920, 1080, 1]);
    const info = find(segment!.children, ID.Info)!;
    expect(new DataView(find(info.children, ID.Duration)!.data.slice().buffer).getFloat64(0)).toBeCloseTo((64 * 1000) / 60, 3);
    const groups = all(segment!.children, ID.Cluster).flatMap((c) => all(c.children, ID.BlockGroup));
    expect(groups).toHaveLength(64);
    groups.forEach((g, i) => {
      const block = find(g.children, ID.Block)!;
      // Track 1, relative timestamp, no lacing, then the colour frame.
      expect(block.data[0]).toBe(0x81);
      expect(block.data[3]).toBe(0);
      expect([...block.data.subarray(4)]).toEqual([...f[i]!.color]);
      expect(Math.round(new DataView(block.data.slice().buffer).getInt16(1))).toBe(Math.round(f[i]!.timeMs));
      // Keyframes have no ReferenceBlock; the others refer back one frame.
      expect(Boolean(find(g.children, ID.ReferenceBlock))).toBe(!f[i]!.key);
      const more = find(find(g.children, ID.BlockAdditions)!.children, ID.BlockMore)!;
      expect(uintOf(find(more.children, ID.BlockAddID))).toBe(1);
      expect([...find(more.children, ID.BlockAdditional)!.data]).toEqual([...f[i]!.alpha]);
    });
  });

  it("starts a new cluster every 5 s (block timestamps are 16-bit offsets)", () => {
    const file = writeAlphaWebm({ width: 64, height: 64, fps: 30, frames: frames(400, 30) });
    const segment = readEbml(file)[1]!;
    const clusters = all(segment.children, ID.Cluster);
    expect(clusters.length).toBe(3);
    expect(clusters.map((c) => uintOf(find(c.children, ID.Timestamp)))).toEqual([0, 5000, 10000]);
    expect(clusters.flatMap((c) => all(c.children, ID.BlockGroup))).toHaveLength(400);
  });
});

describe("canvas pixels to the colour and alpha pictures", () => {
  it("keeps the alpha exactly (full range) and the colour in VP8's range", () => {
    // 2×2: opaque white, half-transparent white, fully transparent, opaque black.
    const px = Uint8ClampedArray.from([255, 255, 255, 255, 255, 255, 255, 128, 0, 0, 0, 0, 0, 0, 0, 255]);
    const { color, alpha } = rgbaToI420Pair(px, 2, 2);
    expect([...alpha.subarray(0, 4)]).toEqual([255, 128, 0, 255]);
    // The alpha picture is grey: no colour.
    expect([...alpha.subarray(4)]).toEqual([128, 128]);
    expect(color[0]).toBe(235);
    expect(color[3]).toBe(16);
  });

  it("takes an edge's colour from its visible pixels, not the black around it", () => {
    const red = [230, 20, 20, 255];
    const clear = [0, 0, 0, 0];
    const { color } = rgbaToI420Pair(Uint8ClampedArray.from([...red, ...clear, ...clear, ...clear]), 2, 2);
    const { color: solid } = rgbaToI420Pair(Uint8ClampedArray.from([...red, ...red, ...red, ...red]), 2, 2);
    expect(Math.abs(color[4]! - solid[4]!)).toBeLessThanOrEqual(1);
    expect(Math.abs(color[5]! - solid[5]!)).toBeLessThanOrEqual(1);
  });
});
