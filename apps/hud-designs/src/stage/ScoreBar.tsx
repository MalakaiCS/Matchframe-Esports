import { memo, useRef } from "react";
import type { RefObject } from "react";
import type { HudState, HudTeam } from "@matchframe/hud-sdk";
import { aliveCount, clockText, isLive, roundWinner, secondsLeft, seriesBoxCount, seriesWon } from "../shared/format.ts";
import { BombIcon, KitIcon, SkullIcon } from "../shared/parts.ts";
import { useNow } from "../shared/useHud.ts";
import { TeamLogo, TimeoutPips } from "./bits.tsx";
import { colorOf, teamVars, timeoutTeam, type Settings } from "./util.ts";

/** CS2's bomb fuse (s). */
const BOMB_SECONDS = 40;

type Centre = "clock" | "planting" | "bomb" | "defuse" | "defused" | "exploded";

function centreMode(state: HudState): Centre {
  const b = state.bomb;
  const p = state.match.phase;
  if (b && isLive(p)) {
    if (b.state === "defusing") return "defuse";
    if (b.state === "planted") return "bomb";
    if (b.state === "planting") return "planting";
  }
  if (p === "over") {
    const reason = state.roundHistory[state.roundHistory.length - 1]?.reason ?? "";
    if (b?.state === "defused" || reason.includes("defuse")) return "defused";
    if (b?.state === "exploded" || reason.includes("bomb")) return "exploded";
  }
  return "clock";
}

/** The small line over the clock: the round, or what holds the game up. */
function roundLabel(state: HudState): string {
  const m = state.match;
  if (m.phase === "timeout_ct" || m.phase === "timeout_t") return "TIMEOUT";
  if (m.paused || m.phase === "paused") return "PAUSED";
  if (m.phase === "warmup") return "WARMUP";
  if (m.phase === "halftime") return "HALF TIME";
  if (m.phase === "gameover") return "MAP OVER";
  if (m.roundNumber === null) return "";
  if (m.regulationRounds && m.roundNumber > m.regulationRounds) return `OVERTIME ${m.roundNumber}`;
  return `ROUND ${m.roundNumber}`;
}

/** The round clock: the only part of the bar that re-renders ten times a second. */
const Clock = memo(function Clock({ sec, running, receivedAt, warn }: { sec: number | null; running: boolean; receivedAt: number; warn: boolean }) {
  const now = useNow(100);
  const left = secondsLeft(sec, running, receivedAt, now);
  return <span className={`st-clock ${warn && left !== null && left <= 10 ? "is-low" : ""}`}>{clockText(sec, running, receivedAt, now) || "–:––"}</span>;
});

/** Seconds left on the bomb's fuse, with tenths under ten seconds. */
const FuseText = memo(function FuseText({ sec, running, receivedAt }: { sec: number | null; running: boolean; receivedAt: number }) {
  const now = useNow(100);
  const left = secondsLeft(sec, running, receivedAt, now);
  if (left === null) return <span className="st-fuse-text" />;
  return <span className="st-fuse-text">{left < 10 ? left.toFixed(1) : Math.ceil(left)}</span>;
});

/** The fuse bar's fill, draining with the bomb (10 Hz); remembers where it stopped for the exit. */
const FuseFill = memo(function FuseFill({ sec, running, receivedAt, last }: { sec: number | null; running: boolean; receivedAt: number; last: RefObject<number> }) {
  const now = useNow(100);
  const left = secondsLeft(sec, running, receivedAt, now);
  const frac = left === null ? last.current : Math.max(0, Math.min(1, left / BOMB_SECONDS));
  last.current = frac;
  return <i className="st-fuse-fill" style={{ transform: `scaleX(${frac.toFixed(4)})` }} />;
});

/** A thin bar under the score bar while the bomb ticks: red, CT colour while it is being defused. */
function FuseBar({ state, receivedAt, mode, ct }: { state: HudState; receivedAt: number; mode: Centre; ct: string }) {
  const b = state.bomb;
  const on = mode === "bomb" || mode === "defuse";
  const last = useRef(1);
  const wasOn = useRef(false);
  if (on && !wasOn.current) last.current = 1;
  wasOn.current = on;
  return (
    <div className={`st-fuse ${on ? "is-on" : ""} ${mode === "defuse" ? "is-defuse" : ""}`} style={teamVars(ct)} aria-hidden={!on}>
      {on && b ? <FuseFill sec={b.remainingSec} running={b.clockRunning} receivedAt={receivedAt} last={last} /> : <i className="st-fuse-fill" style={{ transform: `scaleX(${last.current.toFixed(4)})` }} />}
    </div>
  );
}

/** Series boxes: one per map needed to win the series, lit for each map won. */
function SeriesPips({ count, won }: { count: number; won: number }) {
  if (count === 0) return null;
  return (
    <span className={`st-sb-pips n-${Math.min(count, 5)}`} aria-label={`${won} of ${count} maps won`}>
      {Array.from({ length: Math.min(count, 5) }, (_, i) => (
        <i key={i} className={i < won ? "is-won" : ""} />
      ))}
    </span>
  );
}

function Half({ team, color, align, pips, won }: { team: HudTeam; color: string; align: "left" | "right"; pips: number; won: number }) {
  return (
    <div className={`st-sb-half st-sb-${align}`} style={teamVars(color)}>
      <span className="st-sb-edge" aria-hidden />
      <span className="st-sb-logo">
        <TeamLogo team={team} />
      </span>
      <SeriesPips count={pips} won={won} />
      <span className="st-sb-score">
        <span key={team.score ?? 0} className="st-sb-num">
          {team.score ?? 0}
        </span>
      </span>
    </div>
  );
}

/** The event line over the score bar: the event on the left, the stage or match on the right. */
function EventLine({ state, settings }: { state: HudState; settings: Settings }) {
  const left = settings.eventTitle || state.event.name || "";
  const stage = [state.event.stage, state.event.matchTitle].filter((x): x is string => !!x).join(" · ");
  const right = settings.stageTitle || stage || (state.series.bestOf ? `BEST OF ${state.series.bestOf}` : "");
  if (!left && !right) return null;
  return (
    <div className="st-event">
      <span className="st-event-l">{left}</span>
      <span className="st-event-r">{right}</span>
    </div>
  );
}

const REASON: [string, string][] = [
  ["defuse", "BOMB DEFUSED"],
  ["bomb", "BOMB EXPLODED"],
  ["time", "TIME RAN OUT"],
  ["surrender", "SURRENDER"],
];

/**
 * Under the bar: players alive, the round's winner, a timeout or a pause (one at a time). With the
 * freeze-time scoreboard up, a timeout shows over the scoreboard instead.
 */
function UnderBar({ state, settings, colors, boardOn }: { state: HudState; settings: Settings; colors: { left: string; right: string }; boardOn: boolean }) {
  const p = state.match.phase;
  const winner = roundWinner(state);
  const timeout = timeoutTeam(state);
  // The engine also reports a timeout as paused: it shows as the timeout, never as a pause.
  const inTimeout = p === "timeout_ct" || p === "timeout_t";
  if (winner) {
    const team = state[winner];
    const reason = state.roundHistory[state.roundHistory.length - 1]?.reason ?? "";
    const why = REASON.find(([k]) => reason.includes(k))?.[1] ?? "ELIMINATION";
    return (
      <div key={`win-${winner}-${state.match.roundNumber}`} className="st-under st-win" style={teamVars(colors[winner])}>
        <span className="st-win-logo">
          <TeamLogo team={team} />
        </span>
        <span className="st-win-text">
          <b>{team.shortName || team.name}</b> WIN THE ROUND
        </span>
        <span className="st-win-why">
          {why === "BOMB DEFUSED" ? <KitIcon size={15} /> : why === "BOMB EXPLODED" ? <BombIcon size={16} /> : why === "ELIMINATION" ? <SkullIcon size={15} /> : null}
          {why}
        </span>
      </div>
    );
  }
  if (inTimeout && boardOn && timeout) return null;
  if (inTimeout && !timeout) {
    return (
      <div key="timeout-any" className="st-under st-paused">
        <span className="st-paused-text">TACTICAL TIMEOUT</span>
      </div>
    );
  }
  if (timeout) {
    const color = timeout === state.left ? colors.left : colors.right;
    return (
      <div key="timeout" className="st-under st-timeout" style={teamVars(color)}>
        <span className="st-timeout-team">{timeout.shortName || timeout.name}</span>
        <span className="st-timeout-text">TACTICAL TIMEOUT</span>
        <TimeoutPips left={timeout.timeoutsRemaining} className="st-timeout-pips" />
      </div>
    );
  }
  if (state.match.paused || p === "paused") {
    return (
      <div key="paused" className="st-under st-paused">
        <span className="st-paused-text">MATCH PAUSED</span>
      </div>
    );
  }
  // Players alive: once someone has gone down in the round (5 VS 5 adds nothing).
  const down = aliveCount(state.left) < state.left.players.length || aliveCount(state.right) < state.right.players.length;
  if (settings.showAlive && isLive(p) && down) {
    return (
      <div key="alive" className="st-under st-alive">
        <span className="st-alive-n" style={teamVars(colors.left)}>
          <span key={aliveCount(state.left)}>{aliveCount(state.left)}</span>
        </span>
        <span className="st-alive-vs">VS</span>
        <span className="st-alive-n" style={teamVars(colors.right)}>
          <span key={aliveCount(state.right)}>{aliveCount(state.right)}</span>
        </span>
      </div>
    );
  }
  return null;
}

/**
 * Top centre: the event line, the score bar (logos, series boxes, scores, the round and its clock;
 * the bomb or defuse with the fuse's seconds while it ticks), a fuse bar under it, and the badge
 * under the bar.
 */
export function ScoreBar({ state, receivedAt, settings, compact, boardOn }: { state: HudState; receivedAt: number; settings: Settings; compact: boolean; boardOn: boolean }) {
  const m = state.match;
  const colors = { left: colorOf(state.left, settings), right: colorOf(state.right, settings) };
  const mode = centreMode(state);
  const pips = seriesBoxCount(state.series.bestOf);
  const ct = state.left.side === "CT" ? colors.left : state.right.side === "CT" ? colors.right : settings.ctColor;
  const b = state.bomb;
  return (
    <div className="st-top">
      {compact ? null : <EventLine state={state} settings={settings} />}
      <div className="st-sb" data-centre={mode}>
        <Half team={state.left} color={colors.left} align="left" pips={pips} won={seriesWon(state, "left")} />
        <Half team={state.right} color={colors.right} align="right" pips={pips} won={seriesWon(state, "right")} />
        <div className={`st-sb-centre is-${mode}`} style={mode === "defuse" || mode === "defused" ? teamVars(ct) : undefined}>
          <span className="st-sb-clockbox">
            <span className={`st-sb-round ${m.paused || m.phase === "paused" || m.phase.startsWith("timeout") ? "is-hold" : ""}`}>{roundLabel(state)}</span>
            <Clock sec={m.phaseEndsInSec} running={m.clockRunning && !m.paused} receivedAt={receivedAt} warn={m.phase === "live"} />
          </span>
          <span className="st-sb-bomb">
            {mode === "defuse" || mode === "defused" ? <KitIcon size={26} /> : <BombIcon size={30} />}
            {mode === "bomb" || mode === "defuse" ? b ? <FuseText sec={b.remainingSec} running={b.clockRunning} receivedAt={receivedAt} /> : null : <span className="st-sb-bomb-label">{mode === "planting" ? "PLANTING" : mode === "defused" ? "DEFUSED" : mode === "exploded" ? "EXPLODED" : ""}</span>}
          </span>
        </div>
      </div>
      <FuseBar state={state} receivedAt={receivedAt} mode={mode} ct={ct} />
      <UnderBar state={state} settings={settings} colors={colors} boardOn={boardOn} />
    </div>
  );
}
