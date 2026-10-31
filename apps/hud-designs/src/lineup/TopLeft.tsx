import type { HudSeriesMap, HudState } from "@matchframe/hud-sdk";
import { Radar } from "../shared/parts.ts";
import type { Settings } from "./util.ts";

function MapTab({ m, state }: { m: HudSeriesMap; state: HudState }) {
  const picker = m.pickedBy === "left" || m.pickedBy === "right" ? state[m.pickedBy] : null;
  const pick = picker ? (picker.shortName || picker.name).toUpperCase() : m.pickedBy === "decider" ? "DECIDER" : "";
  const played = m.status === "completed" || m.status === "forfeited";
  return (
    <div className={`lu-map is-${m.status}`}>
      <span className="lu-map-name">{m.displayName}</span>
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
  const showRadar = settings.showRadar && state.radar.available;
  return (
    <div className="lu-topleft">
      {title || showSeries ? (
        <div className="lu-series-box">
          <div className="lu-title">{title}</div>
          {showSeries ? (
            <div className="lu-series">
              {s.maps.slice(0, 5).map((m, i) => (
                <MapTab key={`${m.mapName}-${i}`} m={m} state={state} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {showRadar ? (
        <div className="lu-radar">
          <Radar radar={state.radar} />
        </div>
      ) : null}
    </div>
  );
}
