import type { CSSProperties } from "react";
import type { HudSeriesMap, HudState } from "@matchframe/hud-sdk";
import { mapArt } from "../shared/art.ts";
import { seriesWindow } from "../shared/format.ts";
import { MapRadar } from "../shared/radar.tsx";
import { colorOf, teamVars, type Settings } from "./util.ts";

/**
 * One map of the series strip: the picking team's mark (its logo, else its tag on its colour), or
 * DECIDER; the map's own logo from the HUD images when set; the name; the score once played. The
 * live map is lit (with the map's picture behind it when set), maps to come are dimmed.
 */
function MapItem({ m, state, settings }: { m: HudSeriesMap; state: HudState; settings: Settings }) {
  const picker = m.pickedBy === "left" || m.pickedBy === "right" ? state[m.pickedBy] : null;
  const played = m.status === "completed" || m.status === "forfeited";
  const art = mapArt(state, m.mapName);
  const winner = m.winner ? state[m.winner] : null;
  // The live map shows its picture from the HUD images behind it.
  const picture = m.status === "live" && art.imageUrl ? ({ "--st-map-img": `url("${art.imageUrl}")` } as CSSProperties) : null;
  return (
    <span className={`st-map is-${m.status} ${picture ? "has-image" : ""}`} style={{ ...(picker ? teamVars(colorOf(picker, settings)) : {}), ...picture }}>
      {picker ? (
        <span className={`st-map-pick ${picker.logoUrl ? "has-img" : ""}`}>{picker.logoUrl ? <img src={picker.logoUrl} alt="" /> : (picker.shortName || picker.name).slice(0, 3).toUpperCase()}</span>
      ) : m.pickedBy === "decider" ? (
        <span className="st-map-pick is-decider">DECIDER</span>
      ) : null}
      {art.logoUrl ? <img className="st-map-logo" src={art.logoUrl} alt="" /> : null}
      <span className="st-map-name">{m.displayName}</span>
      {played ? (
        <span className="st-map-score" style={winner ? teamVars(colorOf(winner, settings)) : undefined}>
          {m.scoreLeft}-{m.scoreRight}
        </span>
      ) : null}
    </span>
  );
}

/** Top left: the series strip (maps in order) and the minimap under it. */
export function TopLeft({ state, settings }: { state: HudState; settings: Settings }) {
  const maps = state.series.maps;
  return (
    <div className="st-topleft">
      {settings.showSeries && maps.length > 0 ? (
        <div className="st-series" aria-label="Series">
          {seriesWindow(maps, 5).map((m, i) => (
            <MapItem key={`${m.mapName}-${i}`} m={m} state={state} settings={settings} />
          ))}
        </div>
      ) : null}
      {settings.showRadar ? <MapRadar radar={state.radar} className="st-radar" /> : null}
    </div>
  );
}
