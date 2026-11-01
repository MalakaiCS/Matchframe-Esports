import { useEffect, useId, useState } from "react";
import type { PortraitCrop, StripSettings } from "./types.ts";

/**
 * One card of the recording's speaker strip as the console previews it: the same clipped-corner
 * hexagon, frame, dark inset and portrait placement as the strip page (services/local-engine/src/comms/strip.ts),
 * grayscale with the idle frame while silent, colour with the active frame while speaking.
 */

type Pt = [number, number];

const hexPts = (w: number, h: number): Pt[] => {
  const a = w * 0.235;
  return [
    [a, 0],
    [w - a, 0],
    [w, h / 2],
    [w - a, h],
    [a, h],
    [0, h / 2],
  ];
};

/** The polygon moved inwards by d (clockwise on screen). */
function inset(pts: Pt[], d: number): Pt[] {
  const n = pts.length;
  const lines = pts.map((p, i): [Pt, Pt] => {
    const q = pts[(i + 1) % n]!;
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    const l = Math.hypot(dx, dy);
    return [[p[0] + (-dy / l) * d, p[1] + (dx / l) * d], [dx, dy]];
  });
  return lines.map((b, j) => {
    const a = lines[(j - 1 + n) % n]!;
    const cr = a[1][0] * b[1][1] - a[1][1] * b[1][0];
    const t = ((b[0][0] - a[0][0]) * b[1][1] - (b[0][1] - a[0][1]) * b[1][0]) / cr;
    return [a[0][0] + a[1][0] * t, a[0][1] + a[1][1] * t];
  });
}

const f = (p: Pt) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;

function rounded(pts: Pt[], r: number): string {
  const n = pts.length;
  let d = "";
  for (let i = 0; i < n; i++) {
    const p = pts[(i - 1 + n) % n]!;
    const v = pts[i]!;
    const q = pts[(i + 1) % n]!;
    const t1 = Math.min(0.45, r / Math.hypot(p[0] - v[0], p[1] - v[1]));
    const t2 = Math.min(0.45, r / Math.hypot(q[0] - v[0], q[1] - v[1]));
    const A: Pt = [v[0] + (p[0] - v[0]) * t1, v[1] + (p[1] - v[1]) * t1];
    const B: Pt = [v[0] + (q[0] - v[0]) * t2, v[1] + (q[1] - v[1]) * t2];
    d += `${i === 0 ? "M" : "L"}${f(A)}Q${f(v)} ${f(B)}`;
  }
  return `${d}Z`;
}

/** The card's paths at a size (px) and frame thickness, as the strip page draws them. */
export function cardGeometry(w: number, border: number) {
  const h = Math.round(w * 0.99);
  const r = w * 0.085;
  const ring = Math.max(1, border * 0.3);
  const outer = hexPts(w, h);
  return {
    w,
    h,
    outer: rounded(outer, r),
    mid: rounded(inset(outer, border), Math.max(1, r - border * 0.55)),
    inner: rounded(inset(outer, border + ring), Math.max(1, r - (border + ring) * 0.55)),
    box: { x: border + ring, y: border + ring, w: w - 2 * (border + ring), h: h - 2 * (border + ring) },
  };
}

/** Where the portrait goes in its box: covering it, the crop's point kept in place, zoomed. */
export function placePortrait(box: { x: number; y: number; w: number; h: number }, nat: { w: number; h: number }, crop: PortraitCrop) {
  const s = Math.max(box.w / nat.w, box.h / nat.h) * (crop.zoom || 1);
  const dw = nat.w * s;
  const dh = nat.h * s;
  return { x: box.x + (box.w - dw) * (crop.x / 100), y: box.y + (box.h - dh) * (crop.y / 100), width: dw, height: dh };
}

export function StripCard({ name, pictureUrl, crop, speaking, settings, size }: { name: string; pictureUrl: string; crop: PortraitCrop; speaking: boolean; settings: Pick<StripSettings, "borderPx" | "activeColor" | "idleColor" | "insetColor" | "cardPx">; size?: number }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const w = size ?? settings.cardPx;
  const border = (settings.borderPx * w) / settings.cardPx;
  const g = cardGeometry(w, border);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    let live = true;
    const im = new Image();
    im.onload = () => live && setNat({ w: im.naturalWidth || 1, h: im.naturalHeight || 1 });
    im.src = pictureUrl;
    return () => {
      live = false;
    };
  }, [pictureUrl]);
  const at = placePortrait(g.box, nat ?? { w: 1, h: 1 }, nat ? crop : { x: 50, y: 50, zoom: 1 });
  return (
    <svg className={`strip-card ${speaking ? "is-speaking" : ""}`} width={g.w} height={g.h} viewBox={`0 0 ${g.w} ${g.h}`} role="img" aria-label={`${name}: ${speaking ? "speaking (colour, active frame)" : "silent (grayscale, grey frame)"}`}>
      <defs>
        <clipPath id={`${id}c`}>
          <path d={g.inner} />
        </clipPath>
        <filter id={`${id}g`} colorInterpolationFilters="sRGB">
          <feColorMatrix type="saturate" values="0" />
        </filter>
      </defs>
      <path d={g.outer} fill={speaking ? settings.activeColor : settings.idleColor} />
      <path d={g.mid} fill={settings.insetColor} />
      <g clipPath={`url(#${id}c)`}>
        <image href={pictureUrl} preserveAspectRatio="none" x={at.x} y={at.y} width={at.width} height={at.height} filter={speaking ? undefined : `url(#${id}g)`} />
      </g>
    </svg>
  );
}
