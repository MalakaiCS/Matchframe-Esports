import { useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { HudState, HudTeam } from "@matchframe/hud-sdk";
import { clockText, lossBonus, money, roundWinner, secondsLeft } from "../shared/format.ts";
import { BombIcon, KitIcon } from "../shared/parts.ts";
import { useNow } from "../shared/useHud.ts";
import { Flip, sizeClass, TeamBadge } from "./bits.tsx";
import type { Align } from "./bits.tsx";

const BOMB_FUSE = 40;

type Match = HudState["match"];
type Bomb = NonNullable<HudState["bomb"]>;

const bombActive = (state: HudState): boolean => {
  const b = state.bomb;
  const p = state.match.phase;
  return !!b && (b.state === "planted" || b.state === "defusing") && (p === "live" || p === "bomb" || p === "defuse");
};

/** The line under the clock: the round, or what holds the game up. */
function roundLabel(state: HudState): string {
  const m = state.match;
  const sideTeam = (side: "CT" | "T") => (state.left.side === side ? state.left : state.right.side === side ? state.right : null);
  if (m.phase === "timeout_ct" || m.phase === "timeout_t") return `${sideTeam(m.phase === "timeout_ct" ? "CT" : "T")?.shortName ?? (m.phase === "timeout_ct" ? "CT" : "T")} TIMEOUT`;
  if (m.paused || m.phase === "paused") return "PAUSED";
  if (m.phase === "warmup") return "WARMUP";
  if (m.phase === "halftime") return "HALFTIME";
  if (m.phase === "gameover") return "MAP OVER";
  if (m.roundNumber === null) return "";
  if (m.regulationRounds && m.roundNumber > m.regulationRounds) return `OVERTIME · R${m.roundNumber}`;
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
  const bomb = bombActive(state);
  const running = m.clockRunning && !m.paused && m.phaseEndsInSec !== null;
  // The clock flips over whenever the kind of clock changes (freeze time, round, after the round).
  const mode = m.phase === "freezetime" ? "freeze" : m.phase === "live" || m.phase === "bomb" || m.phase === "defuse" ? "live" : m.phase;
  return (
    <div className={`vx-center ${bomb ? "is-bomb" : ""}`}>
      <div className="vx-clock-slot">
        <div className="vx-clock">
          <div key={mode} className="vx-clock-flip">
            {running ? <Ticking sec={m.phaseEndsInSec!} receivedAt={receivedAt} warn={mode === "live"} /> : <span>{clockText(m.phaseEndsInSec, false, receivedAt, 0) || "–:––"}</span>}
          </div>
        </div>
        <div className="vx-center-bomb">
          <BombIcon size={40} className="vx-center-bomb-icon" />
        </div>
      </div>
      <div className="vx-round">{roundLabel(state)}</div>
    </div>
  );
}

function Pips({ n }: { n: number | null }) {
  if (n === null) return null;
  return (
    <span className="vx-pips" aria-label={`${n} timeouts left`}>
      {Array.from({ length: Math.max(3, Math.min(5, n)) }, (_, i) => (
        <i key={i} className={i < n ? "is-on" : ""} />
      ))}
    </span>
  );
}

function Plate({ team, align, bestOf }: { team: HudTeam; align: Align; bestOf: number | null }) {
  const needed = bestOf && bestOf > 1 ? Math.floor(bestOf / 2) + 1 : 0;
  return (
    <div className={`vx-plate vx-${align}`}>
      <Pips n={team.timeoutsRemaining} />
      <TeamBadge team={team} />
      <div className="vx-plate-text">
        <div className={`vx-plate-name ${sizeClass(team.name.length, 11, 15, 19)}`}>{team.name}</div>
        {needed ? (
          <div className="vx-plate-series">
            {Array.from({ length: needed }, (_, i) => (
              <i key={i} className={i < team.seriesWins ? "is-won" : ""} />
            ))}
          </div>
        ) : null}
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
        <span className="vx-pill-value">{money(bonus)}</span>
      </div>
    </div>
  );
}

function SeriesStrip({ state, on }: { state: HudState; on: boolean }) {
  const s = state.series;
  if (!s.bestOf || s.maps.length === 0) return null;
  const short = (k: "left" | "right" | "decider" | null) => (k === "left" ? state.left.shortName : k === "right" ? state.right.shortName : null);
  return (
    <div className={`vx-series ${on ? "is-on" : ""} ${s.maps.length > 3 ? "is-many" : ""}`}>
      {s.maps.map((m, i) => {
        const done = m.status === "completed" || m.status === "forfeited";
        const sub = m.status === "live" ? "LIVE" : m.pickedBy === "decider" ? "DECIDER" : short(m.pickedBy) ? `${short(m.pickedBy)} PICK` : m.status === "upcoming" ? "UPCOMING" : "";
        return (
          <div key={`${m.mapName}-${i}`} className={`vx-map is-${m.status} ${m.winner ? `won-${m.winner}` : ""}`}>
            <div className="vx-map-text">
              <span className="vx-map-name">{m.displayName}</span>
              <span className="vx-map-sub">
                {m.status === "live" ? <i className="vx-live-dot" /> : null}
                {sub}
              </span>
            </div>
            {done ? (
              <span className="vx-map-score">
                <b className={m.winner === "left" ? "is-win" : ""}>{m.scoreLeft}</b>
                <i>:</i>
                <b className={m.winner === "right" ? "is-win" : ""}>{m.scoreRight}</b>
              </span>
            ) : null}
            <i className="vx-map-mark" />
          </div>
        );
      })}
    </div>
  );
}

/** Fill scale for the defuse: the clock the defuse started with (5 s with a kit, 10 s without), else the fuse. */
const defuseScale = (sec: number | null): number => (sec === null ? BOMB_FUSE : sec <= 5.05 ? 5 : sec <= 10.05 ? 10 : BOMB_FUSE);

function BombFace({ sec, scale, defusing, site }: { sec: number; scale: number; defusing: boolean; site: string | null }) {
  const f = Math.max(0, Math.min(1, sec / scale));
  return (
    <>
      <div className="vx-bomb-bar">
        <i className="vx-bomb-fill" style={{ transform: `scaleX(${f})` }} />
        <span className="vx-bomb-icon">{defusing ? <KitIcon size={20} /> : <BombIcon size={20} />}</span>
        <span className="vx-bomb-label">{defusing ? "DEFUSING" : "BOMB PLANTED"}</span>
        {site ? <span className="vx-bomb-site">SITE {site}</span> : null}
        <span className={`vx-bomb-sec ${!defusing && sec <= 10 ? "is-low" : ""}`}>{sec.toFixed(1)}</span>
      </div>
      <div className="vx-bomb-line">BOMB BEING DEFUSED</div>
    </>
  );
}

/** Ticks at 10 Hz while the bomb is down. */
function BombTicking({ bomb, receivedAt, scale }: { bomb: Bomb; receivedAt: number; scale: number }) {
  const now = useNow(100);
  return <BombFace sec={secondsLeft(bomb.remainingSec, bomb.clockRunning, receivedAt, now) ?? 0} scale={scale} defusing={bomb.state === "defusing"} site={bomb.site} />;
}

function BombBar({ state, receivedAt }: { state: HudState; receivedAt: number }) {
  const on = bombActive(state);
  const bomb = state.bomb;
  const defusing = on && bomb!.state === "defusing";
  // The defuse scale is fixed when the defuse starts, so the bar drains from full to empty.
  const [defuse, setDefuse] = useState({ on: false, scale: BOMB_FUSE });
  if (defusing !== defuse.on) setDefuse({ on: defusing, scale: defusing ? defuseScale(bomb!.remainingSec) : BOMB_FUSE });
  const scale = defusing ? defuse.scale : BOMB_FUSE;
  // While leaving, the bar keeps what it last showed.
  const last = useRef<{ bomb: Bomb; receivedAt: number; scale: number } | null>(null);
  if (on) last.current = { bomb: bomb!, receivedAt, scale };
  const snap = last.current;
  return (
    <div className="vx-bomb-slot">
      <div className={`vx-bomb ${on ? "is-on" : ""} ${(on ? defusing : snap?.bomb.state === "defusing") ? "is-defuse" : ""}`}>
        {on ? (
          <BombTicking bomb={bomb!} receivedAt={receivedAt} scale={scale} />
        ) : snap ? (
          <BombFace sec={secondsLeft(snap.bomb.remainingSec, snap.bomb.clockRunning, snap.receivedAt, performance.now()) ?? 0} scale={snap.scale} defusing={snap.bomb.state === "defusing"} site={snap.bomb.site} />
        ) : null}
      </div>
    </div>
  );
}

const REASON: Record<string, string> = {
  ct_win_elimination: "ELIMINATION",
  t_win_elimination: "ELIMINATION",
  ct_win_defuse: "BOMB DEFUSED",
  t_win_bomb: "BOMB DETONATED",
  ct_win_time: "TIME RAN OUT",
  ct_win_rescue: "HOSTAGES RESCUED",
};

function WinnerCard({ state, color }: { state: HudState; color: { left: string; right: string } }) {
  const winner = roundWinner(state);
  const last = useRef<{ team: HudTeam; side: Align; reason: string } | null>(null);
  if (winner) last.current = { team: state[winner], side: winner, reason: REASON[state.roundHistory[state.roundHistory.length - 1]?.reason ?? ""] ?? "" };
  const w = last.current;
  return (
    <div className={`vx-win ${winner ? "is-on" : ""}`} style={w ? ({ "--team": color[w.side] } as CSSProperties) : undefined}>
      {w ? (
        <>
          <i className="vx-win-tint" />
          <TeamBadge team={w.team} className="vx-win-badge" />
          <div className="vx-win-text">
            <div className={`vx-win-name ${w.team.name.length > 18 ? "is-long" : ""}`}>{w.team.name}</div>
            <div className="vx-win-sub">
              WINS THE ROUND{w.reason ? <span className="vx-win-reason">{w.reason}</span> : null}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * Top centre: both teams, scores and the clock; in freeze time the loss-bonus pills and the series
 * maps; the bomb bar while the bomb is down; the round winner's card after the round.
 */
export function ScoreBar({ state, receivedAt, extras, color }: { state: HudState; receivedAt: number; extras: boolean; color: { left: string; right: string } }) {
  return (
    <div className="vx-top">
      <LossPill team={state.left} align="left" on={extras} />
      <LossPill team={state.right} align="right" on={extras} />
      <div className="vx-bar">
        <Plate team={state.left} align="left" bestOf={state.series.bestOf} />
        <div className="vx-score vx-left">
          <Flip value={state.left.score ?? 0} />
        </div>
        <Center state={state} receivedAt={receivedAt} />
        <div className="vx-score vx-right">
          <Flip value={state.right.score ?? 0} />
        </div>
        <Plate team={state.right} align="right" bestOf={state.series.bestOf} />
      </div>
      <SeriesStrip state={state} on={extras} />
      <BombBar state={state} receivedAt={receivedAt} />
      <WinnerCard state={state} color={color} />
    </div>
  );
}
