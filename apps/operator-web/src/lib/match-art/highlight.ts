import type { HudReplayClip } from "@matchframe/hud-sdk";

/**
 * The lower third burned into a highlight reel's clips: drawn on a canvas (1920×1080, transparent
 * around it) and laid over its clip by ffmpeg with a fade in and out. An original Matchframe design
 * in the match graphics' type: the team-colour block with the logo, the player on a dark panel with
 * the weapon, headshot and victims under the name, and a team-colour badge for a 2K–ACE or a clutch.
 */

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export const REEL_GRAPHIC = { width: 1920, height: 1080 } as const;

/** The side colours when a team has none of its own (as the match graphics' defaults). */
const SIDE = { CT: "#3b82e6", T: "#e6a23a" } as const;
const NEUTRAL = "#5c6676";
const PANEL = "rgba(11, 13, 18, 0.9)";
const INK = "#ffffff";
const DIM = "#c4cad4";

function rgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const n = m ? parseInt(m[1]!, 16) : 0x888888;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** The player's colour: their team's own, else the colour of the side they played in that round. */
export function clipAccent(clip: HudReplayClip): string {
  if (clip.team?.color && /^#[0-9a-f]{6}$/i.test(clip.team.color)) return clip.team.color;
  return clip.side ? SIDE[clip.side] : NEUTRAL;
}

/** Text on the team colour: dark on a light one. */
const inkOn = (hex: string) => (luminance(hex) > 0.35 ? "#0b0d12" : "#ffffff");

function imageSize(img: CanvasImageSource): [number, number] {
  const i = img as { naturalWidth?: number; naturalHeight?: number; width?: number | { baseVal: { value: number } }; height?: number | { baseVal: { value: number } } };
  const w = i.naturalWidth || (typeof i.width === "number" ? i.width : 0);
  const h = i.naturalHeight || (typeof i.height === "number" ? i.height : 0);
  return [w || 1, h || 1];
}

function font(ctx: Ctx, family: string, weight: number, size: number): void {
  ctx.font = `${weight} ${size}px "${family}", "Arial Narrow", sans-serif`;
}

/** Fits a line into `maxW` by lowering the size; returns the size used. */
function fit(ctx: Ctx, text: string, family: string, weight: number, size: number, maxW: number): number {
  let s = size;
  for (;;) {
    font(ctx, family, weight, s);
    if (ctx.measureText(text).width <= maxW || s <= 12) return s;
    s = Math.floor(s * 0.94);
  }
}

/** What the play was, under the name: weapon, headshot, victims (or the round won, for a clutch). */
export function playLine(clip: HudReplayClip): string {
  const parts: string[] = [];
  if (clip.weapon) parts.push(clip.weapon.displayName);
  if (clip.headshot) parts.push("Headshot");
  if (clip.victims.length) parts.push(`▸ ${clip.victims.join(", ")}`);
  else if (clip.clutchVersus !== null) parts.push(`Won the round 1v${clip.clutchVersus}`);
  return parts.join("   ·   ").toUpperCase();
}

/** The badge: "3K", "ACE", "1V3" (with "CLUTCH" under it), or null for one kill. */
export function badgeOf(clip: HudReplayClip): { big: string; small: string | null } | null {
  if (clip.clutchVersus !== null) return { big: `1V${clip.clutchVersus}`, small: "CLUTCH" };
  return clip.multiKill ? { big: clip.multiKill, small: null } : null;
}

/** Draws one clip's lower third on a cleared 1920×1080 canvas. */
export function drawReelGraphic(ctx: Ctx, clip: HudReplayClip, logo: CanvasImageSource | null, family: string): void {
  const { width: W, height: H } = REEL_GRAPHIC;
  ctx.clearRect(0, 0, W, H);
  if (!clip.player) return;
  const color = clipAccent(clip);
  const x = 96;
  const h = 132;
  const y = H - 92 - h;
  const block = 132;
  const name = clip.player.name.toUpperCase();
  const line = playLine(clip);
  const badge = badgeOf(clip);
  // The width follows the text (up to a third of the screen past the block).
  font(ctx, family, 800, 72);
  const nameW = Math.min(ctx.measureText(name).width, 820);
  font(ctx, family, 700, 26);
  const lineW = Math.min(ctx.measureText(line).width, 820);
  const bodyW = Math.max(420, Math.max(nameW, lineW) + 76);
  const badgeW = badge ? 168 : 0;

  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 28;
  ctx.shadowOffsetY = 8;
  ctx.fillStyle = PANEL;
  ctx.fillRect(x, y, block + bodyW + badgeW, h);
  ctx.restore();

  // The kicker above the panel: the team, and the round.
  const kicker = [clip.team?.name, clip.roundNumber !== null ? `ROUND ${clip.roundNumber}` : null].filter(Boolean).join("   ·   ").toUpperCase();
  if (kicker) {
    font(ctx, family, 700, 22);
    const kw = ctx.measureText(kicker).width + 36;
    ctx.fillStyle = color;
    ctx.fillRect(x, y - 38, kw, 38);
    ctx.fillStyle = inkOn(color);
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillText(kicker, x + 18, y - 18);
  }

  // Team block: the colour, darker toward the panel, with the logo or the tag.
  const g = ctx.createLinearGradient(x, 0, x + block, 0);
  g.addColorStop(0, color);
  g.addColorStop(1, `rgba(${rgb(color).map((v) => Math.round(v * 0.55)).join(",")},1)`);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, block, h);
  if (logo) {
    const [iw, ih] = imageSize(logo);
    const box = 84;
    const s = Math.min(box / iw, box / ih);
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.4)";
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 3;
    ctx.drawImage(logo, x + block / 2 - (iw * s) / 2, y + h / 2 - (ih * s) / 2, iw * s, ih * s);
    ctx.restore();
  } else {
    const tag = (clip.team?.shortName || clip.team?.name || "").slice(0, 4).toUpperCase() || "?";
    fit(ctx, tag, family, 800, 44, block - 24);
    ctx.fillStyle = inkOn(color);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(tag, x + block / 2, y + h / 2 + 2);
  }

  // The player and the play.
  const bx = x + block + 30;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  fit(ctx, name, family, 800, 72, bodyW - 60);
  ctx.fillStyle = INK;
  ctx.fillText(name, bx, y + 74);
  if (line) {
    fit(ctx, line, family, 700, 26, bodyW - 60);
    ctx.fillStyle = DIM;
    ctx.fillText(line, bx, y + 111);
  }
  // A thin team-colour rule along the bottom of the panel.
  ctx.fillStyle = color;
  ctx.fillRect(x + block, y + h - 5, bodyW + badgeW, 5);

  if (badge) {
    const ax = x + block + bodyW;
    ctx.fillStyle = color;
    ctx.fillRect(ax, y, badgeW, h);
    ctx.fillStyle = inkOn(color);
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    fit(ctx, badge.big, family, 800, badge.small ? 70 : 84, badgeW - 24);
    ctx.fillText(badge.big, ax + badgeW / 2, badge.small ? y + 82 : y + 96);
    if (badge.small) {
      font(ctx, family, 700, 22);
      ctx.fillText(badge.small, ax + badgeW / 2, y + 112);
    }
  }
}
