/**
 * Match graphics drawn on a canvas: YouTube-style thumbnails (1280×720), an "Up next" screen
 * (1920×1080) and the frames of the two stinger transitions (1920×1080 with transparency). Original
 * Matchframe designs: team-colour panels, logo cards with name bars, a big two-tone headline.
 */

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface ArtTeam {
  name: string;
  shortName: string;
  /** Team colour (#rrggbb), or null for the default of its side. */
  color: string | null;
  /** The decoded logo, or null for the "?" placeholder. */
  logo: CanvasImageSource | null;
  /** The logo's average colour (#rrggbb), to keep it visible on its own team colour. */
  logoColor?: string | null;
}

export interface ArtInput {
  a: ArtTeam;
  b: ArtTeam;
  /** Match title ("Grand final") or null. */
  title: string | null;
  eventName: string | null;
  eventLogo: CanvasImageSource | null;
  /** Highlight colour of the headline (#rrggbb). */
  accent: string;
  bestOf: number;
  scheduledAt: string | null;
  /** Optional photo behind the thumbnails (a game screenshot); drawn darkened. */
  background: CanvasImageSource | null;
  /** Font family names (loaded by the caller). */
  fonts: { display: string; text: string };
}

export type ThumbnailKind = "highlights" | "replay" | "live";

export const THUMBNAILS: { kind: ThumbnailKind; words: [string, string] }[] = [
  { kind: "highlights", words: ["MATCH", "HIGHLIGHTS"] },
  { kind: "replay", words: ["FULL", "REPLAY"] },
  { kind: "live", words: ["LIVE", "NOW"] },
];

/**
 * Stinger timing. OBS starts the video a little after the transition starts (more on a busy computer)
 * but cuts at a fixed time from the start and ends the transition at the video's length + 250 ms, so
 * the video only ever runs late against OBS's clock: the screen is covered from 400 to 1000 ms with
 * the cut at 900 ms (safe up to ~500 ms late), and the animation is over by 1300 ms (a see-through
 * tail OBS may cut short).
 */
export const STINGER = { width: 1920, height: 1080, fps: 60, durationMs: 1600, transitionPointMs: 900 } as const;

const DEFAULT_A = "#2f6fe0";
const DEFAULT_B = "#e0492f";
const INK = "#0b0d12";

// ------------------------------------------------------------------ colour helpers

function rgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const n = m ? parseInt(m[1]!, 16) : 0x888888;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(hex: string, other: string, t: number): string {
  const a = rgb(hex);
  const b = rgb(other);
  const c = a.map((v, i) => Math.round(v + (b[i]! - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The two teams' colours, kept apart when both are (nearly) the same. */
export function teamColors(a: ArtTeam, b: ArtTeam): [string, string] {
  const ca = a.color ?? DEFAULT_A;
  let cb = b.color ?? DEFAULT_B;
  const [r1, g1, b1] = rgb(ca);
  const [r2, g2, b2] = rgb(cb);
  if (Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2) < 90) cb = ca.toLowerCase() === DEFAULT_B ? DEFAULT_A : DEFAULT_B;
  return [ca, cb];
}

/** Text colour readable on `bg`. */
const onColor = (bg: string) => (luminance(bg) > 0.45 ? INK : "#ffffff");

// ------------------------------------------------------------------ drawing helpers

/** A small deterministic random sequence (the same picture every time for the same match). */
function seeded(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

function poly(ctx: Ctx, pts: [number, number][]): void {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
}

function imageSize(img: CanvasImageSource): [number, number] {
  const i = img as { naturalWidth?: number; naturalHeight?: number; width?: number | { baseVal: { value: number } }; height?: number | { baseVal: { value: number } }; displayWidth?: number; displayHeight?: number };
  const w = i.naturalWidth || i.displayWidth || (typeof i.width === "number" ? i.width : 0);
  const h = i.naturalHeight || i.displayHeight || (typeof i.height === "number" ? i.height : 0);
  return [w || 1, h || 1];
}

function cover(ctx: Ctx, img: CanvasImageSource, w: number, h: number): void {
  const [iw, ih] = imageSize(img);
  const s = Math.max(w / iw, h / ih);
  ctx.drawImage(img, (w - iw * s) / 2, (h - ih * s) / 2, iw * s, ih * s);
}

/** Fits text into `maxW` by lowering the size; returns the size used. */
function fitFont(ctx: Ctx, text: string, family: string, weight: string, size: number, maxW: number, italic = false): number {
  let s = size;
  for (;;) {
    ctx.font = `${italic ? "italic " : ""}${weight} ${s}px "${family}"`;
    if (ctx.measureText(text).width <= maxW || s <= 10) return s;
    s = Math.floor(s * 0.94);
  }
}

function distance(a: string, b: string): number {
  const x = rgb(a);
  const y = rgb(b);
  return Math.abs(x[0] - y[0]) + Math.abs(x[1] - y[1]) + Math.abs(x[2] - y[2]);
}

/**
 * A soft plate behind a logo that is nearly the colour it sits on (a red logo on a red panel): dark
 * behind a lighter logo, light behind a darker one.
 */
function contrastPlate(ctx: Ctx, team: ArtTeam, under: string, cx: number, cy: number, box: number): void {
  if (!team.logo || !team.logoColor || distance(team.logoColor, under) > 150) return;
  const dark = luminance(team.logoColor) >= luminance(under);
  const g = ctx.createRadialGradient(cx, cy, box * 0.1, cx, cy, box * 0.72);
  g.addColorStop(0, dark ? "rgba(8,10,14,0.78)" : "rgba(255,255,255,0.85)");
  g.addColorStop(0.65, dark ? "rgba(8,10,14,0.55)" : "rgba(255,255,255,0.55)");
  g.addColorStop(1, dark ? "rgba(8,10,14,0)" : "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(cx - box, cy - box, box * 2, box * 2);
}

/** A team logo fitted in a box, or a "?" badge when the team has none. */
export function drawLogo(ctx: Ctx, team: ArtTeam, cx: number, cy: number, box: number, fonts: ArtInput["fonts"], fg = "#ffffff"): void {
  ctx.save();
  if (team.logo) {
    const [iw, ih] = imageSize(team.logo);
    const s = Math.min(box / iw, box / ih);
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = box * 0.06;
    ctx.shadowOffsetY = box * 0.025;
    ctx.drawImage(team.logo, cx - (iw * s) / 2, cy - (ih * s) / 2, iw * s, ih * s);
  } else {
    // Placeholder: a hexagon outline with a question mark.
    const r = box * 0.46;
    const pts: [number, number][] = [];
    for (let k = 0; k < 6; k++) {
      const ang = Math.PI / 6 + (k * Math.PI) / 3;
      pts.push([cx + r * Math.cos(ang), cy + r * Math.sin(ang)]);
    }
    poly(ctx, pts);
    ctx.fillStyle = "rgba(255,255,255,0.10)";
    ctx.fill();
    ctx.lineWidth = Math.max(2, box * 0.035);
    ctx.strokeStyle = fg;
    ctx.stroke();
    ctx.fillStyle = fg;
    ctx.font = `800 ${Math.round(box * 0.62)}px "${fonts.display}"`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("?", cx, cy + box * 0.03);
  }
  ctx.restore();
}

/** Heavy outlined headline text with a hard offset shadow; returns its width. */
function headline(ctx: Ctx, text: string, x: number, y: number, size: number, fill: string, family: string, align: CanvasTextAlign = "left"): number {
  ctx.save();
  ctx.font = `italic 800 ${size}px "${family}"`;
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  ctx.lineJoin = "round";
  const w = ctx.measureText(text).width;
  // Hard shadow, then a thick dark outline, then the fill.
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillText(text, x + size * 0.05, y + size * 0.06);
  ctx.strokeStyle = INK;
  ctx.lineWidth = size * 0.11;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
  ctx.restore();
  return w;
}

/** Diagonal stripes over an area (texture). */
function stripes(ctx: Ctx, w: number, h: number, gap: number, color: string): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = gap * 0.18;
  ctx.beginPath();
  for (let x = -h; x < w; x += gap) {
    ctx.moveTo(x, h);
    ctx.lineTo(x + h * 0.45, 0);
  }
  ctx.stroke();
  ctx.restore();
}

/** Background shared by the stills: team-colour halves split on a slant (or a darkened photo). */
function background(ctx: Ctx, w: number, h: number, input: ArtInput, seed: string): void {
  const [ca, cb] = teamColors(input.a, input.b);
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, w, h);
  if (input.background) {
    cover(ctx, input.background, w, h);
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "rgba(8,10,14,0.55)");
    g.addColorStop(0.55, "rgba(8,10,14,0.35)");
    g.addColorStop(1, "rgba(8,10,14,0.85)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // A wash of each team's colour on its side.
    const side = ctx.createLinearGradient(0, 0, w, 0);
    side.addColorStop(0, mix(ca, "#000000", 0.2).replace("rgb", "rgba").replace(")", ",0.45)"));
    side.addColorStop(0.45, "rgba(0,0,0,0)");
    side.addColorStop(0.55, "rgba(0,0,0,0)");
    side.addColorStop(1, mix(cb, "#000000", 0.2).replace("rgb", "rgba").replace(")", ",0.45)"));
    ctx.fillStyle = side;
    ctx.fillRect(0, 0, w, h);
  } else {
    const split = w * 0.5;
    const lean = h * 0.18;
    const left = ctx.createLinearGradient(0, 0, split, h);
    left.addColorStop(0, mix(ca, "#000000", 0.25));
    left.addColorStop(1, mix(ca, "#000000", 0.72));
    ctx.fillStyle = left;
    poly(ctx, [[0, 0], [split + lean, 0], [split - lean, h], [0, h]]);
    ctx.fill();
    const right = ctx.createLinearGradient(w, 0, split, h);
    right.addColorStop(0, mix(cb, "#000000", 0.25));
    right.addColorStop(1, mix(cb, "#000000", 0.72));
    ctx.fillStyle = right;
    poly(ctx, [[split + lean, 0], [w, 0], [w, h], [split - lean, h]]);
    ctx.fill();
    // Texture: stripes, a few light shards and specks.
    stripes(ctx, w, h, w * 0.022, "rgba(255,255,255,0.035)");
    const rnd = seeded(seed);
    ctx.save();
    for (let k = 0; k < 7; k++) {
      const x = rnd() * w;
      const y = rnd() * h;
      const s = (0.08 + rnd() * 0.16) * w;
      ctx.fillStyle = `rgba(255,255,255,${0.025 + rnd() * 0.04})`;
      poly(ctx, [[x, y], [x + s, y - s * 0.35], [x + s * 0.8, y - s * 0.3], [x - s * 0.15, y + s * 0.05]]);
      ctx.fill();
    }
    for (let k = 0; k < 900; k++) {
      ctx.fillStyle = `rgba(255,255,255,${rnd() * 0.05})`;
      ctx.fillRect(rnd() * w, rnd() * h, 1.5, 1.5);
    }
    ctx.restore();
    // Light behind the centre.
    const glow = ctx.createRadialGradient(w / 2, h * 0.62, 0, w / 2, h * 0.62, w * 0.45);
    glow.addColorStop(0, "rgba(255,255,255,0.16)");
    glow.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);
    // The seam between the halves.
    ctx.strokeStyle = "rgba(255,255,255,0.75)";
    ctx.lineWidth = w * 0.004;
    ctx.beginPath();
    ctx.moveTo(split + lean, 0);
    ctx.lineTo(split - lean, h);
    ctx.stroke();
  }
  // Vignette.
  const v = ctx.createRadialGradient(w / 2, h / 2, h * 0.35, w / 2, h / 2, w * 0.75);
  v.addColorStop(0, "rgba(0,0,0,0)");
  v.addColorStop(1, "rgba(0,0,0,0.55)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, w, h);
}

/** A slanted logo card: team colour, the logo, and a name bar along the bottom. */
function card(ctx: Ctx, team: ArtTeam, color: string, x: number, y: number, cw: number, ch: number, input: ArtInput, nameBar: string): void {
  const slant = cw * 0.1;
  const bar = ch * 0.2;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur = cw * 0.06;
  ctx.shadowOffsetY = cw * 0.03;
  const g = ctx.createLinearGradient(x, y, x + cw, y + ch);
  g.addColorStop(0, mix(color, "#ffffff", 0.08));
  g.addColorStop(1, mix(color, "#000000", 0.35));
  ctx.fillStyle = g;
  poly(ctx, [[x + slant, y], [x + cw + slant, y], [x + cw - slant, y + ch], [x - slant, y + ch]]);
  ctx.fill();
  ctx.restore();
  // Inner texture.
  ctx.save();
  poly(ctx, [[x + slant, y], [x + cw + slant, y], [x + cw - slant, y + ch], [x - slant, y + ch]]);
  ctx.clip();
  ctx.translate(x - slant, y);
  stripes(ctx, cw + 2 * slant, ch, cw * 0.06, "rgba(255,255,255,0.05)");
  ctx.restore();
  // Name bar.
  const by = y + ch - bar;
  const t = (by - y) / ch;
  const lx = x + slant - 2 * slant * t;
  ctx.fillStyle = nameBar;
  poly(ctx, [[lx, by], [lx + cw, by], [x + cw - slant, y + ch], [x - slant, y + ch]]);
  ctx.fill();
  ctx.fillStyle = onColor(nameBar);
  const name = team.name.toUpperCase();
  const size = fitFont(ctx, name, input.fonts.display, "800", bar * 0.66, cw * 0.86, true);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // The card leans: its centre line at a height is `slant` right at the top, `slant` left at the bottom.
  const centreAt = (yy: number) => x + cw / 2 + slant - 2 * slant * ((yy - y) / ch);
  ctx.fillText(name, centreAt(by + bar / 2), by + bar / 2 + size * 0.04);
  // Logo.
  const logoY = y + (ch - bar) / 2;
  const box = Math.min(cw, ch - bar) * 0.68;
  ctx.save();
  poly(ctx, [[x + slant, y], [x + cw + slant, y], [x + cw - slant, y + ch], [x - slant, y + ch]]);
  ctx.clip();
  contrastPlate(ctx, team, color, centreAt(logoY), logoY, box);
  ctx.restore();
  drawLogo(ctx, team, centreAt(logoY), logoY, box, input.fonts, onColor(color));
}

function vsMark(ctx: Ctx, cx: number, cy: number, size: number, input: ArtInput): void {
  ctx.save();
  ctx.font = `italic 800 ${size}px "${input.fonts.display}"`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillText("VS", cx + size * 0.05, cy + size * 0.06);
  ctx.strokeStyle = INK;
  ctx.lineWidth = size * 0.12;
  ctx.strokeText("VS", cx, cy);
  ctx.fillStyle = "#ffffff";
  ctx.fillText("VS", cx, cy);
  ctx.restore();
}

function subline(input: ArtInput): string {
  const parts = [input.eventName, input.title].filter((p): p is string => !!p && !!p.trim());
  return [...new Set(parts.map((p) => p.trim().toUpperCase()))].join("  ·  ");
}

// ------------------------------------------------------------------ thumbnails

/** A 16:9 thumbnail (any size; designed at 1280×720). */
export function drawThumbnail(ctx: Ctx, w: number, h: number, kind: ThumbnailKind, input: ArtInput, seed = `${input.a.name}|${input.b.name}`): void {
  const u = w / 1280;
  const [ca, cb] = teamColors(input.a, input.b);
  const words = THUMBNAILS.find((t) => t.kind === kind)!.words;
  background(ctx, w, h, input, `${seed}|${kind}`);
  // Headline: two words, the second in the accent colour ("LIVE" first in red).
  const first = kind === "live" ? "#ff3b3b" : "#ffffff";
  const second = kind === "live" ? "#ffffff" : input.accent;
  const gap = 26 * u;
  ctx.font = `italic 800 ${150 * u}px "${input.fonts.display}"`;
  let size = 150 * u;
  const fullW = () => ctx.measureText(words[0]).width + gap + ctx.measureText(words[1]).width;
  while (fullW() > w * 0.9 && size > 40 * u) {
    size *= 0.95;
    ctx.font = `italic 800 ${size}px "${input.fonts.display}"`;
  }
  const total = fullW();
  const hx = (w - total) / 2;
  const hy = 40 * u + size * 0.86;
  const w0 = headline(ctx, words[0], hx, hy, size, first, input.fonts.display);
  headline(ctx, words[1], hx + w0 + gap, hy, size, second, input.fonts.display);
  if (kind === "live") {
    // A red "on air" dot before the headline.
    ctx.save();
    ctx.fillStyle = "#ff3b3b";
    ctx.strokeStyle = INK;
    ctx.lineWidth = 6 * u;
    ctx.beginPath();
    ctx.arc(hx - 38 * u, hy - size * 0.36, 20 * u, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
  // Event and title, small, under the headline.
  const sub = subline(input);
  if (sub) {
    ctx.save();
    const s = fitFont(ctx, sub, input.fonts.display, "700", 34 * u, w * 0.8);
    ctx.font = `700 ${s}px "${input.fonts.display}"`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const tw = ctx.measureText(sub).width + 40 * u;
    const y = hy + 34 * u;
    ctx.fillStyle = "rgba(11,13,18,0.82)";
    poly(ctx, [[w / 2 - tw / 2 + 10 * u, y], [w / 2 + tw / 2 + 10 * u, y], [w / 2 + tw / 2 - 10 * u, y + 50 * u], [w / 2 - tw / 2 - 10 * u, y + 50 * u]]);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(sub, w / 2, y + 26 * u);
    ctx.restore();
  }
  // Logo cards and VS.
  const cw = 360 * u;
  const ch = 330 * u;
  const cy = 330 * u;
  card(ctx, input.a, ca, 130 * u, cy, cw, ch, input, "#ffffff");
  card(ctx, input.b, cb, w - 130 * u - cw, cy, cw, ch, input, "#ffffff");
  vsMark(ctx, w / 2, cy + ch * 0.45, 150 * u, input);
  // Format and event logo.
  if (input.eventLogo) drawLogoImage(ctx, input.eventLogo, w / 2, cy + ch - 20 * u, 90 * u);
  else {
    // The format in a small slanted tag under VS.
    ctx.save();
    const fmt = `BEST OF ${input.bestOf}`;
    ctx.font = `italic 800 ${34 * u}px "${input.fonts.display}"`;
    const tw = ctx.measureText(fmt).width + 36 * u;
    const ty = cy + ch - 56 * u;
    ctx.fillStyle = INK;
    poly(ctx, [[w / 2 - tw / 2 + 10 * u, ty], [w / 2 + tw / 2 + 10 * u, ty], [w / 2 + tw / 2 - 10 * u, ty + 48 * u], [w / 2 - tw / 2 - 10 * u, ty + 48 * u]]);
    ctx.fill();
    ctx.fillStyle = input.accent;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(fmt, w / 2, ty + 26 * u);
    ctx.restore();
  }
}

function drawLogoImage(ctx: Ctx, img: CanvasImageSource, cx: number, cy: number, box: number): void {
  const [iw, ih] = imageSize(img);
  const s = Math.min(box / iw, box / ih);
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur = box * 0.1;
  ctx.drawImage(img, cx - (iw * s) / 2, cy - (ih * s) / 2, iw * s, ih * s);
  ctx.restore();
}

// ------------------------------------------------------------------ "Up next" screen

/** A full-screen 1920×1080 card for OBS before the match: "UP NEXT", both teams, event, format, time. */
export function drawVersus(ctx: Ctx, w: number, h: number, input: ArtInput, seed = `${input.a.name}|${input.b.name}`): void {
  const u = w / 1920;
  const [ca, cb] = teamColors(input.a, input.b);
  background(ctx, w, h, { ...input, background: input.background }, `${seed}|versus`);
  const size = 120 * u;
  const tag = "UP";
  ctx.font = `italic 800 ${size}px "${input.fonts.display}"`;
  const total = ctx.measureText("UP NEXT").width;
  const x0 = (w - total) / 2;
  const w0 = headline(ctx, tag, x0, 70 * u + size * 0.86, size, "#ffffff", input.fonts.display);
  headline(ctx, "NEXT", x0 + w0 + ctx.measureText(" ").width, 70 * u + size * 0.86, size, input.accent, input.fonts.display);
  const sub = subline(input);
  const when = input.scheduledAt ? new Date(input.scheduledAt) : null;
  const time = when && !Number.isNaN(when.getTime()) ? when.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).toUpperCase() : null;
  const line = [sub || null, `BEST OF ${input.bestOf}`, time].filter(Boolean).join("  ·  ");
  ctx.save();
  const s = fitFont(ctx, line, input.fonts.display, "700", 44 * u, w * 0.8);
  ctx.font = `700 ${s}px "${input.fonts.display}"`;
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.fillText(line, w / 2, 250 * u);
  ctx.restore();
  const cw = 560 * u;
  const ch = 560 * u;
  const cy = 340 * u;
  card(ctx, input.a, ca, 200 * u, cy, cw, ch, input, "#ffffff");
  card(ctx, input.b, cb, w - 200 * u - cw, cy, cw, ch, input, "#ffffff");
  vsMark(ctx, w / 2, cy + ch * 0.45, 220 * u, input);
  if (input.eventLogo) drawLogoImage(ctx, input.eventLogo, w / 2, cy + ch * 0.85, 150 * u);
}

// ------------------------------------------------------------------ stingers

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const outCubic = (x: number) => 1 - (1 - clamp01(x)) ** 3;
const inCubic = (x: number) => clamp01(x) ** 3;
const outBack = (x: number) => {
  const c = 1.6;
  const t = clamp01(x) - 1;
  return 1 + (c + 1) * t ** 3 + c * t ** 2;
};
/** 0 → 1 between `a` and `b` ms. */
const span = (t: number, a: number, b: number) => clamp01((t - a) / (b - a));

/**
 * One frame of a stinger at `t` ms (0–1600) on a transparent canvas: the teams' panels close in from
 * the sides (the screen is fully covered from 400 ms to 1000 ms, around the cut at 900 ms), logos and
 * VS punch in, then the panels open out again, gone by 1300 ms. The replay stinger adds a REPLAY band.
 */
export function drawStingerFrame(ctx: Ctx, w: number, h: number, t: number, input: ArtInput, replay: boolean): void {
  const u = w / 1920;
  const [ca, cb] = teamColors(input.a, input.b);
  ctx.clearRect(0, 0, w, h);
  const lean = h * 0.2;
  // How far each panel has come: 0 = off screen, 1 = meeting in the middle (with overlap).
  const closeIn = (lag: number) => outCubic(span(t, 40 + lag, 400 + lag));
  // Out in the reverse order: the team colour first, the accent last.
  const openOut = (lag: number) => inCubic(span(t, 980 - lag * 0.8, 1260 - lag * 0.8));
  const reach = (lag: number) => closeIn(lag) * (1 - openOut(lag));
  // Layers from back to front: accent, white, team colour (each a little behind the one before).
  const layers: { lag: number; fill: (side: 0 | 1) => string | CanvasGradient; extra: number }[] = [
    { lag: -50, fill: () => input.accent, extra: 0.06 },
    { lag: -25, fill: () => "#ffffff", extra: 0.03 },
    { lag: 0, fill: (side) => mix(side ? cb : ca, "#000000", 0.08), extra: 0 },
  ];
  for (const layer of layers) {
    const r = reach(layer.lag);
    if (r <= 0) continue;
    // Left panel: its slanted right edge goes from off screen to just past the middle.
    const edgeA = -lean + (w / 2 + lean * 1.1 + w * layer.extra) * r;
    ctx.fillStyle = layer.fill(0);
    poly(ctx, [[-lean * 2, 0], [edgeA + lean, 0], [edgeA - lean, h], [-lean * 2, h]]);
    ctx.fill();
    const edgeB = w + lean - (w / 2 + lean * 1.1 + w * layer.extra) * r;
    ctx.fillStyle = layer.fill(1);
    poly(ctx, [[edgeB + lean, 0], [w + lean * 2, 0], [w + lean * 2, h], [edgeB - lean, h]]);
    ctx.fill();
  }
  const full = reach(0);
  if (full <= 0) return;
  // Depth on the panels: two flat darker bands, parallel to the seam, only on what is already drawn
  // (never on the transparent part). Flat shapes, not gradients or fine texture: the stinger is
  // stored as one PNG per frame, and flat colour keeps each frame small.
  ctx.save();
  ctx.globalCompositeOperation = "source-atop";
  ctx.fillStyle = "rgba(0,0,0,0.22)";
  for (const x of [w * 0.12, w * 0.88 - lean * 0.4]) {
    poly(ctx, [[x + lean, 0], [x + lean + w * 0.07, 0], [x - lean + w * 0.07, h], [x - lean, h]]);
    ctx.fill();
  }
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  for (const x of [w * 0.2, w * 0.8 - lean * 0.4]) {
    poly(ctx, [[x + lean, 0], [x + lean + w * 0.02, 0], [x - lean + w * 0.02, h], [x - lean, h]]);
    ctx.fill();
  }
  ctx.restore();
  // The seam where the panels meet.
  if (full > 0.98) {
    ctx.save();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 10 * u;
    ctx.beginPath();
    ctx.moveTo(w / 2 + lean, 0);
    ctx.lineTo(w / 2 - lean, h);
    ctx.stroke();
    ctx.strokeStyle = input.accent;
    ctx.lineWidth = 4 * u;
    ctx.beginPath();
    ctx.moveTo(w / 2 + lean + 16 * u, 0);
    ctx.lineTo(w / 2 - lean + 16 * u, h);
    ctx.stroke();
    ctx.restore();
  }
  // Logos and names punch in, then out.
  const pin = outBack(span(t, 290, 480));
  const pout = inCubic(span(t, 880, 990));
  const shown = pin * (1 - pout);
  if (shown > 0) {
    const scale = 0.7 + 0.3 * pin + 0.25 * pout;
    const ly = replay ? h * 0.36 : h * 0.44;
    const box = (replay ? 330 : 420) * u;
    for (const [team, cx, color] of [
      [input.a, w * 0.25, ca],
      [input.b, w * 0.75, cb],
    ] as const) {
      ctx.save();
      ctx.globalAlpha = clamp01(shown);
      ctx.translate(cx, ly);
      ctx.scale(scale, scale);
      contrastPlate(ctx, team, color, 0, 0, box);
      drawLogo(ctx, team, 0, 0, box, input.fonts, onColor(color));
      const name = team.name.toUpperCase();
      const s = fitFont(ctx, name, input.fonts.display, "800", 84 * u, w * 0.36, true);
      ctx.font = `italic 800 ${s}px "${input.fonts.display}"`;
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      ctx.lineJoin = "round";
      ctx.strokeStyle = "rgba(11,13,18,0.85)";
      ctx.lineWidth = s * 0.12;
      ctx.strokeText(name, 0, box * 0.5 + s * 1.05);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(name, 0, box * 0.5 + s * 1.05);
      ctx.restore();
    }
    // VS on the seam.
    const vsIn = outBack(span(t, 360, 520));
    if (vsIn > 0) {
      ctx.save();
      ctx.globalAlpha = clamp01(1 - pout);
      ctx.translate(w / 2, ly);
      ctx.scale(vsIn * (1 + 0.3 * pout), vsIn * (1 + 0.3 * pout));
      vsMark(ctx, 0, 0, (replay ? 150 : 190) * u, input);
      ctx.restore();
    }
  }
  if (replay) {
    // A dark band across the lower third slides in with REPLAY and rewind chevrons.
    const bin = outCubic(span(t, 240, 440));
    const bout = inCubic(span(t, 900, 1040));
    const reachB = bin * (1 - bout);
    if (reachB > 0) {
      const by = h * 0.66;
      const bh = 190 * u;
      const x1 = w * (1 - reachB) + -lean;
      ctx.save();
      ctx.fillStyle = INK;
      poly(ctx, [[x1 + 40 * u, by], [w + 100 * u, by], [w + 100 * u, by + bh], [x1 - 40 * u, by + bh]]);
      ctx.fill();
      ctx.fillStyle = input.accent;
      poly(ctx, [[x1 + 40 * u, by - 10 * u], [w + 100 * u, by - 10 * u], [w + 100 * u, by], [x1 + 40 * u, by]]);
      ctx.fill();
      ctx.restore();
      const textIn = outCubic(span(t, 320, 500)) * (1 - inCubic(span(t, 860, 980)));
      if (textIn > 0) {
        ctx.save();
        ctx.globalAlpha = clamp01(textIn);
        const tx = w / 2 + (1 - textIn) * 300 * u;
        const size = 150 * u;
        ctx.font = `italic 800 ${size}px "${input.fonts.display}"`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = input.accent;
        ctx.fillText("REPLAY", tx, by + bh / 2 + 6 * u);
        // Rewind chevrons either side, drifting left.
        const drift = ((t / 1000) * 150 * u) % (40 * u);
        ctx.fillStyle = "#ffffff";
        const tw = ctx.measureText("REPLAY").width;
        for (const side of [-1, 1]) {
          for (let k = 0; k < 3; k++) {
            const cx = tx + side * (tw / 2 + 110 * u + k * 60 * u) - drift;
            const cy = by + bh / 2;
            const s = 30 * u;
            ctx.globalAlpha = clamp01(textIn) * (1 - k * 0.28);
            poly(ctx, [[cx + s * 0.4, cy - s], [cx - s * 0.6, cy], [cx + s * 0.4, cy + s], [cx + s * 0.1, cy + s], [cx - s * 0.9, cy], [cx + s * 0.1, cy - s]]);
            ctx.fill();
          }
        }
        ctx.restore();
      }
    }
  } else if (input.eventLogo && shown > 0) {
    ctx.save();
    ctx.globalAlpha = clamp01(shown);
    drawLogoImage(ctx, input.eventLogo, w / 2, h * 0.82, 140 * u);
    ctx.restore();
  }
}
