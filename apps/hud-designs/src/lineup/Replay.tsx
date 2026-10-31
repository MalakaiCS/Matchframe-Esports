import type { CSSProperties } from "react";
import type { HudReplayClip, HudState } from "@matchframe/hud-sdk";
import { replayBadge } from "@matchframe/hud-sdk";
import { clipColor, clipVictims, teamMonogram, useReplayGraphic } from "../../../hud-renderer/src/components/replay.ts";
import { HeadshotIcon, ReplayIcon } from "../shared/parts.ts";
import { readSettings, teamVars } from "./util.ts";
import "./replay.css";

const NEUTRAL = "#9aa4b5";

function Card({ clip, leaving, color }: { clip: HudReplayClip; leaving: boolean; color: string }) {
  const badge = replayBadge(clip);
  const victims = clipVictims(clip);
  const t = clip.team;
  const name = clip.player?.name ?? "";
  return (
    <div className={`lu-rp-card ${leaving ? "is-out" : "is-in"}`} style={teamVars(color)}>
      <div className="lu-rp-bar">
        <span className="lu-rp-logo">{t?.logoUrl ? <img src={t.logoUrl} alt="" /> : <b data-len={t ? teamMonogram(t).length : 1}>{t ? teamMonogram(t) : "?"}</b>}</span>
        <span className="lu-rp-who">
          <span className={`lu-rp-name ${name.length > 14 ? "is-long" : ""}`}>{name}</span>
          {t ? <span className="lu-rp-team">{t.name}</span> : null}
        </span>
        {badge ? (
          <span className={`lu-rp-badge ${clip.clutchVersus !== null ? "is-clutch" : ""}`}>
            <b>{clip.clutchVersus !== null ? `1V${clip.clutchVersus}` : clip.multiKill}</b>
            {clip.clutchVersus !== null ? <i>Clutch</i> : null}
          </span>
        ) : null}
      </div>
      <div className="lu-rp-strip">
        <span className="lu-rp-play">
          {clip.weapon ? <span>{clip.weapon.displayName}</span> : null}
          {clip.headshot ? (
            <span className="lu-rp-hs">
              <HeadshotIcon size={17} /> Headshot
            </span>
          ) : null}
          {victims ? <span className="lu-rp-victims">{victims}</span> : null}
        </span>
      </div>
    </div>
  );
}

/**
 * Lineup's replay graphic (the `replay` entry point): a "REPLAY" bar where the score bar sits, with
 * the round on a white tab under it, and a lower third along the bottom (the player on a near-black
 * bar with the team's edge, a white badge for 2K–ACE or a clutch, the play on a team-colour strip).
 * Bars grow from the centre and strips slide from under them, like the HUD's banners.
 */
export function ReplayLayer({ state, scale }: { state: HudState; scale: number }) {
  const view = useReplayGraphic(state.replay.clip);
  const settings = readSettings(state.settings);
  const colors = { ct: settings.ctColor, t: settings.tColor };
  const card = view.card;
  const clip = card?.clip ?? state.replay.clip;
  const color = clip ? clipColor(clip, colors, NEUTRAL) : NEUTRAL;
  return (
    <div className="lu-stage lu-replay-stage" style={{ transform: `scale(${scale})` } as CSSProperties}>
      {view.tag !== "off" ? (
        <div className={`lu-rp-tag ${view.tag === "out" ? "is-out" : "is-in"}`} style={teamVars(color)}>
          <div className="lu-rp-tag-bar">
            <span className="lu-rp-tag-text">
              <ReplayIcon size={26} />
              Replay
            </span>
          </div>
          {clip?.roundNumber != null ? <div className="lu-rp-tag-tab">Round {clip.roundNumber}</div> : null}
          {state.simulated ? <span className="lu-label is-sim lu-rp-sim">SIMULATION</span> : null}
        </div>
      ) : null}
      {card?.clip.player ? <Card key={card.clip.id} clip={card.clip} leaving={card.state === "out"} color={clipColor(card.clip, colors, NEUTRAL)} /> : null}
    </div>
  );
}
