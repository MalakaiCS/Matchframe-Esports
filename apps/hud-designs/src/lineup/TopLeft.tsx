import type { HudSeriesMap, HudState } from "@matchframe/hud-sdk";
import { Radar } from "../shared/parts.ts";
import { colorOf, teamVars, type Settings } from "./util.ts";

function MapTile({ m, state, settings }: { m: HudSeriesMap; state: HudState; settings: Settings }) {
  const picker = m.pickedBy === "left" || m.pickedBy === "right" ? state[m.pickedBy] : null;
  const played = m.status === "completed" || m.status === "live" || m.status === "forfeited";
  const winColor = m.winner ? colorOf(state[m.winner], settings) : null;
  return (
    <div className={`lu-map is-${m.status} ${m.pickedBy === "decider" ? "is-decider" : ""}`} style={winColor ? teamVars(winColor) : undefined}>
      <span className="lu-map-top">
        <span className="lu-map-name">{m.displayName}</span>
        {m.status === "live" ? <span className="lu-map-live">LIVE</span> : null}
      </span>
      <span className="lu-map-bottom">
        {picker ? (
          <span className="lu-map-pick" style={teamVars(colorOf(picker, settings))}>
            <i />
            <span>{picker.shortName || picker.name} PICK</span>
          </span>
        ) : m.pickedBy === "decider" ? (
          <span className="lu-map-pick is-decider">DECIDER</span>
        ) : (
          <span className="lu-map-pick" />
        )}
        {played ? (
          <span className="lu-map-score">
            <b className={m.winner === "left" ? "is-win" : ""}>{m.scoreLeft}</b>
            <span>:</span>
            <b className={m.winner === "right" ? "is-win" : ""}>{m.scoreRight}</b>
          </span>
        ) : null}
      </span>
    </div>
  );
}

/** Top left: the event title line, the series with its maps, and the radar under them. */
export function TopLeft({ state, settings }: { state: HudState; settings: Settings }) {
  const title = settings.eventTitle || state.event.name || "";
  const s = state.series;
  const showSeries = settings.showSeries && s.maps.length > 0;
  const showRadar = settings.showRadar && state.radar.available;
  return (
    <div className="lu-topleft">
      {title || s.bestOf ? (
        <div className="lu-title" style={teamVars(state.event.primary)}>
          <i className="lu-title-mark" />
          <span className="lu-title-text">{title}</span>
          {s.bestOf ? (
            <span className="lu-title-bo">
              BO{s.bestOf}
              {s.bestOf > 1 ? (
                <b>
                  {s.left}–{s.right}
                </b>
              ) : null}
            </span>
          ) : null}
        </div>
      ) : null}
      {showSeries ? (
        <div className="lu-series" data-count={Math.min(5, s.maps.length)}>
          {s.maps.map((m, i) => (
            <MapTile key={`${m.mapName}-${i}`} m={m} state={state} settings={settings} />
          ))}
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
