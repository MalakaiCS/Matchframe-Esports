import { useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { HudState, HudTeam } from "@matchframe/hud-sdk";
import { mapArt } from "../shared/art.ts";
import { clockText, lossBonus, money, roundWinner, secondsLeft, seriesBoxCount, seriesWindow, seriesWon } from "../shared/format.ts";
import { BombIcon, KitIcon } from "../shared/parts.ts";
import { useNow } from "../shared/useHud.ts";
import { Flip, sizeClass, TeamBadge, Watermark } from "./bits.tsx";
import type { Align } from "./bits.tsx";

const BOMB_FUSE = 40;

type Match = HudState["match"];
type Bomb = NonNullable<HudState["bomb"]>;

const bombActive = (state: HudState): boolean => {
  const b = state.bomb;
  const p = state.match.phase;
  return !!b && (b.state === "planted" || b.state === "defusing") && (p === "live" || p === "bomb" || p === "defuse");
};

const sideTeam = (state: HudState, side: "CT" | "T"): HudTeam | null => (state.left.side === side ? state.left : state.right.side === side ? state.right : null);

/** What the centre of the bar shows: the clock, or the bomb, the defuse, and how a bomb round ended. */
type CenterMode = "clock" | "bomb" | "defuse" | "defused" | "exploded";

function centerMode(state: HudState): CenterMode {
  if (bombActive(state)) return state.bomb!.state === "defusing" ? "defuse" : "bomb";
  if (state.match.phase === "over") {
    const reason = state.roundHistory[state.roundHistory.length - 1]?.reason;
    if (reason === "ct_win_defuse" || state.bomb?.state === "defused") return "defused";
    if (reason === "t_win_bomb" || state.bomb?.state === "exploded") return "exploded";
  }
  return "clock";
}

/** The line under the clock: the round, or what holds the game up. */
function roundLabel(state: HudState): string {
  const m = state.match;
  if (m.phase === "timeout_ct" || m.phase === "timeout_t") return `${sideTeam(state, m.phase === "timeout_ct" ? "CT" : "T")?.shortName ?? (m.phase === "timeout_ct" ? "CT" : "T")} TIMEOUT`;
  if (m.paused || m.phase === "paused") return "PAUSED";
  if (m.phase === "warmup") return "WARMUP";
  if (m.phase === "halftime") return "HALFTIME";
  if (m.phase === "gameover") return "MAP OVER";
  if (m.roundNumber === null) return "";
  if (m.regulationRounds && m.roundNumber > m.regulationRounds) return `OVERTIME ${m.roundNumber}`;
  return `ROUND ${m.roundNumber}${m.regulationRounds ? `/${m.regulationRounds}` : ""}`;
}

/** Only this re-renders at 10 Hz while the round clock runs. */
function Ticking({ sec, receivedAt, warn }: { sec: number; receivedAt: number; warn: boolean }) {
  const now = useNow(100);
  const left = secondsLeft(sec, true, receivedAt, now) ?? 0;
  return <span className={warn && left <= 10 ? "is-low" : ""}>{clockText(sec, true, receivedAt, now)}</span>;
}

function Center({ state, receivedAt }: { state: HudState; receivedAt: number }) {
  const m: Match = state.match;
  const mode = centerMode(state);
  const running = m.clockRunning && !m.paused && m.phaseEndsInSec !== null;
  // The clock flips over whenever the kind of clock changes (freeze time, round, after the round).
  const kind = m.phase === "freezetime" ? "freeze" : m.phase === "live" || m.phase === "bomb" || m.phase === "defuse" ? "live" : m.phase;
  return (
    <div className={`vx-center is-${mode}`}>
      <i className="vx-center-bg bg-bomb" />
      <i className="vx-center-bg bg-defuse" />
      <i className="vx-center-bg bg-defused" />
      <div className="vx-clock">
        <div key={kind} className="vx-clock-flip">
          {running ? <Ticking sec={m.phaseEndsInSec!} receivedAt={receivedAt} warn={kind === "live"} /> : <span>{clockText(m.phaseEndsInSec, false, receivedAt, 0) || "–:––"}</span>}
        </div>
        <div className="vx-round">{roundLabel(state)}</div>
      </div>
      <span className="vx-center-icon icon-bomb">
        <BombIcon size={42} />
      </span>
      <span className="vx-center-icon icon-kit">
        <KitIcon size={34} />
      </span>
    </div>
  );
}

/** The series boxes: an outlined capsule at the bar's end, one cell per map needed, filled for each map won. */
function SeriesBoxes({ count, won, align }: { count: number; won: number; align: Align }) {
  if (count === 0) return null;
  return (
    <span className={`vx-boxes vx-${align} n-${Math.min(count, 7)}`} aria-label={`${won} of ${count} maps won`}>
      {Array.from({ length: Math.min(count, 7) }, (_, i) => (
        <i key={i} className={i < won ? "is-won" : ""} />
      ))}
    </span>
  );
}

function TeamBlock({ team, align }: { team: HudTeam; align: Align }) {
  return (
    <div className={`vx-team vx-${align}`}>
      <Watermark team={team} />
      <TeamBadge team={team} />
      <div className="vx-score">
        <Flip value={team.score ?? 0} />
      </div>
    </div>
  );
}

function LossPill({ team, align, on }: { team: HudTeam; align: Align; on: boolean }) {
  const bonus = lossBonus(team.consecutiveRoundLosses);
  if (bonus === null) return null;
  return (
    <div className={`vx-pill-slot vx-${align} ${on ? "is-on" : ""}`}>
      <div className="vx-pill">
        <span className="vx-pill-label">LOSS BONUS</span>
        <span className="vx-pill-value">{money(bonus).replace(",", "")}</span>
      </div>
    </div>
  );
}

/**
 * Freeze time: the series maps under the bar. With the operator's map art a tile shows the map's
 * picture behind it and its logo in place of the name; four or five maps stack each tile in two rows.
 */
function SeriesStrip({ state, on }: { state: HudState; on: boolean }) {
  const s = state.series;
  if (!s.bestOf || s.maps.length === 0) return null;
  const maps = seriesWindow(s.maps, 5);
  return (
    <div className={`vx-series ${on ? "is-on" : ""} ${maps.length > 3 ? "is-many" : ""}`}>
      {maps.map((m, i) => {
        const done = m.status === "completed" || m.status === "forfeited";
        const picker = m.pickedBy === "left" || m.pickedBy === "right" ? state[m.pickedBy] : null;
        const art = mapArt(state, m.mapName);
        return (
          <div
            key={`${m.mapName}-${i}`}
            className={`vx-map is-${m.status} ${m.winner ? `won-${m.winner}` : ""} ${art.imageUrl ? "has-image" : ""}`}
            style={art.imageUrl ? { backgroundImage: `url("${art.imageUrl}")` } : undefined}
            title={m.displayName}
          >
            <span className="vx-map-id">{art.logoUrl ? <img className="vx-map-logo" src={art.logoUrl} alt={m.displayName} /> : <span className="vx-map-name">{m.displayName}</span>}</span>
            <span className="vx-map-info">
              {picker ? <TeamBadge team={picker} className="vx-map-pick" /> : m.pickedBy === "decider" ? <span className="vx-map-decider">DECIDER</span> : null}
              {m.status === "live" ? <span className="vx-live">LIVE</span> : null}
              {done ? (
                <span className="vx-map-score">
                  <b className={m.winner === "left" ? "is-win" : ""}>{m.scoreLeft}</b>
                  <i>-</i>
                  <b className={m.winner === "right" ? "is-win" : ""}>{m.scoreRight}</b>
                </span>
              ) : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Fill scale for the defuse: the clock the defuse started with (5 s with a kit, 10 s without). */
const defuseScale = (sec: number | null): number => (sec !== null && sec <= 5.05 ? 5 : 10);

/** A defuse countdown is short; a longer bomb clock while defusing is still the fuse. */
const isDefuseClock = (bomb: Bomb): boolean => bomb.state === "defusing" && bomb.remainingSec !== null && bomb.remainingSec <= 10.05;

interface BombSnap {
  bomb: Bomb;
  receivedAt: number;
  /** The fuse as last seen while planted (the game reports the defuse clock instead while defusing). */
  fuse: { sec: number | null; running: boolean; at: number } | null;
  scale: number;
}

function BombFace({ snap, now, ctName }: { snap: BombSnap; now: number; ctName: string | null }) {
  const { bomb, receivedAt, fuse } = snap;
  const defuseClock = isDefuseClock(bomb);
  const fuseSec = defuseClock ? (fuse ? secondsLeft(fuse.sec, fuse.running, fuse.at, now) : null) : secondsLeft(bomb.remainingSec, bomb.clockRunning, receivedAt, now);
  const defuseSec = defuseClock ? secondsLeft(bomb.remainingSec, bomb.clockRunning, receivedAt, now) : null;
  const f = fuseSec === null ? 1 : Math.max(0, Math.min(1, fuseSec / BOMB_FUSE));
  const d = defuseSec === null ? 1 : Math.max(0, Math.min(1, defuseSec / snap.scale));
  return (
    <>
      <div className="vx-bomb-bar">
        <i className="vx-bomb-fill" style={{ transform: `scaleX(${f})` }} />
        <span className="vx-bomb-sec">{fuseSec === null ? "" : fuseSec.toFixed(1)}</span>
      </div>
      <div className="vx-defuse-bar">
        <i className="vx-defuse-fill" style={{ transform: `scaleX(${d})` }} />
        <span className="vx-defuse-text">
          {ctName ? <b>{ctName}</b> : null}
          {ctName ? " IS DEFUSING THE BOMB" : "BOMB IS BEING DEFUSED"}
        </span>
      </div>
    </>
  );
}

/** Ticks at 10 Hz while the bomb is down. */
function BombTicking({ snap, ctName }: { snap: BombSnap; ctName: string | null }) {
  const now = useNow(100);
  return <BombFace snap={snap} now={now} ctName={ctName} />;
}

function BombBar({ state, receivedAt }: { state: HudState; receivedAt: number }) {
  const on = bombActive(state);
  const bomb = state.bomb;
  const defusing = on && bomb!.state === "defusing";
  // The defuse scale is fixed when the defuse starts, so the bar drains from full to empty.
  const [defuse, setDefuse] = useState({ on: false, scale: 10 });
  if (defusing !== defuse.on) setDefuse({ on: defusing, scale: defusing ? defuseScale(bomb!.remainingSec) : 10 });
  const fuse = useRef<BombSnap["fuse"]>(null);
  if (on && bomb!.state === "planted") fuse.current = { sec: bomb!.remainingSec, running: bomb!.clockRunning, at: receivedAt };
  if (!bomb || bomb.state === "carried" || bomb.state === "dropped") fuse.current = null;
  // While leaving, the bars keep what they last showed.
  const last = useRef<BombSnap | null>(null);
  if (on) last.current = { bomb: bomb!, receivedAt, fuse: fuse.current, scale: defuse.scale };
  const snap = last.current;
  const ct = sideTeam(state, "CT");
  const ctName = ct ? ct.name : null;
  return (
    <div className="vx-bomb-slot">
      <div className={`vx-bomb ${on ? "is-on" : ""} ${(on ? defusing : snap?.bomb.state === "defusing") ? "is-defuse" : ""}`}>
        {on && snap ? <BombTicking snap={snap} ctName={ctName} /> : snap ? <BombFace snap={snap} now={performance.now()} ctName={ctName} /> : null}
      </div>
    </div>
  );
}

function WinnerCard({ state, color }: { state: HudState; color: { left: string; right: string } }) {
  const winner = roundWinner(state);
  const last = useRef<{ team: HudTeam; side: Align } | null>(null);
  if (winner) last.current = { team: state[winner], side: winner };
  const w = last.current;
  return (
    <div className={`vx-win ${winner ? "is-on" : ""}`} style={w ? ({ "--team": color[w.side] } as CSSProperties) : undefined}>
      {w ? (
        <>
          <Watermark team={w.team} />
          <div className={`vx-win-name ${sizeClass(w.team.name.length, 16, 20, 24)}`}>{w.team.name}</div>
          <div className="vx-win-sub">WINS THE ROUND</div>
        </>
      ) : null}
    </div>
  );
}

/**
 * Top centre: both teams' logos and scores around the clock, series boxes at the ends; in freeze time the
 * loss bonus and the series maps; the bomb and defuse bars while the bomb is down; the round
 * winner after the round.
 */
export function ScoreBar({ state, receivedAt, extras, color }: { state: HudState; receivedAt: number; extras: boolean; color: { left: string; right: string } }) {
  const boxes = seriesBoxCount(state.series.bestOf);
  return (
    <div className="vx-top">
      <SeriesBoxes count={boxes} won={seriesWon(state, "left")} align="left" />
      <SeriesBoxes count={boxes} won={seriesWon(state, "right")} align="right" />
      <LossPill team={state.left} align="left" on={extras} />
      <LossPill team={state.right} align="right" on={extras} />
      <div className="vx-bar">
        <TeamBlock team={state.left} align="left" />
        <Center state={state} receivedAt={receivedAt} />
        <TeamBlock team={state.right} align="right" />
      </div>
      <SeriesStrip state={state} on={extras} />
      <BombBar state={state} receivedAt={receivedAt} />
      <WinnerCard state={state} color={color} />
    </div>
  );
}
