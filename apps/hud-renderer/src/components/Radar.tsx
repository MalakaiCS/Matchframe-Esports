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
 * Matchframe minimap: the built-in radar image for the map (or an operator-calibrated one), or the
 * schematic outline generated from map-pack geometry. Markers use the same transform as the
 * background; without a trustworthy transform nothing is drawn.
 *
 * Players: team colour with their slot number, a facing wedge, a ring on the observed player, an
 * orange badge on the bomb carrier, lighter while flashed, a small faded cross when dead. Utility:
 * smokes outlined in the thrower's team colour, fires, flashes and HE bursts. The bomb shows when
 * dropped or planted (pulsing), and defused/exploded.
 */
export function Radar({ radar: given }: { radar: HudRadar }) {
  // A map without a radar image: Matchframe's radar drawn in the radar images' style, else the outline.
  const radar = given.mode === "schematic" && given.cleanUrl ? { ...given, mode: "image" as const, backgroundUrl: given.cleanUrl } : given;
  const outline = useOutline(radar.mode === "schematic" ? radar.backgroundUrl : null);
  if (!radar.available) return null;
  const S = 1000;
  return (
    <div className={`mf-radar mf-radar-${radar.mode}`} data-map={radar.mapName ?? ""}>
      <svg viewBox={`0 0 ${S} ${S}`} className="mf-radar-svg" aria-label="radar">
        <rect x="0" y="0" width={S} height={S} className="mf-radar-bg" />
        {radar.mode === "image" && radar.backgroundUrl ? <image href={radar.backgroundUrl} x="0" y="0" width={S} height={S} preserveAspectRatio="none" className="mf-radar-image" /> : null}
        {outline?.cells.map(([u, v, w, ri], i) => (
          <rect key={i} x={u * S} y={v * S} width={w * S + 0.6} height={w * S + 0.6} className={`mf-radar-cell k-${outline.regions[ri]?.kind ?? "other"}`} />
        ))}
        {outline?.polygons.map((p, i) => (
          <polygon key={`p${i}`} points={p.points.map(([u, v]) => `${u * S},${v * S}`).join(" ")} className={`mf-radar-cell k-${outline.regions[p.regionIndex]?.kind ?? "other"}`} />
        ))}
        {radar.utility.map((u) => (
          <circle
            key={u.id}
            cx={u.u * S}
            cy={u.v * S}
            r={Math.max(u.type === "decoy" ? 12 : 22, (u.radius ?? 0.02) * S)}
            className={`mf-radar-util ${UTILITY_CLASS[u.type] ?? "u-other"} mf-side-${u.side ?? "none"} ${u.evidence === "estimated" ? "is-estimated" : ""}`}
          />
        ))}
        {radar.bomb && radar.bomb.state !== "carried" ? (
          <g transform={`translate(${radar.bomb.u * S} ${radar.bomb.v * S})`} className={`mf-radar-bomb s-${radar.bomb.state}`}>
            <circle r="30" className="mf-radar-bomb-pulse" />
            <rect x="-17" y="-12" width="34" height="24" rx="4" className="mf-radar-bomb-body" />
            <rect x="-10" y="-5" width="11" height="10" className="mf-radar-bomb-face" />
          </g>
        ) : null}
        {[...radar.players]
          .sort((a, b) => Number(a.alive) - Number(b.alive) || Number(a.observed) - Number(b.observed))
          .map((p) => (
            <g key={p.id} transform={`translate(${p.u * S} ${p.v * S})`} className={`mf-radar-player mf-side-${p.side ?? "none"} ${p.alive ? "" : "is-dead"} ${p.observed ? "is-observed" : ""} ${p.flashed ? "is-flashed" : ""} ${p.hasBomb ? "has-bomb" : ""}`}>
              {p.alive ? (
                <>
                  {p.yawDeg !== null ? <path d="M0,-42 L14,-18 L-14,-18 Z" transform={`rotate(${90 - p.yawDeg})`} className="mf-radar-facing" /> : null}
                  {p.observed ? <circle r="34" className="mf-radar-ring" /> : null}
                  <circle r={p.observed ? 26 : 22} className="mf-radar-dot" />
                  {p.label ? (
                    <text y="9" textAnchor="middle" className="mf-radar-label">
                      {p.label}
                    </text>
                  ) : null}
                  {p.hasBomb ? <circle cx="20" cy="-20" r="9" className="mf-radar-carrier" /> : null}
                </>
              ) : (
                <path d="M-10,-10 L10,10 M10,-10 L-10,10" className="mf-radar-dead" />
              )}
            </g>
          ))}
      </svg>
    </div>
  );
}
