import { memo, useRef } from "react";
import type { CSSProperties, RefObject } from "react";
import type { HudPhase, HudState, HudTeam } from "@matchframe/hud-sdk";
import { clockText, roundWinner, secondsLeft } from "../shared/format.ts";
import { BombIcon, KitIcon } from "../shared/parts.ts";
import { useNow } from "../shared/useHud.ts";
import { TeamBadge } from "./Badge.tsx";
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

const REASON: Record<string, string> = {
  ct_win_defuse: "BOMB DEFUSED",
  t_win_bomb: "BOMB EXPLODED",
  ct_win_time: "TIME RAN OUT",
  ct_win_elimination: "ELIMINATION",
  t_win_elimination: "ELIMINATION",
  elimination: "ELIMINATION",
  ct_win_rescue: "HOSTAGES RESCUED",
};

/** The round clock: the only part of the bar that re-renders ten times a second. */
const Clock = memo(function Clock({ sec, running, receivedAt, live }: { sec: number | null; running: boolean; receivedAt: number; live: boolean }) {
  const now = useNow(100);
  const left = secondsLeft(sec, running, receivedAt, now);
  return <span className={`lu-clock ${live && left !== null && left <= 10 ? "is-low" : ""}`}>{clockText(sec, running, receivedAt, now) || "–"}</span>;
});

function Fill({ frac }: { frac: number }) {
  return (
    <div className="lu-bombbar-fill" style={{ transform: `scaleX(${frac.toFixed(4)})` }}>
      <i className="lu-bombbar-ct" />
    </div>
  );
}

/** The draining fill while the bomb ticks (10 Hz); it remembers where it stopped for the exit. */
const BombFill = memo(function BombFill({ sec, running, receivedAt, last }: { sec: number | null; running: boolean; receivedAt: number; last: RefObject<number> }) {
  const now = useNow(100);
  const left = secondsLeft(sec, running, receivedAt, now);
  const frac = left === null ? last.current : Math.max(0, Math.min(1, left / BOMB_SECONDS));
  last.current = frac;
  return <Fill frac={frac} />;
});

/** Bar under the score bar while the bomb is planted: slides down, drains, CT colour while defusing. */
function BombBar({ state, receivedAt }: { state: HudState; receivedAt: number }) {
  const b = state.bomb;
  const on = !!b && (b.state === "planted" || b.state === "defusing") && state.match.phase !== "over";
  const last = useRef(1);
  // A new plant starts full; the bar keeps its colour while it shrinks away (the bomb is no longer
  // "defusing" by then).
  const wasOn = useRef(false);
  const wasDefuse = useRef(false);
  if (on && !wasOn.current) last.current = 1;
  wasOn.current = on;
  if (on) wasDefuse.current = b?.state === "defusing";
  return (
    <div className={`lu-bombbar ${on ? "is-on" : ""} ${wasDefuse.current ? "is-defuse" : ""}`} aria-hidden={!on}>
      <div className="lu-bombbar-track">{on && b ? <BombFill sec={b.remainingSec} running={b.clockRunning} receivedAt={receivedAt} last={last} /> : <Fill frac={last.current} />}</div>
    </div>
  );
}

function Cap({ team, color, align }: { team: HudTeam; color: string; align: "left" | "right" }) {
  return (
    <div className={`lu-cap lu-cap-${align}`} style={teamVars(color)}>
      <span className="lu-cap-fill" aria-hidden />
      <span key={team.score ?? 0} className="lu-score">
        {team.score ?? 0}
      </span>
    </div>
  );
}

function TeamBlock({ team, color, align, bestOf }: { team: HudTeam; color: string; align: "left" | "right"; bestOf: number | null }) {
  const needed = bestOf && bestOf > 1 ? Math.ceil(bestOf / 2) : 0;
  return (
    <div className={`lu-sb-team lu-sb-${align} ${(team.shortName || team.name).length > 5 ? "is-long" : ""}`} style={teamVars(color)}>
      <TeamBadge team={team} className="lu-sb-badge" />
      <div className="lu-sb-id">
        <span className="lu-sb-name">{team.shortName || team.name}</span>
        {needed ? (
          <span className="lu-sb-pips" aria-label={`${team.seriesWins} maps won`}>
            {Array.from({ length: needed }, (_, i) => (
              <i key={i} className={i < team.seriesWins ? "is-won" : ""} />
            ))}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The score bar: a dark capsule with each team's colour on its end cap, logos, and the round clock.
 * Bomb planted: the clock cross-fades to the bomb glyph and the bomb bar slides down under it.
 * Round won: a panel in the winner's colour grows out of the centre over the whole bar (scores
 * included), the winner's badge and name come in, and it folds back to the centre at freeze time.
 */
export function ScoreBar({ state, receivedAt, settings }: { state: HudState; receivedAt: number; settings: Settings }) {
  const m = state.match;
  const leftColor = colorOf(state.left, settings);
  const rightColor = colorOf(state.right, settings);
  const winner = roundWinner(state);
  const lastRound = state.roundHistory[state.roundHistory.length - 1];
  // What the banner shows, kept as it was while it folds away at freeze time.
  const banner = useRef<{ side: "left" | "right"; round: number | null; reason: string | undefined }>({ side: "left", round: null, reason: undefined });
  if (winner) banner.current = { side: winner, round: lastRound?.roundNumber ?? null, reason: lastRound ? REASON[lastRound.reason] : undefined };
  const { side: bannerSide, round: bannerRound, reason } = banner.current;
  const bannerTeam = state[bannerSide];
  const bannerColor = bannerSide === "left" ? leftColor : rightColor;

  const b = state.bomb;
  const bombOn = !!b && (b.state === "planted" || b.state === "defusing") && m.phase !== "over";
  const defusing = bombOn && b?.state === "defusing";
  const live = m.phase === "live";
  const ctTeam = state.left.side === "CT" ? state.left : state.right.side === "CT" ? state.right : null;
  const defuseVar = { "--lu-defuse": ctTeam ? colorOf(ctTeam, settings) : settings.ctColor } as CSSProperties;
  const round = m.roundNumber !== null ? `ROUND ${m.roundNumber}${m.regulationRounds && m.roundNumber <= m.regulationRounds ? ` / ${m.regulationRounds}` : ""}` : "";
  const label = m.paused ? "PAUSED" : (PHASE_LABEL[m.phase] ?? round);

  return (
    <div className="lu-scorebar" data-phase={m.phase} style={defuseVar}>
      <div className={`lu-sb ${winner ? "is-won" : ""}`}>
        <Cap team={state.left} color={leftColor} align="left" />
        <TeamBlock team={state.left} color={leftColor} align="left" bestOf={state.series.bestOf} />
        <div className={`lu-sb-centre ${bombOn ? "is-bomb" : ""} ${defusing ? "is-defuse" : ""}`}>
          <div className="lu-sb-time">
            <span className="lu-sb-clock">
              <Clock sec={m.phaseEndsInSec} running={m.clockRunning && !m.paused} receivedAt={receivedAt} live={live} />
            </span>
            <span className="lu-sb-glyph lu-sb-glyph-bomb">
              <BombIcon size={30} />
              {b?.site ? <b>{b.site}</b> : null}
            </span>
            <span className="lu-sb-glyph lu-sb-glyph-kit">
              <KitIcon size={28} />
              {b?.site ? <b>{b.site}</b> : null}
            </span>
          </div>
          <div className={`lu-sb-round ${m.paused ? "is-paused" : ""}`}>{bombOn ? (defusing ? "DEFUSING" : "BOMB PLANTED") : label}</div>
        </div>
        <TeamBlock team={state.right} color={rightColor} align="right" bestOf={state.series.bestOf} />
        <Cap team={state.right} color={rightColor} align="right" />
        <div className="lu-banner" style={teamVars(bannerColor)} aria-hidden={!winner}>
          <span className="lu-banner-sheen" />
        </div>
        <div className="lu-banner-content" style={teamVars(bannerColor)} aria-hidden={!winner}>
          <TeamBadge team={bannerTeam} className="lu-banner-badge" />
          <div className="lu-banner-text">
            <span className="lu-banner-name">{bannerTeam.name}</span>
            <span className="lu-banner-sub">
              {bannerRound !== null ? `WIN ROUND ${bannerRound}` : "WIN THE ROUND"}
              {reason ? <em>{reason}</em> : null}
            </span>
          </div>
        </div>
      </div>
      <BombBar state={state} receivedAt={receivedAt} />
    </div>
  );
}
