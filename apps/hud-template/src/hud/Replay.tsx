import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { HudReplayClip, HudState, ReplayGraphicView } from "@matchframe/hud-sdk";
import { REPLAY_GRAPHIC_OFF, replayBadge, ReplayGraphicSequencer } from "@matchframe/hud-sdk";
import "../styles/replay.scss";

/**
 * The clip on air (`state.replay.clip`) as the HUD SDK's sequencer times it: the tag and the lower
 * third come in a moment after a clip starts, the lower third changes per clip, both go when the
 * replays end.
 */
function useReplayGraphic(clip: HudReplayClip | null): ReplayGraphicView {
  const [view, setView] = useState<ReplayGraphicView>(REPLAY_GRAPHIC_OFF);
  const seq = useRef<ReplayGraphicSequencer | null>(null);
  seq.current ??= new ReplayGraphicSequencer(setView);
  useEffect(() => {
    seq.current!.update(clip);
  });
  useEffect(() => () => seq.current?.dispose(), []);
  return view;
}

/** The side's colour in this HUD (the colour of the side played in the clip's round), else the team's own, else grey. */
const accent = (clip: HudReplayClip): string => (clip.side === "CT" ? "var(--color-new-ct)" : clip.side === "T" ? "var(--color-new-t)" : (clip.team?.color ?? "#bfbfbf"));

function Rewind() {
  return (
    <svg className="rp-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path d="M11.5 5.5v13L2 12z" fill="currentColor" />
      <path d="M22 5.5v13L12.5 12z" fill="currentColor" />
    </svg>
  );
}

function Card({ clip, leaving }: { clip: HudReplayClip; leaving: boolean }) {
  const badge = replayBadge(clip);
  const t = clip.team;
  return (
    <div className={`rp-card ${leaving ? "rp-out" : "rp-in"}`} style={{ "--rp-side": accent(clip) } as CSSProperties}>
      <div className="rp-main">
        <div className="rp-logo">{t?.logoUrl ? <img src={t.logoUrl} alt="" /> : <span>{(t?.shortName || t?.name || "?").slice(0, 4)}</span>}</div>
        <div className="rp-who">
          <div className="rp-name">{clip.player?.name}</div>
          {t ? <div className="rp-team">{t.name}</div> : null}
        </div>
        {badge ? (
          <div className="rp-badge">
            <b>{clip.clutchVersus !== null ? `1v${clip.clutchVersus}` : clip.multiKill}</b>
            {clip.clutchVersus !== null ? <span>clutch</span> : null}
          </div>
        ) : null}
      </div>
      <div className="rp-stats">
        {clip.weapon ? (
          <div className="rp-cell">
            <div className="label">WEAPON</div>
            <div className="stat">{clip.weapon.displayName}</div>
          </div>
        ) : null}
        {clip.headshot ? (
          <div className="rp-cell">
            <div className="label">HEADSHOT</div>
            <div className="stat rp-yes">YES</div>
          </div>
        ) : null}
        {clip.victims.length ? (
          <div className="rp-cell rp-wide">
            <div className="label">{clip.victims.length === 1 ? "KILLED" : `KILLED (${clip.victims.length})`}</div>
            <div className="stat">{clip.victims.join(", ")}</div>
          </div>
        ) : clip.clutchVersus !== null ? (
          <div className="rp-cell rp-wide">
            <div className="label">RESULT</div>
            <div className="stat">Won the round alone against {clip.clutchVersus}</div>
          </div>
        ) : null}
        {clip.roundNumber !== null ? (
          <div className="rp-cell rp-round">
            <div className="label">ROUND</div>
            <div className="stat">{clip.roundNumber}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The Pro CS2 HUD's replay graphic (its `replay` entry point): a "REPLAY" panel where the match bar
 * sits and a lower third where the observed player is, in the HUD's dark panels and side colours.
 */
export default function ReplayLayer({ state }: { state: HudState }) {
  const view = useReplayGraphic(state.replay.clip);
  const card = view.card;
  const clip = card?.clip ?? state.replay.clip;
  return (
    <div className="replay-layer">
      {view.tag !== "off" ? (
        <div className={`rp-tag ${view.tag === "out" ? "rp-out" : "rp-in"}`} style={clip ? ({ "--rp-side": accent(clip) } as CSSProperties) : undefined}>
          <Rewind />
          <span className="rp-tag-text">REPLAY</span>
          {clip?.roundNumber != null ? <span className="rp-tag-round">ROUND {clip.roundNumber}</span> : null}
        </div>
      ) : null}
      {state.simulated && view.tag !== "off" ? <div className="mf-simulation rp-sim">SIMULATION</div> : null}
      {card?.clip.player ? <Card key={card.clip.id} clip={card.clip} leaving={card.state === "out"} /> : null}
    </div>
  );
}
