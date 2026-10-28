import { describe, expect, it } from "vitest";
import { writePngMov } from "./mov.ts";

interface Atom {
  type: string;
  start: number;
  end: number;
}

/** Atoms between `start` and `end` (one level). */
function atoms(b: Uint8Array, start = 0, end = b.length): Atom[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: Atom[] = [];
  for (let o = start; o < end; ) {
    const size = v.getUint32(o);
    out.push({ type: new TextDecoder().decode(b.subarray(o + 4, o + 8)), start: o + 8, end: o + size });
    o += size;
  }
  return out;
}
const child = (b: Uint8Array, parent: Atom, type: string) => atoms(b, parent.start, parent.end).find((a) => a.type === type)!;
const u32 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(o);
const u16 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint16(o);

const png = (n: number) => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, n, n]);

describe("QuickTime file of PNG frames (OBS Stinger)", () => {
  it("stores every frame in order and points at each from the sample table", () => {
    const frames = Array.from({ length: 96 }, (_, i) => png(i));
    const mov = writePngMov({ width: 1920, height: 1080, fps: 60, frames });
    const top = atoms(mov);
    expect(top.map((a) => a.type)).toEqual(["ftyp", "mdat", "moov"]);
    const moov = top[2]!;
    const mvhd = child(mov, moov, "mvhd");
    // Time scale 6000, 96 frames of 100: 1.6 s.
    expect([u32(mov, mvhd.start + 12), u32(mov, mvhd.start + 16)]).toEqual([6000, 9600]);
    const trak = child(mov, moov, "trak");
    const tkhd = child(mov, trak, "tkhd");
    expect([u32(mov, tkhd.end - 8) >>> 16, u32(mov, tkhd.end - 4) >>> 16]).toEqual([1920, 1080]);
    const stbl = child(mov, child(mov, child(mov, trak, "mdia"), "minf"), "stbl");
    const stsd = child(mov, stbl, "stsd");
    const entry = stsd.start + 8;
    expect(new TextDecoder().decode(mov.subarray(entry + 4, entry + 8))).toBe("png ");
    // Width, height, and a 32-bit depth (with alpha).
    expect([u16(mov, entry + 8 + 24), u16(mov, entry + 8 + 26), u16(mov, entry + 8 + 74)]).toEqual([1920, 1080, 32]);
    const stts = child(mov, stbl, "stts");
    expect([u32(mov, stts.start + 8), u32(mov, stts.start + 12)]).toEqual([96, 100]);
    const stsz = child(mov, stbl, "stsz");
    const stco = child(mov, stbl, "stco");
    expect(u32(mov, stsz.start + 8)).toBe(96);
    expect(u32(mov, stco.start + 4)).toBe(96);
    frames.forEach((f, i) => {
      const size = u32(mov, stsz.start + 12 + i * 4);
      const offset = u32(mov, stco.start + 8 + i * 4);
      expect(size).toBe(f.length);
      expect([...mov.subarray(offset, offset + size)]).toEqual([...f]);
    });
  });
});
