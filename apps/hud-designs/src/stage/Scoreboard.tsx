import { memo } from "react";
import type { ReactNode } from "react";
import type { HudPlayer, HudState, HudTeam } from "@matchframe/hud-sdk";
import { playerPicture } from "../shared/art.ts";
import { equipmentValue, lossBonus, secondsLeft, seriesBoxCount, seriesWon } from "../shared/format.ts";
import { ArmorIcon, BombIcon, KitIcon, WeaponIcon } from "../shared/parts.ts";
import { Photo, TeamLogo, TimeoutPips } from "./bits.tsx";
import { grenadeList, Nades } from "./Cards.tsx";
import { useNow } from "../shared/useHud.ts";
import { SponsorSpot } from "./TopRight.tsx";
import { cash, colorOf, slotOrder, teamVars, timeoutTeam, type Settings } from "./util.ts";

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="st-board-stat">
      <span className="st-board-label">{label}</span>
      <span className="st-board-value">{children}</span>
    </span>
  );
}

/** One team's end of the header: equipment value, loss bonus, timeouts, logo, tag, series boxes and score. */
function HeaderSide({ state, team, align, color }: { state: HudState; team: HudTeam; align: "left" | "right"; color: string }) {
  const bonus = lossBonus(team.consecutiveRoundLosses);
  const boxes = seriesBoxCount(state.series.bestOf);
  const won = seriesWon(state, align);
  return (
    <div className={`st-board-head st-board-head-${align}`} style={teamVars(color)}>
      <Stat label="EQUIPMENT VALUE">{cash(equipmentValue(team))}</Stat>
      <Stat label="LOSS BONUS">{bonus === null ? "–" : cash(bonus)}</Stat>
      <Stat label="TIMEOUTS LEFT">
        <TimeoutPips left={team.timeoutsRemaining} />
      </Stat>
      <span className="st-board-logo">
        <TeamLogo team={team} />
      </span>
      <span className="st-board-tag">{team.shortName || team.name}</span>
      {boxes ? (
        <span className="st-board-pips" aria-label={`${won} of ${boxes} maps won`}>
          {Array.from({ length: Math.min(boxes, 5) }, (_, i) => (
            <i key={i} className={i < won ? "is-won" : ""} />
          ))}
        </span>
      ) : null}
      <span className="st-board-score">{team.score ?? 0}</span>
    </div>
  );
}

/** A player's row: photo, name, armour, kit or bomb, grenades, pistol, main weapon, money. */
function Row({ state, p, index }: { state: HudState; p: HudPlayer; index: number }) {
  const alive = p.alive !== false;
  const pistol = alive ? (p.secondary?.name ?? null) : null;
  const main = alive ? (p.primary?.name ?? null) : null;
  return (
    <div className={`st-row ${alive ? "" : "is-dead"}`} style={{ ["--i" as string]: index }}>
      <span className="st-row-pic">
        <Photo url={playerPicture(state, p)} />
      </span>
      <span className="st-row-name">{p.name}</span>
      <span className="st-row-cell st-row-armor">{alive && (p.armor ?? 0) > 0 ? <ArmorIcon helmet={!!p.helmet} size={19} /> : null}</span>
      <span className="st-row-cell st-row-kit">{alive && p.hasBomb ? <BombIcon size={21} className="st-c4" /> : alive && p.defuseKit ? <KitIcon size={19} /> : null}</span>
      <span className="st-row-cell st-row-nades">
        <Nades list={alive ? grenadeList(p) : ""} size={18} />
      </span>
      <span className="st-row-cell st-row-pistol">{pistol ? <WeaponIcon weapon={pistol} className="st-row-gun" /> : null}</span>
      <span className="st-row-cell st-row-main">{main ? <WeaponIcon weapon={main} className="st-row-gun" /> : null}</span>
      <span className="st-row-money">{cash(p.money)}</span>
    </div>
  );
}

function Rows({ state, team, align, color }: { state: HudState; team: HudTeam; align: "left" | "right"; color: string }) {
  return (
    <div className={`st-rows st-rows-${align}`} style={teamVars(color)}>
      {slotOrder(team).map((p, i) => (
        <Row key={p.steamId} state={state} p={p} index={i} />
      ))}
    </div>
  );
}

/**
 * The team's coach over its end of the bar (from the team's roster): a COACH tag, their photo and
 * name. Never a voice or mute indicator: Team Comms rules keep individual comms off air.
 */
function Coach({ team, align, color }: { team: HudTeam; align: "left" | "right"; color: string }) {
  if (!team.coach) return null;
  return (
    <div className={`st-coach st-coach-${align}`} style={teamVars(color)}>
      <span className="st-coach-tag">COACH</span>
      <span className="st-coach-row">
        <span className="st-coach-pic">
          <Photo url={team.coach.avatarUrl} />
        </span>
        <span className="st-coach-name">{team.coach.name}</span>
      </span>
    </div>
  );
}

/** The timeout's seconds left, counting down locally (4 Hz). */
const TimeoutSeconds = memo(function TimeoutSeconds({ sec, running, receivedAt }: { sec: number | null; running: boolean; receivedAt: number }) {
  const now = useNow(250);
  const left = secondsLeft(sec, running, receivedAt, now);
  return <span className="st-tocall-sec">{left === null ? "–" : Math.ceil(left)}</span>;
});

/** During a timeout, over the calling team's end of the bar: the seconds left, TIMEOUT with the timeouts left, the team's logo. */
function TimeoutCallout({ state, receivedAt, settings }: { state: HudState; receivedAt: number; settings: Settings }) {
  const team = timeoutTeam(state);
  if (!team) return null;
  const m = state.match;
  return (
    <div key={team.key} className={`st-tocall ${team === state.left ? "is-left" : "is-right"}`} style={teamVars(colorOf(team, settings))}>
      <TimeoutSeconds sec={m.phaseEndsInSec} running={m.clockRunning && !m.paused} receivedAt={receivedAt} />
      <span className="st-tocall-text">
        <b>TIMEOUT</b>
        <span className="st-tocall-sub">
          {team.shortName || team.name}
          <TimeoutPips left={team.timeoutsRemaining} />
        </span>
      </span>
      <span className="st-tocall-logo">
        <TeamLogo team={team} />
      </span>
    </div>
  );
}

/**
 * Freeze time, timeouts and other breaks in play: a full-width bar along the bottom. The header has
 * each team's equipment value, loss bonus, timeouts left, logo, tag, series boxes and score; under
 * it each team's players with their gear and money, and the scoreboard sponsor in the middle; each
 * team's coach over its end. Individual players' or coaches' voice or mute state is never shown
 * (Team Comms rules).
 */
export function Scoreboard({ state, receivedAt, settings, shown }: { state: HudState; receivedAt: number; settings: Settings; shown: boolean }) {
  const left = colorOf(state.left, settings);
  const right = colorOf(state.right, settings);
  return (
    <div className={`st-board ${shown ? "is-on" : ""}`} aria-hidden={!shown}>
      {shown ? <TimeoutCallout state={state} receivedAt={receivedAt} settings={settings} /> : null}
      <Coach team={state.left} align="left" color={left} />
      <Coach team={state.right} align="right" color={right} />
      <div className="st-board-header">
        <HeaderSide state={state} team={state.left} align="left" color={left} />
        <span className="st-board-vs">VS</span>
        <HeaderSide state={state} team={state.right} align="right" color={right} />
      </div>
      <div className="st-board-body">
        <Rows state={state} team={state.left} align="left" color={left} />
        <div className="st-board-centre">{settings.showSponsors ? <SponsorSpot sponsor={state.sponsors.scoreboard_slot} className="st-sponsor-board" /> : null}</div>
        <Rows state={state} team={state.right} align="right" color={right} />
      </div>
    </div>
  );
}
