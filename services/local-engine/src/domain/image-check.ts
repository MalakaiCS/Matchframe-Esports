/**
 * Checks an uploaded logo or avatar from its bytes (never its name or the browser's type): PNG,
 * JPEG or WebP, by signature, with the picture's real size read from the file's own header
 * structure. Anything else, a truncated file or an impossible size is refused with a message an
 * operator can act on.
 */

export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
/** Larger pictures are refused (they are logos and avatars, not photos for print). */
export const IMAGE_MAX_SIDE = 8192;

export type ImageType = "png" | "jpeg" | "webp";

export interface ImageInfo {
  type: ImageType;
  ext: ".png" | ".jpg" | ".webp";
  mime: string;
  width: number;
  height: number;
  bytes: number;
}

export class ImageCheckError extends Error {
  readonly status = 400;
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

let crcTable: Uint32Array | null = null;
function crc32(buf: Uint8Array, start: number, end: number): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = crcTable[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function png(b: Buffer): { width: number; height: number } {
  // Walk the chunks: IHDR first (CRC checked), at least one IDAT, and IEND at the end.
  let p = 8;
  let width = 0;
  let height = 0;
  let sawData = false;
  let first = true;
  while (p + 12 <= b.length) {
    const len = b.readUInt32BE(p);
    const type = b.toString("latin1", p + 4, p + 8);
    if (p + 12 + len > b.length) throw new ImageCheckError("truncated", "The PNG file is cut off (incomplete upload or damaged file).");
    if (first) {
      if (type !== "IHDR" || len !== 13) throw new ImageCheckError("bad_image", "The PNG file has no valid header (IHDR).");
      if (crc32(b, p + 4, p + 8 + len) !== b.readUInt32BE(p + 8 + len)) throw new ImageCheckError("bad_image", "The PNG header is damaged (checksum mismatch).");
      width = b.readUInt32BE(p + 8);
      height = b.readUInt32BE(p + 12);
      first = false;
    }
    if (type === "IDAT") sawData = true;
    if (type === "IEND") {
      if (!sawData) throw new ImageCheckError("bad_image", "The PNG file has no picture data.");
      return { width, height };
    }
    p += 12 + len;
  }
  throw new ImageCheckError("truncated", "The PNG file is cut off (no end marker).");
}

function jpeg(b: Buffer): { width: number; height: number } {
  // Segments from SOI to the first start-of-frame marker (which holds the size).
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) throw new ImageCheckError("bad_image", "The JPEG file is damaged (bad segment marker).");
    let marker = b[p + 1]!;
    while (marker === 0xff && p + 2 < b.length) {
      p++;
      marker = b[p + 1]!;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      p += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const len = b.readUInt16BE(p + 2);
    if (len < 2 || p + 2 + len > b.length) throw new ImageCheckError("truncated", "The JPEG file is cut off (incomplete upload or damaged file).");
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (len < 8) throw new ImageCheckError("bad_image", "The JPEG frame header is damaged.");
      const height = b.readUInt16BE(p + 5);
      const width = b.readUInt16BE(p + 7);
      // A complete JPEG ends with the end-of-image marker (some writers add a few bytes after it).
      const tail = b.subarray(Math.max(0, b.length - 64));
      if (tail.indexOf(Buffer.from([0xff, 0xd9])) < 0) throw new ImageCheckError("truncated", "The JPEG file is cut off (no end marker).");
      return { width, height };
    }
    p += 2 + len;
  }
  throw new ImageCheckError("bad_image", "The JPEG file has no frame header (no picture size).");
}

function webp(b: Buffer): { width: number; height: number } {
  const riffSize = b.readUInt32LE(4);
  if (riffSize + 8 > b.length) throw new ImageCheckError("truncated", "The WebP file is cut off (incomplete upload or damaged file).");
  const chunk = b.toString("latin1", 12, 16);
  const d = 20;
  if (chunk === "VP8 ") {
    if (b.length < d + 10 || b[d + 3] !== 0x9d || b[d + 4] !== 0x01 || b[d + 5] !== 0x2a) throw new ImageCheckError("bad_image", "The WebP (lossy) frame header is damaged.");
    return { width: b.readUInt16LE(d + 6) & 0x3fff, height: b.readUInt16LE(d + 8) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (b.length < d + 5 || b[d] !== 0x2f) throw new ImageCheckError("bad_image", "The WebP (lossless) header is damaged.");
    const bits = b.readUInt32LE(d + 1);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    if (b.length < d + 10) throw new ImageCheckError("bad_image", "The WebP (extended) header is damaged.");
    return { width: b.readUIntLE(d + 4, 3) + 1, height: b.readUIntLE(d + 7, 3) + 1 };
  }
  throw new ImageCheckError("bad_image", "The WebP file has no picture data.");
}

/** Checks the bytes; throws ImageCheckError with a readable message when they are not a usable image. */
export function inspectImage(body: Buffer): ImageInfo {
  if (body.length === 0) throw new ImageCheckError("empty", "The file is empty.");
  if (body.length > IMAGE_MAX_BYTES) throw new ImageCheckError("too_large", `The image is ${(body.length / 1024 / 1024).toFixed(1)} MB; the limit is 2 MB. Save it smaller (a 512 × 512 PNG or WebP is plenty).`);
  let type: ImageType;
  let size: { width: number; height: number };
  if (body.length >= 33 && PNG_SIG.every((v, i) => body[i] === v)) {
    type = "png";
    size = png(body);
  } else if (body.length >= 4 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) {
    type = "jpeg";
    size = jpeg(body);
  } else if (body.length >= 30 && body.toString("latin1", 0, 4) === "RIFF" && body.toString("latin1", 8, 12) === "WEBP") {
    type = "webp";
    size = webp(body);
  } else {
    const hint = body.toString("latin1", 0, 5).toLowerCase().startsWith("<svg") || body.toString("latin1", 0, 5) === "<?xml" ? " SVG is not accepted here; export it as PNG." : body.toString("latin1", 0, 3) === "GIF" ? " GIF is not accepted; save it as PNG." : "";
    throw new ImageCheckError("bad_type", `This file is not a PNG, JPEG or WebP image.${hint}`);
  }
  if (size.width < 1 || size.height < 1) throw new ImageCheckError("bad_image", "The image has no size (0 pixels).");
  if (size.width > IMAGE_MAX_SIDE || size.height > IMAGE_MAX_SIDE) throw new ImageCheckError("too_big_dimensions", `The image is ${size.width} × ${size.height} pixels; the limit is ${IMAGE_MAX_SIDE} on each side.`);
  const ext = type === "png" ? ".png" : type === "jpeg" ? ".jpg" : ".webp";
  return { type, ext, mime: type === "png" ? "image/png" : type === "jpeg" ? "image/jpeg" : "image/webp", width: size.width, height: size.height, bytes: body.length };
}

/** Advice for the editor (not an error): small or far-from-square pictures. */
export function imageAdvice(info: Pick<ImageInfo, "width" | "height">): string | null {
  const ratio = info.width / info.height;
  if (Math.min(info.width, info.height) < 200) return `The image is ${info.width} × ${info.height}; 200 × 200 or larger looks sharper on air.`;
  if (ratio > 1.25 || ratio < 0.8) return `The image is ${info.width} × ${info.height}; a square image fits best (it is shown whole, with space around it).`;
  return null;
}
