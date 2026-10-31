import type { HudState } from "@matchframe/hud-sdk";
import { displayClock } from "@matchframe/hud-sdk";
import { mapArt, setting, teamName } from "../util.ts";
import "../styles/mapseries.scss";
import TeamLogo from "./TeamLogo.tsx";

export function Pause({ state }: { state: HudState }) {
  return (
    <div id="pause" className={state.match.phase === "paused" || state.match.paused ? "show" : ""}>
      PAUSE
    </div>
  );
}

export function Timeout({ state, receivedAt, now }: { state: HudState; receivedAt: number; now: number }) {
  const phase = state.match.phase;
  const side = phase === "timeout_t" ? "T" : phase === "timeout_ct" ? "CT" : null;
  const team = side ? (state.left.side === side ? state.left : state.right) : null;
  const left = displayClock(state.match.phaseEndsInSec, state.match.clockRunning, receivedAt, now);
  return (
    <div id="timeout" className={`${team && (left === null || left > 2) ? "show" : ""} ${side ?? ""}`}>
      {team ? `${teamName(state, team)} TIMEOUT` : ""}
    </div>
  );
}

/** The series maps (picked by, score, winner), shown during freeze time. */
export function MapSeries({ state, show }: { state: HudState; show: boolean }) {
  const maps = state.series.maps;
  if (!maps.length || !setting(state, "showMapSeries", true)) return null;
  const teamOf = (s: "left" | "right" | "decider" | null) => (s === "left" ? state.left : s === "right" ? state.right : null);
  return (
    <div className={`map_series_container ${show ? "show" : "hide"}`}>
      <div className="title_bar">
        <div className="picked">Picked</div>
        <div className="winner">Winner</div>
        <div className="score">Score</div>
      </div>
      {maps.map((m) => {
        // HUD images: the map's picture behind its name and its logo before it, when set.
        const art = mapArt(state, m.mapName);
        return (
          <div key={m.mapName} className={`veto_container ${m.status === "live" ? "active" : ""}`}>
            <div className={`veto_map_name ${art.imageUrl ? "with-image" : ""}`} style={art.imageUrl ? { backgroundImage: `linear-gradient(rgba(0, 0, 0, 0.45), rgba(0, 0, 0, 0.65)), url("${art.imageUrl.replace(/["\\]/g, "")}")` } : undefined}>
              {art.logoUrl ? <img className="map_logo" src={art.logoUrl} alt="" /> : null}
              {m.displayName}
            </div>
            <div className="veto_picker">{m.pickedBy === "decider" ? <span className="decider">Decider</span> : <TeamLogo team={teamOf(m.pickedBy)} />}</div>
            <div className="veto_winner">
              <TeamLogo team={teamOf(m.winner)} />
            </div>
            <div className="veto_score">{m.status === "upcoming" ? "–:–" : `${m.scoreLeft}:${m.scoreRight}`}</div>
            <div className="active_container">
              <div className="active">Currently playing</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
