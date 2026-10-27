import { useEffect, useRef, useState } from "react";
import { displayClock } from "@matchframe/hud-sdk";
import type { HudState, HudTeam } from "@matchframe/hud-sdk";
import { C4, Defuse, SmallBomb } from "../icons.tsx";
import { clock, roundLabel, sideClass, teamName } from "../util.ts";
import "../styles/matchbar.scss";
import TeamLogo from "./TeamLogo.tsx";

const BOMB_SECONDS = 40;
type Orientation = "left" | "right";

/** The team that won the round that just ended, for five seconds (a new round-history entry). */
function useRoundWinner(state: HudState): Orientation | null {
  const [winner, setWinner] = useState<Orientation | null>(null);
  const seen = useRef<number | null>(null);
  const last = state.roundHistory.at(-1);
  useEffect(() => {
    if (!last) return;
    if (seen.current === null) {
      seen.current = last.roundNumber; // already finished when the HUD opened
      return;
    }
    if (last.roundNumber === seen.current) return;
    seen.current = last.roundNumber;
    if (!last.winner) return;
    setWinner(last.winner);
    const t = setTimeout(() => setWinner(null), 5000);
    return () => clearTimeout(t);
  }, [last?.roundNumber, last?.winner]);
  return winner;
}

/**
 * Who is planting or defusing. The planter is the bomb carrier; the defuser is not reported by the
 * game, so the caption names the defending team instead (never guessed).
 */
function PlantDefuse({ state, orientation }: { state: HudState; orientation: Orientation }) {
  const team = state[orientation];
  const s = state.bomb?.state;
  if (s === "planting" && team.side === "T") {
    const carrier = team.players.find((p) => p.hasBomb);
    return (
      <div className={`defuse_plant_container ${orientation} show`}>
        <div className="defuse_plant_caption">
          <SmallBomb height={22} fill="var(--color-new-t)" />
          <div className="T">{carrier ? `${carrier.name} is planting the bomb` : "Planting the bomb"}</div>
        </div>
      </div>
    );
  }
  if (s === "defusing" && team.side === "CT") {
    return (
      <div className={`defuse_plant_container ${orientation} show`}>
        <div className="defuse_plant_caption">
          <Defuse height={22} width={22} fill="var(--color-new-ct)" />
          <div className="CT">{teamName(state, team)} defusing the bomb</div>
        </div>
      </div>
    );
  }
  return null;
}

function TeamScore({ state, team, orientation, won }: { state: HudState; team: HudTeam; orientation: Orientation; won: boolean }) {
  return (
    <>
      <div className={`team ${orientation} ${sideClass(team.side)}`}>
        <div className="team-name">{teamName(state, team)}</div>
        <TeamLogo team={team} />
        <div className="round-thingy">
          <div className="inner" />
        </div>
      </div>
      <PlantDefuse state={state} orientation={orientation} />
      <div className={`win_text ${won ? "show" : ""} ${orientation} ${sideClass(team.side)}`}>WINS THE ROUND!</div>
    </>
  );
}

function BombTimer({ state, receivedAt, now }: { state: HudState; receivedAt: number; now: number }) {
  const b = state.bomb;
  const show = !!b && (b.state === "planted" || b.state === "defusing");
  const remaining = show ? displayClock(b!.remainingSec, b!.clockRunning, receivedAt, now) : null;
  return (
    <div id="bomb_container">
      <div className={`bomb_timer ${show ? "show" : "hide"}`} style={{ height: `${Math.max(0, Math.min(100, ((remaining ?? 0) * 100) / BOMB_SECONDS))}%` }} />
      <div className={`bomb_icon ${show ? "show" : "hide"}`}>
        <C4 fill="white" />
      </div>
    </div>
  );
}

/** Top bar: team names and logos, scores, the round clock or bomb timer, the round and best-of. */
export default function MatchBar({ state, receivedAt, now }: { state: HudState; receivedAt: number; now: number }) {
  const winner = useRoundWinner(state);
  const planted = !!state.bomb && (state.bomb.state === "planted" || state.bomb.state === "defusing");
  const time = displayClock(state.match.phaseEndsInSec, state.match.clockRunning, receivedAt, now);
  const bo = state.series.bestOf ?? 0;
  return (
    <div id="matchbar">
      <TeamScore state={state} team={state.left} orientation="left" won={winner === "left"} />
      <div className={`score left ${sideClass(state.left.side)}`}>{state.left.score ?? 0}</div>
      <div id="timer" className={bo === 0 ? "no-bo" : ""}>
        <div id="round_timer_text" className={planted ? "hide" : ""}>
          {state.match.paused ? "PAUSE" : clock(time)}
        </div>
        <div id="round_now" className={planted ? "hide" : ""}>
          {roundLabel(state)}
        </div>
        <BombTimer state={state} receivedAt={receivedAt} now={now} />
      </div>
      <div className={`score right ${sideClass(state.right.side)}`}>{state.right.score ?? 0}</div>
      <TeamScore state={state} team={state.right} orientation="right" won={winner === "right"} />
    </div>
  );
}

/** Series wins under the bar (best of N). */
export function SeriesBox({ state }: { state: HudState }) {
  const bo = state.series.bestOf ?? 0;
  if (!bo) return null;
  const needed = Math.floor(bo / 2) + 1;
  const boxes = (team: HudTeam) =>
    Array.from({ length: needed }, (_, i) => <div key={i} className={`wins_box ${team.seriesWins > i ? "win" : ""} ${sideClass(team.side)}`} />);
  return (
    <div id="encapsulator">
      <div className="container left">
        <div className="series_wins left">
          <div className="wins_box_container">{boxes(state.left)}</div>
        </div>
      </div>
      <div id="series_container">
        <div id="series_text">BEST OF {bo}</div>
      </div>
      <div className="container right">
        <div className="series_wins right">
          <div className="wins_box_container">{boxes(state.right)}</div>
        </div>
      </div>
    </div>
  );
}
