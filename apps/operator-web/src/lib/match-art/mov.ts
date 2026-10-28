/**
 * A minimal QuickTime (.mov) writer for a video whose frames are PNG pictures with transparency (the
 * "png " codec, 32-bit): a stinger format OBS plays with its alpha through FFmpeg. It needs no video
 * encoder, only the canvas's own PNG export, so it works wherever the program can draw.
 */

export interface PngMovie {
  width: number;
  height: number;
  fps: number;
  /** One PNG file per frame. */
  frames: Uint8Array[];
}

const enc = new TextEncoder();

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0);
  return b;
}
function u16(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n & 0xffff);
  return b;
}
const zeros = (n: number) => new Uint8Array(n);
const fourcc = (s: string) => enc.encode(s);

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function atom(type: string, body: Uint8Array | Uint8Array[]): Uint8Array {
  const data = Array.isArray(body) ? concat(body) : body;
  return concat([u32(8 + data.length), fourcc(type), data]);
}

/** The identity transformation matrix (16.16 and 2.30 fixed point). */
const MATRIX = concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);

/** A Pascal string padded to `size` bytes. */
function pstring(s: string, size: number): Uint8Array {
  const b = new Uint8Array(size);
  const t = enc.encode(s).subarray(0, size - 1);
  b[0] = t.length;
  b.set(t, 1);
  return b;
}

export function writePngMov(m: PngMovie): Uint8Array {
  if (!m.frames.length) throw new Error("no frames");
  const timescale = m.fps * 100;
  const frameDuration = 100;
  const duration = m.frames.length * frameDuration;
  const ftyp = atom("ftyp", [fourcc("qt  "), u32(0x200), fourcc("qt  ")]);
  // Frames go in one mdat right after ftyp; each one's offset in the file is recorded in stco.
  const mdatHeader = 8;
  let offset = ftyp.length + mdatHeader;
  const offsets: number[] = [];
  for (const f of m.frames) {
    offsets.push(offset);
    offset += f.length;
  }
  const mdat = concat([u32(mdatHeader + m.frames.reduce((n, f) => n + f.length, 0)), fourcc("mdat"), ...m.frames]);

  const mvhd = atom("mvhd", [u32(0), u32(0), u32(0), u32(timescale), u32(duration), u32(0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(2)]);
  const tkhd = atom("tkhd", [u32(0x00000003), u32(0), u32(0), u32(1), u32(0), u32(duration), zeros(8), u16(0), u16(0), u16(0), u16(0), MATRIX, u32(m.width << 16), u32(m.height << 16)]);
  const mdhd = atom("mdhd", [u32(0), u32(0), u32(0), u32(timescale), u32(duration), u16(0), u16(0)]);
  const hdlr = atom("hdlr", [u32(0), fourcc("mhlr"), fourcc("vide"), u32(0), u32(0), u32(0), pstring("VideoHandler", 13)]);
  const vmhd = atom("vmhd", [u32(0x00000001), u16(0x0040), u16(0), u16(0), u16(0)]);
  const dhlr = atom("hdlr", [u32(0), fourcc("dhlr"), fourcc("alis"), u32(0), u32(0), u32(0), pstring("DataHandler", 12)]);
  const dinf = atom("dinf", atom("dref", [u32(0), u32(1), atom("alis", u32(0x00000001))]));
  const sampleEntry = concat([
    zeros(6),
    u16(1), // data reference index
    u16(0), // version
    u16(0), // revision
    fourcc("FFMP"), // vendor
    u32(0), // temporal quality
    u32(512), // spatial quality
    u16(m.width),
    u16(m.height),
    u32(72 << 16),
    u32(72 << 16),
    u32(0), // data size
    u16(1), // frames per sample
    pstring("PNG", 32),
    u16(32), // depth: 32 bits, with alpha
    u16(0xffff), // no colour table
  ]);
  const stsd = atom("stsd", [u32(0), u32(1), u32(8 + sampleEntry.length), fourcc("png "), sampleEntry]);
  const stts = atom("stts", [u32(0), u32(1), u32(m.frames.length), u32(frameDuration)]);
  const stsc = atom("stsc", [u32(0), u32(1), u32(1), u32(1), u32(1)]);
  const stsz = atom("stsz", [u32(0), u32(0), u32(m.frames.length), ...m.frames.map((f) => u32(f.length))]);
  const stco = atom("stco", [u32(0), u32(offsets.length), ...offsets.map((o) => u32(o))]);
  const stbl = atom("stbl", [stsd, stts, stsc, stsz, stco]);
  const minf = atom("minf", [vmhd, dhlr, dinf, stbl]);
  const mdia = atom("mdia", [mdhd, hdlr, minf]);
  const trak = atom("trak", [tkhd, mdia]);
  const moov = atom("moov", [mvhd, trak]);
  return concat([ftyp, mdat, moov]);
}
