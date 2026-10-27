import { useEffect, useState } from "react";
import type { HudState } from "@matchframe/hud-sdk";

/** Schematic outline from the HUD server (/overlay-api/radar/<map>): same 0–1 coordinates as the markers. */
interface Outline {
  cells: [number, number, number, number][];
  polygons: { regionIndex: number; points: [number, number][] }[];
  regions: { id: string; name: string; kind: string }[];
}

const cache = new Map<string, Outline | null>();

function useOutline(url: string | null): Outline | null {
  const [o, setO] = useState<Outline | null>(url ? (cache.get(url) ?? null) : null);
  useEffect(() => {
    if (!url) return setO(null);
    if (cache.has(url)) return setO(cache.get(url) ?? null);
    let alive = true;
    fetch(url)
      .then((r) => (r.ok ? (r.json() as Promise<Outline>) : null))
      .then((j) => {
        cache.set(url, j);
        if (alive) setO(j);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [url]);
  return o;
}

const UTILITY: Record<string, string> = { smoke: "u-smoke", molotov: "u-fire", incendiary: "u-fire", fire_unknown: "u-fire", he: "u-he", flashbang: "u-flash", decoy: "u-decoy" };
const S = 1000;

/**
 * Radar (top left) from Matchframe's radar data: the built-in radar image for the map (or an
 * operator-calibrated one), or the schematic outline generated from map geometry. Players with their
 * slot number (bigger when observed, lighter while flashed, orange when carrying the bomb, faded
 * when dead), the bomb when dropped or planted, and confirmed utility (smokes outlined in the
 * thrower's team colour). Nothing is drawn without a trustworthy transform (mode "none").
 */
export default function Radar({ state, size }: { state: HudState; size: number }) {
  const r = state.radar;
  const outline = useOutline(r.mode === "schematic" ? r.backgroundUrl : null);
  if (!r.available || r.mode === "none") return null;
  return (
    <div id="radar_maps_container" className={`mode-${r.mode}`} style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${S} ${S}`} className="mf-radar" aria-hidden>
        {r.mode === "image" && r.backgroundUrl ? <image href={r.backgroundUrl} x="0" y="0" width={S} height={S} preserveAspectRatio="none" /> : null}
        {outline?.cells.map(([u, v, w, ri], i) => (
          <rect key={i} x={u * S} y={v * S} width={w * S + 0.6} height={w * S + 0.6} className={`mf-radar-cell k-${outline.regions[ri]?.kind ?? "other"}`} />
        ))}
        {outline?.polygons.map((p, i) => (
          <polygon key={`p${i}`} points={p.points.map(([u, v]) => `${u * S},${v * S}`).join(" ")} className={`mf-radar-cell k-${outline.regions[p.regionIndex]?.kind ?? "other"}`} />
        ))}
        {r.utility.map((u) => (
          <circle key={u.id} cx={u.u * S} cy={u.v * S} r={Math.max(u.type === "decoy" ? 12 : 22, (u.radius ?? 0.02) * S)} className={`mf-radar-util ${UTILITY[u.type] ?? "u-other"} ${u.side ?? ""}`} />
        ))}
        {r.bomb && r.bomb.state !== "carried" ? (
          <g transform={`translate(${r.bomb.u * S} ${r.bomb.v * S})`} className={`mf-radar-bomb s-${r.bomb.state}`}>
            <circle r="30" className="mf-radar-bomb-ping" />
            <rect x="-17" y="-12" width="34" height="24" rx="4" className="mf-radar-bomb-body" />
          </g>
        ) : null}
        {[...r.players]
          .sort((a, b) => Number(a.alive) - Number(b.alive) || Number(a.observed) - Number(b.observed))
          .map((p) => (
            <g key={p.id} transform={`translate(${p.u * S} ${p.v * S})`} className={`mf-radar-player ${p.side ?? ""} ${p.alive ? "" : "dead"} ${p.observed ? "active" : ""} ${p.flashed ? "flashed" : ""} ${p.hasBomb ? "hasBomb" : ""}`}>
              {p.alive && p.yawDeg !== null ? <path d="M0,-44 L14,-20 L-14,-20 Z" transform={`rotate(${90 - p.yawDeg})`} className="mf-radar-facing" /> : null}
              <circle r={p.alive ? (p.observed ? 30 : 24) : 11} className="mf-radar-dot" />
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
