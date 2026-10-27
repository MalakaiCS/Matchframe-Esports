import type { HudState } from "@matchframe/hud-sdk";
import { displayClock } from "@matchframe/hud-sdk";
import { setting, teamName } from "../util.ts";
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
      {maps.map((m) => (
        <div key={m.mapName} className={`veto_container ${m.status === "live" ? "active" : ""}`}>
          <div className="veto_map_name">{m.displayName}</div>
          <div className="veto_picker">{m.pickedBy === "decider" ? <span className="decider">Decider</span> : <TeamLogo team={teamOf(m.pickedBy)} />}</div>
          <div className="veto_winner">
            <TeamLogo team={teamOf(m.winner)} />
          </div>
          <div className="veto_score">{m.status === "upcoming" ? "–:–" : `${m.scoreLeft}:${m.scoreRight}`}</div>
          <div className="active_container">
            <div className="active">Currently playing</div>
          </div>
        </div>
      ))}
    </div>
  );
}
