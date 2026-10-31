import type { HudState, HudTeam } from "@matchframe/hud-sdk";
import { displayClock, formatClock } from "@matchframe/hud-sdk";
import { mapArt, mapBackground } from "../art.ts";
import { BombIcon } from "./Icons.tsx";

const PHASE_LABEL: Record<string, string> = {
  warmup: "WARMUP",
  freezetime: "BUY TIME",
  live: "",
  bomb: "BOMB PLANTED",
  defuse: "DEFUSING",
  over: "ROUND OVER",
  halftime: "HALFTIME",
  paused: "PAUSED",
  timeout_ct: "TACTICAL TIMEOUT",
  timeout_t: "TACTICAL TIMEOUT",
  gameover: "MAP OVER",
  unknown: "",
};

function TeamBlock({ team, align }: { team: HudTeam; align: "left" | "right" }) {
  return (
    <div className={`mf-sb-team mf-sb-${align} mf-side-${team.side ?? "none"}`} style={team.color ? ({ "--mf-team": team.color } as React.CSSProperties) : undefined}>
      <div className="mf-sb-logo">{team.logoUrl ? <img src={team.logoUrl} alt="" /> : <span>{team.shortName.slice(0, 3)}</span>}</div>
      <div className="mf-sb-name" title={team.name}>
        {team.name}
      </div>
      <div className="mf-sb-score">{team.score ?? "–"}</div>
    </div>
  );
}

export function Scoreboard({ state, receivedAt, now }: { state: HudState; receivedAt: number; now: number }) {
  const m = state.match;
  const bomb = state.bomb;
  const planted = bomb && (bomb.state === "planted" || bomb.state === "defusing");
  const clock = planted ? displayClock(bomb.remainingSec, bomb.clockRunning, receivedAt, now) : displayClock(m.phaseEndsInSec, m.clockRunning, receivedAt, now);
  const label = PHASE_LABEL[m.phase] ?? "";
  const roundInfo = m.roundNumber !== null ? `ROUND ${m.roundNumber}${m.regulationRounds ? ` / ${m.regulationRounds}` : ""}` : "";
  return (
    <div className="mf-scoreboard" data-phase={m.phase}>
      <TeamBlock team={state.left} align="left" />
      <div className={`mf-sb-center ${planted ? "is-bomb" : ""} ${m.paused ? "is-paused" : ""}`}>
        <div className="mf-sb-clock" aria-live="off">
          {planted ? <BombIcon size={22} className="mf-sb-bomb" /> : null}
          <span>{m.paused ? "PAUSED" : formatClock(clock)}</span>
        </div>
        <div className="mf-sb-round">{label || roundInfo}</div>
      </div>
      <TeamBlock team={state.right} align="right" />
    </div>
  );
}

export function SeriesStrip({ state }: { state: HudState }) {
  const s = state.series;
  if (!s.bestOf || s.maps.length === 0) return null;
  return (
    <div className="mf-series">
      <span className="mf-series-bo">BO{s.bestOf}</span>
      {s.maps.map((m, i) => {
        const art = mapArt(state, m.mapName);
        return (
          <span key={`${m.mapName}-${i}`} className={`mf-series-map is-${m.status} ${m.winner ? `won-${m.winner}` : ""} ${art.imageUrl ? "has-image" : ""}`} style={mapBackground(art.imageUrl)}>
            {art.logoUrl ? <img className="mf-map-logo" src={art.logoUrl} alt="" /> : null}
            <span className="mf-series-name">{m.displayName}</span>
            {m.status === "completed" || m.status === "live" ? (
              <span className="mf-series-score">
                {m.scoreLeft}–{m.scoreRight}
              </span>
            ) : m.pickedBy === "decider" ? (
              <span className="mf-series-score">DECIDER</span>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

const REASON_GLYPH: Record<string, string> = {
  ct_win_elimination: "✕",
  t_win_elimination: "✕",
  ct_win_defuse: "◆",
  t_win_bomb: "✸",
  ct_win_time: "◷",
  t_win_time: "◷",
  ct_win_rescue: "◇",
  unknown: "•",
};

export function RoundHistory({ state }: { state: HudState }) {
  const total = Math.max(state.match.regulationRounds ?? 24, state.roundHistory.length);
  const byRound = new Map(state.roundHistory.map((r) => [r.roundNumber, r]));
  return (
    <div className="mf-history" aria-label="round history">
      {Array.from({ length: total }, (_, i) => {
        const r = byRound.get(i + 1);
        const half = state.match.regulationRounds ? i + 1 === state.match.regulationRounds / 2 : false;
        return (
          <span key={i} className={`mf-history-cell ${r?.winner ? `won-${r.winner}` : ""} ${half ? "is-half" : ""}`} title={r ? `Round ${r.roundNumber}: ${r.reason}` : `Round ${i + 1}`}>
            {r ? (REASON_GLYPH[r.reason] ?? "•") : ""}
          </span>
        );
      })}
    </div>
  );
}
