import { useEffect, useState } from "react";
import type { HudRadar } from "@matchframe/hud-sdk";

interface Outline {
  cells: [number, number, number, number][];
  polygons: { regionIndex: number; points: [number, number][] }[];
  regions: { id: string; name: string; kind: string }[];
}

const cache = new Map<string, Outline | null>();

function useOutline(url: string | null): Outline | null {
  const [o, setO] = useState<Outline | null>(url ? (cache.get(url) ?? null) : null);
  useEffect(() => {
    if (!url) return;
    if (cache.has(url)) {
      setO(cache.get(url) ?? null);
      return;
    }
    let alive = true;
    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: Outline | null) => {
        cache.set(url, j);
        if (alive) setO(j);
      })
      .catch(() => cache.set(url, null));
    return () => {
      alive = false;
    };
  }, [url]);
  return o;
}

const UTILITY_CLASS: Record<string, string> = { smoke: "u-smoke", molotov: "u-fire", incendiary: "u-fire", fire_unknown: "u-fire", he: "u-he", flashbang: "u-flash", decoy: "u-decoy" };

/**
 * Matchframe schematic radar. Markers use the same world transform as the outline (generated from
 * map-pack geometry); without a trustworthy transform nothing is drawn.
 */
export function Radar({ radar }: { radar: HudRadar }) {
  const outline = useOutline(radar.mode === "schematic" ? radar.backgroundUrl : null);
  if (!radar.available) return null;
  const S = 1000;
  return (
    <div className="mf-radar">
      <svg viewBox={`0 0 ${S} ${S}`} className="mf-radar-svg" aria-label="radar">
        <rect x="0" y="0" width={S} height={S} className="mf-radar-bg" />
        {radar.mode === "image" && radar.backgroundUrl ? <image href={radar.backgroundUrl} x="0" y="0" width={S} height={S} preserveAspectRatio="none" /> : null}
        {outline?.cells.map(([u, v, w, ri], i) => (
          <rect key={i} x={u * S} y={v * S} width={w * S + 0.6} height={w * S + 0.6} className={`mf-radar-cell k-${outline.regions[ri]?.kind ?? "other"}`} />
        ))}
        {outline?.polygons.map((p, i) => (
          <polygon key={`p${i}`} points={p.points.map(([u, v]) => `${u * S},${v * S}`).join(" ")} className={`mf-radar-cell k-${outline.regions[p.regionIndex]?.kind ?? "other"}`} />
        ))}
        {radar.utility.map((u) => (
          <circle key={u.id} cx={u.u * S} cy={u.v * S} r={Math.max(u.type === "decoy" ? 14 : 26, (u.radius ?? 0.02) * S)} className={`mf-radar-util ${UTILITY_CLASS[u.type] ?? "u-other"} ${u.evidence === "estimated" ? "is-estimated" : ""}`} />
        ))}
        {radar.bomb ? <rect x={radar.bomb.u * S - 16} y={radar.bomb.v * S - 11} width="32" height="22" rx="3" className={`mf-radar-bomb s-${radar.bomb.state}`} /> : null}
        {radar.players.map((p) => (
          <g key={p.id} transform={`translate(${p.u * S} ${p.v * S})`} className={`mf-radar-player mf-side-${p.side ?? "none"} ${p.alive ? "" : "is-dead"} ${p.observed ? "is-observed" : ""}`}>
            {p.alive && p.yawDeg !== null ? <path d="M0,-40 L13,-17 L-13,-17 Z" transform={`rotate(${90 - p.yawDeg})`} className="mf-radar-facing" /> : null}
            {p.observed ? <circle r="33" className="mf-radar-ring" /> : null}
            <circle r={p.alive ? 22 : 12} className="mf-radar-dot" />
            {p.alive && p.label ? (
              <text y="9" textAnchor="middle" className="mf-radar-label">
                {p.label}
              </text>
            ) : null}
          </g>
        ))}
      </svg>
    </div>
  );
}
