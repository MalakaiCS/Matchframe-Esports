/**
 * A minimal WebM (Matroska) writer for a VP8 video with an alpha channel, the format OBS's Stinger
 * transition plays with transparency: each frame's colour is a VP8 frame in the Block, and its alpha
 * is a second VP8 frame (the alpha as the picture's brightness) in BlockAdditions with BlockAddID 1,
 * on a track marked AlphaMode 1. FFmpeg's libvpx decoder (which OBS uses for such files) decodes
 * both and puts them together.
 *
 * Browsers' WebCodecs can't encode alpha themselves, so the caller encodes two VP8 streams and gives
 * them here frame by frame.
 */

export interface AlphaFrame {
  /** VP8 colour frame. */
  color: Uint8Array;
  /** VP8 frame whose brightness is the alpha (same size and keyframes as the colour frame). */
  alpha: Uint8Array;
  key: boolean;
  /** Presentation time in milliseconds. */
  timeMs: number;
}

export interface WebmVideo {
  width: number;
  height: number;
  /** Frames per second (for DefaultDuration and the file's duration). */
  fps: number;
  frames: AlphaFrame[];
  app?: string;
}

const enc = new TextEncoder();

/** EBML variable-length size: the shortest form that holds `n`. */
function vsize(n: number): Uint8Array {
  for (let len = 1; len <= 8; len++) {
    // All-ones in the value bits is reserved (unknown size).
    if (n < 2 ** (7 * len) - 1) {
      const out = new Uint8Array(len);
      let v = n;
      for (let i = len - 1; i >= 0; i--) {
        out[i] = v & 0xff;
        v = Math.floor(v / 256);
      }
      out[0]! |= 1 << (8 - len);
      return out;
    }
  }
  throw new Error(`EBML size too large: ${n}`);
}

function idBytes(id: number): Uint8Array {
  const out: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return Uint8Array.from(out);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function el(id: number, body: Uint8Array | Uint8Array[]): Uint8Array {
  const data = Array.isArray(body) ? concat(body) : body;
  return concat([idBytes(id), vsize(data.length), data]);
}

function uint(id: number, n: number): Uint8Array {
  const bytes: number[] = [];
  let v = n;
  do {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  } while (v > 0);
  return el(id, Uint8Array.from(bytes));
}

function int(id: number, n: number): Uint8Array {
  // Two's complement in the fewest bytes (up to 4 here: block timestamps).
  for (let len = 1; len <= 4; len++) {
    const lim = 2 ** (8 * len - 1);
    if (n >= -lim && n < lim) {
      const out = new Uint8Array(len);
      let v = n < 0 ? 2 ** (8 * len) + n : n;
      for (let i = len - 1; i >= 0; i--) {
        out[i] = v & 0xff;
        v = Math.floor(v / 256);
      }
      return el(id, out);
    }
  }
  throw new Error(`int too large: ${n}`);
}

function float(id: number, n: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, n);
  return el(id, b);
}

const str = (id: number, s: string) => el(id, enc.encode(s));

/** Element ids (Matroska / WebM). */
export const ID = {
  EBML: 0x1a45dfa3,
  EBMLVersion: 0x4286,
  EBMLReadVersion: 0x42f7,
  EBMLMaxIDLength: 0x42f2,
  EBMLMaxSizeLength: 0x42f3,
  DocType: 0x4282,
  DocTypeVersion: 0x4287,
  DocTypeReadVersion: 0x4285,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Duration: 0x4489,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83,
  FlagLacing: 0x9c,
  CodecID: 0x86,
  DefaultDuration: 0x23e383,
  MaxBlockAdditionID: 0x55ee,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  AlphaMode: 0x53c0,
  Cluster: 0x1f43b675,
  Timestamp: 0xe7,
  BlockGroup: 0xa0,
  Block: 0xa1,
  ReferenceBlock: 0xfb,
  BlockAdditions: 0x75a1,
  BlockMore: 0xa6,
  BlockAddID: 0xee,
  BlockAdditional: 0xa5,
} as const;

/** Clusters hold at most this much time (a Block's timestamp is a signed 16-bit offset). */
const CLUSTER_MS = 5000;

export function writeAlphaWebm(v: WebmVideo): Uint8Array {
  if (!v.frames.length) throw new Error("no frames");
  const frameMs = 1000 / v.fps;
  const header = el(ID.EBML, [uint(ID.EBMLVersion, 1), uint(ID.EBMLReadVersion, 1), uint(ID.EBMLMaxIDLength, 4), uint(ID.EBMLMaxSizeLength, 8), str(ID.DocType, "webm"), uint(ID.DocTypeVersion, 4), uint(ID.DocTypeReadVersion, 2)]);
  const last = v.frames[v.frames.length - 1]!;
  const info = el(ID.Info, [uint(ID.TimestampScale, 1_000_000), float(ID.Duration, last.timeMs + frameMs), str(ID.MuxingApp, v.app ?? "Matchframe"), str(ID.WritingApp, v.app ?? "Matchframe")]);
  const track = el(ID.TrackEntry, [
    uint(ID.TrackNumber, 1),
    uint(ID.TrackUID, 1),
    uint(ID.TrackType, 1),
    uint(ID.FlagLacing, 0),
    str(ID.CodecID, "V_VP8"),
    uint(ID.DefaultDuration, Math.round(1e9 / v.fps)),
    uint(ID.MaxBlockAdditionID, 1),
    el(ID.Video, [uint(ID.PixelWidth, v.width), uint(ID.PixelHeight, v.height), uint(ID.AlphaMode, 1)]),
  ]);
  const tracks = el(ID.Tracks, track);
  const clusters: Uint8Array[] = [];
  let i = 0;
  while (i < v.frames.length) {
    const start = Math.round(v.frames[i]!.timeMs);
    const groups: Uint8Array[] = [uint(ID.Timestamp, start)];
    let prevMs: number | null = null;
    while (i < v.frames.length && Math.round(v.frames[i]!.timeMs) - start < CLUSTER_MS) {
      const f = v.frames[i]!;
      const t = Math.round(f.timeMs);
      const rel = t - start;
      // Block: track number 1, 16-bit relative timestamp, flags (none: no lacing), the frame.
      const head = new Uint8Array(4);
      head[0] = 0x81;
      new DataView(head.buffer).setInt16(1, rel);
      head[3] = 0;
      const parts = [el(ID.Block, [head, f.color])];
      // A frame that isn't a keyframe refers to the one before it.
      if (!f.key) parts.push(int(ID.ReferenceBlock, (prevMs ?? t - Math.round(frameMs)) - t));
      parts.push(el(ID.BlockAdditions, el(ID.BlockMore, [uint(ID.BlockAddID, 1), el(ID.BlockAdditional, f.alpha)])));
      groups.push(el(ID.BlockGroup, parts));
      prevMs = t;
      i++;
    }
    clusters.push(el(ID.Cluster, groups));
  }
  return concat([header, el(ID.Segment, [info, tracks, ...clusters])]);
}

/** Reads back the elements of a file this module wrote (for checks): id, offset, size, children. */
export interface EbmlNode {
  id: number;
  size: number;
  data: Uint8Array;
  children?: EbmlNode[];
}

const MASTER = new Set<number>([ID.EBML, ID.Segment, ID.Info, ID.Tracks, ID.TrackEntry, ID.Video, ID.Cluster, ID.BlockGroup, ID.BlockAdditions, ID.BlockMore]);

export function readEbml(buf: Uint8Array, start = 0, end = buf.length): EbmlNode[] {
  const out: EbmlNode[] = [];
  let o = start;
  while (o < end) {
    // Id: its length is given by the first byte's leading zeros, like a size.
    const first = buf[o]!;
    let idLen = 1;
    while (idLen <= 4 && !(first & (0x80 >> (idLen - 1)))) idLen++;
    let id = 0;
    for (let k = 0; k < idLen; k++) id = id * 256 + buf[o + k]!;
    o += idLen;
    const s0 = buf[o]!;
    let sLen = 1;
    while (sLen <= 8 && !(s0 & (0x80 >> (sLen - 1)))) sLen++;
    let size = s0 & ((0x80 >> (sLen - 1)) - 1);
    for (let k = 1; k < sLen; k++) size = size * 256 + buf[o + k]!;
    o += sLen;
    const data = buf.subarray(o, o + size);
    out.push(MASTER.has(id) ? { id, size, data, children: readEbml(buf, o, o + size) } : { id, size, data });
    o += size;
  }
  return out;
}
