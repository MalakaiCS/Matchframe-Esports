import type { CSSProperties } from "react";
import type { HudReplayClip, HudState } from "@matchframe/hud-sdk";
import { replayBadge } from "@matchframe/hud-sdk";
import { clipColor, clipVictims, teamMonogram, useReplayGraphic } from "../../../hud-renderer/src/components/replay.ts";
import { HeadshotIcon, ReplayIcon } from "../shared/parts.ts";
import { sizeClass } from "./bits.tsx";
import "./replay.css";

const NEUTRAL = "#7d8794";

/** The team block: the logo (or tag) on the team colour, the tag large and faint behind it. */
function TeamBlock({ clip }: { clip: HudReplayClip }) {
  const t = clip.team;
  return (
    <span className="vx-rp-team">
      {t ? <span className="vx-mark">{t.logoUrl ? <img src={t.logoUrl} alt="" /> : <span>{teamMonogram(t).slice(0, 3)}</span>}</span> : null}
      <span className={`vx-rp-logo ${t?.logoUrl ? "has-logo" : ""}`}>{t?.logoUrl ? <img src={t.logoUrl} alt="" /> : <b>{t ? teamMonogram(t) : "?"}</b>}</span>
    </span>
  );
}

function Card({ clip, leaving, color }: { clip: HudReplayClip; leaving: boolean; color: string }) {
  const badge = replayBadge(clip);
  const victims = clipVictims(clip);
  const name = clip.player?.name ?? "";
  return (
    <div className={`vx-rp-card ${leaving ? "is-out" : "is-in"} ${badge ? "has-badge" : ""}`} style={{ "--team": color } as CSSProperties}>
      <TeamBlock clip={clip} />
      <div className="vx-rp-main">
        <span className="vx-rp-kicker">
          {clip.team ? <b>{clip.team.name}</b> : null}
          {clip.roundNumber !== null ? <span>Round {clip.roundNumber}</span> : null}
        </span>
        <span className={`vx-rp-name ${sizeClass(name.length, 12, 15, 18)}`}>{name}</span>
        <span className="vx-rp-meta">
          {clip.weapon ? <span className="vx-rp-weapon">{clip.weapon.displayName}</span> : null}
          {clip.headshot ? (
            <span className="vx-rp-hs">
              <HeadshotIcon size={15} /> Headshot
            </span>
          ) : null}
          {victims ? <span className="vx-rp-victims">{victims}</span> : null}
        </span>
      </div>
      {badge ? (
        <span className="vx-rp-badge">
          {clip.clutchVersus !== null ? (
            <>
              <b>1V{clip.clutchVersus}</b>
              <i>Clutch</i>
            </>
          ) : (
            <b className={clip.multiKill === "ACE" ? "is-ace" : ""}>{clip.multiKill}</b>
          )}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Vector's replay graphic (the `replay` entry point): a "REPLAY" tag top left and, a moment after a
 * clip starts, a lower third in the score bar's language (team-colour block with the logo, dark
 * body, team-colour badge for a 2K–ACE or a clutch). Transparent everywhere else.
 */
export function ReplayLayer({ state }: { state: HudState }) {
  const view = useReplayGraphic(state.replay.clip);
  const s = state.settings;
  const colors = { ct: typeof s.ctColor === "string" ? s.ctColor : "#109be3", t: typeof s.tColor === "string" ? s.tColor : "#d05354" };
  const card = view.card;
  const clip = card?.clip ?? state.replay.clip;
  const color = clip ? clipColor(clip, colors, NEUTRAL) : NEUTRAL;
  return (
    <div className="vx-stage vx-replay-stage">
      {view.tag !== "off" ? (
        <div className={`vx-rp-tag ${view.tag === "out" ? "is-out" : "is-in"}`} style={{ "--team": color } as CSSProperties}>
          <span className="vx-rp-tag-icon">
            <ReplayIcon size={20} />
          </span>
          <span className="vx-rp-tag-text">Replay</span>
          {clip?.roundNumber != null ? <span className="vx-rp-tag-round">R{clip.roundNumber}</span> : null}
        </div>
      ) : null}
      {state.simulated && view.tag !== "off" ? <span className="vx-flag is-sim vx-rp-sim">SIMULATION</span> : null}
      {card?.clip.player ? <Card key={card.clip.id} clip={card.clip} leaving={card.state === "out"} color={clipColor(card.clip, colors, NEUTRAL)} /> : null}
    </div>
  );
}
