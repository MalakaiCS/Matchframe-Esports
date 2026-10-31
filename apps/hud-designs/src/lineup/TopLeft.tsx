import type { CSSProperties } from "react";
import type { HudSeriesMap, HudState } from "@matchframe/hud-sdk";
import { mapArt } from "../shared/art.ts";
import { seriesWindow } from "../shared/format.ts";
import { MapRadar } from "../shared/radar.tsx";
import type { Settings } from "./util.ts";

/** A series tab: the map's picture behind it when the operator set one, its logo before the name. */
function MapTab({ m, state }: { m: HudSeriesMap; state: HudState }) {
  const picker = m.pickedBy === "left" || m.pickedBy === "right" ? state[m.pickedBy] : null;
  const pick = picker ? (picker.shortName || picker.name).toUpperCase() : m.pickedBy === "decider" ? "DECIDER" : "";
  const played = m.status === "completed" || m.status === "forfeited";
  const art = mapArt(state, m.mapName);
  const bg = art.imageUrl ? ({ backgroundImage: `url("${art.imageUrl}")` } as CSSProperties) : undefined;
  return (
    <div className={`lu-map is-${m.status} ${art.imageUrl ? "has-image" : ""}`} style={bg}>
      <span className="lu-map-name">
        {art.logoUrl ? <img className="lu-map-logo" src={art.logoUrl} alt="" /> : null}
        <span>{m.displayName}</span>
      </span>
      <span className="lu-map-sub">
        {pick}
        {played ? (
          <b>
            {pick ? " · " : ""}
            {m.scoreLeft}-{m.scoreRight}
          </b>
        ) : null}
      </span>
    </div>
  );
}

/** Top left: the title bar, the series maps as tabs (the live one white), and the radar under them. */
export function TopLeft({ state, settings }: { state: HudState; settings: Settings }) {
  const title = settings.eventTitle || state.event.name || "";
  const s = state.series;
  const showSeries = settings.showSeries && s.maps.length > 0;
  return (
    <div className="lu-topleft">
      {title || showSeries ? (
        <div className="lu-series-box">
          <div className="lu-title">{title}</div>
          {showSeries ? (
            <div className="lu-series">
              {seriesWindow(s.maps, 5).map((m, i) => (
                <MapTab key={`${m.mapName}-${i}`} m={m} state={state} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {settings.showRadar ? <MapRadar radar={state.radar} className="lu-radar" /> : null}
    </div>
  );
}
