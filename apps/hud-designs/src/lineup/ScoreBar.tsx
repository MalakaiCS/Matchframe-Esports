import { memo, useRef } from "react";
import type { RefObject } from "react";
import type { HudPhase, HudState, HudTeam } from "@matchframe/hud-sdk";
import { clockText, roundWinner, secondsLeft, seriesBoxCount, seriesWon } from "../shared/format.ts";
import { BombIcon, KitIcon } from "../shared/parts.ts";
import { useNow } from "../shared/useHud.ts";
import { TeamLogo } from "./Badge.tsx";
import { colorOf, teamVars, type Settings } from "./util.ts";

/** CS2's bomb fuse. */
const BOMB_SECONDS = 40;

const PHASE_LABEL: Partial<Record<HudPhase, string>> = {
  warmup: "WARMUP",
  halftime: "HALFTIME",
  timeout_ct: "TIMEOUT",
  timeout_t: "TIMEOUT",
  gameover: "MAP OVER",
};

/** The round clock: the only part of the bar that re-renders ten times a second. */
const Clock = memo(function Clock({ sec, running, receivedAt, live }: { sec: number | null; running: boolean; receivedAt: number; live: boolean }) {
  const now = useNow(100);
  const left = secondsLeft(sec, running, receivedAt, now);
  return <span className={`lu-clock ${live && left !== null && left <= 10 ? "is-low" : ""}`}>{clockText(sec, running, receivedAt, now) || "–"}</span>;
});

function Fill({ frac }: { frac: number }) {
  return <div className="lu-bombbar-fill" style={{ transform: `scaleX(${frac.toFixed(4)})` }} />;
}

/** The draining fill while the bomb ticks (10 Hz); it remembers where it stopped for the exit. */
const BombFill = memo(function BombFill({ sec, running, receivedAt, last }: { sec: number | null; running: boolean; receivedAt: number; last: RefObject<number> }) {
  const now = useNow(100);
  const left = secondsLeft(sec, running, receivedAt, now);
  const frac = left === null ? last.current : Math.max(0, Math.min(1, left / BOMB_SECONDS));
  last.current = frac;
  return <Fill frac={frac} />;
});

/** Bar under the score bar while the bomb is planted: slides down from under it and drains with the fuse. */
function BombBar({ state, receivedAt }: { state: HudState; receivedAt: number }) {
  const b = state.bomb;
  const on = !!b && (b.state === "planted" || b.state === "defusing") && state.match.phase !== "over";
  const last = useRef(1);
  // A new plant starts full.
  const wasOn = useRef(false);
  if (on && !wasOn.current) last.current = 1;
  wasOn.current = on;
  return (
    <div className={`lu-bombbar ${on ? "is-on" : ""}`} aria-hidden={!on}>
      {on && b ? <BombFill sec={b.remainingSec} running={b.clockRunning} receivedAt={receivedAt} last={last} /> : <Fill frac={last.current} />}
    </div>
  );
}

/** The panel's countdown: the bomb's fuse while defusing (the defuse itself is not reported), the round clock while planting. */
const PanelClock = memo(function PanelClock({ sec, running, receivedAt, fuse }: { sec: number | null; running: boolean; receivedAt: number; fuse: boolean }) {
  const now = useNow(100);
  const left = secondsLeft(sec, running, receivedAt, now);
  const frac = fuse && left !== null ? Math.max(0, Math.min(1, left / BOMB_SECONDS)) : 1;
  const text = left === null ? "" : fuse ? left.toFixed(2).padStart(5, "0") : clockText(sec, running, receivedAt, now);
  return (
    <>
      <span className="lu-plant-time">{text}</span>
      <span className="lu-plant-bar" aria-hidden>
        <i style={{ transform: `scaleX(${frac.toFixed(4)})` }} />
      </span>
    </>
  );
});

/**
 * Who is planting or defusing, under the score bar. The planter is the bomb carrier; the defuser
 * is not reported by the game, so the defending team is named instead (never guessed).
 */
function PlantPanel({ state, receivedAt, settings }: { state: HudState; receivedAt: number; settings: Settings }) {
  const b = state.bomb;
  const planting = b?.state === "planting";
  const defusing = b?.state === "defusing" && state.match.phase !== "over";
  const lastText = useRef("");
  const lastKind = useRef<"plant" | "defuse">("plant");
  const t = state.left.side === "T" ? state.left : state.right;
  const ct = state.left.side === "CT" ? state.left : state.right;
  if (planting) {
    const carrier = t.players.find((p) => p.hasBomb);
    lastText.current = `${carrier ? carrier.name : t.shortName || t.name} IS PLANTING THE BOMB`;
    lastKind.current = "plant";
  } else if (defusing) {
    lastText.current = `${ct.shortName || ct.name} IS DEFUSING THE BOMB`;
    lastKind.current = "defuse";
  }
  const team = lastKind.current === "plant" ? t : ct;
  return (
    <div className={`lu-plant is-${lastKind.current} ${planting || defusing ? "is-on" : ""}`} style={teamVars(colorOf(team, settings))} aria-hidden={!(planting || defusing)}>
      <span className="lu-plant-text">{lastText.current}</span>
      {planting ? <PanelClock sec={state.match.phaseEndsInSec} running={state.match.clockRunning} receivedAt={receivedAt} fuse={false} /> : defusing && b ? <PanelClock sec={b.remainingSec} running={b.clockRunning} receivedAt={receivedAt} fuse /> : null}
    </div>
  );
}

/** The series boxes between score and logo: one per map needed to win, filled for each map won. */
function SeriesBoxes({ count, won }: { count: number; won: number }) {
  if (count === 0) return null;
  return (
    <span className={`lu-sb-boxes n-${Math.min(count, 7)}`} aria-label={`${won} of ${count} maps won`}>
      {Array.from({ length: count }, (_, i) => (
        <i key={i} className={i < won ? "is-won" : ""} />
      ))}
    </span>
  );
}

function Side({ team, color, align, boxes, won }: { team: HudTeam; color: string; align: "left" | "right"; boxes: number; won: number }) {
  return (
    <div className={`lu-sb-side lu-sb-${align}`} style={teamVars(color)}>
      <span className="lu-sb-edge" aria-hidden />
      <span className="lu-sb-score">
        <span key={team.score ?? 0} className="lu-score">
          {team.score ?? 0}
        </span>
      </span>
      <SeriesBoxes count={boxes} won={won} />
      <TeamLogo team={team} className="lu-sb-logo" />
    </div>
  );
}

/**
 * The score bar: scores at both ends over each team's colour, logos, and the round clock with the
 * round number. Bomb planted: the clock cross-fades to the bomb glyph and the bomb bar slides down
 * under the bar. Round won: a panel in the winner's colours grows out of the centre over the whole
 * bar (scores included), the winner's logo comes in, and it folds back to the centre at freeze time.
 */
export function ScoreBar({ state, receivedAt, settings }: { state: HudState; receivedAt: number; settings: Settings }) {
  const m = state.match;
  const leftColor = colorOf(state.left, settings);
  const rightColor = colorOf(state.right, settings);
  const winner = roundWinner(state);
  // The banner keeps its team while it folds away at freeze time.
  const bannerSide = useRef<"left" | "right">("left");
  if (winner) bannerSide.current = winner;
  const bannerTeam = state[bannerSide.current];
  const bannerColor = bannerSide.current === "left" ? leftColor : rightColor;

  const b = state.bomb;
  const bombOn = !!b && (b.state === "planted" || b.state === "defusing") && m.phase !== "over";
  const after = b?.state === "defused" ? "defused" : b?.state === "exploded" ? "exploded" : null;
  const live = m.phase === "live";
  const round = m.roundNumber !== null ? `ROUND ${m.roundNumber}${m.regulationRounds && m.roundNumber <= m.regulationRounds ? `/${m.regulationRounds}` : ""}` : "";
  const label = m.paused ? "PAUSED" : (PHASE_LABEL[m.phase] ?? round);
  const centre = bombOn ? "is-bomb" : after ? `is-${after}` : "";
  const boxes = seriesBoxCount(state.series.bestOf);

  return (
    <>
      <div className="lu-scorebar" data-phase={m.phase}>
        <div className={`lu-sb ${winner ? "is-won" : ""}`}>
          <Side team={state.left} color={leftColor} align="left" boxes={boxes} won={seriesWon(state, "left")} />
          <Side team={state.right} color={rightColor} align="right" boxes={boxes} won={seriesWon(state, "right")} />
          <div className={`lu-sb-centre ${centre}`}>
            <span className="lu-sb-clock">
              <Clock sec={m.phaseEndsInSec} running={m.clockRunning && !m.paused} receivedAt={receivedAt} live={live} />
              <span className={`lu-sb-round ${m.paused ? "is-paused" : ""}`}>{label}</span>
            </span>
            <span className="lu-sb-glyph lu-sb-glyph-bomb">
              <BombIcon size={62} />
            </span>
            <span className="lu-sb-glyph lu-sb-glyph-defused">
              <KitIcon size={40} />
            </span>
            <span className="lu-sb-glyph lu-sb-glyph-exploded">
              <BombIcon size={62} />
            </span>
          </div>
          <div className="lu-banner" style={teamVars(bannerColor)} aria-hidden={!winner} />
          <div className="lu-banner-content" style={teamVars(bannerColor)} aria-hidden={!winner}>
            <TeamLogo team={bannerTeam} className="lu-banner-logo" />
          </div>
        </div>
        <BombBar state={state} receivedAt={receivedAt} />
      </div>
      <PlantPanel state={state} receivedAt={receivedAt} settings={settings} />
    </>
  );
}
