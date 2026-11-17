import type { CSSProperties } from "react";
import type { HudReplayClip, HudState } from "@matchframe/hud-sdk";
import { replayBadge } from "@matchframe/hud-sdk";
import { clipColor, clipVictims, teamMonogram, useReplayGraphic } from "../../../hud-renderer/src/components/replay.ts";
import { ReplayIcon } from "../shared/parts.ts";
import { Headshot, Weapon } from "./icons.tsx";
import { readSettings, teamVars } from "./util.ts";
import "./replay.css";

const NEUTRAL = "#9aa6b8";

function Card({ clip, leaving, color }: { clip: HudReplayClip; leaving: boolean; color: string }) {
  const badge = replayBadge(clip);
  const victims = clipVictims(clip);
  const t = clip.team;
  const name = clip.player?.name ?? "";
  return (
    <div className={`st-rp-card ${leaving ? "is-out" : "is-in"}`} style={teamVars(color)}>
      <div className="st-rp-bar">
        <span className="st-rp-logo">{t?.logoUrl ? <img src={t.logoUrl} alt="" /> : <b>{t ? teamMonogram(t) : "?"}</b>}</span>
        <span className="st-rp-who">
          <span className={`st-rp-name ${name.length > 14 ? "is-long" : ""}`}>{name}</span>
          {t ? <span className="st-rp-team">{t.name}</span> : null}
        </span>
        {badge ? <span className="st-rp-badge">{clip.clutchVersus !== null ? `1V${clip.clutchVersus} CLUTCH` : clip.multiKill}</span> : null}
      </div>
      <div className="st-rp-strip">
        {clip.weapon ? (
          <span className="st-rp-weapon">
            <Weapon weapon={clip.weapon.name} className="st-rp-gun" />
            {clip.weapon.displayName}
          </span>
        ) : null}
        {clip.headshot ? (
          <span className="st-rp-hs">
            <Headshot size={16} /> HEADSHOT
          </span>
        ) : null}
        {victims ? <span className="st-rp-victims">{victims}</span> : null}
      </div>
    </div>
  );
}

/**
 * The replay graphic (the `replay` entry point): a REPLAY tag where the score bar sits, with the
 * round, and a lower third where the observed player's panel sits: who made the play, the 2K–ACE
 * or clutch badge, the weapon and who went down.
 */
export function ReplayLayer({ state, scale }: { state: HudState; scale: number }) {
  const view = useReplayGraphic(state.replay.clip);
  const settings = readSettings(state.settings);
  const colors = { ct: settings.ctColor, t: settings.tColor };
  const card = view.card;
  const clip = card?.clip ?? state.replay.clip;
  const color = clip ? clipColor(clip, colors, NEUTRAL) : NEUTRAL;
  return (
    <div className="st-stage st-replay-stage" style={{ transform: `scale(${scale})` } as CSSProperties}>
      {view.tag !== "off" ? (
        <div className={`st-rp-tag ${view.tag === "out" ? "is-out" : "is-in"}`} style={teamVars(color)}>
          <span className="st-rp-tag-main">
            <ReplayIcon size={24} />
            REPLAY
          </span>
          {clip?.roundNumber != null ? <span className="st-rp-tag-round">ROUND {clip.roundNumber}</span> : null}
        </div>
      ) : null}
      {state.simulated ? <span className="st-label is-sim st-rp-sim">SIMULATION</span> : null}
      {card?.clip.player ? <Card key={card.clip.id} clip={card.clip} leaving={card.state === "out"} color={clipColor(card.clip, colors, NEUTRAL)} /> : null}
    </div>
  );
}
